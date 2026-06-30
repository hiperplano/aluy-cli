// EST-0948 · CA-3 / spec §2.13 — roteamento de SLASH-COMMANDS.
//
// `/` no início do composer abre o menu (filtro incremental). Comandos NATIVOS
// (código) + comandos do USUÁRIO (DADO de `~/.aluy/commands/`, ADR-0053 §2.2).
// Aqui só o reconhecimento/roteamento (puro, testável); a execução de cada um é
// do wiring (run.tsx). `/model` mostra o TIER, NUNCA provider (HG-2) — a tela
// onde a tentação é maior (§2.13).

import { fuzzyScore } from '../attach/fuzzy.js';
import { displayWidth } from '../session/visual-lines.js';
import type { I18nKey, TFunction } from '../i18n/index.js';

/** Identificador de um comando nativo. */
export type NativeCommandId =
  | 'help'
  | 'login'
  | 'logout'
  | 'whoami'
  | 'doctor'
  | 'model'
  | 'provider'
  | 'effort'
  | 'theme'
  | 'lang'
  | 'rename'
  | 'history'
  | 'ask'
  | 'rooms'
  | 'subagent'
  | 'back'
  | 'clear'
  | 'compact'
  | 'cycle'
  | 'cron'
  | 'permissions'
  | 'usage'
  | 'notify'
  | 'undo'
  | 'redo'
  | 'rewind'
  | 'init'
  | 'memory'
  | 'mcp'
  | 'agents'
  | 'skills'
  | 'workflows'
  | 'telegram'
  | 'add-dir'
  | 'split'
  | 'fullscreen'
  | 'tools'
  | 'quit'
  | 'todo';

/** Seção do menu (agrupamento visual §2.15). */
export type SlashSection = 'conta' | 'sessão' | 'workspace' | 'usuário';

/**
 * EST-0974 — um SUBcomando declarado de um comando (ex.: `/mcp search`, `/mcp add`).
 * É DADO listável: o menu o achata como entrada própria descobrível (digitar `/mcp s`
 * filtra `/mcp search`) e a seleção COMPLETA `/<pai> <name> ` no composer (com o espaço
 * pra digitar o argumento), em vez de executar na hora. O ROTEAMENTO não muda — quem
 * interpreta `search`/`add`/… continua sendo o handler do pai (parseMcpSlash etc.).
 */
export interface SlashSubcommand {
  /** O verbo, sem o pai nem a barra (`search`, `add`, `list`, `remove`). */
  readonly name: string;
  /** Linha de ajuda curta exibida no menu (ao lado do `/pai name`). */
  readonly summary: string;
  /** Forma de uso (ex.: `search <termo>`) — p/ documentação/descoberta. */
  readonly usage?: string;
  /**
   * EST-0983 (#157 fix) — SUBcomando TERMINAL: é um VERBO completo, SEM argumento (ex.:
   * `/clear full`, `/clear memory`). Quando `true`, selecioná-lo no menu e dar Enter
   * SUBMETE direto (`/<pai> <sub>`), em vez de só RE-COMPLETAR `/<pai> <sub> ` e ficar
   * preso esperando um argumento que não existe. Subs que PRECISAM de argumento (ex.:
   * `/mcp search <termo>`) NÃO marcam isto ⇒ seguem completando e aguardando o termo.
   */
  readonly terminal?: boolean;
}

/** Um comando do menu (nativo ou do usuário). */
export interface SlashCommand {
  readonly name: string; // sem a barra (`help`, `quit`, `deploy`)
  /**
   * Descrição exibida no menu/palette. Para NATIVOS é o pt-BR canônico (back-compat
   * de testes/não-TTY); a TUI o LOCALIZA em runtime via `summaryKey`+`t()`
   * (`localizeCommands`). Comandos do USUÁRIO não têm `summaryKey` ⇒ o summary do
   * arquivo `.md` é usado como está (não se traduz dado do usuário).
   */
  readonly summary: string;
  /**
   * EST-0989 (i18n) — chave i18n do `summary` (só NATIVOS). Quando presente, a TUI
   * substitui o `summary` por `t(summaryKey)` no idioma ativo (fallback p/ pt-BR). A
   * ausência (comando do usuário) ⇒ mantém o `summary` literal. O registro estático
   * segue com o pt-BR no `summary` p/ quem não localiza (não-TTY linear, testes).
   */
  readonly summaryKey?: I18nKey;
  /** `native` = código; `user` = dado de ~/.aluy/commands/. */
  readonly source: 'native' | 'user';
  /** id do nativo (ausente p/ comandos do usuário). */
  readonly id?: NativeCommandId;
  /** Seção p/ o agrupamento do menu (§2.15). Comandos do usuário = `usuário`. */
  readonly section?: SlashSection;
  /**
   * EST-0974 — SUBcomandos declarados (ex.: `/mcp` → search/add/list/remove). Quando
   * presente, o menu ACHATA cada sub como entrada própria (descoberta) e manter o menu
   * aberto passa a tolerar UM espaço (digitar o nome do sub) — ver `isSlashMenuQuery`.
   */
  readonly subcommands?: readonly SlashSubcommand[];
  /**
   * EST-0982 · ADR-0080 — comando PARALELO-SEGURO mid-turn. Quando `true`, o handler de
   * Enter-OCUPADO (type-ahead / slash-menu durante um turno vivo) o EXECUTA JÁ (mesmo
   * caminho do idle) em vez de ENFILEIRAR. Vale SÓ p/ comandos read-only que rodam num
   * caller PRÓPRIO sem tocar o loop/histórico/catraca do turno principal (hoje o `/ask`:
   * pergunta paralela read-only via `controller.askParallel`). NÃO marcar comandos que
   * MUTAM estado/sessão (compact/model/clear/…): esses DEVEM continuar enfileirando —
   * rodar mid-turn quebraria o turno em curso.
   */
  readonly parallelWhileBusy?: true;
  /**
   * EST-0982 — comando DUAL-MODE (parte read-only, parte mutadora): paralelo-seguro mid-turn
   * SÓ p/ certos argumentos. Ex.: `/effort` (sem arg = LÊ o valor → seguro; `/effort high` =
   * MUTA → enfileira), `/mcp` (listagem/`search`/`reload`/`status` = leitura/efeito próprio →
   * seguro; `/mcp add|remove|disable|enable` = MUTA a config → enfileira). O predicado recebe
   * os `args` JÁ roteados e devolve `true` só quando aquela invocação NÃO toca o turno vivo.
   * Mutuamente exclusivo com `parallelWhileBusy` (que é "sempre"). Falta dos dois ⇒ enfileira.
   */
  readonly parallelWhileBusyWith?: (args: string) => boolean;
  /** Forma de uso (ex.: `<intervalo> "<tarefa>"`) — p/ auto-conhecimento e documentação. */
  readonly usage?: string;
}

/**
 * EST-0982 · ADR-0080 — o comando é PARALELO-SEGURO mid-turn? Prefere a flag de metadado
 * (`parallelWhileBusy`, explícita/extensível) com FALLBACK ao id `'ask'` (o /ask sempre é
 * paralelo por construção do ADR-0080, mesmo que a flag falte num registro reconstruído).
 */
export function isParallelWhileBusy(command: SlashCommand, args = ''): boolean {
  if (command.parallelWhileBusy === true || command.id === 'ask') return true;
  // DUAL-MODE: paralelo-seguro só quando o predicado aceita ESTES args (leitura/efeito
  // próprio); qualquer variante mutadora cai p/ a fila (devolve `false`).
  if (command.parallelWhileBusyWith) return command.parallelWhileBusyWith(args);
  return false;
}

// EST-0982 — predicados de paralelismo p/ os comandos DUAL-MODE (read-only vs mutador).
// Exportados (testáveis) e reusados nos registros dos NATIVOS abaixo.

/** `/effort` é leitura SÓ sem argumento (`/effort` ⇒ mostra o atual). `/effort <v>` MUTA. */
export function effortIsReadOnly(args: string): boolean {
  return args.trim() === '';
}

/**
 * `/mcp` é paralelo-seguro SÓ nas variantes PURAS de leitura que empurram uma nota e nada
 * mais: listagem (sem arg) e `search <termo>` (lookup no registro aberto). As demais TOCAM
 * a sessão viva e DEVEM enfileirar: `add`/`remove`/`disable`/`enable` mutam a config;
 * `reload`/`reconnect` re-handshake os servers (troca o conjunto de tools do turno EM curso).
 */
export function mcpIsReadOnly(args: string): boolean {
  const verb = args.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (verb === '') return true; // listagem pura
  // ALLOWLIST das variantes que SÓ leem/empurram nota: `list` e `search`. Tudo o mais
  // (add/remove/disable/enable mutam a config; reload/reconnect re-handshake servers) ⇒ fila.
  return verb === 'list' || verb === 'search';
}

/**
 * EST-0974 — uma ENTRADA do slash-menu: ou um comando (nativo/usuário) ou um SUBcomando
 * achatado de um comando-pai. O menu lista entradas (não só comandos) p/ os subs serem
 * DESCOBRÍVEIS no mesmo nível, filtráveis por substring (`/mcp s` ⇒ `/mcp search`).
 */
export type SlashMenuEntry =
  | { readonly kind: 'command'; readonly command: SlashCommand }
  | {
      readonly kind: 'subcommand';
      readonly parent: SlashCommand;
      readonly sub: SlashSubcommand;
    };

/** O caminho exibido/filtrado da entrada, SEM a barra (`mcp` ou `mcp search`). */
export function entryPath(entry: SlashMenuEntry): string {
  return entry.kind === 'command' ? entry.command.name : `${entry.parent.name} ${entry.sub.name}`;
}

/** A seção da entrada (o sub herda a do pai). */
export function entrySection(entry: SlashMenuEntry): SlashSection {
  const cmd = entry.kind === 'command' ? entry.command : entry.parent;
  if (cmd.source === 'user') return 'usuário';
  return cmd.section ?? 'sessão';
}

/** O summary exibido pela entrada. */
export function entrySummary(entry: SlashMenuEntry): string {
  return entry.kind === 'command' ? entry.command.summary : entry.sub.summary;
}

/**
 * EST-1015 (anti-flicker) — ALTURA (linhas) que o `<SlashMenu>` ocupa ao renderizar `entries`.
 * ESPELHA o render do componente: 1 linha de AJUDA no topo + 1 linha por ENTRADA + 1 linha de
 * CABEÇALHO a cada MUDANÇA de seção. PURO. Usada p/ DESCONTAR o menu do orçamento da fala
 * (`speechMaxLines`): o menu mora abaixo do composer e PODE coexistir com o stream (EST-0982),
 * então a soma `chrome + fala + menu` precisa caber em `rows` — senão o Ink repinta a tela toda
 * (clearTerminal) a cada frame ⇒ cintilação. `[]` ⇒ só a linha de ajuda (1).
 */
/**
 * F89 (wrap-aware) — largura VISUAL aproximada de UMA entrada do menu, espelhando o render
 * do `<SlashMenu>`: indent (2 normal / 4 sub) + `/path` + padding até ~18 + summary. Usada
 * p/ contar quantas LINHAS a entrada ocupa num terminal estreito (`ceil(w / columns)`).
 */
const SLASH_HELP_WIDTH = 56; // aprox. da linha de ajuda ("/ para comandos · ↑↓ …").
function entryVisualLines(entry: SlashMenuEntry, columns: number): number {
  const path = entryPath(entry);
  const indent = entry.kind === 'subcommand' ? 4 : 2;
  const w =
    indent +
    displayWidth(`/${path}`) +
    Math.max(1, 18 - path.length) +
    displayWidth(entrySummary(entry));
  return Math.max(1, Math.ceil(w / columns));
}

export function slashMenuVisibleLines(
  entries: readonly SlashMenuEntry[],
  columns?: number,
): number {
  // F89 — a ajuda também QUEBRA num terminal estreito; conta visual quando `columns` dado.
  let lines =
    columns !== undefined && columns > 0 ? Math.max(1, Math.ceil(SLASH_HELP_WIDTH / columns)) : 1;
  let lastSection: SlashSection | null = null;
  for (const entry of entries) {
    const section = entrySection(entry);
    if (section !== lastSection) lines += 1; // cabeçalho da seção (curto ⇒ ~1 linha).
    lastSection = section;
    // F89 — a entrada conta LINHAS VISUAIS quando `columns` dado (estreito ⇒ quebra); senão 1.
    lines += columns !== undefined && columns > 0 ? entryVisualLines(entry, columns) : 1;
  }
  return lines;
}

/** Uma JANELA do menu: o sub-conjunto visível + quantos itens ficaram fora (acima/abaixo). */
export interface SlashMenuWindow {
  readonly slice: readonly SlashMenuEntry[];
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

/**
 * EST-1015 (🔴 fix do menu-FANTASMA · CIENTE DE ALTURA) — JANELA o menu p/ caber em `maxRows`
 * linhas (centrada no `selected`, estilo `windowOf` da paleta). SEM isso, o `<SlashMenu>`
 * renderizava a lista INTEIRA; num terminal baixo ela ESTOURAVA `rows` ⇒ o Ink entrava no
 * caminho full-screen (clearTerminal), empurrando o scrollback p/ fora — e ao FECHAR o menu
 * o scrollback não voltava, deixando as linhas do menu de FANTASMA "em cima".
 *
 * **Ciente de altura** (v2): em vez de contar ITENS com uma reserva fixa (HEADERS_RESERVE=7),
 * CRESCE a janela ITEM A ITEM em torno do `selected` e MEDE a altura RENDERIZADA REAL com
 * `slashMenuVisibleLines(slice)` + os indicadores "↑ N acima"/"↓ N mais". Para ANTES de
 * exceder `maxRows`. Isso garante a INVARIANTE:
 *
 *   `slashMenuVisibleLines(slice) + (hiddenAbove>0?1:0) + (hiddenBelow>0?1:0) <= maxRows`
 *
 * …que a versão anterior VIOLAVA quando muitos cabeçalhos de seção caíam dentro da janela
 * (cada cabeçalho consome 1 linha extra não contabilizada pelo `cap` de itens).
 *
 * Garante ao menos 1 item (o selecionado). Navegação ↑↓ segue rolando por TODOS os comandos
 * (o slice re-centra no selected). Menu pequeno (cabe) ⇒ early-return mostra tudo.
 */
export function windowSlashEntries(
  entries: readonly SlashMenuEntry[],
  selected: number,
  maxRows: number,
  columns?: number,
): SlashMenuWindow {
  // Early-return: se tudo cabe em altura ⇒ mostra tudo (não regride).
  if (slashMenuVisibleLines(entries, columns) <= maxRows) {
    return { slice: entries, hiddenAbove: 0, hiddenBelow: 0 };
  }

  // Garante ao menos 1 item e clamp do selected em [0, len-1].
  const sel = Number.isFinite(selected) ? Math.max(0, Math.min(selected, entries.length - 1)) : 0;

  /** Altura RENDERIZADA do slice [s, e) + indicadores de overflow que o `<SlashMenu>` exibe. */
  const windowHeight = (s: number, e: number): number =>
    slashMenuVisibleLines(entries.slice(s, e), columns) +
    (s > 0 ? 1 : 0) + // "↑ N acima"
    (e < entries.length ? 1 : 0); // "↓ N mais"

  // Começa com 1 item (o selecionado) e CRESCE item-a-item enquanto couber.
  let start = sel;
  let end = sel + 1;

  // Expansão ALTERNADA: tenta um passo p/ cima, depois p/ baixo, repetindo.
  // Se a direção preferida não couber, tenta a outra. Para quando nenhuma cabe.
  let goUp = true;
  let grew = true;
  while (grew) {
    grew = false;
    if (goUp) {
      if (start > 0 && windowHeight(start - 1, end) <= maxRows) {
        start--;
        grew = true;
      } else if (end < entries.length && windowHeight(start, end + 1) <= maxRows) {
        end++;
        grew = true;
      }
    } else {
      if (end < entries.length && windowHeight(start, end + 1) <= maxRows) {
        end++;
        grew = true;
      } else if (start > 0 && windowHeight(start - 1, end) <= maxRows) {
        start--;
        grew = true;
      }
    }
    goUp = !goUp;
  }

  // Pós-condição: consolida — tenta sugar itens restantes de um lado que a alternância
  // possa ter deixado escapar (ex.: cabeçalho extra consumiu linhas e travou um lado).
  while (start > 0 && windowHeight(start - 1, end) <= maxRows) start--;
  while (end < entries.length && windowHeight(start, end + 1) <= maxRows) end++;

  return {
    slice: entries.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: entries.length - end,
  };
}

/**
 * EST-0974 — o TEXTO que a seleção (Tab/Enter) escreve no composer:
 *  - comando SEM subcomandos ⇒ `/<name>` (segue executável na hora, comportamento atual).
 *  - comando COM subcomandos ⇒ `/<name> ` (com espaço) p/ o menu REVELAR os subs.
 *  - subcomando ⇒ `/<pai> <name> ` (com espaço) p/ digitar o argumento.
 * O trailing space é intencional (entra no espaço de args do sub); só o comando-folha
 * NÃO leva espaço (pra Enter poder executá-lo direto, como hoje).
 */
export function entryCompletion(entry: SlashMenuEntry): string {
  if (entry.kind === 'subcommand') {
    return `/${entry.parent.name} ${entry.sub.name} `;
  }
  return entry.command.subcommands && entry.command.subcommands.length > 0
    ? `/${entry.command.name} `
    : `/${entry.command.name}`;
}

/**
 * EST-0983 (#157 fix) — a entrada é um SUBcomando TERMINAL (verbo sem argumento, ex.:
 * `/clear full`)? Nesse caso o Enter no menu deve SUBMETER `/<pai> <sub>` direto, em vez
 * de re-completar `/<pai> <sub> ` e ficar preso esperando um argumento inexistente. Para
 * comandos (não-sub) e subs que pedem argumento (`/mcp search <termo>`) ⇒ `false`.
 */
export function isTerminalSubcommand(entry: SlashMenuEntry): boolean {
  return entry.kind === 'subcommand' && entry.sub.terminal === true;
}

/**
 * EST-0983 (#157 fix) — a linha SUBMETÍVEL de um subcomando terminal (`/<pai> <sub>`, SEM
 * o trailing space). É o que entra na fila / vai p/ `routeInput` quando o usuário dá Enter
 * num sub terminal — o pai (`parseClearCommand` etc.) interpreta o verbo normalmente.
 */
export function terminalSubmitLine(entry: Extract<SlashMenuEntry, { kind: 'subcommand' }>): string {
  return `/${entry.parent.name} ${entry.sub.name}`;
}

/** Os comandos NATIVOS (spec §2.15). DADO listável, não hardcode espalhado. */
export const NATIVE_COMMANDS: readonly SlashCommand[] = [
  // EST-0989 (i18n) — os NATIVOS ganham `summaryKey`: o `summary` segue pt-BR (back-compat
  // de testes/não-TTY), e a TUI o LOCALIZA via `localizeCommands(t)` no idioma ativo.
  {
    name: 'help',
    summary: 'mostra esta lista',
    summaryKey: 'cmd.help',
    source: 'native',
    id: 'help',
    section: 'sessão',
    // EST-0982 — read-only puro (nota): roda JÁ mid-turn em vez de enfileirar.
    parallelWhileBusy: true,
  },
  {
    name: 'login',
    summary: 'entrar na conta',
    summaryKey: 'cmd.login',
    source: 'native',
    id: 'login',
    section: 'conta',
  },
  {
    name: 'logout',
    summary: 'sair da conta',
    summaryKey: 'cmd.logout',
    source: 'native',
    id: 'logout',
    section: 'conta',
  },
  {
    name: 'whoami',
    summary: 'conta, org e escopos atuais',
    summaryKey: 'cmd.whoami',
    source: 'native',
    id: 'whoami',
    section: 'conta',
    // EST-0982 — read-only puro (nota): roda JÁ mid-turn.
    parallelWhileBusy: true,
  },
  {
    // ADR-0134/0135 — conector Telegram: setup DENTRO da sessão. `status` (read-only),
    // `allow/deny <chat-id>` (allowlist no config), `logout` (apaga o token). `login` (token)
    // aponta p/ o terminal (prompt sem eco). A bridge em si segue inerte até a ativação gated.
    name: 'telegram',
    summary: 'conector Telegram · status/allow/deny/logout (setup na sessão)',
    summaryKey: 'cmd.telegram',
    source: 'native',
    id: 'telegram',
    section: 'conta',
    // status/allow/deny são leves (config/keychain local) — rodam JÁ mid-turn como nota.
    parallelWhileBusy: true,
  },
  {
    // EST-0970 — health-check read-only: credencial/broker/catálogo/MCP/perfis/config/
    // versão/memória, ✓/⚠/✗ + dica de conserto. Não conserta nada nem gasta modelo.
    name: 'doctor',
    summary: 'diagnóstico da instalação · credencial, broker, MCP, config (read-only)',
    summaryKey: 'cmd.doctor',
    source: 'native',
    id: 'doctor',
    section: 'conta',
    // EST-0982 — health-check read-only (ticks numa nota própria, fire-and-forget): roda
    // JÁ mid-turn. NB: `/doctor --deep` gasta modelo, mas num caller PRÓPRIO (não o turno).
    parallelWhileBusy: true,
  },
  {
    name: 'model',
    summary: 'trocar o tier',
    summaryKey: 'cmd.model',
    source: 'native',
    id: 'model',
    section: 'sessão',
  },
  {
    // EST-0962 · /provider — seta o NOME do provider do modo CUSTOM (par do modelo).
    // MESMA mecânica/teclas do `/model`//theme` (picker ↑↓/enter/esc; ● ativo). Sem arg ⇒
    // abre o picker (não-TTY lista); `/provider deepseek` seta direto. Só o NOME (HG-2,
    // DADO — não credencial): o broker resolve `(provider, model)` server-side.
    name: 'provider',
    summary: 'seta o provider do modelo Custom',
    summaryKey: 'cmd.provider',
    source: 'native',
    id: 'provider',
    section: 'sessão',
  },
  {
    // EST-0962 · /effort — seta o `reasoning_effort` (PASSTHROUGH: qualquer string ≤32 chars;
    // low/medium/high são comuns mas CUSTOM é aceito). SEM tier-gate: vale em qualquer tier.
    // Sem arg ⇒ mostra o valor atual; `/effort low` seta direto. É só DADO (não credencial).
    name: 'effort',
    summary: 'seta o reasoning_effort (low/medium/high/custom) · passthrough ≤32 chars',
    summaryKey: 'cmd.effort',
    source: 'native',
    id: 'effort',
    section: 'sessão',
    // EST-0982 — DUAL-MODE: `/effort` (sem arg) só LÊ o valor ⇒ roda JÁ mid-turn; `/effort <v>`
    // MUTA o reasoning_effort do turno em curso ⇒ enfileira (não muta o turno vivo).
    parallelWhileBusyWith: effortIsReadOnly,
  },
  {
    name: 'theme',
    summary: 'trocar o tema (dark/light) · auto-detecta no boot',
    summaryKey: 'cmd.theme',
    source: 'native',
    id: 'theme',
    section: 'sessão',
  },
  {
    // EST-0989 (i18n) — `/lang`: troca o idioma da TUI (pt-BR/en). MESMA mecânica/teclas
    // do `/theme` (picker ↑↓/enter/esc; ● ativo). Sem arg ⇒ abre o picker (não-TTY lista).
    name: 'lang',
    summary: 'trocar o idioma (pt-BR/en) · auto-detecta no boot',
    summaryKey: 'cmd.lang',
    source: 'native',
    id: 'lang',
    section: 'sessão',
  },
  {
    name: 'usage',
    summary: 'tokens e janela desta sessão',
    summaryKey: 'cmd.usage',
    source: 'native',
    id: 'usage',
    section: 'sessão',
    // EST-0982 — read-only puro (lê tokens/janela numa nota): roda JÁ mid-turn.
    parallelWhileBusy: true,
  },
  {
    name: 'rename',
    summary: 'dá um nome + cor de identificação à sessão · ●nome no composer',
    summaryKey: 'cmd.rename',
    source: 'native',
    id: 'rename',
    section: 'sessão',
  },
  {
    name: 'history',
    summary: 'navega e RETOMA uma sessão anterior · sem sair do aluy',
    summaryKey: 'cmd.history',
    source: 'native',
    id: 'history',
    section: 'sessão',
  },
  {
    name: 'ask',
    summary: 'pergunta PARALELA (read-only) sem parar o trabalho em curso',
    source: 'native',
    id: 'ask',
    section: 'sessão',
    // EST-0982 · ADR-0080 — read-only + caller próprio ⇒ roda JÁ mid-turn (não enfileira).
    parallelWhileBusy: true,
  },
  {
    name: 'notify',
    summary: 'liga/desliga o sino de atenção (on/off)',
    summaryKey: 'cmd.notify',
    source: 'native',
    id: 'notify',
    section: 'sessão',
  },
  {
    // EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG). Toggle (alias do Ctrl+L). `/view`
    // é alias (resolvido no routeInput). ≥100col lado-a-lado; 60–99 abas; <60 desabilita.
    name: 'split',
    summary: 'liga/desliga o painel de LOG ao lado do chat (Ctrl+L · /view)',
    source: 'native',
    id: 'split',
    section: 'sessão',
  },
  {
    // EST-1000 · ADR-0076 — MODO COCKPIT (tela cheia, alt-screen). Toggle in-session;
    // alias `/cockpit` (resolvido no routeInput). INLINE é o DEFAULT — sair volta a ele.
    name: 'fullscreen',
    summary: 'modo cockpit (tela cheia, alt-screen)',
    summaryKey: 'cmd.fullscreen',
    source: 'native',
    id: 'fullscreen',
    section: 'sessão',
  },
  {
    name: 'undo',
    summary: 'desfaz a última edição de arquivo do agente',
    summaryKey: 'cmd.undo',
    source: 'native',
    id: 'undo',
    section: 'workspace',
  },
  {
    name: 'redo',
    summary: 'refaz a última edição desfeita',
    summaryKey: 'cmd.redo',
    source: 'native',
    id: 'redo',
    section: 'workspace',
  },
  {
    name: 'rewind',
    summary: 'volta a um ponto da sessão (código e/ou conversa) · Esc Esc',
    summaryKey: 'cmd.rewind',
    source: 'native',
    id: 'rewind',
    section: 'workspace',
  },
  {
    name: 'clear',
    summary: 'limpa a sessão (contexto) · full também APAGA a memória do agente',
    summaryKey: 'cmd.clear',
    source: 'native',
    id: 'clear',
    section: 'sessão',
    // EST-0983 — subcomandos DESTRUTIVOS do /clear (parseClearCommand): `full` = sessão +
    // memória; `memory` = só a memória. Ambos APAGAM os fatos (global+projeto) e PEDEM
    // confirmação (IRREVERSÍVEL). `/clear` puro (sem sub) segue só limpando a sessão.
    subcommands: [
      {
        name: 'full',
        summary: 'limpa a sessão E APAGA a memória (global+projeto) · confirma',
        usage: 'full',
        terminal: true,
      },
      {
        name: 'memory',
        summary: 'APAGA só a memória do agente (global+projeto) · confirma',
        usage: 'memory',
        terminal: true,
      },
    ],
  },
  {
    name: 'compact',
    summary: 'compacta o contexto (resume a conversa e continua)',
    summaryKey: 'cmd.compact',
    source: 'native',
    id: 'compact',
    section: 'sessão',
  },
  {
    name: 'cycle',
    summary: 'roda uma tarefa em ciclos · com tetos duros e parada (anti-runaway)',
    summaryKey: 'cmd.cycle',
    source: 'native',
    id: 'cycle',
    section: 'sessão',
    usage: '<intervalo> "<tarefa>"',
    // EST-1158 — lifecycle do /cycle EM EXECUÇÃO, DESCOBRÍVEIS no menu (o dono pediu).
    // A forma de INICIAR é posicional (`/cycle 5m "tarefa"`); estes verbos só atuam num
    // ciclo JÁ rodando (run.tsx roteia). `/cycle ` abre o submenu; `/cycle 5m "..."`
    // (multi-token) fecha e cai no posicional (isSlashMenuQuery).
    subcommands: [
      {
        name: 'pause',
        summary: 'pausa o /cycle em execução (sem matar; Esc ainda para)',
        usage: 'pause',
        terminal: true,
      },
      { name: 'resume', summary: 'retoma um /cycle pausado', usage: 'resume', terminal: true },
      {
        name: 'edit',
        summary: 'reconfigura o /cycle ativo · vale na próxima iteração',
        usage: 'edit ["<tarefa>"] [<intervalo>] [--max-iter N]',
      },
      {
        name: 'status',
        summary: 'mostra o /cycle ativo (config corrente · pausado?)',
        usage: 'status',
        terminal: true,
      },
      {
        name: 'stop',
        summary: 'para/encerra o /cycle em execução (= Esc)',
        usage: 'stop',
        terminal: true,
      },
    ],
  },
  {
    // EST-1158 — `/cron` na sessão (espelha o CLI `aluy cron`): gerência dos jobs
    // PERSISTENTES sem sair do aluy. O dono pediu (emenda ao ADR-0132/0133).
    name: 'cron',
    summary: 'agendamento PERSISTENTE · lista/gerencia os jobs (mesmo motor do aluy cron)',
    source: 'native',
    id: 'cron',
    section: 'sessão',
    usage: 'list · add <quando> "<tarefa>" · edit/enable/disable/rm <id>',
    subcommands: [
      {
        name: 'list',
        summary: 'lista os jobs (id · on/off · schedule · tarefa)',
        usage: 'list',
        terminal: true,
      },
      {
        name: 'add',
        summary: 'agenda um job novo (cron de 5 campos)',
        usage: 'add <quando> "<tarefa>" [--yolo]',
      },
      {
        name: 'edit',
        summary: 'reconfigura um job (preserva id)',
        usage: 'edit <id> [--quando "<cron>"] [--tarefa "<txt>"] [--yolo|--no-yolo]',
      },
      { name: 'enable', summary: 'reativa um job desabilitado', usage: 'enable <id>' },
      {
        name: 'disable',
        summary: 'desabilita SEM excluir (sai do agendador)',
        usage: 'disable <id>',
      },
      { name: 'rm', summary: 'remove um job de vez', usage: 'rm <id>' },
    ],
  },
  {
    name: 'permissions',
    summary: 'painel · modo, grants e tools seguras (sempre-ask travado)',
    summaryKey: 'cmd.permissions',
    source: 'native',
    id: 'permissions',
    section: 'workspace',
  },
  {
    // F59 · /tools — inventário unificado das ferramentas do agente (8 nativas +
    // MCP por server + estado de permissão). SÓ LEITURA: não executa nada, não muda estado.
    name: 'tools',
    summary: 'inventário unificado das ferramentas · nativas, MCP, permissão (read-only)',
    summaryKey: 'cmd.tools',
    source: 'native',
    id: 'tools',
    section: 'workspace',
    // EST-0982 — read-only puro (nota): roda JÁ mid-turn.
    parallelWhileBusy: true,
  },
  {
    // EST-0982 · /add-dir — ATO DO USUÁRIO que autoriza um diretório EXTRA além da
    // raiz do workspace (multi-raiz). NÃO é tool: o agente não tem como invocar
    // (sem auto-ampliação, nem em --unsafe). Sem args, LISTA as raízes ativas.
    name: 'add-dir',
    summary: 'autoriza um diretório EXTRA p/ o agente (sessão) · sem args lista',
    summaryKey: 'cmd.addDir',
    source: 'native',
    id: 'add-dir',
    section: 'workspace',
  },
  {
    name: 'init',
    summary: 'cria um ALUY.md neste projeto',
    summaryKey: 'cmd.init',
    source: 'native',
    id: 'init',
    section: 'workspace',
  },
  {
    name: 'memory',
    summary: 'vê/edita/esquece/fixa a memória do agente (global + projeto)',
    summaryKey: 'cmd.memory',
    source: 'native',
    id: 'memory',
    section: 'workspace',
    // EST-0974 — subcomandos de /memory (parseMemoryCommand). `/memory` puro LISTA;
    // os verbos mutam (negados em Plan, ADR-0055). Achatados no menu p/ descoberta.
    subcommands: [
      { name: 'list', summary: 'lista a memória (global + projeto)', usage: 'list' },
      { name: 'forget', summary: 'remove um fato pelo id', usage: 'forget <id>' },
      { name: 'edit', summary: 'corrige o texto de um fato', usage: 'edit <id> <texto>' },
      { name: 'pin', summary: 'fixa um fato (retenção)', usage: 'pin <id>' },
      { name: 'unpin', summary: 'desfixa um fato', usage: 'unpin <id>' },
    ],
  },
  {
    // EST-1108 — /todo: backlog/TODO persistente. `/todo` puro LISTA; `done` marca
    // concluído; `clear` remove feitos. Mutações negadas em Plan (ADR-0055).
    name: 'todo',
    summary: 'vê/gerencia o backlog de tarefas anotadas (done/clear)',
    summaryKey: 'cmd.todo',
    source: 'native',
    id: 'todo',
    section: 'workspace',
    subcommands: [
      { name: 'list', summary: 'lista o backlog (pendentes + feitos)', usage: 'list' },
      { name: 'done', summary: 'marca um item como concluído', usage: 'done <id>' },
      { name: 'clear', summary: 'remove os itens já feitos', usage: 'clear', terminal: true },
    ],
  },
  {
    name: 'mcp',
    summary: 'lista/gerencia servers MCP (add/remove/disable/enable · search <termo>)',
    summaryKey: 'cmd.mcp',
    source: 'native',
    id: 'mcp',
    section: 'workspace',
    // EST-0982 — DUAL-MODE: listagem/`list`/`search` só LEEM (nota) ⇒ rodam JÁ mid-turn;
    // add/remove/disable/enable (config) e reload/reconnect (troca tools do turno) ⇒ enfileiram.
    parallelWhileBusyWith: mcpIsReadOnly,
    // EST-0974/EST-0970 — subcomandos de /mcp, TODOS in-session (parseMcpAdminSlash +
    // parseMcpSlash): o ciclo completo sem ir ao shell. Achatados no menu p/ ficarem
    // descobríveis (digitar `/mcp s` filtra); selecionar completa `/mcp <sub> `.
    subcommands: [
      { name: 'search', summary: 'busca no registro oficial aberto', usage: 'search <termo>' },
      {
        name: 'add',
        summary: 'adiciona um server local (stdio)',
        usage: 'add <nome> -- <cmd> [args...]',
      },
      { name: 'list', summary: 'lista os servers de todas as fontes', usage: 'list' },
      { name: 'remove', summary: 'remove um server gerenciado pelo aluy', usage: 'remove <nome>' },
      {
        name: 'disable',
        summary: 'desativa um server sem desinstalar',
        usage: 'disable <nome>',
      },
      { name: 'enable', summary: 'reativa um server desativado', usage: 'enable <nome>' },
      {
        name: 'reconnect',
        summary: 're-sobe + re-handshake os servers (recupera "Not connected")',
        usage: 'reconnect [all|<nome>]',
      },
      {
        name: 'reload',
        summary: 're-lê o ~/.aluy/mcp.json + reconecta (aplica edições da config)',
        usage: 'reload [all|<nome>]',
      },
    ],
  },
  {
    // EST-0977 · ADR-0061 — `/agents`: lista os perfis de sub-agente .md que o aluy
    // MAPEOU (válidos + rejeitados c/ motivo). Read-only; reusa o loader do boot.
    name: 'agents',
    summary: 'lista os agentes .md mapeados (global + projeto · válidos + rejeitados)',
    source: 'native',
    id: 'agents',
    section: 'workspace',
    // EST-0982 — read-only puro (lista perfis numa nota): roda JÁ mid-turn.
    parallelWhileBusy: true,
  },
  {
    // EST-1112 · ADR-0116 — `/skills`: lista as SKILLS (SKILL.md) que o aluy MAPEOU
    // (válidas + rejeitadas c/ motivo). Read-only; reusa os loaders confinados.
    name: 'skills',
    summary: 'lista as skills SKILL.md mapeadas (global + projeto · válidas + rejeitadas)',
    source: 'native',
    id: 'skills',
    section: 'workspace',
    // EST-0982 — read-only puro (lista skills numa nota): roda JÁ mid-turn.
    parallelWhileBusy: true,
  },
  {
    // EST-1105 · ADR-workflows — `/workflows`: lista os workflows .md que o aluy
    // MAPEOU (válidos + rejeitados c/ motivo). Read-only; reusa o formatador do core.
    name: 'workflows',
    summary: 'fluxos de atividades que coordenam o agente — lista, executa e ativa',
    summaryKey: 'cmd.workflows',
    source: 'native',
    id: 'workflows',
    section: 'workspace',
    subcommands: [
      {
        name: 'run',
        summary: 'executa as atividades do workflow em sequência',
        usage: 'run <nome>',
      },
      {
        name: 'use',
        summary: 'ativa o modo de workflow — submissões seguem o fluxo',
        usage: 'use <nome>',
      },
    ],
    // EST-0982 — read-only puro (lista workflows numa nota): roda JÁ mid-turn.
    parallelWhileBusy: true,
  },
  {
    // EST-ROOMS-3 · ADR-0081 — salas de conversa entre agentes (criar/listar/observar).
    name: 'rooms',
    summary: 'salas entre agentes — lista, cria, lê e OBSERVA AO VIVO a conversa da frota',
    source: 'native',
    id: 'rooms',
    section: 'workspace',
    subcommands: [
      { name: 'list', summary: 'lista as salas (código · msgs · atividade · quem)', usage: 'list' },
      { name: 'new', summary: 'cria uma sala e mostra o código', usage: 'new' },
      { name: 'read', summary: 'snapshot da conversa de uma sala', usage: 'read <código>' },
      {
        name: 'watch',
        summary: 'observa a conversa AO VIVO (poll até 2min)',
        usage: 'watch <código>',
      },
    ],
  },
  {
    // ADR-0126(A) — foco 1:1: abre uma sub-sessão dedicada com um perfil .md.
    name: 'subagent',
    summary: 'fala 1:1 com um sub-agente (perfil .md) numa sub-sessão focada e contínua',
    source: 'native',
    id: 'subagent',
    section: 'workspace',
  },
  {
    // ADR-0126(A) — sai do foco 1:1 e volta ao agente principal.
    name: 'back',
    summary: 'volta ao agente principal (sai do foco de /subagent)',
    source: 'native',
    id: 'back',
    section: 'workspace',
  },
  {
    name: 'quit',
    summary: 'sair do aluy',
    summaryKey: 'cmd.quit',
    source: 'native',
    id: 'quit',
    section: 'sessão',
  },
];

/**
 * EST-0989 (i18n) — LOCALIZA os comandos no idioma ATIVO: cada comando com `summaryKey`
 * tem o `summary` substituído por `t(summaryKey)` (fallback en→pt-BR no próprio `t`). Os
 * SEM `summaryKey` (comandos do usuário, ou nativos ainda não migrados — Fase 2) passam
 * intactos (o summary do `.md`/pt-BR é mantido — dado do usuário não se traduz). Os
 * subcomandos seguem em pt-BR na Fase 1 (migração Fase 2). PURA: a App chama com o `t`
 * do contexto e passa o resultado p/ `filterCommands`/`menuEntries`/palette.
 */
export function localizeCommands(
  commands: readonly SlashCommand[],
  t: TFunction,
): readonly SlashCommand[] {
  let changed = false;
  const out = commands.map((c) => {
    if (c.summaryKey === undefined) return c;
    const localized = t(c.summaryKey);
    if (localized === c.summary) return c;
    changed = true;
    return { ...c, summary: localized };
  });
  // Sem nenhuma troca (idioma pt-BR, summaries idênticos) ⇒ devolve a MESMA referência
  // (estabilidade de identidade p/ memo/igualdade no React; evita re-render à toa).
  return changed ? out : commands;
}

// ── EST-0961 — COMMAND PALETTE (Ctrl+P) ──────────────────────────────────────
// A palette é uma vista FUZZY sobre a MESMA fonte de comandos do slash-menu
// (`NATIVE_COMMANDS` + comandos do usuário) — não duplica a lista (um comando
// novo aparece nos DOIS automaticamente). Além dos slash-commands, expõe AÇÕES
// que não têm barra (ex.: "trocar modo", hoje no Tab) como itens de 1ª classe,
// para a palette ser o índice ÚNICO de tudo que dá pra fazer (inspirado no
// OpenCode). Cada item tem id/label/descrição/ação — a ação é resolvida pelo
// chamador (App), aqui só o DADO listável e a filtragem (puro, testável).

/** Identificador de uma AÇÃO não-slash exposta só na palette. */
export type PaletteActionId = 'cycle-mode';

/** Um item da palette: deriva de um slash-command OU de uma ação pura. */
export interface PaletteItem {
  /** id estável (`cmd:model`, `action:cycle-mode`) p/ key/teste. */
  readonly id: string;
  /** Rótulo curto exibido (com a `/` nos slash-commands). */
  readonly label: string;
  /** Descrição (o `summary` do comando ou a explicação da ação). */
  readonly description: string;
  /** A AÇÃO a executar quando confirmado (Enter). */
  readonly action:
    | { readonly kind: 'command'; readonly command: SlashCommand }
    | { readonly kind: 'action'; readonly actionId: PaletteActionId };
}

/** Índices (no `label`) dos caracteres que casaram a query fuzzy — p/ realçar. */
export interface PaletteHit extends PaletteItem {
  readonly score: number;
  readonly matched: readonly number[];
}

/** As AÇÕES puras (não-slash) da palette. DADO listável, não hardcode na tela. */
export const PALETTE_ACTIONS: readonly PaletteItem[] = [
  {
    id: 'action:cycle-mode',
    label: 'trocar modo',
    // EST-0959 — o nome de PRODUTO do modo `unsafe` é yolo (`--yolo`).
    description: 'cicla o modo da sessão (plan → normal → yolo) · também no Tab',
    action: { kind: 'action', actionId: 'cycle-mode' },
  },
];

/**
 * Monta os itens da palette a partir da FONTE ÚNICA: os mesmos
 * `NATIVE_COMMANDS` + comandos do usuário que o slash-menu lê, MAIS as ações
 * puras. Assim um comando novo no registro aparece no slash-menu E na palette
 * sem nenhuma duplicação de lista.
 */
export function paletteItems(
  userCommands: readonly SlashCommand[] = [],
  // EST-0989 (i18n) — natives LOCALIZADOS (idioma ativo) pela App; default pt-BR.
  natives: readonly SlashCommand[] = NATIVE_COMMANDS,
): readonly PaletteItem[] {
  const fromCommands = [...natives, ...userCommands].map<PaletteItem>((command) => ({
    id: `cmd:${command.source}:${command.name}`,
    label: `/${command.name}`,
    description: command.summary,
    action: { kind: 'command', command },
  }));
  return [...fromCommands, ...PALETTE_ACTIONS];
}

/**
 * Filtra+ordena os itens da palette pela `query` FUZZY (subsequência), casando
 * sobre o LABEL e a DESCRIÇÃO (recall alto — `tema` acha `/theme`). Query vazia
 * ⇒ todos na ordem natural (comandos antes das ações), sem highlight. Os índices
 * `matched` são SEMPRE relativos ao `label` (a descrição só pontua, não realça).
 * Puro/determinístico — espelha a mecânica do file-picker, sobre comandos.
 */
export function filterPalette(
  query: string,
  userCommands: readonly SlashCommand[] = [],
  // EST-0989 (i18n) — natives LOCALIZADOS (idioma ativo) pela App; default pt-BR.
  natives: readonly SlashCommand[] = NATIVE_COMMANDS,
): readonly PaletteHit[] {
  const items = paletteItems(userCommands, natives);
  const q = query.trim();
  if (q === '') return items.map((it) => ({ ...it, score: 0, matched: [] }));
  const hits: PaletteHit[] = [];
  for (const it of items) {
    const onLabel = fuzzyScore(q, it.label);
    const onDesc = fuzzyScore(q, it.description);
    if (!onLabel && !onDesc) continue;
    // Score = melhor das duas projeções; o realce só sai quando casou no label
    // (a descrição contribui recall/ranking, mas não tem onde realçar na lista).
    const labelScore = onLabel ? onLabel.score : -Infinity;
    // Casar no label vale MAIS que só na descrição (peso, não exclusão).
    const descScore = onDesc ? onDesc.score - 5 : -Infinity;
    const score = Math.max(labelScore, descScore);
    hits.push({ ...it, score, matched: onLabel ? onLabel.matched : [] });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label),
  );
  return hits;
}

/** Resultado de rotear uma entrada do composer. */
export type RouteResult =
  | { readonly kind: 'command'; readonly command: SlashCommand; readonly args: string }
  | { readonly kind: 'unknown-command'; readonly name: string }
  // EST-0958 — `!comando` (atalho de shell): o resto da linha é um comando rodado
  // localmente ATRÁS da catraca (mesma do `run_command`), NÃO um objetivo p/ o modelo.
  | { readonly kind: 'bang'; readonly command: string }
  | { readonly kind: 'goal'; readonly text: string }; // não é slash ⇒ é objetivo p/ o agente

/**
 * Roteia uma linha do composer. Linha começada por `!` ⇒ comando de shell (EST-0958,
 * atrás da catraca). Linha começada por `/` ⇒ comando (nativo OU do usuário, se na
 * lista). Qualquer outra ⇒ objetivo p/ o agente. Whitespace-only vira goal vazio (o
 * caller ignora). Determinístico, sem I/O.
 */
export function routeInput(line: string, userCommands: readonly SlashCommand[] = []): RouteResult {
  const trimmed = line.trim();
  // EST-0958 — `!` no INÍCIO entra em modo shell: o resto da linha (sem o `!`) é o
  // comando exato. `!` sozinho (sem comando) cai como goal vazio (o caller ignora).
  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    if (command === '') return { kind: 'goal', text: '' };
    return { kind: 'bang', command };
  }
  if (!trimmed.startsWith('/')) {
    return { kind: 'goal', text: trimmed };
  }
  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const rawName = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
  // EST-0990 — `/view` é ALIAS de `/split` (mesmo toggle do modo view avançado).
  // EST-1000 · ADR-0076 — `/cockpit` é ALIAS de `/fullscreen` (mesmo toggle do cockpit).
  const name = rawName === 'view' ? 'split' : rawName === 'cockpit' ? 'fullscreen' : rawName;
  const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();
  const all = [...NATIVE_COMMANDS, ...userCommands];
  const command = all.find((c) => c.name === name);
  if (!command) {
    return { kind: 'unknown-command', name };
  }
  return { kind: 'command', command, args };
}

/**
 * EST-0948 — o slash-MENU fica aberto enquanto se digita o NOME do comando (antes de
 * qualquer espaço). EST-0974 estende: comandos COM SUBcomandos toleram UM nível a mais
 * — o menu segue aberto enquanto se digita o NOME do subcomando (`/mcp`, `/mcp `,
 * `/mcp s`, `/mcp search`), e só FECHA quando se entra nos ARGS do sub (`/mcp search
 * github` — um 2º espaço). Comandos SEM subcomandos seguem a regra antiga intacta
 * (`/cycle ` já fecha). Determinístico, sem I/O; testável isolado.
 *
 * Regra:
 *  - não começa com `/` ⇒ false (objetivo/bang/@).
 *  - sem whitespace após `/` ⇒ true (digitando o nome do comando — `/`, `/c`, `/mcp`).
 *  - com whitespace: o 1º token é o nome do comando; se ELE tem subcomandos E o resto
 *    (após colapsar os espaços) NÃO tem mais nenhum whitespace ⇒ true (digitando o nome
 *    do sub: `/mcp `, `/mcp s`, `/mcp search`). Caso contrário ⇒ false (args).
 */
export function isSlashMenuQuery(
  line: string,
  userCommands: readonly SlashCommand[] = [],
): boolean {
  if (!line.startsWith('/')) return false;
  const q = line.slice(1);
  if (!/\s/.test(q)) return true; // ainda no nome do comando (regra antiga).
  // Há ≥1 espaço: separa o nome do comando do resto.
  const spaceIdx = q.search(/\s/);
  const name = q.slice(0, spaceIdx).toLowerCase();
  const rest = q.slice(spaceIdx).replace(/^\s+/, ''); // remove só os espaços de junção.
  const all = [...NATIVE_COMMANDS, ...userCommands];
  const command = all.find((c) => c.name === name);
  if (!command?.subcommands || command.subcommands.length === 0) return false;
  // Comando COM subs: aberto enquanto o resto for só o nome do sub (sem 2º whitespace).
  return !/\s/.test(rest);
}

/**
 * EST-0974 — ACHATA os comandos em ENTRADAS do menu: cada comando vira uma entrada e,
 * logo abaixo, cada subcomando dele vira a própria entrada (`/mcp`, `/mcp search`, …).
 * Mantém a ordem (comando antes dos seus subs) p/ o agrupamento por seção do `<SlashMenu>`
 * ficar coerente. Nativos antes dos do usuário.
 */
export function menuEntries(
  userCommands: readonly SlashCommand[] = [],
  // EST-0989 (i18n) — os NATIVOS podem vir LOCALIZADOS (`localizeCommands(NATIVE_COMMANDS,
  // t)`) p/ o menu exibir os summaries no idioma ativo. Default = `NATIVE_COMMANDS`
  // (pt-BR; back-compat com callers/testes que não localizam).
  natives: readonly SlashCommand[] = NATIVE_COMMANDS,
): readonly SlashMenuEntry[] {
  const out: SlashMenuEntry[] = [];
  for (const command of [...natives, ...userCommands]) {
    out.push({ kind: 'command', command });
    for (const sub of command.subcommands ?? []) {
      out.push({ kind: 'subcommand', parent: command, sub });
    }
  }
  return out;
}

/**
 * Filtra as ENTRADAS do menu (comandos + subcomandos achatados) por prefixo/substring
 * incremental do CAMINHO (`mcp`, `mcp search`). Case-insensitive. O que casa o início
 * do caminho vem antes (prefixo), depois o que casa por substring (recall p/ descoberta);
 * a ordem natural (comando antes dos seus subs) é o desempate. Query vazia ⇒ tudo.
 *
 * O caminho normaliza o whitespace interno (`mcp  search` casa `mcp search`), então
 * digitar `/mcp s` (query `mcp s`) filtra exatamente `/mcp search`.
 */
export function filterCommands(
  query: string,
  userCommands: readonly SlashCommand[] = [],
  // EST-0989 (i18n) — natives LOCALIZADOS (idioma ativo) passados pela App; default pt-BR.
  natives: readonly SlashCommand[] = NATIVE_COMMANDS,
): readonly SlashMenuEntry[] {
  const q = query.trim().replace(/\s+/g, ' ').toLowerCase();
  const all = menuEntries(userCommands, natives);
  if (q === '') return all;
  const pathOf = (e: SlashMenuEntry): string => entryPath(e).toLowerCase();
  const starts = all.filter((e) => pathOf(e).startsWith(q));
  const contains = all.filter((e) => !pathOf(e).startsWith(q) && pathOf(e).includes(q));
  return [...starts, ...contains];
}

// ─────────────────────────────────────────────────────────────────────────────
// EST-1149 · ADR-0127 — AUTO-CONHECIMENTO: nota dos COMANDOS DA SESSÃO p/ o system prompt
// ─────────────────────────────────────────────────────────────────────────────

/** Cabeçalho da seção de comandos da sessão no system prompt (estável p/ teste). */
export const SESSION_COMMANDS_NOTE_HEADER =
  'COMANDOS DA SESSÃO (o HUMANO os digita; você os RECOMENDA, não os invoca como ferramenta):';

/**
 * EST-1149 · ADR-0127 — monta a nota de AUTO-CONHECIMENTO dos `/comandos` da sessão, GERADA
 * do registro (`NATIVE_COMMANDS` por default) — single-source, nunca hardcoded: comando novo
 * no registro aparece sozinho no prompt. PURO. O caller (run.tsx) injeta no canal `system`.
 *
 * FRONTEIRA (a nota reforça): estes são comandos que o HUMANO digita na sessão — o agente os
 * RECOMENDA quando cabem (ex.: "agendar/repetir uma tarefa em loop" ⇒ `/cycle`), em vez de
 * dizer "não tenho como" ou sugerir ferramentas externas (cron do SO / Task Scheduler). O
 * agente NÃO os invoca como tool (não são suas tools). Sem o registro ⇒ `undefined` (não
 * injeta — não-regressão). O `summary` é o texto pt-BR do registro (consistente com o prompt).
 */
export function buildSessionCommandsNote(
  commands: readonly SlashCommand[] = NATIVE_COMMANDS,
): string | undefined {
  const lines = commands
    .filter((c) => c.summary.trim() !== '')
    .map((c) => {
      const base = `  /${c.name} — ${c.summary}`;
      return c.usage ? `${base}\n    uso: /${c.name} ${c.usage}` : base;
    });
  if (lines.length === 0) return undefined;
  return [
    SESSION_COMMANDS_NOTE_HEADER,
    'Quando o usuário pede algo que um destes comandos resolve — ex.: AGENDAR/REPETIR uma',
    'tarefa em loop recorrente ⇒ `/cycle`; checar a saúde da sessão ⇒ `/doctor`; liberar',
    'contexto ⇒ `/compact` — RECOMENDE o comando ao usuário. NÃO diga "não tenho como" nem',
    'sugira ferramentas externas (cron do SO, Windows Task Scheduler) quando existe um',
    'comando nativo que resolve. Você NÃO digita estes comandos (não são suas ferramentas);',
    'quem os digita é o usuário.',
    ...lines,
  ].join('\n');
}
