// EST-0966 / EST-1010 · /theme — REGISTRO de temas nomeados (dado listável p/ o picker).
//
// O `resolveTheme` (theme.ts) sabe pintar a partir do `Brightness`; este módulo é o
// CATÁLOGO de temas NOMEADOS — o que o `/theme` lista, marca o ativo e troca. Espelha
// a ideia do OpenCode (temas nomeados), mas SEM cor crua: cada tema aponta a PALETA
// curada do DS (palette.ts) e o seu FUNDO nominal.
//
// EST-1010 (port dos 3 temas do aluy web): antes só dark/light eram selecionáveis e a
// paleta saía só do `brightness`. Agora há TRÊS temas — light / dark / slate — TODOS
// com accent ÂMBAR (o amarelo do Λluy); o que muda entre eles é o FUNDO/tom:
//   · light — creme (--stone-50), accent escurecido p/ AA sobre fundo claro;
//   · dark  — quase-preto neutro (#070707), accent --amber-400;
//   · slate — terra escura WARM (--stone-950), accent --amber-400.
// Cada tema carrega o seu próprio `bg` (a cor que o `/theme` SETA no terminal via OSC
// 11 — EST-1010 §3) e a sua paleta truecolor (palette.ts). O `brightness` continua
// guiando a degradação ansi16 e o piso de contraste; mono (NO_COLOR) zera a cor nos
// três (significado no glifo+palavra).
//
// Contraste: o piso AA de cada tema é VERIFICADO em teste (tests/ui/themes.test.ts)
// sobre o `bg` declarado aqui (sem mágica espalhada).

import { resolveTheme, type Brightness, type ResolveThemeInput, type Theme } from './theme.js';
import { TRUECOLOR_DARK, TRUECOLOR_LIGHT, TRUECOLOR_SLATE, type Palette } from './palette.js';

/** Nome canônico de um tema (o que o usuário digita em `/theme <nome>`). */
export type ThemeName = 'aluy-dark' | 'aluy-light' | 'aluy-slate';

/** Uma entrada do catálogo de temas (DADO p/ o picker — nunca hardcode por tela). */
export interface ThemeEntry {
  /** Chave canônica (case-insensitive na resolução). */
  readonly name: ThemeName;
  /** Rótulo amigável exibido no picker. */
  readonly label: string;
  /** Brilho do fundo deste tema (escolhe a degradação ansi16 e o piso de contraste). */
  readonly brightness: Brightness;
  /** Uma linha de descrição (a11y / discoverability no picker). */
  readonly summary: string;
  /**
   * FUNDO do terminal deste tema (`#RRGGBB`), resolvido dos tokens do DS. Tem dois
   * papéis: (1) o `/theme` SETA esta cor no terminal via OSC 11 ao aplicar o tema
   * (EST-1010) — o "fundo" mais fiel ao web; (2) é a referência do piso de contraste
   * AA (os papéis coloridos têm de passar AA SOBRE este fundo). É o `--bg` do tema.
   */
  readonly bg: string;
  /**
   * PALETA truecolor (os 7 papéis) deste tema. light/dark/slate compartilham o accent
   * ÂMBAR, mas têm fg/fgDim/bg distintos — por isso a paleta vem por TEMA, não só pelo
   * brilho. Em ansi16/mono a degradação ainda sai do `brightness` (theme.ts).
   */
  readonly palette: Palette;
}

/**
 * O catálogo de temas (ordem = ordem no picker). Dark é o default — o primeiro item.
 * Cores resolvidas de `aluy-design-system/.../colors_and_type.css` (tokens DS):
 *   --stone-50 #FAF8F5 · --stone-100 #F2EEE8 · --stone-950 #0E0C09
 *   --amber-400 #DDA13F · --amber-500 #C8821E · --amber-700 #82530F
 */
export const THEMES: readonly ThemeEntry[] = [
  {
    name: 'aluy-dark',
    label: 'Aluy Dark',
    brightness: 'dark',
    summary: 'escuro neutro (default) — fundo quase-preto, accent âmbar',
    // Fundo do web dark (#070707): quase-preto neutro (≠ o terra do slate).
    bg: '#070707',
    palette: TRUECOLOR_DARK,
  },
  {
    name: 'aluy-light',
    label: 'Aluy Light',
    brightness: 'light',
    summary: 'claro creme — fundo --stone-50, accent âmbar escurecido (AA)',
    // Fundo creme (mais quente que o --stone-50 #FAF8F5 do web; no terminal o stone-50
    // "lava" — Tiago pediu mais creme). Contraste AA preservado (fg #1A1712 sobre creme).
    bg: '#F4ECDC',
    palette: TRUECOLOR_LIGHT,
  },
  {
    name: 'aluy-slate',
    label: 'Aluy Slate',
    brightness: 'dark',
    summary: 'terra escura WARM — fundo --stone-950, accent âmbar',
    // Fundo do web slate: --stone-950 (#0E0C09), a terra escura do DS.
    bg: '#0E0C09',
    palette: TRUECOLOR_SLATE,
  },
];

/** O tema DEFAULT (dark) quando nada o sobrepõe (spec: dark é o padrão). */
export const DEFAULT_THEME: ThemeName = 'aluy-dark';

/** Busca uma entrada pelo nome canônico (exato). */
export function themeByName(name: string): ThemeEntry | undefined {
  return THEMES.find((t) => t.name === name);
}

/**
 * Resolve uma string do usuário (`/theme <nome>`) p/ um tema do catálogo. Aceita o
 * nome canônico (`aluy-light`), o apelido curto (`light`/`dark`/`slate`) e variações
 * de caixa/espaço. Devolve `undefined` se não casar (o caller dá um aviso honesto).
 */
export function resolveThemeName(input: string): ThemeEntry | undefined {
  const q = input.trim().toLowerCase();
  if (q === '') return undefined;
  const exact = THEMES.find((t) => t.name === q);
  if (exact) return exact;
  // apelido curto: o sufixo do nome canônico (`dark` ⇒ aluy-dark, `slate` ⇒ aluy-slate).
  const bySuffix = THEMES.find((t) => t.name === `aluy-${q}`);
  if (bySuffix) return bySuffix;
  // por rótulo (`aluy light`, `Aluy Slate`).
  return THEMES.find((t) => t.label.toLowerCase() === q);
}

/**
 * O tema nomeado de um `Brightness` (p/ o caller que só tem o brilho — ex.: a
 * auto-detecção OSC 11 no boot, que devolve dark/light). Mapeia light⇒aluy-light e
 * dark⇒aluy-dark (o dark NEUTRO é o representante canônico do escuro; slate é uma
 * ESCOLHA explícita do usuário, nunca o destino de uma heurística de brilho).
 */
export function themeNameForBrightness(brightness: Brightness): ThemeName {
  return brightness === 'light' ? 'aluy-light' : 'aluy-dark';
}

/**
 * EST-0966/1010 — resolve o `Theme` concreto de um tema NOMEADO. O tema fornece a
 * PALETA truecolor (override do `paletteFor` por brilho) e o `brightness` (que guia a
 * degradação ansi16/mono e os glifos). PRESERVA as demais capacidades do env
 * (colorMode/Unicode/densidade/animação) — trocar de tema NUNCA descarta NO_COLOR nem
 * reduced-motion. Tema desconhecido cai no default (dark), nunca quebra.
 */
export function resolveThemeByName(
  name: string,
  input: Omit<ResolveThemeInput, 'theme' | 'truecolorPalette'> = {},
): Theme {
  const entry = themeByName(name) ?? themeByName(DEFAULT_THEME)!;
  return resolveTheme({
    ...input,
    theme: entry.brightness,
    truecolorPalette: entry.palette,
  });
}
