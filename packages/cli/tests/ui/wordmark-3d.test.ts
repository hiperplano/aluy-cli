// F198 — Splash 3D: SHIMMER/GLINT horizontal (troca o antigo "pisca" da sombra). Testa a
// lógica PURA: a cabeça do brilho ANDA com o frame e é CÍCLICA; o degradê (pico→halo→fora)
// mapeia nos 3 papéis; a grade tem LARGURA/ALTURA estáveis entre frames (anti-flicker) e só a
// COR da marca muda; a sombra é FIXA (não respira mais); e o gate reduced-motion (marca toda
// `accent`, sem brilho). O efeito visual em si é verificado no TTY pelo dono.

import { describe, expect, it } from 'vitest';
import {
  shimmerHead,
  shimmerAt,
  shimmerRole,
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

describe('shimmerRole — intensidade → papel do tema (accent→depth→accentDim)', () => {
  it('mapeia os 3 níveis nos 3 papéis do degradê', () => {
    expect(shimmerRole(2)).toBe('accent');
    expect(shimmerRole(1)).toBe('depth');
    expect(shimmerRole(0)).toBe('accentDim');
  });
});

describe('composeShadowedWordmark — marca com brilho + sombra fixa', () => {
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

  it('a marca usa os 3 papéis do brilho ao longo dos frames (accent/depth/accentDim)', () => {
    const markRolesAt = (f: number): Set<string> =>
      new Set(
        composeShadowedWordmark(f)
          .flat()
          .filter((c) => c.char === '█')
          .map((c) => c.role as string),
      );
    // a união dos papéis vistos na marca ao longo de um ciclo cobre os 3 tons do degradê.
    const seen = new Set<string>();
    for (let f = 0; f < WIDTH + SHIMMER_TAIL; f += 1)
      for (const r of markRolesAt(f)) seen.add(r);
    expect(seen).toContain('accent');
    expect(seen).toContain('depth');
    expect(seen).toContain('accentDim');
  });

  it('a SOMBRA é FIXA (tom SHADOW_SHADE `depth`, não respira mais)', () => {
    // as células de SOMBRA são as com o glifo SHADOW_SHADE (a marca é `█`; o halo do brilho
    // também usa o papel `depth`, então filtramos pelo CHAR, não pelo papel).
    const shadowCells = (f: number): Cell[] =>
      composeShadowedWordmark(f)
        .flat()
        .filter((c) => c.char === SHADOW_SHADE);
    expect(shadowCells(0).length).toBeGreaterThan(0);
    // a sombra é sempre o mesmo glifo E sempre no papel `depth`, em qualquer frame
    // (não é fonte de movimento — anti-flicker).
    for (const f of [0, 3, 9, 20]) {
      expect(shadowCells(f).every((c) => c.char === SHADOW_SHADE && c.role === 'depth')).toBe(true);
    }
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
});

describe('reduced-motion (animate=false) — SEM brilho, marca estática em accent', () => {
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

  it('a grade estática é IDÊNTICA entre frames (nada anima)', () => {
    const dump = (f: number): string =>
      JSON.stringify(composeShadowedWordmark(f, false));
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
      { role: 'depth', char: '▒' },
    ];
    expect(rowSegments(row)).toEqual([
      { role: 'accent', text: '██' },
      { role: null, text: ' ' },
      { role: 'depth', text: '▒' },
    ]);
  });
});
