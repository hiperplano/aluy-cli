// FLICKER-F8 (guarda ESTRUTURAL) — as três funções do orçamento de altura aceitam
// `detachedSubagents` como campo OPCIONAL. Opcional é conveniente e é justamente por isso
// que é perigoso: quem esquecer de passá-lo não vê erro de tipo, não vê teste vermelho, e
// o desconto simplesmente não acontece. O orçamento volta a ser cego ao aviso do F8 EM
// SILÊNCIO — que é exatamente como este defeito nasceu na rc.144.
//
// Não é hipótese: no mesmo dia, a migração de `boxTable` p/ `tableLines` deixou `maxWidths`
// num spread onde a opção era aceita e ignorada — a coluna parou de ser truncada sem uma
// única falha. O tipo aceitava, ninguém passava, e nada acusou.
//
// Precedente para uma guarda que LÊ O FONTE: `packages/cli-core/tests/boundary.test.ts`,
// que trava a fronteira modular do mesmo jeito. Os testes puros (`live-budget.test.ts`)
// provam que o desconto CALCULA certo; este prova que ele é CHAMADO.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP = readFileSync(
  fileURLToPath(new URL('../../src/session/App.tsx', import.meta.url)),
  'utf8',
);

/** Trecho do fonte a partir da abertura da chamada até o `});` que a fecha. */
function chamada(fn: string): string {
  const i = APP.indexOf(`${fn}({`);
  expect(i, `chamada a ${fn} não encontrada no <App>`).toBeGreaterThan(-1);
  const fim = APP.indexOf('});', i);
  return APP.slice(i, fim === -1 ? i + 1200 : fim);
}

describe('FLICKER-F8 — o <App> passa `detachedSubagents` a TODO o orçamento de altura', () => {
  for (const fn of ['speechMaxLines', 'slashMenuMaxRows', 'liveRegionMinRows']) {
    it(`${fn} recebe a contagem de sub-agentes vivos`, () => {
      expect(chamada(fn)).toContain('detachedSubagents');
    });
  }
});
