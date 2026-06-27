// EST-1015 (POC — pedido do dono: "acople e teste com o headroom") — cliente FETCH do
// PROXY headroom (`POST /v1/compress`). Comprime as mensagens ANTES de irem ao broker,
// para economizar tokens em saídas de ferramenta verbosas (logs, dumps, RAG).
//
// ⚠️ EXPERIMENTAL — OFF por default. Liga SÓ com `ALUY_HEADROOM_URL` (ex.:
//    http://127.0.0.1:8787) apontando p/ um proxy headroom que o usuário roda. SEM
//    dependência npm: o aluy só faz HTTP ao proxy (o pacote `headroom-ai` é cliente do
//    mesmo proxy — não precisamos dele aqui).
//
// LIMITES CONHECIDOS (por isso é POC, NÃO produção — atrás de arquiteto+seguranca):
//   • 2ª HOP de rede do PROMPT: o conteúdo (com observações de tool, possivelmente
//     código/segredo já redigido na origem) sai p/ o proxy ⇒ toca CLI-SEC-7 (caminho
//     único pelo broker) e egress. O proxy, por sua vez, pode baixar modelo/ONNX.
//   • LOSSY: a compressão CCR do headroom DEDUPA/TRUNCA e deixa um marcador
//     "[… Retrieve more: hash=…]". O modelo PODE recuperar o conteúdo dedupado pela tool
//     `headroom_retrieve` — JÁ WIRED (wiring.ts monta a tool quando `ALUY_HEADROOM_URL`
//     aponta p/ o proxy; efeito `network`, atrás da catraca como web_fetch). Ainda assim
//     é POC (medir/demonstrar): se o modelo NÃO recuperar, a saída segue degradada.
//   • FAIL-OPEN: QUALQUER erro/timeout/forma inesperada ⇒ devolve as mensagens ORIGINAIS
//     (nunca quebra o turno). Preserva role/tool_calls/tool_call_id — só troca `content`.

import type { ChatMessage, HostResolver } from '@aluy/cli-core';
import { headroomFetch } from './headroom-fetch.js';

export interface HeadroomOptions {
  /** Base URL do proxy headroom (ex.: `http://127.0.0.1:8787`). */
  readonly baseUrl: string;
  /** Modelo-alvo (o headroom usa p/ contar tokens). Default genérico. */
  readonly model?: string;
  /** `fetch` injetável (teste). Default `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
  /** EST-1075 — resolver de host injetável (teste). Default `NodeHostResolver`. */
  readonly resolver?: HostResolver;
  readonly signal?: AbortSignal;
  /**
   * F84 — teto DURO de tempo (ms) p/ o compress. O compress roda no CAMINHO CRÍTICO
   * (antes de CADA chamada ao modelo); um proxy PENDURADO (aceita a conexão e nunca
   * responde) NÃO lança ⇒ sem este teto, `await compress` estala o loop até o ESC do
   * humano. Estourado ⇒ aborta ⇒ fail-open (mensagens ORIGINAIS). Default 2.5s
   * (mesmo corte do recall/judge, F78). 0/negativo ⇒ sem teto interno (back-compat).
   */
  readonly timeoutMs?: number;
  /** Callback com a economia medida pelo proxy (p/ logar/exibir). */
  readonly onSavings?: (info: { before: number; after: number; ratio: number }) => void;
  /**
   * EST-1075 · HR-SEC-2 — chamado quando o destino é RECUSADO (não-loopback / inválido):
   * o compress NÃO dispara (fail-open: devolve o original) e isto avisa UMA vez (o
   * caller dedupa). NUNCA carrega conteúdo de mensagem — só o motivo da recusa.
   */
  readonly onRefused?: (reason: string) => void;
}

interface CompressResponse {
  readonly messages?: ReadonlyArray<{
    readonly role?: unknown;
    readonly content?: unknown;
    readonly tool_calls?: unknown;
    readonly tool_call_id?: unknown;
  }>;
  readonly tokens_before?: number;
  readonly tokens_after?: number;
  readonly compression_ratio?: number;
}

/** F84 — teto default do compress (ms). Mesmo corte do recall/judge (F78). */
export const DEFAULT_COMPRESS_TIMEOUT_MS = 2_500;

/** `ALUY_HEADROOM_URL` (trim). Vazio/ausente ⇒ `undefined` (desligado). PURO. */
export function headroomUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const u = env.ALUY_HEADROOM_URL?.trim();
  return u !== undefined && u !== '' ? u : undefined;
}

/**
 * Comprime `messages` via o proxy headroom. FAIL-OPEN: erro/forma inesperada ⇒ devolve o
 * ORIGINAL. Preserva TODOS os campos da mensagem (role/tool_calls/tool_call_id) e só troca
 * o `content` pelo comprimido — e só quando a contagem/ordem batem (senão, original).
 */
export async function compressViaHeadroom(
  messages: readonly ChatMessage[],
  opts: HeadroomOptions,
): Promise<readonly ChatMessage[]> {
  if (messages.length === 0) return messages;
  // F84 — teto DURO de tempo: um proxy PENDURADO não lança, então sem isto o
  // `await` abaixo (caminho crítico, antes de cada chamada ao modelo) estalaria o
  // loop. O AbortController interno dispara no teto E encaminha o abort EXTERNO
  // (ESC/Ctrl-C). Abortado ⇒ headroomFetch lança/recusa ⇒ cai no fail-open (original).
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPRESS_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
  const onExternalAbort = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (opts.signal?.aborted) ac.abort();
  try {
    // EST-1075 · HR-SEC-1/2 — valida (loopback-only) + pina ANTES de qualquer byte sair.
    // Destino não-loopback ⇒ compress NÃO dispara (fail-open: original) + avisa 1×.
    const outcome = await headroomFetch(
      opts.baseUrl,
      '/v1/compress',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, model: opts.model ?? 'claude-3-5-sonnet' }),
        signal: ac.signal,
      },
      {
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      },
    );
    if (!outcome.ok) {
      opts.onRefused?.(outcome.reason);
      return messages; // destino recusado ⇒ roda como headroom-off.
    }
    const res = outcome.response;
    if (!res.ok) return messages;
    const data = (await res.json()) as CompressResponse;
    const out = data.messages;
    // Só aceita quando a forma BATE (mesma contagem) — senão é arriscado remapear ⇒ original.
    if (!Array.isArray(out) || out.length !== messages.length) return messages;
    // EST-1075 · HR-SEC-3 — a resposta do proxy é DADO NÃO-CONFIÁVEL (CLI-SEC-4): o proxy
    // pode estar comprometido/buggado. Ele SÓ pode dedupar/encurtar `content`. REJEITA
    // (fail-open ⇒ ORIGINAL) se adulterar a ESTRUTURA — `role` trocado, ou `tool_calls`/
    // `tool_call_id` FABRICADO que não existia no original. Isso impede que um `[N items
    // compressed]` ou um `content` injetado VIRE uma mensagem `system`/ordem ou forje uma
    // tool-call. NÃO basta preservar implícito (`...orig`): tem de DETECTAR e recusar.
    for (let i = 0; i < messages.length; i++) {
      const orig = messages[i] as ChatMessage & {
        readonly tool_calls?: unknown;
        readonly tool_call_id?: unknown;
      };
      const ret = out[i];
      if (ret === undefined) return messages;
      if (ret.role !== undefined && ret.role !== orig.role) {
        opts.onRefused?.(`proxy adulterou o role da mensagem ${i} (${String(ret.role)})`);
        return messages;
      }
      if (ret.tool_calls !== undefined && orig.tool_calls === undefined) {
        opts.onRefused?.(`proxy injetou tool_calls na mensagem ${i}`);
        return messages;
      }
      if (ret.tool_call_id !== undefined && orig.tool_call_id === undefined) {
        opts.onRefused?.(`proxy injetou tool_call_id na mensagem ${i}`);
        return messages;
      }
    }
    opts.onSavings?.({
      before: data.tokens_before ?? 0,
      after: data.tokens_after ?? 0,
      ratio: data.compression_ratio ?? 1,
    });
    return messages.map((orig, i) => {
      const c = out[i]?.content;
      // F97 (HR-SEC-3) — compressão DEDUPA/ENCURTA texto EXISTENTE; ela NÃO materializa
      // `content` onde não havia. Sem o guard de `orig.content !== ''`, um proxy
      // comprometido/buggado injeta `content` num turno de `content` VAZIO — em especial
      // numa mensagem `assistant` com `tool_calls` (content `''`), FABRICANDO fala do
      // modelo (que o turno seguinte trata como raciocínio próprio confiável). Reescrever
      // content NÃO-vazio segue permitido (é a compressão lossy aceita); materializar
      // sobre vazio, não. (Crescer o content é fora-de-contrato, mas o fail-open ao
      // original ao recusar seria a degradação segura — aqui focamos a materialização.)
      const accept = typeof c === 'string' && orig.content !== '' && c !== orig.content;
      return accept ? { ...orig, content: c } : orig;
    });
  } catch {
    return messages; // FAIL-OPEN — nunca derruba o turno por causa do compressor (inclui timeout/abort).
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}
