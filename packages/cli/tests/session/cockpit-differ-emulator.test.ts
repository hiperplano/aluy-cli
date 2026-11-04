// Cockpit — o differ contra um EMULADOR DE TERMINAL de verdade (@xterm/headless).
//
// Por que existe: a duplicação do composer / linhas embaralhadas em /fullscreen só aparecia com
// o terminal real (cursor + erase + largura), nunca nos testes de bytes. Aqui os bytes REAIS do
// `createCockpitDiffer` alimentam um xterm headless (auto-wrap OFF, como o app) ao longo de
// uma sequência de frames com mudanças no lugar, linhas crescendo/encolhendo, emoji, linhas
// que enchem a largura (réguas) e crescimento do LOG; a cada passo a tela emulada tem de ser
// IGUAL ao último frame. Mutação: voltar o `\x1b[K` depois da linha (comia a última coluna das
// réguas) ou desligar a detecção de geometria quebra este teste.

import { describe, expect, it } from 'vitest';
import xterm from '@xterm/headless';
import { createCockpitDiffer } from '../../src/session/synchronized-output.js';

const { Terminal } = xterm as unknown as {
  Terminal: new (o: Record<string, unknown>) => {
    write(d: string, cb: () => void): void;
    resize(c: number, r: number): void;
    buffer: {
      active: {
        getLine(
          i: number,
        ): { translateToString(trim: boolean, start?: number, end?: number): string } | undefined;
        baseY: number;
      };
    };
  };
};

const CT = '\x1b[2J\x1b[3J\x1b[H';
const NOWRAP = '\x1b[?7l';

function rng(seed: number): () => number {
  let x = seed;
  return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
const EMO = ['🪶', '🐙', '🤣', '👋', '🚀', '✔', '◕', '⇄', 'é', '你'];
const WORDS = ['silêncio', 'aprende', 'soletrar', 'spawn_agent', 'poeta', 'piada', 'ok', '2.6s'];

function sentence(r: () => number, max: number): string {
  let s = '';
  while (s.length < max) {
    const w =
      r() < 0.25 ? EMO[Math.floor(r() * EMO.length)]! : WORDS[Math.floor(r() * WORDS.length)]!;
    if ((s + ' ' + w).length > max) break;
    s += (s ? ' ' : '') + w;
  }
  return s;
}

async function screenOf(
  term: ReturnType<typeof mkTerm>,
  rows: number,
  cols: number,
): Promise<string[]> {
  await new Promise<void>((res) => term.write('', res));
  const b = term.buffer.active;
  return Array.from({ length: rows }, (_, i) =>
    (b.getLine(b.baseY + i)?.translateToString(true, 0, cols) ?? '').trimEnd(),
  );
}
function mkTerm(cols: number, rows: number) {
  return new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
}
const write = (t: ReturnType<typeof mkTerm>, d: string): Promise<void> =>
  new Promise((res) => t.write(d, res));

describe('createCockpitDiffer × terminal emulado (xterm headless)', () => {
  for (const [rows, cols] of [
    [35, 106],
    [24, 80],
  ] as const) {
    it(`${cols}x${rows}: a tela == o último frame em CADA passo (mudança no lugar, emoji, réguas, cresce/encolhe)`, async () => {
      const r = rng(rows * 1000 + cols);
      const term = mkTerm(cols, rows);
      const differ = createCockpitDiffer(
        () => rows,
        () => rows,
        () => cols,
      );
      await write(term, '\x1b[?1049h\x1b[?25l'); // alt-screen, como o app
      const rule = '─'.repeat(cols); // linha que ENCHE a largura (a que perdia a última coluna)
      // layout fixo: header, régua, conversa (cresce), régua, LOG (cresce), régua, composer.
      const conv: string[] = [];
      const log: string[] = [];
      const compose = (): string[] => {
        const convRows = rows - 5 - 4;
        const logRows = 4;
        const c = conv.slice(-convRows);
        const l = log.slice(-logRows);
        const out = [
          'Λluy Cli v1.0 · zai-coding',
          rule,
          ...Array.from({ length: convRows }, (_, i) => c[i - (convRows - c.length)] ?? ''),
          rule,
          ...Array.from({ length: logRows }, (_, i) => l[i] ?? ''),
          rule,
          '❯ ●digite um objetivo ou /comando…',
        ];
        return out;
      };
      for (let step = 0; step < 150; step += 1) {
        const k = r();
        if (k < 0.3) conv.push(`┃ ${sentence(r, cols - 6)}`);
        else if (k < 0.5 && conv.length > 0)
          conv[conv.length - 1] = `┃ ${sentence(r, cols - 6)}`; // no lugar
        else if (k < 0.7) log.push(` ▼ [agente] ${sentence(r, cols - 16)}`);
        else if (k < 0.85 && log.length > 0)
          log[log.length - 1] = ` ▼ [agente] ok · ${step}s`; // encolhe
        else if (conv.length > 0) conv[Math.floor(r() * conv.length)] = '';
        const frame = compose();
        expect(frame).toHaveLength(rows);
        await write(term, NOWRAP + differ.transform(CT + frame.join('\n') + '\n'));
        const got = await screenOf(term, rows, cols);
        const want = frame.map((l) => l.trimEnd());
        expect(got, `passo ${step}`).toEqual(want);
      }
    });
  }

  it('resize 106x35 → 80x24: tela == frame novo (sem sobras do reflow)', async () => {
    let rows = 35;
    let cols = 106;
    const term = mkTerm(cols, rows);
    const differ = createCockpitDiffer(
      () => rows,
      () => rows,
      () => cols,
    );
    const mk = (R: number, C: number, tag: string): string[] => [
      `topo ${tag}`,
      '─'.repeat(C),
      ...Array.from({ length: R - 4 }, (_, i) => `linha ${i} ${tag} 🪶`),
      '─'.repeat(C),
      '❯ digite um objetivo ou /comando…',
    ];
    await write(term, '\x1b[?1049h' + NOWRAP);
    await write(term, differ.transform(CT + mk(rows, cols, 'A').join('\n') + '\n'));
    rows = 24;
    cols = 80;
    term.resize(cols, rows);
    await write(term, NOWRAP + differ.transform(CT + mk(rows, cols, 'B').join('\n') + '\n'));
    const got = await screenOf(term, rows, cols);
    expect(got).toEqual(mk(rows, cols, 'B').map((l) => l.trimEnd()));
    expect(got.filter((l) => l.includes('digite um objetivo ou'))).toHaveLength(1);
  });

  it('heal(): uma tela que divergiu do modelo (rolagem/escrita alheia) volta a == frame', async () => {
    const rows = 12;
    const cols = 60;
    const term = mkTerm(cols, rows);
    const differ = createCockpitDiffer(
      () => rows,
      () => rows,
      () => cols,
    );
    const frame = Array.from({ length: rows }, (_, i) =>
      i === rows - 2 ? '─'.repeat(cols) : i === rows - 1 ? '❯ digite um objetivo' : `linha ${i}`,
    );
    await write(term, '\x1b[?1049h' + NOWRAP);
    await write(term, differ.transform(CT + frame.join('\n') + '\n'));
    // corrupção que o differ NÃO viu: rola a tela 1 linha e escreve lixo (o "composer 2×").
    await write(term, `\x1b[${rows};1H\n\x1b[3;1Hlixo alheio`);
    expect(await screenOf(term, rows, cols)).not.toEqual(frame);
    // o differ acha que nada mudou ⇒ um frame idêntico NÃO conserta…
    await write(term, NOWRAP + differ.transform(CT + frame.join('\n') + '\n'));
    expect(await screenOf(term, rows, cols)).not.toEqual(frame);
    // …mas o heal() (rede de segurança no ocioso) repinta tudo.
    await write(term, NOWRAP + differ.heal());
    expect(await screenOf(term, rows, cols)).toEqual(frame);
  });
});
