// A âncora do composer contra um TERMINAL EMULADO (xterm headless) com a tela CHEIA: o histórico
// (`<Static>`) nunca pode receber uma cópia velha da linha de trabalho (`Λ frase…`). Relato do dono:
// com a tela cheia, ao subir a nota `✔ tN concluída` a frase de trabalho ficava repetida no histórico.
import { describe, expect, it } from 'vitest';
import xterm from '@xterm/headless';
import {
  BEGIN_SYNC,
  END_SYNC,
  createFrameAnchor,
  overwriteInPlace,
  wrapStdoutWithSync,
} from '../../src/session/synchronized-output.js';

const { Terminal } = xterm as unknown as {
  Terminal: new (o: Record<string, unknown>) => {
    write(d: string, cb: () => void): void;
    buffer: {
      active: {
        length: number;
        getLine(i: number): { translateToString(trim: boolean): string } | undefined;
      };
    };
  };
};

const ROWS = 10;
const COLS = 60;

/** Quem escreve como o Ink (`log-update` + `<Static>`), passando pelo MESMO caminho do wrapper. */
function harness() {
  const term = new Terminal({ rows: ROWS, cols: COLS, allowProposedApi: true, scrollback: 500 });
  const anchor = createFrameAnchor(() => ROWS);
  let prevCount = 0; // `previousLineCount` do log-update (linhas do último quadro + 1)
  const pending: string[] = [];
  const erase = (n: number): string =>
    n <= 0 ? '' : '\x1b[2K\x1b[1A'.repeat(n - 1) + '\x1b[2K\x1b[G';
  const emit = (raw: string): void => {
    pending.push(overwriteInPlace(anchor.transform(raw)));
  };
  return {
    frame(lines: string[]): void {
      const out = lines.join('\n') + '\n';
      emit(erase(prevCount) + out);
      prevCount = lines.length + 1;
    },
    /** `<Static>` novo: o Ink limpa o quadro, escreve o histórico e repinta o quadro. */
    staticThenFrame(history: string[], lines: string[]): void {
      emit(erase(prevCount));
      emit(history.join('\n') + '\n');
      const out = lines.join('\n') + '\n';
      emit(out);
      prevCount = lines.length + 1;
    },
    async text(): Promise<string[]> {
      await new Promise<void>((r) => term.write(pending.splice(0).join(''), r));
      const b = term.buffer.active;
      const all: string[] = [];
      for (let i = 0; i < b.length; i++) all.push(b.getLine(i)?.translateToString(true) ?? '');
      return all;
    },
  };
}

const viva = (frase: string): string[] => [
  '',
  `Λ ${frase}… (1 em segundo plano · 10s)`,
  '',
  '┃❯ digite',
  '  status',
  '  1 tarefa · 1 rodando',
];
const idle = (): string[] => ['', '┃❯ digite', '  status', '  1 tarefa · 1 encerrada'];

describe('âncora + terminal real, tela cheia: a frase de trabalho não vaza para o histórico', () => {
  it('nota `✔ tN concluída` sobe ao <Static> enquanto a linha de trabalho some (encolhe 2)', async () => {
    const h = harness();
    // enche a tela (histórico > ROWS)
    const hist = Array.from({ length: 14 }, (_, i) => `histórico ${i}`);
    h.frame(viva('a'));
    h.staticThenFrame(hist, viva('b'));
    for (const f of ['c', 'd', 'e']) h.frame(viva(f));
    // a tarefa termina: a nota vai ao Static e a linha de trabalho some no MESMO quadro
    h.staticThenFrame(['  ✔ t1 concluída — ok'], idle());
    h.frame(idle());
    const linhas = await h.text();
    const fantasmas = linhas.filter((l) => /^Λ /.test(l));
    expect(fantasmas, linhas.join('\n')).toEqual([]);
    expect(linhas.filter((l) => l.includes('✔ t1 concluída'))).toHaveLength(1);
    expect(linhas.filter((l) => l.includes('┃❯'))).toHaveLength(1);
  });

  it('o mesmo, com vários quadros da frase entre o histórico e a nota (cada tick repinta)', async () => {
    const h = harness();
    h.frame(viva('a'));
    h.staticThenFrame(
      Array.from({ length: 14 }, (_, i) => `histórico ${i}`),
      viva('b'),
    );
    for (let i = 0; i < 6; i++) h.frame(viva(`tick ${i}`));
    h.staticThenFrame(['  ✔ t1 concluída — ok'], viva('preparando o relato'));
    h.frame(viva('preparando o relato 2'));
    h.staticThenFrame(['┃ Λluy', '┃ Resumo.'], idle());
    const linhas = await h.text();
    expect(linhas.filter((l) => /^Λ /.test(l))).toEqual([]);
  });
});

describe('um render do Ink (erase + histórico + quadro) sai em UM bloco ?2026', () => {
  const fakeStream = () => {
    const writes: string[] = [];
    const stream = {
      rows: 10,
      columns: 60,
      isTTY: true,
      write: (d: string, cb?: () => void) => {
        writes.push(d);
        cb?.();
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { stream, writes };
  };
  const erase = (n: number): string => '\x1b[2K\x1b[1A'.repeat(n - 1) + '\x1b[2K\x1b[G';

  it('erase puro + histórico + quadro no mesmo tick ⇒ 1 write, 1 BSU e 1 ESU, na ordem', async () => {
    const { stream, writes } = fakeStream();
    const w = wrapStdoutWithSync(stream);
    w.stdout.write('1\n2\n3\n'); // 1º quadro
    writes.length = 0;
    w.stdout.write(erase(4)); // log.clear()
    w.stdout.write('  ✔ t1 concluída\n'); // <Static>
    w.stdout.write('NOVO1\nNOVO2\n'); // quadro
    expect(writes).toHaveLength(0); // ainda no lote
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    const out = writes[0]!;
    expect(out.split(BEGIN_SYNC)).toHaveLength(2);
    expect(out.split(END_SYNC)).toHaveLength(2);
    expect(out.indexOf('✔ t1 concluída')).toBeLessThan(out.indexOf('NOVO1'));
  });

  it('quadro comum (sem erase puro) segue síncrono, um write por quadro', () => {
    const { stream, writes } = fakeStream();
    const w = wrapStdoutWithSync(stream);
    w.stdout.write('a\n');
    w.stdout.write(`${erase(2)}b\n`);
    expect(writes).toHaveLength(2);
  });

  it('cleanup() descarrega o lote pendente (nada fica preso)', () => {
    const { stream, writes } = fakeStream();
    const w = wrapStdoutWithSync(stream);
    w.stdout.write('a\n');
    writes.length = 0;
    w.stdout.write(erase(2));
    w.cleanup();
    expect(writes.join('')).toContain('\x1b[J'); // o erase chegou
  });
});
