// EST-1010 (BUG-0020) — TETO de BYTES por turno de stream (anti-OOM client-side).
//
// COMPLEMENTA a guarda de degeneração (EST-0969): aquela pega o LOOP repetitivo
// (mesma linha / ciclo curto sem novidade); ESTA pega o stream GIGANTE NÃO-
// repetitivo — um broker bugado, um `done` que nunca chega, ou um modelo que
// despeja megabytes de prosa nova. Sem ela, `content += ev.content` e
// `toolCalls.push(...)` acumulam SEM LIMITE no cliente até OOM, mesmo quando a
// degeneração nunca dispara (porque o conteúdo não se repete).
//
// Contrato deliberadamente DIFERENTE do guard de degeneração:
//
//   - Degeneração LANÇA `DegenerateLoopError` ⇒ o loop converte num `stop` de
//     erro (turno descartado como degenerado).
//   - O teto de bytes NÃO lança: ele SINALIZA (`push` devolve `true`) p/ o
//     acumulador PARAR de drenar o stream e DEVOLVER o turno acumulado (capado),
//     marcando `finish_reason` como truncado — igual ao truncamento de leitura de
//     arquivo gigante (preserva o trabalho parcial, só corta o excesso).
//
// Conta os bytes UTF-8 de TODO conteúdo agregado (`delta`) + uma estimativa dos
// bytes das tool-calls nativas (id + name + JSON dos args). Bounded por
// construção: guarda só o CONTADOR, nunca o conteúdo.

/** Teto default de bytes agregados por turno de stream. 24 MiB — bem acima de um
 * turno honesto (≈ centenas de KB), abaixo do ponto de pressão de heap. */
export const DEFAULT_MAX_STREAM_BYTES = 24 * 1024 * 1024;

/** Env p/ ajustar o teto (consolidação `ALUY_*`). Inteiro positivo de bytes. */
export const STREAM_MAX_BYTES_ENV = 'ALUY_STREAM_MAX_BYTES';

/** Env p/ DESLIGAR o teto (paridade com `ALUY_DEGENERATE_OFF`). */
export const STREAM_CAP_DISABLE_ENV = 'ALUY_STREAM_CAP_OFF';

/**
 * Motivo `finish_reason` quando o teto corta o turno. DADO de auditoria/UX —
 * o loop o trata como um turno NORMAL (texto/tool-calls preservados), só com
 * a marca honesta de que houve corte client-side.
 */
export const STREAM_CAP_FINISH_REASON = 'length_client_cap';

/**
 * Acumulador de teto de bytes do stream. Um por turno do modelo (estado é só o
 * contador corrente). `addText`/`addBytes` retornam `true` no exato chunk que
 * faz o total CRUZAR o teto — o acumulador de stream para de drenar AQUI.
 * `tripped` fica `true` após o primeiro cruzamento (idempotente). NO-OP quando
 * desligado (`max <= 0`): nunca corta (paridade com a guarda desligada).
 */
export class StreamByteCap {
  private readonly max: number;
  private total = 0;
  private _tripped = false;

  constructor(maxBytes: number = DEFAULT_MAX_STREAM_BYTES) {
    // max <= 0 ⇒ desligado (sentinela): nunca corta.
    this.max = maxBytes > 0 ? Math.floor(maxBytes) : 0;
  }

  /** `true` se o teto já foi cruzado neste turno. */
  get tripped(): boolean {
    return this._tripped;
  }

  /** Bytes agregados até agora (texto + tool-calls). */
  get bytes(): number {
    return this.total;
  }

  /** O teto efetivo (0 ⇒ desligado). */
  get limit(): number {
    return this.max;
  }

  /** Soma os bytes UTF-8 de um chunk de TEXTO. Retorna `true` se cruzou o teto. */
  addText(chunk: string): boolean {
    return this.addBytes(Buffer.byteLength(chunk, 'utf8'));
  }

  /**
   * Soma uma estimativa de bytes de uma TOOL-CALL nativa (id + name + JSON dos
   * args). Retorna `true` se cruzou o teto. Tolera args não-serializáveis
   * (fallback p/ um custo fixo — nunca lança).
   */
  addToolCall(call: {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }): boolean {
    let argBytes = 0;
    try {
      argBytes = Buffer.byteLength(JSON.stringify(call.input ?? {}), 'utf8');
    } catch {
      argBytes = 256; // estimativa de piso p/ input opaco/cíclico.
    }
    return this.addBytes(
      Buffer.byteLength(call.id, 'utf8') + Buffer.byteLength(call.name, 'utf8') + argBytes,
    );
  }

  /** Soma `n` bytes ao total. Retorna `true` se o teto foi cruzado. */
  addBytes(n: number): boolean {
    if (this.max <= 0) return false; // desligado.
    this.total += n > 0 ? n : 0;
    if (this.total > this.max) this._tripped = true;
    return this._tripped;
  }
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function isStreamCapDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env[STREAM_CAP_DISABLE_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Fábrica única do teto de bytes p/ os acumuladores de stream (DRY: a TUI
 * (`StreamingModelCaller`) e o agregado (`BrokerModelClient.call`) usam ESTA
 * mesma config). Lê o toggle + o teto do env (`env` injetável p/ teste).
 * Ligado por default; `ALUY_STREAM_CAP_OFF` ⇒ teto desligado (max 0).
 */
export function newStreamByteCap(
  env: Record<string, string | undefined> = process.env,
): StreamByteCap {
  if (isStreamCapDisabled(env)) return new StreamByteCap(0);
  return new StreamByteCap(parsePositiveInt(env[STREAM_MAX_BYTES_ENV]) ?? DEFAULT_MAX_STREAM_BYTES);
}
