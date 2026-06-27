// Parser de SSE (text/event-stream) PORTÁVEL — EST-0943, CA-2.
//
// Por que NÃO usar `EventSource`: a chamada ao broker é um POST com corpo +
// `Authorization` (credencial headless), e `EventSource` (WHATWG) só faz GET sem
// headers de auth. Por isso lemos o corpo da resposta `fetch` como um stream e
// parseamos os eventos nomeados (`event:`/`data:`) à mão, do jeito que o broker
// emite (`broker.md` §1.2). Sem deps, sem DOM — roda em qualquer locus (ADR-0053
// §8: o core é portável).
//
// Formato SSE (W3C): eventos separados por linha em branco; campos `field: value`
// por linha; `data:` pode repetir (concatena com `\n`); `event:` nomeia o tipo
// (default `message`); linha começando com `:` é comentário (heartbeat). O broker
// manda um JSON por `data:`.

/** Um evento SSE bruto (nome + payload de dados concatenado). */
export interface SseEvent {
  /** Nome do evento (`event:`); `message` se ausente. */
  readonly event: string;
  /** Dados (`data:` concatenados por `\n`). */
  readonly data: string;
}

/**
 * Fonte de bytes/linhas mínima que o parser consome: um async-iterable de
 * `Uint8Array` (corpo de `Response.body`) ou de `string` (testes). Mantemos o
 * contrato estreito p/ injetar um stream fake nos testes sem rede.
 */
export type ByteSource = AsyncIterable<Uint8Array | string>;

/**
 * Decodifica uma `ByteSource` em eventos SSE, na ORDEM (CA-2). Async-generator:
 * cada `yield` é um evento completo (já viu a linha em branco terminadora).
 * Buffer parcial entre chunks é preservado — um evento partido em 2 chunks
 * TCP é remontado corretamente.
 *
 * Cancelamento: o consumidor (loop) para de iterar / aborta o fetch; o
 * generator simplesmente deixa de ser puxado (não há recurso a fechar aqui — o
 * `Response.body` é fechado pelo abort do fetch no cliente).
 */
export async function* parseSse(source: ByteSource): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    // Normaliza CRLF→LF (SSE permite ambos). Processa enquanto houver um
    // separador de evento (linha em branco): `\n\n`.
    buffer = buffer.replace(/\r\n/g, '\n');
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseEventBlock(rawEvent);
      if (parsed) yield parsed;
      sep = buffer.indexOf('\n\n');
    }
  }

  // Flush final: um evento sem a linha em branco terminadora (stream fechou).
  // O broker sempre fecha com `\n\n`, mas somos tolerantes a um corte abrupto.
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail.length > 0) {
    const parsed = parseEventBlock(buffer);
    if (parsed) yield parsed;
  }
}

/** Parseia um bloco (linhas de um evento) em `{ event, data }` ou `null` (vazio/comentário). */
function parseEventBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  let sawField = false;

  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      // Linha em branco residual ou comentário/heartbeat — ignora.
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // SSE: um espaço após o `:` é opcional e descartado.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      event = value;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
    // `id`/`retry` e campos desconhecidos: ignorados (não usamos reconexão SSE —
    // o broker é um stream de turno único, sem `Last-Event-ID`).
  }

  if (!sawField) return null;
  return { event, data: dataLines.join('\n') };
}
