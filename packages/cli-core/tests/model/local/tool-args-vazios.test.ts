// BUG-ARGS-VAZIOS (22/09/2026, medido em campo com glm-5.3 na z.ai) — as três formas de
// o fio produzir uma tool-call com `{}` no lugar dos argumentos.
//
// O SINTOMA que originou isto, colhido de uma sessão real do dono: seis chamadas seguidas
// a `run_command` devolvendo `requer "command" (string não-vazia). Recebi: nenhum
// argumento`, até o supervisor encerrar o turno. O NOME chegava certo; só os argumentos
// sumiam — e do lado do modelo não havia o que corrigir, porque ele tinha mandado.
//
// O que torna esta classe de defeito cara é o SILÊNCIO: `coerceArgs` devolve `{}` para
// texto vazio E para texto que não parseia, então todo caminho de perda desemboca na
// MESMA mensagem, indistinguível. Estes testes atacam cada caminho na origem.
import { describe, expect, it } from 'vitest';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { newSseAccumulator } from '../../../src/model/local/adapter.js';
import type { ModelStreamEvent } from '../../../src/model/types.js';

/**
 * Provider NEUTRO de propósito. O defeito foi MEDIDO com glm-5.3 na z.ai, mas ele não é
 * de lá: mora no adapter OpenAI-compat, que serve todo provider desse dialeto. Fixar a
 * z.ai aqui faria o teste mentir sobre o alcance do conserto — e abriria a porta para
 * alguém "consertar" por provider, que é exatamente o que não se deve fazer.
 */
function adapter(): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter({
    provider: 'compat',
    defaultBaseUrl: 'https://provider.exemplo/v1',
  });
}

/** Roda uma sequência de chunks pelo adapter e devolve os eventos, na ordem. */
function rodar(chunks: readonly unknown[], comDone = true): ModelStreamEvent[] {
  const a = adapter();
  const acc = newSseAccumulator();
  const out: ModelStreamEvent[] = [];
  for (const c of chunks) out.push(...a.mapSse('', JSON.stringify(c), acc));
  if (comDone) out.push(...a.mapSse('', '[DONE]', acc));
  else out.push(...a.finalize(acc));
  return out;
}

const callsDe = (ev: readonly ModelStreamEvent[]) =>
  ev.filter((e) => e.type === 'tool_call').map((e) => (e as { call: unknown }).call);

describe('BUG-ARGS-VAZIOS · fragmento que chega DEPOIS do finish_reason', () => {
  // A REGRESSÃO exata: o flush morava no `finish_reason` e LATCHAVA. Tudo que viesse
  // depois era acumulado e jogado fora — a call já tinha saído vazia.
  it('argumentos após o finish_reason NÃO se perdem', () => {
    const ev = rodar([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_command' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] },
    ]);
    expect(callsDe(ev)).toEqual([{ id: 'c1', name: 'run_command', input: { command: 'ls' } }]);
  });

  it('a ordem observável se mantém: tool_call ANTES de done', () => {
    const ev = rodar([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(ev.map((e) => e.type)).toEqual(['tool_call', 'done']);
  });

  // Rede: provider que fecha o corpo sem `[DONE]` — o `finalize` tem de emitir os dois.
  it('sem [DONE], o finalize ainda emite a call COMPLETA', () => {
    const ev = rodar(
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] },
      ],
      false,
    );
    expect(callsDe(ev)).toEqual([{ id: 'c1', name: 'f', input: { a: 1 } }]);
    expect(ev.map((e) => e.type)).toEqual(['tool_call', 'done']);
  });

  // O teto anti-hang: com o flush movido para o fim, este caminho perderia a call INTEIRA
  // se não flushasse também. 64 eventos de trailer sem `[DONE]`.
  it('provider que estoura o teto de trailer não perde a tool-call', () => {
    const a = adapter();
    const acc = newSseAccumulator();
    const out: ModelStreamEvent[] = [];
    out.push(
      ...a.mapSse(
        '',
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } },
          ],
        }),
        acc,
      ),
    );
    out.push(...a.mapSse('', JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), acc));
    for (let i = 0; i < 80; i++) out.push(...a.mapSse('', JSON.stringify({ choices: [] }), acc));
    expect(callsDe(out)).toEqual([{ id: 'c1', name: 'f', input: { a: 1 } }]);
    expect(out.filter((e) => e.type === 'done')).toHaveLength(1);
  });
});

describe('BUG-ARGS-VAZIOS · `arguments` como OBJETO (fora da spec, mas existe)', () => {
  it('objeto já parseado é aceito em vez de descartado', () => {
    const ev = rodar([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'run_command', arguments: { command: 'ls -la' } } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(callsDe(ev)).toEqual([
      { id: 'c1', name: 'run_command', input: { command: 'ls -la' } },
    ]);
  });

  it('`null` segue sendo AUSÊNCIA, não conteúdo (não vira a string "null")', () => {
    const ev = rodar([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: null } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(callsDe(ev)).toEqual([{ id: 'c1', name: 'f', input: { a: 1 } }]);
  });

  // Não-regressão: a string continua sendo o caminho normal, fragmentada como sempre.
  it('string fragmentada segue concatenando (o caminho de sempre)', () => {
    const ev = rodar([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(callsDe(ev)).toEqual([{ id: 'c1', name: 'f', input: { path: 'a.ts' } }]);
  });
});

describe('BUG-ARGS-VAZIOS · COLISÃO de slot (duas calls no mesmo index)', () => {
  // Sem a separação por `id`, os dois JSON se concatenam (`{"a":1}{"b":2}`), o parse
  // falha, e AS DUAS calls saem com `{}`.
  it('duas calls completas repetindo index 0 não se misturam', () => {
    const ev = rodar([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'g', arguments: '{"b":2}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const calls = callsDe(ev);
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ id: 'c1', name: 'f', input: { a: 1 } });
    expect(calls).toContainEqual({ id: 'c2', name: 'g', input: { b: 2 } });
  });

  // O MESMO `id` repetido é continuação, não call nova — não pode virar duas.
  it('id REPETIDO no mesmo index é continuação, não call nova', () => {
    const ev = rodar([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(callsDe(ev)).toEqual([{ id: 'c1', name: 'f', input: { a: 1 } }]);
  });

  // Não-regressão do caminho REAL medido na z.ai: índices distintos, calls paralelas.
  it('índices distintos seguem funcionando (o paralelo medido na z.ai)', () => {
    const ev = rodar([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"1"}' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":"2"}' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 2, id: 'c', function: { name: 'read_file', arguments: '{"path":"3"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(callsDe(ev)).toHaveLength(3);
    expect(callsDe(ev).map((c) => (c as { input: { path: string } }).input.path)).toEqual(['1', '2', '3']);
  });
});
