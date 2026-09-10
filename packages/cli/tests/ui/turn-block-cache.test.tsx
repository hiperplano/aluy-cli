// O cache no CABEÇALHO do bloco — o lugar onde o custo do turno de fato aparece.
//
// A rc.176 foi publicada MOSTRANDO NADA, e o teste de unidade que eu tinha escrito passava.
// O dono mandou testar de verdade ("quero que vc teste o cache") e eu levantei um provider
// falso em 127.0.0.1 que devolve `cached_tokens`. O `cache_control` SAÍA no wire (capturei o
// corpo: 27.555 chars de system com o marcador), mas a tela não mostrava número nenhum.
//
// Eram TRÊS componentes plausíveis e eu tinha instrumentado os dois errados:
//
//   <TurnFooter>          instrumentei 1º; passa em teste isolado, mas o custo MIGROU para
//                         cá (F-CONTA-NO-BLOCO) e o rodapé roda com `showCost:false`.
//   turnAccounting()      é o estado VIVO; o cabeçalho usa o accounting SELADO no fim.
//   accounting do bloco   <- era este.
//
// Nenhum teste pegou porque todos exercitavam a peça ISOLADA. Este arquivo trava o
// componente que a tela usa de verdade.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';
import type { TurnAccountingView } from '../../src/session/model.js';

const CONTA: TurnAccountingView = { tokens: 10_240, toolCalls: 2, durationMs: 100, live: false };

// eslint-disable-next-line no-control-regex
const SEM_COR = /\u001b\[[0-9;]*m/g;

function frame(accounting: TurnAccountingView): string {
  const { lastFrame } = render(
    <ThemeProvider theme={resolveTheme('escuro')}>
      <AluyBlock text="ok." streaming={false} accounting={accounting} columns={100} />
    </ThemeProvider>,
  );
  return (lastFrame() ?? '').replace(SEM_COR, '');
}

describe('o cabeçalho do turno mostra o cache', () => {
  it('mostra a fração quando o provider reportou', () => {
    // Medido de ponta a ponta: provider devolveu 8192 de 10240 => `80% cache` na tela.
    expect(frame({ ...CONTA, cachePct: 80 })).toContain('80% cache');
  });

  it('0% é MOSTRADO — "o cache existe e não pegou" é informação', () => {
    expect(frame({ ...CONTA, cachePct: 0 })).toContain('0% cache');
  });

  it('provider MUDO não vira 0% — ausente é diferente de zero', () => {
    expect(frame(CONTA)).not.toContain('cache');
  });

  it('não atropela o que o cabeçalho já mostrava', () => {
    const f = frame({ ...CONTA, cachePct: 42 });
    expect(f).toContain('tokens');
    expect(f).toContain('2 tools');
  });

  it('fica colado nos tokens, antes das tools', () => {
    const f = frame({ ...CONTA, cachePct: 42 });
    expect(f.indexOf('42% cache')).toBeGreaterThan(f.indexOf('tokens'));
    expect(f.indexOf('42% cache')).toBeLessThan(f.indexOf('2 tools'));
  });
});
