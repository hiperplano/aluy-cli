// EST-1015 (fullscreen idle "horrível") · ADR-0076 §3 — PARTIÇÃO dos blocos da sessão
// p/ o cockpit. PURO/testável (sem Ink, sem I/O).
//
// O PROBLEMA (uso real do Tiago): no cockpit idle/boot, a região de CONVERSA aparece
// POLUÍDA com as NOTAS DE DIAGNÓSTICO de boot (`◷ config`, `◷ agentes`) pinadas no topo,
// enquanto a região de LOG fica ~30% VAZIA ("sem atividade ainda" + linhas mortas). No
// inline essas notas rolam embora no scrollback; no cockpit cada região é de altura FIXA,
// então elas ficam ESTACIONADAS — barren e "horrível".
//
// A DECISÃO (Tiago, opção A): mover as notas de DIAGNÓSTICO de boot p/ a região de LOG
// (que existe exatamente p/ isso e está vazia no idle) e deixar a CONVERSA limpa (com um
// boas-vindas calmo até o 1º objetivo). Resolve as DUAS causas SEM mexer na ALTURA das
// regiões (o que quebraria o overlay do `/` — beco já provado).
//
// O QUE relocamos: SÓ as notas puramente INFORMATIVAS de boot (`config`/`agentes`) e SÓ
// ANTES do 1º turno do usuário (`you`). Notas ACIONÁVEIS (login/model/yolo) e qualquer
// nota PÓS-objetivo (resultado de `/comando`) FICAM na conversa — não são diagnóstico de
// startup e o usuário as espera ali.

import type { NoteBlock, SessionBlock } from './model.js';

/**
 * Títulos das notas de DIAGNÓSTICO de boot que migram p/ o LOG (opção A). SÓ as puramente
 * informativas — `config` (instruções/comandos/MCP) e `agentes` (perfis .md). Notas
 * ACIONÁVEIS (login/model/yolo) NÃO entram: ficam visíveis na conversa.
 */
export const STARTUP_LOG_NOTE_TITLES: ReadonlySet<string> = new Set(['config', 'agentes']);

/** O resultado da partição: o que vai p/ o LOG (boot) e o que vai p/ a CONVERSA. */
export interface CockpitBlockPartition {
  /** Notas de diagnóstico de boot (`config`/`agentes`) — renderizadas no empty-state do LOG. */
  readonly startupNotes: readonly NoteBlock[];
  /** O resto — a CONVERSA propriamente dita (vazia até o 1º objetivo ⇒ boas-vindas). */
  readonly conversation: readonly SessionBlock[];
}

/**
 * Particiona os blocos da sessão p/ o cockpit (opção A). Uma nota é de "startup" sse seu
 * título ∈ {@link STARTUP_LOG_NOTE_TITLES} E aparece ANTES do 1º turno do usuário (`you`).
 * Tudo o mais (turnos, notas acionáveis, notas pós-objetivo) segue na CONVERSA, na ordem.
 * PURO. Preserva a ordem relativa dentro de cada lado.
 */
export function partitionCockpitBlocks(blocks: readonly SessionBlock[]): CockpitBlockPartition {
  let seenUserTurn = false;
  const startupNotes: NoteBlock[] = [];
  const conversation: SessionBlock[] = [];
  for (const b of blocks) {
    if (b.kind === 'you') seenUserTurn = true;
    if (!seenUserTurn && b.kind === 'note' && STARTUP_LOG_NOTE_TITLES.has(b.title)) {
      startupNotes.push(b);
    } else {
      conversation.push(b);
    }
  }
  return { startupNotes, conversation };
}
