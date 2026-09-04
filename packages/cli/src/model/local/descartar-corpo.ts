// SAÍDA EM 2 CTRL-C — LIBERAR o socket de uma resposta que decidimos NÃO ler.
//
// O SINTOMA (medido no tmux, byte `0x03` literal, 1s entre apertos): o rodapé promete
// "ctrl-c×2 sair" e eram precisos TRÊS apertos. O 2º Ctrl-C fazia tudo certo — o
// `decideCtrlC` devolvia `exit`, o Ink desmontava (`waitUntilExit` resolvia em 8ms) e o
// teardown inteiro (telegram/MCP/save) terminava em ~90ms. Só que o processo NÃO morria:
// quem o encerrava era o CÃO DE GUARDA de 2s do `run.tsx` (o `process.exit` forçado).
// Nesses ~2,2s a tela ficava PARADA no último frame desenhado — que ainda dizia
// "pressione ctrl-c de novo para sair". O dono lia aquilo como "o 2º aperto não fez
// nada" e apertava a 3ª vez — que o `useInput` já nem via (o Ink tinha desmontado; o
// log instrumentado registra DOIS eventos, não três). E o 3º aperto nem era necessário:
// medido SEM ele, o processo morria igual, 2230ms depois do 2º. O "×3" era o intervalo
// do cão de guarda caindo em cima do dedo de quem esperava.
//
// A CAUSA, medida: `process._getActiveHandles()` no instante do cão de guarda mostrava
// um `TLSSocket[api.tokenrouter.com]` com `_httpMessage = /v1/credits`. O fetch PINADO
// (`pinned-stream-fetch.ts`) é `node:https.request` — o corpo é uma `IncomingMessage`.
// Enquanto ela não é consumida NEM destruída, o socket segue ATRIBUÍDO à requisição:
// não volta ao pool livre do agent (é lá, e só lá, que o Node o `unref`a) e portanto
// SEGURA o laço de eventos indefinidamente. O `/credits` do tokenrouter responde 404, e
// o `if (!res.ok) return undefined` da descoberta de saldo largava o corpo ali — a cada
// boot, sem erro, sem rastro. Com o corpo liberado, a saída medida caiu de 2230ms para
// 265ms (e o `handles` final some com o socket).
//
// POR QUE `destroy()` e não drenar: drenar leria um corpo de tamanho desconhecido de um
// host que nem sempre é o nosso (o mesmo egress BYO que o anti-SSRF do fetch pinado
// vigia). `destroy()` é O(1), não lê byte nenhum e devolve o socket ao Node na hora.
// Perder o keep-alive daquela conexão é irrelevante aqui: todos os pontos de chamada
// são consultas ONE-SHOT de boot (saldo, `/models`, ping de conectividade).
//
// A REGRA, para o próximo: **toda** resposta do fetch pinado ou é consumida
// (`text()`/`json()`/iterar `body`) ou passa por aqui. Um único ponto de chamada
// esquecido segura o processo do mesmo jeito — o inventário está no teste
// `tests/model/local/corpo-descartado.test.ts`, que falha se um deles regredir.

/**
 * Descarta o corpo de uma resposta que não vamos ler, liberando o socket.
 *
 * Best-effort e TOLERANTE à forma do corpo (os chamadores recebem um `StreamFetch`
 * injetável — em teste o corpo costuma ser `null`/string, e aí isto é no-op):
 * - `IncomingMessage` (node:http/https, o caso real do fetch pinado) ⇒ `destroy()`;
 * - `ReadableStream` do WHATWG (`globalThis.fetch`) ⇒ `cancel()`;
 * - qualquer outra coisa ⇒ no-op.
 *
 * NUNCA lança: falhar em descartar não pode derrubar quem já estava degradando.
 */
export function descartarCorpo(res: unknown): void {
  // `unknown` de propósito: os três chamadores tipam a resposta pelo SUBSET que
  // consomem (`ConnectivityFetch` só declara `ok`/`status`/`text()`), e o corpo real
  // chega por baixo, vindo do fetch pinado. Exigir um tipo com `body` obrigaria a
  // alargar aquelas portas só para poder descartar — o oposto do que elas defendem.
  const body = (res as { body?: unknown } | null | undefined)?.body as
    | {
        destroy?: (err?: Error) => void;
        cancel?: () => unknown;
      }
    | null
    | undefined;
  if (body === null || body === undefined) return;
  try {
    if (typeof body.destroy === 'function') {
      body.destroy();
      return;
    }
    if (typeof body.cancel === 'function') {
      // `cancel()` do WHATWG devolve Promise; um reject aqui é ruído, não erro nosso.
      void Promise.resolve(body.cancel()).catch(() => undefined);
    }
  } catch {
    /* best-effort: descartar corpo nunca é motivo de erro para o chamador. */
  }
}
