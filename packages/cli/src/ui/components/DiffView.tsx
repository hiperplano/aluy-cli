// F164 (decisão do dono, 2026-07-02) · CLI-SEC-9 — janela cabeça+cauda + render de
// uma linha de DIFF unificado (`-`/`+` com direção no glifo + realce de sintaxe).
//
// Extraído do `<AskDialog>` (onde nasceu p/ a confirmação de efeito) p/ ser
// REUSADO pelo `<ToolLine>` no histórico/scrollback (transcript pós-execução,
// inclusive `--yolo`/auto-approved — onde o `<AskDialog>` nunca chega a existir).
// Um SÓ lugar formata diff — o dialog de permissão e o bloco de tool concluído
// mostram o MESMO recorte, nunca duas lógicas divergindo com o tempo.

import React from 'react';
import { Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { highlightToSegments, resolveLanguage } from '../markdown/index.js';

/** Linguagem inferida da extensão do path (p/ realçar o conteúdo do diff). */
export function langFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const ext = path.split('.').pop();
  return ext && ext !== path ? ext : undefined;
}

/**
 * F164 — JANELA do corpo do efeito. Um batch/heredoc ou diff de 100+ linhas
 * despejado INTEIRO não melhora a revisão — PIORA: estoura a tela e o COMEÇO
 * (a parte mais importante) rola p/ fora. A janela mostra a CABEÇA (o começo)
 * + a CAUDA (o fim) + a contagem EXPLÍCITA do oculto. Nada é RESUMIDO/
 * parafraseado, só recortado com marcador visível; abaixo do teto o render é
 * IDÊNTICO ao de antes.
 */
export const ASK_EFFECT_MAX_LINES = 14;
const ASK_EFFECT_HEAD_LINES = 9;
const ASK_EFFECT_TAIL_LINES = 4; // cabeça + marcador (1) + cauda = ASK_EFFECT_MAX_LINES

export interface EffectWindow {
  readonly head: readonly string[];
  /** Linhas OCULTAS entre a cabeça e a cauda (0 = coube inteiro, sem marcador). */
  readonly hidden: number;
  readonly tail: readonly string[];
}

/** PURA (testável sem Ink): janela cabeça+cauda das linhas do efeito. */
export function windowEffectLines(lines: readonly string[]): EffectWindow {
  if (lines.length <= ASK_EFFECT_MAX_LINES) return { head: lines, hidden: 0, tail: [] };
  return {
    head: lines.slice(0, ASK_EFFECT_HEAD_LINES),
    hidden: lines.length - ASK_EFFECT_HEAD_LINES - ASK_EFFECT_TAIL_LINES,
    tail: lines.slice(lines.length - ASK_EFFECT_TAIL_LINES),
  };
}

/**
 * Uma linha de diff com DIREÇÃO no glifo (§2.9 refinado): remoção `‹` em danger,
 * adição `›` em success, contexto em dim. O glifo `‹`/`›` carrega a direção ALÉM
 * da cor (a11y §3.3) — em NO_COLOR/mono nada se perde. Cabeçalhos de hunk do
 * unified diff (`---`/`+++`/`@@`) ficam em dim (meta, não conteúdo).
 */
export function DiffLine(props: {
  readonly line: string;
  readonly lang?: string | undefined;
}): React.ReactElement {
  const theme = useTheme();
  const l = props.line;
  // cabeçalhos do unified diff: meta estrutural (não é uma linha de mudança).
  if (l.startsWith('---') || l.startsWith('+++') || l.startsWith('@@')) {
    return <Role name="fgDim">{l}</Role>;
  }
  if (l.startsWith('-')) {
    // SINAL/direção em `danger` (mantém `‹` + vermelho do diff, a11y §3.3); o
    // CONTEÚDO ganha realce de sintaxe — mas tingido p/ não perder o "isto saiu":
    // sem lang, fica tudo `danger`; com lang, realça e o sinal segue em danger.
    return (
      <Text>
        <Role name="danger">{theme.glyph('diffDel')} </Role>
        <HighlightedCode code={l.slice(1)} lang={props.lang} fallback="danger" />
      </Text>
    );
  }
  if (l.startsWith('+')) {
    return (
      <Text>
        <Role name="success">{theme.glyph('diffAdd')} </Role>
        <HighlightedCode code={l.slice(1)} lang={props.lang} fallback="success" />
      </Text>
    );
  }
  return <Role name="fgDim">{l}</Role>;
}

/**
 * Conteúdo de uma linha (de diff) realçado por sintaxe. Sem `lang` (ou linha
 * vazia) ⇒ um único papel `fallback` (mantém o verde/vermelho do sinal de diff).
 */
function HighlightedCode(props: {
  readonly code: string;
  readonly lang?: string | undefined;
  readonly fallback: 'danger' | 'success' | 'fg';
}): React.ReactElement {
  if (props.lang === undefined || props.code === '') {
    return <Role name={props.fallback}>{props.code}</Role>;
  }
  const segs = highlightToSegments(props.code, props.lang);
  return (
    <Text>
      {segs.map((s, i) => (
        <Role key={i} name={s.role}>
          {s.text}
        </Role>
      ))}
    </Text>
  );
}

/** Resolve o `lang` (p/ `<DiffLine>`) a partir de um path — degrada p/ `undefined`. */
export function diffLangOf(path: string | undefined): string | undefined {
  return resolveLanguage(langFromPath(path)) ?? undefined;
}
