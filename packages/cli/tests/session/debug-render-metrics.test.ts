// `ALUY_DEBUG_RENDER`: métrica por quadro (linhas do Ink × linhas físicas) para diagnosticar o
// fantasma de quadro — o Ink conta 1 linha, o terminal desenha 2 quando ela passa da largura.
import { describe, expect, it } from 'vitest';
import { frameMetrics } from '../../src/session/debug-render.js';

describe('frameMetrics', () => {
  it('quadro que cabe: linhas do Ink = linhas físicas', () => {
    const m = frameMetrics('abc\nde\n', 20);
    expect(m.inkLines).toBe(2);
    expect(m.physicalRows).toBe(2);
    expect(m.overwide).toEqual([]);
  });
  it('linha mais larga que o terminal ocupa 2 linhas físicas e é apontada', () => {
    const m = frameMetrics(`curta\n${'x'.repeat(50)}\n`, 20);
    expect(m.inkLines).toBe(2);
    expect(m.physicalRows).toBe(1 + 3);
    expect(m.overwide).toHaveLength(1);
    expect(m.overwide[0]!.index).toBe(1);
    expect(m.maxWidth).toBe(50);
  });
  it('ignora ANSI e conta glifo largo pela mesma conta do Ink (string-width)', () => {
    const esc = String.fromCharCode(27);
    const m = frameMetrics(`${esc}[31m${'a'.repeat(10)}${esc}[0m\n`, 10);
    expect(m.maxWidth).toBe(10);
    expect(m.physicalRows).toBe(1);
    expect(frameMetrics('日本語日本語\n', 6).physicalRows).toBe(2); // 12 células em 6 colunas
  });
});
