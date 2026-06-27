// EST-0972 — `/rename <nome> [--cor <cor>]`: rótulo + cor de identificação da sessão.
//
// DoD (parser + paleta do DS, PUROS):
//   - `/rename projeto-x` ⇒ set com cor DETERMINÍSTICA do nome (mesmo nome ⇒ mesma cor);
//   - `--cor azul` ⇒ cor explícita; `--cor=azul` idem; cor inválida ⇒ erro listando válidas;
//   - `/rename` puro ⇒ show (não muda nada); `--limpar` ⇒ clear;
//   - `--cor` sem nome ⇒ erro de uso; nome saneado (espaços/teto);
//   - a paleta vem do DS (8 cores nomeadas), resolve truecolor/ansi16/mono (NO_COLOR sem cor);
//   - o runner LINEAR (não-TTY) aplica set/clear/show/erro e ecoa.

import { describe, expect, it, vi } from 'vitest';
import {
  routeRename,
  runRenameLinear,
  MAX_LABEL_LEN,
  type RenameLinearDeps,
} from '../../src/session/rename.js';
import { displayWidth } from '../../src/session/visual-lines.js';
import {
  hashToSessionColor,
  isSessionColorName,
  sessionColorStyle,
  SESSION_COLOR_NAMES,
  SESSION_COLORS,
} from '../../src/ui/theme/session-colors.js';

describe('routeRename — parse do /rename', () => {
  it('`/rename projeto-x` ⇒ set com nome + cor DETERMINÍSTICA do nome', () => {
    const r = routeRename('projeto-x');
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.label).toBe('projeto-x');
    // a cor default é o hash do nome na paleta do DS — estável e na paleta.
    expect(r.label.color).toBe(hashToSessionColor('projeto-x'));
    expect(SESSION_COLOR_NAMES).toContain(r.label.color);
  });

  it('MESMO nome ⇒ MESMA cor (determinismo); nomes diferentes podem diferir', () => {
    const a = routeRename('alpha');
    const a2 = routeRename('alpha');
    expect(a).toEqual(a2);
    // (não exige que difiram sempre, mas a paleta espalha — pelo menos um par difere)
    const cores = ['alpha', 'beta', 'gamma', 'delta', 'omega'].map(
      (n) => (routeRename(n) as { label: { color: string } }).label.color,
    );
    expect(new Set(cores).size).toBeGreaterThan(1);
  });

  it('`--cor azul` ⇒ cor EXPLÍCITA (vence o default)', () => {
    const r = routeRename('projeto-x --cor azul');
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.label).toBe('projeto-x');
    expect(r.label.color).toBe('azul');
  });

  it('`--cor=azul` (forma com igual) também funciona', () => {
    const r = routeRename('proj --cor=verde');
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.color).toBe('verde');
    expect(r.label.label).toBe('proj');
  });

  it('cor INVÁLIDA ⇒ erro listando as cores VÁLIDAS', () => {
    const r = routeRename('proj --cor turquesa-neon');
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('cor inválida');
    // a mensagem ENSINA: lista todas as cores válidas da paleta do DS.
    for (const name of SESSION_COLOR_NAMES) {
      expect(r.message).toContain(name);
    }
  });

  it('`--cor` SEM valor ⇒ erro (lista válidas)', () => {
    const r = routeRename('proj --cor');
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('verde'); // alguma cor válida listada
  });

  it('`--cor azul` SEM nome ⇒ erro de uso (cor exige nome)', () => {
    const r = routeRename('--cor azul');
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('nome');
  });

  it('`/rename` puro ⇒ SHOW (não muda nada)', () => {
    expect(routeRename('').kind).toBe('show');
    expect(routeRename('   ').kind).toBe('show');
  });

  it('`--limpar`/`limpar`/`--clear` ⇒ CLEAR (volta ao default)', () => {
    expect(routeRename('--limpar').kind).toBe('clear');
    expect(routeRename('limpar').kind).toBe('clear');
    expect(routeRename('--clear').kind).toBe('clear');
  });

  it('nome saneado: colapsa espaços e apara', () => {
    const r = routeRename('  meu   projeto  ');
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.label).toBe('meu projeto');
  });

  it('nome longo é TRUNCADO no teto (cabe no composer denso)', () => {
    const longo = 'x'.repeat(MAX_LABEL_LEN + 20);
    const r = routeRename(longo);
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.label.length).toBeLessThanOrEqual(MAX_LABEL_LEN);
    expect(r.label.label.endsWith('…')).toBe(true);
  });

  // FIX (HUNT-RENDER) — o teto é em COLUNAS de exibição, não em unidades UTF-16. Antes
  // `t.length`/`slice` deixava um nome de MAX_LABEL_LEN CJK ocupar o DOBRO de colunas
  // (cada CJK = 2) ⇒ roubava a linha do composer/SessionTag. Agora mede por displayWidth.
  it('nome CJK é truncado por LARGURA (colunas), não por .length', () => {
    const cjk = '中'.repeat(MAX_LABEL_LEN); // MAX_LABEL_LEN ideogramas = 2× colunas
    const r = routeRename(cjk);
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    // cada CJK = 2 colunas; a largura de exibição NÃO pode passar do teto.
    expect(displayWidth(r.label.label)).toBeLessThanOrEqual(MAX_LABEL_LEN);
    expect(r.label.label.endsWith('…')).toBe(true);
  });

  it('nome com emoji: o corte não parte um par surrogate (sem `\\uFFFD`)', () => {
    const emoji = '🎉'.repeat(MAX_LABEL_LEN); // emojis astral = 2 colunas cada
    const r = routeRename(emoji);
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.label).not.toContain('�'); // nenhum surrogate órfão renderizável.
    expect(displayWidth(r.label.label)).toBeLessThanOrEqual(MAX_LABEL_LEN);
  });

  it('cor case-insensitive (AZUL ⇒ azul)', () => {
    const r = routeRename('proj --cor AZUL');
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.color).toBe('azul');
  });

  // HUNT-SLASH — o `--cor` precisa ser a flag INTEIRA, não um PREFIXO de outra palavra.
  // Sem a fronteira de palavra, um nome com um token tipo `--corrida`/`--correto` casava
  // `--cor` e era tratado como a flag (color='' ⇒ erro espúrio, e o token virava `rida`).
  it('um token `--corrida` no nome NÃO é tratado como o flag --cor (prefixo)', () => {
    const r = routeRename('plano --corrida diaria');
    // antes: casava `--cor`, color='' ⇒ kind:'error'. Correto: é parte do NOME.
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.label).toContain('--corrida'); // o token sobreviveu no nome.
    expect(r.label.label).toBe('plano --corrida diaria');
  });

  it('`--cor` de verdade (com valor) ainda casa, mesmo com `--corX` no nome', () => {
    const r = routeRename('plano --corrida --cor teal');
    expect(r.kind).toBe('set');
    if (r.kind !== 'set') return;
    expect(r.label.color).toBe('teal'); // a flag real foi reconhecida…
    expect(r.label.label).toBe('plano --corrida'); // …e só ela foi extraída do nome.
  });
});

describe('paleta de SESSÃO (do DS) — cores e resolução', () => {
  it('exatamente 8 cores DISTINTAS, todas nomeadas', () => {
    expect(SESSION_COLORS).toHaveLength(8);
    expect(new Set(SESSION_COLOR_NAMES).size).toBe(8);
  });

  it('isSessionColorName valida (e é case-insensitive)', () => {
    expect(isSessionColorName('azul')).toBe(true);
    expect(isSessionColorName('AZUL')).toBe(true);
    expect(isSessionColorName('turquesa')).toBe(false);
  });

  it('truecolor ⇒ hex + bold; ansi16 ⇒ nome Ink; mono (NO_COLOR) ⇒ SEM cor', () => {
    const tc = sessionColorStyle('azul', 'truecolor', 'dark');
    expect(tc.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    const a16 = sessionColorStyle('azul', 'ansi16', 'dark');
    expect(a16.color).toBe('blue');
    const mono = sessionColorStyle('azul', 'mono', 'dark');
    // NO_COLOR/mono: a cor degrada — o ●+nome carregam o significado (a11y).
    expect(mono.color).toBeUndefined();
  });

  it('light escurece o hex (contraste AA sobre fundo claro)', () => {
    const dark = sessionColorStyle('verde', 'truecolor', 'dark').color;
    const light = sessionColorStyle('verde', 'truecolor', 'light').color;
    expect(dark).not.toBe(light);
  });

  it('nome de cor DESCONHECIDO ⇒ fail-safe (cor determinística do nome, nunca lança)', () => {
    const s = sessionColorStyle('inexistente', 'truecolor', 'dark');
    expect(s.color).toMatch(/^#[0-9A-Fa-f]{6}$/); // resolveu uma cor da paleta
  });
});

// ── runner LINEAR (não-TTY) ───────────────────────────────────────────────────
function collector(): { out: { write: (s: string) => void }; text: () => string } {
  let buf = '';
  return { out: { write: (s: string) => (buf += s) }, text: () => buf };
}

describe('runRenameLinear — /rename no não-TTY', () => {
  function deps(over: Partial<RenameLinearDeps> = {}): RenameLinearDeps {
    return {
      setLabel: vi.fn(),
      persist: vi.fn(),
      currentLabel: undefined,
      currentColor: undefined,
      ...over,
    };
  }

  it('não trata uma linha que não é /rename', () => {
    const c = collector();
    expect(runRenameLinear('rode os testes', c.out, deps())).toBe(false);
  });

  it('`/rename proj` ⇒ aplica + persiste + ecoa o ●nome', () => {
    const c = collector();
    const d = deps();
    expect(runRenameLinear('/rename proj --cor azul', c.out, d)).toBe(true);
    expect(d.setLabel).toHaveBeenCalledWith('proj', 'azul');
    expect(d.persist).toHaveBeenCalledOnce();
    expect(c.text()).toContain('● proj');
    expect(c.text()).toContain('azul');
  });

  it('`/rename --limpar` ⇒ setLabel(undefined) + persiste', () => {
    const c = collector();
    const d = deps({ currentLabel: 'proj' });
    expect(runRenameLinear('/rename --limpar', c.out, d)).toBe(true);
    expect(d.setLabel).toHaveBeenCalledWith(undefined);
    expect(c.text()).toContain('removido');
  });

  it('`/rename` puro com rótulo ⇒ MOSTRA o atual (não muda)', () => {
    const c = collector();
    const d = deps({ currentLabel: 'atual', currentColor: 'teal' });
    expect(runRenameLinear('/rename', c.out, d)).toBe(true);
    expect(d.setLabel).not.toHaveBeenCalled();
    expect(c.text()).toContain('● atual');
    expect(c.text()).toContain('teal');
  });

  it('`/rename` puro SEM rótulo ⇒ ensina o uso + cores', () => {
    const c = collector();
    expect(runRenameLinear('/rename', c.out, deps())).toBe(true);
    expect(c.text()).toContain('sem rótulo');
    expect(c.text()).toContain('verde');
  });

  it('cor inválida ⇒ ecoa o erro, NÃO aplica', () => {
    const c = collector();
    const d = deps();
    expect(runRenameLinear('/rename proj --cor neon', c.out, d)).toBe(true);
    expect(d.setLabel).not.toHaveBeenCalled();
    expect(c.text()).toContain('cor inválida');
  });
});
