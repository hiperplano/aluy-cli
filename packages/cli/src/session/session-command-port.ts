// ADR-0147 — o EXECUTOR concreto da tool `session_command`: a `SessionCommandPort`
// (contrato definido em `@hiperplano/aluy-cli-core`, `agent/tools/session-command.ts`)
// que este arquivo IMPLEMENTA, ligando ao registro (`slash/commands.ts`
// `NATIVE_COMMANDS`/`resolveAgentEffect`) e ao MESMO executor que o caminho do
// HUMANO usa (`slash/handlers.ts` `buildSlashEffect`, `slash/clear.ts`
// `runClearCommand`, `slash/memory.ts` `runMemoryCommand`, `slash/todo.ts`
// `runTodoCommand`, `slash/init.ts` `runInit`, `commands/cron.ts` `runCron`,
// `session/rename.ts` `routeRename`, os métodos do `SessionController`).
//
// ROTEAMENTO POR CLASSE (ADR-0147 §2/§3 — a peça de segurança desta estória):
//   - `read-only`/`session-effect` ⇒ EXECUTA direto (a catraca externa já deu `allow`
//     — ver `permission/engine.ts`); o efeito PRÓPRIO de cada comando (ex.: os
//     `run_command` dentro de um `/cycle`) segue passando por `decide()` normal.
//   - `destructive` ⇒ RE-PASSA `decide()` com um `ToolCall` SINTÉTICO
//     (`SESSION_COMMAND_DESTRUCTIVE_CALL_NAME`) — a engine o força p/
//     `ask`/`always-ask:destructive`, SEMPRE (nem `--yolo` relaxa). Só executa a
//     ação real se `askResolver.resolve()` aprovar; deny/timeout ⇒ fail-closed.
//   - `human-only`/não-classificado ⇒ tratados no CALLER (a tool nem chega a
//     invocar `run()` p/ human-only — ver `sessionCommandTool`); aqui só
//     `read-only`/`session-effect`/`destructive` chegam à execução real.
//
// Comando desconhecido/não-nativo (ex.: um `~/.aluy/commands/*.md` do usuário) ⇒
// fail-closed (ADR-0147 §5: comandos do usuário são objetivos submetidos, fora
// desta tool — EST-0974).

import { basename } from 'node:path';
import {
  decide,
  SESSION_COMMAND_DESTRUCTIVE_CALL_NAME,
  buildAgentsNote,
  buildWorkflowsNote,
  buildSkillsNote,
  type AgentRegistry,
  type AgentMemory,
  type AskResolver,
  type LoginService,
  type PermissionEngine,
  type SessionCommandOutcome,
  type SessionCommandPort,
  type ToolPorts,
  type ToolRunContext,
} from '@hiperplano/aluy-cli-core';
import {
  NATIVE_COMMANDS,
  resolveAgentEffect,
  type SlashCommand,
} from '../slash/commands.js';
import type { WorkspacePort } from '../io/index.js';
import { buildSlashEffect, runAsyncSlash, type SlashContext, type SlashNote } from '../slash/handlers.js';
import { parseClearCommand, runClearCommand } from '../slash/clear.js';
import { parseMemoryCommand, runMemoryCommand } from '../slash/memory.js';
import { parseTodoCommand, runTodoCommand } from '../slash/todo.js';
import { runInit } from '../slash/init.js';
import { routeRename } from './rename.js';
import { runCron } from '../commands/cron.js';
import { UserSkillsLoader, ProjectSkillsLoader, UserWorkflowsLoader, ProjectWorkflowsLoader } from '../io/index.js';
import type { SessionController } from './controller.js';

/**
 * As dependências que o locus concreto (`SessionController`, ver
 * `session/controller.ts`) já tem em mãos e injeta aqui — MESMO padrão de
 * `capabilitiesPort`/`subAgents` (o core define o CONTRATO puro; aqui entra o dado/
 * mecânica concreta). `memory`/`workspace`/`login` são OPCIONAIS: ausentes, os
 * comandos que dependem deles degradam com uma observação HONESTA (nunca fingem
 * sucesso) — fail-safe, como qualquer outra porta opcional do core.
 */
export interface SessionCommandPortDeps {
  readonly controller: SessionController;
  readonly engine: PermissionEngine;
  readonly askResolver: AskResolver;
  readonly ports: ToolPorts;
  readonly memory?: AgentMemory;
  readonly workspace?: WorkspacePort;
  readonly login?: LoginService;
  readonly agentRegistry?: AgentRegistry;
}

// ── helpers de texto ──────────────────────────────────────────────────────────

function noteText(note: SlashNote): string {
  return note.lines.length > 0 ? `${note.title}:\n${note.lines.join('\n')}` : note.title;
}

function unavailable(what: string): SessionCommandOutcome {
  return {
    ok: false,
    text: `"/${what}" via agente indisponível nesta sessão (dependência não injetada) — recomende ao usuário rodar "/${what}" diretamente.`,
  };
}

function slashCtx(deps: SessionCommandPortDeps): SlashContext {
  // `unsafe` é só um AVISO cosmético no /permissions — leitura best-effort duck-typed
  // (a engine injetada é sempre a `PolicyPermissionEngine` concreta em produção; o
  // seam `PermissionEngine` do core não expõe `isUnsafe`). Ausente ⇒ `undefined`
  // (mesmo default do resto do produto quando o wiring não injeta o campo).
  const maybeUnsafe = (deps.engine as { readonly isUnsafe?: boolean }).isUnsafe;
  return {
    usage: deps.controller.usage,
    ...(maybeUnsafe === true ? { unsafe: true } : {}),
  };
}

/** Fallback GENÉRICO: reusa o texto honesto que `buildSlashEffect` já escreve p/
 * comandos sem roteamento pleno (ex.: não-TTY) — aqui, "sem execução total via
 * agente ainda". NUNCA finge um efeito que não ocorreu. */
function fromSlashEffectFallback(id: NonNullable<SlashCommand['id']>, deps: SessionCommandPortDeps): SessionCommandOutcome {
  const effect = buildSlashEffect(id, slashCtx(deps));
  if (effect.kind === 'note') return { ok: true, text: noteText(effect.note) };
  // Os outros `kind` (clear/quit/notify/theme/lang/provider/async) só aparecem p/ ids
  // que este arquivo trata ESPECIFICAMENTE acima (ou que são `human-only`, negados
  // antes de chegar aqui) — nunca deveriam cair neste `default`. Defensivo/fail-safe.
  return { ok: false, text: `"/${id}" via agente ainda não tem execução completa nesta versão.` };
}

/** Junta os blocos NOVOS empurrados na sessão (ex.: via `pushNote`) durante `fn()`
 * numa observação textual — usada p/ comandos cujo efeito é "empurrar uma nota"
 * (compact/cycle-lifecycle/rooms/ask/workflows) em vez de devolver um valor. */
async function captureBlocks(
  controller: SessionController,
  fn: () => void | Promise<void>,
): Promise<string> {
  const before = controller.current.blocks.length;
  await fn();
  const added = controller.current.blocks.slice(before);
  if (added.length === 0) return '(sem saída nova — ver o estado da sessão)';
  return added
    .map((b) => {
      if (b.kind === 'note') return b.lines.length > 0 ? `${b.title}:\n${b.lines.join('\n')}` : b.title;
      if (b.kind === 'doctor') {
        return `doctor: ${b.summary ?? b.checks.map((c) => `${c.label}=${c.status}`).join(', ')}`;
      }
      return `[bloco "${b.kind}" atualizado]`;
    })
    .join('\n\n');
}

// ── gate destrutivo (ADR-0147 §3 — RE-PASSA decide()) ─────────────────────────

/**
 * RE-PASSA `decide()` com o `ToolCall` SINTÉTICO que a engine (`permission/engine.ts`)
 * força p/ `ask`/`always-ask:destructive` — NUNCA auto-aprovável, nem sob `--yolo`
 * (ADR-0147, decisão do dono). Só devolve `true` se o USUÁRIO aprovar via o MESMO
 * `AskResolver` de qualquer outro efeito. `command`/`args` viajam no input SINTÉTICO
 * só p/ o `describeEffect` da engine formatar o efeito exato; `exact` é o texto do
 * ESCOPO REAL (ex.: "apaga 12 fatos — IRREVERSÍVEL") que ESTE arquivo já apurou.
 */
async function confirmDestructive(
  command: string,
  args: string,
  exact: string,
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<boolean> {
  const call = {
    name: SESSION_COMMAND_DESTRUCTIVE_CALL_NAME,
    input: { command, args, exact },
  };
  const verdict = decide(deps.engine, call);
  if (verdict.decision !== 'ask' || !verdict.effect) return false; // fail-closed defensivo
  const alwaysAsk = (verdict.category ?? '').startsWith('always-ask:');
  const resolution = await deps.askResolver.resolve(
    {
      call,
      effect: verdict.effect,
      category: verdict.category ?? 'always-ask:destructive',
      reason: verdict.reason,
      alwaysAsk,
    },
    ctx?.signal,
  );
  return resolution.kind !== 'deny';
}

function destructiveDenied(): SessionCommandOutcome {
  return {
    ok: false,
    text: 'comando destrutivo NEGADO ou sem confirmação do usuário — nada foi executado (fail-closed, CLI-SEC-3).',
  };
}

// ── comandos DESTRUTIVOS (cada um com seu escopo exato) ────────────────────────

async function runDestructiveClear(
  kind: 'full' | 'memory',
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  if (!deps.memory) return unavailable(`clear ${kind}`);
  const memory = deps.memory;
  const total = (await memory.list()).length;
  const clearSession = (): void => deps.controller.clear();
  if (total === 0) {
    // Nada a apagar ⇒ não há confirmação a pedir (mesma regra do caminho humano,
    // `slash/clear.ts`).
    const outcome = await runClearCommand({ kind }, { clearSession, memory }, false);
    return { ok: true, text: noteText(outcome.note) };
  }
  const exact =
    kind === 'full'
      ? `limpa a sessão E apaga a memória do agente: ${total} fato(s) (global+projeto) — IRREVERSÍVEL`
      : `apaga a memória do agente: ${total} fato(s) (global+projeto) — IRREVERSÍVEL`;
  const approved = await confirmDestructive('clear', kind, exact, deps, ctx);
  if (!approved) return destructiveDenied();
  const outcome = await runClearCommand({ kind }, { clearSession, memory }, true);
  return { ok: true, text: noteText(outcome.note) };
}

async function runDestructiveMemoryForget(
  id: string,
  args: string,
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  if (!deps.memory) return unavailable('memory forget');
  const exact = `remove o fato de memória "${id}" — IRREVERSÍVEL`;
  const approved = await confirmDestructive('memory', args, exact, deps, ctx);
  if (!approved) return destructiveDenied();
  const note = await runMemoryCommand({ kind: 'forget', id }, deps.memory, false);
  return { ok: true, text: noteText(note) };
}

async function runDestructiveCronRm(
  args: string,
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  const id = args.trim().split(/\s+/)[1] ?? '';
  if (id === '') return { ok: false, text: 'uso: cron rm <id> — id ausente.' };
  const exact = `remove o job de cron "${id}" de vez — IRREVERSÍVEL`;
  const approved = await confirmDestructive('cron', args, exact, deps, ctx);
  if (!approved) return destructiveDenied();
  const collected: string[] = [];
  const io = { out: (l: string): number => collected.push(l), err: (l: string): number => collected.push(l) };
  await runCron(['rm', id], { io });
  return { ok: true, text: collected.length > 0 ? collected.join('\n') : '(sem saída)' };
}

async function runDestructiveLogout(
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  const exact = 'revoga a sessão no servidor e apaga a credencial do keychain — IRREVERSÍVEL';
  const approved = await confirmDestructive('logout', '', exact, deps, ctx);
  if (!approved) return destructiveDenied();
  if (!deps.login) {
    return {
      ok: false,
      text: 'confirmado, mas a revogação via agente ainda não está disponível nesta sessão — rode /logout você mesmo.',
    };
  }
  const note = await runAsyncSlash('logout', deps.login);
  return { ok: true, text: noteText(note) };
}

async function runDestructiveRewind(
  args: string,
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  const exact =
    'reverte a sessão a um ponto anterior (código e/ou conversa) — perde as edições/mensagens posteriores';
  const approved = await confirmDestructive('rewind', args, exact, deps, ctx);
  if (!approved) return destructiveDenied();
  return {
    ok: false,
    text: 'confirmado, mas o /rewind via agente ainda não está implementado nesta versão (precisa do seletor de checkpoints interativo) — rode Esc Esc você mesmo.',
  };
}

async function runDestructiveGeneric(
  found: SlashCommand,
  args: string,
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  const exact = `/${found.name}${args ? ` ${args}` : ''} — efeito destrutivo/irreversível`;
  const approved = await confirmDestructive(found.name, args, exact, deps, ctx);
  if (!approved) return destructiveDenied();
  return {
    ok: false,
    text: `confirmado, mas "/${found.name}" via agente ainda não tem execução implementada nesta versão.`,
  };
}

async function runDestructive(
  found: SlashCommand,
  args: string,
  deps: SessionCommandPortDeps,
  ctx?: ToolRunContext,
): Promise<SessionCommandOutcome> {
  const verb = args.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (found.id === 'clear') {
    const parsed = parseClearCommand(args);
    if (parsed.kind === 'full' || parsed.kind === 'memory') {
      return runDestructiveClear(parsed.kind, deps, ctx);
    }
  }
  if (found.id === 'memory' && verb === 'forget') {
    const parsed = parseMemoryCommand(args);
    if (parsed.kind === 'forget') return runDestructiveMemoryForget(parsed.id, args, deps, ctx);
  }
  if (found.id === 'cron' && verb === 'rm') return runDestructiveCronRm(args, deps, ctx);
  if (found.id === 'logout') return runDestructiveLogout(deps, ctx);
  if (found.id === 'rewind') return runDestructiveRewind(args, deps, ctx);
  return runDestructiveGeneric(found, args, deps, ctx);
}

// ── comandos read-only / session-effect (execução real) ────────────────────────

async function execClear(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const parsed = parseClearCommand(args);
  // Só `session`/`cancel`/`help` chegam aqui — `full`/`memory` são `destructive`
  // (roteados em `runDestructive` ANTES de chamar `execute`).
  const outcome = await runClearCommand(
    parsed,
    { clearSession: () => deps.controller.clear(), memory: deps.memory as AgentMemory },
    false,
  );
  return { ok: true, text: parsed.kind === 'session' ? 'sessão limpa (contexto zerado; memória intacta).' : noteText(outcome.note) };
}

async function execCompact(
  deps: SessionCommandPortDeps,
  ctx: ToolRunContext | undefined,
): Promise<SessionCommandOutcome> {
  const text = await captureBlocks(deps.controller, () => deps.controller.compact(ctx?.signal));
  return { ok: true, text };
}

/** Espelha o parse de `/cycle edit …` do `session/run.tsx` (mesma gramática). */
function parseCycleEditPatch(rest: string): { task?: string; intervalMs?: number; maxIterations?: number } {
  const tokens = rest.match(/"[^"]*"|\S+/g) ?? [];
  const patch: { task?: string; intervalMs?: number; maxIterations?: number } = {};
  const taskParts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tk = tokens[i]!;
    if (tk === '--max-iter' || tk === '--iter') {
      const n = Number(tokens[i + 1]);
      i += 1;
      if (Number.isInteger(n)) patch.maxIterations = n;
      continue;
    }
    const xm = tk.match(/^(\d+)x$/i);
    if (xm) {
      patch.maxIterations = Number(xm[1]);
      continue;
    }
    const im = tk.match(/^(\d+)(s|m|h)$/i);
    if (im && patch.intervalMs === undefined && taskParts.length === 0) {
      const n = Number(im[1]);
      const u = im[2]!.toLowerCase();
      patch.intervalMs = n * (u === 's' ? 1000 : u === 'm' ? 60_000 : 3_600_000);
      continue;
    }
    taskParts.push(tk.replace(/^"|"$/g, ''));
  }
  const task = taskParts.join(' ').trim();
  if (task) patch.task = task;
  return patch;
}

async function execCycle(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const sub = args.trim().split(/\s+/)[0]?.toLowerCase();
  if (sub === 'pause') {
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.cyclePause()) };
  }
  if (sub === 'resume') {
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.cycleResume()) };
  }
  if (sub === 'stop') {
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.cycleStop()) };
  }
  if (sub === 'status') {
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.cycleStatus()) };
  }
  if (sub === 'edit') {
    const rest = (args.trim().match(/^edit\b\s*(.*)$/i)?.[1] ?? '').trim();
    const patch = parseCycleEditPatch(rest);
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.cycleEdit(patch)) };
  }
  if (args.trim() === '') {
    return {
      ok: false,
      text: 'uso: cycle <intervalo|--por dur> "<tarefa>" — sem teto (duração/iterações), o /cycle NÃO inicia.',
    };
  }
  // ADR-0147 (Q-4) — o agente PODE INICIAR o /cycle sozinho: os tetos DUROS do
  // CycleEngine (CLI-SEC-14) + a catraca (cada iteração re-passa `decide()`) são a
  // rede anti-runaway. `cycle()` resolve só quando o ciclo PARA (duração/iterações/
  // budget/conclusão/esc) — o tool-call fica pendente até lá, por construção (mesmo
  // contrato de qualquer outro tool-call: o loop aguarda `tool.run()`).
  const result = await deps.controller.cycle(args);
  if (result.started) {
    return {
      ok: result.ran,
      text: result.ran
        ? 'ciclo concluído.'
        : 'ciclo iniciou mas terminou sem rodar (erro de execução do motor) — ver a sessão.',
    };
  }
  return {
    ok: false,
    text: `/cycle NÃO iniciou (${result.refused}): ${result.message ?? 'sem detalhe.'}`,
  };
}

function tokenizeQuoted(args: string): string[] {
  return (args.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
}

async function execCron(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const tokens = tokenizeQuoted(args);
  const argv = tokens.length === 0 ? ['list'] : tokens;
  const collected: string[] = [];
  const io = { out: (l: string): number => collected.push(l), err: (l: string): number => collected.push(l) };
  await runCron(argv, { io });
  void deps; // silencia o lint em builds sem uso adicional de deps neste ramo.
  return { ok: true, text: collected.length > 0 ? collected.join('\n') : '(sem saída)' };
}

async function execMemory(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  if (!deps.memory) return unavailable('memory');
  const parsed = parseMemoryCommand(args);
  // `forget` é destructive (roteado ANTES de chegar aqui); os demais (list/edit/pin/
  // unpin/help) chegam aqui.
  const note = await runMemoryCommand(parsed, deps.memory, false);
  return { ok: true, text: noteText(note) };
}

async function execTodo(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  if (!deps.ports.todo) return unavailable('todo');
  const parsed = parseTodoCommand(args);
  const note = await runTodoCommand(parsed, deps.ports.todo, false);
  return { ok: true, text: noteText(note) };
}

async function execProvider(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const v = args.trim();
  if (v === '') return fromSlashEffectFallback('provider', deps);
  deps.controller.setProvider(v);
  return { ok: true, text: `provider setado: ${v}` };
}

async function execEffort(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const v = args.trim();
  if (v === '') return fromSlashEffectFallback('effort', deps);
  if (v.length > 32) {
    return { ok: false, text: `erro: "effort" aceita no máximo 32 caracteres (recebeu ${v.length}).` };
  }
  deps.controller.setEffort(v);
  return { ok: true, text: `effort definido para: ${v}` };
}

async function execModel(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  if (args.trim() === '') return fromSlashEffectFallback('model', deps);
  return {
    ok: false,
    text: '"/model <tier>" via agente ainda não tem execução implementada nesta versão (o tier NÃO foi trocado) — "/model" sem args (leitura) funciona.',
  };
}

async function execRename(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const result = routeRename(args);
  switch (result.kind) {
    case 'set':
      deps.controller.setLabel(result.label.label, result.label.color);
      return {
        ok: true,
        text: `sessão renomeada: ${result.label.label} (cor: ${result.label.color})${result.notice ? `\n${result.notice}` : ''}`,
      };
    case 'clear':
      deps.controller.setLabel(undefined);
      return { ok: true, text: 'rótulo removido — a sessão volta sem nome.' };
    case 'show': {
      const cur = deps.controller.label;
      return {
        ok: true,
        text:
          cur !== undefined
            ? `sessão: ${cur}${deps.controller.labelColor ? ` (${deps.controller.labelColor})` : ''}`
            : 'esta sessão não tem rótulo.',
      };
    }
    case 'error':
      return { ok: false, text: result.message };
  }
}

async function execInit(
  args: string,
  deps: SessionCommandPortDeps,
  ctx: ToolRunContext | undefined,
): Promise<SessionCommandOutcome> {
  const overwrite = /(?:^|\s)--force\b/.test(args);
  const rootName = deps.ports.cwd?.root ? basename(deps.ports.cwd.root) : undefined;
  const result = await runInit({
    ports: deps.ports,
    permission: deps.engine,
    askResolver: deps.askResolver,
    ...(rootName !== undefined ? { rootName } : {}),
    overwrite,
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
  });
  return { ok: true, text: noteText(result.note) };
}

async function execWhoami(deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  if (!deps.login) return unavailable('whoami');
  const note = await runAsyncSlash('whoami', deps.login);
  return { ok: true, text: noteText(note) };
}

async function execAgents(deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const profiles = deps.agentRegistry?.list() ?? [];
  const note = buildAgentsNote({ profiles, errors: [] });
  return { ok: true, text: noteText(note) };
}

async function execSkills(deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const globalSk = new UserSkillsLoader().load();
  const projectSk = deps.workspace
    ? new ProjectSkillsLoader({ workspace: deps.workspace }).load()
    : { skills: [], errors: [] };
  const note = buildSkillsNote({
    skills: [...globalSk.skills, ...projectSk.skills],
    errors: [...globalSk.errors, ...projectSk.errors],
  });
  return { ok: true, text: noteText(note) };
}

async function execWorkflows(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const runMatch = /^\s*run\s+(\S+)/.exec(args);
  if (runMatch) {
    const name = runMatch[1]!;
    const text = await captureBlocks(deps.controller, () => deps.controller.workflowRun(name));
    return { ok: true, text };
  }
  const useMatch = /^\s*use\s+(\S+)/.exec(args);
  if (useMatch) {
    const name = useMatch[1]!;
    const text = await captureBlocks(deps.controller, () => deps.controller.workflowsUse(name));
    return { ok: true, text };
  }
  const globalWf = new UserWorkflowsLoader().load();
  const projectWf = deps.workspace
    ? new ProjectWorkflowsLoader({ workspace: deps.workspace }).load()
    : { workflows: [], errors: [] };
  const note = buildWorkflowsNote({
    workflows: [...globalWf.workflows, ...projectWf.workflows],
    errors: [...globalWf.errors, ...projectWf.errors],
  });
  return { ok: true, text: noteText(note) };
}

async function execInventory(deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const agentNames = (deps.agentRegistry?.list() ?? []).map((p) => p.name);
  return {
    ok: true,
    text: `inventário · agentes (${agentNames.length}): ${agentNames.length > 0 ? agentNames.join(', ') : '—'}`,
  };
}

async function execRooms(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const [sub, ...rest] = args.trim().split(/\s+/);
  if (sub === '' || sub === undefined || sub === 'list') {
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.roomList()) };
  }
  if (sub === 'new') {
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.roomNew()) };
  }
  if (sub === 'read') {
    const code = rest.join(' ').trim();
    if (code === '') return { ok: false, text: 'uso: rooms read <código> — código ausente.' };
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.roomRead(code)) };
  }
  if (sub === 'watch') {
    const code = rest.join(' ').trim();
    if (code === '') return { ok: false, text: 'uso: rooms watch <código> — código ausente.' };
    return { ok: true, text: await captureBlocks(deps.controller, () => deps.controller.roomWatch(code)) };
  }
  return { ok: false, text: `subcomando desconhecido: "${sub}" — use list | new | read <código> | watch <código>.` };
}

async function execAsk(args: string, deps: SessionCommandPortDeps): Promise<SessionCommandOutcome> {
  const question = args.trim();
  if (question === '') return { ok: false, text: 'uso: ask <pergunta> — pergunta ausente.' };
  const text = await captureBlocks(deps.controller, () => deps.controller.askParallel(question));
  return { ok: true, text };
}

async function execute(
  found: SlashCommand,
  args: string,
  deps: SessionCommandPortDeps,
  ctx: ToolRunContext | undefined,
): Promise<SessionCommandOutcome> {
  switch (found.id) {
    case 'clear':
      return execClear(args, deps);
    case 'compact':
      return execCompact(deps, ctx);
    case 'cycle':
      return execCycle(args, deps);
    case 'cron':
      return execCron(args, deps);
    case 'memory':
      return execMemory(args, deps);
    case 'todo':
      return execTodo(args, deps);
    case 'provider':
      return execProvider(args, deps);
    case 'effort':
      return execEffort(args, deps);
    case 'model':
      return execModel(args, deps);
    case 'rename':
      return execRename(args, deps);
    case 'init':
      return execInit(args, deps, ctx);
    case 'whoami':
      return execWhoami(deps);
    case 'agents':
      return execAgents(deps);
    case 'skills':
      return execSkills(deps);
    case 'workflows':
      return execWorkflows(args, deps);
    case 'inventory':
      return execInventory(deps);
    case 'rooms':
      return execRooms(args, deps);
    case 'ask':
      return execAsk(args, deps);
    default:
      // help/usage/permissions/tools/doctor/telegram/undo/redo/history/export/mcp —
      // reusa o texto honesto do `buildSlashEffect` (comandos read-only puros ou cuja
      // execução completa via agente ainda não está wired nesta versão).
      return fromSlashEffectFallback(found.id!, deps);
  }
}

/**
 * A FÁBRICA da porta (ADR-0147). `deps.controller` é o `SessionController` (`this`,
 * quando chamado do PRÓPRIO construtor — seguro: a porta só é INVOCADA muito depois,
 * quando o agente de fato disparar `session_command`, nunca durante a construção).
 */
export function createSessionCommandPort(deps: SessionCommandPortDeps): SessionCommandPort {
  return {
    async run(command, args, ctx): Promise<SessionCommandOutcome> {
      const found = NATIVE_COMMANDS.find((c) => c.source === 'native' && c.name === command);
      if (!found) {
        return {
          ok: false,
          text: `comando de sessão desconhecido ou não-classificado: "/${command}" (fail-closed — só comandos NATIVOS classificados são invocáveis; comandos do usuário em ~/.aluy/commands/ não são; ver /help).`,
        };
      }
      const effect = resolveAgentEffect(found, args);
      if (effect === 'human-only') {
        return {
          ok: false,
          text: `"/${found.name}" só faz sentido no terminal do humano (interface/interativo) — recomende ao usuário digitar "/${found.name}${args ? ` ${args}` : ''}" diretamente; você não pode disparar este comando.`,
        };
      }
      if (effect === 'destructive') return runDestructive(found, args, deps, ctx);
      return execute(found, args, deps, ctx);
    },
  };
}
