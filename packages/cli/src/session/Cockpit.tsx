// EST-1000 · ADR-0076 §3/§4/§5 — <Cockpit>: a 2ª superfície de render (TELA CHEIA).
//
// O cockpit é uma superfície de RENDER alternativa ao inline (que segue o DEFAULT). Em
// vez de viver no scrollback do terminal (<Static>), o cockpit toma a tela INTEIRA
// (alt-screen) e a divide em 6 regiões de altura FIXA cuja soma == `rows` (§3). Cada
// região é um <Box> de altura cravada; conversa e log têm SCROLL PRÓPRIO (§4, viewport).
//
// ANTI-FLICKER (§5): como a soma das alturas == `rows`, a árvore NUNCA reflui pra fora
// de `rows` ⇒ o gatilho `outputHeight >= rows` do Ink NÃO dispara ⇒ não há
// `clearTerminal`-por-frame. NÃO usamos `live-budget.ts` aqui (ele é EXCLUSIVO do
// inline). As regiões são endereçáveis e estáveis: só a célula que muda repinta
// (overwrite-in-place do #95, que continua envelopando o stdout no run.tsx).
//
// REUSO (§3/§7): a conversa reusa o MESMO <BlockView> do inline (App.tsx, exportado); o
// log reusa o MESMO <ActivityLog>/`buildActivityLog` do split #135 — uma fonte de
// telemetria, duas vistas. O dado já chega REDIGIDO (RES-C-1) da FlowTree.
//
// i18n (#140): TODA string do cockpit vem do catálogo via `t()` (rótulos das regiões,
// hints). Nenhuma cor/estilo cru — só papéis do DS (Role/Glyph).

import React from 'react';
import { Box, Text } from 'ink';
import { Role, Glyph } from '../ui/theme/index.js';
import { useI18n } from '../i18n/index.js';
import { Header, StatusBar, Composer, ActivityLog } from '../ui/components/index.js';
import { FooterHints, type HintState } from '../ui/components/index.js';
import { BlockView } from './App.js';
import type { SessionState, SessionBlock } from './model.js';
import { abbreviateCount } from './model.js';
import type { LogSection } from './activity-log.js';
import type { CockpitLayout } from './cockpit-layout.js';
import { partitionCockpitBlocks } from './cockpit-blocks.js';
import { elapsedTickEnabled } from './tick-policy.js';
import { fitConversaWindow, streamPreviewMaxLines } from './cockpit-conversa.js';
import { useTheme } from '../ui/theme/index.js';

/**
 * EST-1015 (fix fullscreen "texto embaralhado/sobreposto" — bug #1 do dono) — clipa as
 * LINHAS de um bloco `note` p/ caber em `maxLines`. RAIZ do bug (provada por PTY+emulador
 * + repro isolado no Ink 5.2.1): um bloco ALTO na conversa de altura FIXA (ex.: a saída do
 * `/help`, ~34 linhas) fazia o Ink MIS-CLIPAR — o `overflow:hidden` falha com conteúdo
 * alto/aninhado e MESCLA as caudas das linhas escondidas nas visíveis ("sair da conta"+cauda
 * de outro comando). Clipando a FONTE p/ caber (sem depender do overflow:hidden), o render
 * fica limpo (provado: conteúdo que CABE não corrompe). Mostra `…(+N)` ao truncar. PURO;
 * bloco não-`note` passa inalterado. */
export function clipNoteToFit(b: SessionBlock, maxLines: number): SessionBlock {
  if (b.kind !== 'note') return b;
  // A nota renderiza como TÍTULO (1) + linhas + paddingBottom (1) do wrapper do BlockView.
  // P/ caber ESTRITAMENTE abaixo de `maxLines` (e não tocar a borda do overflow, que é onde
  // o Ink mis-clipa), reservamos 3 linhas: título + pad + 1 de folga. O indicador "…(+N)"
  // consome 1 das linhas mostradas.
  const budget = Math.max(1, maxLines - 3);
  if (b.lines.length <= budget) return b;
  const shown = b.lines.slice(0, Math.max(1, budget - 1)); // -1 p/ o indicador "…(+N)"
  return {
    ...b,
    lines: [
      ...shown,
      `…(+${b.lines.length - shown.length} linhas — saia do /fullscreen p/ ver tudo)`,
    ],
  };
}

/** Qual região tem o FOCO de scroll (Tab alterna). */
export type CockpitFocus = 'conversa' | 'log';

export interface CockpitProps {
  /** O estado vivo da sessão (o MESMO `SessionState` do inline). */
  readonly state: SessionState;
  /** O layout resolvido (regiões fixas + alturas) — `kind:'cockpit'` (a recusa não chega aqui). */
  readonly layout: Extract<CockpitLayout, { kind: 'cockpit' }>;
  /** Seções projetadas do LOG (`buildActivityLog`, já redigidas — RES-C-1). */
  readonly logSections: readonly LogSection[];
  /** Painel com FOCO de scroll (Tab alterna). */
  readonly focus: CockpitFocus;
  /** Offset de scroll da CONVERSA (0 = colado na cauda, "ao vivo"). */
  readonly conversaScroll: number;
  /** Offset de scroll do LOG. */
  readonly logScroll: number;
  /** Texto corrente do composer. */
  readonly input: string;
  /** Posição do cursor no composer. */
  readonly cursorPos: number;
  /** Composer ativo (idle) vs inativo (durante o trabalho). */
  readonly composerActive: boolean;
  /** Cursor piscante (anim ligada). */
  readonly showCursor: boolean;
  /** Estado do footer de hints (idle/thinking/streaming/…) ou `null` (compact = sem hints). */
  readonly hintState: HintState | null;
  /** Nome de exibição do tier (`Granito`), nunca a key crua (HG-2). */
  readonly tierDisplay: string;
  /** `true` quando o tier é o default (status bar neutro vs accent). */
  readonly isDefaultTier: boolean;
  /** Largura/altura do terminal (== layout.cols/rows; passados p/ os componentes). */
  readonly columns: number;
  /** Frame da animação (tick) — p/ cursor/working pulsarem dentro das regiões. */
  readonly frame: number;
  /** cwd p/ a status bar. */
  readonly cwd: string;
  /** Versão do binário p/ o header. */
  readonly version?: string;
  /**
   * EST-1000 (#157 fix) — OVERLAY MODAL de `/` (SlashMenu / pickers model·theme·lang·
   * history / CommandPalette), montado pela App. `null` quando nenhum está aberto. Quando
   * presente, é renderizado como POPOVER no lugar dos blocos da CONVERSA (a região mais
   * alta), SEM inflar o grid: a região é um <Box> de altura FIXA (`conversaRows`), então
   * o overlay é CLIPADO a essa altura e a soma das regiões segue == `rows` (anti-flicker
   * §5). O ESTADO/navegação (↑↓/Enter/esc) é o MESMO do inline — só a posição mudou.
   */
  readonly overlay?: React.ReactNode;
}

/** Régua horizontal de 1 linha (borda entre regiões — papel `fgDim` do DS). */
function Rule(props: {
  readonly columns: number;
  readonly label?: string;
  // EST-1015 (UX) — região FOCADA (tab): a régua ganha o marcador `▌` (glifo `you`,
  // ASCII `>`), pra o foco ficar óbvio MESMO sem cor (NO_COLOR). a11y: o ▌ carrega o sentido.
  readonly focused?: boolean;
}): React.ReactElement {
  const width = Math.max(1, props.columns);
  if (props.label !== undefined && props.label !== '') {
    // régua rotulada: `── ▌ label ───────` (focada) ou `── label ───────`.
    const lead = '── ';
    const marker = props.focused === true ? '▌ ' : ''; // só p/ a CONTA da largura (render via Glyph).
    const text = `${lead}${marker}${props.label} `;
    const rest = Math.max(0, width - text.length);
    return (
      <Box>
        <Role name="fgDim">{lead}</Role>
        {props.focused === true && (
          <>
            <Glyph name="you" role="accent" />
            <Role name="fgDim"> </Role>
          </>
        )}
        <Role name="accent">{props.label}</Role>
        <Role name="fgDim"> {'─'.repeat(rest)}</Role>
      </Box>
    );
  }
  return <Role name="fgDim">{'─'.repeat(width)}</Role>;
}

/**
 * A região de CONVERSA: janela própria sobre os blocos da sessão, com scroll (offset) e
 * indicador `↑N / ▼ ao vivo`. Anti-flicker: a janela é BOUNDED por `conversaRows`; nunca
 * escreve mais que sua altura. Reusa o <BlockView> (mesmo render de bloco do inline).
 */
function ConversaRegion(props: {
  readonly blocks: readonly SessionBlock[];
  readonly rows: number;
  /** Altura TOTAL do terminal (linhas) — p/ o cap adaptativo da cauda viva (F163). */
  readonly screenRows: number;
  readonly columns: number;
  readonly focused: boolean;
  readonly scroll: number;
  readonly frame: number;
  readonly overlay?: React.ReactNode;
}): React.ReactElement {
  const { t } = useI18n();
  const theme = useTheme();
  const blocks = props.blocks;
  // 1 linha p/ o rótulo da região; o resto p/ os blocos.
  const room = Math.max(1, props.rows - 1);
  // EST-1015 (fix "texto embaralhado/sobreposto") — a janela é por LINHAS VISUAIS, não
  // por nº de blocos: `fitConversaWindow` MEDE cada bloco como o <BlockView> renderiza e
  // só deixa entrar o que CABE em `room` (clipando NA FONTE o que sozinho não cabe). O
  // conteúdo NUNCA estoura a Box ⇒ o mis-clip do Ink (que MESCLA linhas) nem é exercitado.
  const ctx = {
    columns: props.columns,
    rows: props.screenRows,
    mono: theme.colorMode === 'mono',
    streamMaxLines: streamPreviewMaxLines(room),
  };
  const vp = fitConversaWindow(blocks, room, props.scroll, ctx);
  const visible = vp.blocks;
  // EST-1000 (#157 fix) — POPOVER: quando há overlay de `/` aberto, ele OCUPA a região da
  // conversa (o foco do usuário está nele, não nos turnos). O rótulo da região vira
  // `conversa · /menu` p/ sinalizar a sobreposição (a11y). A altura segue cravada em
  // `props.rows` (Box fixo) ⇒ o overlay é clipado, o grid NÃO reflui (anti-flicker §5).
  if (props.overlay !== undefined && props.overlay !== null) {
    return (
      <Box flexDirection="column" height={props.rows}>
        <Box>
          <Role name="accent">{t('cockpit.conversa')}</Role>
          <Role name="fgDim"> · /menu</Role>
        </Box>
        {/* O overlay (SlashMenu/picker/paleta) pode ser MAIS ALTO que a região (a lista
            de `/` lista todos os comandos). CLIPAMOS a `room` linhas (`overflow:hidden`)
            p/ NUNCA estourar `conversaRows` ⇒ a soma das regiões segue == rows e o grid
            não reflui/corrompe (anti-flicker §5). O usuário filtra (digita) p/ reduzir a
            lista; o popover mostra o topo (cabeçalho + os 1ºs itens) sempre alinhado. */}
        <Box flexDirection="column" height={room} overflow="hidden">
          {props.overlay}
        </Box>
      </Box>
    );
  }
  // EST-1015 (cockpit idle "horrível") — CONVERSA vazia (até o 1º objetivo, com as notas de
  // boot já realocadas p/ o LOG): em vez de uma região barren, um BOAS-VINDAS calmo CENTRADO
  // (vertical+horizontal). A altura segue cravada em `props.rows` ⇒ grid não reflui (§5).
  //
  // FIX (vão gigante na conversa vazia, achado do dono) — o gatilho era `blocks.length===0`,
  // mas uma sessão NOVA em fullscreen já traz NOTAS transitórias (◷ cockpit entrou, ◷ yolo…)
  // na conversa ⇒ `length>0` ⇒ caía no ramo `flex-end` e a nota única boiava no RODAPÉ com
  // ~40 linhas EM BRANCO empurradas pro topo (horrível). Agora o empty-state dispara quando
  // NÃO HÁ TURNO REAL (só notas): mostra a dica de boas-vindas + as notas VERTICALMENTE
  // CENTRADAS (não um bloco enorme de nada no topo). As notas SEGUEM visíveis (a nota de
  // entrada "◷ cockpit — modo cockpit…" #386 aparece); no 1º turno o ramo de baixo (flex-end,
  // chat) assume. `overflow:hidden` crava a região (nunca estoura `room`, §5).
  const hasTurns = blocks.some((b) => b.kind !== 'note');
  if (!hasTurns) {
    return (
      <Box flexDirection="column" height={props.rows}>
        <Box>
          {props.focused === true && (
            <>
              <Glyph name="you" role="accent" />
              <Text> </Text>
            </>
          )}
          <Role name={props.focused ? 'accent' : 'fgDim'}>{t('cockpit.conversa')}</Role>
          <Role name="fgDim"> · ▼ ao vivo</Role>
        </Box>
        <Box
          height={room}
          width={props.columns}
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          overflow="hidden"
        >
          <Role name="accent">{t('cockpit.welcomeTitle')}</Role>
          <Role name="fgDim">{t('cockpit.welcomeHint')}</Role>
          {/* as notas transitórias (entrada do cockpit, yolo…) — visíveis, logo abaixo da
              dica, no MESMO grupo centrado ⇒ sem o vão gigante. `marginTop` só quando há nota. */}
          {blocks.length > 0 && (
            <Box flexDirection="column" alignItems="center" marginTop={1}>
              {blocks.map((b, i) => (
                <BlockView
                  key={i}
                  block={b}
                  isCurrent={false}
                  frame={props.frame}
                  columns={props.columns}
                  rows={props.screenRows}
                  maxLines={ctx.streamMaxLines}
                />
              ))}
            </Box>
          )}
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={props.rows}>
      <Box>
        {/* ▌ marca o FOCO (a11y: sentido sem cor — espelha o log e o empty-state). */}
        {props.focused && (
          <>
            <Glyph name="you" role="accent" />
            <Text> </Text>
          </>
        )}
        <Role name={props.focused ? 'accent' : 'fgDim'}>{t('cockpit.conversa')}</Role>
        {vp.hiddenAbove > 0 && <Role name="fgDim"> · ↑{vp.hiddenAbove}</Role>}
        {vp.hiddenBelow === 0 ? (
          <Role name="fgDim"> · ▼ ao vivo</Role>
        ) : (
          <Role name="fgDim"> · ↓{vp.hiddenBelow}</Role>
        )}
      </Box>
      {/* EST-1015 (#fullscreen "vazio") — ANCORA a conversa EMBAIXO (chat natural): a
          mensagem mais nova fica junto do `── log ──`/composer e o espaço em branco vai
          pro TOPO (lê como histórico que rolou pra cima), em vez de blocos boiando no
          topo com um buraco antes do log. No caso de OVERFLOW (conteúdo > `room`), o
          `flex-end` clipa o TOPO (mais antigo) — o que se QUER num "▼ ao vivo" (ver o
          novo). O windowing por bloco do viewport (`vp`) e os indicadores `↑N`/`↓N`
          seguem corretos (são contagem de blocos, independem do âncora visual). */}
      <Box flexDirection="column" height={room} overflow="hidden" justifyContent="flex-end">
        {visible.map((b, i) => (
          <BlockView
            key={vp.start + i}
            block={b}
            isCurrent={vp.start + i === blocks.length - 1}
            frame={props.frame}
            columns={props.columns}
            // F163 — altura do TERMINAL p/ a cauda viva de shell (tool/bang) usar o cap
            // adaptativo `liveShellTailMaxLines` — o MESMO que `fitConversaWindow` mediu.
            rows={props.screenRows}
            // EST-1015 (irmão do #371) — CAPPA a prévia VIVA do aluy streaming ABAIXO da
            // altura da região (`streamPreviewMaxLines(room)` = room − overhead do bloco):
            // sem teto, uma resposta longa streamando estourava `room` ⇒ mis-clip do Ink.
            // TEM de ser o MESMO valor usado na medição (ctx.streamMaxLines).
            maxLines={ctx.streamMaxLines}
          />
        ))}
      </Box>
    </Box>
  );
}

/**
 * <Cockpit> — monta as 6 regiões de altura FIXA (header / conversa / log / status /
 * composer / hints) com réguas entre elas. A SOMA das alturas == `rows` (invariante §5).
 */
export function Cockpit(props: CockpitProps): React.ReactElement {
  const { t } = useI18n();
  const { layout } = props;
  const tokens = props.state.meta.tokens;
  const windowPct = props.state.meta.windowPct;
  // EST-1015 (cockpit idle) — realoca as notas de DIAGNÓSTICO de boot (config/agentes) p/ o
  // LOG (preenche a região barren) e deixa a CONVERSA limpa (boas-vindas até o 1º objetivo).
  const { startupNotes, conversation } = partitionCockpitBlocks(props.state.blocks);
  const bootInfo = startupNotes.map((n) => ({ title: n.title, lines: n.lines }));

  return (
    // FIX (fantasma do composer no differ) — `overflow="hidden"` CRAVA o frame em `rows`:
    // se QUALQUER região passar da sua altura (ex.: um transiente do composer/log durante uma
    // mudança de altura), o Ink CLIPA em vez de estourar `rows`. Sem isto, um frame de `rows+1`
    // linhas fazia o terminal ROLAR 1 linha ⇒ o modelo por-linha ABSOLUTO do CockpitDiffer
    // (ADR-0076 §5) dessincronizava do terminal e deixava a linha ANTIGA do composer como
    // FANTASMA (composer duplicado no rodapé) até um full-paint. Cravar a altura mantém o
    // invariante sum==rows SEMPRE verdadeiro na tela, não só no cálculo do layout.
    <Box flexDirection="column" width={props.columns} height={layout.rows} overflow="hidden">
      {/* ── 1) HEADER (fixo) ─────────────────────────────────────────────────── */}
      <Box height={layout.headerRows}>
        <Header
          tier={props.tierDisplay}
          columns={props.columns}
          rows={1}
          {...(props.version !== undefined ? { version: props.version } : {})}
        />
      </Box>
      <Rule columns={props.columns} />

      {/* ── 2) CONVERSA (gerida, scroll próprio) ─────────────────────────────── */}
      <ConversaRegion
        blocks={conversation}
        rows={layout.regions.conversaRows}
        screenRows={layout.rows}
        columns={props.columns}
        focused={props.focus === 'conversa'}
        scroll={props.conversaScroll}
        frame={props.frame}
        overlay={props.overlay}
      />
      {/* EST-1015 (densidade) — régua LISA: o rótulo/estado do log (`LOG · ▼ ao vivo` +
          ▌ de foco) já vive DENTRO da região (<ActivityLog>), como na conversa. A régua
          rotulada duplicava ("── log ──" + "LOG · …" na linha seguinte). */}
      <Rule columns={props.columns} />

      {/* ── 3) LOG (FlowTree/ActivityLog — altura cheia, scroll próprio) ──────── */}
      {/* overflow:hidden — CRAVA a região (a altura do log é ADAPTATIVA; um transiente não
          pode empurrar as regiões de baixo / estourar `rows`). Ver o topo. */}
      <Box height={layout.regions.logRows} overflow="hidden" flexShrink={0}>
        <ActivityLog
          sections={props.logSections}
          visibleRows={layout.regions.logRows}
          scrollOffset={props.logScroll}
          focused={props.focus === 'log'}
          columns={props.columns}
          bootInfo={bootInfo}
        />
      </Box>
      <Rule columns={props.columns} />

      {/* ── 4) STATUS (fixo, vivo) ───────────────────────────────────────────── */}
      <Box height={layout.statusRows}>
        <StatusBar
          cwd={props.cwd}
          tier={props.tierDisplay}
          isDefaultTier={props.isDefaultTier}
          {...(props.state.meta.model !== undefined
            ? // HG-2/CLI-SEC-7: só o `model` da via Custom (slug do usuário); NÃO exibir
              // `activeModel` (=usage.model = modelo de roteamento upstream cru) — revelaria
              // o mapa tier→provider na tela (gate AG-0008 reprovou #378). Ver App.tsx.
              { model: props.state.meta.model }
            : {})}
          tokens={tokens}
          windowPct={windowPct}
          columns={props.columns}
          error={props.state.phase === 'error'}
          busy={elapsedTickEnabled(props.state.phase)}
          frame={props.frame}
          {...(props.state.meta.focus !== undefined ? { focus: props.state.meta.focus } : {})}
          {...(process.env.ALUY_CYCLE_UI_OFF !== '1' &&
          process.env.ALUY_CYCLE_UI_OFF !== 'true' &&
          props.state.cycleProgress !== undefined
            ? { cycleProgress: props.state.cycleProgress }
            : {})}
        />
      </Box>

      {/* ── 5) COMPOSER (fixo) ───────────────────────────────────────────────── */}
      {/* overflow:hidden — o composer SELF-CLIPA em `composerRows`: se o input crescer/encolher
          e um frame transiente tiver mais linhas visuais que a região, o excedente é CORTADO
          AQUI (não empurra os hints nem estoura `rows`) ⇒ sem rolagem ⇒ sem fantasma no differ.
          Em regime o windowComposerVisual já cabe; isto é a rede de segurança do invariante. */}
      <Box height={layout.composerRows} overflow="hidden" flexShrink={0}>
        <Composer
          value={props.input}
          cursorPos={props.cursorPos}
          active={props.composerActive}
          showCursor={props.showCursor}
          shellMode={props.input.startsWith('!')}
          maxRows={layout.composerRows}
          columns={props.columns}
          {...(props.state.meta.label !== undefined
            ? { sessionLabel: props.state.meta.label }
            : {})}
          {...(props.state.meta.labelColor !== undefined
            ? { sessionColor: props.state.meta.labelColor }
            : {})}
        />
      </Box>

      {/* ── 6) HINTS (fixo, contextual) ──────────────────────────────────────── */}
      <Box height={layout.hintsRows}>
        {/* No idle/streaming o cockpit ensina seus próprios atalhos (tab/pgup/ctrl-s);
            nos estados de ask/budget/erro mantém os hints do inline (decididos a montante).
            `null` (compact) ⇒ ao menos o atalho-base do cockpit (a região existe no grid). */}
        {props.hintState === null || props.hintState === 'idle' ? (
          <Role name="fgDim">
            {t('hints.cockpit')}
            <Text> · </Text>
            {abbreviateCount(tokens)} tok
          </Role>
        ) : (
          <FooterHints state={props.hintState} />
        )}
      </Box>
    </Box>
  );
}
