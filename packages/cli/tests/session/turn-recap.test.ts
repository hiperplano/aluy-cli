// F-RECAP (pedido do dono: "um recap na linha inferior, do que fez") — o rodapé informava
// só CUSTO (`✓ 15.6k tokens · 2 tools · 2.5s`), que responde "quanto gastou" e não "o que
// aconteceu". Num turno com dez tools, saber qual arquivo foi tocado exigia reler o
// histórico inteiro.
//
// A regra do texto: contar o que TEM CONSEQUÊNCIA. Escrita e comando mudam o mundo;
// leitura e busca, não. Falha NUNCA é omitida — rodapé que esconde erro vira propaganda.
import { describe, expect, it } from 'vitest';
import { buildTurnRecap } from '../../src/session/turn-recap.js';
import type { SessionBlock } from '../../src/session/model.js';

const you = (text: string): SessionBlock => ({ kind: 'you', text });
const tool = (verb: string, target: string, status: 'ok' | 'err' = 'ok'): SessionBlock =>
  ({ kind: 'tool', verb, target, result: '', status }) as SessionBlock;

describe('F-RECAP — a linha diz o que o turno FEZ', () => {
  it('cita os arquivos editados pelo nome curto (o rodapé tem uma linha, não uma coluna)', () => {
    const r = buildTurnRecap([
      you('faça'),
      tool('edit', 'packages/cli/src/session/controller.ts'),
      tool('write', 'packages/cli/src/session/model.ts'),
    ]);
    expect(r).toBe('editou controller.ts e model.ts');
  });

  it('comando aparece encurtado (duas palavras: `npm test`, não a linha inteira)', () => {
    expect(buildTurnRecap([you('rode'), tool('bash', 'npm test -- --run --reporter=dot')])).toBe(
      'rodou npm test',
    );
  });

  it('leitura só aparece quando foi a ÚNICA coisa — junto de edição é ruído de processo', () => {
    expect(buildTurnRecap([you('x'), tool('read', 'a.ts'), tool('grep', 'foo')])).toBe(
      'leu 2 arquivos',
    );
    expect(buildTurnRecap([you('x'), tool('read', 'a.ts'), tool('edit', 'b.ts')])).toBe(
      'editou b.ts',
    );
  });

  it('FALHA nunca é omitida — o rodapé não é propaganda do turno', () => {
    const r = buildTurnRecap([you('x'), tool('write', 'a.ts'), tool('bash', 'npm test', 'err')]);
    expect(r).toContain('editou a.ts');
    expect(r).toContain('1 falhou');
  });

  it('acima do teto de nomes, resume com +N em vez de estourar a linha', () => {
    const r = buildTurnRecap([
      you('x'),
      tool('edit', 'a.ts'),
      tool('edit', 'b.ts'),
      tool('edit', 'c.ts'),
      tool('edit', 'd.ts'),
      tool('edit', 'e.ts'),
    ]);
    expect(r).toBe('editou a.ts, b.ts e c.ts +2');
  });

  it('o mesmo arquivo editado duas vezes conta UMA (é um arquivo, não dois)', () => {
    expect(buildTurnRecap([you('x'), tool('edit', 'a.ts'), tool('edit', 'a.ts')])).toBe(
      'editou a.ts',
    );
  });

  it('olha só o ÚLTIMO turno — o que o turno anterior fez não é recap deste', () => {
    const r = buildTurnRecap([
      you('primeiro'),
      tool('edit', 'antigo.ts'),
      you('segundo'),
      tool('edit', 'novo.ts'),
    ]);
    expect(r).toBe('editou novo.ts');
  });

  it('conversa pura ⇒ SEM recap (rodapé idêntico ao de hoje, sem regressão)', () => {
    expect(
      buildTurnRecap([you('oi'), { kind: 'aluy', text: 'olá', streaming: false }]),
    ).toBeUndefined();
  });
});
