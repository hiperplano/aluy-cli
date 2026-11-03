// LIMITAÇÃO CONHECIDA (documentada, não desejada) — chip de paste/anexo no eco "você" ao RETOMAR.
//
// No turno ao vivo o bloco `you` carrega `text` (o que o modelo recebe) e `display` (o eco com
// o chip `[texto colado #1, +130 linhas]` / `[anexo: x]`). O registro de sessão em disco
// restaura só `text` (o `sanitizeBlock` do `you` não preserva `display`), então, ao retomar,
// o eco mostra o texto COMPLETO do paste em vez do chip. Este teste trava o comportamento
// ATUAL: se um dia o `display` passar a sobreviver à retomada, o teste falha de propósito —
// atualize-o (e remova este aviso) junto com a correção.

import { describe, expect, it } from 'vitest';
import { sanitizeBlock, blocksToHistory } from '../../src/io/session-record.js';
import type { SessionBlock } from '../../src/session/model.js';

describe('retomada: eco do `you` com chip de paste (limitação conhecida)', () => {
  const completo = 'linha 1\nlinha 2\nlinha 3';
  const chip = '[texto colado #1, +3 linhas]';

  it('o `display` (chip) NÃO sobrevive ao registro: o eco volta com o texto cheio', () => {
    const viaDisco = sanitizeBlock(
      JSON.parse(JSON.stringify({ kind: 'you', text: completo, display: chip })),
    );
    expect(viaDisco).toEqual({ kind: 'you', text: completo });
    expect((viaDisco as { display?: string }).display).toBeUndefined();
  });

  it('o histórico do modelo na retomada usa o texto CHEIO (nunca o chip)', () => {
    const blocks: SessionBlock[] = [{ kind: 'you', text: completo, display: chip }];
    const hist = blocksToHistory(blocks);
    const goal = hist.find((h) => h.role === 'goal');
    expect(goal && 'text' in goal ? goal.text : '').toBe(completo);
    expect(JSON.stringify(hist)).not.toContain('texto colado');
  });
});
