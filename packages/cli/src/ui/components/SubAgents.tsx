// EST-0969 (display) · spec §sub-agentes — <SubAgents>: o INDICADOR COMPACTO dos
// sub-agentes paralelos.
//
// O bug que isto resolve: sub-agentes paralelos NÃO devem despejar os tokens crus
// de cada filho na região viva (interleava → lixo ilegível, "Usar Go?rust", "fGomt").
// Em vez disso, um bloco estável `⊕ N sub-agentes:` com uma linha de STATUS por
// filho (`[rust] ◷ rodando` → `[rust] ✓ pronto · 1.2k tokens · 3 tools`), atualizado
// quando cada um inicia/termina — NUNCA o corpo/stream do filho.
//
// a11y (§3.3): o estado vem SEMPRE com a PALAVRA ao lado do glifo (`rodando`/`pronto`/
// `falhou`), nunca só pela cor. Bloco ESTÁVEL (sem jitter): só muda na transição de
// um filho (início/fim), não a cada token — então não treme como o stream.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import stringWidth from 'string-width';
import { ShimmerText } from './ShimmerText.js';
import { formatSegundos } from '../../session/verbos.js';

/** Espelha `SubAgentChild` do model (sem importar o tipo p/ manter o componente puro). */
export interface SubAgentChildView {
  readonly label: string;
  // EST-0982 — `cancelled` quando o usuário PAROU este filho (cessar≠falha).
  readonly status: 'running' | 'done' | 'fail' | 'cancelled';
  readonly summary?: string;
  readonly stop?: 'final' | 'limit' | 'timeout' | 'error' | 'cancelled' | 'paused';
  /**
   * ADR-0146 (D5) — NOME do tier/modelo RESOLVIDO deste filho (`aluy-strata`,
   * `custom · <slug>`, `herdado (...)`). NUNCA provider/base_url/credencial
   * (HG-2/CLI-SEC-7) — mesmo filtro da status bar do pai.
   */
  readonly model?: string;
  /** F13 — início (epoch ms) do filho vivo: a linha mostra `· 7s` mesmo sem tokens ainda. */
  readonly startedAt?: number;
  /** ADR 0006 — palavra de estado própria (`aguardando aprovação`, `espera t1`): não é "rodando", então sem brilho. */
  readonly word?: string;
}

export interface SubAgentsProps {
  /**
   * Os filhos a exibir (status por filho). Nome `childrenStatus` (não `children`) p/
   * NÃO colidir com a prop `children` do React — aqui é DADO de status, não nós JSX.
   */
  readonly childrenStatus: readonly SubAgentChildView[];
  /**
   * O lote já está no HISTÓRICO (escrito uma vez, nunca repintado) com filhos ainda rodando em
   * segundo plano. Aí "rodando" viraria mentira congelada no scrollback; a palavra é "em segundo
   * plano" (o estado ao vivo mora no painel do rodapé).
   */
  readonly settled?: boolean;
  /** Frame do tick central (brilho dos filhos rodando). Ausente ⇒ frame 0. */
  readonly frame?: number;
  /** Rodapé: sem o respiro de baixo (o painel fica colado ao que vem antes/depois). */
  readonly flush?: boolean;
}

/** Palavra do estado (a11y): glifo NUNCA sozinho. `timeout`/`limit` ⇒ palavra honesta. */
function statusWord(child: SubAgentChildView, settled = false): string {
  if (child.word !== undefined) return child.word;
  if (child.status === 'running') return settled ? 'em segundo plano' : 'rodando';
  if (child.status === 'done') return 'pronto';
  // EST-0982 — PARADO pelo usuário: cessar≠falha (a11y honesta).
  // PAUSA POR COTA — pausado não é parado nem falhou: o trabalho está guardado e retoma.
  if (child.status === 'cancelled' && child.stop === 'paused') return 'pausado (cota)';
  if (child.status === 'cancelled') return 'parado';
  // fail: distingue o motivo p/ o usuário (teto vs timeout vs erro).
  switch (child.stop) {
    case 'timeout':
      return 'timeout';
    case 'limit':
      return 'teto';
    default:
      return 'falhou';
  }
}

/** UMA linha de filho: `  [rust] ◷ rodando` / `  [rust] ✓ pronto · 1.2k tokens · 3 tools`. */
export function ChildLine(props: {
  readonly child: SubAgentChildView;
  readonly settled?: boolean;
  readonly frame?: number;
}): React.ReactElement {
  const theme = useTheme();
  // Texto livre (atividade da tool, objetivo) numa linha só: controle/tab/CR somem — o Ink conta
  // `\t` como 0 coluna e o terminal como até 8, e a linha quebraria fisicamente (fantasma de quadro).
  const limpo = (t: string): string =>
    Array.from(t, (ch) => {
      const n = ch.codePointAt(0) ?? 0;
      return n < 0x20 || (n >= 0x7f && n <= 0x9f) ? ' ' : ch;
    }).join('');
  const c0 = props.child;
  const c: SubAgentChildView = {
    ...c0,
    label: limpo(c0.label),
    ...(c0.summary !== undefined ? { summary: limpo(c0.summary) } : {}),
  };
  const word = statusWord(c, props.settled === true);
  const glyph =
    c.status === 'running' ? (
      <Glyph name="clock" role="depth" />
    ) : c.status === 'done' ? (
      <Glyph name="ok" role="success" />
    ) : c.status === 'cancelled' ? (
      // PARADO pelo usuário (cessar≠falha): glifo neutro `dim`, não `danger`.
      <Glyph name="err" role="fgDim" />
    ) : (
      <Glyph name="err" role="danger" />
    );
  // Só quem está RODANDO brilha — `settled` (scrollback) é história, nunca repinta.
  const viva = c.status === 'running' && c.word === undefined && props.settled !== true;
  const rotulo = `[${c.label}]`;
  const total = rotulo.length + 1 + word.length;
  const wordRole = c.status === 'done' ? 'success' : c.status === 'fail' ? 'danger' : 'fgDim';
  // O `✔` mede DUAS colunas na conta do Ink (`string-width`) e UMA na nossa
  // (`displayWidth`) — as duas bibliotecas discordam. Com o separador FIXO em um espaço, a
  // linha do filho PRONTO nascia uma coluna mais larga que a dos outros: o `✔  pronto`
  // saía com um espaço a mais que o `✘ falhou` logo abaixo. Visível na tela do dono.
  //
  // A célula do glifo passa a ter largura FIXA, medida pela conta do próprio Ink.
  const nomeGlifo =
    c.status === 'running'
      ? 'clock'
      : c.status === 'done'
        ? 'ok'
        : c.status === 'cancelled'
          ? 'err'
          : 'err';
  // A célula do glifo vale 2 colunas SEMPRE, e o separador é 1 espaço em cima disso.
  // (A primeira tentativa usava `max(1, 2 - largura)`, que dá 1 nos dois casos e não
  // compensa nada — o `✔` seguia uma coluna à frente do `✘`.)
  const espacoAposGlifo = ' '.repeat(Math.max(0, 2 - stringWidth(theme.glyph(nomeGlifo))) + 1);
  return (
    <Box paddingLeft={2}>
      {/* BRILHO: enquanto RODA, a banda de cor da marca varre `[nome] … palavra` (o sinal de
          "vivo"; o relógio/glifo é só complemento). Terminado/pausado/falho: estático. */}
      {viva ? (
        <ShimmerText text={rotulo} frame={props.frame ?? 0} papelEstatico="accent" total={total} />
      ) : (
        <Role name="accent">{rotulo}</Role>
      )}
      <Text> </Text>
      {glyph}
      <Text>{espacoAposGlifo}</Text>
      {viva ? (
        <ShimmerText
          text={word}
          frame={props.frame ?? 0}
          offset={rotulo.length + 1}
          total={total}
        />
      ) : (
        <Role name={wordRole}>{word}</Role>
      )}
      {/* ADR-0146 (D5) — tier/modelo RESOLVIDO: visível enquanto roda E mantido no
          resumo final (mesma linha, ao lado do status/summary). NUNCA credencial. */}
      {c.model !== undefined && <Role name="fgDim"> · {c.model}</Role>}
      {/* O resumo aparece TAMBÉM enquanto ele corre. Era escondido no `running` porque, na
          época, o número só existia no fim; desde que o uso do filho passou a subir a cada
          débito (`onChildProgress`), esconder o resumo é esconder justamente o que muda. */}
      {c.summary !== undefined && <Role name="fgDim"> · {c.summary}</Role>}
      {/* F13 — sem o relógio, um filho esperando a 1ª resposta do modelo ficava em "0 tokens"
          por segundos, indistinguível de travado. */}
      {viva && c.startedAt !== undefined && (
        <Role name="fgDim"> · {formatSegundos(Date.now() - c.startedAt)}</Role>
      )}
    </Box>
  );
}

export function SubAgents(props: SubAgentsProps): React.ReactElement {
  const items = props.childrenStatus;
  const total = items.length;
  const running = items.filter((c) => c.status === 'running').length;
  // Cabeçalho compacto: `⊕ 3 sub-agentes:` (com `(N rodando)` enquanto há vivos).
  const headTail =
    running > 0 ? ` (${running} ${props.settled === true ? 'em segundo plano' : 'rodando'})` : '';
  return (
    <Box flexDirection="column" paddingLeft={2} paddingBottom={props.flush === true ? 0 : 1}>
      <Box>
        <Glyph name="subagents" role="accent" />
        <Role name="fg">
          {' '}
          {total} sub-agente{total === 1 ? '' : 's'}:
        </Role>
        {headTail !== '' && <Role name="fgDim">{headTail}</Role>}
      </Box>
      {items.map((c, i) => {
        const line = (
          <ChildLine
            key={`${c.label}:${i}`}
            child={c}
            settled={props.settled === true}
            {...(props.frame !== undefined ? { frame: props.frame } : {})}
          />
        );
        // Cópia FIXA do rodapé: UMA linha por agente (quebrar em terminal estreito mudava a
        // altura do rodapé e o composer pulava).
        return props.flush === true ? (
          <Box key={`${c.label}:${i}`} height={1} overflow="hidden">
            {line}
          </Box>
        ) : (
          line
        );
      })}
    </Box>
  );
}
