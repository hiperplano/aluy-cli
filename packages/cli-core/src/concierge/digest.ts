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
  parts.push(`${t.steps} passo${t.steps === 1 ? '' : 's'}`);
  parts.push(formatElapsed((t.endedAt ?? now) - t.startedAt));
  let line = `- ${t.id} [${parts.join(' · ')}] ${clip(t.goal, 120)}`;
  if (t.files.length > 0) line += ` (arquivos: ${t.files.slice(0, 4).join(', ')})`;
  if (t.summary) line += `\n    resultado: ${clip(t.summary, 200)}`;
  return line;
}

export function buildDigest(args: {
  tasks: readonly TaskRecord[];
  events: readonly TaskEvent[];
  engine: EngineSnapshot;
  now: number;
}): string {
  const out: string[] = [];
  // As terminais mais antigas saem do digest (as 5 mais recentes bastam).
  const live = args.tasks.filter((t) => t.endedAt === undefined);
  const ended = args.tasks.filter((t) => t.endedAt !== undefined).slice(-5);
  if (live.length + ended.length === 0) out.push('tarefas: nenhuma');
  else {
    out.push('tarefas:');
    for (const t of [...ended, ...live]) out.push(describeTask(t, args.now));
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
