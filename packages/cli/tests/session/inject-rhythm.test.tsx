// Ritmo do `↳ encaixado` (inject): a nota é UMA linha sem respiro de baixo; quem vem DEPOIS
// paga a linha em branco de cima. Pagar de cima dependia do futuro (a 1ª nota já está no
// `<Static>` quando a 2ª chega) — ver `block-rhythm.ts`. Aqui: as peças puras e a PARIDADE
// medida×render do cockpit com blocos seguindo um inject.
import React from 'react';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { BlockView } from '../../src/session/App.js';
import {
  fitConversaWindow,
  measureConversaBlock,
  type ConversaCtx,
} from '../../src/session/cockpit-conversa.js';
import { liveOverheadLines } from '../../src/session/live-budget.js';
import {
  blankAfterInject,
  blockEndsWithBlankLine,
  previousVisibleKind,
} from '../../src/session/block-rhythm.js';
import type { SessionBlock } from '../../src/session/model.js';

const CTX: ConversaCtx = { columns: 100, rows: 33 };
const inj = (text: string): SessionBlock => ({ kind: 'inject', text });
const note: SessionBlock = { kind: 'note', title: 'marco', lines: ['depois'] };
const tool: SessionBlock = {
  kind: 'tool',
  verb: 'read',
  target: 'a.ts',
  result: '1 linha',
  status: 'ok',
};
const aluy: SessionBlock = { kind: 'aluy', text: 'RESP', streaming: false };
const oculto: SessionBlock = { kind: 'aluy', text: 'x', streaming: false, selfCheck: true };

describe('inject — peças puras', () => {
  it('o inject NÃO termina em branco; quem o segue paga', () => {
    expect(blockEndsWithBlankLine('inject')).toBe(false);
    expect(blankAfterInject('note', 'inject')).toBe(true);
    expect(blankAfterInject('inject', 'inject')).toBe(false);
    expect(blankAfterInject('note', 'tool')).toBe(false);
    expect(blankAfterInject('note', undefined)).toBe(false);
  });

  it('previousVisibleKind pula o invisível e respeita o piso', () => {
    const bs = [inj('a'), oculto, note];
    expect(previousVisibleKind(bs, 2)).toBe('inject');
    expect(previousVisibleKind(bs, 2, 2)).toBeUndefined();
    expect(previousVisibleKind(bs, 0)).toBeUndefined();
  });
});

describe('inject — medição do cockpit', () => {
  it('a nota mede 1 linha; o seguinte ganha +1 só após um inject', () => {
    expect(measureConversaBlock(inj('a'), CTX)).toBe(1);
    expect(measureConversaBlock(inj('b'), CTX, 'inject')).toBe(1);
    for (const b of [note, tool, aluy]) {
      expect(measureConversaBlock(b, CTX, 'inject')).toBe(measureConversaBlock(b, CTX) + 1);
    }
    expect(measureConversaBlock(oculto, CTX, 'inject')).toBe(measureConversaBlock(oculto, CTX));
  });

  it('fitConversaWindow soma o respiro (usedLines fecha com a soma medida)', () => {
    const bs = [inj('a'), inj('b'), note, inj('c'), tool];
    const w = fitConversaWindow(bs, 100, 0, CTX);
    const esperado =
      1 + 1 + (measureConversaBlock(note, CTX) + 1) + 1 + (measureConversaBlock(tool, CTX) + 1);
    expect(w.usedLines).toBe(esperado);
  });

  it('PARIDADE com o render real: a altura do frame == soma medida', () => {
    const bs = [inj('a'), inj('b'), note, inj('c'), tool, inj('d'), aluy];
    const frame =
      render(
        <ThemeProvider
          theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}
        >
          <Box width={CTX.columns} flexDirection="column">
            {bs.map((b, i) => (
              <BlockView
                key={i}
                block={b}
                isCurrent={false}
                frame={0}
                columns={CTX.columns}
                rows={CTX.rows}
                aposInject={previousVisibleKind(bs, i) === 'inject'}
              />
            ))}
          </Box>
        </ThemeProvider>,
      ).lastFrame() ?? '';
    const medido = bs.reduce(
      (acc, b, i) => acc + measureConversaBlock(b, CTX, previousVisibleKind(bs, i)),
      0,
    );
    expect(frame.split('\n').length).toBe(medido);
  });
});

describe('inject — orçamento da região viva', () => {
  const base = { phase: 'tool' as const, hasBlocks: true, columns: 100, rows: 40 };
  it('o bloco vivo após um inject conta +1; inject após inject não', () => {
    const runTool: SessionBlock = {
      kind: 'tool',
      verb: 'bash',
      target: 'x',
      result: '',
      status: 'running',
    };
    const a = liveOverheadLines({ ...base, live: [inj('a'), runTool] });
    const b = liveOverheadLines({ ...base, live: [runTool] });
    expect(a - b).toBe(1 + 1); // a nota (1) + o respiro do bloco seguinte (1)
    const c = liveOverheadLines({ ...base, live: [inj('a'), inj('b')] });
    const d = liveOverheadLines({ ...base, live: [inj('a')] });
    expect(c - d).toBe(1);
  });
});
