// CRASH-YOGA — propriedade EXAUSTIVA de `resolveCockpitLayout`: p/ TODA combinação de
// (rows 1..80, cols 20..240, statusline full|compact|hidden, hintsRow, composerLines, dica de
// atividade do log) toda dimensão que vai p/ um <Box> do Yoga é um INTEIRO FINITO ≥ 0 e a
// soma das regiões fecha em `rows`. Uma dimensão NaN/negativa/fracionária no Yoga-wasm é o
// caminho clássico p/ corromper a memória; este teste trava o gerador na origem.
// (O popover de `/` é overlay SOBRE a conversa — não entra na partição, logo não altera as
// alturas; a combinação "popup aberto/fechado" é igual por construção e está coberta aqui.)
import { describe, expect, it } from 'vitest';
import {
  resolveCockpitLayout,
  cockpitRegionSum,
  COCKPIT_MIN_COLS,
  COCKPIT_MIN_ROWS,
  type LogActivityHint,
} from '../../src/session/cockpit-layout.js';
import type { StatuslineMode } from '../../src/io/user-config.js';

const MODES: Array<StatuslineMode | undefined> = ['full', 'compact', 'hidden', undefined];
const HINTS: Array<LogActivityHint | undefined> = [
  undefined,
  { lines: 0, hasActivity: false, activeAgents: 0, focused: false },
  { lines: 7, hasActivity: true, activeAgents: 0, focused: false },
  { lines: 500, hasActivity: true, activeAgents: 2, focused: true },
  { lines: Number.NaN, hasActivity: true, activeAgents: 0, focused: false },
  { lines: Number.POSITIVE_INFINITY, hasActivity: true, activeAgents: 1, focused: true },
  { lines: -3, hasActivity: true, activeAgents: 0, focused: false },
  { lines: 2.5, hasActivity: true, activeAgents: 0, focused: true },
];
const COMPOSER_LINES = [1, 2, 3, 5, 9, 100, 0, -4, Number.NaN, 2.7];

const isInt = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n) && n >= 0;

describe('resolveCockpitLayout — propriedade: dimensões sempre inteiras finitas ≥ 0', () => {
  it('rows 1..80 × cols 20..240 × modos × hintsRow × composer × dica do log', () => {
    let cockpits = 0;
    let refuses = 0;
    const violations: string[] = [];
    const check = (ok: boolean, what: string, ctx: () => string): void => {
      if (!ok && violations.length < 20) violations.push(`${what} ${ctx()}`);
    };
    for (let rows = 1; rows <= 80; rows++) {
      for (let cols = 20; cols <= 240; cols += 11) {
        for (const statusline of MODES) {
          for (const hintsRow of [false, true]) {
            for (const hint of HINTS) {
              for (const composerLines of COMPOSER_LINES) {
                const l = resolveCockpitLayout(rows, cols, composerLines, hint, {
                  ...(statusline !== undefined ? { statusline } : {}),
                  hintsRow,
                });
                const ctx = (): string =>
                  JSON.stringify({ rows, cols, statusline, hintsRow, hint, composerLines });
                check(isInt(l.rows) && isInt(l.cols), 'rows/cols inválidos', ctx);
                if (l.kind === 'refuse') {
                  refuses++;
                  check(cols < COCKPIT_MIN_COLS || rows < COCKPIT_MIN_ROWS, 'recusa indevida', ctx);
                  continue;
                }
                cockpits++;
                const dims = [
                  l.headerRows,
                  l.statusRows,
                  l.composerRows,
                  l.hintsRows,
                  l.regions.conversaRows,
                  l.regions.logRows,
                ];
                check(dims.every(isInt), 'dimensão inválida', ctx);
                // soma fecha em `rows`; as 2 regiões geridas e o composer têm ≥ 1 linha.
                check(cockpitRegionSum(l) === rows, 'soma != rows', ctx);
                check(l.regions.conversaRows >= 1, 'conversa < 1', ctx);
                check(l.regions.logRows >= 1, 'log < 1', ctx);
                check(l.composerRows >= 1, 'composer < 1', ctx);
                check(l.cols === cols, 'cols divergente', ctx);
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
    expect(cockpits).toBeGreaterThan(1000);
    expect(refuses).toBeGreaterThan(1000);
  });

  it('entradas de tela inválidas (NaN, Infinity, negativas, fracionárias) ⇒ recusa ou inteiros válidos', () => {
    const bad = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -5,
      0,
      24.9,
      100.5,
    ];
    for (const rows of bad) {
      for (const cols of bad) {
        const l = resolveCockpitLayout(rows, cols);
        expect(isInt(l.rows)).toBe(true);
        expect(isInt(l.cols)).toBe(true);
        if (l.kind === 'cockpit') expect(cockpitRegionSum(l)).toBe(l.rows);
      }
    }
  });
});
