// ADR-0153 — TEST-THEN-REGISTER de um modelo LOCAL desconhecido: fábrica da porta
// `verifyAndRegisterLocalModel(slug)` que `run.tsx` monta e `controller.ts` chama do
// ramo `kind:'local'` de `spawnNamed` (ADR-0152 D6c) quando um slug NÃO está no
// catálogo (declarado ∪ registrado-na-sessão). Espelha o padrão de
// `createLocalChildCallerFactory` (factory.ts): uma fábrica PURA-de-I/O-injetado, que
// devolve uma função memoizada — sem tocar TTY/Ink, testável isolada (mesmo estilo
// de `pinned-stream-fetch.ts`/`credential-resolver.ts`, "I/O concreto" do `cli`).
//
// Fecha SÓ sobre o que o BOOT já resolveu (`wireFormat`/`baseUrl`/`fetchImpl`/
// `getKey`, todos injetados por `run.tsx`) — nenhum dado de spawn/`.md`/config entra
// aqui além do `slug` em si (um DADO de catálogo, HG-2). COND-S1 (fetch PINADO) e
// COND-S2 (credencial do boot) são responsabilidade do CHAMADOR (`run.tsx`): esta
// fábrica só USA o que foi injetado, nunca `globalThis.fetch`/keychain diretamente.

import {
  checkModelConnectivity,
  formatConnectivityFailureDetail,
  type ConnectivityFetch,
} from './connectivity-check.js';

/**
 * ADR-0153 (COND-S3) — teto de SLUGS DISTINTOS testados por sessão. Um teste é 1
 * chamada trivial (`max_tokens:1`) na quota BYO do dono — advisory, mas ainda um
 * teto DURO (fail-closed, sem ping) contra um lote com dezenas de slugs distintos
 * (typo/loop do modelo-pai). Slugs JÁ conhecidos (memoizados/no catálogo) não contam.
 */
export const MAX_LOCAL_MODEL_TESTS_PER_SESSION = 64;

export interface VerifyAndRegisterLocalModelResult {
  readonly ok: boolean;
  /** Texto SANITIZADO (COND-S5) — pronto p/ nota/erro por-filho, nunca corpo cru/location. */
  readonly detail: string;
  /** `true` ⇒ persistiu em `config.providers[<id>].models`; `false` ⇒ só sessão OU `!ok`. */
  readonly registered: boolean;
}

export interface CreateVerifyAndRegisterLocalModelPortOptions {
  /** `WireFormat` do provider ATIVO do boot (nunca de DADO — COND-S9). */
  readonly wireFormat: string;
  /** `base_url` do provider ATIVO do boot, já resolvido (override OU default do catálogo — COND-S9). */
  readonly baseUrl: string;
  /**
   * Fetch PINADO (EST-1115, COND-S1) do provider ativo — o CHAMADOR (`run.tsx`)
   * monta com `createPinnedStreamFetch`; esta fábrica NUNCA usa `globalThis.fetch`.
   */
  readonly fetchImpl: ConnectivityFetch;
  /**
   * Credencial do credential provider do BOOT (COND-S2) — MESMA do pai. Envolve
   * `createLocalCredentialProvider` (que pode LANÇAR `MissingLocalCredentialError`
   * — capturado no `catch` abaixo, COND-S7, nunca escapa). `auth:'none'` (Ollama)
   * devolve `''` (aceito).
   */
  readonly getKey: () => Promise<string>;
  /**
   * Append IDEMPOTENTE em `config.providers[<id>].models` (COND-S4). Devolve
   * `false` p/ provider built-in sem entrada (a fábrica registra SÓ na sessão —
   * `markSessionRegistered` — e o `detail` de sucesso reflete isso).
   */
  readonly registerLocalModel: (slug: string) => boolean;
  /** Marca o slug como registrado NA SESSÃO — o que faz `listNames()` (D2) o unir. */
  readonly markSessionRegistered: (slug: string) => void;
  /** Teto de slugs distintos testados (default `MAX_LOCAL_MODEL_TESTS_PER_SESSION`). Injetável p/ teste. */
  readonly maxTestsPerSession?: number;
}

/**
 * Monta a porta `verifyAndRegisterLocalModel(slug)`. MEMOIZADA por slug (D3 — N
 * filhos no MESMO slug resolvem 1 teste; COND-S7 — uma rejeição TAMBÉM fica
 * memoizada, um blip transitório "envenena" o slug até o fim da sessão, escolha
 * consciente). Teto de sessão (COND-S3): o teste (N+1)-ésimo SLUG DISTINTO, com N
 * = `maxTestsPerSession`, devolve erro SEM pingar (nem entra na memoização — cada
 * chamada seguinte cai no mesmo teto, até o fim da sessão).
 */
export function createVerifyAndRegisterLocalModelPort(
  opts: CreateVerifyAndRegisterLocalModelPortOptions,
): (slug: string) => Promise<VerifyAndRegisterLocalModelResult> {
  const cap = opts.maxTestsPerSession ?? MAX_LOCAL_MODEL_TESTS_PER_SESSION;
  const memo = new Map<string, Promise<VerifyAndRegisterLocalModelResult>>();

  return (slug: string): Promise<VerifyAndRegisterLocalModelResult> => {
    const cached = memo.get(slug);
    if (cached !== undefined) return cached;
    if (memo.size >= cap) {
      // COND-S3 — teto atingido: NÃO memoiza (não foi de fato testado) e NÃO pinga
      // o provider (fail-closed, custo zero). Cada chamada seguinte cai aqui de
      // novo — o teto não afrouxa dentro da sessão.
      return Promise.resolve({
        ok: false,
        detail:
          `modelo local "${slug}" não testado: teto de verificações da sessão ` +
          `atingido (${cap} slugs distintos).`,
        registered: false,
      });
    }
    // COND-S7 (fail-closed, não derruba irmãos) — QUALQUER throw (rede, timeout,
    // `MissingLocalCredentialError` do `getKey`, redirect bloqueado pelo fetch
    // pinado) é capturado AQUI e nunca escapa como exception.
    const p = (async (): Promise<VerifyAndRegisterLocalModelResult> => {
      try {
        const key = await opts.getKey();
        const r = await checkModelConnectivity({
          wireFormat: opts.wireFormat,
          baseUrl: opts.baseUrl,
          model: slug,
          key,
          fetchImpl: opts.fetchImpl,
        });
        if (!r.ok) {
          // COND-S5 — SANITIZA antes da TUI: só status HTTP (+hint) OU texto fixo de
          // rede/SSRF; o corpo de 160 chars / detalhe cru NUNCA chegam.
          return {
            ok: false,
            detail: formatConnectivityFailureDetail(slug, r.detail),
            registered: false,
          };
        }
        // D2 — REGISTRA: append idempotente no config (só quando o provider ATIVO
        // já tem entrada, COND-S4) + no Set da sessão (sempre — é o que faz o
        // PRÓXIMO filho do lote ver o slug como "conhecido", sem re-testar).
        const registered = opts.registerLocalModel(slug);
        opts.markSessionRegistered(slug);
        const detail = registered
          ? `modelo "${slug}" respondeu — registrado no catálogo do provider local.`
          : `modelo "${slug}" respondeu — registrado no catálogo do provider local ` +
            `(registrado nesta sessão).`;
        return { ok: true, detail, registered };
      } catch {
        // COND-S7 — NUNCA interpola a exceção (pode ser `MissingLocalCredentialError`
        // ou o erro anti-SSRF do fetch pinado — nenhum dos dois vai à TUI cru). MESMO
        // texto FIXO do branch de rede/SSRF de `formatConnectivityFailureDetail`.
        return {
          ok: false,
          detail: `modelo local "${slug}" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).`,
          registered: false,
        };
      }
    })();
    memo.set(slug, p);
    return p;
  };
}
