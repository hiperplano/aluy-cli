// EST-0948 · spec §3.6 / handoff §10 — animação "viva", testada SEM timers reais.
//
// A regra de ouro do redesign: a animação é estado DERIVADO de um `frame` passado
// por prop (componentes puros). Aqui passamos `frame` fixo e provamos:
//  - <Working> move o brilho da onda conforme o frame (e é estático sem animação);
//  - <Spinner> resolve o frame braille (e cai p/ ◷ estático sem animação);
//  - o verbo vivo SEMPRE aparece (movimento não carrega sentido — a11y §6);
//  - fallback ASCII (sem Unicode) e NO_COLOR não perdem o sentido.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Working } from '../../src/ui/components/Working.js';
import { Spinner } from '../../src/ui/components/Spinner.js';
import { UnsafeBanner } from '../../src/ui/components/UnsafeBanner.js';
import { ToolLine } from '../../src/ui/components/ToolLine.js';

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', ...env };
  const theme = resolveTheme({ env: base });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('<Working> — a onda "vau" + verbo vivo (§2.4/§2.6)', () => {
  it('mostra o verbo vivo SEMPRE (o sentido não depende do movimento)', () => {
    const { lastFrame } = wrap(<Working label="pensando" frame={0} />);
    expect(lastFrame() ?? '').toContain('pensando…');
  });

  it('a banda de onda ~ aparece (o motivo do "vau"; EST-0984 endureceu ～→~)', () => {
    const out = wrap(<Working label="pensando" frame={0} />).lastFrame() ?? '';
    expect(out).toContain('~');
  });

  it('o brilho da onda CORRE: frames diferentes movem a cabeça ›', () => {
    // a cabeça › marca a posição corrente; em frames consecutivos ela anda. Como
    // o render é texto, comparamos a posição do › na banda entre 2 frames.
    const f0 = wrap(<Working label="rodando" frame={0} />).lastFrame() ?? '';
    const f1 = wrap(<Working label="rodando" frame={1} />).lastFrame() ?? '';
    // ambos têm a cabeça, mas em colunas diferentes ⇒ as strings diferem.
    expect(f0).not.toBe(f1);
    expect(f0).toContain('›');
    expect(f1).toContain('›');
  });

  it('sem animação (ALUY_NO_ANIM): onda ESTÁTICA, mas o verbo permanece', () => {
    const out =
      wrap(<Working label="rodando npm test" frame={3} />, { ALUY_NO_ANIM: '1' }).lastFrame() ?? '';
    // sem cabeça correndo (não há › de onda), mas o verbo carrega o sentido.
    expect(out).toContain('rodando npm test…');
    expect(out).toContain('~'); // EST-0984: onda endurecida ～→~
  });

  it('fallback ASCII (sem Unicode): onda vira ~ e o verbo permanece', () => {
    const out =
      wrap(<Working label="pensando" frame={0} />, { TERM: 'linux', LANG: 'C' }).lastFrame() ?? '';
    expect(out).toContain('~');
    expect(out).toContain('pensando…');
  });
});

describe('<Spinner> — braille (§3.6)', () => {
  it('resolve um frame braille quando animado', () => {
    const out = wrap(<Spinner frame={0} />).lastFrame() ?? '';
    expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('frames diferentes ⇒ glifos diferentes (gira)', () => {
    const f0 = wrap(<Spinner frame={0} />).lastFrame() ?? '';
    const f1 = wrap(<Spinner frame={1} />).lastFrame() ?? '';
    expect(f0).not.toBe(f1);
  });

  it('sem animação: cai p/ ◷ estático (não gira)', () => {
    const out = wrap(<Spinner frame={5} />, { ALUY_NO_ANIM: '1' }).lastFrame() ?? '';
    expect(out).toContain('◷');
  });

  it('fallback ASCII: usa - \\ | / em vez de braille', () => {
    const out = wrap(<Spinner frame={0} />, { TERM: 'linux', LANG: 'C' }).lastFrame() ?? '';
    expect(out).toMatch(/[-\\|/]/);
  });
});

describe('<ToolLine> — in-flight ○ → ⏺ (§2.6; EST-0984 endureceu ◌→○)', () => {
  it('running: ○ + gerúndio + alvo (o agente está fazendo algo agora)', () => {
    const out =
      wrap(
        <ToolLine
          verb="bash"
          target="npm run typecheck"
          result=""
          status="running"
          verbGerund="rodando"
          frame={0}
        />,
      ).lastFrame() ?? '';
    expect(out).toContain('○');
    expect(out).toContain('rodando');
    expect(out).toContain('npm run typecheck');
  });

  it('concluída ok: ⏺ + resultado quantificado + ✓', () => {
    const out =
      wrap(<ToolLine verb="bash" target="npm test" result="0 erros" status="ok" />).lastFrame() ??
      '';
    expect(out).toContain('⏺');
    expect(out).toContain('0 erros');
    expect(out).toContain('✓');
  });

  it('erro: ✗ + box de saída com rodapé-resumo na borda inferior (§2.8)', () => {
    const out =
      wrap(
        <ToolLine verb="bash" target="npm test" result="2 falhas" status="err" output="FAIL x" />,
      ).lastFrame() ?? '';
    expect(out).toContain('✗');
    expect(out).toContain('saída');
    expect(out).toContain('2 falhas'); // o resultado vai no rodapé da borda
  });
});

describe('<UnsafeBanner> — aviso vermelho gritante (decisão do Tiago)', () => {
  // EST-0959 — o banner exibe o nome de PRODUTO do modo: YOLO (`--yolo`).
  it('mostra ⚠ + MODO YOLO + que o agente roda qualquer comando sem perguntar', () => {
    const out = wrap(<UnsafeBanner columns={100} />).lastFrame() ?? '';
    expect(out).toContain('⚠');
    expect(out).toContain('MODO YOLO');
    expect(out).toMatch(/aprovação DESLIGADA/);
    expect(out).toMatch(/QUALQUER comando/);
  });

  it('a11y: o sentido vive no glifo+palavra, não só na cor (NO_COLOR)', () => {
    const out = wrap(<UnsafeBanner columns={100} />, { NO_COLOR: '1' }).lastFrame() ?? '';
    expect(out).toContain('MODO YOLO');
  });

  it('tela estreita encurta a frase, mas mantém o aviso', () => {
    const out = wrap(<UnsafeBanner columns={40} />).lastFrame() ?? '';
    expect(out).toContain('MODO YOLO');
  });
});
