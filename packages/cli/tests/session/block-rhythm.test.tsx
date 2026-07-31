// RESPIRO antes do `Λ aluy` (achado do dono, dogfooding) — PROVA por RENDER REAL.
//
// O BUG: o bloco de resposta COLAVA na linha de ferramenta anterior —
//
//     ⏺  bash    echo "=== POSIÇÕES ATUAIS ===" … 0 erros ✓
//   Λ aluy
//     Sim, isso é exatamente o que está faltando…
//
// porque o respiro entre turnos é pago SEMPRE pelo `paddingBottom` do bloco de CIMA e a
// `<ToolLine>` não tem padding (de propósito: tools seguidas = lista compacta). O fix é
// CONDICIONAL ao bloco anterior (`block-rhythm.ts` + `prevKind` no `<BlockView>`), e o
// risco do fix é o EXTREMO OPOSTO: duas linhas em branco em `você → aluy`.
//
// As camadas provadas aqui (a 3ª é a que pega regressão de verdade):
//   1. a TABELA (`blockEndsWithBlankLine`) bate com o que o Ink DESENHA — se alguém
//      tirar/pôr um `paddingBottom` num bloco, este teste cai (não a UI do usuário);
//   2. a REGRA é total e complementar (nunca 0 respiros, nunca 2);
//   3. a SEQUÊNCIA renderizada (`você → tool → aluy → tool → aluy`) tem exatamente 1
//      linha em branco em CADA fronteira — e NENHUM par de linhas em branco seguidas;
//   4. a FRONTEIRA Static×viva — onde este repo já teve "buraco no meio da tela" e gap
//      crescente no resize — NÃO dobra a linha: o `<Box paddingY={1}>` do contêiner da
//      região viva já a paga, e o saldo não muda quando o bloco desce p/ o scrollback;
//   5. o ORÇAMENTO anti-flicker (`liveOverheadLines`) CONTA a linha nova quando ela
//      existe. Sem isso o frame vivo cruza `rows` por 1 linha e o Ink cai no
//      `clearTerminal` (o flicker que `live-budget.ts` existe p/ evitar).

import React from 'react';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { BlockView } from '../../src/session/App.js';
import { aluyNeedsLeadingBlank, blockEndsWithBlankLine } from '../../src/session/block-rhythm.js';
import { liveOverheadLines } from '../../src/session/live-budget.js';
import type { SessionBlock } from '../../src/session/model.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const COLS = 80;

/** Renderiza nós dentro de uma coluna de `COLS` (o que ATIVA o wrap do Ink) e devolve as linhas. */
function frameLines(node: React.ReactElement): string[] {
  const out =
    render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <Box width={COLS} flexDirection="column">
          {node}
        </Box>
      </ThemeProvider>,
    ).lastFrame() ?? '';
  return out.split('\n').map((l) => l.trimEnd());
}

/** UM bloco, como o `<Static>`/região viva o desenham (com o vizinho de cima em mãos). */
function blockLines(block: SessionBlock, prevKind?: SessionBlock['kind']): string[] {
  return frameLines(
    <BlockView block={block} isCurrent={false} frame={0} columns={COLS} prevKind={prevKind} />,
  );
}

/** Um exemplar de CADA `kind` do `SessionBlock` — a bateria exaustiva da tabela. */
const SAMPLES: readonly SessionBlock[] = [
  { kind: 'you', text: 'oi' },
  { kind: 'aluy', text: 'ola', streaming: false },
  { kind: 'tool', verb: 'bash', target: 'echo oi', result: '0 erros', status: 'ok' },
  { kind: 'deny', verb: 'escrever', exact: '/etc/passwd' },
  { kind: 'bang', command: 'ls', status: 'ok', output: 'a.txt' },
  { kind: 'subagents', children: [{ label: 'rust', status: 'done' }] },
  { kind: 'broker-error', message: 'sem crédito' },
  { kind: 'note', title: 'nota', lines: ['uma linha'] },
  { kind: 'doctor', checks: [{ label: 'versão', status: 'ok' }], summary: 'tudo certo' },
  { kind: 'inject', text: 'btw, use tabs' },
  {
    kind: 'testrun',
    score: { passed: 3, failed: 0, total: 3, failures: [] },
    running: false,
    startedAt: 0,
  },
];

describe('block-rhythm — a TABELA bate com o que o Ink desenha (paridade render)', () => {
  for (const b of SAMPLES) {
    it(`${b.kind}: blockEndsWithBlankLine reflete o render REAL`, () => {
      const lines = blockLines(b);
      // "termina em branco" = a ÚLTIMA linha do frame do bloco é vazia (o
      // `paddingBottom={1}` do wrapper). É a única coisa que o vizinho de baixo
      // precisa saber p/ decidir se paga o respiro.
      const endsBlank = lines.length > 1 && lines[lines.length - 1] === '';
      expect(endsBlank).toBe(blockEndsWithBlankLine(b.kind));
    });
  }
});

describe('block-rhythm — a REGRA (pura): total, complementar, sem respiro no topo', () => {
  it('sem bloco anterior (1º da conversa / cockpit) ⇒ NUNCA respira', () => {
    expect(aluyNeedsLeadingBlank(undefined)).toBe(false);
  });

  it('respira EXATAMENTE quando o anterior NÃO termina em branco (nunca 0, nunca 2)', () => {
    for (const b of SAMPLES) {
      expect(aluyNeedsLeadingBlank(b.kind)).toBe(!blockEndsWithBlankLine(b.kind));
    }
  });
});

describe('block-rhythm — a SEQUÊNCIA do bug do dono, renderizada pelo Ink', () => {
  // `você → tool → aluy → tool → aluy`: o caso REPORTADO (a resposta colada na tool) +
  // o caso de risco do fix (`você → aluy`, que não pode ganhar 2 linhas em branco).
  const SEQ: readonly SessionBlock[] = [
    { kind: 'you', text: 'confere as posicoes' },
    { kind: 'tool', verb: 'bash', target: 'echo pos', result: '0 erros', status: 'ok' },
    { kind: 'aluy', text: 'RESP-A', streaming: false },
    { kind: 'tool', verb: 'ler', target: 'App.tsx', result: '120 linhas', status: 'ok' },
    { kind: 'aluy', text: 'RESP-B', streaming: false },
  ];

  /** Renderiza a conversa como o <App> (cada bloco enxerga o `kind` do de cima). */
  function conversationLines(): string[] {
    return frameLines(
      <>
        {SEQ.map((b, i) => (
          <BlockView
            key={i}
            block={b}
            isCurrent={false}
            frame={0}
            columns={COLS}
            prevKind={SEQ[i - 1]?.kind}
          />
        ))}
      </>,
    );
  }

  it('há uma linha EM BRANCO entre a `⏺ tool` e o `Λ aluy` seguinte (o bug do dono)', () => {
    const lines = conversationLines();
    for (const [i, line] of lines.entries()) {
      if (!line.includes('aluy')) continue;
      // a linha imediatamente ACIMA do rótulo `Λ aluy` tem de ser vazia — sempre,
      // venha de um `você` (que paga o pad) ou de uma `⏺ tool` (que não paga).
      expect({ i, acima: lines[i - 1] }).toEqual({ i, acima: '' });
    }
  });

  it('NUNCA duas linhas em branco seguidas (o extremo oposto do fix ingênuo)', () => {
    const lines = conversationLines();
    for (let i = 1; i < lines.length; i += 1) {
      expect({ i, par: [lines[i - 1], lines[i]] }).not.toEqual({ i, par: ['', ''] });
    }
  });

  it('sem `prevKind` (cockpit / 1º bloco vivo) o render fica IDÊNTICO ao de antes', () => {
    // Dois clientes dependem disto: o <Cockpit> (mede cada bloco 1:1 via
    // `measureConversaBlock` numa região de altura FIXA — mudar o ritmo lá sem mexer na
    // medição espelho reintroduziria o mis-clip do Ink, F170) e o 1º bloco do sufixo
    // vivo (o pad do contêiner já deu a linha). Sem `prevKind` a regra devolve `false`.
    const semContexto = blockLines({ kind: 'aluy', text: 'RESP', streaming: false });
    const depoisDeYou = blockLines({ kind: 'aluy', text: 'RESP', streaming: false }, 'you');
    expect(semContexto).toEqual(depoisDeYou);
    expect(semContexto[0]).not.toBe('');
  });
});

describe('block-rhythm — a FRONTEIRA Static×viva não ganha linha dobrada', () => {
  // O contêiner da região viva é um `<Box paddingY={1}>`: o 1º bloco do sufixo vivo JÁ
  // vem com uma linha em branco acima (orçada em `LIVE_CHROME_BASE_ROWS`). Por isso o
  // call-site da viva passa `prevKind` só p/ `i > 0` — passar o vizinho ABSOLUTO daria
  // DUAS linhas em branco antes do `Λ aluy` (visto em PTY antes desta correção).
  it('o 1º bloco do sufixo vivo NÃO repete o respiro (o pad do contêiner já o deu)', () => {
    const semContexto = blockLines({ kind: 'aluy', text: 'RESP', streaming: true });
    expect(semContexto[0]).not.toBe('');
  });

  it('o saldo de linhas NÃO muda quando o bloco desce p/ o `<Static>`', () => {
    // ANTES do commit: pad do contêiner (1) + o bloco sem paddingTop.
    // DEPOIS do commit: o bloco no Static com paddingTop (1). Mesmo total ⇒ nada pula.
    const vivo = 1 + blockLines({ kind: 'aluy', text: 'RESP', streaming: false }).length;
    const commitado = blockLines({ kind: 'aluy', text: 'RESP', streaming: false }, 'tool').length;
    expect(commitado).toBe(vivo);
  });
});

describe('block-rhythm — o ORÇAMENTO anti-flicker conta o respiro', () => {
  const streaming: SessionBlock = { kind: 'aluy', text: 'oi', streaming: true };

  it('fala viva SOZINHA no sufixo: orçamento igual ao de antes do fix (não-regressão)', () => {
    // O vizinho está no `<Static>` ⇒ quem paga a linha da fronteira é o contêiner (que
    // já está em `LIVE_CHROME_BASE_ROWS`), não o bloco. Nada muda aqui.
    const overhead = liveOverheadLines({
      live: [streaming],
      phase: 'streaming',
      hasBlocks: true,
      columns: COLS,
    });
    expect(overhead).toBe(3); // cabeçalho `Λ aluy` + cursor + paddingBottom
  });

  it('vizinho DENTRO do sufixo vivo (tool → fala) custa +1 no orçamento', () => {
    // Acontece de verdade: com sub-agentes rodando, o pai RESPONDE em paralelo
    // (`answerInParallelWhileSubagents`) ⇒ o sufixo vivo tem tool/subagents ANTES da fala.
    // `⏺ rodando` não tem paddingBottom ⇒ o `Λ aluy` abaixo dela paga o respiro, e essa
    // linha OCUPA altura de frame: sem contá-la o frame cruza `rows` ⇒ clearTerminal.
    const live: readonly SessionBlock[] = [
      { kind: 'tool', verb: 'bash', target: 'npm test', result: '', status: 'running' },
      streaming,
    ];
    const overhead = liveOverheadLines({
      live,
      phase: 'streaming',
      hasBlocks: true,
      columns: COLS,
    });
    expect(overhead).toBe(1 /* tool running */ + 3 /* rótulo+cursor+pad */ + 1 /* respiro */);
  });

  it('vizinho que JÁ termina em branco (sub-agentes → fala) NÃO custa nada', () => {
    const live: readonly SessionBlock[] = [
      { kind: 'subagents', children: [{ label: 'rust', status: 'running' }] },
      streaming,
    ];
    const overhead = liveOverheadLines({
      live,
      phase: 'streaming',
      hasBlocks: true,
      columns: COLS,
    });
    expect(overhead).toBe(3 /* subagents: cabeçalho+filho+pad */ + 3 /* fala */);
  });
});
