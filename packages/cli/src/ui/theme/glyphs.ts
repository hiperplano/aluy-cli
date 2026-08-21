// EST-0948 · spec-tui §3.3 — tabela de GLIFOS com fallback ASCII.
// EST-0984 — endurecimento dos glifos "sujos" no Terminator + opt-in SAFE.
// F-NERD-GLYPHS — perfil opt-in Nerd Font (pedido do dono: "fontes mais robustas
// tipo do opencode"). Um app de terminal NÃO escolhe a FONTE — isso é do
// emulador (aqui, WezTerm); o que dá pra pedir é o CONJUNTO DE GLIFOS. Sem a
// fonte Nerd Font PATCHEADA instalada, um glifo da Private Use Area vira
// caixinha vazia (tofu ▯) — por isso o perfil é 100% opt-in, ver NERD_GLYPHS.
// F-GLYPH-PESO — reprioridade do dono ("o peso e preenchimento [do opencode] é
// melhor" que os ícones): perfil NORMAL (UNICODE_GLYPHS) ganhou MASSA VISUAL
// onde dava p/ trocar sem risco. `gauge` (◔→◉) foi a 1ª rodada, SEM tocar
// teste alheio.
// F-GLYPH-PESO-2 — o dono viu a amostra de 6 molduras e escolheu a **B** (borda
// EXTERNA grossa `┏┓┗┛━┃`, separador INTERNO leve `─` com junção `┠┨`) — e
// autorizou EXPLICITAMENTE atualizar as asserções que pinam os glifos/bordas
// literais, DESDE QUE na mesma janela da troca (nada de teste vermelho órfão).
// Esta rodada destrava as candidatas que a F-GLYPH-PESO tinha deixado de fora:
// `ok`/`err` (✓✗→✔✘), `window` (□→■), `barFull`/`barEmpty` (▰▱→█░, a de MAIOR
// impacto — medidor contínuo em vez de contas soltas), `normalMode` (◇→◆),
// `clock` (◷→◕), e o `BoxChars` do tema (moldura esquema B, com o campo NOVO
// `innerHorizontal` p/ o separador leve — ver abaixo). As asserções pinadas
// foram todas ATUALIZADAS (nunca afrouxadas) na mesma janela — inclusive fora
// do mapeamento original do dono (`question-dialog.test.tsx`, `glyphs-nerd.
// test.ts`), achadas rodando a suíte cheia. `<CodeBlock>`/`<TableBlock>` são a
// ÚNICA exceção deliberada: são CONTEÚDO (código/tabela dentro da fala), não
// CHROME/diálogo — ficam no box LEVE de sempre via `LIGHT_UNICODE_BOX` (abaixo),
// desacoplados do `theme.box` (que agora é a moldura PESADA). SAFE_GLYPHS e
// ASCII_GLYPHS ficam INTOCADOS (terminal limitado continua como está);
// NERD_GLYPHS foi SINCRONIZADO nas chaves que mudaram (ver doc lá embaixo).
//
// Fora do perfil NERD_GLYPHS, todos os demais são Unicode comum (NÃO
// nerd-font). Há fallback ASCII p/ TERM=linux / locale não-UTF-8. Invariante de
// a11y (§3.3): glifo NUNCA carrega significado sozinho — sempre acompanha a
// palavra (`⚠ ask`, `✗ negado`, `✓ <contagem>`). Aqui só resolvemos o GLIFO; o
// componente é quem cola a palavra ao lado.
//
// EST-0984/F-NERD-GLYPHS · COBERTURA DE FONTE — QUATRO perfis. A ordem abaixo é
// a de RESOLUÇÃO (quem vence quando mais de um está pedido ao mesmo tempo),
// da mais SEGURA p/ a mais EXIGENTE — pedir Nerd num terminal incapaz (TERM=
// linux) NUNCA entrega Nerd (ver `resolveTheme` em theme.ts):
//   1. ASCII_GLYPHS    (TERM=linux / locale não-UTF-8 / `ALUY_ASCII`)  — só
//      ASCII puro (7-bit), sempre legível. VENCE TUDO.
//   2. SAFE_GLYPHS     (opt-in `ALUY_SAFE_GLYPHS=1` / `--ascii`-soft)  — só
//      geométricos de cobertura QUASE universal (círculo branco/cheio, quadrado
//      vazado), p/ terminais teimosos com fonte limitada mas ainda UTF-8. Vence
//      sobre NERD: quem pediu terminal SEGURO quer cobertura garantida, não um
//      ícone que pode faltar.
//   3. NERD_GLYPHS     (opt-in `ALUY_NERD_GLYPHS=1` / config `nerdGlyphs`) —
//      troca só as chaves onde um ícone/separador Nerd Font agrega DE VERDADE
//      (ver doc de NERD_GLYPHS abaixo); o resto segue UNICODE_GLYPHS. EXIGE
//      fonte patcheada — NUNCA default.
//   4. UNICODE_GLYPHS  (default Unicode)  — só caracteres de COBERTURA AMPLA
//      (presentes em DejaVu Sans Mono e fontes mono comuns). Os "fancy" de
//      largura ambígua / emoji-ish foram trocados (ver TROCAS EST-0984 abaixo).

/** Nomes de glifo (papel visual), resolvidos p/ Unicode ou ASCII. */
export type GlyphName =
  | 'you' // ▌ papel "você"
  | 'aluy' // Λ marca do Aluy (Λ do logo; pisca/“desenha” ao pensar) 〔EST-0984〕
  | 'tool' // ⏺ tool call concluída
  | 'toolInflight' // ○ tool em execução (anel; vira ⏺ ao concluir) 〔EST-0948/0984〕
  | 'wave' // ~ onda "vau" (trabalho/pensando, anima) 〔EST-0948/0984〕
  | 'waveHead' // › cabeça da onda (o brilho que corre) 〔EST-0948〕
  | 'ask' // ⚠ ask / atenção
  | 'ok' // ✔ sucesso 〔F-GLYPH-PESO-2: ✓→✔, check GROSSO〕
  | 'err' // ✘ erro / deny 〔F-GLYPH-PESO-2: ✗→✘, X GROSSO — casa com o `ok`〕
  | 'broker' // ● broker 〔EST-0948/0984〕
  | 'clock' // ◕ tier (EST-0989) / tokens / tempo (e fallback estático do braille) 〔F-GLYPH-PESO-2: ◷→◕〕
  | 'gauge' // ◉ medidor de consumo (sessão/quota) 〔EST-0989/F-GLYPH-PESO〕
  | 'window' // ■ janela de contexto 〔EST-0948/0984; F-GLYPH-PESO-2: □→■ PREENCHIDO〕
  | 'branch' // ⎇ branch git
  | 'diffDel' // ‹ remoção no diff (direção) 〔EST-0948〕
  | 'diffAdd' // › adição no diff (direção) 〔EST-0948〕
  | 'prompt' // › prompt
  | 'cursor' // ● cursor do composer — GROSSO/arredondado (mesma grossura do thinkingCursor), branco/fg 〔EST-0965〕
  | 'thinkingCursor' // ● cursor de TRABALHO (pensando/streaming): grosso, arredondado, AMARELO 〔EST-0965〕
  | 'planMode' // ◑ modo Plan (read-only) 〔EST-0959〕
  | 'normalMode' // ◆ modo normal (catraca) 〔EST-0959; F-GLYPH-PESO-2: ◇→◆ PREENCHIDO〕
  | 'subagents' // + indicador de sub-agentes paralelos 〔EST-0969/0984〕
  | 'sessionDot' // ● identificação colorida da sessão (/rename) 〔EST-0972〕
  | 'barFull' // █ célula PREENCHIDA da barra de progresso determinada 〔EST-0973; F-GLYPH-PESO-2: ▰→█ — medidor CONTÍNUO, maior impacto visual〕
  | 'barEmpty' // ░ célula VAZIA da barra de progresso determinada 〔EST-0973; F-GLYPH-PESO-2: ▱→░〕
  | 'pulseBlock' // █ bloco GROSSO do pulso "trabalhando" na StatusBar (enche/esvazia) 〔F195〕
  | 'sidecar'; // ◈ chip de USO dos sidecars (headroom/ollama/mem0) na StatusBar 〔F-SIDECAR-USO〕

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
 *
 * TROCAS F-GLYPH-PESO-2 (dono escolheu a moldura B na amostra + pediu MAIS peso/
 * preenchimento, referência opencode — autorizou destravar os pins de teste):
 *   - `ok`         ✓ → ✔   (2714 HEAVY CHECK MARK — check GROSSO)
 *   - `err`        ✗ → ✘   (2718 HEAVY BALLOT X — X GROSSO, casa com o `ok`)
 *   - `window`     □ → ■   (25A0 BLACK SQUARE — vazado→PREENCHIDO)
 *   - `barFull`    ▰ → █   (2588 FULL BLOCK — a de MAIOR impacto: medidor
 *     CONTÍNUO em vez de "contas soltas", mesmo glifo já usado em `pulseBlock`)
 *   - `barEmpty`   ▱ → ░   (2591 LIGHT SHADE — acompanha o `barFull` cheio)
 *   - `normalMode` ◇ → ◆   (25C6 BLACK DIAMOND — vazado→PREENCHIDO)
 *   - `clock`      ◷ → ◕   (25D5 CIRCLE ¾ BLACK — mais massa que o quadrante fino)
 * Todos os 7 são código-ponto ÚNICO, mesma largura 1 célula (ver o teste de
 * `displayWidth` em `tests/ui/glyphs-weight-2.test.ts`) — nenhum é wide/ambíguo.
 * `ask`/`branch`/`prompt`/`gauge`/`broker`/`tool`/`you`/`aluy`/`cursor` NÃO mudam
 * aqui (fora do escopo que o dono pediu). SAFE_GLYPHS/ASCII_GLYPHS INTOCADOS —
 * quem está em terminal limitado continua exatamente como estava.
 */
export const UNICODE_GLYPHS: Readonly<Record<GlyphName, string>> = {
  you: '▌',
  aluy: ALUY_MARK_UNICODE,
  tool: '⏺',
  toolInflight: '○',
  wave: '~',
  waveHead: '›',
  ask: '⚠',
  ok: '✔',
  err: '✘',
  broker: '●',
  clock: '◕',
  // F-GLYPH-PESO (pedido do dono: "o peso e preenchimento [do opencode] é melhor") —
  // ◔ (25D4, quadrante vazado) tinha POUCA massa visual perto de vizinhos cheios como
  // ● (broker/cursor) e ⏺ (tool). ◉ (25C9 FISHEYE — anel com o centro PREENCHIDO) dá
  // o mesmo papel de "medidor" com peso real, mesmo bloco Geometric Shapes já usado
  // por ●/◑/□ acima (cobertura idêntica — não é um char novo de risco). EST-0989.
  gauge: '◉',
  window: '■',
  branch: '⎇',
  diffDel: '‹',
  diffAdd: '›',
  // F-PROMPT (pedido do dono: "ao invés de › o composer deveria ter outro ícone") —
  // `❯` é o chevron pesado que virou convenção de prompt em terminal (starship,
  // powerlevel, oh-my-zsh). Tem MASSA (o `›` é um sinal de aspas, fino e apagado), é
  // largura 1 e vive no mesmo bloco Unicode dos outros glifos já em uso.
  prompt: '\u276F',
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
  // F-GLYPH-PESO-2 — ◇ (25C7 vazado) → ◆ (25C6 BLACK DIAMOND, PREENCHIDO): mesmo
  // papel (catraca do modo normal), mais massa visual — coerente com o `window`/
  // `barFull` abaixo (vazado→cheio é o fio condutor desta rodada de peso).
  normalMode: '◆',
  subagents: '+',
  sessionDot: '●', // 25CF black circle — universal, é o ● da identificação da sessão
  // EST-0973 — barra de progresso DETERMINADA. F-GLYPH-PESO-2: ▰/▱ (25B0/25B1
  // "parallelogram") → █/░ (2588 FULL BLOCK / 2591 LIGHT SHADE) — a troca de MAIOR
  // impacto visual da rodada: em vez de "contas soltas" (parallelogramas discretos),
  // um medidor CONTÍNUO (mesmo bloco cheio já usado em `pulseBlock`), com o vazio
  // em sombra leve (não mais um parallelogram oco) — cobertura idêntica em mono,
  // contraste cheio/vazado ainda lê o avanço SEM depender de cor (a11y §6).
  barFull: '█',
  barEmpty: '░',
  // F195 — o pulso "trabalhando" da StatusBar: bloco GROSSO (o "cursor grosso" que o
  // dono pediu). █ (2588 full block) tem cobertura UNIVERSAL em mono e é o glifo mais
  // "grosso"/cheio — uma barra dele enchendo/esvaziando lê como trabalho VIVO em curso.
  pulseBlock: '█',
  // F-SIDECAR-USO — chip dos sidecars. ◈ (25C8, white diamond containing black small
  // diamond): geométrico de cobertura ampla em mono, e DISTINTO dos vizinhos da barra
  // (◆ normalMode, ● broker, ◉ gauge, ◕ clock) — o olho não confunde os campos.
  sidecar: '◈',
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
  pulseBlock: '█', // F195 — no perfil seguro o bloco cheio segue █ (cobertura universal)
  // F-SIDECAR-USO — ◈ pode faltar em fonte limitada; ◆ (25C6 black diamond) é
  // universal e mantém o "ar geométrico" do campo.
  sidecar: '◆',
};

/**
 * Perfil NERD FONT (opt-in `ALUY_NERD_GLYPHS=1` / config `nerdGlyphs`) —
 * F-NERD-GLYPHS. Pedido do dono: "fontes mais robustas tipo do opencode" — mas
 * um app de terminal não escolhe FONTE (isso é do emulador, aqui WezTerm); o
 * que dá pra pedir é um CONJUNTO DE GLIFOS mais definido. Troca SÓ onde um
 * ícone/separador Nerd Font agrega DE VERDADE sobre o geométrico Unicode — as
 * chaves sem ganho claro mantêm o MESMO glifo de `UNICODE_GLYPHS` (não troca
 * por trocar):
 *   - `ask`    ⚠ → nf-fa-exclamation_triangle (U+F071) — triângulo de alerta desenhado
 *   - `ok`     ✓ → nf-fa-check                (U+F00C) — check de ícone, não de fonte
 *   - `err`    ✗ → nf-fa-times                (U+F00D) — X de ícone, casa com o `ok`
 *   - `clock`  ◷ → nf-fa-clock_o               (U+F017) — relógio desenhado
 *   - `branch` ⎇ → nf-pl-branch                (U+E0A0) — o ícone de git branch
 *                  mais reconhecido de qualquer prompt Powerline/Starship/opencode
 *   - `prompt` › → nf-pl-right_soft_divider    (U+E0B1) — o chevron separador que
 *                  dá a "cara" de prompt moderno (opencode/starship/oh-my-posh)
 * `aluy` (Λ, a MARCA do Aluy) não tem equivalente Nerd Font — não troca a
 * identidade visual por um ícone genérico. Os demais (bullets/barras/box) já são
 * geométricos de cobertura universal; um ícone Nerd ali não agregaria, só
 * arriscaria tofu à toa.
 *
 * Todos os seis vêm da Private Use Area (PUA) — SEM a fonte Nerd Font patcheada
 * instalada no emulador, cada um renderiza como caixinha vazia (tofu ▯). É por
 * isso que o resto do repo optou por NÃO depender disso (ver cabeçalho do
 * arquivo); a mesma cautela vale aqui — perfil 100% opt-in, jamais default, e
 * `SAFE_GLYPHS` (fonte limitada mas sem Nerd) VENCE quando os dois são pedidos
 * ao mesmo tempo (resolução em `theme.ts`: ASCII > SAFE > NERD > normal).
 *
 * Escritos como `\uXXXX` (não o char cru): fora de um terminal com a Nerd Font
 * instalada, o char cru mostra tofu até no editor/diff — o escape mantém o
 * código legível e o codepoint auditável independente da fonte de quem olha.
 */
export const NERD_GLYPHS: Readonly<Record<GlyphName, string>> = {
  you: '▌',
  aluy: ALUY_MARK_UNICODE, // Λ é a MARCA do Aluy — sem equivalente Nerd Font; não troca
  tool: '⏺',
  toolInflight: '○',
  wave: '~',
  waveHead: '›',
  ask: '\uF071', // nf-fa-exclamation_triangle — alerta desenhado (vs ⚠ genérico)
  ok: '\uF00C', // nf-fa-check
  err: '\uF00D', // nf-fa-times — casa com o `ok` acima
  broker: '●',
  clock: '\uF017', // nf-fa-clock_o
  gauge: '◉', // F-GLYPH-PESO — não é troca Nerd; segue o normal (mesmo glifo, ver UNICODE_GLYPHS)
  window: '■', // F-GLYPH-PESO-2 — não é troca Nerd; SINCRONIZADO com o normal (□→■)
  branch: '\uE0A0', // nf-pl-branch (Powerline VCS branch) — o ícone canônico de git branch
  diffDel: '‹',
  diffAdd: '›',
  prompt: '\uE0B1', // nf-pl-right_soft_divider — chevron powerline do prompt
  cursor: '●',
  thinkingCursor: '●',
  planMode: '◑',
  normalMode: '◆', // F-GLYPH-PESO-2 — não é troca Nerd; SINCRONIZADO com o normal (◇→◆)
  subagents: '+',
  sessionDot: '●',
  barFull: '█', // F-GLYPH-PESO-2 — não é troca Nerd; SINCRONIZADO com o normal (▰→█)
  barEmpty: '░', // F-GLYPH-PESO-2 — não é troca Nerd; SINCRONIZADO com o normal (▱→░)
  pulseBlock: '█',
  sidecar: '◈',
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
  pulseBlock: '#', // F195 — ASCII puro: `#` é o bloco "grosso" do pulso (a cor carrega o vivo)
  // F-SIDECAR-USO — ASCII puro: RÓTULO, no mesmo estilo de `ctx:`/`git:`/`t:`. Em 7-bit
  // a cor pode não existir (NO_COLOR/16 cores), então a palavra tem de bastar (a11y §6).
  sidecar: 'sc:',
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

/**
 * Bordas de box (spec §3.4) — F-GLYPH-PESO-2: moldura ESQUEMA B (o dono viu 6
 * variações e escolheu esta): borda EXTERNA GROSSA (`┏┓┗┛━┃`) + separador
 * INTERNO leve (`innerHorizontal`, `─`) com junção grossa→leve nos tês
 * (`┠┨` — U+2520/2528, vertical PESADA + horizontal LEVE): dá HIERARQUIA — a
 * borda que emoldura pesa mais que a linha que só separa seções por dentro.
 *
 *   ┏━━━ ⚠ ask ━━━━━━━━━━━━━━━━┓
 *   ┃ executar este comando?    ┃
 *   ┠───────────────────────────┨   ← innerHorizontal (leve), NÃO horizontal
 *   ┃ [a] aprovar [s] sempre    ┃
 *   ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * `innerHorizontal` é um campo NOVO: antes o mesmo `horizontal` servia pra
 * borda E pro divisor interno — sem um campo à parte não dá pra ter borda
 * grossa com miolo leve (a troca que É o ponto da escolha do dono). ASCII
 * puro não tem peso de traço (é tudo `-`) ⇒ `innerHorizontal` = `horizontal`
 * lá — a hierarquia visual, em ASCII, some (limite honesto do charset).
 */
export interface BoxChars {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeLeft: string;
  readonly teeRight: string;
  /**
   * F-GLYPH-PESO-2 — separador horizontal INTERNO (leve), distinto da borda
   * EXTERNA (`horizontal`, agora grossa). Usado SÓ nas linhas de junção
   * `teeLeft`/`teeRight` (ex.: o separador antes das ações do `<AskDialog>`/
   * `<QuestionDialog>`) — nunca no topo/base da moldura (esses seguem `horizontal`).
   */
  readonly innerHorizontal: string;
}

export const UNICODE_BOX: BoxChars = {
  topLeft: '┏',
  topRight: '┓',
  bottomLeft: '┗',
  bottomRight: '┛',
  horizontal: '━',
  vertical: '┃',
  // U+2520/2528 — vertical PESADA + horizontal LEVE saindo pro lado: a junção
  // grossa→leve que faz o separador interno ler como MENOS peso que a borda.
  teeLeft: '┠',
  teeRight: '┨',
  innerHorizontal: '─',
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
  // ASCII puro não distingue peso de traço — mesmo `-` da borda (sem hierarquia
  // visual possível em 7-bit; §3.4 já aceita essa degradação).
  innerHorizontal: '-',
};

/**
 * F-GLYPH-PESO-2 — box LEVE preservado à parte p/ CONTEÚDO (`<CodeBlock>`/
 * `<TableBlock>`), que NÃO usam `theme.box` (essa virou a moldura PESADA do
 * esquema B, para diálogo/chrome — ask, pergunta, gates, divisórias). Um
 * bloco de código ou uma tabela dentro da FALA do agente é conteúdo, não
 * alerta/decisão — a moldura grossa ali competiria com o texto (e quebraria
 * o snapshot pinado de `render.test.tsx`/`table-render.test.tsx`, que NÃO
 * está no escopo desta troca). É o MESMO desenho que `UNICODE_BOX` tinha
 * antes desta rodada — preservado por nome, não regride.
 */
export const LIGHT_UNICODE_BOX: BoxChars = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
  innerHorizontal: '─',
};
