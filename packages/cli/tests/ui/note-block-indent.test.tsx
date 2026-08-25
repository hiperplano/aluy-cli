// RECUO DA NOTA — o dono, olhando a tela: "esse tab que fica na frase em verde e abaixo em
// cinza ta muito longe, outra coisa, acho que o tab das tabelas tambem ta muito grande".
//
// Eram a MESMA causa, somada três vezes. O `<NoteBlock>` recuava toda linha de continuação
// por `ROTULO_COLS + 1` (9) para alinhá-la SOB o valor — o que faz sentido quando o título
// cabe na coluna de rótulo e a primeira linha sobe para o lado dele (`◕ usage   linha um`).
// Com título LONGO não há valor nenhum na primeira linha, e o recuo alinhava sob uma coluna
// que não existe. Numa tabela o preço aparecia inteiro: 2 (bloco) + 9 (nota) + 2 (o próprio
// `tableLines`) = 13 colunas antes da primeira letra, e a última coluna vinha truncada.
//
// O que este arquivo trava: o recuo pequeno no caso do título longo, o alinhamento PRESERVADO
// no caso do título curto (é a harmonia com o `<StatusPanel>`, não um acidente), e a fonte
// ÚNICA da decisão — o cockpit mede a altura da nota com a mesma função que o render desenha,
// e medir com um recuo e desenhar com outro devolve o jitter que o ADR-0076 §5 mata.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  NoteBlock,
  noteContinuationIndent,
  noteTitleFitsColumn,
  NOTE_TITLE_COL,
} from '../../src/ui/components/NoteBlock.js';
import { ROTULO_COLS } from '../../src/ui/components/StatusPanel.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { tableLines } from '../../src/ui/table-lines.js';

/** Linhas do bloco, sem cor. */
function linhas(node: React.ReactElement): string[] {
  const { lastFrame } = render(<ThemeProvider theme={resolveTheme('escuro')}>{node}</ThemeProvider>);
  // eslint-disable-next-line no-control-regex
  return ((lastFrame() ?? '').replace(/\u001b\[[0-9;]*m/g, '')).split('\n');
}

/** Coluna da primeira letra (o recuo VISUAL de fato). */
const recuo = (l: string): number => l.search(/\S/);

describe('<NoteBlock> — recuo da continuação', () => {
  it('título LONGO: a continuação alinha sob o TÍTULO, não sob uma coluna inexistente', () => {
    const l = linhas(
      <NoteBlock title="fan-out concluído" lines={['3 sub-agentes terminaram.']} />,
    );
    expect(noteTitleFitsColumn('fan-out concluído')).toBe(false);
    expect(recuo(l[0]!)).toBe(0); // o glifo na margem
    expect(recuo(l[1]!)).toBe(NOTE_TITLE_COL);
    // O ponto do defeito: NÃO é mais o recuo da coluna de rótulo.
    expect(recuo(l[1]!)).toBeLessThan(ROTULO_COLS);
  });

  it('título CURTO: alinhamento com o <StatusPanel> PRESERVADO (não regride)', () => {
    const l = linhas(<NoteBlock title="usage" lines={['linha um', 'linha dois']} />);
    expect(noteTitleFitsColumn('usage')).toBe(true);
    // a 1ª linha sobe p/ o lado do rótulo; a 2ª desce alinhada SOB ela.
    expect(l[0]).toContain('linha um');
    // O alinhamento é medido CONTRA O RENDER, não contra uma constante: é a única forma de
    // pegar o erro-por-um que estava aqui (a continuação vinha uma coluna à esquerda do
    // valor). Se o cabeçalho mudar de composição, este teste acusa.
    expect(l[0]!.indexOf('linha um')).toBe(recuo(l[1]!));
    expect(recuo(l[1]!)).toBe(noteContinuationIndent('usage'));
  });

  it('tabela dentro de nota não perde 13 colunas para recuo', () => {
    const tabela = tableLines([['a', 'b']], { headers: ['col1', 'col2'] });
    const l = linhas(<NoteBlock title="service instalados (1)" lines={tabela} />);
    const daTabela = l.filter((x) => x.includes('col1') || x.includes('a  '));
    expect(daTabela.length).toBeGreaterThan(0);
    // 2 do recuo da nota + 2 do próprio tableLines. O bloco ainda soma os seus 2 na App,
    // então na tela dá 6 — era 13.
    for (const x of daTabela) expect(recuo(x)).toBe(NOTE_TITLE_COL + 2);
  });

  it('a decisão do recuo é UMA função — é o que o cockpit usa para MEDIR', () => {
    expect(noteContinuationIndent('usage')).toBe(NOTE_TITLE_COL + ROTULO_COLS);
    expect(noteContinuationIndent('fan-out concluído')).toBe(NOTE_TITLE_COL);
    // fronteira exata da coluna de rótulo (7 cabe, 8 não).
    expect(noteContinuationIndent('a'.repeat(ROTULO_COLS - 1))).toBe(NOTE_TITLE_COL + ROTULO_COLS);
    expect(noteContinuationIndent('a'.repeat(ROTULO_COLS))).toBe(NOTE_TITLE_COL);
  });
});
