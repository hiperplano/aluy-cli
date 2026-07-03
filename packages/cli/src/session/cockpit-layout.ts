// EST-1000 · ADR-0076 §3/§5/§6 — LAYOUT FIXO de 6 regiões do cockpit (PURO, testável).
//
// A tela do cockpit é particionada em 6 regiões de altura CRAVADA cuja soma == `rows`
// (ADR-0076 §3). Esse é o invariante de layout que ELIMINA o flicker (§5): a árvore
// nunca reflui pra fora de `rows`, então o gatilho `outputHeight >= rows` do Ink (a
// causa-raiz do clear-por-frame, EST-0965) NUNCA dispara — `live-budget.ts` deixa de
// ser necessário NO COCKPIT.
//
// As 6 regiões (ADR-0076 §3):
//   header   — wordmark + sessão/tier/modo            (altura fixa)
//   conversa — turnos (região gerida, scroll próprio) (FLEX — cresce p/ encher)
//   log      — a FlowTree/ActivityLog (scroll próprio) (FLEX — divide com conversa)
//   status   — budget/teto, modo, working             (altura fixa)
//   composer — input do usuário                       (altura fixa)
//   hints    — atalhos contextuais                    (altura fixa)
//
// As 4 regiões de CHROME (header/status/composer/hints) têm altura constante; as 2
// regiões GERIDAS (conversa/log) dividem o RESTANTE de `rows` na razão `COCKPIT_LOG_RATIO`
// (~30% p/ o log, ~70% p/ a conversa — EST-1000, o log era "metade" demais), respeitando o
// piso `COCKPIT_LOG_MIN_ROWS` em telas baixas. Cada uma tem scroll PRÓPRIO (viewport.ts) —
// sem tocar o scrollback do terminal (que não existe em alt-screen).
//
// DEGRADAÇÃO (ADR-0076 §6): abaixo do PISO de colunas (`MIN_COLS=80`) ou de linhas
// (`MIN_ROWS`), o grid não cabe com legibilidade ⇒ o cockpit é RECUSADO (cai pro inline
// com aviso). Esta é a decisão (a), recomendada no ADR.

/** ADR-0076 §6 — piso de COLUNAS p/ o cockpit (abaixo disso cai pro inline). */
export const COCKPIT_MIN_COLS = 80;

/** Alturas FIXAS das 4 regiões de chrome (linhas). Somadas com as 2 geridas == rows. */
export const HEADER_ROWS = 1; // header compacto de 1 linha (o banner não cabe no grid fixo).
export const STATUS_ROWS = 1; // status bar (tier/budget/modo) — 1 linha viva.
export const COMPOSER_ROWS = 1; // input — 1 linha (PISO; cresce p/ multi-linha, ver abaixo).
export const HINTS_ROWS = 1; // atalhos contextuais — 1 linha.

/**
 * BUG P2-C — TETO de linhas do COMPOSER no cockpit. No inline o composer cresce sem teto
 * (vive no scrollback); no cockpit cada região é um <Box> de altura cravada e a soma ==
 * rows (§5), então o composer NÃO pode crescer sem limite. O composer cresce de
 * `COMPOSER_ROWS` (=1) até este teto conforme o input multi-linha (bracketed-paste/`\n`),
 * descontando as linhas extras da CONVERSA (a maior região gerida) p/ a soma seguir ==
 * rows. Acima do teto o <Composer> cuida do scroll interno (cauda visível) — mas o usuário
 * já vê várias linhas (paridade prática com o inline) em vez de ter o conteúdo SUMIDO.
 */
export const COMPOSER_MAX_ROWS = 5;

/** Linhas de SEPARADOR/régua entre regiões (bordas do DS). Contadas no chrome. */
export const SEPARATOR_ROWS = 3; // header│conversa, conversa│log, log│status (3 réguas).

/** Altura total de chrome FIXO (regiões + separadores). O resto vai p/ conversa+log. */
export const COCKPIT_CHROME_ROWS =
  HEADER_ROWS + STATUS_ROWS + COMPOSER_ROWS + HINTS_ROWS + SEPARATOR_ROWS;

/**
 * ADR-0076 §6 — piso de LINHAS: o chrome fixo + ≥1 linha útil de conversa E ≥1 de log.
 * Abaixo disso as 6 regiões não cabem ⇒ recusa. `+2` = 1 linha mínima por região gerida.
 */
export const COCKPIT_MIN_ROWS = COCKPIT_CHROME_ROWS + 2;

/**
 * EST-1000 — RAZÃO do LOG na área GERIDA (conversa+log). O Tiago achou o log "metade"
 * (largo demais); 0.30 dá ~30% p/ o log e ~70% p/ a CONVERSA (o foco primário). Constante
 * ÚNICA e clara — mexer aqui re-equilibra o cockpit inteiro. (O split vertical do cockpit
 * particiona LINHAS, não colunas; esta razão é sobre a altura da área gerida.)
 */
export const COCKPIT_LOG_RATIO = 0.3;

/**
 * EST-1000 — PISO de legibilidade do LOG: o análogo-em-LINHAS do `LOG_MIN_COLS` do split
 * lado-a-lado (#135). A 30%, em telas BAIXAS, o log encolheria a 0–1 linha e ficaria
 * ilegível; este piso garante ≥ N linhas vivas no log (1 rótulo `▼ ao vivo` + ≥2 de
 * conteúdo). Quando o piso e a razão brigam em tela pequena, o PISO vence (a conversa cede
 * o excedente). O piso nunca rouba a última linha da conversa (ela mantém ≥1) — garantido
 * porque `COCKPIT_MIN_ROWS` reserva +2 e o clamp abaixo respeita o mínimo de cada lado.
 */
export const COCKPIT_LOG_MIN_ROWS = 3;

/**
 * EST-1015 (UX redesign do cockpit) — SINAL de atividade do LOG p/ o dimensionamento
 * ADAPTATIVO (mata o espaço morto da razão fixa 70/30). Derivado do estado ESTÁVEL da
 * sessão (NÃO de tokens chegando — senão o log "respiraria" de altura a cada frame de
 * streaming, virando flicker). Ausente ⇒ o layout cai na razão fixa (back-compat).
 */
export interface LogActivityHint {
  /** Nº de linhas REAIS de atividade no log (de `flatten(sections)`). */
  readonly lines: number;
  /** Há atividade no anel (algum turno/tool com saída)? */
  readonly hasActivity: boolean;
  /** Sub-agentes VIVOS (>0 ⇒ o log expande — a ação está nele). */
  readonly activeAgents: number;
  /** O foco (tab) está no log? (focar = "quero ver o log" ⇒ expande). */
  readonly focused: boolean;
}

/** As 2 regiões geridas (com scroll próprio) e suas alturas resolvidas. */
export interface ManagedRegions {
  /** Altura (linhas) da região de CONVERSA (scroll próprio). */
  readonly conversaRows: number;
  /** Altura (linhas) da região de LOG (scroll próprio). */
  readonly logRows: number;
}

/** O layout resolvido do cockpit p/ um (rows, cols) — ou a RECUSA (degrada pro inline). */
export type CockpitLayout =
  | {
      readonly kind: 'cockpit';
      readonly rows: number;
      readonly cols: number;
      /** Alturas fixas (eco das consts — p/ o render montar os Box sem recalcular). */
      readonly headerRows: number;
      readonly statusRows: number;
      readonly composerRows: number;
      readonly hintsRows: number;
      readonly regions: ManagedRegions;
    }
  | {
      readonly kind: 'refuse';
      /** Motivo legível (a11y — a palavra carrega o sentido, não só um código). */
      readonly reason: 'narrow' | 'short';
      readonly rows: number;
      readonly cols: number;
    };

/**
 * BUG P2-C — altura desejada do COMPOSER (linhas) p/ um input de `lines` linhas visuais,
 * clampada à faixa `[COMPOSER_ROWS, COMPOSER_MAX_ROWS]`. PURO. `lines` ≤ 1 (ou ausente) ⇒
 * o piso 1 (caso comum INALTERADO). Exportada p/ o caller (App) derivar do `\n` do input.
 */
export function composerRowsForLines(lines: number): number {
  if (!Number.isFinite(lines) || lines <= COMPOSER_ROWS) return COMPOSER_ROWS;
  return Math.min(COMPOSER_MAX_ROWS, Math.floor(lines));
}

/**
 * Resolve o layout do cockpit p/ a tela `(rows, cols)`. PURO/determinístico.
 *
 *  · `cols < COCKPIT_MIN_COLS` ⇒ recusa `narrow` (ADR-0076 §6, decisão (a)).
 *  · `rows < COCKPIT_MIN_ROWS` ⇒ recusa `short` (altura mínima — §6).
 *  · senão ⇒ as 4 regiões de chrome fixas + as 2 geridas dividindo o restante. O LOG fica
 *    com `COCKPIT_LOG_RATIO` (~30%) da área gerida (a CONVERSA, foco primário, com o resto
 *    ~70%), RESPEITANDO o piso de legibilidade `COCKPIT_LOG_MIN_ROWS` em telas baixas.
 *    Soma EXATA == rows (invariante §3/§5).
 *
 * BUG P2-C — `composerLines` (opcional, default 1) faz o COMPOSER crescer p/ input
 * multi-linha (até `COMPOSER_MAX_ROWS`), descontando as linhas EXTRAS da CONVERSA (a maior
 * região gerida) — paridade com o inline. O extra nunca rouba a última linha da conversa
 * NEM do log: é clampado p/ a área gerida manter ≥2 (1 conversa + 1 log), então a soma
 * segue == rows. `composerLines` ≤ 1 ⇒ comportamento INALTERADO (composer = 1 linha).
 */
/**
 * EST-1015 (UX) — altura do LOG na área gerida. Sem `hint` ⇒ razão fixa `COCKPIT_LOG_RATIO`
 * (~30%, back-compat). Com `hint` ⇒ ADAPTATIVO em 3 modos (mata o espaço morto):
 *   · RECOLHIDO  — sem atividade E sem agentes ⇒ 1 linha (só a régua-rótulo `· ocioso`).
 *   · EXPANDIDO  — foco no log OU sub-agentes vivos ⇒ até 60% (a ação está no log).
 *   · NATURAL    — caso comum ⇒ `clamp(linhasReais, PISO, 50%)` (nunca maior que o conteúdo).
 * Sempre deixa ≥1 linha p/ a CONVERSA (`min(managed-1, …)`) ⇒ soma == rows preservada. PURO.
 */
function resolveLogRows(managedTotal: number, hint: LogActivityHint | undefined): number {
  const floor = Math.min(COCKPIT_LOG_MIN_ROWS, managedTotal - 1);
  if (hint === undefined) {
    const proportional = Math.round(managedTotal * COCKPIT_LOG_RATIO);
    return Math.min(managedTotal - 1, Math.max(floor, proportional));
  }
  // RECOLHIDO: 1 linha (sem roubar a última da conversa). NÃO aplica o piso (1 é de propósito).
  if (!hint.hasActivity && hint.activeAgents === 0) {
    return Math.min(1, managedTotal - 1);
  }
  // EXPANDIDO (foco/agentes) ⇒ até 60%; NATURAL ⇒ até 50%. Nunca maior que as linhas reais.
  const cap = Math.floor(managedTotal * (hint.focused || hint.activeAgents > 0 ? 0.6 : 0.5));
  // GUARD — `hint.lines` NaN/Infinity (contagem instável em transição) ⇒ trata como 1 (não
  // propaga NaN p/ a altura da região, que viraria `new Array(NaN)` no Ink).
  const want = Math.max(1, Number.isFinite(hint.lines) ? hint.lines : 1);
  return Math.min(managedTotal - 1, Math.max(floor, Math.min(cap, want)));
}

export function resolveCockpitLayout(
  rows: number,
  cols: number,
  composerLines = COMPOSER_ROWS,
  logHint?: LogActivityHint,
): CockpitLayout {
  // GUARD DURO (crash `RangeError: Invalid array length` no Ink, achado do dono) — dimensões
  // INVÁLIDAS (NaN, Infinity, ≤0, fracionárias) vindas de `stdout.rows/columns` em transições
  // (resume + cockpit + resize) ESCAPAVAM dos checks `< MIN` abaixo, porque `NaN < x === false`
  // ⇒ a função seguia com `rows=NaN` e devolvia alturas de região NaN/negativas ⇒ o Ink fazia
  // `new Array(height)` no `Output.get` ⇒ CRASH que MATA o processo (e o Ctrl-C junto). Aqui
  // normalizamos p/ inteiros e, se não formam uma tela válida, RECUSAMOS (cai pro inline
  // seguro) — NUNCA propagamos dimensão inválida adiante. PURO/determinístico.
  const safeRows = Number.isFinite(rows) ? Math.floor(rows) : 0;
  const safeCols = Number.isFinite(cols) ? Math.floor(cols) : 0;
  rows = safeRows;
  cols = safeCols;
  if (cols < COCKPIT_MIN_COLS) {
    return { kind: 'refuse', reason: 'narrow', rows, cols };
  }
  if (rows < COCKPIT_MIN_ROWS) {
    return { kind: 'refuse', reason: 'short', rows, cols };
  }
  // O composer cresce p/ multi-linha, mas as linhas EXTRAS (acima de 1) só podem sair da
  // área gerida — e essa precisa manter ≥2 (1 conversa + 1 log). Clampamos o extra a esse
  // teto; o resto do input rola DENTRO do composer (cauda visível). Caso comum (1 linha):
  // `extra=0` ⇒ partição idêntica à de antes.
  const baseManaged = rows - COCKPIT_CHROME_ROWS; // com composer=1 (piso garantido por MIN_ROWS).
  const wantExtra = composerRowsForLines(composerLines) - COMPOSER_ROWS;
  const extra = Math.max(0, Math.min(wantExtra, baseManaged - 2));
  const composerRows = COMPOSER_ROWS + extra;
  const managedTotal = baseManaged - extra;
  // LOG = ~30% da área gerida (arredondado), mas:
  //  · nunca abaixo do PISO de legibilidade (clamp inferior) — exceto se o piso não couber
  //    (área gerida minúscula), aí cede p/ deixar ≥1 linha pra conversa;
  //  · nunca toma TUDO: a conversa (foco) mantém ≥1 linha (clamp superior).
  // O clamp final garante a soma EXATA == rows mesmo quando piso e razão brigam.
  const logRows = resolveLogRows(managedTotal, logHint);
  const conversaRows = managedTotal - logRows;
  return {
    kind: 'cockpit',
    rows,
    cols,
    headerRows: HEADER_ROWS,
    statusRows: STATUS_ROWS,
    composerRows,
    hintsRows: HINTS_ROWS,
    regions: { conversaRows, logRows },
  };
}

/**
 * Soma das alturas de TODAS as regiões + separadores. DEVE ser exatamente `rows` (o
 * invariante de layout §3/§5). Exportada p/ o teste provar a soma == rows. Só faz
 * sentido p/ um layout `cockpit` (a recusa não tem regiões).
 */
export function cockpitRegionSum(layout: Extract<CockpitLayout, { kind: 'cockpit' }>): number {
  return (
    layout.headerRows +
    layout.statusRows +
    layout.composerRows +
    layout.hintsRows +
    SEPARATOR_ROWS +
    layout.regions.conversaRows +
    layout.regions.logRows
  );
}
