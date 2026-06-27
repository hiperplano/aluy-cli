// EST-1110 · ADR-0114 — <QuestionDialog>: a UI da tool de núcleo `perguntar`.
//
// O agente PERGUNTA ao usuário (single/multi/text + "Outro") e CONTINUA com a resposta.
// NÃO é o <AskDialog> (permissão, EST-0948): aqui não há `[a]/[s]/[n]/[e]`, há ESCOLHA
// (lista navegável) ou TEXTO livre. Espelha a densidade/box do <AskDialog> com tokens
// do Aluy DS (sem cor crua) e a11y (glifo + texto; NO_COLOR/mono sem perda).
//
// APRESENTAÇÃO PURA (handoff §10 regra 3): a captura de tecla (setas/espaço/enter/esc)
// e o estado de interação (cursor, marcados, "Outro", rascunho) ficam no App.tsx (o
// MESMO orquestrador que já dirige composer/ask/picker). Este componente só RENDERIZA
// o `spec` + o estado corrente que recebe por props — testável sem captura de teclas.

import React from 'react';
import { Box } from 'ink';
import type { QuestionSpec } from '@hiperplano/aluy-cli-core';
import { Glyph, Role, useTheme } from '../theme/index.js';

/**
 * EST-1110 — índice SINTÉTICO da entrada "Outro" (resposta livre) em single/multi.
 * Fica DEPOIS das opções reais; o App usa este sentinel p/ saber que o cursor está na
 * entrada de texto livre (e abrir o campo de rascunho).
 */
export const OTHER_INDEX = -1;

export interface QuestionDialogProps {
  readonly spec: QuestionSpec;
  /**
   * single/multi: índice da linha sob o cursor (navegação ↑↓). `OTHER_INDEX` = a
   * entrada "Outro". Ignorado em `text`.
   */
  readonly cursor: number;
  /** multi: o conjunto de índices MARCADOS (espaço alterna). Ignorado fora de multi. */
  readonly selected?: ReadonlySet<number>;
  /**
   * `true` quando o usuário está digitando a resposta LIVRE — o campo "Outro" (single/
   * multi) OU o campo único do `text`. Mostra o `draft` + cursor.
   */
  readonly editing?: boolean;
  /** O texto livre em digitação (quando `editing`). */
  readonly draft?: string;
}

/**
 * Largura INTERNA (traços) das linhas horizontais da caixa — topo, separador e base
 * usam a MESMA, p/ os cantos ALINHAREM (antes era hardcoded 2/40/42 = assimétrico).
 * sep/base = `repeat(W)` entre os cantos ⇒ W+2 codepoints, glyph-independentes.
 */
const QUESTION_BOX_W = 42;

/**
 * Codepoints do PREFIXO do título no topo, ENTRE o canto e os traços — p/ o topo fechar
 * no MESMO codepoint que a base. São: 1 espaço (pós-canto) + 1 glifo `⚠` + 1 espaço +
 * " Pergunta " (10) = 13. (O `−12` antigo contava 12 e deixava o topo 1 codepoint mais
 * longo que a base — bug pego medindo o frame.) Resíduo conhecido: terminais que renderizam
 * `⚠` em 2 COLUNAS de DISPLAY ainda ficam +1 visual — inerente a box manual com glifo de
 * largura ambígua; sep/base seguem SEMPRE simétricos.
 */
const QUESTION_TITLE_CPS = 13;

/** `true` quando há entrada "Outro" (single/multi com allowOther — default true). */
function hasOther(spec: QuestionSpec): boolean {
  return spec.kind !== 'text' && spec.allowOther !== false;
}

export function QuestionDialog(props: QuestionDialogProps): React.ReactElement {
  const theme = useTheme();
  const { spec } = props;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* topo do box: TAG `? perguntar` à esquerda (espelha o title-tag do AskDialog). */}
      <Box>
        <Role name="accent">{theme.box.topLeft} </Role>
        <Glyph name="ask" role="accent" />
        <Role name="accent">
          {' '}
          Pergunta {theme.box.horizontal.repeat(QUESTION_BOX_W - QUESTION_TITLE_CPS)}
          {theme.box.topRight}
        </Role>
      </Box>

      {/* respiro */}
      <Role name="accent">{theme.box.vertical}</Role>

      {/* cabeçalho opcional (contexto curto) */}
      {spec.header !== undefined && (
        <Box>
          <Role name="accent">{theme.box.vertical} </Role>
          <Role name="depth">{spec.header}</Role>
        </Box>
      )}

      {/* a PERGUNTA (uma ou mais linhas) */}
      {spec.question.split('\n').map((line, i) => (
        <Box key={`q-${i}`}>
          <Role name="accent">{theme.box.vertical} </Role>
          <Role name="fg">{line}</Role>
        </Box>
      ))}

      {/* respiro antes das opções/campo */}
      <Role name="accent">{theme.box.vertical}</Role>

      {spec.kind === 'text' ? (
        <TextField theme={theme} draft={props.draft ?? ''} />
      ) : (
        <OptionList {...props} />
      )}

      {/* separador antes do footer de atalhos */}
      <Role name="accent">
        {theme.box.teeLeft}
        {theme.box.horizontal.repeat(QUESTION_BOX_W)}
        {theme.box.teeRight}
      </Role>
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name="fgDim">{footerOf(spec, props.editing === true)}</Role>
      </Box>

      <Role name="accent">
        {theme.box.bottomLeft}
        {theme.box.horizontal.repeat(QUESTION_BOX_W)}
        {theme.box.bottomRight}
      </Role>
    </Box>
  );
}

/** Lista navegável de opções (single/multi) + a entrada "Outro". */
function OptionList(props: QuestionDialogProps): React.ReactElement {
  const theme = useTheme();
  const { spec } = props;
  const options = spec.options ?? [];
  const multi = spec.kind === 'multi';
  const selected = props.selected ?? new Set<number>();

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const onCursor = props.cursor === i;
        // marcador: multi = caixa [x]/[ ]; single = ponto ●/○ (radio). a11y: glifo + cor.
        const mark = multi ? (selected.has(i) ? '[x]' : '[ ]') : onCursor ? '(•)' : '( )';
        return (
          <Box key={`opt-${i}`}>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name={onCursor ? 'accent' : 'fgDim'}>{onCursor ? '›' : ' '} </Role>
            <Role name={onCursor ? 'accent' : 'fgDim'}>{mark} </Role>
            <Role name={onCursor ? 'accent' : 'fg'}>{opt.label}</Role>
            {opt.description !== undefined && <Role name="fgDim"> — {opt.description}</Role>}
          </Box>
        );
      })}

      {hasOther(spec) && (
        <OtherEntry
          theme={theme}
          onCursor={props.cursor === OTHER_INDEX}
          editing={props.editing === true && props.cursor === OTHER_INDEX}
          draft={props.draft ?? ''}
        />
      )}
    </Box>
  );
}

/** A entrada "Outro" (resposta livre) em single/multi. Abre o campo quando editando. */
function OtherEntry(props: {
  readonly theme: ReturnType<typeof useTheme>;
  readonly onCursor: boolean;
  readonly editing: boolean;
  readonly draft: string;
}): React.ReactElement {
  const { theme, onCursor, editing, draft } = props;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="accent">{theme.box.vertical} </Role>
        <Role name={onCursor ? 'accent' : 'fgDim'}>{onCursor ? '›' : ' '} </Role>
        <Role name={onCursor ? 'accent' : 'fg'}>Outro (resposta livre)</Role>
      </Box>
      {editing && (
        <Box>
          <Role name="accent">{theme.box.vertical} </Role>
          <Role name="fg">{draft}</Role>
          <Role name="accent">{theme.glyph('cursor')}</Role>
        </Box>
      )}
    </Box>
  );
}

/** O campo de texto livre (kind 'text'). */
function TextField(props: {
  readonly theme: ReturnType<typeof useTheme>;
  readonly draft: string;
}): React.ReactElement {
  const { theme, draft } = props;
  return (
    <Box>
      <Role name="accent">{theme.box.vertical} </Role>
      <Role name="depth">{theme.glyph('prompt')} </Role>
      <Role name="fg">{draft}</Role>
      <Role name="accent">{theme.glyph('cursor')}</Role>
    </Box>
  );
}

/** Footer linear de atalhos (a11y §4.3), por tipo de pergunta. */
function footerOf(spec: QuestionSpec, editing: boolean): string {
  if (editing) return 'enter confirma · esc cancela a digitação';
  if (spec.kind === 'text') return 'digite a resposta · enter confirma · esc cancela';
  if (spec.kind === 'multi') {
    return '↑↓ navega · espaço marca · enter confirma · esc cancela';
  }
  return '↑↓ navega · enter escolhe · esc cancela';
}

export default QuestionDialog;
