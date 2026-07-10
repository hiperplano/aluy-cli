// CHECK DE CONECTIVIDADE do backend LOCAL — chamada REAL e mínima (max_tokens:1) ao
// endpoint do provider, com a chave do usuário. É o MESMO fio que a sessão usa
// (openai-compat → /chat/completions; anthropic → /v1/messages). Compartilhado pelo
// `aluy onboard` (gate antes dos sidecars) e pelo `aluy login` (valida ao gravar).
//
// Decisão do dono: "a instalação tem que ser lisa do início ao fim" ⇒ não declarar
// sucesso sem o modelo ter respondido de verdade. Devolve ok + um detalhe ACIONÁVEL
// (status HTTP + dica de chave/baseURL/modelo). 15s de timeout. NUNCA lança.

export interface ModelCheckResult {
  readonly ok: boolean;
  /** Detalhe legível: `HTTP 200`, `HTTP 401 — chave inválida? …`, `não conectou: …`. */
  readonly detail: string;
}

/**
 * ADR-0153 (COND-S1/Q-4) — subset MÍNIMO de `fetch` que este módulo de fato usa
 * (`.ok`/`.status`/`.text()` da resposta). Existe p/ que o caminho de
 * TEST-THEN-REGISTER (`run.tsx`) possa injetar o FETCH PINADO anti-SSRF
 * (`createPinnedStreamFetch`, EST-1115 — `StreamFetch`/`StreamResponse` do
 * `cli-core`) SEM um adaptador `StreamResponse→Response` completo: `StreamResponse`
 * já expõe exatamente esse subset, então é estruturalmente atribuível aqui. O
 * `fetch` GLOBAL (default, usado por `aluy onboard`/`aluy login`) também satisfaz
 * este tipo — nenhuma mudança de comportamento p/ os chamadores existentes. Este
 * módulo NÃO seta `init.redirect`: o fetch PINADO cai no default `'error'`
 * (fail-closed, EST-1115) — um `302 → http://169.254.169.254/` nunca é seguido.
 */
export type ConnectivityFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export async function checkModelConnectivity(args: {
  readonly wireFormat: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly key: string;
  /**
   * `fetch` injetável (testes) — ou o FETCH PINADO anti-SSRF no caminho
   * TEST-THEN-REGISTER (ADR-0153, COND-S1: NUNCA o default global neste caminho).
   * Default: `fetch` global (mantém `aluy onboard`/`aluy login` intocados).
   */
  readonly fetchImpl?: ConnectivityFetch;
  /** Timeout em ms (default 15000). */
  readonly timeoutMs?: number;
}): Promise<ModelCheckResult> {
  const f = args.fetchImpl ?? fetch;
  const base = args.baseUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 15000);
  try {
    const res =
      args.wireFormat === 'anthropic'
        ? await f(`${base}/v1/messages`, {
            method: 'POST',
            signal: ctrl.signal,
            headers: {
              'content-type': 'application/json',
              'x-api-key': args.key,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: args.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
          })
        : await f(`${base}/chat/completions`, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${args.key}` },
            body: JSON.stringify({
              model: args.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
          });
    if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
    let body = '';
    try {
      body = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
    } catch {
      /* corpo opcional */
    }
    const hint =
      res.status === 401 || res.status === 403
        ? ' — chave inválida?'
        : res.status === 404
          ? ' — modelo ou baseURL errado?'
          : '';
    return { ok: false, detail: `HTTP ${res.status}${hint} ${body}`.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `não conectou (baseURL/rede?): ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-0153 (COND-S5) — SANITIZA o `detail` de um `ModelCheckResult{ok:false}` ANTES
 * de alcançar a TUI (nota/erro por-filho), p/ o caminho de TEST-THEN-REGISTER
 * (`verifyAndRegisterLocalModel`, `run.tsx`). `detail` hoje pode ecoar até 160
 * chars do CORPO CRU do provider (ANSI/BEL/pseudo-segredo, ACHADO-A do parecer de
 * segurança) e, no branch de rede/timeout/redirect-bloqueado, a `location`/
 * `baseURL` via `e.message` (SSRF). Esta função DESCARTA os dois:
 *
 *   - `detail` bate `/^HTTP (\d{3})\b/` (branch HTTP do `checkModelConnectivity`,
 *     linha `return { ok:false, detail: \`HTTP ${status}${hint} ${body}\` }`) ⇒
 *     devolve SÓ `modelo local "<slug>" não respondeu: HTTP <ddd><hint>` — o
 *     `<hint>` é RECALCULADO aqui (401/403 ⇒ " — chave inválida?", 404 ⇒
 *     " — modelo ou baseURL errado?", senão vazio); o corpo de 160 chars É
 *     DESCARTADO por completo (nunca chega à TUI).
 *   - Qualquer outro formato (branch `catch` — rede/timeout/redirect BLOQUEADO
 *     pelo anti-SSRF, EST-1115) ⇒ texto FIXO, sem interpolar `detail`/`e.message`
 *     (nunca vaza `location`/`baseUrl`/host interno).
 *
 * PURA — recebe o `detail` já produzido, nunca refaz a chamada. Exportada p/ o
 * `controller.ts` (que monta o erro por-filho) e testável isoladamente.
 */
export function formatConnectivityFailureDetail(slug: string, detail: string): string {
  const m = /^HTTP (\d{3})\b/.exec(detail);
  if (m !== null) {
    const status = Number(m[1]);
    const hint =
      status === 401 || status === 403
        ? ' — chave inválida?'
        : status === 404
          ? ' — modelo ou baseURL errado?'
          : '';
    return `modelo local "${slug}" não respondeu: HTTP ${m[1]}${hint}`;
  }
  return `modelo local "${slug}" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).`;
}
