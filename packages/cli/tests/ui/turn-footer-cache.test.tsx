// O CACHE DE PROMPT chega à tela — que é a única forma de responder de verdade.
//
// O dono perguntou em 10/09: "a gente usa prompt caching?". Os adaptadores passaram a ler
// o número do `usage`; se tivesse parado ali, a resposta continuaria sendo "não sei", só que
// com o dado tendo passado pela mão e sido jogado fora. Ele instalaria a versão nova e não
// veria diferença nenhuma — o meio-conserto de sempre.
//
// E é o número que PROVA o resto: sem ele não dá para verificar que o `cache_control` que
// passamos a mandar teve efeito nos providers de cache explícito.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { TurnFooter } from '../../src/ui/components/TurnFooter.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';
import type { TurnAccountingView } from '../../src/session/model.js';

const BASE: TurnAccountingView = { tokens: 15_600, toolCalls: 2, durationMs: 2_500, live: false };

// eslint-disable-next-line no-control-regex
const SEM_COR = /\u001b\[[0-9;]*m/g;

function frame(a: TurnAccountingView, showCost?: boolean): string {
  const { lastFrame } = render(
    <ThemeProvider theme={resolveTheme('escuro')}>
      <TurnFooter accounting={a} columns={100} {...(showCost !== undefined ? { showCost } : {})} />
    </ThemeProvider>,
  );
  return (lastFrame() ?? '').replace(SEM_COR, '');
}

describe('o rodapé do turno mostra o cache', () => {
  it('mostra a FRAÇÃO quando o provider reportou', () => {
    // A fração, não o total: "8.2k reaproveitados" não diz se foi muito ou pouco sem o
    // total ao lado.
    expect(frame({ ...BASE, cachePct: 80 })).toContain('80% cache');
  });

  it('0% é MOSTRADO — "o cache existe e não pegou" é informação', () => {
    expect(frame({ ...BASE, cachePct: 0 })).toContain('0% cache');
  });

  it('provider MUDO não vira 0% — ausente é diferente de zero', () => {
    // Inventar 0% ali seria afirmar o que não se sabe: o provider pode simplesmente não
    // reportar o campo.
    expect(frame(BASE)).not.toContain('cache');
  });

  it('não atropela o que o rodapé já mostrava', () => {
    const f = frame({ ...BASE, cachePct: 42 });
    expect(f).toContain('tokens');
    expect(f).toContain('2 tools');
  });

  it('o cache fica ao lado dos tokens, antes das tools', () => {
    // Quem varre o rodapé lê o custo da esquerda para a direita; o quanto foi reaproveitado
    // é leitura do MESMO número, então mora colado nele.
    const f = frame({ ...BASE, cachePct: 42 });
    expect(f.indexOf('42% cache')).toBeGreaterThan(f.indexOf('tokens'));
    expect(f.indexOf('42% cache')).toBeLessThan(f.indexOf('2 tools'));
  });

  it('com o custo desligado, não aparece (segue o showCost)', () => {
    expect(frame({ ...BASE, cachePct: 80 }, false)).not.toContain('cache');
  });
});
