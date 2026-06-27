// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — HOOKS DE CICLO-DE-VIDA (config PURA).
//
// Um HOOK roda um COMANDO em um EVENTO do ciclo de vida da sessão (ao iniciar a
// sessão, antes/depois de uma tool, ao terminar o turno). A config mora em
// `~/.aluy/hooks.json` (config do dono). Aqui só os TIPOS + o PARSER puro do JSON;
// a EXECUÇÃO (atrás da catraca, via shell-port) é o `HookRunner` (hook-runner.ts), o
// disparo nos eventos é do locus concreto (@aluy/cli).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CRÍTICO DE SEGURANÇA (o `seguranca` GATEIA — hook = EXECUÇÃO DE CÓDIGO):     ║
// ║  • Um hook EXECUTA um comando ⇒ é EFEITO ⇒ passa pela MESMA catraca           ║
// ║    (`decide()`/CLI-SEC-H1) que o `run_command` do agente. NÃO é um caminho    ║
// ║    de shell paralelo que escape a catraca. Isso é o `HookRunner`.            ║
// ║  • Plan mode NEGA hooks de efeito (Plan ⇒ DENY p/ run_command, por           ║
// ║    construção — o HookRunner usa o MESMO tool-call `run_command`).            ║
// ║  • `~/.aluy/hooks.json` é WRITE-DENY pela catraca (editar config de hook =    ║
// ║    ato do USUÁRIO, não do agente) — senão um README malicioso faria o agente  ║
// ║    plantar um hook que roda sempre. (Trava em permission/categories.ts.)      ║
// ║  • A SAÍDA de um hook, se realimentada, é DADO_NÃO_CONFIÁVEL (CLI-SEC-4).     ║
// ║  • Hook herda o MODO/confinamento da sessão — nunca roda com privilégio acima.║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): parser de JSON/string PURO (sem `node:*`, sem I/O).

/**
 * Os EVENTOS de ciclo-de-vida em que um hook pode disparar. Conjunto FECHADO
 * (allow-list de nomes) — um evento desconhecido na config é IGNORADO (não vira
 * um hook que nunca/sempre dispara silenciosamente).
 *   • `session-start`      — ao iniciar a sessão (boot). (Claude: SessionStart)
 *   • `user-prompt-submit` — ANTES de mandar o prompt do usuário ao modelo.
 *                            (Claude: UserPromptSubmit) — EST-0980.
 *   • `pre-tool`           — ANTES de uma tool do agente. OBSERVA por default;
 *                            com `gate: true` pode VETAR a tool (Claude: PreToolUse,
 *                            exit≠0 bloqueia) — composto MONOTONICAMENTE com a
 *                            catraca (só REFORÇA o deny, nunca relaxa). EST-0980.
 *   • `post-tool`          — DEPOIS de uma tool do agente executar. (Claude: PostToolUse)
 *   • `turn-end`           — ao terminar um turno (o agente parou). (Claude: Stop)
 *   • `subagent-stop`      — ao terminar um SUB-agente. (Claude: SubagentStop) — EST-0980.
 *   • `notification`       — em uma NOTIFICAÇÃO da sessão (ex.: precisa de atenção).
 *                            (Claude: Notification) — EST-0980.
 */
export type HookEvent =
  | 'session-start'
  | 'user-prompt-submit'
  | 'pre-tool'
  | 'post-tool'
  | 'turn-end'
  | 'subagent-stop'
  | 'notification';

/** Conjunto FECHADO de eventos reconhecidos (allow-list). */
export const HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'session-start',
  'user-prompt-submit',
  'pre-tool',
  'post-tool',
  'turn-end',
  'subagent-stop',
  'notification',
]);

/**
 * EST-0980 — MAPEAMENTO do nome de evento no estilo Claude Code (`settings.json`)
 * para o evento do Aluy. Conjunto FECHADO — um nome fora do mapa é IGNORADO no
 * parser de settings (fail-closed: nunca vira um hook "meio-válido"). É a única
 * tradução; NÃO há segundo motor de hooks (o disparo/execução é o mesmo da EST-0974).
 */
export const CLAUDE_EVENT_MAP: Readonly<Record<string, HookEvent>> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt-submit',
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  Stop: 'turn-end',
  SubagentStop: 'subagent-stop',
  Notification: 'notification',
};

/** Um hook já PARSEADO: o evento, o comando a rodar, e um matcher opcional. */
export interface Hook {
  /** O evento que dispara o hook. */
  readonly event: HookEvent;
  /** O comando de shell a rodar (passa pela catraca como `run_command`). */
  readonly command: string;
  /**
   * Matcher OPCIONAL p/ `pre-tool`/`post-tool`: o NOME da tool a casar (ex.:
   * `edit_file`). Ausente ⇒ casa qualquer tool. Ignorado p/ eventos sem tool
   * (`session-start`/`turn-end`). String literal (não regex) — match exato.
   */
  readonly matcher?: string;
  /**
   * EST-0980 — GATING: SÓ tem efeito em `pre-tool`. Quando `true`, este hook pode
   * VETAR a tool do agente: se o comando do hook RODA e termina com exit≠0 (igual
   * ao `exit 2` do PreToolUse do Claude Code), a tool é BLOQUEADA. É composto
   * MONOTONICAMENTE com a catraca: a tool só roda se `decide()==allow` E nenhum
   * hook de gate vetou (AND lógico). O hook NUNCA pode RELAXAR a catraca — só
   * SOMAR um veto (CLI-SEC-3/H1 intactos). Ausente/`false` ⇒ observa, não veta.
   */
  readonly gate?: boolean;
}

/** A config de hooks já validada: uma lista chata de `Hook`. */
export interface HooksConfig {
  readonly hooks: readonly Hook[];
}

/** Config vazia (sem hooks) — o default seguro quando não há `hooks.json`. */
export const EMPTY_HOOKS_CONFIG: HooksConfig = { hooks: [] };

function isEvent(v: unknown): v is HookEvent {
  return typeof v === 'string' && HOOK_EVENTS.has(v as HookEvent);
}

/**
 * Parseia um objeto de config (já `JSON.parse`-ado) num `HooksConfig` VALIDADO.
 * Forma aceita (tolerante, fail-closed): `{ "hooks": [ { event, command, matcher? } ] }`.
 * Entradas inválidas (sem `command` string, evento fora da allow-list) são
 * DESCARTADAS silenciosamente — nunca lançam, nunca viram um hook "meio-válido"
 * que dispara onde não devia. Não-objeto / sem `hooks` array ⇒ config vazia.
 *
 * IMPORTANTE: este parser NÃO executa nada — só estrutura o DADO. A execução
 * (atrás da catraca) é do `HookRunner`. PURO/determinístico.
 */
export function parseHooksConfig(value: unknown): HooksConfig {
  if (typeof value !== 'object' || value === null) return EMPTY_HOOKS_CONFIG;
  const raw = (value as { hooks?: unknown }).hooks;
  if (!Array.isArray(raw)) return EMPTY_HOOKS_CONFIG;
  const hooks: Hook[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { event?: unknown; command?: unknown; matcher?: unknown };
    if (!isEvent(e.event)) continue;
    if (typeof e.command !== 'string' || e.command.trim() === '') continue;
    hooks.push(buildHook(e.event, e.command, e.matcher, (e as { gate?: unknown }).gate));
  }
  return { hooks };
}

/**
 * Monta um `Hook` validado, anexando `matcher`/`gate` SÓ quando fazem sentido. O
 * `gate` só é honrado em `pre-tool` (gating de tool); em qualquer outro evento é
 * DESCARTADO (um `gate:true` em `turn-end` não tem o que vetar). PURO.
 */
function buildHook(event: HookEvent, command: string, matcher: unknown, gate: unknown): Hook {
  let hook: Hook = { event, command };
  if (typeof matcher === 'string' && matcher !== '') hook = { ...hook, matcher };
  if (gate === true && event === 'pre-tool') hook = { ...hook, gate: true };
  return hook;
}

/**
 * Seleciona os hooks que casam um EVENTO (e, p/ pre/post-tool, opcionalmente o
 * nome da tool). Um hook com `matcher` SÓ casa quando o `toolName` é igual; um hook
 * sem `matcher` casa qualquer tool do evento. Eventos sem tool ignoram `toolName`.
 * PURO — a ordem é a da config (determinística).
 */
export function selectHooks(
  config: HooksConfig,
  event: HookEvent,
  toolName?: string,
): readonly Hook[] {
  return config.hooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.matcher === undefined) return true;
    return toolName !== undefined && h.matcher === toolName;
  });
}

/**
 * EST-0980 — seleciona SÓ os hooks de `pre-tool` marcados `gate: true` que casam o
 * `toolName` (os que podem VETAR a tool). Sub-conjunto de `selectHooks('pre-tool')`.
 * PURO. O chamador (loop) os roda ANTES da tool e BLOQUEIA se algum vetar.
 */
export function selectGateHooks(config: HooksConfig, toolName?: string): readonly Hook[] {
  return selectHooks(config, 'pre-tool', toolName).filter((h) => h.gate === true);
}

/**
 * EST-0980 — PARSER do formato de hooks no estilo `settings.json` do Claude Code,
 * mapeando-o para o `HooksConfig` do Aluy (a MESMA estrutura da EST-0974). NÃO há
 * segundo motor: isto só TRADUZ o DADO declarativo do Claude para o nosso modelo;
 * a execução (atrás da catraca) é a mesma do `HookRunner`.
 *
 * Forma aceita (tolerante, fail-closed) — espelha o Claude Code:
 *   { "hooks": {
 *       "PreToolUse":  [ { "matcher": "Edit", "hooks": [ { "type": "command", "command": "..." } ] } ],
 *       "SessionStart":[ { "hooks": [ { "type": "command", "command": "..." } ] } ]
 *   } }
 *
 * Regras (fail-closed): nome de evento fora de `CLAUDE_EVENT_MAP` ⇒ DESCARTA o grupo
 * inteiro; entrada de hook sem `type:"command"` (ou `command` não-string/vazio) ⇒
 * DESCARTA aquele hook. `matcher` do grupo (string literal) propaga p/ cada comando.
 *
 * SEGURANÇA (CLI-SEC-3): um hook de `PreToolUse` do Claude que "bloqueia" (exit≠0)
 * é mapeado p/ um hook do Aluy com `gate: true` — ele só pode REFORÇAR a negação,
 * NUNCA executar fora da catraca nem aprovar nada. Não existe campo de settings que
 * faça um hook RODAR fora da `decide()`. PURO/determinístico, sem I/O.
 */
export function parseClaudeHooksSettings(value: unknown): HooksConfig {
  if (typeof value !== 'object' || value === null) return EMPTY_HOOKS_CONFIG;
  const raw = (value as { hooks?: unknown }).hooks;
  if (typeof raw !== 'object' || raw === null) return EMPTY_HOOKS_CONFIG;
  const hooks: Hook[] = [];
  for (const [claudeEvent, groups] of Object.entries(raw as Record<string, unknown>)) {
    const event = CLAUDE_EVENT_MAP[claudeEvent];
    if (event === undefined) continue; // evento fora da allow-list ⇒ descarta o grupo.
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue;
      const g = group as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof g.matcher === 'string' && g.matcher !== '' ? g.matcher : undefined;
      if (!Array.isArray(g.hooks)) continue;
      for (const entry of g.hooks) {
        if (typeof entry !== 'object' || entry === null) continue;
        const h = entry as { type?: unknown; command?: unknown };
        if (h.type !== 'command') continue; // só `command` é suportado (sem efeito fora da catraca).
        if (typeof h.command !== 'string' || h.command.trim() === '') continue;
        // Um PreToolUse do Claude bloqueia via exit≠0 ⇒ marca como gate (só reforça a catraca).
        hooks.push(buildHook(event, h.command, matcher, event === 'pre-tool'));
      }
    }
  }
  return { hooks };
}

/** EST-0980 — funde N configs em ordem de PRECEDÊNCIA (todas valem; ordem preservada). */
export function mergeHooksConfigs(...configs: readonly HooksConfig[]): HooksConfig {
  return { hooks: configs.flatMap((c) => c.hooks) };
}
