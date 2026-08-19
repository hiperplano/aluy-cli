// EST-0948 · spec §2.5/§2.6 — <ToolLine>: `⏺ verbo alvo resultado ✓/✗` e o
// in-flight `◌ verbo alvo ～～› rodando…`.
//
// Uma linha por tool, em COLUNAS ALINHADAS (§2.7): glifo + verbo (largura fixa) +
// alvo + resultado QUANTIFICADO (dim, à direita) + ✓ (success) ou ✗ (danger).
// a11y (§3.3): o estado vem SEMPRE com a palavra/contagem ao lado do glifo, nunca
// só pela cor. No erro, uma box "saída" de borda esmaecida com o rodapé-resumo na
// própria borda inferior (§2.8). Em `running` (§2.6), o anel `◌` + o `<Working>`
// (onda + gerúndio) mostram a tool EM EXECUÇÃO; ao concluir vira `⏺` + resultado.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { Working } from './Working.js';
import { windowTailVisual, capLongSourceLines } from '../../session/visual-lines.js';
import { clampLiveOutputChars, MAX_LIVE_OUTPUT_CHARS } from '../../session/live-budget.js';
import { DiffLine, diffLangOf, windowEffectLines } from './DiffView.js';

/** Largura fixa do verbo p/ alinhar a coluna do alvo (§2.7 "tabela limpa"). */
const VERB_WIDTH = 7;

/**
 * Indentação (colunas) da SAÍDA AO VIVO sob o in-flight: a tool `running` está num
 * `<Box paddingLeft={2}>` e a saída num `<Box paddingLeft={2}>` ANINHADO ⇒ 4 colunas.
 * O wrap da saída acontece, portanto, em `columns - 4`.
 */
const LIVE_OUTPUT_INDENT = 4;

function padVerb(verb: string): string {
  return verb.length >= VERB_WIDTH ? verb : verb + ' '.repeat(VERB_WIDTH - verb.length);
}

export interface ToolLineProps {
  readonly verb: string;
  readonly target: string;
  readonly result: string;
  readonly status: 'ok' | 'err' | 'running';
  /** Saída relevante (só no erro). Já truncada pelo produtor. */
  readonly output?: string;
  /** Gerúndio do in-flight (`rodando`, `lendo`). Usado quando `running`. */
  readonly verbGerund?: string;
  /** Frame do tick central (in-flight anima a onda). Puro. */
  readonly frame?: number;
  /**
   * EST-0982 — SAÍDA AO VIVO de um `run_command` enquanto roda (já redigida,
   * CLI-SEC-6, pelo core). Mostrada bounded pela CAUDA (`maxLines`) sob a linha
   * `◌ rodando…`: o usuário vê o progresso em vez de tela congelada. Some quando
   * a linha resolve (o resultado a substitui).
   */
  readonly liveOutput?: string;
  /** Anti-flicker — teto de altura VISUAL da prévia viva (cauda). Sem ele, mostra tudo. */
  readonly maxLines?: number;
  /**
   * Largura do terminal (colunas) — p/ medir a altura VISUAL (wrap) da saída ao vivo
   * ao janelar a cauda. Ausente/0 ⇒ janela por linhas-FONTE (comportamento antigo).
   */
  readonly columns?: number;
  /**
   * DIFF unificado de um `edit_file`/`write_file` concluído (o mesmo `result.display`
   * que o `<AskDialog>` já mostra no ask, CLI-SEC-9) — bloco compacto (cabeça+cauda,
   * `windowEffectLines`/DiffView) ANEXADO abaixo da linha `⏺`. Só faz sentido junto de
   * `status !== 'running'` (o produtor — `tool-reporter.ts` — só o preenche quando o
   * `ToolResult` já resolveu com sucesso): por isso este bloco NUNCA aparece no ramo
   * `running` acima, o que garante que ele só entra em cena depois que `isLiveBlock`
   * (render-split.ts) já classifica o bloco como CONCLUÍDO — ou seja, só no `<Static>`
   * (histórico), nunca na região viva. `undefined` ⇒ sem diff a mostrar (tool não
   * editou, ou editou e falhou).
   */
  readonly diff?: string;
}

export function ToolLine(props: ToolLineProps): React.ReactElement {
  const theme = useTheme();

  // ── in-flight (§2.6): ◌ + verbo + alvo + onda + gerúndio (via <Working>) ──────
  if (props.status === 'running') {
    const label = `${props.verbGerund ?? 'rodando'}${props.target ? ` ${props.target}` : ''}`;
    // EST-0982 — saída ao vivo bounded (cauda) sob o in-flight, quando há. Apara as
    // quebras finais p/ não despejar linhas vazias na região viva (altura estável).
    // HUNT-RENDER: cap o RAW string ANTES de processar — `windowTailVisual` varre o
    // texto INTEIRO a cada tick (~120ms); com output de MBs vira jank/flicker.
    const liveRaw = clampLiveOutputChars(props.liveOutput ?? '', MAX_LIVE_OUTPUT_CHARS);
    const live = liveRaw.replace(/\n+$/, '');
    const liveCols = props.columns && props.columns > 0 ? props.columns - LIVE_OUTPUT_INDENT : 0;
    const { text: liveText, hidden } = windowTailVisual(live, props.maxLines, liveCols);
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Working
          glyph="toolInflight"
          glyphRole="depth"
          label={label}
          {...(props.frame !== undefined ? { frame: props.frame } : {})}
        />
        {liveText.length > 0 && (
          <Box flexDirection="column" paddingLeft={2}>
            {hidden > 0 && <Role name="fgDim">… ({hidden} linhas acima)</Role>}
            {liveText.split('\n').map((line, i) => (
              <Box key={i}>
                <Role name="fgDim">{line}</Role>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  const isErr = props.status === 'err';
  // Diff compacto (ver doc do prop `diff` acima) — cabeça+cauda, MESMO teto do
  // `<AskDialog>` (ASK_EFFECT_MAX_LINES via windowEffectLines): um edit grande NUNCA
  // despeja o arquivo inteiro no scrollback, só o recorte + a contagem do oculto.
  const diffWin = props.diff ? windowEffectLines(props.diff.split('\n')) : undefined;
  const diffLang = props.diff ? diffLangOf(props.target) : undefined;
  // GUARD DURO (fix "congela e não responde mais nada" — dono trocou p/ /fullscreen e mandou
  // uma msg) — a saída de ERRO CONCLUÍDA renderiza `output.split('\n')` CRU logo abaixo, sem
  // nenhuma janela (ao contrário do `liveOutput`, já bounded). Uma linha sem `\n`
  // patologicamente longa trava o Ink ao medir/quebrar o `<Text wrap>` dela (mesma raiz de
  // `windowTailVisual`/`capLongSourceLines`, visual-lines.ts — fonte única).
  const safeOutput = props.output !== undefined ? capLongSourceLines(props.output) : undefined;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Glyph name="tool" role="depth" />
        <Role name="fg"> {padVerb(props.verb)}</Role>
        <Text> </Text>
        <Role name="fg">{props.target}</Role>
        <Text> </Text>
        <Role name="fgDim">{props.result}</Role>
        <Text> </Text>
        {isErr ? <Glyph name="err" role="danger" /> : <Glyph name="ok" role="success" />}
      </Box>
      {isErr && safeOutput && (
        <Box flexDirection="column" paddingLeft={2}>
          <Role name="fgDim">
            {theme.box.topLeft} saída {theme.box.horizontal.repeat(8)}
          </Role>
          {safeOutput.split('\n').map((line, i) => (
            <Box key={i}>
              <Role name="fgDim">{theme.box.vertical} </Role>
              <Role name="danger">{line}</Role>
            </Box>
          ))}
          {/* rodapé-resumo na própria borda inferior (§2.8): `╰ <result> ─` */}
          <Role name="fgDim">
            {theme.box.bottomLeft} {props.result} {theme.box.horizontal.repeat(4)}
          </Role>
        </Box>
      )}
      {diffWin && (
        <Box flexDirection="column" paddingLeft={2}>
          <Role name="fgDim">
            {theme.box.topLeft} diff {theme.box.horizontal.repeat(6)}
          </Role>
          {diffWin.head.map((line, i) => (
            <Box key={`dh${i}`}>
              <Role name="fgDim">{theme.box.vertical} </Role>
              <DiffLine line={line} lang={diffLang} />
            </Box>
          ))}
          {diffWin.hidden > 0 && (
            <Box>
              <Role name="fgDim">
                {theme.box.vertical} … (+{diffWin.hidden} linhas ocultas)
              </Role>
            </Box>
          )}
          {diffWin.tail.map((line, i) => (
            <Box key={`dt${i}`}>
              <Role name="fgDim">{theme.box.vertical} </Role>
              <DiffLine line={line} lang={diffLang} />
            </Box>
          ))}
          <Role name="fgDim">
            {theme.box.bottomLeft} {theme.box.horizontal.repeat(8)}
          </Role>
        </Box>
      )}
    </Box>
  );
}
