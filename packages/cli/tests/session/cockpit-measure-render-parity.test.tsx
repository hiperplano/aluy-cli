// EST-1015 (hardening — CAMADA 2, achado do dono) — TESTE DE PARIDADE medida×render REAL.
//
// CAUSA-RAIZ do fantasma/duplicação no SCROLL de sessão grande (ver `synchronized-output.ts`
// e `visual-lines.ts`): o cockpit MEDE a altura de cada bloco À MÃO (`measureConversaBlock`/
// `flatLineRows`), uma reimplementação PARALELA do render real (Markdown/wrap-ansi/Ink) — sem
// fonte única. `fitConversaWindow`/`ActivityLog` confiam nessa medição p/ decidir o que CABE
// numa região de altura FIXA (§5); se a medição diverge do render de fato — nem que por 1
// linha —, o corpo real sai mais alto que a Box e o `CockpitDiffer` (que assume "o corpo tem
// exatamente as linhas esperadas") dessincroniza — os fantasmas do bug reportado.
//
// Os testes PUROS existentes (`cockpit-conversa.test.ts`) verificam a FÓRMULA de
// `measureConversaBlock` contra contas feitas à mão — mas nunca contra o Ink DE VERDADE. Este
// arquivo fecha esse elo: renderiza cada bloco com `ink-testing-library` (o Ink real) e
// compara a altura RENDERIZADA contra `measureConversaBlock`/`flatLineRows`, com uma bateria
// ADVERSARIAL (ANSI colorido, CJK, tabela larga, linha única gigante) — os casos em que a
// medição e o render têm MAIS chance de divergir (só aparecem em conteúdo real de sessão
// grande, não nos exemplos curtos das provas puras).

import React from 'react';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { BlockView } from '../../src/session/App.js';
import {
  measureConversaBlock,
  streamPreviewMaxLines,
  type ConversaCtx,
} from '../../src/session/cockpit-conversa.js';
import { ActivityLog } from '../../src/ui/components/index.js';
import { flatLineRows, flatten } from '../../src/ui/components/ActivityLog.js';
import type { LogSection, LogEvent } from '../../src/session/activity-log.js';
import type { SessionBlock } from '../../src/session/model.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

/**
 * Renderiza `node` (o Ink REAL, via `ink-testing-library`) dentro de um `<Box width={cols}>`
 * — é o que ATIVA o wrap do Ink (sem largura cravada num ancestral, o texto não reflui; ver
 * o mesmo cuidado em `activity-log.test.tsx`) — e devolve o Nº DE LINHAS FÍSICAS do frame.
 */
function renderedHeight(node: React.ReactElement, cols: number): number {
  const frame =
    render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <Box width={cols} flexDirection="column">
          {node}
        </Box>
      </ThemeProvider>,
    ).lastFrame() ?? '';
  return frame.split('\n').length;
}

/** Renderiza UM bloco via `<BlockView>` (o MESMO componente que o cockpit usa) e mede. */
function blockHeight(block: SessionBlock, ctx: ConversaCtx): number {
  return renderedHeight(
    <BlockView
      block={block}
      isCurrent
      frame={0}
      columns={ctx.columns}
      rows={ctx.rows}
      {...(ctx.streamMaxLines !== undefined ? { maxLines: ctx.streamMaxLines } : {})}
    />,
    ctx.columns,
  );
}

/** Confere a PARIDADE: altura REAL renderizada === `measureConversaBlock` (a medição à mão). */
function expectParity(block: SessionBlock, ctx: ConversaCtx): void {
  expect(blockHeight(block, ctx)).toBe(measureConversaBlock(block, ctx));
}

const CTX: ConversaCtx = { columns: 100, rows: 33 };

describe('paridade medida×render — <BlockView> (cada tipo de bloco), conteúdo SIMPLES', () => {
  it('you', () => expectParity({ kind: 'you', text: 'oi, tudo bem?' }, CTX));

  it('aluy concluído (markdown com parágrafos)', () =>
    expectParity({ kind: 'aluy', text: 'Oi.\n\nTchau.', streaming: false }, CTX));

  it('aluy streaming (com cursor de trabalho)', () =>
    expectParity(
      { kind: 'aluy', text: 'respondendo aos poucos', streaming: true },
      { ...CTX, streamMaxLines: streamPreviewMaxLines(20) },
    ));

  it('tool ok', () =>
    expectParity(
      { kind: 'tool', verb: 'read', target: 'src/app.ts', result: '48 linhas', status: 'ok' },
      CTX,
    ));

  it('tool err (com box de saída)', () =>
    expectParity(
      {
        kind: 'tool',
        verb: 'bash',
        target: 'npm test',
        result: '1 erro',
        status: 'err',
        output: 'Error: falhou\nat linha 3',
      },
      CTX,
    ));

  it('tool running (in-flight)', () =>
    expectParity(
      {
        kind: 'tool',
        verb: 'bash',
        target: 'npm test',
        result: '',
        status: 'running',
        verbGerund: 'rodando',
      },
      CTX,
    ));

  it('note', () =>
    expectParity({ kind: 'note', title: 'ajuda', lines: ['linha 1', 'linha 2'] }, CTX));

  it('bang ok (com box de saída)', () =>
    expectParity(
      { kind: 'bang', command: 'ls -la', status: 'ok', output: 'total 8\ndrwxr-xr-x  2 a a' },
      CTX,
    ));

  it('bang running (com saída ao vivo)', () =>
    expectParity(
      {
        kind: 'bang',
        command: 'npm run build',
        status: 'running',
        liveOutput: 'compilando…\n50%\n',
      },
      CTX,
    ));

  it('subagents', () =>
    expectParity(
      {
        kind: 'subagents',
        children: [
          { label: 'rust', status: 'done', summary: '1.2k tokens · 3 tools · 2.1s' },
          { label: 'go', status: 'running' },
        ],
      },
      CTX,
    ));

  it('doctor (com dica de conserto)', () =>
    expectParity(
      {
        kind: 'doctor',
        checks: [
          { id: 'a', label: 'credencial', status: 'ok' },
          { id: 'b', label: 'rede', status: 'fail', detail: 'timeout', fix: 'verifique a VPN' },
        ],
        summary: '1 ok · 1 falha',
      },
      CTX,
    ));

  it('deny', () => expectParity({ kind: 'deny', verb: 'bash', exact: 'rm -rf /' }, CTX));

  it('broker-error (com status/retry)', () =>
    expectParity(
      {
        kind: 'broker-error',
        message: 'sem resposta do broker',
        status: 503,
        attempt: 1,
        maxAttempts: 3,
        retryInSeconds: 5,
        retrying: true,
      },
      CTX,
    ));

  it('testrun (com falhas)', () =>
    expectParity(
      {
        kind: 'testrun',
        running: false,
        startedAt: Date.now() - 2000,
        score: {
          passed: 3,
          failed: 1,
          total: 4,
          durationMs: 2100,
          unknownFormat: false,
          failures: [{ name: 'suite > caso', message: 'esperado 1, recebido 2' }],
        },
      },
      CTX,
    ));

  it('inject', () => expectParity({ kind: 'inject', text: 'btw, use TypeScript' }, CTX));
});

// ── Bateria ADVERSARIAL — os casos em que medida×render têm MAIS chance de divergir ────────
// (só aparecem em conteúdo REAL de sessão grande — saída de tool colorida, texto CJK, tabelas
// largas do agente, uma linha única gigante — nunca nos exemplos curtos das provas puras.)
describe('paridade medida×render — bateria ADVERSARIAL (ANSI, CJK, tabela larga, linha gigante)', () => {
  it('ANSI colorido: saída de tool `err` com sequências SGR (cor) intercaladas no texto', () => {
    const RED = '\x1b[31m';
    const GREEN = '\x1b[32m';
    const BOLD = '\x1b[1m';
    const RESET = '\x1b[0m';
    const output = [
      `${BOLD}${RED}FAIL${RESET} src/app.test.ts`,
      `  ${GREEN}✓${RESET} passou · ${RED}✗${RESET} falhou`,
      `${RED}Error: expected 1 to equal 2${RESET}`,
    ].join('\n');
    expectParity(
      { kind: 'tool', verb: 'bash', target: 'npm test', result: '1 erro', status: 'err', output },
      CTX,
    );
  });

  it('ANSI colorido: saída de bang `ok` com cor (ex.: `ls --color`)', () => {
    const BLUE = '\x1b[34;1m';
    const RESET = '\x1b[0m';
    const output = [`${BLUE}src${RESET}  ${BLUE}dist${RESET}  package.json`, 'README.md'].join(
      '\n',
    );
    expectParity({ kind: 'bang', command: 'ls --color', status: 'ok', output }, CTX);
  });

  it('CJK largo: fala do usuário (you) com texto de largura DUPLA quebra corretamente', () => {
    // 150 ideogramas (2 cols cada = 300 cols) em columns-2=98 ⇒ ceil(300/98)=4 linhas visuais.
    expectParity({ kind: 'you', text: '日'.repeat(150) }, CTX);
  });

  it('CJK largo: fala concluída do aluy (markdown) com CJK', () => {
    expectParity({ kind: 'aluy', text: '结论：'.repeat(60), streaming: false }, CTX);
  });

  it('tabela LARGA: aluy concluído com tabela markdown de muitas colunas/células longas', () => {
    const cols = ['id', 'arquivo', 'status', 'linhas', 'duração', 'observação'];
    const row = (n: number): string =>
      `| ${n} | src/muito/longo/caminho/${n}/arquivo.ts | ok | ${100 + n} | ${n}.${n}s | comentário bem comprido número ${n} |`;
    const header = `| ${cols.join(' | ')} |`;
    const sep = `|${cols.map(() => ' --- ').join('|')}|`;
    const table = [header, sep, row(1), row(2), row(3)].join('\n');
    expectParity({ kind: 'aluy', text: table, streaming: false }, CTX);
  });

  it('linha ÚNICA gigante: aluy STREAMING com uma linha sem `\\n` maior que o teto visual', () => {
    const room = 10;
    const streamMaxLines = streamPreviewMaxLines(room);
    // 1 linha-fonte de 5000 chars, sem quebra — força o `clampLineToVisualTail` (corte na
    // cauda) tanto na medição (`aluySpeech`/`windowTailVisual`) quanto no render real.
    const giant = 'x'.repeat(5000);
    expectParity(
      { kind: 'aluy', text: giant, streaming: true },
      { ...CTX, streamMaxLines },
    );
  });

  it('linha ÚNICA gigante + ANSI: streaming com uma linha colorida gigante sem `\\n`', () => {
    const room = 10;
    const streamMaxLines = streamPreviewMaxLines(room);
    const giant = Array.from({ length: 200 }, (_, i) => `\x1b[3${i % 8}m palavra${i}\x1b[0m`).join(
      ' ',
    );
    expectParity(
      { kind: 'aluy', text: giant, streaming: true },
      { ...CTX, streamMaxLines },
    );
  });

  it('linha ÚNICA gigante: saída de tool `err` sem `\\n` (log de uma linha só, ex.: JSON minificado)', () => {
    const output = Array.from({ length: 100 }, (_, i) => `{"campo${i}":"valor${i}"}`).join(', ');
    expectParity(
      { kind: 'tool', verb: 'bash', target: 'curl api', result: '1 erro', status: 'err', output },
      CTX,
    );
  });

  it('coluna ESTREITA (cockpit ~30%): CJK + ANSI juntos numa fala concluída', () => {
    const narrow: ConversaCtx = { columns: 30, rows: 33 };
    const text = `\x1b[31m结果\x1b[0m: ${'很'.repeat(20)} done`;
    expectParity({ kind: 'aluy', text, streaming: false }, narrow);
  });
});

// ── ActivityLog / EventRow — mesma técnica, comparando contra `flatLineRows` ────────────────
describe('paridade medida×render — <ActivityLog> (flatLineRows), incl. ANSI/CJK', () => {
  function expectLogParity(sections: readonly LogSection[], cols: number): void {
    const flat = flatten(sections);
    const expected = 1 /* rótulo `LOG · …` */ + flat.reduce((sum, ln) => sum + flatLineRows(ln, cols), 0);
    const height = renderedHeight(
      <ActivityLog
        sections={sections}
        visibleRows={10_000} // sem teto: queremos a altura NATURAL, não a janela clipada.
        scrollOffset={0}
        focused={false}
        columns={cols}
      />,
      cols,
    );
    expect(height).toBe(expected);
  }

  const baseEvent = (over: Partial<LogEvent>): LogEvent => ({
    kind: 'tool',
    label: 'bash',
    detail: 'ls',
    status: 'ok',
    ...over,
  });

  const section = (events: readonly LogEvent[]): LogSection => ({
    id: 'root',
    kind: 'root',
    label: 'root',
    phase: 'tool',
    tokens: 100,
    toolCalls: events.length,
    durationMs: 100,
    collapsed: false,
    events,
  });

  it('evento simples', () => expectLogParity([section([baseEvent({})])], 60));

  it('evento running com tail ao vivo (2 linhas)', () =>
    expectLogParity(
      [section([baseEvent({ status: 'running', tail: 'saída parcial…' })])],
      60,
    ));

  it('evento com dado rico (summary/diffstat/duração/tokens) que QUEBRA em coluna estreita', () =>
    expectLogParity(
      [
        section([
          baseEvent({
            label: 'edit',
            detail: 'src/muito/longo/caminho/de/verdade/arquivo.ts',
            summary: 'aplicado com sucesso e detalhe extra',
            added: 12,
            removed: 4,
            durationMs: 2100,
            tokens: 1200,
          }),
        ]),
      ],
      24, // coluna estreita do cockpit (~30%) — força o wrap.
    ));

  it('detalhe ANSI-colorido (tail de comando com cor) não infla a contagem', () =>
    expectLogParity(
      [
        section([
          baseEvent({
            status: 'running',
            tail: `\x1b[32m✓\x1b[0m 42 passed \x1b[31m✗\x1b[0m 1 failed`,
          }),
        ]),
      ],
      60,
    ));

  it('detalhe CJK longo (quebra em coluna estreita)', () =>
    expectLogParity(
      [section([baseEvent({ label: 'edit', detail: '中'.repeat(40) + '.ts' })])],
      30,
    ));
});
