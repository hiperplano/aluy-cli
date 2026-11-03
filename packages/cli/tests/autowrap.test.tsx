// Regressão do "redesenho com sobra" (linha de trabalho congelada + brancos): o terminal mede
// emoji por conta própria e, se achar a linha mais larga que o Ink, quebra numa linha física A
// MAIS ⇒ o erase da região viva deixa o topo para trás. Aqui: Ink REAL + o envelope REAL do
// stdout + um mini-emulador de terminal cuja tabela de largura DISCORDA do Ink (como o tmux:
// tom de pele = 2+2 colunas), com e sem o auto-wrap desligado.

import React from 'react';
import { Box, Static, Text, render } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  disableAutowrap,
  DISABLE_AUTOWRAP,
  ENABLE_AUTOWRAP,
  noAutowrapEnabled,
} from '../src/session/autowrap.js';
import { wrapStdoutWithSync } from '../src/session/synchronized-output.js';
import { displayWidth } from '../src/session/visual-lines.js';
import { EventEmitter } from 'node:events';

/** Largura "de tmux": cada code point visível conta (tom de pele 1F3FB-F = 2), VS/ZWJ = 0. */
function termWidth(cp: number): number {
  if (cp === 0xfe0f || cp === 0x200d) return 0;
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2;
  return 1;
}

/** Mini-terminal: grade de linhas, cursor, `ESC[nA`, `ESC[G`, `ESC[K`, `ESC[J`, `?7`, CRLF. */
function emulate(chunks: string[], cols: number): string[] {
  const rows: string[][] = [[]];
  let r = 0;
  let c = 0;
  let wrap = true;
  const put = (ch: string, w: number): void => {
    if (c + w > cols) {
      if (!wrap) {
        // sem wrap: sobrescreve a última coluna
        c = cols - w;
      } else {
        r += 1;
        c = 0;
      }
    }
    rows[r] ??= [];
    rows[r]![c] = ch;
    for (let k = 1; k < w; k += 1) rows[r]![c + k] = '';
    c += w;
  };
  const data = chunks.join('');
  for (let i = 0; i < data.length; ) {
    if (data[i] === '\x1b' && data[i + 1] === '[') {
      // eslint-disable-next-line no-control-regex
      const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(data.slice(i));
      if (!m) break;
      const [seq, p = '', f] = m;
      i += seq.length;
      const n = Number(p) || 1;
      if (f === 'A') r = Math.max(0, r - n);
      else if (f === 'G') c = 0;
      else if (f === 'K') (rows[r] ??= []).length = c;
      else if (f === 'J') {
        (rows[r] ??= []).length = c;
        rows.length = r + 1;
      } else if (f === 'l' && p === '?7') wrap = false;
      else if (f === 'h' && p === '?7') wrap = true;
      continue;
    }
    const cp = data.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ch === '\r') c = 0;
    else if (ch === '\n') {
      r += 1;
      c = 0;
      rows[r] ??= [];
    } else put(ch, termWidth(cp));
  }
  return rows.map((row) => row.join('').trimEnd());
}

function fakeStdout(cols: number): { stream: NodeJS.WriteStream; chunks: string[] } {
  const chunks: string[] = [];
  const ee = new EventEmitter();
  const stream = Object.assign(ee, {
    isTTY: true,
    columns: cols,
    rows: 200,
    write(c: string | Uint8Array): boolean {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, chunks };
}

const EMOJI_LINE = '👍🏽'.repeat(14); // Ink: 28 col; "tmux": 56 col

async function runTurn(autowrapOff: boolean, cols: number): Promise<string[]> {
  const { stream, chunks } = fakeStdout(cols);
  const sync = wrapStdoutWithSync(stream, { sync: true, overwrite: true, anchor: false });
  if (autowrapOff) chunks.push(DISABLE_AUTOWRAP);
  const App = ({ done }: { done: boolean }): React.ReactElement => (
    <>
      <Static items={done ? [EMOJI_LINE] : []}>
        {(t) => <Text key={t}>{`resposta ${t}`}</Text>}
      </Static>
      <Box flexDirection="column">
        <Text>{done ? 'composer' : 'Λ Alinhando… (preparando · 0s)'}</Text>
        {done ? null : <Text>{`ao vivo ${EMOJI_LINE}`}</Text>}
      </Box>
    </>
  );
  const inst = render(<App done={false} />, {
    stdout: sync.stdout,
    stdin: new EventEmitter() as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
    debug: false,
  });
  await new Promise((r) => setTimeout(r, 50));
  inst.rerender(<App done={true} />);
  await new Promise((r) => setTimeout(r, 80));
  inst.unmount();
  return emulate(chunks, cols);
}

describe('auto-wrap (DECAWM) — redesenho sem sobra', () => {
  it('SEM o fix: o terminal quebra a linha larga e a linha de trabalho sobra', async () => {
    const out = await runTurn(false, 40);
    expect(out.some((l) => l.includes('Alinhando'))).toBe(true); // reproduz o bug
  });

  it('COM auto-wrap desligado: nenhuma linha de trabalho sobra no quadro final', async () => {
    const out = await runTurn(true, 40);
    expect(out.some((l) => l.includes('Alinhando'))).toBe(false);
    expect(out.some((l) => l.includes('composer'))).toBe(true);
    expect(out.some((l) => l.startsWith('resposta'))).toBe(true);
  });
});

describe('disableAutowrap', () => {
  it('emite ?7l e restaura ?7h uma única vez', () => {
    const w: string[] = [];
    const c = disableAutowrap({ write: (s) => (w.push(s), true) });
    c.restore();
    c.restore();
    expect(w).toEqual([DISABLE_AUTOWRAP, ENABLE_AUTOWRAP]);
  });
  it('ALUY_AUTOWRAP=1 desliga o fix', () => {
    expect(noAutowrapEnabled({ ALUY_AUTOWRAP: '1' })).toBe(false);
    expect(noAutowrapEnabled({})).toBe(true);
    const w: string[] = [];
    disableAutowrap({ write: (s) => (w.push(s), true) }, false).restore();
    expect(w).toEqual([]);
  });
});

describe('displayWidth — classes de emoji (orçamento conservador)', () => {
  const table: Array<[string, string, number]> = [
    ['ASCII', 'abc', 3],
    ['CJK', '你好', 4],
    ['emoji astral', '😄', 2],
    ['VS16 sobre símbolo estreito', '⚠️', 2],
    ['VS16 sobre coração', '❤️', 2],
    ['VS16 sobre museu', '🏛️', 2],
    ['VS16 sobre sol', '☀️', 2],
    ['keycap', '1️⃣', 2],
    ['ZWJ (soma dos componentes, sem subestimar)', '👩‍💻', 4],
    ['tom de pele (emoji + modificador)', '👍🏽', 4],
    ['bandeira (2 indicadores regionais)', '🇧🇷', 2],
    ['símbolo estreito sem VS16', '✔', 1],
  ];
  for (const [name, s, w] of table) {
    it(`${name}: ${s} = ${w}`, () => expect(displayWidth(s)).toBe(w));
  }
});
