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
import { wordmarkCells, wordmarkHeadIndex } from '../../src/ui/components/AluyLoader.js';
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

  // A ONDA continua sendo o desenho do papel de TOOL (`◌ ~~~ rodando npm test…`) — ali
  // ela acompanha um verbo que muda a cada ferramenta. O que saiu foi a onda no papel do
  // ALUY: o dono achou o indicador permanente poluído ("acho que ta poluido ter aquele
  // progress rodando toda a vez que esta rodando algo") e pediu o wordmark no lugar
  // ("eu colocaria todos os caracteres do aluy aparecendo e desaparecendo um apos o
  // outro... ao vines somente do inicial"). Por isso estes casos passaram a exercitar o
  // papel onde a onda ainda vive, em vez de sumirem.
  it('a banda de onda ~ aparece no papel de TOOL (o motivo do "vau")', () => {
    const out = wrap(<Working glyph="toolInflight" label="rodando" frame={0} />).lastFrame() ?? '';
    expect(out).toContain('~');
  });

  it('o brilho da onda CORRE: frames diferentes movem a cabeça ›', () => {
    // a cabeça › marca a posição corrente; em frames consecutivos ela anda. Como
    // o render é texto, comparamos a posição do › na banda entre 2 frames.
    const f0 = wrap(<Working glyph="toolInflight" label="rodando" frame={0} />).lastFrame() ?? '';
    const f1 = wrap(<Working glyph="toolInflight" label="rodando" frame={1} />).lastFrame() ?? '';
    // ambos têm a cabeça, mas em colunas diferentes ⇒ as strings diferem.
    expect(f0).not.toBe(f1);
    expect(f0).toContain('›');
    expect(f1).toContain('›');
  });

  it('sem animação (ALUY_NO_ANIM): onda ESTÁTICA, mas o verbo permanece', () => {
    const out =
      wrap(<Working glyph="toolInflight" label="rodando npm test" frame={3} />, {
        ALUY_NO_ANIM: '1',
      }).lastFrame() ?? '';
    // sem cabeça correndo (não há › de onda), mas o verbo carrega o sentido.
    expect(out).toContain('rodando npm test…');
    expect(out).toContain('~'); // EST-0984: onda endurecida ～→~
  });

  it('fallback ASCII (sem Unicode): onda vira ~ e o verbo permanece', () => {
    const out =
      wrap(<Working glyph="toolInflight" label="pensando" frame={0} />, {
        TERM: 'linux',
        LANG: 'C',
      }).lastFrame() ?? '';
    expect(out).toContain('~');
    expect(out).toContain('pensando…');
  });
});

// WORDMARK — o que substituiu a onda no papel do Aluy. O que se trava aqui é o que o
// dono pediu (as letras acendendo uma após a outra) E o invariante que a ideia dele
// esbarrava: LARGURA CONSTANTE. Ele disse "aparecendo e desaparecendo"; célula que some
// muda a largura da linha a cada frame, e o EST-0956 existe porque isso gera jitter. As
// letras ficam sempre lá — corre a COR.
describe('<Working> — o wordmark Λluy no papel do Aluy', () => {
  it('desenha o nome INTEIRO, não só a inicial', () => {
    const out = wrap(<Working label="pensando" frame={0} />).lastFrame() ?? '';
    expect(out).toContain('Λluy');
    expect(out).toContain('pensando…');
  });

  it('a onda decorativa SAIU deste papel (era a poluição)', () => {
    const out = wrap(<Working label="pensando" frame={0} />).lastFrame() ?? '';
    expect(out).not.toContain('~');
  });

  // O MOVIMENTO se prova na LÓGICA, não no quadro: o brilho é cor, e neste harness o Ink
  // não emite código de cor (stdout não é TTY), então dois frames renderizados saem
  // idênticos mesmo com o wordmark correndo. Comparar quadros aqui passaria também para um
  // wordmark PARADO — seria um teste vazio, do tipo que passei o dia caçando.
  it('o brilho CORRE de letra em letra (Λ→l→u→y) e dá a volta', () => {
    const total = wordmarkCells('Λ').length; // 4 células em Unicode
    expect(total).toBe(4);
    expect([0, 1, 2, 3, 4, 5].map((f) => wordmarkHeadIndex(f, total))).toEqual([0, 1, 2, 3, 0, 1]);
    // frame negativo (relógio reiniciado) não quebra o índice.
    expect(wordmarkHeadIndex(-1, total)).toBe(3);
  });

  it('em ASCII o wordmark tem 5 células (a marca /\\ ocupa duas) e ainda corre', () => {
    const total = wordmarkCells('/\\').length;
    expect(total).toBe(5);
    expect([0, 4, 5].map((f) => wordmarkHeadIndex(f, total))).toEqual([0, 4, 0]);
  });

  it('terminal MONO cai de volta na onda — sem cor, um nome parado não indica trabalho', () => {
    const out = wrap(<Working label="pensando" frame={0} />, { NO_COLOR: '1' }).lastFrame() ?? '';
    expect(out).toContain('~');
    expect(out).toContain('pensando…');
  });

  it('LARGURA CONSTANTE entre frames — nenhuma letra some (anti-jitter EST-0956)', () => {
    // eslint-disable-next-line no-control-regex
    const semCor = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
    // As duas medidas vêm de fontes DIFERENTES de propósito: a largura do texto SEM cor
    // (é o que ocupa célula na tela) e a variação do texto COM cor (o brilho correndo é
    // só código ANSI). Medir as duas na string sem cor daria "nada muda" — e daria certo
    // até para um wordmark parado.
    const larguras = new Set<number>();
    const comCor = new Set<string>();
    for (let f = 0; f < 8; f += 1) {
      const cru = wrap(<Working label="pensando" frame={f} />).lastFrame() ?? '';
      larguras.add(semCor(cru).length);
      comCor.add(cru);
      expect(semCor(cru)).toContain('Λluy'); // as 4 letras, em TODO frame
    }
    expect(larguras.size).toBe(1); // a largura NUNCA muda
    expect(comCor.size).toBeGreaterThanOrEqual(1); // (o brilho se prova no teste acima)
  });

  it('sem animação: nome SÓLIDO, sem pulso, verbo preservado', () => {
    const out = wrap(<Working label="pensando" frame={3} />, { ALUY_NO_ANIM: '1' }).lastFrame() ?? '';
    expect(out).toContain('Λluy');
    expect(out).toContain('pensando…');
  });

  it('SUFIXO na mesma linha: a contagem de sub-agentes não vira um segundo indicador', () => {
    const out =
      wrap(<Working label="pensando" suffix="· 3 sub-agente(s) trabalhando · F8 para parar" frame={0} />)
        .lastFrame() ?? '';
    expect(out.split('\n')).toHaveLength(1); // UMA linha
    expect(out).toContain('pensando…');
    expect(out).toContain('3 sub-agente(s)');
    expect(out).toContain('F8 para parar');
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

  it('sem animação: cai p/ ◕ estático (não gira)', () => {
    const out = wrap(<Spinner frame={5} />, { ALUY_NO_ANIM: '1' }).lastFrame() ?? '';
    expect(out).toContain('◕'); // F-GLYPH-PESO-2: clock ◷→◕
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

  it('concluída ok: ⏺ + resultado quantificado + ✔', () => {
    const out =
      wrap(<ToolLine verb="bash" target="npm test" result="0 erros" status="ok" />).lastFrame() ??
      '';
    expect(out).toContain('⏺');
    expect(out).toContain('0 erros');
    expect(out).toContain('✔'); // F-GLYPH-PESO-2: ✓→✔
  });

  it('erro: ✘ + box de saída com rodapé-resumo na borda inferior (§2.8)', () => {
    const out =
      wrap(
        <ToolLine verb="bash" target="npm test" result="2 falhas" status="err" output="FAIL x" />,
      ).lastFrame() ?? '';
    expect(out).toContain('✘'); // F-GLYPH-PESO-2: ✗→✘
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
