// ADR 0006 — o DIGEST: retrato compacto do estado vivo que o Concierge lê a cada mensagem.
// PURO. Tudo que veio de tarefa (objetivo, resumo, detalhe) é DADO: redigido (CLI-SEC-6),
// cortado e apresentado numa seção rotulada — o prompt manda não obedecer ao que está nela.

import { redactOutputSecrets } from '../agent/journal/redact.js';
import type { TaskEvent, TaskRecord, TaskStatus } from './tasks.js';

/** O que o motor sabe além do registro de tarefas (sub-agentes, aprovações, cota). */
export interface EngineSnapshot {
  readonly subAgents: readonly { label: string; status: string; taskId?: string }[];
  readonly approvals: readonly { taskId?: string; summary: string }[];
  readonly quotaPauses: readonly { taskId?: string; reason: string }[];
}

export const EMPTY_SNAPSHOT: EngineSnapshot = { subAgents: [], approvals: [], quotaPauses: [] };

const STATUS_PT: Readonly<Record<TaskStatus, string>> = {
  blocked: 'esperando arquivos',
  running: 'rodando',
  waiting_approval: 'aguardando aprovação',
  paused_quota: 'pausada por cota',
  done: 'concluída',
  failed: 'falhou',
  stopped: 'parada',
  interrupted: 'interrompida',
};

const PHASE_PT: Readonly<Record<string, string>> = {
  idle: 'entre passos',
  model_call: 'em chamada ao modelo',
  tool: 'executando ferramenta',
  asking: 'esperando o dono',
};

export function statusPt(s: TaskStatus): string {
  return STATUS_PT[s];
}

/** Corta e redige texto de origem não-confiável para entrar no digest. */
export function clip(text: string, max: number): string {
  const one = redactOutputSecrets(text).replace(/\s+/g, ' ').trim();
  return cutAt(one, max);
}

/** Como `clip`, mas também tira marcação markdown (`**`, crases): para relatos de uma linha. */
export function clipPlain(text: string, max: number): string {
  const one = redactOutputSecrets(text)
    .replace(/[*_`#>]+/g, '')
    // Tabela markdown vira texto corrido: `| a | b |` / `|---|---|` não pode poluir a nota de 1 linha.
    .replace(/\|/g, ' ')
    .replace(/[-=─]{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cutAt(one, max);
}

/** Teto do resultado de uma tarefa que entra no relato automático (uma única chamada ao modelo). */
export const RESULT_MAX_CHARS = 6000;

/**
 * Resultado de tarefa preservando as QUEBRAS DE LINHA (listas, relatórios): só redige segredo,
 * normaliza CRLF e apara linhas em branco do fim. Acima de `max` corta numa FRONTEIRA DE LINHA e
 * acrescenta UMA marca explícita `[… +N linhas; o relato completo está em /task show tN]` — o
 * modelo vê que há mais e sabe onde está, em vez de achar que o dado "veio cortado". O total
 * (marca incluída) nunca passa de `max`, então reaplicar é idempotente.
 */
export function clipBlock(text: string, max: number, taskId?: string): string {
  const clean = redactOutputSecrets(text).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (clean.length <= max) return clean;
  const lines = clean.split('\n');
  const marca = (n: number): string =>
    `[… +${String(n)} linha${n === 1 ? '' : 's'}; o relato completo está em /task show ${taskId ?? 'tN'}]`;
  const reserva = marca(lines.length).length + 1;
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > max - reserva) break;
    kept.push(l);
    used += l.length + 1;
  }
  if (kept.length === 0) kept.push((lines[0] ?? '').slice(0, Math.max(0, max - reserva - 1)));
  const hidden = lines.length - kept.length;
  return `${kept.join('\n')}\n${marca(Math.max(hidden, 1))}`;
}

function cutAt(one: string, max: number): string {
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60
    ? `${m}m${String(s % 60).padStart(2, '0')}s`
    : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function describeTask(t: TaskRecord, now: number): string {
  const live = t.endedAt === undefined;
  const parts = [STATUS_PT[t.status]];
  if (live && t.status === 'running') parts.push(PHASE_PT[t.phase] ?? t.phase);
  if (t.blockedBy) parts.push(`depois de ${t.blockedBy}`);
  else if (t.queued === true && t.status === 'blocked') parts.push('na fila');
  parts.push(`${t.steps} passo${t.steps === 1 ? '' : 's'}`);
  parts.push(formatElapsed((t.endedAt ?? now) - t.startedAt));
  let line = `- ${t.id} [${parts.join(' · ')}] ${clip(t.goal, 120)}`;
  if (t.files.length > 0) line += ` (arquivos: ${t.files.slice(0, 4).join(', ')})`;
  if (t.summary) line += `\n    resultado: ${clip(t.summary, 200)}`;
  return line;
}

/** Teto de tarefas no digest do Concierge. */
export const MAX_DIGEST_TASKS = 40;

/** Encerrada, compacta: id, estado, objetivo e desfecho em UMA linha cada. */
export function describeEnded(t: TaskRecord): string {
  const out = clip(t.summary ?? t.result ?? '', 160);
  return `- ${t.id} [${STATUS_PT[t.status]}] ${clip(t.goal, 100)}${out ? ` → ${out}` : ''}`;
}

/** `task_status` sem id: TODAS as tarefas (id, estado, objetivo, resultado curto). */
export function describeAllTasks(tasks: readonly TaskRecord[], now: number): string {
  if (tasks.length === 0) return 'tarefas: nenhuma';
  return tasks
    .map((t) => (t.endedAt === undefined ? describeTask(t, now) : describeEnded(t)))
    .join('\n');
}

export function buildDigest(args: {
  tasks: readonly TaskRecord[];
  events: readonly TaskEvent[];
  engine: EngineSnapshot;
  now: number;
}): string {
  const out: string[] = [];
  // TODAS as tarefas da sessão, em forma compacta (o dono pergunta "desde a t1"); as vivas com
  // detalhe completo. Teto de MAX_DIGEST_TASKS: as mais antigas viram `+N antigas (use task_status)`.
  const live = args.tasks.filter((t) => t.endedAt === undefined);
  const ended = args.tasks.filter((t) => t.endedAt !== undefined);
  if (live.length + ended.length === 0) out.push('tarefas: nenhuma');
  else {
    out.push('tarefas:');
    const room = Math.max(0, MAX_DIGEST_TASKS - live.length);
    const shown = ended.slice(-room);
    if (ended.length > shown.length)
      out.push(`- +${ended.length - shown.length} antigas (use task_status para ver)`);
    for (const t of shown) out.push(describeEnded(t));
    for (const t of live) out.push(describeTask(t, args.now));
  }
  if (args.engine.approvals.length > 0) {
    out.push('aprovações pendentes (aguardam o dono):');
    for (const a of args.engine.approvals.slice(0, 5))
      out.push(`- ${a.taskId ?? '?'}: ${clip(a.summary, 100)}`);
  }
  if (args.engine.quotaPauses.length > 0) {
    out.push('pausas por cota:');
    for (const q of args.engine.quotaPauses.slice(0, 3))
      out.push(`- ${q.taskId ?? 'sessão'}: ${clip(q.reason, 100)}`);
  }
  if (args.engine.subAgents.length > 0) {
    out.push(
      `sub-agentes: ${args.engine.subAgents
        .slice(0, 8)
        .map((s) => `${clip(s.label, 24)} (${s.status})${s.taskId ? ` em ${s.taskId}` : ''}`)
        .join('; ')}`,
    );
  }
  if (args.events.length > 0) {
    out.push('eventos recentes:');
    for (const e of args.events.slice(-6))
      out.push(`- ${e.taskId} ${e.kind}${e.detail ? `: ${clip(e.detail, 80)}` : ''}`);
  }
  return out.join('\n');
}
