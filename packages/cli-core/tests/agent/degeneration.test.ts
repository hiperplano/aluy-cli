// EST-0969 (anti-runaway · guarda de LOOP DEGENERADO) — prova SINTÉTICA da
// heurística (sem modelo real): degenerado DISPARA / legítimo NÃO dispara,
// configurável, e o toggle. Defesa do "não-falso-positivo" em código real.
import { describe, expect, it } from 'vitest';
import {
  DegenerationDetector,
  DegenerateLoopError,
  detectShortCycle,
  resolveDegenerationConfig,
  isDegenerationGuardEnabled,
  newDegenerationSink,
  DEFAULT_DEGENERATION_CONFIG,
  DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS,
  DEGENERATION_MAX_LINE_REPEATS_ENV,
  DEGENERATION_DISABLE_ENV,
} from '../../src/agent/degeneration.js';

/** Empurra `text` byte-a-byte (pior caso de chunking) e devolve o erro, se houver. */
function feedCharByChar(d: DegenerationDetector, text: string): DegenerateLoopError | undefined {
  try {
    for (const ch of text) d.push(ch);
    return undefined;
  } catch (e) {
    if (e instanceof DegenerateLoopError) return e;
    throw e;
  }
}

/** Empurra `text` num único chunk grande. */
function feedWhole(d: DegenerationDetector, text: string): DegenerateLoopError | undefined {
  try {
    d.push(text);
    return undefined;
  } catch (e) {
    if (e instanceof DegenerateLoopError) return e;
    throw e;
  }
}

describe('EST-0969 · detector de linha repetida (heurística 1)', () => {
  it('mesma linha 30× seguidas ⇒ DISPARA (line-repeat) — o caso do Tiago', () => {
    const d = new DegenerationDetector();
    const text = `pensando...\n${'<<<EDIT_STDIN>/>/>\n'.repeat(30)}`;
    const err = feedCharByChar(d, text);
    expect(err).toBeInstanceOf(DegenerateLoopError);
    expect(err!.kind).toBe('line-repeat');
    // dispara no limiar default (25), MUITO antes das 30 (e dos 217 reais).
    expect(err!.repeats).toBe(DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS);
    expect(err!.sample).toContain('EDIT_STDIN');
  });

  it('chunking não importa: mesma linha repetida num único chunk gigante ⇒ DISPARA', () => {
    const d = new DegenerationDetector();
    const err = feedWhole(d, `${'a mesma frase de verdade\n'.repeat(40)}`);
    expect(err).toBeInstanceOf(DegenerateLoopError);
    expect(err!.kind).toBe('line-repeat');
  });

  it('NÃO dispara: 5 linhas `},` num trecho de código (repetição LEGÍTIMA baixa)', () => {
    const d = new DegenerationDetector();
    const code = [
      'function f() {',
      '  const a = { x: 1 };',
      '  const b = { y: 2 };',
      '  return [a, b];',
      '},',
      '},',
      '},',
      '},',
      '},',
      'const z = 3;',
    ].join('\n');
    expect(feedWhole(d, `${code}\n`)).toBeUndefined();
  });

  it('NÃO dispara: muitas linhas `},` ESPALHADAS (não consecutivas idênticas de conteúdo)', () => {
    // `}` (1 char, trivial) e `},` (2 chars) intercalados com código real: o
    // contador zera a cada linha diferente ⇒ nunca acumula até o limiar.
    const d = new DegenerationDetector();
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`  item[${i}] = compute(${i});`, '},', '}');
    }
    expect(feedWhole(d, `${lines.join('\n')}\n`)).toBeUndefined();
  });

  it('NÃO dispara: linhas TRIVIAIS (vazias / 1 char) repetidas não contam como conteúdo', () => {
    const d = new DegenerationDetector();
    // 100 linhas vazias seguidas (ex.: espaçamento) — triviais, não disparam.
    expect(feedWhole(d, '\n'.repeat(100))).toBeUndefined();
    const d2 = new DegenerationDetector();
    expect(feedWhole(d2, '}\n'.repeat(100))).toBeUndefined();
  });

  it('NÃO dispara: texto normal variado, longo', () => {
    const d = new DegenerationDetector();
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`Passo ${i}: analiso o arquivo número ${i} e anoto a observação ${i * 7}.`);
    }
    expect(feedWhole(d, `${lines.join('\n')}\n`)).toBeUndefined();
  });

  it('uma linha DIFERENTE no meio ZERA o contador (sem acúmulo cross-blocos)', () => {
    const d = new DegenerationDetector();
    // 20 iguais, uma diferente, mais 20 iguais — nenhum bloco chega a 25.
    const text =
      `${'linha repetida de conteúdo\n'.repeat(20)}` +
      'INTERROMPE com algo novo\n' +
      `${'linha repetida de conteúdo\n'.repeat(20)}`;
    expect(feedWhole(d, text)).toBeUndefined();
  });
});

describe('EST-0969 · detector de ciclo curto (heurística 2)', () => {
  it('ciclo curto COLADO sem \\n (abcabc… longo) ⇒ DISPARA (short-cycle)', () => {
    const d = new DegenerationDetector();
    // 'abc' repetido o suficiente p/ passar o span default (2000 chars).
    const err = feedWhole(d, 'abc'.repeat(1000));
    expect(err).toBeInstanceOf(DegenerateLoopError);
    expect(err!.kind).toBe('short-cycle');
  });

  it('ciclo do marcador alucinado colado (<<<EDIT_STDIN>/>/>…) ⇒ DISPARA', () => {
    const d = new DegenerationDetector();
    const err = feedCharByChar(d, '<<<EDIT_STDIN>/>/>'.repeat(300));
    expect(err).toBeInstanceOf(DegenerateLoopError);
    // pode ser short-cycle (colado) ou line-repeat se houver \n; aqui é colado.
    expect(err!.kind).toBe('short-cycle');
  });

  it('NÃO dispara: período curto LEGÍTIMO e CURTO (régua markdown ------)', () => {
    const d = new DegenerationDetector();
    // 20 hífens é uma régua normal — bem abaixo do span de 2000.
    expect(feedWhole(d, '\nseção\n--------------------\ntexto\n')).toBeUndefined();
  });

  it('detectShortCycle: acha o período e conta as repetições', () => {
    const hit = detectShortCycle('xy'.repeat(2000), 80, 2000);
    expect(hit).toBeDefined();
    expect(hit!.period).toBe(2);
    expect(hit!.unit).toBe('xy');
    expect(hit!.repeats).toBeGreaterThanOrEqual(1000);
  });

  it('detectShortCycle: texto variado curto NÃO casa', () => {
    expect(detectShortCycle('the quick brown fox jumps', 80, 2000)).toBeUndefined();
  });
});

describe('EST-0969 · configurável (ALUY_*) + toggle', () => {
  it('resolveDegenerationConfig lê ALUY_DEGENERATE_LINE_REPEATS (com piso ≥3)', () => {
    expect(
      resolveDegenerationConfig({ [DEGENERATION_MAX_LINE_REPEATS_ENV]: '10' })
        .maxConsecutiveLineRepeats,
    ).toBe(10);
    // valor minúsculo cai no piso 3 (não vira falso-positivo trivial).
    expect(
      resolveDegenerationConfig({ [DEGENERATION_MAX_LINE_REPEATS_ENV]: '1' })
        .maxConsecutiveLineRepeats,
    ).toBe(3);
    // inválido ⇒ default.
    expect(
      resolveDegenerationConfig({ [DEGENERATION_MAX_LINE_REPEATS_ENV]: 'lixo' })
        .maxConsecutiveLineRepeats,
    ).toBe(DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS);
  });

  it('limiar configurado MENOR dispara mais cedo', () => {
    const d = new DegenerationDetector({
      ...DEFAULT_DEGENERATION_CONFIG,
      maxConsecutiveLineRepeats: 5,
    });
    const err = feedWhole(d, `${'mesma linha de conteúdo\n'.repeat(5)}`);
    expect(err).toBeInstanceOf(DegenerateLoopError);
    expect(err!.repeats).toBe(5);
  });

  it('limiar configurado MAIOR não dispara no que disparava no default', () => {
    const d = new DegenerationDetector({
      ...DEFAULT_DEGENERATION_CONFIG,
      maxConsecutiveLineRepeats: 1000,
    });
    expect(feedWhole(d, `${'mesma linha de conteúdo\n'.repeat(30)}`)).toBeUndefined();
  });

  it('ALUY_DEGENERATE_OFF desliga a guarda (sink vira no-op, nunca lança)', () => {
    expect(isDegenerationGuardEnabled({ [DEGENERATION_DISABLE_ENV]: '1' })).toBe(false);
    expect(isDegenerationGuardEnabled({})).toBe(true);
    const sink = newDegenerationSink({ [DEGENERATION_DISABLE_ENV]: 'true' });
    // empurra o pior degenerado possível — o no-op nunca lança.
    expect(() => {
      for (let i = 0; i < 100; i++) sink.push('mesma linha\n');
    }).not.toThrow();
  });

  it('newDegenerationSink ligado dispara igual ao detector', () => {
    const sink = newDegenerationSink({});
    expect(() => {
      for (let i = 0; i < 40; i++) sink.push('uma linha de conteúdo repetida\n');
    }).toThrow(DegenerateLoopError);
  });
});
