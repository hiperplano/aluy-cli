// EST-0957 · CLI-SEC-6 (baseline) — PATH-DENY do canal `@arquivo`.
//
// O `@arquivo` é um canal de leitura GUIADO pelo usuário: herda o confinamento de
// workspace (WorkspacePort, EST-0948) E o regime de path-deny de caminhos
// sensíveis (CLI-SEC-6). Mesmo DENTRO do workspace, certos arquivos NÃO devem ser
// oferecidos pelo picker nem injetados no contexto sem fricção — um `.env` na raiz
// do projeto, uma chave privada commitada por engano, um arquivo `*token*`.
//
// Esta é a malha BASELINE (a malha PLENA de redação de segredos é a EST-0946, que
// esta estória CONSOME quando fechar). Aqui: classificamos o caminho como
// `deny` (NUNCA oferecer/injetar — material de chave, ~/.ssh, ~/.aws) ou `ask`
// (sensível — `.env`, `*secret*`/`*token*`: some do picker por padrão; só entra
// por caminho explícito + confirmação). PORTÁVEL no sentido de I/O: regex puro
// sobre o TEXTO do caminho (relativo ao workspace) — sem `fs` aqui.
//
// Espelha, deliberadamente, o SENSITIVE_READ da catraca (categories.ts, EST-0945)
// p/ o canal `@` não virar um BYPASS do path-deny (gate seguranca-light AG-0008):
// o que a catraca trava na tool `read_file`, o picker também não oferece.

import { posix as nodePosix } from 'node:path';

/** Normalização LEXICAL (colapsa `..`/`.`, sem I/O) — anti-traversal do carve-out (ADR-0113 GS-I3). */
function posixNormalize(p: string): string {
  return nodePosix.normalize(p);
}

/** Veredito de path-deny p/ um caminho candidato do canal `@`. */
export type AttachVerdict =
  | { readonly kind: 'allow' }
  /** Sensível: fora do picker por padrão; injeta só com confirmação explícita. */
  | { readonly kind: 'ask'; readonly why: string }
  /** Proibido: NUNCA oferecido nem injetado, nem com caminho explícito. */
  | { readonly kind: 'deny'; readonly why: string };

// Padrões de caminho sensível (espelha SENSITIVE_READ da catraca, EST-0945). O
// `deny` é para material de chave/credencial onde NENHUM contexto justifica vazar;
// o `ask` é para arquivos que PODEM ser legítimos (um `.env.example`, um teste)
// mas cujo nome sinaliza segredo — fora do picker por padrão.
const SENSITIVE_PATHS: readonly { re: RegExp; why: string; deny: boolean }[] = [
  { re: /(?:^|\/|~\/)\.ssh(?:\/|$)/, why: 'chaves SSH (~/.ssh)', deny: true },
  { re: /(?:^|\/|~\/)\.aws(?:\/|$)/, why: 'credenciais AWS (~/.aws)', deny: true },
  { re: /(?:^|\/|~\/)\.gnupg(?:\/|$)/, why: 'chaves GPG (~/.gnupg)', deny: true },
  // ── .aluy/ — ADR-0113 carve-out ───────────────────────────────────────────
  // ~/.aluy/rooms/ — deny EXPLÍCITO (EST-1118 C1), não só herança do ~/.aluy.
  // Cobre também $HOME/.aluy/rooms/, ${HOME}/.aluy/rooms/,
  // /home/<u>/.aluy/rooms/, /Users/<u>/.aluy/rooms/.
  {
    re: /(?:~\/|\$\{?HOME\}?\/|\/(?:home|Users)\/[^/]+\/)\.aluy\/rooms(?:\/|$)/,
    why: 'arquivos de sala do Aluy (~/.aluy/rooms)',
    deny: true,
  },
  // HOME ~/.aluy/ — INTOCADO: credencial/journal/estado (deny absoluto).
  { re: /~\/\.aluy(?:\/|$)/, why: 'estado/credencial do Aluy (~/.aluy)', deny: true },
  // Workspace .aluy/ — carve-out p/ agents|workflows|commands (allow-list por
  // nome, fail-closed). O resto (memory/, secrets/, qualquer-outro/) ⇒ DENY.
  {
    re: /(?:^|\/)\.aluy(?:\/(?!agents\/|workflows\/|commands\/)|$)/,
    why: 'estado/credencial do Aluy (.aluy/)',
    deny: true,
  },
  { re: /(?:^|\/|~\/)\.config\/gh\/hosts\.yml$/, why: 'token do gh CLI', deny: true },
  { re: /(?:^|\/|~\/)\.docker\/config\.json$/, why: 'credenciais Docker', deny: true },
  { re: /(?:^|\/|~\/)\.kube\/config$/, why: 'kubeconfig', deny: true },
  { re: /(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)\b/, why: 'chave privada', deny: true },
  { re: /\.pem$|\.p12$|\.pfx$|\.key$/i, why: 'material de chave privada', deny: true },
  // `.env` como SUFIXO de QUALQUER segmento — pega `.env`, `config/.env.production`,
  // mas TAMBÉM `backup.env`/`prod.env` (sufixo `.env` colado num nome — R2 do
  // seguranca: o âncora antigo `(?:^|\/)\.env` deixava esses passarem). A exceção
  // `example/sample/template/dist` segue valendo p/ o sufixo `.env.<x>` (placeholders);
  // o caractere ANTES do `.env` pode ser início, `/` ou um caractere de nome.
  {
    re: /(?:^|[/\w.-])\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/,
    why: 'arquivo .env (segredos)',
    deny: false,
  },
  {
    re: /(?:^|\/)[^/]*(?:secret|credential|token|apikey|api_key|password|passwd)[^/]*$/i,
    why: 'arquivo com nome sensível (token/secret)',
    deny: false,
  },
];

/**
 * Classifica um caminho (relativo ao workspace) p/ o canal `@arquivo`. `deny` ⇒
 * nunca oferecer/injetar; `ask` ⇒ sensível, fora do picker por padrão (só por
 * caminho explícito + confirmação); `allow` ⇒ livre. Determinístico, sem I/O.
 */
export function classifyAttachPath(path: string): AttachVerdict {
  // ADR-0113 GS-I3 (anti-traversal) — CANONICALIZA lexicamente ANTES de classificar:
  // um `.aluy/agents/../memory/x` ESCAPA do dir permitido pro DENY `.aluy/memory/`. Sem
  // colapsar o `..`, o regex casaria o texto literal (`.aluy/` seguido de `agents/` ⇒
  // não-deny) e o carve-out vazaria por traversal (ASK/allow ⇒ auto-aprovado em --yolo).
  // `posix.normalize` é PURO (sem I/O); a resolução de SYMLINK fica no `resolveInside`
  // do workspace (camada de FS). Mantém o `~` (não é segmento navegável aqui).
  const norm = posixNormalize(path);
  for (const s of SENSITIVE_PATHS) {
    if (s.re.test(norm)) {
      return s.deny ? { kind: 'deny', why: s.why } : { kind: 'ask', why: s.why };
    }
  }
  return { kind: 'allow' };
}

/** `true` se o caminho pode aparecer no PICKER por padrão (allow apenas). */
export function isPickable(path: string): boolean {
  return classifyAttachPath(path).kind === 'allow';
}
