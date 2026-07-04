// F198 — Splash 3D: SHIMMER/GLINT horizontal (troca o antigo "pisca" da sombra). Testa a
// lógica PURA: a cabeça do brilho ANDA com o frame e é CÍCLICA; o degradê (pico→halo→fora)
// mapeia nos 3 papéis; a grade tem LARGURA/ALTURA estáveis entre frames (anti-flicker) e só o
// PAPEL (cor) da marca/sombra muda; e o gate reduced-motion (marca toda `accent`, sombra toda
// `depth`, sem brilho).
// F200 — pedido do dono: a marca é ÂMBAR (accent/accentMid/accentDim, degradê do brilho) e a
// SOMBRA 3D é VERDE/TEAL — contraste de matiz: luz âmbar, sombra fria teal.
// F200b — pedido do dono: a luz que varre a marca passa TAMBÉM pela sombra, em sincronia — a
// sombra ganha seu PRÓPRIO degradê teal (depthBright pico / depth halo / depthDim fora),
// sincronizado ao `shimmerAt` da coluna-FONTE que a projeta (não mais um tom `depth` fixo). O
// efeito visual em si é verificado no TTY pelo dono.

import { describe, expect, it } from 'vitest';
import {
  shimmerHead,
  shimmerAt,
  shimmerRole,
  shadowRole,
  composeShadowedWordmark,
  rowSegments,
  SHADOW_SHADE,
  SHIMMER_SPEED,
  SHIMMER_TAIL,
  type Cell,
} from '../../src/ui/components/wordmark-3d.js';

const WIDTH = 33; // largura aprox. da marca combinada (Λ + gap + luy) — só p/ os testes puros.

describe('shimmerHead — a cabeça do brilho varre e recomeça', () => {
  it('anda SHIMMER_SPEED colunas por frame (esquerda → direita)', () => {
    expect(shimmerHead(0, WIDTH)).toBe(0);
    expect(shimmerHead(1, WIDTH)).toBe(SHIMMER_SPEED);
    expect(shimmerHead(2, WIDTH)).toBe(2 * SHIMMER_SPEED);
  });

  it('é CÍCLICA: o período é width+SHIMMER_TAIL e recomeça (laço com pausa)', () => {
    const period = WIDTH + SHIMMER_TAIL;
    // frame 0 e frame (period/SPEED) caem na mesma cabeça quando SPEED divide period; de todo
    // modo a cabeça sempre fica DENTRO de [0, period) — cíclica, nunca escapa.
    for (let f = 0; f < 200; f += 1) {
      const h = shimmerHead(f, WIDTH);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(period);
    }
    // Explicitamente cíclica: somar `period` frames·(period/gcd)… simplificamos checando que a
    // sequência de cabeças se repete com período `period` (em unidades de coluna) — head(f) e
    // head(f + period) coincidem pois (f+period)*SPEED ≡ f*SPEED (mod period).
    for (let f = 0; f < 50; f += 1) {
      expect(shimmerHead(f + period, WIDTH)).toBe(shimmerHead(f, WIDTH));
    }
  });

  it('normaliza frame negativo/não-finito (fail-safe, nunca NaN)', () => {
    expect(Number.isFinite(shimmerHead(-1, WIDTH))).toBe(true);
    expect(shimmerHead(Number.NaN, WIDTH)).toBe(0);
    expect(shimmerHead(-5, WIDTH)).toBeGreaterThanOrEqual(0);
  });
});

describe('shimmerAt — degradê: pico anda com o frame, halo em volta, fora escuro', () => {
  it('a coluna do PICO (nível 2) acompanha a cabeça do brilho', () => {
    // no frame 0 a cabeça está na col 0 ⇒ col 0 é pico; alguns frames depois o pico já
    // deslizou p/ a direita (uma coluna à esquerda deixou de ser pico).
    expect(shimmerAt(0, 0, WIDTH)).toBe(2);
    const later = 3;
    const head = shimmerHead(later, WIDTH);
    expect(shimmerAt(head, later, WIDTH)).toBe(2); // pico segue a cabeça
    expect(shimmerAt(0, later, WIDTH)).toBeLessThan(2); // onde estava, já não é mais pico
  });

  it('há um degradê em volta do pico (halo nível 1) — não uma coluna só acesa', () => {
    const head = shimmerHead(5, WIDTH);
    // colunas vizinhas à cabeça pertencem ao halo (nível 1) — realce que esmaece.
    expect(shimmerAt(head + 2, 5, WIDTH)).toBe(1);
    expect(shimmerAt(head - 2, 5, WIDTH)).toBe(1);
  });

  it('longe da cabeça é FORA do brilho (nível 0 — logo em repouso)', () => {
    const head = shimmerHead(5, WIDTH);
    const far = (head + Math.floor(WIDTH / 2)) % WIDTH;
    expect(shimmerAt(far, 5, WIDTH)).toBe(0);
  });

  it('durante a pausa (cabeça na margem SHIMMER_TAIL) toda coluna real fica FORA (nível 0)', () => {
    // acha um frame cuja cabeça esteja além de width+HALO (região só-escuro).
    let pausaFrame = -1;
    for (let f = 0; f < WIDTH + SHIMMER_TAIL; f += 1) {
      if (shimmerHead(f, WIDTH) >= WIDTH + 5) {
        pausaFrame = f;
        break;
      }
    }
    expect(pausaFrame).toBeGreaterThanOrEqual(0);
    for (let c = 0; c < WIDTH; c += 1) {
      expect(shimmerAt(c, pausaFrame, WIDTH)).toBe(0);
    }
  });
});

describe('shimmerRole — intensidade → papel do tema (accent→accentMid→accentDim)', () => {
  it('mapeia os 3 níveis nos 3 papéis do degradê ÂMBAR', () => {
    expect(shimmerRole(2)).toBe('accent');
    expect(shimmerRole(1)).toBe('accentMid');
    expect(shimmerRole(0)).toBe('accentDim');
  });
});

describe('shadowRole — a MESMA intensidade → o degradê TEAL da sombra (F200b)', () => {
  it('mapeia os 3 níveis nos 3 papéis do degradê TEAL (espelha shimmerRole, matiz diferente)', () => {
    expect(shadowRole(2)).toBe('depthBright');
    expect(shadowRole(1)).toBe('depth');
    expect(shadowRole(0)).toBe('depthDim');
  });
});

describe('composeShadowedWordmark — marca com brilho + sombra sincronizada (F200b)', () => {
  it('grade tem 1 linha e 1 coluna a mais (espaço da sombra ↓→) e é retangular', () => {
    const grid = composeShadowedWordmark(2);
    expect(grid.length).toBe(7); // 6 linhas da marca + 1 da sombra
    const widths = new Set(grid.map((r) => r.length));
    expect(widths.size).toBe(1); // todas as linhas com a mesma largura
  });

  it('LARGURA e ALTURA são ESTÁVEIS entre frames (anti-flicker) — só a cor muda', () => {
    const dims = (f: number): string =>
      `${composeShadowedWordmark(f).length}x${composeShadowedWordmark(f)[0]!.length}`;
    const base = dims(0);
    for (let f = 1; f < 40; f += 1) expect(dims(f)).toBe(base);
    // e os CHARES de cada célula não mudam com o frame — só o papel (cor).
    const chars = (f: number): string =>
      composeShadowedWordmark(f)
        .flat()
        .map((c) => c.char)
        .join('');
    expect(chars(7)).toBe(chars(0));
    expect(chars(13)).toBe(chars(0));
  });

  it('a marca usa os 3 papéis do brilho ao longo dos frames (accent/accentMid/accentDim)', () => {
    const markRolesAt = (f: number): Set<string> =>
      new Set(
        composeShadowedWordmark(f)
          .flat()
          .filter((c) => c.char === '█')
          .map((c) => c.role as string),
      );
    // a união dos papéis vistos na marca ao longo de um ciclo cobre os 3 tons do degradê ÂMBAR.
    const seen = new Set<string>();
    for (let f = 0; f < WIDTH + SHIMMER_TAIL; f += 1) for (const r of markRolesAt(f)) seen.add(r);
    expect(seen).toContain('accent');
    expect(seen).toContain('accentMid');
    expect(seen).toContain('accentDim');
  });

  it('a SOMBRA usa os 3 papéis do degradê TEAL ao longo dos frames (F200b — shimmeia também)', () => {
    // as células de SOMBRA são as com o glifo SHADOW_SHADE (a marca é `█`, âmbar accent/
    // accentMid/accentDim; a sombra é `▒` em depthBright/depth/depthDim — filtramos pelo
    // CHAR, não pelo papel, já que agora o papel da sombra MUDA com o frame).
    const shadowCells = (f: number): Cell[] =>
      composeShadowedWordmark(f)
        .flat()
        .filter((c) => c.char === SHADOW_SHADE);
    expect(shadowCells(0).length).toBeGreaterThan(0);
    // o CHAR da sombra nunca muda (anti-flicker) e o papel é sempre um dos 3 tons TEAL.
    const tealRoles = new Set(['depthBright', 'depth', 'depthDim']);
    for (const f of [0, 3, 9, 20]) {
      expect(
        shadowCells(f).every((c) => c.char === SHADOW_SHADE && tealRoles.has(c.role as string)),
      ).toBe(true);
    }
    // a união dos papéis vistos na sombra ao longo de um ciclo cobre os 3 tons TEAL — a luz
    // atravessa a sombra assim como atravessa a marca.
    const seen = new Set<string>();
    for (let f = 0; f < WIDTH + SHIMMER_TAIL; f += 1) {
      for (const c of shadowCells(f)) seen.add(c.role as string);
    }
    expect(seen).toContain('depthBright');
    expect(seen).toContain('depth');
    expect(seen).toContain('depthDim');
    // e a QUANTIDADE de células de sombra é estável entre frames (não aparece/some).
    expect(shadowCells(9).length).toBe(shadowCells(0).length);
  });

  it('o brilho ANDA: os papéis da marca diferem entre frames distintos (anima)', () => {
    const markRoleString = (f: number): string =>
      composeShadowedWordmark(f)
        .flat()
        .filter((c) => c.char === '█')
        .map((c) => c.role)
        .join(',');
    expect(markRoleString(0)).not.toBe(markRoleString(4)); // brilho em posições diferentes
  });

  it('a sombra shimmeia em SINCRONIA com a marca: seu papel é sempre shadowRole(shimmerAt(coluna-fonte))', () => {
    // a sombra em (r,c) é projetada pela marca em (r-1,c-1) — a coluna-FONTE é c-1. Para
    // TODA célula de sombra, em TODO frame, o papel tem de bater exatamente com
    // shadowRole(shimmerAt(c-1, frame, width)) — prova direta de que a mesma luz que varre a
    // marca (mesmo shimmerAt) governa o degradê teal da sombra, não um tom fixo.
    for (const frame of [0, 3, 9, 20]) {
      const grid = composeShadowedWordmark(frame);
      for (const row of grid) {
        for (let c = 0; c < row.length; c += 1) {
          const cell = row[c]!;
          if (cell.char === SHADOW_SHADE) {
            const expected = shadowRole(shimmerAt(c - 1, frame, WIDTH));
            expect(cell.role).toBe(expected);
          }
        }
      }
    }
  });
});

describe('reduced-motion (animate=false) — SEM brilho, marca em accent E sombra em depth (estáticas)', () => {
  it('toda célula da marca sai em `accent` (realce fixo), independente do frame', () => {
    for (const f of [0, 3, 7, 20]) {
      const markRoles = composeShadowedWordmark(f, false)
        .flat()
        .filter((c) => c.char === '█')
        .map((c) => c.role);
      expect(markRoles.length).toBeGreaterThan(0);
      expect(markRoles.every((r) => r === 'accent')).toBe(true);
    }
  });

  it('F200b — toda célula de SOMBRA sai em `depth` fixo (sem degradê teal), independente do frame', () => {
    for (const f of [0, 3, 7, 20]) {
      const shadowRoles = composeShadowedWordmark(f, false)
        .flat()
        .filter((c) => c.char === SHADOW_SHADE)
        .map((c) => c.role);
      expect(shadowRoles.length).toBeGreaterThan(0);
      expect(shadowRoles.every((r) => r === 'depth')).toBe(true);
    }
  });

  it('a grade estática é IDÊNTICA entre frames (nada anima)', () => {
    const dump = (f: number): string => JSON.stringify(composeShadowedWordmark(f, false));
    expect(dump(1)).toBe(dump(0));
    expect(dump(15)).toBe(dump(0));
  });
});

describe('rowSegments — agrupa células de mesmo papel', () => {
  it('funde consecutivas e separa por papel', () => {
    const row: Cell[] = [
      { role: 'accent', char: '█' },
      { role: 'accent', char: '█' },
      { role: null, char: ' ' },
      { role: 'accentDim', char: '▒' },
    ];
    expect(rowSegments(row)).toEqual([
      { role: 'accent', text: '██' },
      { role: null, text: ' ' },
      { role: 'accentDim', text: '▒' },
    ]);
  });
});
