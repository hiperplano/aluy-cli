// ADR 0006 — o PAINEL DE TAREFAS do rodapé (estilo "tarefas em segundo plano" do Claude Code).
// Mora ABAIXO do composer: nada do trabalho das tarefas entra na conversa. PURO nas contas
// (`buildPanelRows`), para o render e o orçamento de altura (inline e cockpit) usarem as mesmas.
//
// Regras:
//  · poucas tarefas ⇒ uma linha por tarefa (`▸ t1 rodando · bash ls -la · 12s`), com os
//    sub-agentes da tarefa aninhados (com brilho enquanto rodam);
//  · muitas (≥ 3) ou statusline `compact` ⇒ UMA linha (`3 tarefas · 2 rodando · ↓ ver`);
//    `↓` expande (↑↓ escolhe · enter abre o detalhe · p para · esc recolhe);
//  · statusline `hidden` ⇒ só a linha-resumo (e as aprovações, que nunca somem);
//  · aprovações pendentes sempre aparecem (caixa de entrada: `/a` aprova · `/n` nega).
//
// a11y: o estado SEMPRE vem em palavra; o glifo é só apoio.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { truncateToWidth } from '../markdown/table-layout.js';
import { DiffLine, diffLangOf } from './DiffView.js';
import { ChildLine, type SubAgentChildView } from './SubAgents.js';
import type { TaskRecord } from '@hiperplano/aluy-cli-core';

export const MAX_APPROVAL_ROWS = 2;
const MAX_EFFECT_LINES = 4;
/** A partir de quantas tarefas a lista recolhe numa linha só. */
export const COLLAPSE_AT = 3;
const MAX_CHILD_ROWS = 3;
/** Tarefas rodando que mantêm a linha viva mesmo com o painel recolhido. */
export const MAX_COLLAPSED_LIVE = 2;
const MAX_EXPANDED_TASKS = 6;

export interface ApprovalRow {
  readonly taskId: string;
  readonly summary: string;
  /** Efeito EXATO estruturado (diff multi-linha etc.); ausente ⇒ cai no `summary` quebrado. */
  readonly effect?: {
    readonly kind: string;
    readonly tool: string;
    readonly path?: string;
    readonly lines: readonly string[];
  };
}

/** Linhas de diff visíveis na caixa de aprovação (o resto vira `… +N linhas`). */
export const MAX_DIFF_ROWS = 10;

export type PanelRow =
  | { readonly kind: 'summary'; readonly text: string }
  | { readonly kind: 'header'; readonly total: number; readonly running: number }
  | { readonly kind: 'task'; readonly view: SubAgentChildView; readonly selected: boolean }
  | { readonly kind: 'child'; readonly child: SubAgentChildView }
  | { readonly kind: 'approval'; readonly text: string }
  | { readonly kind: 'diff'; readonly line: string; readonly lang?: string }
  | { readonly kind: 'text'; readonly text: string };

export interface PanelInput {
  readonly tasks: readonly TaskRecord[];
  readonly approvals: readonly ApprovalRow[];
  readonly childrenOf: (taskId: string) => readonly SubAgentChildView[];
  /** A tarefa na MESMA gramática de linha dos sub-agentes (nome, estado, modelo, tokens, tools, tempo). */
  readonly viewOf: (task: TaskRecord) => SubAgentChildView;
  /** Linhas que o rodapé comporta (recolhe SÓ quando falta espaço). */
  readonly maxRows?: number;
  /** Tarefa com o pedido de parada armado (aguarda a confirmação). */
  readonly stopArm?: string | null;
  readonly statusline: 'full' | 'compact' | 'hidden';
  readonly expanded: boolean;
  readonly selected: number;
  readonly now: number;
  /** Largura do terminal: a aprovação mostra o efeito EXATO, quebrado em linhas. */
  readonly columns?: number;
  /** `/a show`: o diff/efeito INTEIRO (até `fullRows` linhas) em vez do recorte. */
  readonly approvalFull?: boolean;
  readonly fullRows?: number;
  /** Encerradas recentes fora da lista (só contadas no resumo). */
  readonly hiddenEnded?: number;
}

/** `3 tarefas · 2 rodando · ↓ ver`. */
export function summaryText(
  tasks: readonly TaskRecord[],
  hint = true,
  /** Encerradas recentes que a lista não desenha (teto de linhas) mas que o resumo conta. */
  hiddenEnded = 0,
): string {
  const running = tasks.filter((t) => t.status === 'running').length;
  const waiting = tasks.filter((t) => t.status === 'waiting_approval').length;
  const total = tasks.length + hiddenEnded;
  const parts = [`${total} tarefa${total === 1 ? '' : 's'}`];
  if (running > 0) parts.push(`${running} rodando`);
  if (waiting > 0) parts.push(`${waiting} aguardando aprovação`);
  const paused = tasks.filter((t) => t.status === 'paused_quota').length;
  if (paused > 0) parts.push(`${paused} pausada${paused > 1 ? 's' : ''} (cota)`);
  const ended = tasks.filter((t) => t.endedAt !== undefined).length + hiddenEnded;
  if (ended > 0) parts.push(`${ended} encerrada${ended > 1 ? 's' : ''}`);
  if (hint) parts.push('↓ ver');
  return parts.join(' · ');
}

export function buildPanelRows(i: PanelInput): PanelRow[] {
  const rows: PanelRow[] = [];
  const tasks = i.tasks;
  if (tasks.length > 0) {
    const shown = i.expanded ? tasks.slice(-MAX_EXPANDED_TASKS) : tasks;
    const kidsOf = (t: TaskRecord): readonly SubAgentChildView[] =>
      t.endedAt === undefined ? i.childrenOf(t.id) : [];
    // Nível 1 = TAREFAS; nível 2 = os agentes da tarefa, na MESMA linha do clássico.
    const build = (withAgents: boolean): PanelRow[] => {
      const out: PanelRow[] = [
        {
          kind: 'header',
          total: tasks.length + (i.hiddenEnded ?? 0),
          running: tasks.filter((t) => t.status === 'running').length,
        },
      ];
      shown.forEach((t, idx) => {
        const kids = kidsOf(t);
        const v = i.viewOf(t);
        const view =
          !withAgents && kids.length > 0
            ? {
                ...v,
                summary: `${v.summary ?? ''} · ${kids.length} agente${kids.length > 1 ? 's' : ''}`,
              }
            : v;
        out.push({ kind: 'task', view, selected: i.expanded && idx === i.selected });
        if (withAgents)
          for (const c of kids.slice(0, MAX_CHILD_ROWS)) out.push({ kind: 'child', child: c });
      });
      return out;
    };
    const room = i.maxRows ?? 8;
    const compactOk = i.statusline === 'full';
    let list = build(true);
    // Falta espaço? Primeiro recolhe os AGENTES (a tarefa ganha `· N agentes`, com brilho);
    // só se nem as tarefas couberem vira a linha-resumo.
    if (!i.expanded && list.length > room) list = build(false);
    const collapse = !i.expanded && (!compactOk || list.length > room);
    if (collapse) {
      rows.push({ kind: 'summary', text: summaryText(tasks, true, i.hiddenEnded ?? 0) });
      // Sinal de vida: a linha-resumo é texto parado. Com `compact` (ou sem espaço) quem RODA
      // segue com a sua linha (brilho + atividade + tempo), no máximo MAX_COLLAPSED_LIVE.
      // `hidden` é o pedido explícito de silêncio: só o resumo.
      if (i.statusline !== 'hidden') {
        tasks
          .filter((t) => t.status === 'running')
          .slice(0, MAX_COLLAPSED_LIVE)
          .forEach((t) => rows.push({ kind: 'task', view: i.viewOf(t), selected: false }));
      }
    } else {
      rows.push(...list);
      if (i.expanded) {
        rows.push({
          kind: 'text',
          text:
            i.stopArm !== undefined && i.stopArm !== null
              ? `ctrl+k de novo PARA ${i.stopArm} · qualquer outra tecla cancela`
              : '↑↓ escolhe · enter detalhes · ctrl+k para a tarefa (confirma) · esc recolhe · digitar sai do painel',
        });
      }
    }
  }
  const width = Math.max(30, (i.columns ?? 100) - 8);
  i.approvals.slice(0, MAX_APPROVAL_ROWS).forEach((a) => {
    if (a.effect?.kind === 'diff') {
      pushDiffApproval(rows, a, i);
      return;
    }
    // 1ª linha: quem pede e como responder; abaixo, o efeito EXATO (até 4 linhas, quebrado).
    rows.push({
      kind: 'approval',
      text: `⚠ ${a.taskId} pede aprovação  ·  /a aprova · /a! sempre na tarefa · /n nega`,
    });
    const chunks: string[] = [];
    for (let k = 0; k < a.summary.length; k += width) chunks.push(a.summary.slice(k, k + width));
    chunks.slice(0, MAX_EFFECT_LINES).forEach((c, idx) =>
      rows.push({
        kind: 'approval',
        text: `   ${c}${idx === MAX_EFFECT_LINES - 1 && chunks.length > MAX_EFFECT_LINES ? '…' : ''}`,
      }),
    );
  });
  if (i.approvals.length > MAX_APPROVAL_ROWS) {
    rows.push({
      kind: 'approval',
      text: `  …+${i.approvals.length - MAX_APPROVAL_ROWS} na caixa de aprovações`,
    });
  }
  return rows;
}

/** Diff multi-linha: cabeçalho com o arquivo, linhas -/+ (recorte) e `… +N linhas`. */
function pushDiffApproval(rows: PanelRow[], a: ApprovalRow, i: PanelInput): void {
  const eff = a.effect!;
  const lines = [...eff.lines];
  // O cabeçalho `--- x` / `+++ x` do unified diff vira o título (o arquivo já está nele).
  if (lines[0]?.startsWith('--- ') && lines[1]?.startsWith('+++ ')) lines.splice(0, 2);
  const path = eff.path ?? 'arquivo';
  rows.push({
    kind: 'approval',
    text: `⚠ ${a.taskId} pede aprovação · ${eff.tool} ${path}  ·  /a aprova · /a! sempre na tarefa · /n nega`,
  });
  const cap = i.approvalFull === true ? Math.max(MAX_DIFF_ROWS, i.fullRows ?? 30) : MAX_DIFF_ROWS;
  const lang = path.includes('.') ? path.split('.').pop() : undefined;
  const w = Math.max(30, (i.columns ?? 100) - 10);
  lines.slice(0, cap).forEach((line) =>
    rows.push({
      kind: 'diff',
      line: line.length > w ? `${line.slice(0, w - 1)}…` : line,
      ...(lang !== undefined ? { lang } : {}),
    }),
  );
  if (lines.length > cap) {
    rows.push({
      kind: 'approval',
      text: `   … +${lines.length - cap} linhas · /a show ver tudo`,
    });
  } else if (i.approvalFull === true && lines.length > MAX_DIFF_ROWS) {
    rows.push({ kind: 'approval', text: '   (diff inteiro) · /a show recolhe' });
  }
}

/** Linhas fixas da região viva fora a vista de detalhe e o painel (container, composer, status, hints). */
export const LIVE_OVERHEAD_ROWS = 16;

/**
 * Altura útil da vista de DETALHE (blocos) dado o terminal: a região viva inteira
 * (`room + 3` da vista + painel + o resto) NUNCA passa de `rows`. Se passar, o terminal rola,
 * o Ink só apaga o que ainda está na tela e, ao fechar, sobra um BURACO em branco.
 */
export function taskDetailRoomFor(rows: number, panelRows: number): number {
  // -1: a região viva tem de ficar ESTRITAMENTE abaixo de `rows` (com `>= rows` o Ink limpa o
  // terminal inteiro e some a conversa acima).
  return Math.max(2, Math.min(22, rows - LIVE_OVERHEAD_ROWS - panelRows - 3 - 1));
}

/** Altura (linhas) do painel — sem respiro: statusline e painel ficam juntos. 0 se vazio. */
export function panelLines(rows: readonly PanelRow[]): number {
  return rows.length;
}

export interface TaskPanelProps {
  readonly rows: readonly PanelRow[];
  readonly columns: number;
  readonly frame: number;
}

export function TaskPanel(props: TaskPanelProps): React.ReactElement | null {
  if (props.rows.length === 0) return null;
  const width = Math.max(30, props.columns - 4);
  return (
    // MARGEM À DIREITA: a largura do painel é `columns - 3` (e não a tela inteira). A conta de largura
    // do Ink (`string-width`) e a do terminal divergem em alguns glifos (ambíguos, emoji, tab); uma
    // linha que o Ink acha caber em `columns` mas o terminal desenha 1–2 células mais larga QUEBRA
    // fisicamente, o Ink apaga 1 linha a menos a cada quadro e o topo do rodapé fica para trás (a
    // frase de trabalho repetida no histórico, uma por tick). Com folga, o erro não chega a quebrar.
    <Box flexDirection="column" paddingLeft={2} width={Math.max(20, props.columns - 3)}>
      {props.rows.map((r, idx) => {
        switch (r.kind) {
          case 'summary':
            return (
              <Box key={idx}>
                <Role name="depth">{truncateToWidth(r.text, width)}</Role>
              </Box>
            );
          case 'header':
            return (
              <Box key={idx} paddingLeft={0}>
                <Glyph name="subagents" role="accent" />
                <Role name="fg">
                  {' '}
                  {r.total} tarefa{r.total === 1 ? '' : 's'}:
                </Role>
                {r.running > 0 && <Role name="fgDim">{` (${r.running} rodando)`}</Role>}
              </Box>
            );
          case 'task':
            return (
              <Box key={idx} height={1} overflow="hidden">
                {/* Mesma linha dos sub-agentes (brilho enquanto roda); o marcador só no expandido. */}
                {r.selected && <Role name="accent">❯</Role>}
                <ChildLine child={r.view} frame={props.frame} />
              </Box>
            );
          case 'child':
            return (
              <Box key={idx} paddingLeft={2} height={1} overflow="hidden">
                <ChildLine child={r.child} frame={props.frame} />
              </Box>
            );
          case 'approval':
            return (
              <Box key={idx}>
                <Role name="accent">{truncateToWidth(r.text, width)}</Role>
              </Box>
            );
          case 'diff':
            return (
              <Box key={idx} paddingLeft={3}>
                <DiffLine line={r.line} lang={diffLangOf(r.lang ? `x.${r.lang}` : undefined)} />
              </Box>
            );
          case 'text':
            return (
              <Box key={idx}>
                <Text dimColor>{truncateToWidth(r.text, width)}</Text>
              </Box>
            );
        }
      })}
    </Box>
  );
}
