// EST-0948 · spec-tui §3.3 — tabela de GLIFOS com fallback ASCII.
// EST-0984 — endurecimento dos glifos "sujos" no Terminator + opt-in SAFE.
//
// Todos são Unicode comum (NÃO nerd-font). Há fallback ASCII p/ TERM=linux /
// locale não-UTF-8. Invariante de a11y (§3.3): glifo NUNCA carrega significado
// sozinho — sempre acompanha a palavra (`⚠ ask`, `✗ negado`, `✓ <contagem>`).
// Aqui só resolvemos o GLIFO; o componente é quem cola a palavra ao lado.
//
// EST-0984 · COBERTURA DE FONTE — três níveis, do mais rico ao mais seguro:
//   1. UNICODE_GLYPHS  (default Unicode)  — só caracteres de COBERTURA AMPLA
//      (presentes em DejaVu Sans Mono e fontes mono comuns). Os "fancy" de
//      largura ambígua / emoji-ish foram trocados (ver TROCAS EST-0984 abaixo).
//   2. SAFE_GLYPHS     (opt-in `ALUY_SAFE_GLYPHS=1` / `--ascii`-soft)  — só
//      geométricos de cobertura QUASE universal (círculo branco/cheio, quadrado
//      vazado), p/ terminais teimosos com fonte limitada mas ainda UTF-8.
//   3. ASCII_GLYPHS    (TERM=linux / locale não-UTF-8 / `ALUY_ASCII`)  — só
//      ASCII puro (7-bit), sempre legível.

/** Nomes de glifo (papel visual), resolvidos p/ Unicode ou ASCII. */
export type GlyphName =
  | 'you' // ▌ papel "você"
  | 'aluy' // Λ marca do Aluy (Λ do logo; pisca/“desenha” ao pensar) 〔EST-0984〕
  | 'tool' // ⏺ tool call concluída
  | 'toolInflight' // ○ tool em execução (anel; vira ⏺ ao concluir) 〔EST-0948/0984〕
  | 'wave' // ~ onda "vau" (trabalho/pensando, anima) 〔EST-0948/0984〕
  | 'waveHead' // › cabeça da onda (o brilho que corre) 〔EST-0948〕
  | 'ask' // ⚠ ask / atenção
  | 'ok' // ✓ sucesso
  | 'err' // ✗ erro / deny
  | 'broker' // ● broker 〔EST-0948/0984〕
  | 'clock' // ◷ tier (EST-0989) / tokens / tempo (e fallback estático do braille)
  | 'gauge' // ◔ medidor de consumo (sessão/quota) 〔EST-0989〕
  | 'window' // □ janela de contexto 〔EST-0948/0984〕
  | 'branch' // ⎇ branch git
  | 'diffDel' // ‹ remoção no diff (direção) 〔EST-0948〕
  | 'diffAdd' // › adição no diff (direção) 〔EST-0948〕
  | 'prompt' // › prompt
  | 'cursor' // ● cursor do composer — GROSSO/arredondado (mesma grossura do thinkingCursor), branco/fg 〔EST-0965〕
  | 'thinkingCursor' // ● cursor de TRABALHO (pensando/streaming): grosso, arredondado, AMARELO 〔EST-0965〕
  | 'planMode' // ◑ modo Plan (read-only) 〔EST-0959〕
  | 'normalMode' // ◇ modo normal (catraca) 〔EST-0959〕
  | 'subagents' // + indicador de sub-agentes paralelos 〔EST-0969/0984〕
  | 'sessionDot' // ● identificação colorida da sessão (/rename) 〔EST-0972〕
  | 'barFull' // ▰ célula PREENCHIDA da barra de progresso determinada 〔EST-0973〕
  | 'barEmpty'; // ▱ célula VAZIA da barra de progresso determinada 〔EST-0973〕

/**
 * Marca do Aluy — o Λ do logo (U+039B GREEK CAPITAL LETTER LAMBDA), 1 célula,
 * largura estável. Fallback ASCII `/\` (2 células — as duas "pernas" do Λ). É o
 * MESMO desenho do DS (`AluyGlyph`/`AluyLoader`): duas pernas que se encontram no
 * topo, SEM base. O <AluyLoader> da TUI compõe esta marca + a animação (“desenha
 * + respira”), espelhando o feel do loader web. Largura constante entre frames
 * (anti-jitter EST-0956): nada de aparecer/sumir célula.
 */
export const ALUY_MARK_UNICODE = 'Λ';
export const ALUY_MARK_ASCII = '/\\';

/**
 * Glifos Unicode (spec §3.3) — DEFAULT de COBERTURA AMPLA (EST-0984).
 *
 * TROCAS EST-0984 (glifos "sujos" → cobertura ampla, mantendo a estética):
 *   - `aluy`         ◇ → Λ   (a MARCA real do Aluy, não um losango genérico)
 *   - `wave`         ～ → ~   (FF5E fullwidth, largura ambígua → til ASCII, narrow)
 *   - `toolInflight` ◌ → ○   (25CC dotted circle, tofu comum → 25CB white circle)
 *   - `window`       ⛁ → □   (26C1, emoji-ish/sem cobertura → 25A1 white square)
 *   - `subagents`    ⊕ → +   (2295, cobertura irregular → ASCII `+`, inequívoco)
 *   - `broker`       ◍ → ●   (25CD dotted-half, raro → 25CF black circle, comum)
 * `normalMode` segue ◇ (catraca) — coerente com o losango “neutro” do modo; a
 * MARCA do Aluy migrou p/ Λ (não se confunde mais com o indicador de modo).
 */
export const UNICODE_GLYPHS: Readonly<Record<GlyphName, string>> = {
  you: '▌',
  aluy: ALUY_MARK_UNICODE,
  tool: '⏺',
  toolInflight: '○',
  wave: '~',
  waveHead: '›',
  ask: '⚠',
  ok: '✓',
  err: '✗',
  broker: '●',
  clock: '◷',
  // EST-0989 — medidor de consumo (sessão/quota). ◔ (25D4 white circle w/ upper-right
  // quadrant): "gauge/pie" de cobertura ampla em mono, distinto do ◷ (clock) do tier.
  gauge: '◔',
  window: '□',
  branch: '⎇',
  diffDel: '‹',
  diffAdd: '›',
  prompt: '›',
  // EST-0965 — o cursor do COMPOSER agora é ● (25CF black circle): GROSSO/ARREDONDADO,
  // a MESMA grossura visual do thinkingCursor (o Tiago: "a grossura do amarelo e do
  // branco devem ser as mesmas, grossinho"). A COR é que diferencia os papéis: o
  // composer é pintado em `fg` (BRANCO) pelo Composer.tsx; o thinkingCursor em `accent`
  // (AMARELO) pelo TurnBlock. Nunca os dois ao mesmo tempo (App suprime o composer
  // enquanto trabalha — #127 intacto). ● tem cobertura UNIVERSAL em mono.
  cursor: '●',
  // EST-0965 — o cursor de TRABALHO (pensando/streaming): ● (25CF black circle),
  // GROSSO e ARREDONDADO, pintado em AMARELO (papel `accent` do DS) pelo TurnBlock.
  // Lê como "o agente está trabalhando" — distinto pela COR (amarelo) do ● branco do
  // composer. ● tem cobertura UNIVERSAL em mono (mesmo glifo de `broker`/`sessionDot`).
  thinkingCursor: '●',
  planMode: '◑',
  normalMode: '◇',
  subagents: '+',
  sessionDot: '●', // 25CF black circle — universal, é o ● da identificação da sessão
  // EST-0973 — barra de progresso DETERMINADA. ▰ (25B0)/▱ (25B1) "black/white
  // parallelogram": cobertura ampla em mono, célula estável (anti-jitter EST-0956),
  // e o contraste cheio/vazado lê o avanço SEM depender de cor (a11y §6).
  barFull: '▰',
  barEmpty: '▱',
};

/**
 * Perfil SEGURO (opt-in `ALUY_SAFE_GLYPHS=1` / `--ascii`-soft) — EST-0984.
 *
 * Para terminais UTF-8 mas com FONTE LIMITADA (ex.: Terminator com bitmap font
 * teimosa) onde até alguns geométricos do default viram tofu. Mantém só os de
 * cobertura QUASE universal e troca os de risco residual por equivalentes ainda
 * mais seguros (sem virar ASCII cru — preserva o ar geométrico):
 *   - `aluy` segue Λ (a marca; lambda grego tem cobertura ampla em mono)
 *   - `tool`/`ok`/`err`/`ask`/`clock`/`branch` → geométricos/setas seguros
 *   - box-drawing fica com o conjunto Unicode (╭╮… têm cobertura ampla); só os
 *     glifos de PAPEL são endurecidos aqui.
 */
export const SAFE_GLYPHS: Readonly<Record<GlyphName, string>> = {
  you: '▌',
  aluy: ALUY_MARK_UNICODE,
  tool: '●', // ⏺ (23FA) tem cobertura fraca; ● (25CF) é universal
  toolInflight: '○',
  wave: '~',
  waveHead: '>',
  ask: '!',
  ok: '√', // ✓ (2713) pode faltar; √ (221A) e o `[ok]` ASCII cobrem o resto
  err: 'x',
  broker: '●',
  clock: 'o',
  gauge: '◔', // 25D4: cobertura ampla; mantém o medidor distinto do clock no perfil seguro
  window: '□',
  branch: 'Y', // ⎇ (2387) raro; Y evoca o “fork” sem tofu
  diffDel: '<',
  diffAdd: '>',
  prompt: '>',
  cursor: '●', // EST-0965: ● grosso/arredondado (mesma grossura do thinkingCursor); 25CF universal
  thinkingCursor: '●', // 25CF: cobertura universal mesmo em fonte limitada (grosso/arredondado)
  planMode: '◑', // meio-círculo: cobertura ampla
  normalMode: '◇',
  subagents: '+',
  sessionDot: '●', // 25CF: cobertura universal mesmo em fonte limitada
  // EST-0973 — no perfil SEGURO os parallelogramas ▰/▱ podem virar tofu em fonte
  // limitada; cai p/ os blocos cheio/sombra (█/░), de cobertura quase universal.
  barFull: '█',
  barEmpty: '░',
};

/** Fallback ASCII (spec §3.3, coluna "Fallback ASCII"). */
export const ASCII_GLYPHS: Readonly<Record<GlyphName, string>> = {
  you: '>',
  aluy: ALUY_MARK_ASCII,
  tool: 'o',
  toolInflight: '.',
  wave: '~',
  waveHead: '>',
  ask: '!',
  ok: '[ok]',
  err: '[x]',
  broker: '(b)',
  clock: 't:',
  gauge: '%:', // ASCII puro: rótulo de medidor (sessão/quota colam a palavra ao lado)
  window: 'ctx:',
  branch: 'git:',
  diffDel: '-',
  diffAdd: '+',
  prompt: '>',
  cursor: '*', // EST-0965: asterisco "grosso" — MESMO fallback do thinkingCursor (degradam igual)
  thinkingCursor: '*', // ASCII: asterisco "grosso" como cursor de trabalho (a cor degrada)
  planMode: '[plan]',
  normalMode: '*',
  subagents: '(+)',
  sessionDot: '*', // ASCII: asterisco como pista de identificação (a cor degrada)
  // EST-0973 — ASCII puro: a barra vira `[###...]` (cheio `#`, vazio `.`), o estilo
  // universal de progresso em terminal 7-bit. O componente cola os colchetes.
  barFull: '#',
  barEmpty: '.',
};

/**
 * Frames do SPINNER braille (spec §3.6) — 10 frames. Fallback ASCII de 4 frames
 * (`- \ | /`). O componente lê `frames[frame % frames.length]`. Mantidos aqui
 * (tabela única) p/ não espalhar literais. NÃO carregam significado (a11y §6: é só
 * atividade; o verbo vivo ao lado carrega o sentido).
 *
 * EST-0984: braille (U+28xx) tem cobertura irregular em fontes limitadas — o
 * perfil SEGURO usa os mesmos frames ASCII do TERM=linux (resolvido em theme.ts).
 */
export const BRAILLE_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const ASCII_SPINNER_FRAMES: readonly string[] = ['-', '\\', '|', '/'];

/** Bordas de box arredondadas (Unicode) e fallback ASCII (spec §3.4). */
export interface BoxChars {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeLeft: string;
  readonly teeRight: string;
}

export const UNICODE_BOX: BoxChars = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
};

export const ASCII_BOX: BoxChars = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  teeLeft: '+',
  teeRight: '+',
};
