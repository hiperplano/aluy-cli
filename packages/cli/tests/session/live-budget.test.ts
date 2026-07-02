// EST-0965 (anti-flicker) — PROVA PURA do orçamento da região viva. O bug: o teto
// da prévia de FALA recebia `rows - 13` INTEIRO, ignorando os OUTROS blocos vivos do
// frame (tool `running`, <Working>, sub-agents, marcador `…N acima`, cursor). Com
// streaming+tool+working a altura total da região DINÂMICA virava `> rows` ⇒ o Ink
// redesenhava tudo a cada frame (`outputHeight >= rows`) ⇒ o "refresh toda hora".
//
// Aqui asseguramos, SEM o modelo (broker zerado): a altura TOTAL da região viva
// (chrome fixo + EXCEDENTE do banner unsafe + outros blocos vivos + a prévia de fala
// no seu teto + o marcador) fica ≤ rows-1 em vários `rows` (20/24/40) e no caso
// crítico streaming+tool+working. É a lógica PURA — espelha linha-a-linha a
// composição do <App> (ver live-budget.ts).
//
// EST-0965 (fix --unsafe): o furo era o `<ModeIndicator>` em `unsafe` virar o BANNER
// (a frase longa quebra p/ 2 linhas em larguras médias) e NÃO ser orçado — só a base
// de 1 linha estava no chrome, e supunha-se que a FOLGA cobria o resto. Em telas
// estreitas a folga já era consumida pelo chrome, e a viva estourava `rows` em
// `--unsafe` ⇒ flicker. Agora o `mode` entra no orçamento e cada asserção roda nos
// DOIS modos (`normal` E `unsafe`). A altura do banner é ANCORADA no render real do
// `<ModeIndicator mode="unsafe">` (Ink testing) em `mode-indicator-height.test.tsx`,
// pra a constante não divergir do componente.

import { describe, expect, it } from 'vitest';
import {
  speechMaxLines,
  slashMenuMaxRows,
  liveOverheadLines,
  modeIndicatorOverhead,
  respiroOverhead,
  LIVE_CHROME_ROWS,
  LIVE_CHROME_BASE_ROWS,
  RESPIRO_ROWS,
  RESPIRO_MIN_ROWS,
  SAFETY_MARGIN,
  MIN_SPEECH_LINES,
  MODE_INDICATOR_BASE_ROWS,
  UNSAFE_INDICATOR_ROWS,
  narrowChromeOverhead,
  liveShellTailMaxLines,
  LIVE_SHELL_OUTPUT_MAX_LINES,
  NARROW_CHROME_MAX_COLS,
  liveRegionMinRows,
} from '../../src/session/live-budget.js';
import type { SessionBlock, SessionState } from '../../src/session/model.js';
import { visualLines } from '../../src/session/visual-lines.js';

type SessionMode = SessionState['mode'];

// ── blocos vivos SINTÉTICOS (sem modelo) ────────────────────────────────────────
const longSpeech = (lines: number): SessionBlock => ({
  kind: 'aluy',
  text: Array.from({ length: lines }, (_, i) => `linha ${i + 1}`).join('\n'),
  streaming: true,
});
const runningTool = (): SessionBlock => ({
  kind: 'tool',
  verb: 'rodar',
  target: 'npm test',
  result: '',
  status: 'running',
  verbGerund: 'rodando',
});
const subagents = (n: number): SessionBlock => ({
  kind: 'subagents',
  children: Array.from({ length: n }, (_, i) => ({
    label: `f${i}`,
    status: 'running' as const,
  })),
});

/**
 * ALTURA TOTAL (linhas) da região viva no frame, do jeito que o Ink a desenharia:
 *   chrome fixo + sobrecusto dos OUTROS vivos + corpo da fala (limitado ao teto) +
 *   o marcador `… (N acima)` (1 linha SE a fala cortar).
 * É a soma que precisa ficar ≤ rows-1 p/ NÃO disparar o clearTerminal do Ink.
 */
function liveRegionHeight(args: {
  rows: number;
  live: readonly SessionBlock[];
  phase: SessionState['phase'];
  hasBlocks: boolean;
  mode: SessionMode;
}): number {
  const max = speechMaxLines(args);
  const overhead = liveOverheadLines({
    live: args.live,
    phase: args.phase,
    hasBlocks: args.hasBlocks,
  });
  const speech = args.live.find((b) => b.kind === 'aluy' && b.streaming);
  const speechLines = speech && speech.kind === 'aluy' ? speech.text.split('\n').length : 0;
  const bodyShown = Math.min(speechLines, max);
  const willTruncate = speechLines > max;
  // EST-0965 (fix --unsafe) — a altura REAL inclui o EXCEDENTE do banner UNSAFE,
  // que NÃO está no chrome (lá só a base de 1 linha do ModeIndicator). EST-0989 — o
  // RESPIRO só conta quando RENDERIZA (tela alta): chrome BASE + respiroOverhead(rows).
  return (
    LIVE_CHROME_BASE_ROWS +
    respiroOverhead(args.rows) +
    modeIndicatorOverhead(args.mode) +
    overhead +
    bodyShown +
    (willTruncate ? 1 : 0)
  );
}

// Os DOIS modos que importam p/ a altura da viva: `unsafe` (banner que quebra p/ 2
// linhas — o furo da EST-0965) e `normal` (base de 1 linha, não regride). `plan`
// segue o mesmo orçamento de `normal` (indicador compacto de 1 linha).
const MODES: readonly SessionMode[] = ['normal', 'unsafe'];

describe('live-budget — orçamento dinâmico da região viva (anti-flicker EST-0965)', () => {
  it('caso crítico (streaming LONGO + tool running): total ≤ rows-1 em normal E unsafe', () => {
    for (const mode of MODES) {
      for (const rows of [20, 24, 40]) {
        const live = [longSpeech(50), runningTool()];
        const total = liveRegionHeight({ rows, live, phase: 'streaming', hasBlocks: true, mode });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('streaming + tool + sub-agentes (3 filhos): ainda ≤ rows-1 em normal E unsafe', () => {
    for (const mode of MODES) {
      for (const rows of [24, 40]) {
        const live = [longSpeech(80), subagents(3), runningTool()];
        const total = liveRegionHeight({ rows, live, phase: 'streaming', hasBlocks: true, mode });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('só a prévia de fala (sem outros vivos): total ≤ rows-1 em normal E unsafe', () => {
    for (const mode of MODES) {
      for (const rows of [20, 24, 40]) {
        const live = [longSpeech(50)];
        const total = liveRegionHeight({ rows, live, phase: 'streaming', hasBlocks: true, mode });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('fase thinking (pré-stream, sem fala ainda): o <Working> entra no orçamento (ambos os modos)', () => {
    for (const mode of MODES) {
      for (const rows of [20, 24, 40]) {
        // sem fala viva; o <Working> de thinking ocupa 1+1(padding) linhas.
        const total = liveRegionHeight({
          rows,
          live: [],
          phase: 'thinking',
          hasBlocks: true,
          mode,
        });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('fase compacting (EST-0973): o <ProgressBar> entra no orçamento igual ao <Working>', () => {
    // O <ProgressBar> do /compact ocupa a MESMA geometria do <Working> de thinking
    // (1 linha + 1 de padding quando há blocos) ⇒ mesmo overhead, mesmo teto.
    for (const hasBlocks of [false, true]) {
      const thinking = liveOverheadLines({ live: [], phase: 'thinking', hasBlocks });
      const compacting = liveOverheadLines({ live: [], phase: 'compacting', hasBlocks });
      expect(compacting, `hasBlocks=${hasBlocks}`).toBe(thinking);
    }
    // e a região viva inteira segue ≤ rows-1 (não dispara o clearTerminal do Ink)
    for (const mode of MODES) {
      for (const rows of [20, 24, 40]) {
        const total = liveRegionHeight({
          rows,
          live: [],
          phase: 'compacting',
          hasBlocks: true,
          mode,
        });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('o teto em UNSAFE é exatamente 1 linha MENOR que em normal (o excedente do banner)', () => {
    // O furo era ignorar o modo: o teto não mudava de normal p/ unsafe, e a viva
    // estourava `rows`. Agora unsafe desconta o excedente do banner (1 linha).
    for (const rows of [24, 40]) {
      const base = {
        rows,
        live: [longSpeech(50), runningTool()],
        phase: 'streaming' as const,
        hasBlocks: true,
      };
      const normalMax = speechMaxLines({ ...base, mode: 'normal' });
      const unsafeMax = speechMaxLines({ ...base, mode: 'unsafe' });
      expect(normalMax - unsafeMax).toBe(UNSAFE_INDICATOR_ROWS - MODE_INDICATOR_BASE_ROWS);
    }
  });

  it('o TETO da fala encolhe quando há mais blocos vivos (orçamento dinâmico)', () => {
    const soloMax = speechMaxLines({
      rows: 40,
      live: [longSpeech(50)],
      phase: 'streaming',
      hasBlocks: true,
      mode: 'normal',
    });
    const withToolMax = speechMaxLines({
      rows: 40,
      live: [longSpeech(50), runningTool()],
      phase: 'streaming',
      hasBlocks: true,
      mode: 'normal',
    });
    const withMoreMax = speechMaxLines({
      rows: 40,
      live: [longSpeech(50), subagents(4), runningTool()],
      phase: 'streaming',
      hasBlocks: true,
      mode: 'normal',
    });
    // Mais blocos vivos ⇒ MENOS teto p/ a fala (o budget é compartilhado).
    expect(withToolMax).toBeLessThan(soloMax);
    expect(withMoreMax).toBeLessThan(withToolMax);
  });

  it('EST-1015 — overlayLines (slash-menu aberto) ENCOLHE o teto da fala 1:1 (anti-flicker)', () => {
    const base = {
      rows: 40,
      live: [longSpeech(50)],
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
    };
    const semMenu = speechMaxLines(base);
    const comMenu = speechMaxLines({ ...base, overlayLines: 6 });
    // O menu mora abaixo do composer e coexiste com o stream ⇒ rouba altura da fala.
    expect(comMenu).toBe(semMenu - 6);
    // Ausente ⇒ comportamento idêntico ao de antes (default 0).
    expect(speechMaxLines({ ...base, overlayLines: 0 })).toBe(semMenu);
  });

  it('piso de segurança: terminal minúsculo nunca dá teto < MIN_SPEECH_LINES (ambos os modos)', () => {
    for (const mode of MODES) {
      const max = speechMaxLines({
        rows: 10,
        live: [longSpeech(50), runningTool()],
        phase: 'streaming',
        hasBlocks: true,
        mode,
      });
      expect(max, `mode=${mode}`).toBe(MIN_SPEECH_LINES);
    }
  });

  it('modeIndicatorOverhead: plan/normal = 0; unsafe = excedente do banner', () => {
    expect(modeIndicatorOverhead('plan')).toBe(0);
    expect(modeIndicatorOverhead('normal')).toBe(0);
    expect(modeIndicatorOverhead('unsafe')).toBe(UNSAFE_INDICATOR_ROWS - MODE_INDICATOR_BASE_ROWS);
  });

  it('liveOverheadLines: tool running = 1 linha', () => {
    expect(liveOverheadLines({ live: [runningTool()], phase: 'streaming', hasBlocks: true })).toBe(
      1,
    );
  });

  it('liveOverheadLines: sub-agentes = cabeçalho + N filhos + paddingBottom', () => {
    // 3 filhos ⇒ 1(cab) + 3 + 1(pad) = 5.
    expect(liveOverheadLines({ live: [subagents(3)], phase: 'streaming', hasBlocks: true })).toBe(
      5,
    );
  });

  it('liveOverheadLines: a prévia de fala soma cabeçalho+cursor+paddingBottom (3)', () => {
    expect(liveOverheadLines({ live: [longSpeech(10)], phase: 'streaming', hasBlocks: true })).toBe(
      3,
    );
  });

  it('constantes documentadas: chrome=9 (base 8 + respiro 1, EST-0989), folga=2, piso=4, banner base=1/unsafe=2', () => {
    expect(LIVE_CHROME_ROWS).toBe(9); // base + respiro (tela alta)
    expect(LIVE_CHROME_BASE_ROWS).toBe(8); // SEM respiro (tela baixa/narrow)
    expect(RESPIRO_ROWS).toBe(1); // o respiro é exatamente 1 linha
    expect(LIVE_CHROME_BASE_ROWS + RESPIRO_ROWS).toBe(LIVE_CHROME_ROWS);
    expect(SAFETY_MARGIN).toBe(2);
    expect(MIN_SPEECH_LINES).toBe(4);
    expect(MODE_INDICATOR_BASE_ROWS).toBe(1);
    expect(UNSAFE_INDICATOR_ROWS).toBe(2);
  });

  it('respiroOverhead: +1 em tela ALTA (≥RESPIRO_MIN_ROWS), 0 em tela baixa (EST-0989)', () => {
    expect(respiroOverhead(RESPIRO_MIN_ROWS)).toBe(RESPIRO_ROWS); // no limiar, renderiza
    expect(respiroOverhead(RESPIRO_MIN_ROWS + 10)).toBe(RESPIRO_ROWS); // alto, renderiza
    expect(respiroOverhead(RESPIRO_MIN_ROWS - 1)).toBe(0); // abaixo, some
    expect(respiroOverhead(20)).toBe(0); // tela baixa: sem respiro (anti-flicker)
  });
});

// EST-0982 — a SAÍDA AO VIVO de um run_command/!comando em `running` entra no
// orçamento (1 do in-flight + as linhas bounded da prévia). Sem orçá-la, a região
// viva estouraria `rows-1` durante um comando verboso ⇒ flicker. Provamos a conta
// e que o teto da fala encolhe e o total fica ≤ rows-1.
describe('EST-0982 — saída ao vivo do comando entra no orçamento da região viva', () => {
  const runningToolWithOutput = (lines: number): SessionBlock => ({
    kind: 'tool',
    verb: 'bash',
    target: 'npm test',
    result: '',
    status: 'running',
    verbGerund: 'rodando',
    liveOutput: Array.from({ length: lines }, (_, i) => `out ${i + 1}`).join('\n'),
  });
  const runningBangWithOutput = (lines: number): SessionBlock => ({
    kind: 'bang',
    command: 'seq 1 100000',
    status: 'running',
    liveOutput: Array.from({ length: lines }, (_, i) => `${i + 1}`).join('\n'),
  });

  it('tool running SEM saída = 1 linha (não-regressão); COM saída soma as linhas', () => {
    expect(liveOverheadLines({ live: [runningTool()], phase: 'streaming', hasBlocks: true })).toBe(
      1,
    );
    // 3 linhas de saída ⇒ 1 (in-flight) + 3 = 4.
    expect(
      liveOverheadLines({
        live: [runningToolWithOutput(3)],
        phase: 'streaming',
        hasBlocks: true,
      }),
    ).toBe(4);
  });

  it('saída longa é CAPPED no orçamento (teto + 1 do marcador `…N acima`)', () => {
    // 50 linhas de saída ⇒ 1 (in-flight) + (cap 6 + 1 marcador) = 8 (não 51).
    expect(
      liveOverheadLines({
        live: [runningToolWithOutput(50)],
        phase: 'streaming',
        hasBlocks: true,
      }),
    ).toBe(8);
    // idem p/ o !comando (bang) streamando muito.
    expect(
      liveOverheadLines({
        live: [runningBangWithOutput(50)],
        phase: 'streaming',
        hasBlocks: true,
      }),
    ).toBe(8);
  });

  it('com saída ao vivo o teto da fala encolhe', () => {
    const soloMax = speechMaxLines({
      rows: 40,
      live: [longSpeech(80)],
      phase: 'streaming',
      hasBlocks: true,
    });
    const withLiveMax = speechMaxLines({
      rows: 40,
      live: [longSpeech(80), runningToolWithOutput(50)],
      phase: 'streaming',
      hasBlocks: true,
    });
    // A saída ao vivo (capped) consome orçamento ⇒ menos teto p/ a fala.
    expect(withLiveMax).toBeLessThan(soloMax);
  });

  it('em terminal NÃO-minúsculo, a região viva com saída ao vivo cabe em rows-1', () => {
    // rows folgado: a conta fecha sem o piso `MIN_SPEECH_LINES` distorcer (em
    // terminal minúsculo o piso prioriza a LEGIBILIDADE da fala sobre o ≤rows-1 —
    // coberto pelo teste de piso da EST-0965; aqui validamos o caso comum).
    const rows = 40;
    const live = [longSpeech(80), runningToolWithOutput(50)];
    const max = speechMaxLines({ rows, live, phase: 'streaming', hasBlocks: true });
    const overhead = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true });
    const speechLines = 80;
    const bodyShown = Math.min(speechLines, max);
    const willTruncate = speechLines > max;
    const total =
      LIVE_CHROME_BASE_ROWS + respiroOverhead(rows) + overhead + bodyShown + (willTruncate ? 1 : 0);
    expect(total).toBeLessThanOrEqual(rows - 1);
  });

  // EST-0982 (type-ahead) — a FILA de inputs mora ABAIXO da região viva (acima do
  // composer): consome altura do frame. O orçamento desconta `queuedLines` do teto da
  // fala p/ a soma TOTAL caber em rows-1 (anti-flicker intacto com a fila na tela).
  it('a fila (queuedLines) encolhe o teto da fala na MESMA proporção', () => {
    const base = {
      rows: 40,
      live: [longSpeech(80)],
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
    };
    const noQueue = speechMaxLines(base);
    const withQueue = speechMaxLines({ ...base, queuedLines: 5 });
    // 5 linhas de fila ⇒ 5 linhas a menos no teto da fala (longe do piso, em rows=40).
    expect(withQueue).toBe(noQueue - 5);
  });

  it('a região viva + a fila ainda cabe em rows-1', () => {
    const rows = 40;
    const live = [longSpeech(80)];
    const queuedLines = 5;
    const max = speechMaxLines({ rows, live, phase: 'streaming', hasBlocks: true, queuedLines });
    const overhead = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true });
    const speechLines = 80;
    const bodyShown = Math.min(speechLines, max);
    const willTruncate = speechLines > max;
    // Soma TOTAL = chrome fixo + respiro(se tela alta) + outros vivos + fala (teto) +
    // marcador + a FILA.
    const total =
      LIVE_CHROME_BASE_ROWS +
      respiroOverhead(rows) +
      overhead +
      bodyShown +
      (willTruncate ? 1 : 0) +
      queuedLines;
    expect(total).toBeLessThanOrEqual(rows - 1);
  });
});

// EST-0965 (WRAP) — o furo que sobrou do #59/#64: o orçamento contava linhas-FONTE.
// Uma linha mais larga que `columns` quebra em VÁRIAS visuais ⇒ a altura REAL da
// região viva passava do orçado ⇒ flicker. Aqui a prova SINTÉTICA (sem modelo, com
// `columns` estreito p/ FORÇAR wrap): a altura VISUAL TOTAL da região viva ≤ rows-1
// MESMO com linhas largas, em `unsafe` E `normal`. A indentação da fala é 2 colunas
// (paddingLeft), então o wrap da fala acontece em `columns - 2`.
describe('EST-0965 (wrap) — altura VISUAL da região viva ≤ rows-1 com linhas LARGAS', () => {
  const SPEECH_INDENT = 2;

  // Fala com `n` linhas-fonte, cada uma de `width` chars (forçam wrap em col estreito).
  const wideSpeech = (n: number, width: number): SessionBlock => ({
    kind: 'aluy',
    text: Array.from({ length: n }, (_, i) => `L${i} `.padEnd(width, 'x')).join('\n'),
    streaming: true,
  });
  const runningToolWide = (n: number, width: number): SessionBlock => ({
    kind: 'tool',
    verb: 'bash',
    target: 'curl api',
    result: '',
    status: 'running',
    verbGerund: 'rodando',
    liveOutput: Array.from({ length: n }, (_, i) => `{"item":${i},`.padEnd(width, '_') + '}').join(
      '\n',
    ),
  });

  /**
   * ALTURA VISUAL TOTAL da região viva no frame, como o Ink a desenharia COM WRAP:
   *   chrome fixo + excedente do banner unsafe + overhead dos outros vivos (visual) +
   *   corpo da fala MOSTRADO (medido em linhas VISUAIS, limitado ao teto) + 1 (marcador).
   * É o que precisa ficar ≤ rows-1.
   */
  function visualLiveRegionHeight(args: {
    rows: number;
    columns: number;
    live: readonly SessionBlock[];
    mode: SessionMode;
  }): number {
    const { rows, columns, live, mode } = args;
    const phase = 'streaming' as const;
    const max = speechMaxLines({ rows, live, phase, hasBlocks: true, mode, columns });
    const overhead = liveOverheadLines({ live, phase, hasBlocks: true, columns });
    const speech = live.find((b) => b.kind === 'aluy' && b.streaming);
    // altura VISUAL real do corpo da fala (wrap em columns-2), limitada ao teto.
    const speechVisual =
      speech && speech.kind === 'aluy' ? visualLines(speech.text, columns - SPEECH_INDENT) : 0;
    const bodyShown = Math.min(speechVisual, max);
    const willTruncate = speechVisual > max;
    return (
      LIVE_CHROME_BASE_ROWS +
      respiroOverhead(rows) +
      modeIndicatorOverhead(mode) +
      overhead +
      bodyShown +
      (willTruncate ? 1 : 0)
    );
  }

  it('5 linhas-fonte de 250 chars (col=80): a altura VISUAL ≤ rows-1 (era o furo: 5 fonte = 20 visuais)', () => {
    for (const mode of MODES) {
      for (const rows of [20, 24]) {
        const live = [wideSpeech(5, 250)];
        const total = visualLiveRegionHeight({ rows, columns: 80, live, mode });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('fala LARGA + tool running (col=80): a altura VISUAL ≤ rows-1 em normal E unsafe', () => {
    // O furo era a FALA: 8 linhas-fonte de 250 chars = 32 visuais em col=78. A janela
    // de cauda visual corta p/ caber no teto VISUAL ⇒ a região viva cabe em rows-1
    // mesmo com a fala larga + uma tool viva, em 20/24/40, normal E unsafe.
    for (const mode of MODES) {
      for (const rows of [20, 24, 40]) {
        const live = [wideSpeech(8, 250), runningTool()];
        const total = visualLiveRegionHeight({ rows, columns: 80, live, mode });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('o teto VISUAL com `columns` ESTREITO é MENOR (mais wrap) que sem wrap', () => {
    // Mesmos blocos; passar `columns` (wrap real) desconta a saída ao vivo larga em
    // VISUAIS ⇒ teto menor que ignorando a largura (col=0 ⇒ conta linhas-fonte).
    const base = {
      rows: 24,
      live: [wideSpeech(8, 250), runningToolWide(20, 200)],
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
    };
    const semWrap = speechMaxLines({ ...base, columns: 0 }); // linhas-fonte (antigo)
    const comWrap = speechMaxLines({ ...base, columns: 80 }); // linhas VISUAIS
    expect(comWrap).toBeLessThanOrEqual(semWrap);
  });

  it('NÃO REGRIDE linhas CURTAS: com fala estreita o total é o mesmo de antes (≤ rows-1)', () => {
    // linhas curtas não quebram ⇒ visual == fonte; a conta antiga continua valendo.
    for (const mode of MODES) {
      for (const rows of [20, 24, 40]) {
        const live: SessionBlock[] = [
          {
            kind: 'aluy',
            text: Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'),
            streaming: true,
          },
          runningTool(),
        ];
        const total = visualLiveRegionHeight({ rows, columns: 80, live, mode });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('liveOverheadLines com saída LARGA conta linhas VISUAIS (capped no teto+marcador)', () => {
    // 5 linhas-fonte de 200 chars em col=80 (indent 4 ⇒ wrap em 76) = ceil(200/76)=3
    // visuais cada ⇒ 15 visuais; capped em LIVE_SHELL_OUTPUT_MAX_LINES(6)+1 marcador.
    // total = 1 (in-flight) + 7 = 8 — sem wrap a conta antiga daria 1 + 5 = 6 (furo).
    const live = [runningToolWide(5, 200)];
    expect(liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 80 })).toBe(8);
    // sem columns (linhas-fonte): 5 ≤ 6 ⇒ 1 + 5 = 6 (o comportamento antigo).
    expect(liveOverheadLines({ live, phase: 'streaming', hasBlocks: true })).toBe(6);
  });
});

describe('F87 — bloco de sub-agentes é WRAP-AWARE (label longo / terminal estreito)', () => {
  const subWithLabels = (labels: readonly string[]): SessionBlock => ({
    kind: 'subagents',
    children: labels.map((label) => ({ label, status: 'running' as const })),
  });

  it('label que QUEBRA conta 2 linhas visuais por filho (não estoura o orçamento)', () => {
    // `  [abcdefghij] x rodando` = 24 colunas visuais. columns=12 ⇒ 2 visuais/filho.
    const live = [subWithLabels(['abcdefghij'])];
    // overhead = cabeçalho(1) + paddingBottom(1) + 2 (filho quebrado) = 4.
    expect(liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 12 })).toBe(4);
    // largo o bastante p/ caber em 1 visual ⇒ 1 + 1 + 1 = 3 (sem over-contar).
    expect(liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 40 })).toBe(3);
    // sem columns ⇒ degrada p/ linha-fonte (comportamento antigo): 2 + 1 = 3.
    expect(liveOverheadLines({ live, phase: 'streaming', hasBlocks: true })).toBe(3);
  });

  it('o FURO original: 3 filhos com label longo num terminal estreito sub-contavam', () => {
    const labels = ['fix-kpi-ativos', 'ux-menu-coverage', 'adr-menu-coverage'];
    const live = [subWithLabels(labels)];
    const old = 2 + labels.length; // a conta antiga (linhas-fonte) = 5.
    const wrapAware = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 30 });
    // num terminal de 30 colunas, esses labels QUEBRAM ⇒ o orçamento real é MAIOR que
    // a conta antiga (5). Sem isto, a região viva estourava `rows` ⇒ flicker.
    expect(wrapAware).toBeGreaterThan(old);
  });

  it('caso comum (labels curtos, terminal largo) NÃO regride: 2 + nFilhos', () => {
    const live = [subWithLabels(['rust', 'go', 'zig'])];
    expect(liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 120 })).toBe(5);
  });
});

describe('F88 — slashMenuMaxRows: menu + região viva NÃO estoura `rows` (sem flicker/fantasma)', () => {
  // O menu cheio quer muitas linhas; o teto deve JANELÁ-lo p/ caber junto com a viva.
  const MENU_WANTS = 50;

  /** Altura TOTAL do frame com o slash-menu ABERTO durante o stream (pior caso). */
  function totalFrameWithMenu(args: {
    rows: number;
    live: readonly SessionBlock[];
    phase: SessionState['phase'];
    hasBlocks: boolean;
    mode: SessionMode;
    columns: number;
  }): number {
    const cap = slashMenuMaxRows(args);
    const overlayLines = Math.min(MENU_WANTS, cap) + 1; // +1 paddingTop do contêiner
    const speechCap = speechMaxLines({ ...args, overlayLines });
    const overhead = liveOverheadLines({
      live: args.live,
      phase: args.phase,
      hasBlocks: args.hasBlocks,
      columns: args.columns,
    });
    // pior caso: a fala enche o teto (speechCap).
    const liveRegion =
      LIVE_CHROME_BASE_ROWS +
      respiroOverhead(args.rows) +
      modeIndicatorOverhead(args.mode) +
      overhead +
      speechCap;
    return liveRegion + overlayLines;
  }

  it('stream + 3 subagentes + menu cheio ⇒ total ≤ rows-1 (terminais realistas)', () => {
    // ≥30 linhas (Windows Terminal/cmd default ~30). Abaixo de ~28, o conteúdo
    // (chrome+stream+3 subagentes) já lota o terminal — limite inerente, não do fix.
    for (const rows of [30, 40, 60, 100]) {
      const total = totalFrameWithMenu({
        rows,
        live: [longSpeech(300), subagents(3)],
        phase: 'streaming',
        hasBlocks: true,
        mode: 'normal',
        columns: 80,
      });
      expect(total).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('mesmo num terminal MINÚSCULO (24), o fix estoura MUITO menos que o teto antigo', () => {
    const rows = 24;
    const live = [longSpeech(300), subagents(3)];
    const base = {
      rows,
      live,
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
      columns: 80,
    };
    const newTotal = totalFrameWithMenu(base);
    const oldCap = Math.max(4, rows - 10);
    const oldOverlay = Math.min(MENU_WANTS, oldCap) + 1;
    const oldSpeech = speechMaxLines({ ...base, overlayLines: oldOverlay });
    const overhead = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 80 });
    const oldTotal =
      LIVE_CHROME_BASE_ROWS + respiroOverhead(rows) + overhead + oldSpeech + oldOverlay;
    expect(newTotal).toBeLessThan(oldTotal); // o fix é estritamente melhor mesmo no edge.
  });

  it('--yolo + stream + tool + 2 subagentes + menu ⇒ ainda ≤ rows-1', () => {
    for (const rows of [30, 40, 60]) {
      const total = totalFrameWithMenu({
        rows,
        live: [longSpeech(300), subagents(2), runningTool()],
        phase: 'streaming',
        hasBlocks: true,
        mode: 'unsafe',
        columns: 80,
      });
      expect(total).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('prova do BUG: o teto ANTIGO (`rows - 10`) estourava no mesmo cenário', () => {
    const rows = 30;
    const live = [longSpeech(300), subagents(3)];
    const oldCap = Math.max(4, rows - 10);
    const oldOverlay = Math.min(MENU_WANTS, oldCap) + 1;
    const speechCap = speechMaxLines({
      rows,
      live,
      phase: 'streaming',
      hasBlocks: true,
      mode: 'normal',
      columns: 80,
      overlayLines: oldOverlay,
    });
    const overhead = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns: 80 });
    const oldTotal =
      LIVE_CHROME_BASE_ROWS + respiroOverhead(rows) + overhead + speechCap + oldOverlay;
    expect(oldTotal).toBeGreaterThan(rows - 1); // estourava ⇒ Ink full-screen ⇒ flicker+fantasma.
  });

  it('teto nunca abaixo do piso 4 (menu janela em vez de sumir)', () => {
    const cap = slashMenuMaxRows({
      rows: 12,
      live: [longSpeech(300), subagents(5)],
      phase: 'streaming',
      hasBlocks: true,
      mode: 'unsafe',
      columns: 40,
    });
    expect(cap).toBe(4);
  });
});

describe('F163 — sessão gigante em tela baixa/estreita NÃO estoura `rows` (fim do clearTerminal em loop)', () => {
  it('narrowChromeOverhead: +2 abaixo de 80 colunas (StatusBar/FooterHints em wrap); 0 acima', () => {
    expect(narrowChromeOverhead(60)).toBe(2);
    expect(narrowChromeOverhead(NARROW_CHROME_MAX_COLS - 1)).toBe(2);
    expect(narrowChromeOverhead(NARROW_CHROME_MAX_COLS)).toBe(0);
    expect(narrowChromeOverhead(196)).toBe(0);
    // largura desconhecida ⇒ 0 (comportamento antigo, degradação graciosa).
    expect(narrowChromeOverhead(undefined)).toBe(0);
    expect(narrowChromeOverhead(0)).toBe(0);
  });

  it('liveShellTailMaxLines: encolhe em tela baixa (o caso medido 22x60 ⇒ 4) e mantém 6 em tela normal', () => {
    // O stress do F163 mediu: em 22x60 o frame vivo somava 23 linhas com a cauda
    // cheia (6) — precisava de ≤ 4 p/ caber em rows-1. A conta fecha exatamente:
    expect(liveShellTailMaxLines(22, 60)).toBe(4);
    expect(liveShellTailMaxLines(20, 60)).toBe(2);
    // telas normais: cap cheio (comportamento IDÊNTICO ao de antes).
    expect(liveShellTailMaxLines(24, 80)).toBe(LIVE_SHELL_OUTPUT_MAX_LINES);
    expect(liveShellTailMaxLines(33, 196)).toBe(LIVE_SHELL_OUTPUT_MAX_LINES);
    // piso 1: sempre mostra progresso, mesmo em terminal minúsculo.
    expect(liveShellTailMaxLines(10, 40)).toBe(1);
    // rows desconhecido ⇒ cap cheio (antigo).
    expect(liveShellTailMaxLines(0, 60)).toBe(LIVE_SHELL_OUTPUT_MAX_LINES);
  });

  it('o orçamento usa o MESMO cap adaptativo do render (bang streamando em 22x60)', () => {
    // bang vivo com 60 linhas largas (155 chars ⇒ 3 visuais a 56 cols) — o overhead
    // orçado tem que refletir a cauda ENCOLHIDA (4+1 marcador), não a cheia (6+1).
    const bang = {
      kind: 'bang',
      command:
        'for i in $(seq 1 60); do printf "arquivo-%03d " "$i"; head -c 140 /dev/zero; echo; done',
      status: 'running',
      liveOutput: Array.from({ length: 60 }, (_, i) => `arquivo-${i} ${'='.repeat(140)}`).join(
        '\n',
      ),
    } as never;
    const withRows = liveOverheadLines({
      live: [bang],
      phase: 'idle',
      hasBlocks: true,
      rows: 22,
      columns: 60,
    });
    const without = liveOverheadLines({
      live: [bang],
      phase: 'idle',
      hasBlocks: true,
      columns: 60,
    });
    // com rows: cabeçalho (2 visuais a 60 cols) + cauda 4 + marcador 1 = 7;
    // sem rows (antigo): cabeçalho 2 + cauda 6 + marcador 1 = 9.
    expect(withRows).toBeLessThan(without);
    expect(withRows).toBe(2 + liveShellTailMaxLines(22, 60) + 1);
  });

  it('cabeçalho `◌ running` largo conta as linhas VISUAIS (não 1 fixa) em terminal estreito', () => {
    const tool = {
      kind: 'tool',
      verb: 'bash',
      target: 'x'.repeat(100),
      result: '',
      status: 'running',
      verbGerund: 'rodando',
    } as never;
    // 100 chars de alvo + gerúndio (8) + chrome do <Working> (14) = 122 colunas
    // ⇒ 3 visuais a 60 cols (over-contar é seguro no anti-flicker), 1 a 196.
    expect(liveOverheadLines({ live: [tool], phase: 'idle', hasBlocks: true, columns: 60 })).toBe(
      3,
    );
    expect(liveOverheadLines({ live: [tool], phase: 'idle', hasBlocks: true, columns: 196 })).toBe(
      1,
    );
  });
});

// ── F196 — PISO ESTRUTURAL da região viva (anti "branco gigante no resize") ─────────
//
// O bug do dono: ao REDIMENSIONAR o terminal numa sessão cheia, o Ink caía no caminho
// `outputHeight >= rows` (repaint total `clearTerminal + fullStaticOutput + output`), e o
// `clearScreen()` do resize (que remonta o <Static>) fazia o Ink DUPLICAR o `fullStaticOutput`
// a cada redimensionar ⇒ o repaint reescrevia 2×, 3×, … N× o scrollback (bloco/branco
// gigante que só cresce). O <App> passa a PULAR o clearScreen exatamente quando a região viva
// NÃO cabe em `rows` — e o sinal disso é `liveRegionMinRows(...) >= rows`. Aqui provamos, PURO:
//   1) o piso é um LIMITE INFERIOR real (a viva NUNCA é menor que ele);
//   2) em tela BAIXA (com stream) o piso ≥ rows ⇒ clearTerminal garantido ⇒ pular é seguro;
//   3) em tela ALTA o piso < rows ⇒ caminho `fits` ⇒ o clearScreen segue valendo (não pula);
//   4) o sinal é CONSERVADOR: só ≥ rows quando o estouro é garantido p/ QUALQUER fala.
describe('F196 — liveRegionMinRows: piso estrutural que decide pular o clearScreen do resize', () => {
  it('é um LIMITE INFERIOR: a altura REAL da região viva é sempre ≥ o piso', () => {
    // Para vários rows/cols e composições, a altura desenhada (com a fala no seu teto) nunca
    // fica ABAIXO do piso — que é o que garante que "piso ≥ rows" ⇒ "viva ≥ rows" (estoura).
    for (const rows of [10, 12, 16, 24, 40]) {
      for (const columns of [48, 70, 100]) {
        for (const live of [
          [longSpeech(30)],
          [longSpeech(30), runningTool()],
          [longSpeech(30), subagents(3)],
        ] as SessionBlock[][]) {
          const floor = liveRegionMinRows({
            rows,
            live,
            phase: 'streaming',
            hasBlocks: true,
            mode: 'normal',
            columns,
          });
          const real = liveRegionHeight({
            rows,
            live,
            phase: 'streaming',
            hasBlocks: true,
            mode: 'normal',
          });
          expect(real).toBeGreaterThanOrEqual(floor);
        }
      }
    }
  });

  it('tela BAIXA com stream (rows≤13) ⇒ piso ≥ rows ⇒ sinaliza PULAR o clearScreen', () => {
    // Em 12×48 (split/pane pequeno, sessão viva) o chrome (8) + estreito (2) + cabeçalho/cursor/
    // pad da fala (3) = 13 já não cabem em ≤13 ⇒ clearTerminal garantido ⇒ pular o clearScreen
    // (que duplicaria o fullStaticOutput) é seguro. (Em 14 o piso 13<14 ⇒ pode caber ⇒ NÃO pula.)
    for (const rows of [10, 12, 13]) {
      const floor = liveRegionMinRows({
        rows,
        live: [longSpeech(30)],
        phase: 'streaming',
        hasBlocks: true,
        mode: 'normal',
        columns: 48,
      });
      expect(floor).toBeGreaterThanOrEqual(rows);
    }
  });

  it('tela ALTA (rows≥24) ⇒ piso < rows ⇒ NÃO pula (caminho fits: clearScreen limpa órfãos)', () => {
    for (const rows of [24, 40, 50]) {
      const floor = liveRegionMinRows({
        rows,
        live: [longSpeech(30), runningTool()],
        phase: 'streaming',
        hasBlocks: true,
        mode: 'normal',
        columns: 100,
      });
      expect(floor).toBeLessThan(rows);
    }
  });

  it('o sinal FLIPA no resize: mesma sessão, encolher rows cruza de fits→estoura', () => {
    const live: SessionBlock[] = [longSpeech(30)];
    const at = (rows: number, columns: number): boolean =>
      liveRegionMinRows({
        rows,
        live,
        phase: 'streaming',
        hasBlocks: true,
        mode: 'normal',
        columns,
      }) >= rows;
    // Cresça/encolha a MESMA sessão: alto cabe (não pula), baixo estoura (pula) — o effect de
    // resize (App.tsx, F196) lê exatamente este sinal a cada mudança de dimensão.
    expect(at(40, 100)).toBe(false); // fits ⇒ clearScreen segue
    expect(at(12, 48)).toBe(true); //  estoura ⇒ pula o clearScreen (mata a duplicação)
  });

  it('CONSERVADOR: o piso IGNORA o corpo da fala (a viva só pode ser MAIOR, nunca menor)', () => {
    // Fala de 1 linha vs 100 linhas ⇒ MESMO piso (o corpo não entra). Garante que "piso ≥ rows"
    // nunca é um falso-positivo por conteúdo curto: se o piso já estoura, QUALQUER fala estoura.
    const base = {
      rows: 12,
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
      columns: 48,
    };
    expect(liveRegionMinRows({ ...base, live: [longSpeech(1)] })).toBe(
      liveRegionMinRows({ ...base, live: [longSpeech(100)] }),
    );
  });
});
