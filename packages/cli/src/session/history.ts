// EST-0972 — `/history`: navegar e RETOMAR uma sessão anterior DENTRO da sessão
// (sem sair p/ `aluy --resume`). Lógica PURA (sem Ink, sem I/O de render) p/ ser
// testável com um MOCK do `SessionStore`:
//   - `selectHistorySessions` : as N sessões mais RECENTES (teto razoável);
//   - `formatHistoryList`     : as linhas legíveis (data · cwd abreviado · 1ª msg);
//   - `applyResumeRecord`     : a AÇÃO de retomada AO VIVO — REUSA o mesmo caminho do
//                               boot (`restoreBlocks` + `seedHistory(blocksToHistory)`),
//                               troca o ALVO do auto-save p/ a sessão escolhida e limpa
//                               a tela. NÃO reinventa o resume;
//   - `runHistoryLinear`      : o fallback HONESTO do não-TTY (lista + aceita um id).
//
// SEGURANÇA (espelha o `formatSessionList`/`session-persist.ts`): só METADADOS — id,
// data, cwd, 1ª mensagem truncada. NUNCA o corpo da transcrição (CLI-SEC-6); nenhum
// segredo. A transcrição retomada vira contexto da PRÓPRIA conversa, com o conteúdo
// de tool/`!`/arquivo no envelope ORIGINAL (blocksToHistory → observation = DADO).

import type { SessionRecord, SessionStore, SessionSummary } from '../io/index.js';
import { blocksToHistory } from '../io/index.js';
import { abbreviateCwd } from './model.js';
import type { HistoryItem } from '@aluy/cli-core';

/**
 * Teto de sessões listadas no `/history` — as N mais RECENTES. A lista é uma ajuda de
 * navegação rápida, não um arquivo morto: além disso, o GC do store já poda por
 * idade/teto. 15 cabe numa tela sem rolar e cobre o uso típico (o resto via
 * `aluy --resume <id>`).
 */
export const HISTORY_LIST_LIMIT = 15;

/**
 * As sessões a oferecer no `/history`: as `limit` mais RECENTES (o `store.list()` já
 * vem ordenado por `updatedAt` desc). PURA quanto a efeito (só lê o store). Fail-safe:
 * um store que lança em `list()` é tratado como SEM sessões (lista vazia) — o picker
 * mostra "nenhuma sessão anterior" em vez de derrubar a TUI.
 */
export function selectHistorySessions(
  store: Pick<SessionStore, 'list'>,
  limit: number = HISTORY_LIST_LIMIT,
): readonly SessionSummary[] {
  let all: readonly SessionSummary[];
  try {
    all = store.list();
  } catch {
    return [];
  }
  return all.slice(0, Math.max(0, limit));
}

/** Data curta e legível (YYYY-MM-DD HH:MM) a partir de ms epoch. PURO. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

/** A 1ª fala do usuário (truncada) de uma transcrição — rótulo do item. PURO. */
function titleOfBlocks(blocks: readonly SessionBlockLike[]): string | undefined {
  for (const b of blocks) {
    if (b.kind === 'you') {
      const t = b.text.replace(/\s+/g, ' ').trim();
      if (t === '') return undefined;
      return t.length > 60 ? t.slice(0, 57) + '…' : t;
    }
  }
  return undefined;
}

/**
 * Uma linha curta e densa p/ um item do `/history`: `YYYY-MM-DD HH:MM · ~/proj · 1ª
 * mensagem`. PURA (só metadados — CLI-SEC-6). O cwd é ABREVIADO (home → `~`) p/ caber;
 * a 1ª mensagem (`title`) já vem truncada do store. Sem título ⇒ `(sem objetivo)`.
 * `home` é injetável p/ teste determinístico da abreviação. Aceita o `SessionSummary`
 * (lista) OU um `SessionRecord` (cujo título é derivado dos blocos na hora).
 */
export function formatHistoryEntry(
  entry: {
    cwd: string;
    updatedAt: number;
    title?: string | undefined;
    blocks?: readonly SessionBlockLike[] | undefined;
    /**
     * EST-0972 (rename) — RÓTULO amigável da sessão. Quando presente, é o ROSTO do
     * item (vem antes do `data · cwd`) em vez do `1ª mensagem`; sem rótulo, o item
     * cai no formato antigo (`data · cwd · 1ª-msg`) — não regride o #86.
     */
    label?: string | undefined;
  },
  home?: string,
): string {
  const cwd = abbreviateCwd(entry.cwd, home ?? process.env.HOME ?? '');
  const label = entry.label?.trim();
  // EST-0972 — COM rótulo: `<nome> · data · cwd` (o nome é o rosto; o ● colorido é
  // desenhado pelo componente, fora desta string textual). SEM rótulo: o formato
  // antigo (`data · cwd · 1ª-msg`) — fallback intacto (#86).
  if (label) {
    return `${label} · ${shortDate(entry.updatedAt)} · ${cwd}`;
  }
  const title =
    entry.title ?? (entry.blocks ? titleOfBlocks(entry.blocks) : undefined) ?? '(sem objetivo)';
  return `${shortDate(entry.updatedAt)} · ${cwd} · ${title}`;
}

/**
 * Formata a lista do `/history` p/ o caminho LINEAR (não-TTY) e p/ o fallback de nota.
 * Lista vazia ⇒ a linha única "nenhuma sessão anterior." (mesma mensagem do picker).
 * Cada sessão vira DUAS linhas: o id (p/ retomar com `/history <id>`) e os metadados.
 * Só METADADOS — nunca o corpo (CLI-SEC-6). PURA.
 */
export function formatHistoryList(
  summaries: readonly SessionSummary[],
  home?: string,
): readonly string[] {
  if (summaries.length === 0) {
    return ['nenhuma sessão anterior.'];
  }
  const lines = ['sessões anteriores (retome com: /history <id>):', ''];
  for (const s of summaries) {
    lines.push(`  ${s.id}`);
    // EST-0972 — no não-TTY (sem cor) o rótulo ainda se distingue por um ● textual +
    // o nome (formatHistoryEntry já põe o nome à frente); sem rótulo, o ● não aparece.
    const dot = s.label?.trim() ? '● ' : '';
    lines.push(`    ${dot}${formatHistoryEntry(s, home)}`);
  }
  return lines;
}

/**
 * EST-0972 — a AÇÃO de retomada de uma sessão escolhida, REUSANDO o caminho do boot.
 * Restaura a TRANSCRIÇÃO visível (`restoreBlocks`) e SEMEIA o contexto do modelo
 * (`seedHistory(blocksToHistory(record.blocks))`) — o MESMO par que o `runSession`
 * aplica no `--resume`/auto-oferta. Troca o ALVO do auto-save (`switchSession`) p/ a
 * sessão escolhida continuar gravando no SEU arquivo (id + cwd + tier), espelha o cwd
 * no StatusBar e limpa a tela (a transcrição antiga substitui a corrente, sem lixo do
 * `<Static>`). NÃO dispara loop nem I/O de modelo — só prepara o próximo turno.
 *
 * As dependências são a fatia MÍNIMA do controller + 2 callbacks do run.tsx (trocar o
 * alvo do auto-save e limpar a tela) — assim a ação é testável sem Ink nem broker.
 */
export interface ResumeApplyDeps {
  /** Recoloca os blocos estáticos da sessão escolhida na tela. */
  restoreBlocks(blocks: readonly SessionBlockLike[]): void;
  /** Semeia o contexto do PRÓXIMO submit com o histórico reconstruído. */
  seedHistory(items: readonly HistoryItem[]): void;
  /**
   * HUNT-RESUME — zera o contexto de CONTINUAÇÃO da sessão de onde se SAIU
   * (`lastRunHistory`/`compactedSeed`/`budgetResumeHistory`) ANTES de semear a
   * retomada. Sem isto, um `/history` numa sessão que já teve turnos vazaria a
   * conversa anterior (e um `compactedSeed` pendente venceria a retomada) no próximo
   * turno. Opcional p/ não acoplar os testes/ chamadas que só exercitam a tela; no
   * BOOT (controller fresco) é no-op.
   */
  resetContinuation?(): void;
  /** Espelha o cwd da sessão retomada no StatusBar (abreviado). No-op se ausente. */
  setSessionCwd?(cwd: string): void;
  /**
   * Troca o ALVO do auto-save p/ a sessão escolhida (id/cwd/tier): a partir daqui a
   * sessão "É" a retomada — o próximo auto-save grava no arquivo dela, não num novo.
   */
  switchSession(target: { id: string; cwd: string; tier: string }): void;
  /** Limpa a tela + o `<Static>` (a transcrição antiga substitui a corrente). */
  clearScreen(): void;
}

/** Aceita os blocos do record sem acoplar este módulo ao tipo concreto do controller. */
type SessionBlockLike = SessionRecord['blocks'][number];

/**
 * Aplica a retomada de `record` AO VIVO. A ORDEM importa: trocamos o alvo do auto-save
 * ANTES de restaurar/semear, p/ que o primeiro auto-save disparado pela restauração já
 * caia no arquivo certo. `clearScreen` antecede o `restoreBlocks` (limpa o que havia,
 * depois pinta a transcrição retomada). Best-effort no espelho do cwd (não derruba a
 * retomada se a porta não existir).
 */
export function applyResumeRecord(record: SessionRecord, deps: ResumeApplyDeps): void {
  // 1) a partir daqui a sessão É a retomada (auto-save grava no arquivo dela).
  deps.switchSession({ id: record.id, cwd: record.cwd, tier: record.tier });
  // 1.5) HUNT-RESUME — zera o contexto de CONTINUAÇÃO da sessão de onde se SAIU
  // (lastRunHistory/compactedSeed/budgetResumeHistory) ANTES de semear a retomada.
  // Sem isto, retomar AO VIVO de uma sessão que já teve turnos prependaria a conversa
  // ANTERIOR (e um compactedSeed pendente venceria a própria retomada) no próximo
  // submit — vazamento de contexto entre sessões. No boot é no-op (controller fresco).
  deps.resetContinuation?.();
  // 2) tela limpa antes de pintar a transcrição antiga (some o lixo do <Static>).
  deps.clearScreen();
  // 3) restaura os blocos visíveis (já saneados/estáticos pelo store).
  deps.restoreBlocks(record.blocks);
  // 4) semeia o contexto do próximo turno (a conversa continua de onde parou).
  const seed: readonly HistoryItem[] = blocksToHistory(record.blocks);
  if (seed.length > 0) deps.seedHistory(seed);
  // 5) espelha o cwd da sessão retomada no StatusBar (se a porta existir).
  if (record.cwd.trim() !== '') deps.setSessionCwd?.(record.cwd);
}

/** Saída mínima p/ o `/history` linear (não-TTY) — `process.stdout` ou um fake. */
export interface HistoryLinearOut {
  write(chunk: string): void;
}

/** Dependências do `/history` linear: lê o store e, com um id, aplica a retomada. */
export interface HistoryLinearDeps {
  readonly store: Pick<SessionStore, 'list' | 'load'>;
  /** Aplica a retomada (mesma ação do TTY) quando um id válido é informado. */
  readonly resume: (record: SessionRecord) => void;
  /** Home p/ abreviar o cwd na listagem (injetável p/ teste). */
  readonly home?: string;
  /** Teto da lista (default `HISTORY_LIST_LIMIT`). */
  readonly limit?: number;
}

/**
 * EST-0972 — `/history` em modo NÃO-TTY (§9, DoD): sem picker. SEM id ⇒ LISTA as
 * sessões (id + metadados, recente-first); COM id (`/history <id>`) ⇒ carrega aquela
 * sessão e aplica a retomada (mesma `applyResumeRecord` do TTY) ou avisa se o id não
 * casa. Devolve `true` se TRATOU a linha (`/history` ou `/history …`) — o caller não a
 * manda p/ o agente como objetivo. NUNCA vaza o corpo da transcrição (CLI-SEC-6).
 */
export function runHistoryLinear(
  goal: string | undefined,
  out: HistoryLinearOut,
  deps: HistoryLinearDeps,
): boolean {
  const line = (goal ?? '').trim();
  if (line !== '/history' && !line.startsWith('/history ')) return false;
  const id = line === '/history' ? '' : line.slice('/history '.length).trim();

  if (id === '') {
    // sem id: lista as sessões (ou "nenhuma sessão anterior.").
    const summaries = selectHistorySessions(deps.store, deps.limit);
    for (const l of formatHistoryList(summaries, deps.home)) {
      out.write(`[history] ${l}\n`);
    }
    return true;
  }

  // `/history <id>`: carrega e retoma aquela sessão (fail-safe: id que não casa avisa).
  const record = deps.store.load(id);
  if (!record) {
    out.write(`[history] sessão não encontrada: ${id}\n`);
    return true;
  }
  deps.resume(record);
  out.write(`[history] sessão retomada: ${id} (${formatHistoryEntry(record, deps.home)})\n`);
  return true;
}
