// EST-0982 · ADR-0063 §4 (INTERAGIR) · GS-C5 / RES-C-2 — INJEÇÃO DE INPUT num
// (sub)agente vivo, PELA MESMA CATRACA, SEM ampliar escopo.
//
// O 3º verbo (INTERAGIR) deixa o usuário mandar input p/ um agente em curso
// (redirecionar/corrigir o rumo). É a ÚNICA peça com superfície de segurança — e o
// ADR-0063 a crava com precisão: o input é CONTEÚDO DO USUÁRIO que entra no contexto
// do agente, e QUALQUER efeito que ele derive disso passa pela MESMA `decide()`.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ INVARIANTES (gate MÉDIO do `seguranca` — GS-C5 / RES-C-2):                 ║
// ║                                                                            ║
// ║ 1. INPUT = CONTEÚDO/INSTRUÇÃO DO USUÁRIO (CLI-SEC-4/9): o usuário é o        ║
// ║    PRINCIPAL (o dono), então o input entra no canal `user` como             ║
// ║    INSTRUÇÃO (`user_inject` → `user`), com RÓTULO DE ORIGEM — NUNCA como     ║
// ║    `system` (instrução PRIVILEGIADA do sistema). NÃO é DADO_NAO_CONFIÁVEL    ║
// ║    (não é saída de ambiente). A SEGURANÇA não vem de tratar o dono como      ║
// ║    não-confiável: vem de que QUALQUER EFEITO que o modelo derive disto       ║
// ║    RE-PASSA a MESMA `decide()` (a catraca é intocada — ver invariante 3).   ║
// ║                                                                            ║
// ║ 2. NÃO AMPLIA O ESCOPO HERDADO (⊆ pai): a injeção NÃO troca a engine do     ║
// ║    filho. O filho continua com a MESMA engine derivada do pai (toolset ⊆    ║
// ║    pai, grants próprios, spawn_agent negado). Esta função NÃO recebe nem     ║
// ║    devolve uma engine "mais aberta" — ela só PRODUZ o item de histórico.    ║
// ║                                                                            ║
// ║ 3. NÃO RELAXA SEMPRE-ASK / MODO: o filho em Plan continua NEGANDO efeito     ║
// ║    após o input (Plan é o teto, acima de injeção — gate.ts §0). O input      ║
// ║    NÃO vira um canal p/ contornar a catraca (não destrava efeito sem a       ║
// ║    confirmação/ratchet). A PROVA é a engine intacta + a separação de canais. ║
// ║                                                                            ║
// ║ 4. AUDITADO `actor_type=cli` (CLI-SEC-10): quem injeta é o usuário pela      ║
// ║    borda; o evento (nó-alvo + resumo redigido) vai p/ a `ControlAudit`.      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): puro, sem I/O. Constrói o `HistoryItem` de input do
// usuário; a entrega ao loop vivo (re-semear) é do locus concreto. A função NÃO
// abre nenhum efeito por si — só monta dado rotulado.

import type { HistoryItem } from './context.js';

/** Rótulo de origem do canal de input injetado (CLI-SEC-4/CLI-SEC-9). */
export const INJECTED_INPUT_LABEL = 'usuário (interagir)';

/**
 * Monta o `HistoryItem` de um input INJETADO pelo usuário no agente PRINCIPAL vivo
 * (INTERAGIR / "btw"). O usuário é o PRINCIPAL (o dono) ⇒ o item é `user_inject`
 * (canal `user`, INSTRUÇÃO), com o RÓTULO DE ORIGEM (`usuário (interagir)`, CLI-SEC-4/9)
 * — NUNCA `system` (instrução privilegiada do sistema) e NUNCA `DADO_NAO_CONFIÁVEL`
 * (não é saída de ambiente). A segurança NÃO se apoia em tratar o dono como
 * não-confiável: ela se apoia em que QUALQUER EFEITO que o modelo derive daqui
 * RE-PASSA a MESMA `decide()` (a catraca é intocada — invariante 1/3). NÃO toca a
 * catraca; NÃO abre efeito; só produz o item. `text` vazio ⇒ `undefined`.
 */
export function injectedInputItem(input: string): HistoryItem | undefined {
  const text = input.trim();
  if (text === '') return undefined;
  return {
    role: 'user_inject',
    origin: INJECTED_INPUT_LABEL,
    text,
  };
}
