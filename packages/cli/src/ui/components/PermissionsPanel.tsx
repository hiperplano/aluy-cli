// EST-0968 · CLI-SEC-3 — <PermissionsPanel>: o painel INTERATIVO do `/permissions`.
//
// O pedido do Tiago: hoje o `/permissions` so MOSTRA; ele quer MUDAR. Este painel
// reusa a mecanica dos pickers (↑↓ navega · enter age · esc fecha) e deixa o usuario
// mudar o que e SEGURO mudar — e mostra TRAVADO o que CLI-SEC-3 nao deixa relaxar.
//
// O que o painel deixa mudar (estado de sessao, nunca persistido):
//   - MODO: plan / normal / unsafe (mesmo eixo do Tab/ModeIndicator).
//   - DEFAULT de tools SEGURAS (read-only): allow ⇄ ask.
//   - GRANTS de sessao ("sempre nesta sessao"): REVOGAR (so restritivo).
//
// O que FICA TRAVADO (mostrado, nunca acionavel — a proteca anti-injecao):
//   - destrutivo, rede, escalada, exec-de-pacote, config/startup, escrita-fora,
//     leitura de segredos ⇒ sempre-ask. Leitura do journal ~/.aluy/ ⇒ deny (acima
//     ate do --yolo). Cada uma com a explicacao "so via --yolo, com o aviso
//     vermelho". NAO ha caminho no painel que sete uma dessas p/ allow.
//     (EST-0959: a flag e `--yolo`; o modo INTERNO continua `'unsafe'`.)
//
// Apresentacao PURA (papeis do DS, nunca cor crua; glifo+palavra p/ a11y). A captura
// de teclas e a acao vivem na App + no usePermissionsPanel.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import type { PanelRow } from '../hooks/usePermissionsPanel.js';
import type { SessionMode } from '@hiperplano/aluy-cli-core';
import { windowAround } from '../window.js';
import { displayWidth } from '../../session/visual-lines.js';

export interface PermissionsPanelProps {
  readonly rows: readonly PanelRow[];
  /** Indice da linha selecionada (navegada por ↑↓). */
  readonly selected: number;
  /** Modo de sessao corrente (p/ a legenda do topo). */
  readonly mode: SessionMode;
  readonly columns?: number;
  /**
   * Max. de linhas visiveis (janela centrada na selecionada). Os GRANTS de sessao
   * acumulam ("sempre nesta sessao") numa sessao longa em modo normal, entao o painel
   * pode passar de `rows` ⇒ o Ink cai no caminho full-screen (`outputHeight>=rows`,
   * clearTerminal por frame) ⇒ flicker no Windows. MESMO padrao do <HistoryPicker>.
   * Default 14 (auto-seguro sem o cap do caller).
   */
  readonly maxRows?: number;
}

/** Palavra do modo (a11y: a palavra carrega o sentido, nao so a cor). */
const MODE_WORD: Readonly<Record<SessionMode, string>> = {
  plan: 'PLAN (read-only)',
  normal: 'NORMAL (catraca padrão)',
  // EST-0959 — nome de PRODUTO do modo `unsafe` e YOLO (`--yolo`).
  unsafe: 'YOLO (aprovação DESLIGADA)',
};

/** Cabecalho de secao injetado quando o tipo de linha muda. */
function sectionHeader(kind: PanelRow['kind']): string {
  switch (kind) {
    case 'mode':
      return 'modo de sessão · enter cicla plan → normal → yolo';
    case 'safe-tool':
      return 'tools seguras (leitura) · enter alterna allow ⇄ ask';
    case 'grant':
      return 'liberados nesta sessão · enter REVOGA';
    case 'locked':
      return 'TRAVADO por segurança · só via --yolo';
  }
}

/** Render de UMA linha conforme o seu tipo. */
function Row(props: { row: PanelRow; sel: boolean }): React.ReactElement {
  const { row, sel } = props;
  const cursor = <Role name={sel ? 'accent' : 'fgDim'}>{sel ? '› ' : '  '}</Role>;
  switch (row.kind) {
    case 'mode':
      return (
        <Box>
          {cursor}
          <Role name={sel ? 'accent' : 'fg'}>modo: </Role>
          <Role name={row.mode === 'unsafe' ? 'danger' : sel ? 'accent' : 'fg'}>
            {MODE_WORD[row.mode]}
          </Role>
        </Box>
      );
    case 'safe-tool':
      return (
        <Box>
          {cursor}
          <Role name={sel ? 'accent' : 'fg'}>{row.tool}</Role>
          <Role name="fgDim"> = </Role>
          <Role name={row.decision === 'allow' ? 'success' : 'fgDim'}>{row.decision}</Role>
        </Box>
      );
    case 'grant':
      return (
        <Box>
          {cursor}
          <Role name="success">● </Role>
          <Role name={sel ? 'accent' : 'fg'}>{row.grantKey}</Role>
          <Role name="fgDim"> (enter revoga)</Role>
        </Box>
      );
    case 'locked': {
      // a11y: glifo de atencao + a PALAVRA "travado" (nao depende so de cor).
      const isDeny = row.category.lock === 'deny';
      return (
        <Box flexDirection="column">
          <Box>
            {cursor}
            <Glyph name="ask" role="danger" />
            <Role name="danger"> [travado] </Role>
            <Role name={sel ? 'accent' : 'fg'}>{row.category.label}</Role>
            <Role name="danger"> · {isDeny ? 'deny (nem --yolo)' : 'sempre pergunta'}</Role>
          </Box>
          {sel && (
            <Box paddingLeft={4}>
              <Role name="fgDim">{row.category.why}</Role>
            </Box>
          )}
        </Box>
      );
    }
  }
}

export function PermissionsPanel(props: PermissionsPanelProps): React.ReactElement {
  // F88 (anti-flicker, Windows) — JANELA as linhas: grants acumulam ⇒ o painel cresce.
  const maxRows = Math.max(1, props.maxRows ?? 14);
  // F89 (wrap-aware) — altura visual por linha (estimativa por tipo: prefixo + rótulos +
  // texto), quebrando em `ceil(largura / columns)`. Sem `columns`, janela por item.
  const cols = props.columns;
  const rowWidth = (row: PanelRow): number => {
    switch (row.kind) {
      case 'mode':
        return 8 + displayWidth(MODE_WORD[row.mode]);
      case 'safe-tool':
        return 5 + displayWidth(row.tool) + displayWidth(row.decision);
      case 'grant':
        return 19 + displayWidth(row.grantKey);
      case 'locked':
        return 28 + displayWidth(row.category.label);
    }
  };
  const rowHeight =
    cols !== undefined && cols > 0
      ? (row: PanelRow): number => Math.max(1, Math.ceil(rowWidth(row) / cols))
      : undefined;
  const { start, slice } = windowAround(props.rows, props.selected, maxRows, rowHeight);
  let lastKind: PanelRow['kind'] | null = null;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">permissoes · ↑↓ navega · enter muda · esc fecha</Role>
      </Box>
      <Box>
        <Role name="fgDim">modo atual: </Role>
        <Role name={props.mode === 'unsafe' ? 'danger' : 'fg'}>{MODE_WORD[props.mode]}</Role>
      </Box>
      {props.rows.length === 0 ? (
        <Box>
          <Role name="fgDim"> nada a mostrar</Role>
        </Box>
      ) : (
        <>
          {start > 0 && (
            <Box>
              <Role name="fgDim"> ↑ {start} acima</Role>
            </Box>
          )}
          {slice.map((row, i) => {
            const absI = start + i;
            const header = row.kind !== lastKind ? sectionHeader(row.kind) : null;
            lastKind = row.kind;
            return (
              <React.Fragment key={rowKey(row, absI)}>
                {header && (
                  <Box paddingTop={1}>
                    <Role name="fgDim">─── {header}</Role>
                  </Box>
                )}
                <Row row={row} sel={absI === props.selected} />
              </React.Fragment>
            );
          })}
          {start + slice.length < props.rows.length && (
            <Box>
              <Role name="fgDim"> ↓ {props.rows.length - (start + slice.length)} abaixo</Role>
            </Box>
          )}
        </>
      )}
      {/* lembrete do unico bypass total (a estoria: travado nao vira allow pelo menu) */}
      <Box paddingTop={1}>
        <Text> </Text>
      </Box>
      <Box>
        <Role name="fgDim">
          o painel não relaxa as categorias travadas — o único bypass total é --yolo
        </Role>
      </Box>
    </Box>
  );
}

/** Chave estavel de uma linha p/ o React (evita re-montagem na navegacao). */
function rowKey(row: PanelRow, i: number): string {
  switch (row.kind) {
    case 'mode':
      return 'mode';
    case 'safe-tool':
      return `safe:${row.tool}`;
    case 'grant':
      return `grant:${row.grantKey}`;
    case 'locked':
      return `locked:${row.category.category}`;
    default:
      return `row:${i}`;
  }
}
