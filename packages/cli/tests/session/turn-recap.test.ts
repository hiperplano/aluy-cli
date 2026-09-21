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

/** Separador de caminho do Windows, sem barra invertida literal no fonte. */
const BS = String.fromCharCode(92);

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

// ── 21/09/2026 · o recap estava QUEBRADO NO WINDOWS ────────────────────────
//
// Reportado pelo dono ("esse log polui o composer"), com o print da tela. Medido no
// turno real dele: 308 caracteres no Windows contra 46 no POSIX, para o MESMO turno.
// Causa: `nomeCurto` só cortava em `/`, e um caminho `C:\\...` não tem nenhuma barra
// normal — entrava INTEIRO. A linha então quebrava no meio de um path e emendava com o
// próximo item, virando a parede que ele viu.
//
// Estes testes usam separador de Windows de propósito: são os que teriam pego o defeito.
describe('F-RECAP — caminho de Windows encurta igual ao de POSIX', () => {
  const W = 'C:' + BS + 'Projects' + BS + 'app' + BS;

  it('caminho com barra INVERTIDA vira nome curto (antes vinha inteiro)', () => {
    const r = buildTurnRecap([
      you('faça'),
      tool('edit_file', W + 'UX-AUDIT.md'),
      tool('edit_file', W + 'src' + BS + 'components' + BS + 'core' + BS + 'Card.tsx'),
    ]);
    expect(r).toBe('editou UX-AUDIT.md e Card.tsx');
    expect(r).not.toContain('C:');
  });

  it('o comando com caminho gigante no argumento não arrasta o caminho', () => {
    const r = buildTurnRecap([
      you('faça'),
      tool('run_command', 'type ' + W + 'src' + BS + 'components' + BS + 'core' + BS + 'Card.tsx'),
    ]);
    // `type` não é runner ⇒ a 2ª palavra (que É o caminho) fica fora.
    expect(r).toBe('rodou type');
  });

  it('runner com argumento útil MANTÉM as duas palavras (não pode regredir)', () => {
    const r = buildTurnRecap([you('faça'), tool('run_command', 'npm test -- --run')]);
    expect(r).toBe('rodou npm test');
  });

  it('runner com FLAG não vira "node -e" — a flag não informa nada', () => {
    const r = buildTurnRecap([
      you('faça'),
      tool('run_command', 'node -e "console.log(1)"'),
      tool('run_command', 'powershell -Command "Get-Content x"'),
    ]);
    expect(r).toBe('rodou node e powershell');
  });

  it('comando invocado por caminho absoluto vira o binário', () => {
    const r = buildTurnRecap([
      you('faça'),
      tool('run_command', 'C:' + BS + 'Program' + BS + 'nodejs' + BS + 'node.exe server.js'),
    ]);
    expect(r).toBe('rodou node.exe server.js');
  });

  it('POSIX segue idêntico — a correção não pode mudar o que já funcionava', () => {
    const r = buildTurnRecap([
      you('faça'),
      tool('edit', '/home/u/proj/UX-AUDIT.md'),
      tool('edit', '/home/u/proj/src/Card.tsx'),
      tool('run_command', 'npm test'),
    ]);
    expect(r).toBe('editou UX-AUDIT.md e Card.tsx · rodou npm test');
  });
});

describe('F-RECAP — teto de comprimento da linha', () => {
  it('nome de arquivo absurdo ⇒ a linha é cortada com reticências, não vaza', () => {
    const enorme = 'x'.repeat(200) + '.ts';
    const r = buildTurnRecap([you('faça'), tool('edit_file', '/a/' + enorme)]);
    expect(r!.length).toBeLessThanOrEqual(96);
    expect(r!.endsWith('…')).toBe(true);
  });

  it('linha que CABE não ganha reticências', () => {
    const r = buildTurnRecap([you('faça'), tool('edit', '/a/b.ts')]);
    expect(r).toBe('editou b.ts');
  });
});
