// EST-0958 · spec §2.6/§2.8 — <BangBlock>: bloco de saída de um `!comando` (atalho
// de shell do composer). É uma ação do USUÁRIO (não turno do modelo): mostra o
// comando EXATO (CLI-SEC-9: `$ <cmd>`) e a saída como um BLOCO DE SAÍDA.
//
// Estados (a11y §3.3 — palavra sempre ao lado do glifo, nunca só cor):
//   running ⇒ `◌ shell $ <cmd> ～› rodando…` (in-flight, via <Working>)
//   ok/err  ⇒ `⏺ shell $ <cmd>  ✓/✗` + box "saída" com o stdout/stderr
//   blocked ⇒ `✗ shell $ <cmd>  bloqueado` + box com o motivo da catraca
//
// Tokens-only (papéis do DS: accent/fg/fgDim/success/danger; box do tema). Nada de
// cor crua. Reusa a estética da <ToolLine> (mesma "tabela limpa" + box de saída).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { Working } from './Working.js';
import { windowTailVisual } from '../../session/visual-lines.js';
import { clampLiveOutputChars, MAX_LIVE_OUTPUT_CHARS } from '../../session/live-budget.js';

/**
 * Indentação (colunas) da SAÍDA AO VIVO sob o in-flight: o bloco está num
 * `<Box paddingLeft={2}>` e a saída num `<Box paddingLeft={2}>` ANINHADO ⇒ 4 colunas.
 * O wrap da saída acontece, portanto, em `columns - 4`.
 */
const LIVE_OUTPUT_INDENT = 4;

export interface BangBlockProps {
  /** O comando EXATO digitado após o `!` (sem o `!`). */
  readonly command: string;
  /** running (in-flight) · ok/err (executou) · blocked (catraca negou). */
  readonly status: 'running' | 'ok' | 'err' | 'blocked';
  /** Saída bruta (exit/stdout/stderr) ou o motivo do bloqueio. */
  readonly output?: string;
  /** Frame do tick central (anima a onda do in-flight). Puro. */
  readonly frame?: number;
  /**
   * EST-0982 — SAÍDA AO VIVO do `!comando` enquanto roda (já redigida, CLI-SEC-6).
   * Mostrada bounded pela cauda (`maxLines`) sob o in-flight. Some quando resolve.
   */
  readonly liveOutput?: string;
  /** Anti-flicker — teto de altura VISUAL da prévia viva (cauda). */
  readonly maxLines?: number;
  /**
   * Largura do terminal (colunas) — p/ medir a altura VISUAL (wrap) da saída ao vivo
   * ao janelar a cauda. Ausente/0 ⇒ janela por linhas-FONTE (comportamento antigo).
   */
  readonly columns?: number;
}

/** Rótulo curto do verbo (alinha com a coluna `bash` da <ToolLine>). */
const VERB = 'shell';

export function BangBlock(props: BangBlockProps): React.ReactElement {
  const theme = useTheme();

  // ── in-flight (§2.6): ◌ + shell + comando + onda + gerúndio ──────────────────
  if (props.status === 'running') {
    // EST-0982 — saída ao vivo bounded (cauda) sob o in-flight, quando há.
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
          label={`rodando $ ${props.command}`}
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
  const isBlocked = props.status === 'blocked';
  // a11y: a palavra de estado acompanha SEMPRE o glifo (nunca só cor).
  const stateWord = isBlocked ? 'bloqueado' : isErr ? 'erro' : 'ok';
  const output = props.output ?? '';

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        {/* Glifo de conclusão (⏺) p/ ok/err; glifo de erro (✗) p/ bloqueado. */}
        {isBlocked ? <Glyph name="err" role="danger" /> : <Glyph name="tool" role="depth" />}
        <Role name="fg"> {VERB} </Role>
        <Role name="accent">$ </Role>
        <Role name="fg">{props.command}</Role>
        <Text> </Text>
        {isBlocked || isErr ? (
          <Glyph name="err" role="danger" />
        ) : (
          <Glyph name="ok" role="success" />
        )}
        <Role name={isBlocked || isErr ? 'danger' : 'fgDim'}> {stateWord}</Role>
      </Box>
      {output.trim() !== '' && (
        <Box flexDirection="column" paddingLeft={2}>
          <Role name="fgDim">
            {theme.box.topLeft} saída {theme.box.horizontal.repeat(8)}
          </Role>
          {output.split('\n').map((line, i) => (
            <Box key={i}>
              <Role name="fgDim">{theme.box.vertical} </Role>
              <Role name={isBlocked || isErr ? 'danger' : 'fg'}>{line}</Role>
            </Box>
          ))}
          <Role name="fgDim">
            {theme.box.bottomLeft} {stateWord} {theme.box.horizontal.repeat(4)}
          </Role>
        </Box>
      )}
    </Box>
  );
}
