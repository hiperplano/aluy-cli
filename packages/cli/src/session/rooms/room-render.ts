// ADR-0126 (B) — RENDER PURO da visibilidade de salas pro HUMANO observar a frota.
// Separado do controller (que faz I/O/pushNote) p/ ser testável sem TUI/store. O humano
// OBSERVA (texto plano) — ≠ `room_read` do AGENTE, que recebe DADO envelopado (CLI-SEC-4).
//
// PORTÁVEL: sem Ink/IO. Só formata a partir do snapshot de `Room`.

import type { Room } from '@aluy/cli-core';

/** Tempo relativo curto ("agora", "12s", "3m", "2h", "1d") a partir de `ms` decorridos. */
export function relTime(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '—';
  const s = Math.floor(elapsedMs / 1000);
  if (s < 5) return 'agora';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Participantes DISTINTOS (quem já escreveu, por `from`) na ordem de 1ª aparição. */
export function participantsOf(room: Room): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of room.messages) {
    if (!seen.has(m.from)) {
      seen.add(m.from);
      out.push(m.from);
    }
  }
  return out;
}

/**
 * Linha-resumo de UMA sala p/ o `/rooms list`: código · nº msgs · última atividade ·
 * participantes. `now` é o relógio injetável (testável). Sala vazia ⇒ sem "última".
 */
export function formatRoomSummary(room: Room, now: number): string {
  const n = room.messages.length;
  const parts = participantsOf(room);
  const last = n > 0 ? room.messages[n - 1]!.ts : undefined;
  const activity = last !== undefined ? `há ${relTime(now - last)}` : 'sem atividade';
  const who = parts.length > 0 ? ` · ${parts.join(', ')}` : '';
  const flag = room.revoked ? ' (revogada)' : '';
  return `${room.code} · ${n} msg · ${activity}${who}${flag}`;
}

/** Cabeçalho + linhas da conversa de uma sala p/ o `/rooms read`/`watch` (texto PLANO). */
export function formatConversation(room: Room, tail = 50): { header: string; lines: string[] } {
  const parts = participantsOf(room);
  const header = `${room.code} · ${room.messages.length} msg${
    parts.length > 0 ? ` · ${parts.join(', ')}` : ''
  }${room.revoked ? ' · REVOGADA' : ''}`;
  const lines = room.messages
    .slice(-tail)
    .map((m) => `[seq ${m.seq}] ${m.from} → ${m.to} [${m.kind}]: ${m.body}`);
  return { header, lines };
}

/** Só as mensagens com `seq > sinceSeq` formatadas (p/ o `watch` ao vivo mostrar o novo). */
export function formatNewSince(room: Room, sinceSeq: number): string[] {
  return room.messages
    .filter((m) => m.seq > sinceSeq)
    .map((m) => `[seq ${m.seq}] ${m.from} → ${m.to} [${m.kind}]: ${m.body}`);
}

/** Maior seq do feed (0 se vazio) — cursor inicial do `watch`. */
export function maxSeq(room: Room): number {
  return room.messages.reduce((mx, m) => Math.max(mx, m.seq), 0);
}
