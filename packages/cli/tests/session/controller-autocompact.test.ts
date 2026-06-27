// EST-0973 — AUTO-COMPACTAÇÃO da JANELA no CONTROLLER (integração, broker mockado).
//
// Prova o WIRING (sem modelo real): quando o `tokens_in` reportado pelo broker cruza
// ~85% da `contextWindow`, o controller dispara a compactação AUTOMÁTICA (reusando o
// MESMO Compactor do `/compact`), mostra a nota/progresso, e o loop CONTINUA — sem
// pausar nem pedir confirmação. `ALUY_AUTOCOMPACT_AT=0` desliga. Anti-loop não trava.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(files: Record<string, string> = {}): ToolPorts {
  const fs: FileSystemPort = {
    async readFile(p) {
      if (p in files) return files[p]!;
      throw new Error(`não existe: ${p}`);
    },
    async writeFile() {},
    async exists(p) {
      return p in files;
    },
  };
  const shell: ShellPort = {
    async exec(command) {
      return { stdout: `ran: ${command}`, stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/**
 * Caller scriptado que emite cada resposta no sink E reporta um `tokens_in`
 * CONTROLADO por turno (p/ simular a janela enchendo). O `tokensInByTurn[i]` é o
 * prompt-size do turno i; ausente ⇒ um valor baixo (janela com folga).
 */
function scriptedCaller(
  responses: readonly string[],
  tokensInByTurn: readonly number[],
  sink: () => StreamSink,
): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const i = turn;
      const content = responses[Math.min(i, responses.length - 1)] ?? '';
      const tokensIn = tokensInByTurn[i] ?? 100;
      turn += 1;
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: tokensIn, tokens_out: 5 };
      const s = sink();
      s.onStart?.();
      for (const ch of content) s.onDelta(ch);
      s.onUsage?.(usage);
      s.onDone?.();
      // O loop lê `result.usage.tokens_in` p/ medir a ocupação da janela — então o
      // resultado AGREGADO PRECISA carregar o usage (não só o sink).
      return { request_id: 'r', content, finish_reason: 'stop', usage };
    },
  };
}

/** Compaction caller que devolve um resumo fixo e conta as chamadas. */
function compactionCaller(summary = 'resumo: estado preservado.'): {
  model: ModelCaller;
  count: () => number;
} {
  let n = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      n += 1;
      return { request_id: 'r-compact', content: summary, finish_reason: 'stop' };
    },
  };
  return { model, count: () => n };
}

const WINDOW = 1_000; // janela pequena p/ cruzar fácil
// limiar default 0.85 ⇒ 850 tokens. FULL cruza; FREE não.
const FULL = 900;
const FREE = 100;

function build(opts: {
  responses: readonly string[];
  tokensInByTurn: readonly number[];
  files?: Record<string, string>;
  autoCompactEnv?: Record<string, string | undefined>;
  autoCompactAt?: string;
}): { controller: SessionController; compactions: () => number } {
  const ports = fakePorts(opts.files);
  const engine = new PolicyPermissionEngine();
  let ctrlRef: SessionController | null = null;
  const { model: compactionModel, count } = compactionCaller();
  const model = scriptedCaller(opts.responses, opts.tokensInByTurn, () => ({
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  }));
  const controller = new SessionController({
    model,
    compactionModel,
    permission: engine,
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    contextWindow: WINDOW,
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    autoCompactEnv: opts.autoCompactEnv ?? {},
    ...(opts.autoCompactAt !== undefined ? { autoCompactAt: opts.autoCompactAt } : {}),
  });
  ctrlRef = controller;
  return { controller, compactions: count };
}

describe('EST-0973 — auto-compactação da janela (controller)', () => {
  it('a janela cruza 85% ⇒ compacta AUTOMÁTICO (reusa o Compactor) e CONTINUA o loop', async () => {
    // Vários turnos de leitura constroem histórico (folga), e o ÚLTIMO antes da virada
    // reporta a janela CHEIA (900/1000 = 90%) ⇒ no topo da iteração seguinte o controller
    // compacta sozinho. Histórico longo o bastante p/ haver o que compactar (>recentes).
    const { controller, compactions } = build({
      responses: [
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        'pronto, li tudo.',
      ],
      // só o penúltimo turno enche a janela ⇒ dispara antes do final.
      tokensInByTurn: [FREE, FREE, FREE, FREE, FULL, FREE],
      files: { 'README.md': 'conteúdo' },
    });

    await controller.submit('leia o README');

    // CONTINUOU até o fim (não pausou em budget/ask; terminou o turno).
    expect(controller.current.phase).toBe('done');
    // Compactou automaticamente (1 chamada ao compactor).
    expect(compactions()).toBe(1);
    // Mostrou a nota da auto-compactação (o usuário VÊ que compactou — DoD §3).
    const notes = controller.current.blocks.filter(
      (b) => b.kind === 'note' && b.title === 'auto-compactação',
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    const text = notes.flatMap((b) => (b.kind === 'note' ? b.lines : [])).join(' ');
    // a nota de início mostra "↻ janela em ... compactando automaticamente"
    expect(text).toMatch(/compactando automaticamente/);
  });

  it('ALUY_AUTOCOMPACT_AT=0 DESLIGA — não compacta mesmo com a janela cheia', async () => {
    const { controller, compactions } = build({
      responses: [toolCall('read_file', { path: 'README.md' }), 'fim.'],
      tokensInByTurn: [FULL, FULL],
      files: { 'README.md': 'conteúdo' },
      autoCompactEnv: { ALUY_AUTOCOMPACT_AT: '0' },
    });
    await controller.submit('leia');
    expect(controller.current.phase).toBe('done');
    expect(compactions()).toBe(0); // OFF ⇒ nunca compactou
    const notes = controller.current.blocks.filter(
      (b) => b.kind === 'note' && b.title === 'auto-compactação',
    );
    expect(notes.length).toBe(0);
  });

  it('ANTI-LOOP: janela cheia SEM progresso ⇒ avisa e NÃO compacta infinito', async () => {
    // 3 leituras com SUCESSO constroem histórico (há o que compactar); depois várias
    // leituras de um arquivo INEXISTENTE (tool FALHA ⇒ sem progresso real) com a janela
    // SEMPRE cheia. Com maxConsecutive=2, compacta no máx. 2× SEGUIDAS e DESISTE.
    const responses: string[] = [
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
    ];
    const tokens: number[] = [FREE, FREE, FREE];
    for (let i = 0; i < 6; i++) {
      responses.push(toolCall('read_file', { path: 'naoexiste.txt' }));
      tokens.push(FULL);
    }
    responses.push('fim.');
    tokens.push(FULL);
    const { controller, compactions } = build({
      responses,
      tokensInByTurn: tokens,
      files: { 'real.txt': 'conteúdo real' }, // só este existe; o outro falha sempre
      autoCompactEnv: { ALUY_AUTOCOMPACT_MAX: '2' },
    });

    await controller.submit('tente ler');

    // Terminou (não travou em loop de compactar-compactar).
    expect(controller.current.phase).toBe('done');
    // Compactou no máximo 2× (anti-loop), depois desistiu.
    expect(compactions()).toBe(2);
    // Avisou o usuário p/ agir (DoD §4): nota com "janela cheia mesmo após compactar".
    const text = controller.current.blocks
      .filter((b) => b.kind === 'note' && b.title === 'auto-compactação')
      .flatMap((b) => (b.kind === 'note' ? b.lines : []))
      .join(' ');
    expect(text).toMatch(/janela cheia mesmo após compactar/);
    expect(text).toMatch(/\/compact manualmente ou \/clear/);
  });

  it('janela com folga (abaixo do limiar) ⇒ NÃO compacta (baseline)', async () => {
    const { controller, compactions } = build({
      responses: [toolCall('read_file', { path: 'README.md' }), 'ok.'],
      tokensInByTurn: [FREE, FREE],
      files: { 'README.md': 'c' },
    });
    await controller.submit('leia');
    expect(controller.current.phase).toBe('done');
    expect(compactions()).toBe(0);
  });

  it('REGRESSÃO (fix dogfood): tools de SUCESSO + janela cheia ⇒ AINDA desiste (não loop infinito)', async () => {
    // O bug do dono no dogfood: a ~87% a auto-compactação entrava em LOOP — tools de
    // SUCESSO entre iterações zeravam o anti-loop ⇒ o give-up nunca disparava. Aqui
    // TODAS as leituras têm SUCESSO (real.txt EXISTE) e a janela fica SEMPRE cheia
    // (FULL). Antes do fix isto não desistia jamais; com o fix, após maxConsecutive
    // tentativas o give-up dispara (a nota "janela cheia mesmo após compactar" aparece).
    const responses: string[] = [
      // 3 leituras com FOLGA constroem histórico (há o que compactar)…
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
    ];
    const tokens: number[] = [FREE, FREE, FREE];
    // …depois a janela fica SEMPRE cheia (FULL) mas a tool SEMPRE TEM SUCESSO
    // (real.txt existe). É exatamente o cenário que ANTES zerava o anti-loop a cada
    // sucesso ⇒ give-up nunca disparava (o loop infinito do dono).
    for (let i = 0; i < 6; i++) {
      responses.push(toolCall('read_file', { path: 'real.txt' }));
      tokens.push(FULL);
    }
    responses.push('fim.');
    tokens.push(FULL);
    const { controller, compactions } = build({
      responses,
      tokensInByTurn: tokens,
      files: { 'real.txt': 'conteúdo real' }, // a leitura SEMPRE tem sucesso (ok=true)
      autoCompactEnv: { ALUY_AUTOCOMPACT_MAX: '2' },
    });

    await controller.submit('leia em loop');

    // Terminou (não travou em loop infinito de compactar-compactar).
    expect(controller.current.phase).toBe('done');
    // Desistiu após maxConsecutive=2 — NÃO ficou compactando para sempre.
    expect(compactions()).toBe(2);
    // O give-up DISPAROU apesar das tools de sucesso (a prova do fix dogfood).
    const text = controller.current.blocks
      .filter((b) => b.kind === 'note' && b.title === 'auto-compactação')
      .flatMap((b) => (b.kind === 'note' ? b.lines : []))
      .join(' ');
    expect(text).toMatch(/janela cheia mesmo após compactar/);
  });

  it('FALHA de broker na compactação ⇒ nota DISTINTA (não "nada a compactar") — fix secundário', async () => {
    // Fix secundário (observabilidade): um erro de broker na compactação NÃO deve ser
    // engolido como "não consegui compactar agora" (que sugere histórico curto). A
    // PORTA classifica a causa (classifyBrokerError, NEUTRA e SEM SEGREDO) e empurra
    // uma nota DISTINTA "falha ao compactar automaticamente (…)", suprimindo a genérica.
    const ports = fakePorts({ 'real.txt': 'conteúdo' });
    const engine = new PolicyPermissionEngine();
    let ctrlRef: SessionController | null = null;
    // Modelo de COMPACTAÇÃO que SEMPRE falha (simula broker fora durante o resumo).
    const failingCompaction: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        throw new Error('broker fora');
      },
    };
    // Histórico suficiente p/ HAVER o que compactar (3 leituras), depois janela cheia.
    const responses = [
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
      toolCall('read_file', { path: 'real.txt' }),
      'fim.',
    ];
    const tokens = [FREE, FREE, FREE, FULL, FULL];
    const model = scriptedCaller(responses, tokens, () => ({
      onStart: () => ctrlRef?.sink.onStart?.(),
      onDelta: (c) => ctrlRef?.sink.onDelta(c),
      onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
      onDone: () => ctrlRef?.sink.onDone?.(),
    }));
    const controller = new SessionController({
      model,
      compactionModel: failingCompaction,
      permission: engine,
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      contextWindow: WINDOW,
      watchdogEnv: { ALUY_STUCK_OFF: '1' },
      autoCompactEnv: { ALUY_AUTOCOMPACT_MAX: '2' },
    });
    ctrlRef = controller;

    await controller.submit('leia');

    expect(controller.current.phase).toBe('done');
    const lines = controller.current.blocks
      .filter((b) => b.kind === 'note' && b.title === 'auto-compactação')
      .flatMap((b) => (b.kind === 'note' ? b.lines : []));
    const text = lines.join(' ');
    // A nota DISTINTA da falha aparece (causa neutra), …
    expect(text).toMatch(/falha ao compactar automaticamente/);
    // … e a genérica "não consegui compactar agora" NÃO duplica.
    expect(text).not.toMatch(/não consegui compactar agora/);
    // E nada de segredo/origem crua vazou (HG-2 / CLI-SEC-6).
    expect(text).not.toMatch(/broker fora/);
  });
});
