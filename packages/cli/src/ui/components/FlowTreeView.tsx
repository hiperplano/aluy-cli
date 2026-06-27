// EST-0982 · ADR-0063 — <FlowTreeView>: o painel de CONTROLE/OBSERVABILIDADE da
// árvore de fluxos (VER · PARAR · INTERAGIR + contabilidade tokens+tempo).
//
// Dois modos:
//   • OVERVIEW — a árvore (pai + sub-agentes): por nó, origem + fase + contabilidade
//     (tokens·tools·tempo). ↑↓ navega; enter faz DRILL-IN; `p` PARA o nó; `P` PARA todos.
//   • DRILL-IN — UM nó focado: fase + ATIVIDADE recente (tool-calls JÁ REDIGIDOS —
//     RES-C-1/CLI-SEC-6) + contabilidade. SEM interleave (uma visão FOCADA).
//
// RES-C-1 (a prova na UI): este componente SÓ exibe o que o controlador derivou da
// `FlowTree`/`drillIn`, que JÁ aplicou `redactCommandSecrets` na atividade. Não há aqui
// nenhum caminho p/ um "stream cru" — segredo redigido na resposta segue redigido aqui;
// journal/memória nunca aparecem (a árvore só conhece ATIVIDADE, nunca conteúdo confinado).
//
// Apresentação PURA (papéis do DS, nunca cor crua; glifo+palavra p/ a11y). A captura de
// teclas/ações vive na App. PORTÁVEL quanto à UI: nada de I/O — só renderiza props.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { abbreviateCount, formatDuration } from '../../session/model.js';
import { displayWidth } from '../../session/visual-lines.js';
import type { FlowSummary, FlowDrillIn, FlowPhase, FlowActivity } from '@aluy/cli-core';
import { windowAround } from '../window.js';

export interface FlowTreeViewProps {
  /** A visão GERAL (todos os nós) — usada no modo overview. */
  readonly overview: readonly FlowSummary[];
  /** Índice selecionado no overview (↑↓). */
  readonly selected: number;
  /** Quando presente, o painel está em DRILL-IN deste nó (atividade ao vivo). */
  readonly drillIn?: FlowDrillIn | undefined;
  /**
   * Máx. de nós visíveis no OVERVIEW (janela centrada no selecionado). A árvore retém
   * até `MAX_TERMINAL_NODES` (32) terminais + os vivos, então o overview pode passar de
   * `rows` numa sessão pesada (muitos sub-agentes) ⇒ o Ink cairia no caminho full-screen
   * (`outputHeight>=rows`, clearTerminal por frame) ⇒ flicker no Windows. O DRILL-IN já é
   * limitado no core (`MAX_RECENT`=12). Default 10 (auto-seguro sem o cap do caller).
   */
  readonly maxRows?: number;
  /** F89 (wrap-aware) — largura do terminal; janela por LINHAS VISUAIS em cols estreito. */
  readonly columns?: number;
}

/** Palavra da fase (a11y: a palavra carrega o sentido, não só o glifo). */
const PHASE_WORD: Readonly<Record<FlowPhase, string>> = {
  thinking: 'pensando',
  tool: 'rodando tool',
  asking: 'aguardando confirmação',
  done: 'concluído',
  cancelled: 'parado',
  failed: 'falhou',
};

/** Papel de cor da fase (DS): vivo=accent, ok=success, parado=fgDim, falha=danger. */
function phaseRole(phase: FlowPhase): 'accent' | 'success' | 'fgDim' | 'danger' {
  switch (phase) {
    case 'done':
      return 'success';
    case 'cancelled':
      return 'fgDim';
    case 'failed':
      return 'danger';
    default:
      return 'accent';
  }
}

/** `74.4k tokens · 13 tools · 2.1s` — a contabilidade compacta de um nó (estilo Claude Code). */
function accountingText(acc: {
  readonly tokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
}): string {
  const parts = [`${abbreviateCount(acc.tokens)} tokens`];
  if (acc.toolCalls > 0) parts.push(`${acc.toolCalls} tools`);
  parts.push(formatDuration(acc.durationMs));
  return parts.join(' · ');
}

/** Uma linha do OVERVIEW: `▸ [rust] ◷ pensando · 12.3k tokens · 3 tools · 1.4s`. */
function OverviewRow(props: {
  readonly node: FlowSummary;
  readonly focused: boolean;
}): React.ReactElement {
  const n = props.node;
  const indent = n.kind === 'root' ? 0 : 2;
  const marker = props.focused ? '▸' : ' ';
  return (
    <Box paddingLeft={indent}>
      <Role name={props.focused ? 'accent' : 'fgDim'}>{marker} </Role>
      <Role name="accent">[{n.label}]</Role>
      <Text> </Text>
      <Role name={phaseRole(n.phase)}>{PHASE_WORD[n.phase]}</Role>
      <Role name="fgDim"> · {accountingText(n.accounting)}</Role>
    </Box>
  );
}

/** O modo OVERVIEW: a árvore (JANELADA p/ caber em `rows`) + a legenda de atalhos. */
function Overview(props: FlowTreeViewProps): React.ReactElement {
  const maxRows = Math.max(1, props.maxRows ?? 10);
  // F89 (wrap-aware) — altura visual de cada nó: indent (0/2) + `  [label] fase · contab`,
  // quebrando em `ceil(largura / columns)`. Sem `columns`, janela por item (tela larga).
  const cols = props.columns;
  const rowHeight =
    cols !== undefined && cols > 0
      ? (n: FlowSummary): number => {
          const indent = n.kind === 'root' ? 0 : 2;
          const w =
            indent +
            displayWidth(`  [${n.label}] ${PHASE_WORD[n.phase]} · ${accountingText(n.accounting)}`);
          return Math.max(1, Math.ceil(w / cols));
        }
      : undefined;
  const { start, slice } = windowAround(props.overview, props.selected, maxRows, rowHeight);
  return (
    <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
      <Box>
        <Glyph name="subagents" role="accent" />
        <Role name="fg"> árvore de fluxos — ver · parar · interagir</Role>
      </Box>
      {slice.map((n, i) => (
        <OverviewRow key={n.id} node={n} focused={start + i === props.selected} />
      ))}
      {props.overview.length > slice.length && (
        <Box>
          <Role name="fgDim"> … {props.overview.length - slice.length} nós a mais (↑↓ rola)</Role>
        </Box>
      )}
      <Box paddingTop={1}>
        <Role name="fgDim">
          ↑↓ navega · enter: ver · p: parar este · P: parar todos · i: interagir · esc: fecha
        </Role>
      </Box>
    </Box>
  );
}

/**
 * EST-0982 (Fase 0) — UMA linha de atividade no drill-in/ActivityLog, agora COM o DADO
 * RICO quando presente: duração por evento, resumo REDIGIDO, diffstat (`+/−`), tokens.
 * TODOS os campos novos são guardados (`!== undefined`) — ausência = NÃO mostra (degrada
 * com graça; a árvore antiga, sem os campos, renderiza exatamente como antes). O `target`/
 * `summary`/`tail` JÁ vêm REDIGIDOS do core (RES-C-1) — exibidos como-estão.
 */
function ActivityRow(props: { readonly activity: FlowActivity }): React.ReactElement {
  const a = props.activity;
  // Metainfo compacta à direita (duração · diffstat · tokens), só os campos presentes.
  const meta: string[] = [];
  if (a.durationMs !== undefined) meta.push(formatDuration(a.durationMs));
  if (a.added !== undefined || a.removed !== undefined) {
    meta.push(`+${a.added ?? 0}/−${a.removed ?? 0}`);
  }
  if (a.tokens !== undefined) meta.push(`${abbreviateCount(a.tokens)} tok`);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        {a.running ? (
          <Glyph name="clock" role="depth" />
        ) : a.ok ? (
          <Glyph name="ok" role="success" />
        ) : (
          <Glyph name="err" role="danger" />
        )}
        <Text> </Text>
        <Role name="fg">{a.tool}</Role>
        {a.target !== '' && <Role name="fgDim"> {a.target}</Role>}
        <Text> </Text>
        {/* Resumo REDIGIDO quando presente (`48 linhas`/`exit 0`); senão o estado cru. */}
        <Role name={a.running ? 'fgDim' : a.ok ? 'success' : 'danger'}>
          {a.summary && a.summary !== '' ? a.summary : a.running ? 'rodando' : a.ok ? 'ok' : 'erro'}
        </Role>
        {meta.length > 0 && <Role name="fgDim"> · {meta.join(' · ')}</Role>}
      </Box>
      {/* TAIL ao vivo (já redigido) de um comando em curso — últimas linhas, indentado. */}
      {a.running && a.tail !== undefined && a.tail !== '' && (
        <Box paddingLeft={4}>
          <Role name="fgDim">{a.tail}</Role>
        </Box>
      )}
    </Box>
  );
}

/** O modo DRILL-IN: um nó focado, sua atividade REDIGIDA e contabilidade. */
function DrillIn(props: { readonly node: FlowDrillIn }): React.ReactElement {
  const n = props.node;
  return (
    <Box flexDirection="column" paddingLeft={2} paddingBottom={1}>
      <Box>
        <Glyph name="subagents" role="accent" />
        <Role name="fg"> </Role>
        <Role name="accent">[{n.label}]</Role>
        <Text> </Text>
        <Role name={phaseRole(n.phase)}>{PHASE_WORD[n.phase]}</Role>
        <Role name="fgDim"> · {accountingText(n.accounting)}</Role>
      </Box>
      {n.recent.length === 0 ? (
        <Box paddingLeft={2}>
          <Role name="fgDim">sem atividade recente.</Role>
        </Box>
      ) : (
        n.recent.map((a, i) => <ActivityRow key={`${a.tool}:${i}`} activity={a} />)
      )}
      <Box paddingTop={1}>
        <Role name="fgDim">p: parar este · i: interagir · esc/enter: volta à árvore</Role>
      </Box>
    </Box>
  );
}

export function FlowTreeView(props: FlowTreeViewProps): React.ReactElement {
  return props.drillIn ? <DrillIn node={props.drillIn} /> : <Overview {...props} />;
}
