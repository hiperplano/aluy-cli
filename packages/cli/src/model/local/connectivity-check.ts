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

export async function checkModelConnectivity(args: {
  readonly wireFormat: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly key: string;
  /** `fetch` injetável (testes). Default: global fetch. */
  readonly fetchImpl?: typeof fetch;
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
