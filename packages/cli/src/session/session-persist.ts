// EST-0972 — utilidades de persistência de sessão usadas pelo render (run.tsx):
// o AUTO-SAVE best-effort e a FORMATAÇÃO da lista de sessões (`--resume` sem id).
//
// Separadas do run.tsx (Ink) p/ serem testáveis sem TUI. Sem segredo, sem log de
// conteúdo: a formatação mostra SÓ metadados (id, data, cwd, título curto), nunca o
// corpo da transcrição.

import type { SessionBlock } from './model.js';
import type { SessionStore, SessionSummary } from '../io/index.js';

/**
 * Grava a transcrição corrente no store (best-effort). NUNCA lança: uma falha de
 * escrita não derruba a sessão viva (só não persiste p/ a próxima). Não loga o
 * conteúdo. Retorna `true` se gravou (útil p/ teste).
 */
export function autoSaveSession(
  store: SessionStore,
  input: {
    readonly id: string;
    readonly cwd: string;
    readonly tier: string;
    /**
     * EST-0972 (BUG Custom) — slug Custom corrente. Só é gravado sob `tier:'custom'`
     * (o `store.save` re-trava). É a chave de catálogo (HG-2), nunca credencial.
     */
    readonly model?: string;
    /**
     * EST-0972 (rename) — RÓTULO amigável corrente da sessão (`/rename`). DADO DE UI
     * (HG-2, não credencial). O `store.save` re-saneia (controle/teto). undefined = sem
     * rótulo.
     */
    readonly label?: string;
    /** EST-0972 (rename) — cor de identificação corrente (nome da paleta do DS). */
    readonly labelColor?: string;
    readonly blocks: readonly SessionBlock[];
  },
): boolean {
  // Não persiste uma transcrição VAZIA (sessão sem nenhuma interação) — evita poluir
  // `~/.aluy/sessions/` com sessões fantasma de quem só abriu e fechou o `aluy`.
  if (input.blocks.length === 0) return false;
  try {
    return store.save(input);
  } catch {
    return false; // best-effort: nunca derruba a sessão.
  }
}

/** Data curta e legível (YYYY-MM-DD HH:MM) a partir de ms epoch. PURO. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/**
 * EST-0972 (BUG 2) — idade relativa curta e humana ("há 3 min", "há 2 h", "há 1 d")
 * a partir de uma duração em ms. PURO. Usada no prompt de auto-oferta de retomada
 * ("retomar a conversa anterior (… , há X)?"). Granularidade grossa de propósito —
 * é uma pista de recência, não um cronômetro.
 */
export function formatRelativeAge(ageMs: number): string {
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 60) return 'há instantes';
  const min = Math.floor(sec / 60);
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} d`;
}

/**
 * EST-0972 (BUG 2) — a LINHA do prompt de auto-oferta de retomada no boot:
 * `↻ retomar a conversa anterior (N mensagens, há X)? [S/n]`. PURO (só metadados —
 * nº de mensagens e recência, NUNCA o corpo da transcrição, CLI-SEC-6). `S` é o
 * default (Enter = sim): a UX menos surpreendente é continuar de onde parou.
 */
export function formatResumeOffer(messageCount: number, ageMs: number): string {
  const plural = messageCount === 1 ? 'mensagem' : 'mensagens';
  return `↻ retomar a conversa anterior (${messageCount} ${plural}, ${formatRelativeAge(
    ageMs,
  )})? [S/n] `;
}

/**
 * Formata a lista de sessões p/ o `--resume` (sem id): linhas legíveis com id curto,
 * data, cwd e título. Só METADADOS — nunca o corpo da transcrição (CLI-SEC-6). PURO.
 * Devolve as linhas (o caller decide se imprime linear ou empurra como nota).
 */
export function formatSessionList(summaries: readonly SessionSummary[]): string[] {
  if (summaries.length === 0) {
    return ['nenhuma sessão salva ainda.'];
  }
  const lines = ['sessões salvas (retome com: aluy --resume <id>):', ''];
  for (const s of summaries) {
    const title = s.title ?? '(sem objetivo)';
    lines.push(`  ${s.id}`);
    lines.push(`    ${shortDate(s.updatedAt)} · ${s.cwd} · ${s.blockCount} blocos`);
    lines.push(`    ${title}`);
  }
  return lines;
}
