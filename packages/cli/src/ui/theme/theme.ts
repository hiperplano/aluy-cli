// EST-0948 · spec-tui §3 — resolução de CAPACIDADE do terminal → tema concreto.
//
// Detecta, do ambiente, qual modo de cor usar (truecolor / 16-cores / mono), o
// brilho do fundo (dark/light), o suporte a Unicode (Unicode vs ASCII), a
// densidade (confortável/compacto), e se animação está ligada. Tudo via env —
// SEM acessar TTY aqui (puro, testável). O componente raiz lê isto uma vez e o
// distribui por contexto (theme/context.tsx).
//
// Variáveis (spec §3.1/§3.2/§6 + handoff §10):
//   NO_COLOR           → mono (qualquer valor)         (a11y, padrão de facto)
//   COLORTERM          → `truecolor`/`24bit` ⇒ truecolor
//   TERM               → `linux`/`dumb` ⇒ sem Unicode; `*-256color`/`*color` ⇒ 16
//   COLORFGBG / --theme→ tema claro vs escuro
//   LANG/LC_*          → UTF-8 no locale ⇒ Unicode permitido
//   ALUY_NO_ANIM / --no-anim → desliga pisca/spinner (prefers-reduced-motion)
//   ALUY_DENSITY / --dense   → compacto vs confortável (§5)

import {
  ANSI16_DARK,
  ANSI16_LIGHT,
  MONO,
  TRUECOLOR_DARK,
  TRUECOLOR_LIGHT,
  type Palette,
  type RoleStyle,
  type TermRole,
} from './palette.js';
import {
  ALUY_MARK_ASCII,
  ALUY_MARK_UNICODE,
  ASCII_BOX,
  ASCII_GLYPHS,
  ASCII_SPINNER_FRAMES,
  BRAILLE_FRAMES,
  SAFE_GLYPHS,
  UNICODE_BOX,
  UNICODE_GLYPHS,
  type BoxChars,
  type GlyphName,
} from './glyphs.js';
import { sessionColorStyle } from './session-colors.js';

export type ColorMode = 'truecolor' | 'ansi16' | 'mono';
export type Brightness = 'dark' | 'light';
export type Density = 'comfortable' | 'compact';

/** O tema RESOLVIDO — o que os componentes consomem. */
export interface Theme {
  readonly colorMode: ColorMode;
  readonly brightness: Brightness;
  readonly unicode: boolean;
  /**
   * Perfil SEGURO de glifos ligado (EST-0984): `ALUY_SAFE_GLYPHS=1` / `--ascii`.
   * Em UTF-8 mas com fonte limitada (Terminator teimoso) cai num conjunto de
   * cobertura quase universal — sem ir até o ASCII cru. Implica `unicode=true`.
   */
  readonly safeGlyphs: boolean;
  readonly density: Density;
  readonly animate: boolean;
  /** Estilo de um papel semântico (cor + ênfase) — nunca cor crua no componente. */
  role(name: TermRole): RoleStyle;
  /**
   * EST-0972 — estilo de uma COR de IDENTIFICAÇÃO de sessão (paleta do DS, `/rename
   * --cor`). Resolve o NOME da cor (`ambar`/`verde`/…) p/ o modo/brilho atual; em
   * mono (NO_COLOR) degrada p/ texto sem cor (o ●+nome ainda aparecem). Nome fora da
   * paleta ⇒ a cor determinística do próprio nome (fail-safe). Não é cor crua: é a
   * paleta CURADA do DS aplicada ao eixo de rotulagem.
   */
  sessionColor(name: string): RoleStyle;
  /** Glifo resolvido (Unicode / SAFE / ASCII). */
  glyph(name: GlyphName): string;
  /**
   * A MARCA do Aluy (Λ) resolvida p/ a capacidade do terminal: `Λ` (Unicode/SAFE)
   * ou `/\` (ASCII). É o glifo `aluy`, exposto à parte p/ o <AluyLoader> compor a
   * animação sem reespalhar o literal. 〔EST-0984〕
   */
  readonly aluyMark: string;
  /** Frames do spinner (braille em Unicode, `- \ | /` em ASCII). §3.6. */
  readonly spinnerFrames: readonly string[];
  /** Caracteres de box (arredondado ou ASCII). */
  readonly box: BoxChars;
}

export interface ResolveThemeInput {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Override explícito do brilho (`--theme=light` / OSC 11 / COLORFGBG / o tema
   * NOMEADO ativo do `/theme`, que o caller mapeia p/ o seu `brightness`).
   */
  readonly theme?: Brightness;
  /**
   * EST-1010 — PALETA truecolor explícita do tema NOMEADO ativo (light/dark/slate).
   * Quando presente E o modo é truecolor, vence o `paletteFor` por brilho: é assim
   * que o `slate` (mesmo brilho `dark`, paleta WARM própria) e o `dark` neutro
   * coexistem. Sem efeito em ansi16/mono (a degradação por brilho/NO_COLOR vence —
   * trocar de tema nunca inventa cor onde o terminal não tem). Default: pelo brilho.
   */
  readonly truecolorPalette?: Palette;
  /** Override de densidade (`--dense`). */
  readonly density?: Density;
  /** Override de animação (`--no-anim`). */
  readonly animate?: boolean;
  /**
   * Override do perfil SEGURO de glifos (`--ascii` soft). `true` ⇒ usa
   * SAFE_GLYPHS mesmo em UTF-8 (fonte limitada). Sem efeito quando o terminal já
   * é ASCII puro (TERM=linux / locale não-UTF-8), que sempre vence. 〔EST-0984〕
   */
  readonly safeGlyphs?: boolean;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** Decide o modo de cor a partir do env (NO_COLOR vence tudo). */
export function detectColorMode(env: NodeJS.ProcessEnv): ColorMode {
  // NO_COLOR (https://no-color.org/): qualquer valor (até vazio) ⇒ sem cor.
  if (env.NO_COLOR !== undefined) return 'mono';
  // COLORTERM=truecolor é o sinal mais forte de capacidade — vence antes de
  // inferir do TERM (um TERM vazio mas com COLORTERM=truecolor ainda é truecolor).
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'dumb' || term === '') return 'mono';
  return 'ansi16';
}

/** Decide o brilho do fundo (dark default; COLORFGBG/override p/ light). */
export function detectBrightness(env: NodeJS.ProcessEnv, override?: Brightness): Brightness {
  if (override) return override;
  // COLORFGBG = "fg;bg" (ex.: "15;0" = claro sobre escuro). bg < 8 ⇒ escuro.
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const parts = fgbg.split(';');
    const bg = Number(parts[parts.length - 1]);
    if (Number.isFinite(bg)) return bg >= 8 ? 'light' : 'dark';
  }
  return 'dark';
}

/** Decide suporte a Unicode (TERM=linux ou locale não-UTF-8 ⇒ ASCII). */
export function detectUnicode(env: NodeJS.ProcessEnv): boolean {
  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'linux' || term === 'dumb') return false;
  const locale = `${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`.toLowerCase();
  // Se há locale declarado e NÃO é utf-8 ⇒ ASCII. Sem locale ⇒ assume Unicode
  // (terminais modernos). `ALUY_ASCII` força ASCII (escape hatch/teste).
  if (truthy(env.ALUY_ASCII)) return false;
  if (locale && !locale.includes('utf')) return false;
  return true;
}

/**
 * Decide o perfil SEGURO de glifos (EST-0984). Opt-in EXPLÍCITO p/ terminal
 * teimoso (Terminator/fonte limitada): `ALUY_SAFE_GLYPHS=1` no env ou `--ascii`
 * mapeado p/ o override `safeGlyphs`. NÃO liga sozinho por heurística — é escolha
 * do usuário. (Quando o terminal já é ASCII puro, isto é irrelevante: ASCII vence.)
 */
export function detectSafeGlyphs(env: NodeJS.ProcessEnv, override?: boolean): boolean {
  if (override !== undefined) return override;
  return truthy(env.ALUY_SAFE_GLYPHS);
}

function paletteFor(mode: ColorMode, brightness: Brightness, override?: Palette): Palette {
  if (mode === 'mono') return MONO;
  // EST-1010 — em truecolor o tema NOMEADO pode trazer a sua paleta própria (slate
  // tem brilho `dark` mas paleta WARM distinta do dark neutro). Sem override ⇒ a
  // paleta canônica por brilho. ansi16/mono NUNCA usam o override (degradação manda).
  if (mode === 'truecolor') {
    return override ?? (brightness === 'light' ? TRUECOLOR_LIGHT : TRUECOLOR_DARK);
  }
  return brightness === 'light' ? ANSI16_LIGHT : ANSI16_DARK;
}

/**
 * Resolve o tema completo a partir do ambiente + overrides de flag. Puro: não
 * toca TTY nem o processo — recebe o `env`. Default seguro: dark, Unicode,
 * confortável, animação ligada (a menos que o env/flag desligue).
 */
export function resolveTheme(input: ResolveThemeInput = {}): Theme {
  const env = input.env ?? process.env;
  const colorMode = detectColorMode(env);
  const brightness = detectBrightness(env, input.theme);
  const unicode = detectUnicode(env);
  // SAFE só faz sentido quando há Unicode (em ASCII puro o conjunto ASCII vence).
  const safeGlyphs = unicode && detectSafeGlyphs(env, input.safeGlyphs);
  const density: Density =
    input.density ??
    (truthy(env.ALUY_DENSITY) && env.ALUY_DENSITY === 'compact' ? 'compact' : 'comfortable');
  const animate = input.animate ?? !truthy(env.ALUY_NO_ANIM);

  const palette = paletteFor(colorMode, brightness, input.truecolorPalette);
  // Três níveis (EST-0984): ASCII puro (sem Unicode) > SAFE (opt-in) > Unicode.
  const glyphs = !unicode ? ASCII_GLYPHS : safeGlyphs ? SAFE_GLYPHS : UNICODE_GLYPHS;
  const box = unicode ? UNICODE_BOX : ASCII_BOX;
  // Braille (U+28xx) tem cobertura irregular em fonte limitada ⇒ no SAFE cai nos
  // frames ASCII (`- \ | /`), que nunca viram tofu.
  const spinnerFrames = unicode && !safeGlyphs ? BRAILLE_FRAMES : ASCII_SPINNER_FRAMES;
  const aluyMark = unicode ? ALUY_MARK_UNICODE : ALUY_MARK_ASCII;

  return {
    colorMode,
    brightness,
    unicode,
    safeGlyphs,
    density,
    animate,
    role: (name) => palette[name],
    // EST-0972 — a cor de sessão resolve pelo MESMO modo/brilho do tema (truecolor/
    // ansi16/mono), pela paleta curada do DS (`session-colors.ts`).
    sessionColor: (name) => sessionColorStyle(name, colorMode, brightness),
    glyph: (name) => glyphs[name],
    aluyMark,
    spinnerFrames,
    box,
  };
}
