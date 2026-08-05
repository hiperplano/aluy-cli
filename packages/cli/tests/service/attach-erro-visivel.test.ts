// ATTACH-CEGO — o dono passou HORAS travado vendo `spawn_agent  → err` no
// `aluy service attach`, sem nenhum caminho para o motivo: nem no attach, nem no
// `runner.log`, nem na transcrição da sessão. Palavras dele: "tá dando erro e não
// consigo ver".
//
// O mais caro é que a razão SEMPRE existiu: `tool-reporter.ts` grava
// `output: truncate(result.observation)` exatamente quando `status === 'err'`. Ela
// chegava íntegra até o bloco e era DESCARTADA no último metro, porque a linha do
// attach era `${b.result || b.status}` — e em erro o `result` vem VAZIO, então caía
// no `status` e imprimia só "err".
//
// Estes testes travam a razão na linha. Sem eles, qualquer refatoração que volte ao
// `result || status` reintroduz a cegueira sem quebrar nada.

import { describe, expect, it } from 'vitest';
import { summarizeSessionBlockForAttach } from '../../src/service/attach-blocks.js';
import type { SessionBlock } from '../../src/session/model.js';

function toolBlock(over: Partial<Extract<SessionBlock, { kind: 'tool' }>>): SessionBlock {
  return {
    kind: 'tool',
    verb: 'spawn_agent',
    target: '',
    result: '',
    status: 'ok',
    ...over,
  } as SessionBlock;
}

describe('attach — falha de tool mostra o MOTIVO', () => {
  it('erro COM output ⇒ a razão aparece na linha (o bug que custou horas)', () => {
    const s = summarizeSessionBlockForAttach(
      toolBlock({
        status: 'err',
        output: 'agente "data-engineer" desconhecido — delegação RECUSADA',
      }),
    );
    expect(s?.text).toContain('err');
    expect(s?.text).toContain('data-engineer');
    expect(s?.text).toContain('RECUSADA');
  });

  it('erro SEM output ⇒ degrada para "err" sem quebrar (nunca "err: undefined")', () => {
    const s = summarizeSessionBlockForAttach(toolBlock({ status: 'err' }));
    expect(s?.text).toContain('err');
    expect(s?.text).not.toContain('undefined');
    expect(s?.text.trimEnd()).not.toMatch(/:$/); // sem dois-pontos órfão
  });

  it('SUCESSO não ganha cauda de erro — o log não pode afogar em ruído', () => {
    // A razão só entra em ERRO. Um turno tem dezenas de tools bem-sucedidas; se todas
    // carregassem detalhe, o diagnóstico se perderia no meio do sucesso.
    const s = summarizeSessionBlockForAttach(
      toolBlock({ verb: 'read', target: 'agents/quant.md', result: '72 linhas', status: 'ok' }),
    );
    expect(s?.text).toBe('read agents/quant.md → 72 linhas');
  });

  it('sucesso COM output (caso improvável) segue sem cauda — o gate é o status, não o campo', () => {
    // Mata o mutante que trocasse `status === 'err'` por `output !== undefined`.
    const s = summarizeSessionBlockForAttach(
      toolBlock({ result: 'feito', status: 'ok', output: 'ruído qualquer' }),
    );
    expect(s?.text).not.toContain('ruído');
  });

  it('output só-espaço não vira cauda vazia', () => {
    const s = summarizeSessionBlockForAttach(toolBlock({ status: 'err', output: '   ' }));
    expect(s?.text.trimEnd()).not.toMatch(/:$/);
  });
});
