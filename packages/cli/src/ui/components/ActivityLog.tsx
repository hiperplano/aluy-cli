// EST-0990 — <ActivityLog>: a coluna do LOG no MODO VIEW AVANÇADO (split CHAT | LOG),
// Variação V2 (AGRUPADO POR AGENTE). Apresentação PURA (papéis do DS, glifo+palavra
// p/ a11y; nada de cor crua). Lê a PROJEÇÃO da `FlowTree` (`buildActivityLog`) — o
// `<FlowTreeView>` do Ctrl+T fica como está (referência de estilo/glifos).
//
// RES-C-1 (a prova na UI): este componente SÓ exibe `LogEvent`/`LogSection` derivados
// da `FlowTree`/`drillIn`, que JÁ aplicaram `redactCommandSecrets` na atividade. Não há
// aqui nenhum caminho p/ um "stream cru": um segredo na linha de comando já chegou
// `‹redigido›`. Log = passivo "o que aconteceu" (Ctrl+T = ativo "o que fazer").
//
// ANTI-FLICKER: a janela visível é a CAUDA (`▼ ao vivo`) que cabe em `visibleRows`
// linhas VISUAIS; o que sai pela cauda rola no ANEL em memória (não no scrollback do
// chat). Nenhuma coluna escreve a tela toda. O teto de altura é orçado por
// `split-budget.ts` (as duas colunas vivas compartilham a altura do frame).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { abbreviateCount, formatDuration } from '../../session/model.js';
import { displayWidth } from '../../session/visual-lines.js';
import { truncateToWidth } from '../markdown/table-layout.js';
import type { LogSection, LogEvent } from '../../session/activity-log.js';
import type { FlowPhase } from '@hiperplano/aluy-cli-core';

export interface ActivityLogProps {
  /** As seções projetadas (uma por nó da árvore) — `buildActivityLog`. */
  readonly sections: readonly LogSection[];
  /**
   * Teto de linhas VISUAIS da coluna (a janela `▼ ao vivo`). Orçado por `split-budget`
   * (`LOG_VISIBLE_ROWS`). A cauda que cabe é exibida; o topo rola no anel.
   */
  readonly visibleRows: number;
  /** Deslocamento de rolagem (foco no log + ↑↓). 0 = colado na cauda (`▼ ao vivo`). */
  readonly scrollOffset: number;
  /** `true` quando o LOG está com o FOCO (rótulo em accent; passivo em fgDim). */
  readonly focused: boolean;
  /** Largura (colunas) da coluna — p/ elidir alvos longos sem estourar o wrap. */
  readonly columns?: number;
  /**
   * EST-1015 (cockpit idle) — DIAGNÓSTICO de boot (`config`/`agentes`) a mostrar no
   * EMPTY-STATE (sem atividade ainda), preenchendo a região de LOG que antes ficava
   * barren. SÓ o Cockpit passa isto; o split inline NÃO (default ausente ⇒ intacto).
   * Some assim que há atividade real (a árvore toma a região). Cada item = 1 nota.
   */
  readonly bootInfo?: readonly { readonly title: string; readonly lines: readonly string[] }[];
}

/** Palavra da fase (a11y — espelha o FlowTreeView). */
const PHASE_WORD: Readonly<Record<FlowPhase, string>> = {
  thinking: 'pensando',
  tool: 'rodando',
  asking: 'confirmando',
  done: 'ok',
  cancelled: 'parado',
  failed: 'falhou',
};

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

/** Glifo + papel de cor de um evento, pelo seu tipo/status (cores por papel do DS). */
function eventGlyph(e: LogEvent): {
  glyph: Parameters<typeof Glyph>[0]['name'];
  role: 'success' | 'danger' | 'depth' | 'accent' | 'fgDim';
} {
  if (e.kind === 'spawn') return { glyph: 'subagents', role: 'depth' };
  if (e.kind === 'broker') return { glyph: 'broker', role: 'depth' };
  if (e.kind === 'deny') return { glyph: 'err', role: 'danger' };
  if (e.kind === 'ask') return { glyph: 'ask', role: 'accent' };
  // tool: pelo status.
  if (e.status === 'running') return { glyph: 'toolInflight', role: 'fgDim' };
  if (e.status === 'err') return { glyph: 'err', role: 'danger' };
  return { glyph: 'tool', role: 'success' };
}

/** Elide um detalhe (comando/path) p/ caber na coluna (sem quebrar o frame).
 * FIX (HUNT-RENDER): mede e corta por LARGURA DE EXIBIÇÃO (não `.length`), respeitando
 * code points. Antes `detail.length`/`slice` deixava um path/comando com CJK ocupar o
 * DOBRO das colunas reservadas (cada CJK = 2 cols) ⇒ re-fluía/wrap ⇒ flicker; e partia
 * emoji/astral no corte. `truncateToWidth` já põe `…` e nunca parte um code point. */
function elide(detail: string, max: number): string {
  if (max <= 1) return detail;
  return truncateToWidth(detail, max);
}

/**
 * EST-1000 — METAINFO compacta de um evento (só os campos PRESENTES — degrada quando
 * ausente): `+12 −4 · 2.1s · 1.2k tok`. Mono pros números (densidade do DS). Espelha o
 * `FlowTreeView.ActivityRow` (uma fonte de verdade conceitual, duas vistas). O sinal `−`
 * (minus) é o U+2212 (alinha com `+`), não o hífen.
 */
function eventMeta(e: LogEvent): string {
  const parts: string[] = [];
  if (e.added !== undefined || e.removed !== undefined) {
    parts.push(`+${e.added ?? 0} −${e.removed ?? 0}`);
  }
  if (e.durationMs !== undefined) parts.push(formatDuration(e.durationMs));
  if (e.tokens !== undefined) parts.push(`${abbreviateCount(e.tokens)} tok`);
  return parts.join(' · ');
}

/** `74.4k · 6 tools` — a contabilidade compacta da seção (estilo Claude Code). */
function sectionStat(s: LogSection): string {
  const parts = [abbreviateCount(s.tokens)];
  if (s.toolCalls > 0) parts.push(`${s.toolCalls} tools`);
  parts.push(formatDuration(s.durationMs));
  return parts.join(' · ');
}

/** Papel de cor do status do evento (DS): running=fgDim, err=danger, senão success. */
function statusRole(s: LogEvent['status']): 'fgDim' | 'danger' | 'success' {
  if (s === 'running') return 'fgDim';
  if (s === 'err') return 'danger';
  return 'success';
}

/** Palavra do status (a11y — o resumo redigido, se houver, fala mais alto que ela). */
function statusWord(s: LogEvent['status']): string {
  if (s === 'running') return 'rodando';
  if (s === 'err') return 'erro';
  return 'ok';
}

/**
 * EST-1000 — uma linha de evento, agora COM o DADO RICO (#142) quando presente:
 * `⏺ bash · <alvo> · 48 linhas · +12 −4 · 2.1s · 1.2k tok` (+ tail ao vivo se rodando).
 * Tudo REDIGIDO na origem (RES-C-1). Campos ausentes não aparecem (degrada com graça).
 * No painel ESTREITO (cockpit ~30%, split lado-a-lado) a linha QUEBRA em linhas visuais
 * (`<Text wrap="wrap">`) — nada estoura o frame; a janela é bounded por `visibleRows`.
 */
function EventRow(props: { readonly event: LogEvent; readonly cols: number }): React.ReactElement {
  const e = props.event;
  const g = eventGlyph(e);
  // 2 (indent) + glifo + espaço + label; o resto p/ o detalhe.
  // FIX (HUNT-RENDER): largura do label por displayWidth (CJK = 2 cols), não `.length` —
  // senão um label largo subestimava o espaço gasto e o detalhe estourava a coluna.
  const detailRoom = Math.max(4, props.cols - 4 - displayWidth(e.label) - 1);
  const meta = eventMeta(e);
  // Resumo REDIGIDO quando presente (`48 linhas`/`exit 0`); senão a palavra de status.
  const summary = e.summary !== undefined && e.summary !== '' ? e.summary : statusWord(e.status);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text wrap="wrap">
          <Glyph name={g.glyph} role={g.role} />
          <Text> </Text>
          <Role name="fg">{e.label}</Role>
          {e.detail !== '' && <Role name="fgDim"> {elide(e.detail, detailRoom)}</Role>}
          <Text> · </Text>
          <Role name={statusRole(e.status)}>{summary}</Role>
          {meta !== '' && <Role name="fgDim"> · {meta}</Role>}
        </Text>
      </Box>
      {/* TAIL ao vivo (já redigido) de um comando em curso — última linha, indentada. */}
      {e.status === 'running' && e.tail !== undefined && e.tail !== '' && (
        <Box paddingLeft={4}>
          <Role name="fgDim">{elide(e.tail, Math.max(4, props.cols - 4))}</Role>
        </Box>
      )}
    </Box>
  );
}

/** Uma SEÇÃO: cabeçalho do nó (`▼ [root] · 18.4k · 6 tools`) + eventos (se expandida). */
function Section(props: {
  readonly section: LogSection;
  readonly cols: number;
}): React.ReactElement {
  const s = props.section;
  const indent = s.kind === 'root' ? 0 : 1;
  return (
    <Box flexDirection="column" paddingLeft={indent}>
      <Box>
        {/* ▼ expandido / ▶ colapsado — o marcador é DADO (não só cor). */}
        <Role name="fgDim">{s.collapsed ? '▶' : '▼'} </Role>
        <Role name="accent">[{s.label}]</Role>
        <Text> </Text>
        <Role name={phaseRole(s.phase)}>{PHASE_WORD[s.phase]}</Role>
        <Role name="fgDim"> · {sectionStat(s)}</Role>
        {s.collapsed && <Role name="fgDim"> (colapsado)</Role>}
      </Box>
      {!s.collapsed &&
        s.events.map((e, i) => <EventRow key={`${s.id}:${i}`} event={e} cols={props.cols} />)}
    </Box>
  );
}

/**
 * Achata as seções em LINHAS lógicas p/ janelar pela CAUDA: cada seção = 1 linha de
 * cabeçalho + N linhas de evento. A janela `▼ ao vivo` mostra o SUFIXO que cabe em
 * `visibleRows`, deslocado por `scrollOffset` (foco+↑↓). Mantemos a granularidade de
 * SEÇÃO inteira quando cabe; quando uma seção é maior que a janela, mostramos a cauda
 * de seus eventos. Simples e bounded (anti-flicker).
 */
type FlatLine =
  | { readonly t: 'header'; readonly section: LogSection }
  | { readonly t: 'event'; readonly section: LogSection; readonly event: LogEvent };

function flatten(sections: readonly LogSection[]): FlatLine[] {
  const out: FlatLine[] = [];
  for (const s of sections) {
    out.push({ t: 'header', section: s });
    if (!s.collapsed) for (const e of s.events) out.push({ t: 'event', section: s, event: e });
  }
  return out;
}

export function ActivityLog(props: ActivityLogProps): React.ReactElement {
  const cols = props.columns ?? 40;
  const flat = flatten(props.sections);

  if (flat.length === 0) {
    // EST-1015 (cockpit idle) — sem atividade: em vez de uma região BARREN, preenche com o
    // DIAGNÓSTICO de boot (config/agentes) quando o Cockpit o passa. `bootInfo` ausente/vazio
    // (split inline) ⇒ o "sem atividade ainda" de sempre.
    const boot = (props.bootInfo ?? []).filter((b) => b.lines.length > 0);
    return (
      <Box flexDirection="column">
        <Box>
          <Role name={props.focused ? 'accent' : 'fgDim'}>LOG</Role>
          <Role name="fgDim"> · sem atividade ainda</Role>
        </Box>
        {boot.map((b) => (
          <Box key={b.title} flexDirection="column">
            <Box>
              <Glyph name="clock" role="fgDim" />
              <Text> </Text>
              <Role name="accent">{b.title}</Role>
            </Box>
            {b.lines.map((ln, i) => (
              <Box key={`${b.title}:${i}`} paddingLeft={2}>
                <Role name="fgDim">{elide(ln, Math.max(4, cols - 2))}</Role>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    );
  }

  // Janela pela CAUDA: reserva 1 linha p/ o rótulo `▼ ao vivo`/`↑N acima`.
  const room = Math.max(1, props.visibleRows - 1);
  const total = flat.length;
  // scrollOffset 0 = colado na cauda; cresce p/ cima (clamp).
  const maxOffset = Math.max(0, total - room);
  const offset = Math.min(Math.max(0, props.scrollOffset), maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - room);
  const window = flat.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column">
      {/* Rótulo da coluna + estado da janela. `▼ ao vivo` quando colado na cauda. */}
      <Box>
        <Role name={props.focused ? 'accent' : 'fgDim'}>LOG</Role>
        {hiddenAbove > 0 && <Role name="fgDim"> · ↑{hiddenAbove} acima</Role>}
        {hiddenBelow === 0 ? (
          <Role name="fgDim"> · ▼ ao vivo</Role>
        ) : (
          <Role name="fgDim"> · ↓{hiddenBelow} abaixo</Role>
        )}
      </Box>
      {window.map((ln, i) =>
        ln.t === 'header' ? (
          <Section
            key={`h:${ln.section.id}:${i}`}
            section={{ ...ln.section, events: [] }}
            cols={cols}
          />
        ) : (
          <EventRow key={`e:${ln.section.id}:${i}`} event={ln.event} cols={cols} />
        ),
      )}
    </Box>
  );
}
