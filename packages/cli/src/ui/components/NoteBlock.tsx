// EST-0948 · spec §2.15 — <NoteBlock>: saída de um slash-command na conversa.
//
// Resposta da TUI a `/help`, `/model`, `/usage`, `/whoami`… Não é fala do agente
// (◇) nem do usuário (▌): é o sistema respondendo. Bloco `◷` dim com título +
// linhas. NUNCA mostra provider/modelo (HG-2) — `/model` só passa o `tier` aqui.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role } from '../theme/index.js';
import { ROTULO_COLS } from './StatusPanel.js';

export interface NoteBlockProps {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * F-HEADER-HARMONIA — a nota de boot na MESMA gramática do painel de status.
 *
 * O rodapé já lia como tabela — glifo, rótulo alinhado em coluna, valor à direita
 * (`◕ sessão  local · openrouter · …`). O topo não: o glifo colava na margem, o título
 * ficava sozinho numa linha e o valor caía recuado na linha seguinte. Eram dois sistemas de
 * alinhamento na mesma tela, e é isso que fazia o topo parecer de outro produto.
 *
 * Agora a primeira linha da nota sobe para o lado do rótulo. As demais (quando há) seguem
 * alinhadas SOB o valor, não sob o glifo — a continuação pertence ao valor.
 *
 * `ROTULO_COLS` é o mesmo do `<StatusPanel>`: é a coluna compartilhada que faz o topo e o
 * rodapé lerem como um sistema só. Mudar um sem o outro reabre a divergência.
 */
/** Coluna onde o TÍTULO da nota começa: o glifo (1) + o espaço (1). */
export const NOTE_TITLE_COL = 2;

/** O título cabe na coluna de rótulo compartilhada com o `<StatusPanel>`? */
export function noteTitleFitsColumn(title: string): boolean {
  return title.length <= ROTULO_COLS - 1;
}

/**
 * RECUO das linhas que descem — a decisão mora AQUI porque duas camadas dependem dela: o
 * desenho (este componente) e a MEDIÇÃO de altura do cockpit (`cockpit-conversa.ts`, que
 * calcula a largura disponível para quebrar o texto). Divergir as duas faz o cockpit medir
 * uma altura que o render não produz — que é o jitter que o ADR-0076 §5 existe para matar.
 *
 * Título que CABE na coluna: a primeira linha sobe para o lado do rótulo, e as demais se
 * alinham SOB ela — a continuação pertence ao valor, e o alinhamento com o `<StatusPanel>`
 * é o que faz topo e rodapé lerem como um sistema só.
 *
 * Título que NÃO cabe (`fan-out concluído`, `service instalados (1)`): não há valor nenhum
 * na primeira linha — ela é só o título. Recuar as continuações por `ROTULO_COLS + 1` as
 * alinhava sob uma coluna que não está lá, e custava 9 colunas de largura. O dono viu isso
 * como "esse tab que fica na frase em verde e abaixo em cinza ta muito longe", e o preço
 * aparecia nas tabelas: com o recuo do bloco e o do próprio `tableLines` somados, uma tabela
 * dentro de nota começava na coluna 13 e a última coluna vinha truncada. Nesse caso a
 * continuação alinha sob o TÍTULO, que é o que ela de fato continua.
 */
export function noteContinuationIndent(title: string): number {
  // DERIVADO das partes do cabeçalho, não cravado: glifo (1) + espaço (1) + rótulo com
  // `padEnd(ROTULO_COLS - 1)` + espaço (1). Era `ROTULO_COLS + 1`, uma coluna A MENOS que
  // onde o valor de fato começa — o alinhamento que este bloco existe para criar errava por
  // um, e ninguém media. Escrever a soma das partes faz o número acompanhar o desenho se
  // alguma delas mudar.
  const colunaDoValor = NOTE_TITLE_COL + (ROTULO_COLS - 1) + 1;
  return noteTitleFitsColumn(title) ? colunaDoValor : NOTE_TITLE_COL;
}

export function NoteBlock(props: NoteBlockProps): React.ReactElement {
  // Rótulo que NÃO cabe na coluna (`provider` tem 8, a coluna tem 7) empurraria o valor uma
  // coluna à frente e quebraria justamente o alinhamento que esta mudança veio criar — as
  // continuações ficariam numa coluna e a primeira linha em outra. Nesse caso o valor INTEIRO
  // desce, e todas as linhas ficam alinhadas entre si. A coluna vale mais que economizar uma
  // linha.
  const cabeNaColuna = noteTitleFitsColumn(props.title);
  const linhasAbaixo = cabeNaColuna ? props.lines.slice(1) : props.lines;
  const primeira = cabeNaColuna ? props.lines[0] : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Glyph name="clock" role="depth" />
        <Text> </Text>
        <Role name="depth">{props.title.padEnd(ROTULO_COLS - 1, ' ')}</Role>
        <Text> </Text>
        {primeira !== undefined && <Role name="fgDim">{primeira}</Role>}
      </Box>
      {linhasAbaixo.length > 0 && (
        <Box flexDirection="column" paddingLeft={noteContinuationIndent(props.title)}>
          {linhasAbaixo.map((line, i) => (
            <Role key={i} name="fgDim">
              {line}
            </Role>
          ))}
        </Box>
      )}
    </Box>
  );
}
