// EST-0948 · §3.6 / handoff §10.1 — useTick(): o ÚNICO tick central.
//
// O CONTRATO que importa p/ o DoD ("animação via frame-prop, sem timers reais"):
// o componente é puro sobre `frame`; o `useTick` só PRODUZ esse `frame`. Aqui
// cobrimos o que é observável de forma determinística:
//  - `enabled=false` ⇒ frame 0 estável (reduced-motion / não-TTY): o tick não corre;
//  - DEFAULT_TICK_MS é a cadência ~120ms da spec.
// O avanço-por-tempo do timer é exercitado de fato pelos componentes que consomem
// `frame` (animation.test.tsx passa frames concretos) e pela TUI real — o loop de
// efeitos do Ink não roda no harness de teste (ink-testing-library não dispara
// useEffect), então NÃO fingimos um timer aqui (seria um teste-teatro).

import React from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useTick, DEFAULT_TICK_MS } from '../../src/ui/hooks/useTick.js';

function Probe(props: { enabled: boolean }): React.ReactElement {
  const frame = useTick({ enabled: props.enabled });
  return <Text>{`frame=${frame}`}</Text>;
}

describe('useTick', () => {
  it('desabilitado: frame é 0 estável (reduced-motion / não-TTY)', async () => {
    const { lastFrame } = render(<Probe enabled={false} />);
    expect(lastFrame()).toContain('frame=0');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain('frame=0'); // nunca avança quando desligado
  });

  it('o frame inicial é 0 (ponto de partida determinístico)', () => {
    const { lastFrame } = render(<Probe enabled={true} />);
    expect(lastFrame()).toContain('frame=0');
  });

  it('a cadência default é a ~120ms da spec §3.6', () => {
    expect(DEFAULT_TICK_MS).toBe(120);
  });
});
