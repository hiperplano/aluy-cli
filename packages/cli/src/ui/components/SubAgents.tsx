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
  /** Células disponíveis ao bloco (cada linha é ajustada em texto plano). Ausente ⇒ sem ajuste. */
  readonly maxWidth?: number;
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

/** Corta `texto` a `max` células (com `…` no fim). Texto PLANO — nunca passe aqui saída com ANSI. */
function cortar(texto: string, max: number): string {
  if (max <= 0) return '';
  if (stringWidth(texto) <= max) return texto;
  let out = '';
  for (const ch of texto) {
    if (stringWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Piso do objetivo (`[t1 …]`) antes de o resumo começar a ser cortado. */
const OBJETIVO_MIN = 18;

/**
 * Ajusta a linha do filho a `celulas` em TEXTO PLANO (antes de qualquer cor/brilho). Ordem do que
 * PERDE, até caber:
 *   1. `herdado (modelo)` — igual em todas as linhas e a statusline já mostra o modelo (um modelo
 *      NÃO herdado é informação e fica);
 *   2. o ` (97% cache)` do resumo;
 *   3. o objetivo, até `OBJETIVO_MIN`;
 *   4. o resumo (cortado com `…`);
 *   5. o modelo não herdado;
 *   6. o objetivo abaixo do piso;
 *   7. o tempo — por último.
 * `glifo` = células fixas do glifo + espaços. Sem `celulas` devolve tudo intacto.
 */
export function ajustarLinhaDoFilho(a: {
  readonly rotulo: string;
  readonly word: string;
  readonly model: string | undefined;
  readonly summary: string | undefined;
  readonly tempo: string | undefined;
  readonly celulas: number | undefined;
  readonly glifo: number;
}): { rotulo: string; model?: string; summary?: string; tempo?: string } {
  const sep = ' · ';
  const pack = (
    rotulo: string,
    model: string | undefined,
    summary: string | undefined,
    tempo: string | undefined,
  ): { rotulo: string; model?: string; summary?: string; tempo?: string } => ({
    rotulo,
    ...(model !== undefined ? { model } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(tempo !== undefined ? { tempo } : {}),
  });
  if (a.celulas === undefined) return pack(a.rotulo, a.model, a.summary, a.tempo);
  const celulas = a.celulas;
  let rotulo = a.rotulo;
  let model = a.model;
  let summary = a.summary;
  let tempo = a.tempo;
  const w = (t: string | undefined): number => (t === undefined ? 0 : stringWidth(sep + t));
  const total = (): number =>
    stringWidth(rotulo) + a.glifo + stringWidth(a.word) + w(model) + w(summary) + w(tempo);
  const falta = (): number => total() - celulas;
  if (falta() <= 0) return pack(rotulo, model, summary, tempo);
  // 1. modelo herdado
  if (model !== undefined && model.startsWith('herdado (')) model = undefined;
  // 2. % de cache
  if (falta() > 0 && summary !== undefined)
    summary = summary.replace(/\s*\(\d+% cache\)/, '') || undefined;
  // 3. objetivo até o piso
  if (falta() > 0 && stringWidth(rotulo) > OBJETIVO_MIN)
    rotulo = cortar(rotulo, Math.max(OBJETIVO_MIN, stringWidth(rotulo) - falta()));
  // 4. resumo
  if (falta() > 0 && summary !== undefined) {
    const cabe = stringWidth(summary) - falta() - stringWidth(sep);
    summary = cabe >= 4 ? cortar(summary, cabe) : undefined;
  }
  // 5. modelo não herdado
  if (falta() > 0) model = undefined;
  // 6. objetivo abaixo do piso
  if (falta() > 0) rotulo = cortar(rotulo, Math.max(6, stringWidth(rotulo) - falta()));
  // 7. tempo, por último
  if (falta() > 0) tempo = undefined;
  return pack(rotulo, model, summary, tempo);
}

/** UMA linha de filho: `  [rust] ◷ rodando` / `  [rust] ✓ pronto · 1.2k tokens · 3 tools`. */
export function ChildLine(props: {
  readonly child: SubAgentChildView;
  readonly settled?: boolean;
  readonly frame?: number;
  /**
   * Células disponíveis à linha INTEIRA (incluindo o recuo de 2 dela). Dado, a linha é ajustada em
   * TEXTO PLANO antes de pintar (cauda cortada: resumo → modelo → tempo). Sem isto, o Ink encolhia
   * cada pedaço da linha por conta própria e perdia letras/o modelo/o `tools` quando a linha não cabia.
   */
  readonly maxWidth?: number;
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
  const tempo =
    c.status === 'running' &&
    c.word === undefined &&
    props.settled !== true &&
    c.startedAt !== undefined
      ? formatSegundos(Date.now() - c.startedAt)
      : undefined;
  const ajuste = ajustarLinhaDoFilho({
    rotulo: `[${c.label}]`,
    word,
    model: c.model,
    summary: c.summary,
    tempo,
    celulas: props.maxWidth !== undefined ? props.maxWidth - 2 : undefined,
    glifo: 4,
  });
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
  const rotulo = ajuste.rotulo;
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
      {ajuste.model !== undefined && <Role name="fgDim"> · {ajuste.model}</Role>}
      {/* O resumo aparece TAMBÉM enquanto ele corre. Era escondido no `running` porque, na
          época, o número só existia no fim; desde que o uso do filho passou a subir a cada
          débito (`onChildProgress`), esconder o resumo é esconder justamente o que muda. */}
      {ajuste.summary !== undefined && <Role name="fgDim"> · {ajuste.summary}</Role>}
      {/* F13 — sem o relógio, um filho esperando a 1ª resposta do modelo ficava em "0 tokens"
          por segundos, indistinguível de travado. */}
      {viva && ajuste.tempo !== undefined && <Role name="fgDim"> · {ajuste.tempo}</Role>}
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
            {...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth - 2 } : {})}
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
