// EST-0948 — ModelCaller de STREAMING: usa `client.stream()` (EST-0943) p/ emitir
// tokens à TUI token-a-token, e agrega o resultado p/ o loop (EST-0944).
//
// O `BrokerModelCaller` do core agrega via `client.call()` (sem render ao vivo).
// A TUI quer o stream: este caller consome `client.stream()` DIRETO — o MESMO e
// ÚNICO caminho de modelo (CLI-SEC-7: stream/call são a mesma rota, não uma 2ª) —
// emitindo cada `delta` p/ um callback (a UI o concatena no TurnBlock) e
// devolvendo o `ModelCallResult` agregado que o contrato do loop exige.
//
// Mantém o `session_id` do broker entre turnos (ADR-0034). NÃO faz retry aqui
// (igual ao broker-client: erro estruturado sobe; o loop/tetos decidem).

import {
  newDegenerationSink,
  newStreamByteCap,
  pushOrMergeToolCall,
  STREAM_CAP_FINISH_REASON,
  type ModelClient,
  type ChatMessage,
  type LlmTier,
  type ModelCallContext,
  type ModelCaller,
  type ModelCallResult,
  type ModelUsage,
  type NativeToolCall,
  type NativeToolsCapability,
  type Quota,
} from '@hiperplano/aluy-cli-core';
import { compressViaHeadroom } from '../model/headroom.js';
import {
  decideRetry,
  resolveRetry,
  RETRY_OFF,
  ModelCallAbortedError,
  type RetryConfig,
} from '@hiperplano/aluy-cli-core';

/**
 * F-RETRY — espera ABORTÁVEL entre tentativas. Um `sleep` cru prenderia o usuário até o
 * fim do timer mesmo após o Ctrl-C; aqui o abort resolve na hora, lançando o MESMO erro
 * de cancelamento que o resto do caminho já entende (e que `decideRetry` nunca retenta).
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ModelCallAbortedError());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(t);
      reject(new ModelCallAbortedError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Eventos de stream que a UI observa (token-a-token + usage). */
export interface StreamSink {
  /** Início de um turno do modelo (limpa o buffer do TurnBlock). */
  onStart?(): void;
  /** Um chunk de conteúdo (a UI concatena no TurnBlock corrente). */
  onDelta(content: string): void;
  /** Trailer de uso (◷ tokens / ⛁ janela). */
  onUsage?(usage: ModelUsage): void;
  /**
   * EST-0948 (footer/quota) — a QUOTA do usuário (5h/semana) que o broker reportou
   * neste response. BILLING (do broker), distinta do budget LOCAL do `onUsage`.
   * Só emitido quando o broker mandou; ausente ⇒ o footer degrada (oculto).
   */
  onQuota?(quota: Quota): void;
  /** Fim do turno do modelo. */
  onDone?(): void;
}

/** F-RETRY — o que a UI recebe a cada retentativa (o contador `n/N` na tela). */
export interface RetryNotice {
  /** Tentativa que ACABOU de falhar (1-based). */
  readonly attempt: number;
  /** Teto de tentativas extras configurado. */
  readonly max: number;
  /** Espera até a próxima (ms) — honra `Retry-After` quando o provider manda. */
  readonly waitMs: number;
  /** Motivo curto (`HTTP 503`, `falha de rede`…) p/ o usuário entender o porquê. */
  readonly reason: string;
}

export interface StreamingModelCallerOptions {
  // ADR-0120 — broker OU local: o caller de stream da TUI não distingue.
  readonly client: ModelClient;
  /**
   * F-RETRY — config de retentativa. Ausente ⇒ resolve de env/config (ligado por
   * default). `RETRY_OFF` ⇒ baseline exato de antes (erro sobe na 1ª falha).
   */
  readonly retry?: RetryConfig;
  /** F-RETRY — chamado ANTES de cada espera, p/ a UI mostrar o contador. */
  readonly onRetry?: (n: RetryNotice) => void;
  readonly tier: LlmTier;
  /** EST-0962 (Custom) — slug inicial da via Custom (só sob `tier:'custom'`). */
  readonly model?: string;
  /**
   * EST-0962 (`--provider`) — NOME do provider em par com `model` da via Custom (só
   * sob `tier:'custom'`). É só o NOME (DADO, não credencial); o broker resolve
   * `(provider, model)` server-side (HG-2/CLI-SEC-7). Estático na sessão (vem do
   * `--provider` no boot). `undefined` ⇒ o broker escolhe o provider (retrocompat).
   */
  readonly provider?: string;
  /**
   * EST-0962 (`--effort`) — `reasoning_effort` PASSTHROUGH (qualquer string não-vazia
   * ≤32 chars; low/medium/high são comuns mas CUSTOM é aceito). SEM tier-gate: vale em
   * qualquer tier. Vem do `--effort` no boot. `undefined` ⇒ NÃO é enviado (o provider
   * usa o default). Mutável em runtime via `/effort`.
   */
  readonly effort?: string;
  readonly sessionId?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly context?: ModelCallContext;
  /**
   * URL do proxy headroom (compressão de contexto), JÁ RESOLVIDA config-driven pelo wiring
   * (`resolveHeadroomUrl`: turbo+toggle/services/env). `undefined` ⇒ compressão OFF. Antes o
   * caller lia `ALUY_HEADROOM_URL` do env direto (env-only) — agora é injetada (config-driven).
   */
  readonly headroomUrl?: string;
  /**
   * F-SIDECAR-USO — CONTABILIZA cada compressão de contexto. O caller é o ÚNICO lugar
   * do caminho quente que consulta o headroom (`compressViaHeadroom`, antes de CADA
   * chamada ao modelo), então é daqui que sai o número que a StatusBar mostra. `ok`
   * distingue compressão APLICADA de fail-open (que segue com as mensagens originais).
   * Ausente ⇒ nada é contado (baseline).
   */
  readonly onHeadroomUsed?: (ok: boolean) => void;
  /** Para onde os tokens são emitidos ao vivo (a UI). */
  readonly sink: StreamSink;
  /**
   * EST-0996 — CAPACIDADE de tool-calling NATIVO. Quando presente e ativa, o caller
   * envia o catálogo `tools` (HG-2) e, num `422 TOOLS_UNSUPPORTED`, REPETE 1× SEM
   * tools (degrade gracioso p/ o protocolo de texto, #99). Ausente ⇒ chat de texto
   * puro (baseline — não-regressão). É a MESMA `NativeToolsCapability` do core.
   */
  readonly nativeTools?: NativeToolsCapability;
}

export class StreamingModelCaller implements ModelCaller {
  private readonly client: ModelClient;
  private readonly opts: StreamingModelCallerOptions;
  private brokerSessionId: string | undefined;
  // EST-0962 — o tier é MUTÁVEL na sessão (o seletor `/model` o troca em runtime).
  // A próxima chamada de modelo usa este valor; o broker resolve provider/credencial
  // server-side (HG-2 intocado — só o tier muda de pista). Estado de sessão, não
  // persiste global (FU). Continua sendo a pista de modelo (CLI-SEC-7).
  private currentTier: LlmTier;
  // EST-0996 — capacidade de tool-calling NATIVO. MUTÁVEL: o controller (dono do
  // toolset final = nativas + web + MCP + spawn) a CONSTRÓI e a ATTACHA aqui após
  // montar o registry (`attachNativeTools`). Antes do attach (ou sem suporte) ⇒
  // chat de texto puro (baseline). undefined ⇒ nunca manda tools.
  private nativeTools: NativeToolsCapability | undefined;
  // EST-0962 (Custom, ADR-0030 §3) — slug do modelo da via Custom. SÓ tem efeito
  // sob `tier:'custom'`: a chamada o envia junto do tier (o `buildChatBody` ainda
  // re-trava em `tier === 'custom'`). `undefined` nos tiers canônicos. Trocar p/
  // um tier canônico LIMPA o slug (não vaza Custom em tier normal).
  private customModel: string | undefined;
  // EST-0962 (`--provider`) — NOME do provider em par com o slug Custom do BOOT (do
  // `--provider`). SÓ acompanha o `customModel` da LARGADA: trocar de modelo/tier em
  // runtime (`/model`) o LIMPA (o seletor não carrega provider — não atribuiria o
  // provider do `--provider` a outro slug). É só o NOME (DADO, não credencial — HG-2).
  private customProvider: string | undefined;
  // EST-0962 (`--effort` / `/effort`) — `reasoning_effort` PASSTHROUGH (qualquer string
  // ≤32 chars). SEM tier-gate: vale em qualquer tier. `undefined` ⇒ NÃO é enviado (o
  // provider usa o default).
  private reasoningEffort: string | undefined;
  // EST-1075 · HR-SEC-2 — avisa UMA vez quando o destino headroom é recusado (não-loopback).
  private headroomRefusedWarned = false;

  /** F-RETRY — config resolvida uma vez no boot (env > config > default). */
  private readonly retryCfg: RetryConfig;

  constructor(opts: StreamingModelCallerOptions) {
    this.client = opts.client;
    this.opts = opts;
    // Injetada (testes/wiring) OU resolvida do ambiente. `ALUY_RETRY=off` desliga.
    this.retryCfg =
      opts.retry ??
      resolveRetry({
        attemptsEnv: process.env.ALUY_RETRY,
        waitMsEnv: process.env.ALUY_RETRY_WAIT_MS,
      });
    void RETRY_OFF; // re-exportado p/ os testes/wiring desligarem explicitamente.
    this.brokerSessionId = opts.sessionId;
    this.currentTier = opts.tier;
    this.customModel = opts.model;
    // O provider só vale em par com o slug Custom do boot (sob `tier:'custom'`).
    this.customProvider =
      opts.tier === 'custom' && opts.model !== undefined ? opts.provider : undefined;
    this.reasoningEffort = opts.effort;
    this.nativeTools = opts.nativeTools;
  }

  /**
   * EST-0996 — ATTACHA a capacidade de tool-calling NATIVO (o controller a constrói
   * do toolset FINAL — nativas+web+MCP+spawn — e a injeta após montar o registry).
   * A próxima chamada já manda `tools` (se o modelo suportar). Idempotente.
   */
  attachNativeTools(cap: NativeToolsCapability): void {
    this.nativeTools = cap;
  }

  /**
   * Troca o tier da sessão (seletor `/model`). A próxima chamada já o usa. O
   * 2º argumento é o slug Custom: só faz sentido com `tier:'custom'`. Trocar p/
   * um tier canônico LIMPA o slug — Custom não vaza p/ um tier normal (HG-2).
   */
  setTier(tier: LlmTier, model?: string): void {
    this.currentTier = tier;
    this.customModel = tier === 'custom' ? model : undefined;
    // EST-0962 — trocar de modelo/tier em runtime (`/model`) DESCARTA o provider corrente:
    // o slug novo não herda o provider do slug anterior (par model+provider). A próxima
    // chamada deixa o broker escolher o provider do novo slug, até um `/provider` re-setar.
    this.customProvider = undefined;
  }

  /**
   * EST-0962 · /provider — SETA o NOME do provider do modo Custom (slash `/provider`). A
   * próxima chamada já o envia em par com o slug Custom corrente. Só vale sob
   * `tier:'custom'` E com um `model` (slug) presente — fora disso é um no-op (não há
   * modelo Custom a parear). `name` undefined ⇒ LIMPA (volta ao default do broker). É só
   * o NOME (DADO, não credencial — HG-2/CLI-SEC-7); o broker resolve `(provider, model)`.
   */
  setProvider(name: string | undefined): void {
    this.customProvider =
      this.currentTier === 'custom' && this.customModel !== undefined ? name : undefined;
  }

  /** O tier corrente da sessão (p/ a status bar/teste). */
  get tier(): LlmTier {
    return this.currentTier;
  }

  /** O slug Custom corrente (p/ a status bar/teste). `undefined` fora de Custom. */
  get model(): string | undefined {
    return this.customModel;
  }

  /** O NOME do provider Custom corrente (p/ o picker/StatusBar/teste). `undefined`
   * fora de Custom OU quando o broker escolhe o default. Nunca credencial (HG-2). */
  get provider(): string | undefined {
    return this.customProvider;
  }

  /**
   * EST-0962 · /effort — SETA o `reasoning_effort` (slash `/effort`). A próxima
   * chamada já o envia SEM tier-gate (vale em qualquer tier). `v` undefined ⇒ LIMPA
   * (volta ao default do provider). É só um valor PASSTHROUGH (DADO, não credencial).
   */
  setEffort(v: string | undefined): void {
    this.reasoningEffort = v;
  }

  /** O `reasoning_effort` corrente (p/ a status bar / `/effort` sem argumento).
   * `undefined` ⇒ o provider usa o default. */
  get effort(): string | undefined {
    return this.reasoningEffort;
  }

  async call(argsIn: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ModelCallResult> {
    // EST-1015 (headroom) — quando há URL do headroom, comprime as mensagens via o proxy ANTES
    // do broker (economia de tokens em saídas de tool verbosas). FAIL-OPEN (erro ⇒ originais).
    // ⚠️ EXPERIMENTAL: 2ª hop de rede do prompt (CLI-SEC-7) + CCR lossy. A URL vem INJETADA pelo
    // wiring (config-driven: turbo+toggle/services/env), não mais lida do env aqui.
    const headroomUrl = this.opts.headroomUrl;
    const args =
      headroomUrl === undefined
        ? argsIn
        : {
            ...argsIn,
            messages: await compressViaHeadroom(argsIn.messages, {
              baseUrl: headroomUrl,
              ...(argsIn.signal ? { signal: argsIn.signal } : {}),
              onSavings: ({ before, after }) => {
                if (before > after) {
                  process.stderr.write(
                    `[headroom] mensagens comprimidas: ${before} → ${after} tokens (-${before - after})\n`,
                  );
                }
              },
              // F-SIDECAR-USO — marca USO (compressão APLICADA) vs FALHA (fail-open:
              // recusa/timeout/HTTP ruim/proxy adulterado ⇒ mensagens ORIGINAIS). É o
              // sinal que faz o chip `hdr` acender em vez de só dizer "está de pé".
              ...(this.opts.onHeadroomUsed ? { onUsed: this.opts.onHeadroomUsed } : {}),
              onRefused: (reason) => {
                if (!this.headroomRefusedWarned) {
                  this.headroomRefusedWarned = true;
                  process.stderr.write(
                    `[headroom] compressão DESLIGADA nesta sessão — ${reason}. ` +
                      `Rodando sem headroom (fail-open).\n`,
                  );
                }
              },
            }),
          };
    // F-RETRY — laço EXTERNO de RETENTATIVA, por cima do degrade de tools. Só re-tenta
    // o que é TRANSITÓRIO (rede/timeout/429/5xx — `decideRetry`): "o provider negou"
    // (401/404/400/422/recusa) NÃO se retenta, porque é determinístico e, no backend
    // LOCAL/BYO, cada tentativa que chega ao provider CUSTA DINHEIRO. Cancelamento
    // (`ModelCallAbortedError`) nunca se retenta — é ordem do dono.
    //
    // A `idempotencyKey` é a MESMA em todas as tentativas (ela vem pronta do loop, e
    // este é exatamente o caso p/ o qual ela nasceu): o broker DEDUPLICA o billing de
    // um retry de transporte, então re-tentar não cobra duas vezes pela mesma chamada
    // lógica.
    let attempt = 0;
    for (;;) {
      try {
        return await this.callOnceWithToolDegrade(args);
      } catch (e) {
        attempt += 1;
        const verdict = decideRetry(e, attempt, this.retryCfg);
        if (!verdict.retry) throw e;
        // Avisa a UI ANTES de dormir (o contador `n/N` fica visível durante a espera).
        this.opts.onRetry?.({
          attempt,
          max: this.retryCfg.attempts,
          waitMs: verdict.waitMs,
          reason: verdict.reason,
        });
        // A espera é ABORTÁVEL: Ctrl-C durante o backoff encerra na hora, em vez de
        // prender o usuário até o fim do timer.
        await sleepAbortable(verdict.waitMs, args.signal);
      }
    }
  }

  /**
   * EST-0996 — laço do DEGRADE: 1ª passada COM tools (se suportado); se o broker
   * responder `422 TOOLS_UNSUPPORTED`, a capacidade se desliga e repetimos UMA vez SEM
   * tools (fallback p/ o protocolo de texto, #99). Sem capacidade ⇒ uma única passada de
   * texto puro (baseline). Extraído de `call()` p/ que o laço de RETENTATIVA (F-RETRY)
   * envolva o degrade inteiro — um blip de rede na passada sem-tools também re-tenta.
   */
  private async callOnceWithToolDegrade(args: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ModelCallResult> {
    for (let nativeAttempt = 0; nativeAttempt < 2; nativeAttempt++) {
      const withTools = this.nativeTools?.shouldSendTools() ?? false;
      try {
        return await this.streamOnce(args, withTools);
      } catch (e) {
        // Só degrada se ESTA passada MANDOU tools E o erro é o 422 de tools.
        if (withTools && this.nativeTools?.degradeOnUnsupported(e)) {
          continue;
        }
        throw e;
      }
    }
    // inalcançável (cada passada retorna ou lança), mas o TS exige.
    throw new Error('streaming-caller: estado inalcançável no degrade de tools');
  }

  /**
   * UMA passada de stream (com ou sem `tools`). Emite os deltas à UI, acumula as
   * tool-calls NATIVAS (`event: tool_call` agregado) e devolve o `ModelCallResult`.
   * Separada de `call()` p/ que o DEGRADE no 422 possa re-tentar SEM tools sem
   * duplicar a lógica de consumo do stream.
   */
  private async streamOnce(
    args: {
      readonly messages: readonly ChatMessage[];
      readonly idempotencyKey: string;
      readonly signal?: AbortSignal;
    },
    withTools: boolean,
  ): Promise<ModelCallResult> {
    const sink = this.opts.sink;
    let content = '';
    let requestId = '';
    let sessionId: string | undefined;
    let finishReason = 'stop';
    let usage: ModelUsage | undefined;
    let quota: Quota | undefined;
    // EST-0996 — tool-calls NATIVAS agregadas deste turno (vazio ⇒ o loop cai no texto).
    const toolCalls: NativeToolCall[] = [];
    // EST-0969 (anti-runaway) — MESMA guarda anti-repetição do core, no caminho de
    // STREAM da TUI: cada delta a alimenta; se o conteúdo degenerar, ela lança
    // `DegenerateLoopError`, o consumo do stream para AQUI e o AgentLoop o converte
    // num `stop:'degenerate'`. Os tokens já renderizados (parcial do turno) ficam —
    // é só o turno que é cortado. Ligada por default; `ALUY_DEGENERATE_OFF` ⇒ no-op.
    const guard = newDegenerationSink();
    // EST-1010 (BUG-0020) — TETO de BYTES agregados (anti-OOM client-side), no caminho
    // de STREAM da TUI. COMPLEMENTA a guarda de degeneração: aquela pega o LOOP
    // repetitivo; este pega o stream GIGANTE NÃO-repetitivo (broker bugado / `done`
    // que nunca chega). Ao cruzar o teto, PARA de drenar e devolve o turno acumulado
    // (capado) com `finish_reason` truncado — os tokens já renderizados ficam.
    const cap = newStreamByteCap();
    let capped = false;
    // EST-0996 — campos de tool-calling SÓ quando suportado/ativo (HG-2: catálogo).
    const toolFields = withTools ? this.nativeTools!.requestFields() : undefined;

    sink.onStart?.();

    const stream = this.client.stream({
      request: {
        tier: this.currentTier,
        // Via Custom: o slug acompanha o tier. O `buildChatBody` re-trava em
        // `tier === 'custom'` (defesa em profundidade — não vaza em tier canônico).
        ...(this.currentTier === 'custom' && this.customModel !== undefined
          ? { model: this.customModel }
          : {}),
        // EST-0962 (`--provider`) — o NOME do provider acompanha o slug Custom (par
        // model+provider). Trava igual à do `model` + `buildChatBody` re-trava em
        // `tier === 'custom'`. Só o NOME (DADO, não credencial — HG-2). Ausente ⇒
        // o broker escolhe o provider (retrocompat).
        ...(this.currentTier === 'custom' &&
        this.customModel !== undefined &&
        this.customProvider !== undefined
          ? { provider: this.customProvider }
          : {}),
        messages: args.messages,
        ...(this.brokerSessionId !== undefined ? { session_id: this.brokerSessionId } : {}),
        ...(this.opts.maxTokens !== undefined ? { max_tokens: this.opts.maxTokens } : {}),
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
        ...(this.opts.context !== undefined ? { context: this.opts.context } : {}),
        // EST-0962 (--effort / /effort) — reasoning_effort PASSTHROUGH (qualquer string
        // ≤32 chars). SEM tier-gate: vale em qualquer tier. `undefined` ⇒ NÃO sai.
        ...(this.reasoningEffort !== undefined ? { reasoning_effort: this.reasoningEffort } : {}),
        ...(toolFields ?? {}),
      },
      idempotencyKey: args.idempotencyKey,
      ...(args.signal ? { signal: args.signal } : {}),
    });

    for await (const ev of stream) {
      switch (ev.type) {
        case 'start':
          requestId = ev.request_id;
          sessionId = ev.session_id;
          if (sessionId !== undefined) this.brokerSessionId = sessionId;
          break;
        case 'delta':
          content += ev.content;
          sink.onDelta(ev.content);
          guard.push(ev.content);
          if (cap.addText(ev.content)) capped = true;
          break;
        case 'tool_call':
          // EST-0996 — tool-call NATIVA agregada: acumula na ordem (1+ por turno).
          // NÃO vai pro `onDelta` (não é prosa) — a UI a renderiza pela linha `⏺`
          // que o loop já pinta no `onToolStart`, igual ao caminho de texto.
          // HUNT-SSE — COALESCE por `id` (mesmo motivo do broker-client.call): se o
          // broker vazar fragmentos do MESMO id, funde em UMA call em vez de empilhar
          // duplicata (que daria `tool_call_id` repetido ⇒ 400 do provider no resume).
          pushOrMergeToolCall(toolCalls, ev.call);
          if (cap.addToolCall(ev.call)) capped = true;
          break;
        case 'usage':
          usage = ev.usage;
          sink.onUsage?.(ev.usage);
          break;
        case 'quota':
          quota = ev.quota;
          sink.onQuota?.(ev.quota);
          break;
        case 'done':
          finishReason = ev.finish_reason;
          break;
      }
      // EST-1010 — teto cruzado: encerra o consumo do stream AQUI (o generator deixa
      // de ser drenado ⇒ a conexão fecha) e marca o motivo. NÃO lança — o turno
      // parcial é válido (texto/tool-calls renderizados ficam).
      if (capped) {
        finishReason = STREAM_CAP_FINISH_REASON;
        break;
      }
    }

    sink.onDone?.();

    return {
      request_id: requestId,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      content,
      finish_reason: finishReason,
      ...(usage !== undefined ? { usage } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(quota !== undefined ? { quota } : {}),
    };
  }
}
