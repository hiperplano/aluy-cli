// `aluy login` — wiring do fluxo de login (EST-0942 / CLI-SEC-1/2).
//
// Dois caminhos:
//   - INTERATIVO (default): Device Authorization Flow (RFC 8628). Mostra o
//     user_code + URL e faz polling.
//   - HEADLESS/CI: PAT via `--token <PAT>` ou env `ALUY_TOKEN`.
// A credencial vai SEMPRE ao keychain do SO (CLI-SEC-2). Sem keychain ⇒ avisa e
// NÃO grava em claro (CA-4).

import { LoginService, isPat, type FetchLike, type RedactedCredential } from '@aluy/cli-core';
import { loadAuthConfig } from '../auth/config.js';
import { loadBrokerConfig } from '../model/config.js';
import { NoKeychainError, KeychainCredentialStore } from '../auth/keychain-store.js';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import type { CredentialStore } from '@aluy/cli-core';

/**
 * EST-1015 (decisão do dono) — VALIDA o PAT na REDE antes de gravar. Hoje `loginWithPat`
 * grava sem validar (o broker valida só no uso), então um PAT errado/expirado "loga" e só
 * falha DEPOIS (401 confuso = a "problema de login" do dono). Aqui tocamos `GET /v1/quota`
 * (exige auth, NÃO gasta modelo, GET sem body — #123) com o PAT CANDIDATO:
 *   • 200/2xx          ⇒ 'valid'      (grava com confiança)
 *   • 401              ⇒ 'rejected'   (AUTENTICAÇÃO falhou — token errado/expirado/
 *                                       desconhecido; não grava, erro claro)
 *   • 403              ⇒ 'valid'       (⚠ BUG-FIX pós-#364: 403 = AUTENTICOU mas NÃO tem
 *                                       escopo p/ ESTE endpoint. `quota:read` é OPT-IN (ver
 *                                       SCOPE_HINT) — um PAT normal de chat (assistant:session
 *                                       + llm:call, SEM quota:read) recebe 403 aqui e ANTES era
 *                                       REJEITADO por engano, bloqueando login VÁLIDO. O 403
 *                                       PROVA que o broker reconheceu o principal ⇒ o token é
 *                                       bom; a falta de escopo de quota é irrelevante p/ logar.)
 *   • broker fora/outro ⇒ 'unverified' (não dá p/ provar AGORA — grava com aviso, não bloqueia
 *                                       o usuário offline). NUNCA loga o PAT (CLI-SEC-2).
 */
export async function validatePatOnBroker(
  pat: string,
  env: NodeJS.ProcessEnv,
  fetchFn: FetchLike,
): Promise<'valid' | 'rejected' | 'unverified'> {
  const { brokerBaseUrl } = loadBrokerConfig(env);
  try {
    const res = await fetchFn(`${brokerBaseUrl}/v1/quota`, {
      method: 'GET',
      headers: { authorization: `Bearer ${pat}` },
    });
    if (res.status === 401) return 'rejected'; // autenticação falhou ⇒ token ruim.
    // 403 = autenticado, sem escopo p/ /v1/quota (quota:read é opt-in) ⇒ token VÁLIDO.
    if (res.status === 403) return 'valid';
    if (res.status >= 200 && res.status < 300) return 'valid';
    return 'unverified'; // 5xx/404/etc — não confirma nem nega.
  } catch {
    return 'unverified'; // broker fora / erro de rede ⇒ degrada (não bloqueia).
  }
}

export interface LoginOptions {
  /** PAT explícito (`--token`). Se ausente, tenta env `ALUY_TOKEN`. */
  readonly token?: string;
  /** Org-alvo (obrigatória no device-flow; binding do PAT). */
  readonly org?: string;
  /** Força o caminho device-flow mesmo com `ALUY_TOKEN` no ambiente. */
  readonly forceDeviceFlow?: boolean;
}

export interface LoginDeps {
  readonly io?: TerminalIO;
  readonly store?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  /** `fetch` injetável (testes): evita rede real ao exercitar o device-flow. */
  readonly fetch?: FetchLike;
  /**
   * HUNT-IO-NET — `sleep` injetável (testes): o device-flow agora impõe um piso de
   * 1s no intervalo de polling (anti hot-loop). Sem injetar, os testes esperariam
   * relógio REAL entre os polls. Produção usa o sleep real (default do device-flow).
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const SCOPE_HINT =
  'escopo mínimo: assistant:session + llm:call (quota:read é opt-in). Sem admin/`*`.';

function printSummary(io: TerminalIO, cred: RedactedCredential): void {
  io.out('');
  io.out('✓ login concluído — credencial guardada no keychain do SO.');
  io.out(`  org:     ${cred.organization_id}`);
  io.out(`  escopos: ${cred.scopes.join(', ')}`);
  io.out(`  tipo:    ${cred.kind === 'pat' ? 'PAT' : 'sessão device-flow'}`);
  // NUNCA imprime o segredo — só o hint redigido.
}

/**
 * Executa `aluy login`. Retorna 0 em sucesso, 1 em falha (o binário propaga ao
 * process.exitCode). Não lança para erros esperados — escreve no stderr.
 */
export async function runLogin(opts: LoginOptions = {}, deps: LoginDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const io = deps.io ?? realTerminalIO();
  const store = deps.store ?? new KeychainCredentialStore();
  const config = loadAuthConfig(env);

  const service = new LoginService(
    {
      ...config,
      baseUrl: config.identityBaseUrl,
      store,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
    deps.sleep ? { sleep: deps.sleep } : {},
  );

  // --- Caminho PAT (headless/CI) -------------------------------------------
  const patFromEnv = env.ALUY_TOKEN;
  const pat = opts.token ?? (opts.forceDeviceFlow ? undefined : patFromEnv);
  if (pat) {
    const org = opts.org ?? env.ALUY_ORG;
    if (!org) {
      io.err('login --token requer a org-alvo: use --org <id> (ou ALUY_ORG).');
      return 1;
    }
    // EST-1015 — FORMATO antes (erro claro, sem rede). `loginWithPat` re-checa, mas dar o erro
    // aqui evita um round-trip à toa com um token claramente malformado.
    if (!isPat(pat)) {
      io.err('PAT inválido: esperado o formato `pat_<id>_<segredo>`.');
      return 1;
    }
    // EST-1015 (decisão do dono) — VALIDA na rede ANTES de gravar: um PAT errado/expirado
    // NÃO vira uma credencial ruim salva que só falha depois. Broker fora ⇒ grava com aviso.
    const fetchFn = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const verdict = await validatePatOnBroker(pat, env, fetchFn);
    if (verdict === 'rejected') {
      io.err(
        'PAT recusado pelo broker (inválido, expirado ou sem permissão para esta org). ' +
          'Confira o token / a org — NÃO foi salvo.',
      );
      return 1;
    }
    try {
      const cred = await service.loginWithPat(pat, org);
      printSummary(io, cred);
      if (verdict === 'unverified') {
        io.err(
          'aviso: não consegui validar o PAT agora (broker fora?) — salvei mesmo assim; ' +
            'se o token estiver errado, vai falhar no uso.',
        );
      }
      return 0;
    } catch (err) {
      return handleError(io, err);
    }
  }

  // --- Caminho device-flow (interativo) ------------------------------------
  const org = opts.org ?? env.ALUY_ORG;
  if (!org) {
    io.err('login device-flow requer a org-alvo: use --org <id> (ou ALUY_ORG).');
    return 1;
  }
  try {
    const cred = await service.loginWithDeviceFlow({
      organizationId: org,
      onPrompt: (prompt) => {
        io.out('');
        io.out('Para autenticar, abra esta URL no navegador e confirme o código:');
        io.out(`  URL:    ${prompt.verificationUri}`);
        io.out(`  código: ${prompt.userCode}`);
        io.out(`  (link direto: ${prompt.verificationUriComplete})`);
        io.out(`  ${SCOPE_HINT}`);
        io.out('Aguardando aprovação…');
      },
    });
    printSummary(io, cred);
    return 0;
  } catch (err) {
    return handleError(io, err);
  }
}

function handleError(io: TerminalIO, err: unknown): number {
  if (err instanceof NoKeychainError) {
    io.err(`erro: ${err.message}`);
    return 1;
  }
  if (err instanceof Error) {
    // Mensagens dos erros tipados do core NÃO contêm segredo (CLI-SEC-2/10).
    io.err(`erro: ${err.message}`);
    return 1;
  }
  io.err('erro inesperado no login.');
  return 1;
}
