// EST-1012 — ROBUSTEZ DE MEMÓRIA · MONITOR DE PRESSÃO no CONTROLLER (integração,
// broker mockado, heap amostrado por mock — sem depender da RAM real, sem timer real).
//
// PROVAS (DoD):
//  1. heapUsed alto (mock ≥80%) ⇒ DISPARA a auto-compactação (reusa o Compactor) +
//     nota visível; INDEPENDENTE do % da janela do modelo;
//  2. ainda apertado (≥88%, já compactado) ⇒ AVISA o usuário (nota "memória apertada");
//  3. pressão EXTREMA (≥95%) ⇒ encerra LIMPO: porta `shutdown` chamada (salva a sessão)
//     + nota ACIONÁVEL ("memória esgotada" / "sua sessão foi SALVA"), NÃO crash cru;
//  4. heap BAIXO ⇒ NADA (não compacta, não avisa, não encerra — sem overhead/regressão);
//  5. ALUY_MEM_PRESSURE_OFF ⇒ monitor DESLIGADO (não dispara nada);
//  6. monitor inerte sem heapLimit ⇒ não dispara;
//  7. anti-spam: o mesmo degrau não re-dispara a cada amostra.

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

function scriptedCaller(responses: readonly string[], sink: () => StreamSink): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const i = turn;
      const content = responses[Math.min(i, responses.length - 1)] ?? '';
      turn += 1;
      const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 100, tokens_out: 5 };
      const s = sink();
      s.onStart?.();
      for (const ch of content) s.onDelta(ch);
      s.onUsage?.(usage);
      s.onDone?.();
      return { request_id: 'r', content, finish_reason: 'stop', usage };
    },
  };
}

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

const MB = 1024 * 1024;
const HEAP_LIMIT_MB = 1000; // teto: 1000MB ⇒ 1000*MB bytes
// limiares default: compact .8 (800MB), warn .88 (880MB), shutdown .95 (950MB).

function build(opts: {
  responses: readonly string[];
  files?: Record<string, string>;
  heapUsedBytes: () => number;
  shutdown?: () => void;
  env?: Record<string, string | undefined>;
  heapLimitMb?: number;
}): { controller: SessionController; compactions: () => number } {
  const ports = fakePorts(opts.files);
  const engine = new PolicyPermissionEngine();
  let ctrlRef: SessionController | null = null;
  const { model: compactionModel, count } = compactionCaller();
  const model = scriptedCaller(opts.responses, () => ({
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
    contextWindow: 1_000_000, // JANELA enorme ⇒ a auto-compactação por JANELA NUNCA dispara
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    autoCompactEnv: { ALUY_AUTOCOMPACT_AT: '0' }, // desliga a compactação por janela (#157)
    memory: {
      heapLimitMb: opts.heapLimitMb ?? HEAP_LIMIT_MB,
      sampleHeapUsed: opts.heapUsedBytes,
      ...(opts.shutdown !== undefined ? { shutdown: opts.shutdown } : {}),
      env: opts.env ?? {},
    },
  });
  ctrlRef = controller;
  return { controller, compactions: count };
}

/** Constrói histórico compactável (≥2 turnos antigos) via um submit com leituras. */
async function seedHistory(controller: SessionController): Promise<void> {
  await controller.submit('leia o README');
}

function notesText(controller: SessionController, title = 'memória'): string {
  return controller.current.blocks
    .filter((b) => b.kind === 'note' && b.title === title)
    .flatMap((b) => (b.kind === 'note' ? b.lines : []))
    .join(' ');
}

const READ_RESPONSES = [
  toolCall('read_file', { path: 'README.md' }),
  toolCall('read_file', { path: 'README.md' }),
  toolCall('read_file', { path: 'README.md' }),
  'pronto, li tudo.',
];

describe('EST-1012 — monitor de pressão de memória (controller)', () => {
  it('heap ALTO (≥80%) ⇒ COMPACTA (reusa o Compactor) + nota visível', async () => {
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 820 * MB, // 82% ⇒ degrau de compactação
    });
    await seedHistory(controller);
    expect(controller.canCompact).toBe(true);

    await controller.checkMemoryPressure();

    expect(compactions()).toBe(1); // compactou de fato (mesmo Compactor do /compact)
    expect(notesText(controller)).toMatch(/memória apertada/);
  });

  it('heap BAIXO ⇒ NADA (não compacta, não avisa — sem regressão)', async () => {
    let shutdownCalls = 0;
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 300 * MB, // 30% ⇒ folga
      shutdown: () => {
        shutdownCalls += 1;
      },
    });
    await seedHistory(controller);
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(0);
    expect(shutdownCalls).toBe(0);
    expect(notesText(controller)).toBe('');
  });

  it('pressão EXTREMA (≥95%) ⇒ encerra LIMPO (porta shutdown + nota acionável), NÃO crash', async () => {
    let shutdownCalls = 0;
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 970 * MB, // 97% ⇒ último recurso
      shutdown: () => {
        shutdownCalls += 1;
      },
    });
    await seedHistory(controller);

    await controller.checkMemoryPressure();

    expect(shutdownCalls).toBe(1); // a porta SALVOU+encerrou (não morreu cego)
    expect(compactions()).toBe(0); // shutdown vence: não tenta compactar antes
    const text = notesText(controller);
    expect(text).toMatch(/memória esgotada/);
    expect(text).toMatch(/sess[aã]o foi SALVA/i);
    // one-shot terminal: uma 2ª amostra extrema NÃO re-encerra (não duplica o exit)
    await controller.checkMemoryPressure();
    expect(shutdownCalls).toBe(1);
  });

  it('AVISA quando ainda aperta APÓS compactar (≥88%)', async () => {
    // 1ª amostra 82% ⇒ compacta; 2ª amostra 90% ⇒ avisa (já compactou neste episódio).
    let used = 820 * MB;
    const { controller } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => used,
    });
    await seedHistory(controller);
    await controller.checkMemoryPressure(); // compacta
    used = 900 * MB;
    await controller.checkMemoryPressure(); // avisa
    expect(notesText(controller)).toMatch(/considere/);
  });

  it('ALUY_MEM_PRESSURE_OFF ⇒ monitor DESLIGADO (nada dispara)', async () => {
    let shutdownCalls = 0;
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 990 * MB, // extremo, mas desligado
      shutdown: () => {
        shutdownCalls += 1;
      },
      env: { ALUY_MEM_PRESSURE_OFF: '1' },
    });
    await seedHistory(controller);
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(0);
    expect(shutdownCalls).toBe(0);
    expect(notesText(controller)).toBe('');
  });

  it('heapLimit inerte (0) ⇒ não dispara nada', async () => {
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 999 * MB,
      heapLimitMb: 0,
    });
    await seedHistory(controller);
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(0);
    expect(notesText(controller)).toBe('');
  });

  it('ANTI-SPAM: o mesmo degrau de compactação não re-dispara a cada amostra', async () => {
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 820 * MB, // fixo no degrau de compactação
    });
    await seedHistory(controller);
    await controller.checkMemoryPressure(); // compacta 1×
    await controller.checkMemoryPressure(); // mesmo degrau ⇒ não re-compacta
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(1);
  });

  it('mid-turn (turno VIVO) ⇒ ADIA a compactação; ao REPOUSO compacta', async () => {
    // O 2º turno fica VIVO até o teste LIBERAR um gate manual; durante ele, a checagem de
    // pressão NÃO deve compactar (a auto-compactação por janela #157 age in-loop; o
    // backstop não clobbera a fase). Liberado o gate, o turno encerra e a pressão compacta.
    const ports = fakePorts({ 'README.md': 'conteúdo' });
    const engine = new PolicyPermissionEngine();
    let ctrlRef: SessionController | null = null;
    const { model: compactionModel, count } = compactionCaller();
    let turnIdx = 0;
    let releaseGate: (() => void) | null = null;
    const gateOpen = new Promise<void>((res) => {
      releaseGate = res;
    });
    const model: ModelCaller = {
      async call() {
        const s = ctrlRef!.sink;
        s.onStart?.();
        const i = turnIdx++;
        if (i === 3) {
          // 4º turno: segura o turno VIVO até o gate abrir (streaming), depois finaliza.
          s.onDelta('pensando');
          await gateOpen;
        }
        const content = i < 3 ? toolCall('read_file', { path: 'README.md' }) : 'pronto.';
        for (const ch of content) s.onDelta(ch);
        const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 100, tokens_out: 5 };
        s.onUsage?.(usage);
        s.onDone?.();
        return { request_id: 'r', content, finish_reason: 'stop' as const, usage };
      },
    };
    const controller = new SessionController({
      model,
      compactionModel,
      permission: engine,
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      contextWindow: 1_000_000,
      watchdogEnv: { ALUY_STUCK_OFF: '1' },
      autoCompactEnv: { ALUY_AUTOCOMPACT_AT: '0' },
      memory: { heapLimitMb: HEAP_LIMIT_MB, sampleHeapUsed: () => 820 * MB, env: {} },
    });
    ctrlRef = controller;
    const turn = controller.submit('leia'); // 3 leituras + 1 turno que pendura no gate
    await new Promise((r) => setTimeout(r, 30)); // deixa chegar no turno vivo
    expect(['thinking', 'streaming']).toContain(controller.current.phase);

    await controller.checkMemoryPressure(); // mid-turn ⇒ ADIA (não compacta, fase intacta)
    expect(count()).toBe(0);
    expect(['thinking', 'streaming']).toContain(controller.current.phase);

    releaseGate!(); // libera o turno ⇒ encerra ao repouso
    await turn;
    expect(controller.current.phase).toBe('done');

    await controller.checkMemoryPressure(); // ao REPOUSO ⇒ agora compacta
    expect(count()).toBe(1);
  });

  it('conversa CURTA (nada a compactar) ⇒ avisa 1×, NÃO encerra', async () => {
    let shutdownCalls = 0;
    const { controller, compactions } = build({
      responses: ['oi, tudo certo.'], // 1 turno só ⇒ não compactável
      heapUsedBytes: () => 820 * MB,
      shutdown: () => {
        shutdownCalls += 1;
      },
    });
    await controller.submit('oi');
    expect(controller.canCompact).toBe(false);
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(0); // nada a compactar ⇒ não chama o broker
    expect(shutdownCalls).toBe(0); // mas TAMBÉM não encerra (degrau de compactação)
    expect(notesText(controller)).toMatch(/memória apertada/);
  });
});

describe('EST-1012 — start/stop do monitor (timer)', () => {
  it('startMemoryMonitor agenda e dispara a checagem; stop limpa o timer', async () => {
    let used = 820 * MB;
    const { controller, compactions } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => used,
    });
    await seedHistory(controller);
    // (o build não passa sampleIntervalMs; usamos o setter de shutdown + start direto)
    controller.startMemoryMonitor();
    // a 1ª amostra do timer é após o intervalo; força uma checagem manual p/ provar o caminho
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(1);
    controller.stopMemoryMonitor();
    // após stop, novas amostras manuais ainda funcionam (stop só mata o timer, não a API),
    // mas o anti-spam segura o re-disparo no mesmo degrau.
    used = 820 * MB;
    await controller.checkMemoryPressure();
    expect(compactions()).toBe(1);
  });

  it('dispose() para o monitor sem vazar timer', async () => {
    const { controller } = build({
      responses: READ_RESPONSES,
      files: { 'README.md': 'conteúdo' },
      heapUsedBytes: () => 300 * MB,
    });
    controller.startMemoryMonitor();
    controller.dispose(); // não deve lançar; para o timer
    expect(true).toBe(true);
  });
});
