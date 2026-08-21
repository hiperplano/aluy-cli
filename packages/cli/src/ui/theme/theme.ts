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
  NERD_GLYPHS,
  SAFE_GLYPHS,
  UNICODE_BOX,
  UNICODE_GLYPHS,
  type BoxChars,
  type GlyphName,
} from './glyphs.js';
import { sessionColorStyle } from './session-colors.js';
import { observedTerminalBackground, surfaceFrom } from './osc11.js';

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
  /**
   * F-NERD-GLYPHS — perfil NERD FONT ligado: `ALUY_NERD_GLYPHS=1` / config
   * `nerdGlyphs`. Pede ícones/separadores da Private Use Area de uma Nerd Font
   * PATCHEADA (ver NERD_GLYPHS em glyphs.ts). Implica `unicode=true`. NUNCA true
   * quando `safeGlyphs` também está — SAFE vence (precedência ASCII > SAFE >
   * NERD > normal, resolvida abaixo em `resolveTheme`).
   */
  readonly nerdGlyphs: boolean;
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
  /** Glifo resolvido (Unicode / SAFE / NERD / ASCII). */
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
  /**
   * F-COMPOSER-FUNDO (pedido do dono: "um fundo no composer, acho que ficaria top") —
   * cor de FUNDO da faixa do campo de entrada. `undefined` em modo sem cor (NO_COLOR,
   * 16-cores, ASCII): fundo é REALCE, e realce que não pode ser fiel some em vez de
   * chutar uma cor errada — a mesma disciplina do resto da paleta.
   *
   * Tom escolhido para ficar ACIMA do fundo do terminal sem virar bloco: o campo precisa
   * se destacar do histórico, não competir com ele.
   */
  readonly composerBg?: string;
  /**
   * F-ECO-PINTADO (2/2) — fundo do bloco de RESPOSTA do agente. Deliberadamente DIFERENTE
   * do `composerBg`, e MUITO mais discreto que ele (pedido do dono: "próxima à cor do
   * background do tema, mas com uma leve diferença").
   *
   * A assimetria é proposital. O composer é onde você AGE, e some no meio da tela se não
   * se destacar; a resposta é onde você LÊ, e ocupa a maior parte da tela — um fundo forte
   * atrás dela cansaria a leitura e faria a conversa inteira parecer um bloco pintado. Aqui
   * o fundo só precisa dizer "esta região é uma unidade", e para isso basta um degrau
   * quase imperceptível acima do fundo do terminal.
   */
  readonly aluyBg?: string;
  /**
   * F-PROFUNDIDADE (pedido do dono: "fazer a tela parecer um pouco mais profunda... toda
   * a área do header ser de um outro fundo... os itens abaixo do composer poderiam ficar
   * numa caixa cinza") — fundos por CAMADA.
   *
   * A ideia que organiza: profundidade em terminal não vem de linha, vem de SUPERFÍCIE.
   * Regiões de chrome (header, rodapé) recuam para um plano de fundo; a CONVERSA fica no
   * plano do terminal (sem fundo — é o conteúdo, tem de respirar); o COMPOSER avança um
   * plano (é onde a atenção está). Três níveis bastam: mais que isso vira listrado.
   *
   * Todos `undefined` fora de truecolor — cor aproximada em 16 cores vira bloco berrante.
   */
  readonly headerBg?: string;
  /** Ver `headerBg` — o plano do rodapé (status, modo, dicas). */
  readonly footerBg?: string;
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
  /**
   * F-ASCII-DE-VERDADE — força o conjunto ASCII PURO, mesmo em terminal com Unicode.
   *
   * A flag `--ascii` marcava apenas o perfil SAFE (unicode conservador), então símbolos
   * como `⏎` e `↑` continuavam saindo — justamente num modo que alguém liga porque o
   * terminal NÃO renderiza esses caracteres. Quem pede ASCII quer ASCII; o perfil
   * conservador segue disponível por `ALUY_SAFE_GLYPHS`.
   */
  readonly asciiOnly?: boolean;
  /**
   * F-NERD-GLYPHS — override do perfil NERD FONT (`ALUY_NERD_GLYPHS` / config
   * `nerdGlyphs`). `true` ⇒ usa NERD_GLYPHS mesmo sem o env (ex.: config
   * persistida). Sem efeito quando ASCII puro ou `safeGlyphs` vencem (opt-in
   * explícito, nunca sobrepõe terminal incapaz nem o perfil SEGURO).
   */
  readonly nerdGlyphs?: boolean;
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

/**
 * F-NERD-GLYPHS — decide o perfil NERD FONT. Opt-in EXPLÍCITO (MESMA disciplina
 * do `detectSafeGlyphs` acima): `ALUY_NERD_GLYPHS=1` no env, ou o override
 * (alimentado pela config `nerdGlyphs`/flag, resolvida por quem chama
 * `resolveTheme`). NÃO liga sozinho por heurística — exige fonte Nerd Font
 * PATCHEADA instalada; sem ela, os glifos da PUA viram tofu (▯). Quem decide se
 * isto REALMENTE vira o perfil ativo é `resolveTheme` (SAFE/ASCII podem vencer).
 */
export function detectNerdGlyphs(env: NodeJS.ProcessEnv, override?: boolean): boolean {
  if (override !== undefined) return override;
  return truthy(env.ALUY_NERD_GLYPHS);
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
  // F-FUNDO-DERIVADO (relato do dono, três vezes: "essa cor do background do Aluy não está
  // legal... deveria ser uma cor próxima ao background do terminal").
  //
  // As tentativas anteriores foram todas o mesmo erro: escolher um hex fixo sem saber qual
  // é o fundo do terminal do outro lado. Uma cor que fica discreta sobre preto puro destoa
  // sobre um fundo quente, e vice-versa — não existe hex que sirva para todos.
  //
  // O probe OSC 11 do boot já pergunta ao terminal qual é a cor dele (era usado só para
  // decidir claro/escuro). Reaproveitando a resposta, as superfícies passam a ser o
  // PRÓPRIO fundo do usuário deslocado alguns pontos: mesma matiz, um degrau de
  // luminosidade. Terminal que não responde cai nos hexes declarados abaixo.
  const fundoTerminal = observedTerminalBackground();
  const superficie = (passos: number): string | undefined =>
    fundoTerminal !== null ? surfaceFrom(fundoTerminal, passos) : undefined;
  const brightness = detectBrightness(env, input.theme);
  const unicode = input.asciiOnly === true ? false : detectUnicode(env);
  // SAFE só faz sentido quando há Unicode (em ASCII puro o conjunto ASCII vence).
  const safeGlyphs = unicode && detectSafeGlyphs(env, input.safeGlyphs);
  // F-NERD-GLYPHS — NERD só faz sentido com Unicode E sem SAFE já vencendo:
  // precedência ASCII (!unicode) > SAFE > NERD > normal. Quem pediu terminal
  // SEGURO (SAFE) quer cobertura garantida, não um ícone que pode faltar.
  const nerdGlyphs = unicode && !safeGlyphs && detectNerdGlyphs(env, input.nerdGlyphs);
  const density: Density =
    input.density ??
    (truthy(env.ALUY_DENSITY) && env.ALUY_DENSITY === 'compact' ? 'compact' : 'comfortable');
  const animate = input.animate ?? !truthy(env.ALUY_NO_ANIM);

  const palette = paletteFor(colorMode, brightness, input.truecolorPalette);
  // Quatro níveis (EST-0984/F-NERD-GLYPHS): ASCII puro (sem Unicode) > SAFE
  // (opt-in) > NERD (opt-in) > Unicode (default).
  const glyphs = !unicode
    ? ASCII_GLYPHS
    : safeGlyphs
      ? SAFE_GLYPHS
      : nerdGlyphs
        ? NERD_GLYPHS
        : UNICODE_GLYPHS;
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
    nerdGlyphs,
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
    // F-COMPOSER-FUNDO — só em TRUECOLOR: em 16-cores o tom exato não existe e o
    // aproximado vira um bloco berrante; em mono/NO_COLOR fundo não é opção. Ausente ⇒ o
    // <ComposerBox> desenha sem fundo (a barra da esquerda sozinha já marca o campo).
    // F-PROFUNDIDADE — três planos. O composer é o mais CLARO no tema escuro (avança),
    // o chrome é o mais ESCURO (recua), a conversa não tem fundo (plano do terminal).
    ...(colorMode === 'truecolor'
      ? brightness === 'dark'
        ? {
            composerBg: superficie(28) ?? '#35312B',
            aluyBg: superficie(18) ?? '#282D37',
            headerBg: '#1A1815',
            footerBg: '#1A1815',
          }
        : {
            composerBg: superficie(28) ?? '#FFFFFF',
            aluyBg: superficie(18) ?? '#E9ECF2',
            headerBg: '#E8E2D6',
            footerBg: '#E8E2D6',
          }
      : {}),
  };
}
