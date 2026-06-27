// EST-XXXX — `/rewind` + Esc-Esc: lógica PURA da rebobinada (sem Ink). Formata a
// lista de checkpoints p/ o picker e enumera as AÇÕES. A mecânica (marcar ponto,
// restaurar código) é do `CheckpointRegistry` (core); a rebobinada da CONVERSA é do
// `SessionController.rewindConversation` (cli). Aqui só o que liga os dois à UI.
//
// SEGURANÇA (CLI-SEC-6): a label do checkpoint é o PROMPT do usuário (já normalizado/
// truncado no core). É a fala do próprio usuário (não dado de ambiente), exibida como
// rótulo do item — mesma natureza do título da sessão no `/history`.

import type { Checkpoint } from '@aluy/cli-core';

/** A AÇÃO escolhida sobre um checkpoint (a 2ª etapa do menu). */
export type RewindAction = 'both' | 'conversation' | 'code';

/** As ações na ORDEM exibida (default = `both` no topo). */
export const REWIND_ACTIONS: readonly RewindAction[] = ['both', 'conversation', 'code'];

/** Teto de checkpoints listados no menu (os mais recentes no topo). */
export const REWIND_LIST_LIMIT = 30;

/**
 * Os checkpoints a oferecer no `/rewind`, do mais RECENTE p/ o mais antigo, limitados
 * a `limit`. PURO. `list()` do registry vem antigo→recente; aqui invertemos (recente
 * no topo, como o `/history`) e cortamos.
 */
export function selectRewindCheckpoints(
  checkpoints: readonly Checkpoint[],
  limit: number = REWIND_LIST_LIMIT,
): readonly Checkpoint[] {
  const recentFirst = [...checkpoints].reverse();
  return recentFirst.slice(0, limit);
}

/**
 * Formata UMA linha do checkpoint p/ o picker: `#<ordinal> · <hora> · <label>`. A
 * hora é relativa-curta (HH:MM) p/ caber. PURO; `now` injetável só por consistência
 * (não usado no formato atual, reservado p/ "há N min"). Sem segredo (a label é o
 * prompt do usuário, já truncado no core).
 */
export function formatRewindEntry(cp: Checkpoint): string {
  const time = formatClock(cp.ts);
  return `#${cp.ordinal} · ${time} · ${cp.label}`;
}

/** HH:MM local de um epoch ms (estável, sem dependência de locale pesado). */
function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** A chave i18n do rótulo de uma ação (p/ o componente traduzir). */
export function rewindActionKey(action: RewindAction): string {
  switch (action) {
    case 'both':
      return 'picker.rewind.action.both';
    case 'conversation':
      return 'picker.rewind.action.conversation';
    case 'code':
      return 'picker.rewind.action.code';
  }
}
