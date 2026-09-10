// SAÍDA EM 2 CTRL-C — o socket de uma resposta que ninguém leu não pode segurar o processo.
//
// O DEFEITO que este arquivo trava (medido no tmux com o byte `0x03` literal, 1s entre
// apertos): o rodapé promete "ctrl-c×2 sair" e eram precisos TRÊS apertos. O 2º Ctrl-C
// decidia `exit` certinho, o Ink desmontava (`waitUntilExit` resolvia em 8ms) e o teardown
// terminava em ~90ms — mas o processo seguia VIVO. Quem o matava era o cão de guarda de 2s
// do `run.tsx` (`process.exit` forçado), 2230ms depois; nesse intervalo a tela ficava
// congelada no último frame, que ainda dizia "pressione ctrl-c de novo para sair" — e daí
// o 3º aperto, que o `useInput` já nem via (o log instrumentado registra DOIS eventos) e
// que nem era necessário: medido sem ele, o processo morria igual, 2230ms depois do 2º.
//
// A CAUSA medida: `_getActiveHandles()` no instante do cão de guarda trazia um
// `TLSSocket[api.tokenrouter.com]` com `_httpMessage = /v1/credits`. O fetch pinado
// (`pinned-stream-fetch.ts`) é `node:https.request`, então o corpo é uma `IncomingMessage`;
// enquanto ela não é consumida nem destruída, o socket segue ATRIBUÍDO à requisição — não
// volta ao pool livre do agent (o único lugar onde o Node o `unref`a) e segura o laço de
// eventos para sempre. O `/credits` do tokenrouter responde 404 e a descoberta de saldo
// largava o corpo ali, a cada boot.
//
// POR QUE O TESTE É COM SERVIDOR DE VERDADE: um dublê de `fetch` não tem socket, e foi
// exatamente por isso que o defeito atravessou toda a bateria existente de `balance-
// discovery`/`context-window-discovery`/`connectivity-check` (todas passavam, e passam).
// O que se afirma aqui é o MECANISMO: depois da chamada, `http.globalAgent` não pode ter
// socket ATRIBUÍDO àquela porta. Antes do conserto o socket fica lá para sempre.
//
// E são TRÊS chamadores, não um — a lição do `loopback-declarado.test.ts` (nove pontos de
// chamada, o conserto tocou um): saldo (`!res.ok`), descoberta de janela (o corpo da 1ª
// resposta, ABANDONADO quando o 400/404 dispara a 2ª tentativa, e o da 2ª) e o ping de
// conectividade (que só olha o status — abandona o corpo no caminho FELIZ). Um só que
// regrida segura o processo do mesmo jeito.

import { afterEach, describe, expect, it } from 'vitest';
import {
  createServer,
  globalAgent,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPinnedStreamFetch } from '../../../src/model/local/pinned-stream-fetch.js';
import { discoverBalance } from '../../../src/model/local/balance-discovery.js';
import { fetchModelsContexts } from '../../../src/model/local/context-window-discovery.js';
import {
  checkModelConnectivity,
  type ConnectivityFetch,
} from '../../../src/model/local/connectivity-check.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let servidor: Server | undefined;
let portaEmUso: number | undefined;

/** Sobe um servidor HTTP real em 127.0.0.1 (porta efêmera) e devolve o baseURL. */
async function subirServidor(handler: Handler): Promise<string> {
  const s = createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  servidor = s;
  portaEmUso = (s.address() as AddressInfo).port;
  return `http://127.0.0.1:${portaEmUso}/v1`;
}

/**
 * Quantos sockets o agent global ainda tem ATRIBUÍDOS a esta porta. Esta é a medida que
 * importa: `agent.sockets` são os presos a uma requisição (o Node os mantém `ref`ados, e
 * é isso que impede o processo de sair); `agent.freeSockets` são os do keep-alive, já
 * `unref`ados — inofensivos. A porta é efêmera e exclusiva deste teste, então casar a
 * chave pela porta não colide com nada.
 */
function socketsPresos(porta: number): number {
  let total = 0;
  for (const [chave, lista] of Object.entries(globalAgent.sockets)) {
    if (!chave.includes(`:${porta}`)) continue;
    total += lista?.length ?? 0;
  }
  return total;
}

/** Espera o agent soltar a porta (o `close` do socket é assíncrono). */
async function esperarSoltar(porta: number, tetoMs = 1_000): Promise<number> {
  const fim = Date.now() + tetoMs;
  let presos = socketsPresos(porta);
  while (presos > 0 && Date.now() < fim) {
    await new Promise((r) => setTimeout(r, 20));
    presos = socketsPresos(porta);
  }
  return presos;
}

afterEach(async () => {
  // Limpa QUALQUER socket que tenha sobrado (no vermelho ele sobra de propósito — sem esta
  // limpeza o próprio vitest ficaria pendurado pelo mesmo motivo que a CLI ficava).
  if (portaEmUso !== undefined) {
    for (const [chave, lista] of Object.entries(globalAgent.sockets)) {
      if (!chave.includes(`:${portaEmUso}`)) continue;
      for (const sock of lista ?? []) sock.destroy();
    }
  }
  const s = servidor;
  servidor = undefined;
  portaEmUso = undefined;
  if (s !== undefined) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('descoberta de SALDO — o 404 do /credits não pode prender o socket', () => {
  it('gateway responde 404 (o caso medido no tokenrouter) ⇒ agent sem socket preso', async () => {
    let chamadas = 0;
    const baseUrl = await subirServidor((_req, res) => {
      chamadas += 1;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
    const porta = portaEmUso as number;

    const saldo = await discoverBalance({
      wireFormat: 'openai-compat',
      baseUrl,
      key: 'sk-teste',
      fetchImpl: createPinnedStreamFetch({ baseUrl }) as unknown as ConnectivityFetch,
    });

    expect(saldo).toBeUndefined(); // degradação silenciosa, como sempre foi
    expect(chamadas).toBe(1); // e a rede foi tocada de verdade (senão o teste é vácuo)
    expect(
      await esperarSoltar(porta),
      'o corpo do 404 ficou pendurado: este socket é o que segurava o processo depois do 2º Ctrl-C',
    ).toBe(0);
  });
});

describe('descoberta de JANELA — nem a 1ª resposta abandonada, nem a 2ª', () => {
  it('400 no /models + 404 no /models? ⇒ nenhum dos DOIS corpos fica preso', async () => {
    const paths: string[] = [];
    const baseUrl = await subirServidor((req, res) => {
      paths.push(req.url ?? '');
      // O 400 é o defeito real do gateway do dono (ver `context-window-discovery.ts`):
      // é ele que dispara a 2ª tentativa e ABANDONA o corpo da 1ª. O `?` da 2ª URL some
      // no caminho (`new URL(...).search` de `/models?` é vazio), então quem separa as
      // duas tentativas aqui é a ORDEM, não o path.
      const status = paths.length === 1 ? 400 : 404;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'nope' } }));
    });
    const porta = portaEmUso as number;

    const janelas = await fetchModelsContexts({
      wireFormat: 'openai-compat',
      baseUrl,
      key: 'sk-teste',
      fetchImpl: createPinnedStreamFetch({ baseUrl }) as unknown as ConnectivityFetch,
    });

    expect(janelas).toEqual([]);
    expect(paths).toEqual(['/v1/models', '/v1/models']); // as DUAS tentativas rodaram
    expect(
      await esperarSoltar(porta),
      'sobrou socket preso: ou o corpo da 1ª resposta (a abandonada pelo retry) ou o da 2ª',
    ).toBe(0);
  });
});

describe('ping de CONECTIVIDADE — o caminho FELIZ também abandona corpo', () => {
  it('200 no /chat/completions ⇒ agent sem socket preso', async () => {
    const baseUrl = await subirServidor((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
    const porta = portaEmUso as number;

    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl,
      model: 'modelo-de-teste',
      key: 'sk-teste',
      fetchImpl: createPinnedStreamFetch({ baseUrl }) as unknown as ConnectivityFetch,
    });

    expect(r.ok).toBe(true);
    expect(
      await esperarSoltar(porta),
      'o ping só lê o status; sem descartar o corpo, o socket do caminho FELIZ fica preso',
    ).toBe(0);
  });
});
