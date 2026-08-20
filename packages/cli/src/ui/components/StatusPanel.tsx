// F-PAINEL (pedido do dono: "padronizar a forma de apresentar as informações no status?
// cada linha ficar um pouquinho mais bem definida, como se fosse três ITENS e não apenas
// três frases") — o rodapé deixa de ser três frases soltas e vira um PAINEL de três itens
// rotulados, com o mesmo fundo do composer.
//
// O problema não era só de forma. A barra antiga era UMA linha que misturava três assuntos
// diferentes — quem você é (provider, modelo, path), como a máquina está (modo, catraca,
// sidecars) e quanto você gastou (janela, sessão, crédito) — e por isso não havia como
// lê-la em diagonal: para achar o percentual da janela era preciso varrer o provider e o
// caminho do projeto no meio do caminho. Reagrupar por ASSUNTO é o que transforma três
// frases em três itens; o rótulo alinhado é só o que torna o agrupamento visível.
//
// Efeito colateral que importa: com os campos repartidos em três linhas, nenhuma delas
// chega perto de estourar a largura. O truncamento agressivo do `<StatusBar>` (orçamento
// acoplado entre modelo e path, porque os dois disputavam a MESMA linha com todo o resto)
// deixa de ser necessário — aqui cada linha tem folga de sobra, e o path volta a caber
// quase sempre inteiro.
//
// SEM FUNDO, por decisão do dono ("uso, janela e etc não precisam de outra cor de fundo").
// A primeira versão pintava as três linhas com a cor do composer, e o efeito era o oposto
// do pretendido: com o eco, a resposta e o composer já pintados, um quarto retângulo fazia
// a tela inteira virar bloco e as caixas deixavam de significar alguma coisa. O fundo é o
// que marca as VOZES da conversa; o status não é voz, é instrumentação — quem o organiza é
// o alinhamento da coluna de rótulos, não a cor.
//
// Não pintar tem uma consequência prática boa: sem precisar preencher a linha até a borda,
// ela não precisa mais ser um `<Text>` único e medido, e volta a aceitar COMPONENTES —
// o pulso de trabalho e a barrinha de progresso do MCP, que são animados e haviam ficado
// de fora enquanto tudo tinha de ser string.

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionMode } from '@hiperplano/aluy-cli-core';
import { Role, useTheme, type TermRole } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import { buildSidecarChip, sidecarChipCell } from '@hiperplano/aluy-cli-core';
import { abbreviateCount } from '../../session/model.js';
import { displayWidth } from '../../session/visual-lines.js';
import {
  govTotal,
  windowRole,
  budgetRole,
  sidecarRole,
  quotaRole,
  type StatusBarProps,
} from './StatusBar.js';
import { MODE_VIEW } from './ModeIndicator.js';
import { BusyPulse } from './BusyPulse.js';
import { progressRatio, renderBar } from './ProgressBar.js';
import { UnsafeBanner } from './UnsafeBanner.js';

/** Um pedaço de linha com o próprio papel de cor. PURO — sem JSX, para poder ser MEDIDO. */
interface Seg {
  readonly text: string;
  readonly role: TermRole;
}

/**
 * Largura da coluna de rótulos. Cabe o maior deles (`sessão`, `estado`, `uso` ⇒ 6) mais
 * dois espaços de respiro — é o alinhamento dessa coluna que faz os três itens lerem como
 * uma tabela em vez de três parágrafos.
 */
const ROTULO_COLS = 8;

/** Largura visual total de uma sequência de segmentos. */
function larguraSegs(segs: readonly Seg[]): number {
  let n = 0;
  for (const s of segs) n += displayWidth(s.text);
  return n;
}

/**
 * Corta segmentos pelo FIM até caber em `teto`. Os campos são montados em ordem de
 * importância decrescente (identidade primeiro, observabilidade por último), então
 * descartar a cauda descarta exatamente o que é supérfluo — nunca o que identifica a
 * sessão. O último segmento sobrevivente é aparado no caractere, com reticência.
 */
function caberSegs(segs: readonly Seg[], teto: number): readonly Seg[] {
  if (larguraSegs(segs) <= teto) return segs;
  const out: Seg[] = [];
  let usado = 0;
  for (const s of segs) {
    const w = displayWidth(s.text);
    if (usado + w <= teto) {
      out.push(s);
      usado += w;
      continue;
    }
    const resta = teto - usado - 1;
    if (resta > 0) out.push({ text: `${s.text.slice(0, resta)}…`, role: s.role });
    break;
  }
  return out;
}

export interface StatusPanelProps extends StatusBarProps {
  readonly mode: SessionMode;
  /**
   * Uma linha só, em vez de três. Usado pelo cockpit em tela baixa, onde o grid não tem
   * três linhas para dar ao status.
   *
   * A linha que sobra é `sessão`, e a escolha não é arbitrária: das três, é a única que
   * responde "onde isto vai rodar" — provider, modelo e diretório. `estado` e `uso` são
   * observabilidade e podem esperar a tela crescer.
   *
   * Sem esta prop, o cockpit apenas CORTAVA a altura do painel e o que sobrava na tela era
   * a linha do meio (`estado`) — justamente a descartável.
   */
  readonly compact?: boolean;
}

/**
 * F-PAINEL — as três linhas do rodapé, rotuladas e pintadas.
 *
 * O `unsafe` NÃO entra no painel: ele reusa o banner gritante de sempre (EST-0948). Um
 * aviso de modo perigoso não pode ser rebaixado a uma linha de tabela cinza — é o único
 * estado do rodapé que precisa gritar, e o painel é desenhado para NÃO gritar.
 */
export function StatusPanel(props: StatusPanelProps): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const cols = props.columns ?? 80;
  // `-2`: o painel vive recuado 2 colunas, alinhado com a borda do composer.
  // `-1` casa com a largura pintada do composer: o bloco dele tem borda (1 coluna) mais
  // `cols - 2` de fundo. Aqui não há borda, então o fundo sozinho precisa valer `cols - 1`
  // para as duas bordas direitas fecharem na MESMA coluna.
  const util = Math.max(20, cols - 1);
  // A área dos VALORES: o que sobra depois do glifo, do espaço e da coluna de rótulos.
  const tetoValor = Math.max(10, util - 2 - ROTULO_COLS - 1);

  // ── linha 1 · SESSÃO — quem você é nesta conversa ────────────────────────────────
  const sessao: Seg[] = [{ text: props.tier, role: props.isDefaultTier === false ? 'accent' : 'fgDim' }];
  if (props.model !== undefined && props.model !== '') {
    // Sem o orçamento acoplado da barra antiga: aqui o modelo divide a linha só com o
    // provider e o path, então o vendor (`deepseek/`) é redundante mas o resto cabe.
    const slug = props.model.includes('/') ? (props.model.split('/').pop() ?? props.model) : props.model;
    sessao.push({ text: ' · ', role: 'fgDim' }, { text: slug, role: 'depth' });
  }
  if (props.focus !== undefined && props.focus !== '') {
    sessao.push({ text: ' · ', role: 'fgDim' }, { text: `◎ foco: ${props.focus}`, role: 'accent' });
  }
  if (props.cycleProgress !== undefined) {
    const c = props.cycleProgress;
    const sub = c.subcyclesTotal > 0 ? ` · ${t('statusbar.subcycles')} ${c.subcyclesDone}/${c.subcyclesTotal}` : '';
    sessao.push(
      { text: ' · ', role: 'fgDim' },
      { text: `↻ ${t('statusbar.cycle')} ${c.iteration}/${c.max}${sub}`, role: 'accent' },
    );
  }
  if (props.branch !== undefined && props.branch !== '') {
    sessao.push({ text: ' · ', role: 'fgDim' }, { text: `${theme.glyph('branch')} ${props.branch}`, role: 'fgDim' });
  }
  sessao.push({ text: ' · ', role: 'fgDim' }, { text: props.cwd, role: 'fgDim' });
  if (props.governance !== undefined && govTotal(props.governance) > 0) {
    const g = props.governance;
    sessao.push(
      { text: ' · ', role: 'fgDim' },
      { text: `⌁ ${g.agents}a·${g.commands}c·${g.skills}s·${g.workflows}w·${g.memory}m`, role: 'fgDim' },
    );
  }

  // ── linha 2 · ESTADO — como a máquina está agora ─────────────────────────────────
  const v = MODE_VIEW[props.mode];
  const estado: Seg[] = [
    { text: v.word, role: v.role },
    { text: ` · ${t(v.caption)}`, role: 'fgDim' },
  ];
  if (props.sidecarUsage !== undefined) {
    const chip = buildSidecarChip(props.sidecarUsage) ?? [];
    if (chip.length > 0) {
      estado.push({ text: ` · ${theme.glyph('sidecar')} ${t('statusbar.sidecars')}`, role: 'fgDim' });
      for (const e of chip) {
        estado.push({ text: ` ${sidecarChipCell(e, !theme.unicode)}`, role: sidecarRole(e.state) });
      }
    }
  }
  const mcp = props.mcpProgress;
  if (mcp !== undefined && mcp.done) {
    const falhou = mcp.failed;
    estado.push(
      { text: ' · ', role: 'fgDim' },
      {
        text: `${theme.glyph('ok')} MCP ${mcp.connected}/${mcp.total}${falhou > 0 ? ` · ${falhou} ${t('statusbar.mcpFailed')}` : ''}`,
        role: falhou > 0 ? 'accent' : 'success',
      },
    );
  }
  // Enquanto CONECTA, o MCP é uma barrinha (`▰▰▱ 2/3`) e o trabalho é um pulso — os dois
  // são componentes animados, e por isso entram como `extra` em vez de segmento de texto.
  const barraMcp =
    mcp !== undefined && !mcp.done
      ? renderBar(
          progressRatio(mcp.connected + mcp.failed, mcp.total),
          theme.glyph('barFull'),
          theme.glyph('barEmpty'),
          3,
          theme.unicode,
        )
      : undefined;
  const extraEstado = (
    <>
      {barraMcp !== undefined && mcp !== undefined && (
        <>
          <Role name="fgDim"> · MCP </Role>
          <Role name="accent">{barraMcp.filled}</Role>
          <Role name="fgDim">{barraMcp.rest}</Role>
          <Role name="fgDim">{` ${mcp.connected + mcp.failed}/${mcp.total}`}</Role>
        </>
      )}
      {props.busy === true && (
        <>
          <Text> </Text>
          <BusyPulse {...(props.frame !== undefined ? { frame: props.frame } : {})} />
        </>
      )}
    </>
  );
  if (props.error === true) {
    // "broker" era enganoso sob backend LOCAL, que é o caso de quem traz o próprio provider:
    // o usuário lê que o BROKER falhou quando o broker nem está em uso, e vai procurar
    // problema no lugar errado. O rótulo segue quem de fato atendeu a chamada.
    const quem = props.model !== undefined || props.credit !== undefined ? 'provider' : 'broker';
    estado.push(
      { text: ' · ', role: 'fgDim' },
      { text: `${theme.glyph('ask')} ${quem}`, role: 'danger' },
    );
  }

  // ── linha 3 · USO — quanto já se gastou ──────────────────────────────────────────
  const uso: Seg[] = [
    { text: `${theme.glyph('window')} ${props.windowPct}% ${t('statusbar.window')}`, role: windowRole(props.windowPct) },
  ];
  const temBudget = props.budgetPct !== undefined;
  uso.push({ text: ' · ', role: 'fgDim' });
  if (temBudget) {
    uso.push({
      text: `${props.budgetPct}% ${t('statusbar.session')} (${abbreviateCount(props.tokens)})`,
      role: budgetRole(props.budgetPct!),
    });
  } else {
    uso.push({
      text: `${abbreviateCount(props.tokens)} ${t('statusbar.session')}`,
      role: 'fgDim',
    });
  }
  if (props.quotaPct !== undefined) {
    uso.push(
      { text: ' · ', role: 'fgDim' },
      {
        text: `${props.quotaPct}% ${t('statusbar.quota')}`,
        role: quotaRole(props.quotaLevel ?? 'ok'),
      },
    );
  }
  if (props.credit !== undefined && props.credit !== '') {
    uso.push({ text: ' · ', role: 'fgDim' }, { text: `crédito ${props.credit}`, role: 'depth' });
  }

  if (props.mode === 'unsafe') {
    // O banner substitui a linha `estado` (ele JÁ diz qual é o modo, gritando) — mas só
    // ela. `sessão` some junto era regressão: no YOLO, saber em que provider, modelo e
    // diretório o agente vai rodar QUALQUER comando sem perguntar é mais importante que
    // no modo normal, não menos.
    return (
      <Box flexDirection="column">
        <UnsafeBanner columns={cols} />
        <Linha
          glyph={theme.glyph('clock')}
          rotulo={t('painel.sessao')}
          segs={sessao}
          teto={tetoValor}
        />
        <Linha glyph={theme.glyph('gauge')} rotulo={t('painel.uso')} segs={uso} teto={tetoValor} />
      </Box>
    );
  }

  if (props.compact === true) {
    return (
      <Box flexDirection="column">
        <Linha
          glyph={theme.glyph('clock')}
          rotulo={t('painel.sessao')}
          segs={sessao}
          teto={tetoValor}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Linha glyph={theme.glyph('clock')} rotulo={t('painel.sessao')} segs={sessao} teto={tetoValor} />
      <Linha
        glyph={theme.glyph(v.glyph)}
        rotulo={t('painel.estado')}
        segs={estado}
        teto={tetoValor}
        extra={extraEstado}
      />
      <Linha glyph={theme.glyph('gauge')} rotulo={t('painel.uso')} segs={uso} teto={tetoValor} />
    </Box>
  );
}

/**
 * Uma linha do painel: ` <glifo> <rótulo alinhado> <valores…><preenchimento>`.
 *
 * Sem `composerBg` (terminal sem truecolor) a linha sai SEM fundo e sem preenchimento —
 * o painel degrada para três linhas rotuladas, que continuam sendo três itens legíveis.
 * O rótulo nunca é truncado: é ele que dá sentido à linha inteira.
 */
function Linha(props: {
  readonly glyph: string;
  readonly rotulo: string;
  readonly segs: readonly Seg[];
  readonly teto: number;
  /** Componentes animados (pulso, barra de MCP) — entram DEPOIS dos segmentos de texto. */
  readonly extra?: React.ReactNode;
}): React.ReactElement {
  const cortados = caberSegs(props.segs, props.teto);
  const rot = props.rotulo.padEnd(ROTULO_COLS - 1, ' ');
  return (
    <Box>
      <Role name="fgDim">{props.glyph}</Role>
      <Text> </Text>
      <Role name="fgDim">{rot}</Role>
      <Text> </Text>
      {cortados.map((s, i) => (
        <Role key={i} name={s.role}>
          {s.text}
        </Role>
      ))}
      {props.extra}
    </Box>
  );
}
