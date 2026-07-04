// EST-0948 · spec-tui §3.1 — os 10 PAPÉIS SEMÂNTICOS do tema de terminal.
//
// Regra mestra (paridade ADR-0041 / DS web): componentes NÃO acessam cor crua —
// leem PAPÉIS. Aqui o papel resolve para truecolor (24-bit), 16-cores (fallback)
// e mono (degradação). Derivado do tema DARK do DS (`colors_and_type.css`), com
// espelho LIGHT (spec §3.2). Nada de identidade nova: é o DS adaptado ao terminal.

/** Os 10 papéis semânticos (slots) do tema de terminal (spec §3.1).
 * (8 base + o degradê ÂMBAR ESCURO da sombra 3D: shadowAmber/shadowAmberDim — F200c.) */
export type TermRole =
  | 'fg' // texto primário (fala, código)
  | 'fgDim' // cronologia, meta, contagens, captions
  | 'accent' // marca + ask (◇ aluy, ⚠ ask, › prompt, [a]/[s])
  | 'accentMid' // âmbar-500 — tom ÂMBAR do meio (degradê do pulso/shimmer: accent→accentMid→accentDim)
  | 'accentDim' // wordmark de boot, realce calmo
  | 'danger' // deny + erro (✗, [n], linha − do diff)
  | 'success' // ✓, linha + do diff, "0 erros"
  | 'depth' // ◍ broker, /model, URLs, meta estrutural (teal)
  | 'shadowAmber' // âmbar ESCURO — tom LIT (pico+halo) do shimmer da sombra 3D (F200c: sombra âmbar, não teal, sincronizada c/ a marca)
  | 'shadowAmberDim'; // âmbar ESCURO+ — tom DIM/repouso da sombra 3D (mais escuro que a marca ⇒ lê como sombra)

/**
 * Estilo resolvido de um papel: cor (hex truecolor OU nome de cor do Ink p/ 16),
 * e flags de ênfase (bold/dim/inverse) que carregam significado em mono (§3.1
 * "Mono"). A TUI passa isto direto às props do `<Text>` do Ink.
 */
export interface RoleStyle {
  /** Cor: hex (`#RRGGBB`) em truecolor, ou nome Ink (`yellow`/`red`/…) em 16. */
  readonly color?: string;
  readonly bold?: boolean;
  readonly dimColor?: boolean;
  readonly inverse?: boolean;
}

/** Mapa completo de papéis → estilo, para um dado modo de cor. */
export type Palette = Readonly<Record<TermRole, RoleStyle>>;

// ── Truecolor (24-bit) — tema DARK (default) ─────────────────────────────────
// Cores do tema dark do DS (spec §3.1). Pisos ≥ AA sobre fundo escuro.
export const TRUECOLOR_DARK: Palette = {
  fg: { color: '#F2EEE8' },
  fgDim: { color: '#8A7F6D', dimColor: true },
  accent: { color: '#DDA13F', bold: true },
  accentMid: { color: '#C8821E', bold: true }, // --amber-500 (tom do meio)
  accentDim: { color: '#A66A14', bold: true },
  danger: { color: '#E5897C', bold: true },
  success: { color: '#82CF9E' },
  depth: { color: '#5BA8A2' }, // --petrol-300 (teal — broker/URLs/meta)
  // F200c — degradê ÂMBAR ESCURO da sombra 3D (sincronizado ao mesmo shimmerAt() da marca).
  // A sombra é da MESMA família âmbar da marca, mas distintamente MAIS ESCURA que ela (a
  // marca varre accent #DDA13F→accentMid #C8821E→accentDim #A66A14; a sombra fica ABAIXO):
  //   · shadowAmber   = --amber-600 (#A66A14) — o tom LIT da sombra (= o tom MAIS ESCURO da
  //     marca) ⇒ no mesmo ponto do brilho a sombra é sempre ≤ a marca (lê como sombra);
  //   · shadowAmberDim= âmbar-650 (#8C5A11, derivado entre --amber-600 e --amber-700,
  //     clareado o mínimo p/ manter ≥3:1 no fundo do slate) — o repouso, mais escuro ainda.
  shadowAmber: { color: '#A66A14' },
  shadowAmberDim: { color: '#8C5A11' },
};

// ── Truecolor — tema LIGHT (terminais de fundo claro, spec §3.2) ─────────────
export const TRUECOLOR_LIGHT: Palette = {
  fg: { color: '#1A1712' },
  // Secundário (meta/cronologia/captions). No fundo CLARO o atributo `dim` do terminal
  // EMPALIDECE o texto (parece "clarinho" demais — achado do dono). Mantemos o PAPEL
  // (subordinado ao `fg`), mas sem `dimColor` e com a cor um pouco mais ESCURA
  // (#544B3C ≈ 6.9:1 sobre o fundo claro) — legível, ainda hierarquicamente abaixo do fg.
  fgDim: { color: '#544B3C' },
  accent: { color: '#82530F', bold: true },
  accentMid: { color: '#82530F', bold: true }, // light colapsa os tons de âmbar (fundo claro)
  accentDim: { color: '#82530F', bold: true },
  danger: { color: '#B23A2A', bold: true },
  // EST-0966: escurecido de #2E7D4F (4.37:1, abaixo de AA) p/ #1F6B3A (5.64:1) —
  // sucesso é texto normal (✓/contagens), exige AA pleno sobre o fundo claro.
  success: { color: '#1F6B3A' },
  depth: { color: '#2E6E69' }, // teal (broker/URLs/meta)
  // F200c — no LIGHT a marca é âmbar-700 (#82530F, tudo colapsado). A sombra tem de ser
  // MAIS ESCURA que a marca ⇒ âmbar-800 (#5E3B0B, no fundo claro = MAIS contraste, lê como
  // sombra). Os 2 tons COLAPSAM no mesmo valor (como o âmbar da marca colapsa no light): a
  // sombra fica num âmbar escuro FIXO — o shimmer da sombra já é imperceptível no light,
  // igual ao da própria marca (accent/accentMid/accentDim colapsados).
  shadowAmber: { color: '#5E3B0B' },
  shadowAmberDim: { color: '#5E3B0B' },
};

// ── 16-cores (fallback) — nomes de cor do Ink/ANSI (spec §3.1 col "16-cores") ──
export const ANSI16_DARK: Palette = {
  fg: { color: 'white' },
  fgDim: { color: 'gray', dimColor: true },
  accent: { color: 'yellow', bold: true },
  accentMid: { color: 'yellow', bold: true },
  accentDim: { color: 'yellow', bold: true },
  danger: { color: 'red', bold: true },
  success: { color: 'green' },
  depth: { color: 'cyan' },
  // 16-cores não tem âmbar-escuro: a sombra é 'yellow' com dimColor (NÃO bold) — a marca é
  // yellow+bold, então a sombra lê como um amarelo MAIS APAGADO (o degradê colapsa: sem
  // shimmer da sombra em 16-cores, como o âmbar da marca também colapsa em 'yellow').
  shadowAmber: { color: 'yellow', dimColor: true },
  shadowAmberDim: { color: 'yellow', dimColor: true },
};

export const ANSI16_LIGHT: Palette = {
  fg: { color: 'black' },
  fgDim: { color: 'gray', dimColor: true },
  accent: { color: 'yellow', bold: true },
  accentMid: { color: 'yellow', bold: true },
  accentDim: { color: 'yellow', bold: true },
  danger: { color: 'red', bold: true },
  success: { color: 'green' },
  depth: { color: 'cyan' },
  shadowAmber: { color: 'yellow', dimColor: true },
  shadowAmberDim: { color: 'yellow', dimColor: true },
};

// ── Truecolor — tema SLATE (escuro WARM do DS — fundo stone-950, spec web) ────
// EST-1010 (port dos 3 temas do web): slate é o "dark warm" do DS — mesmo accent
// ÂMBAR e a mesma família de papéis do dark, mas sobre o fundo `--stone-950` do DS
// (#0E0C09, terra escura) em vez do quase-preto neutro. O `fg` é o creme `--stone-100`
// (#F2EEE8) e o `fgDim` o `--stone-400` (#B0A593, areia), dando o tom morno. Accent
// `--amber-400` (#DDA13F), idêntico ao dark — o que muda é só o FUNDO/tom, não a marca.
export const TRUECOLOR_SLATE: Palette = {
  fg: { color: '#F2EEE8' }, // --stone-100 (creme)
  fgDim: { color: '#B0A593', dimColor: true }, // --stone-400 (areia warm)
  accent: { color: '#DDA13F', bold: true }, // --amber-400
  accentMid: { color: '#C8821E', bold: true }, // --amber-500 (tom do meio)
  accentDim: { color: '#A66A14', bold: true }, // --amber-600
  danger: { color: '#E5897C', bold: true },
  success: { color: '#82CF9E' },
  depth: { color: '#5BA8A2' }, // --petrol-300 — mesmo teal do dark (só o fundo muda)
  // F200c — mesmos tons âmbar-escuros da sombra do dark (o fundo warm do slate é escuro
  // como o dark; a marca âmbar e a sombra âmbar são idênticas — só o --bg muda).
  shadowAmber: { color: '#A66A14' },
  shadowAmberDim: { color: '#8C5A11' },
};

// ── Mono (NO_COLOR / sem cor) — sem cor, só ênfase estrutural (spec §3.1) ─────
// Em mono o SIGNIFICADO mora no glifo+palavra (a11y §6); aqui só bold/dim/inverse
// reforçam, nunca COR. `color` ausente ⇒ Ink não emite SGR de cor.
export const MONO: Palette = {
  fg: {},
  fgDim: { dimColor: true },
  accent: { bold: true },
  accentMid: { bold: true },
  accentDim: { bold: true },
  danger: { bold: true, inverse: true },
  success: {},
  depth: {},
  // sombra em mono: sem cor, só `dim` p/ reforçar "mais apagada" que a marca (bold). O
  // significado real da sombra mora no CHAR `▒` (vs `█` da marca) — a11y §6.
  shadowAmber: { dimColor: true },
  shadowAmberDim: { dimColor: true },
};
