// EST-0948 · CA-1/CA-2 — integração: loop + broker (mock) + catraca + ask.
//
// Prova de ponta-a-ponta (broker mockado, sem rede): um objetivo roda o loop, o
// modelo pede uma tool com efeito, a catraca devolve `ask`, o AskResolver é
// invocado com o EFEITO EXATO, e a escolha do usuário é repassada à engine —
// allow ⇒ tool roda; deny ⇒ tool NÃO roda e vira deny-block. O streaming
// token-a-token aparece nos blocos `aluy`.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type AskRequest,
  type AskResolution,
  type AskResolver,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { BrokerError, DegenerateLoopError } from '@aluy/cli-core';
import { SessionController, nextMode } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

// ── fakes de porta (em memória; nada de fs/child_process real) ────────────────
function fakePorts(files: Record<string, string> = {}): {
  ports: ToolPorts;
  ran: string[];
  written: Record<string, string>;
} {
  const ran: string[] = [];
  const written: Record<string, string> = {};
  const fs: FileSystemPort = {
    async readFile(p) {
      if (p in files) return files[p]!;
      throw new Error(`não existe: ${p}`);
    },
    async writeFile(p, content) {
      written[p] = content;
    },
    async exists(p) {
      return p in files;
    },
  };
  const shell: ShellPort = {
    async exec(command) {
      ran.push(command);
      return { stdout: `ran: ${command}`, stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran, written };
}

/**
 * ModelCaller scriptado: devolve uma sequência de respostas (uma por turno do
 * loop), emitindo cada uma como deltas no `sink` (simula o stream do broker).
 */
function scriptedCaller(responses: readonly string[], sink: StreamSink): ModelCaller {
  let turn = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const content = responses[Math.min(turn, responses.length - 1)] ?? '';
      turn += 1;
      sink.onStart?.();
      // stream token-a-token (caractere a caractere p/ provar o streaming)
      for (const ch of content) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
}

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function buildController(opts: {
  responses: readonly string[];
  files?: Record<string, string>;
  askResolver: TuiAskResolver | AskResolver;
  limits?: import('@aluy/cli-core').SessionLimits;
  /** EST-0959 — engine pré-configurada (ex.: modo Plan/unsafe). Default: normal. */
  engine?: PolicyPermissionEngine;
  /** EST-0973 — caller DEDICADO da compactação (broker). Default: o `model` da sessão. */
  compactionModel?: ModelCaller;
  /** EST-0969 — override do ModelCaller (ex.: um que dispara a guarda degenerada). */
  model?: ModelCaller;
  /** EST-1015 (AG-0008) — checagem de root injetável (root-block do Tab→unsafe). */
  isRoot?: () => boolean;
}): {
  controller: SessionController;
  ran: string[];
  written: Record<string, string>;
  engine: PolicyPermissionEngine;
} {
  const { ports, ran, written } = fakePorts(opts.files);
  const engine = opts.engine ?? new PolicyPermissionEngine();
  // injeta um caller scriptado que escreve no sink do controller — resolvemos a
  // circularidade igual ao wiring real (sink-proxy).
  let ctrlRef: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const model = opts.model ?? scriptedCaller(opts.responses, sink);
  const controller = new SessionController({
    model,
    permission: engine,
    ports,
    askResolver: opts.askResolver as TuiAskResolver,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    // EST-0969 — estes testes exercitam OUTRAS features (budget/compact/degenerado)
    // com loops repetidos do MESMO tool-call DE PROPÓSITO; o watchdog de travamento
    // (novo) pausaria pedindo direção e penduraria. Desligamo-lo neste harness — a
    // pausa-pede-direção tem testes DEDICADOS (controller-stuck-watchdog.test.ts).
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
    ...(opts.compactionModel !== undefined ? { compactionModel: opts.compactionModel } : {}),
    ...(opts.isRoot !== undefined ? { isRoot: opts.isRoot } : {}),
  });
  ctrlRef = controller;
  return { controller, ran, written, engine };
}

describe('SessionController — splash de boot (EST-0948 §2.1)', () => {
  it('arranca na fase boot (splash) — ANTES do composer', () => {
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
    });
    expect(controller.current.phase).toBe('boot');
  });

  it('dismissBoot() vai p/ idle (composer); é no-op fora de boot', async () => {
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
    });
    controller.dismissBoot();
    expect(controller.current.phase).toBe('idle');
    // 2ª chamada não regride uma fase de trabalho
    await controller.submit('oi');
    const phaseDepois = controller.current.phase;
    controller.dismissBoot();
    expect(controller.current.phase).toBe(phaseDepois);
  });

  it('submit() durante o boot dispensa o splash (a sessão começou)', async () => {
    const { controller } = buildController({
      responses: ['feito.'],
      askResolver: new TuiAskResolver(),
    });
    expect(controller.current.phase).toBe('boot');
    await controller.submit('faça algo');
    expect(controller.current.phase).not.toBe('boot');
    // o objetivo entrou no histórico (não foi engolido pelo splash)
    const you = controller.current.blocks.find((b) => b.kind === 'you');
    expect(you?.kind).toBe('you');
  });
});

describe('SessionController — CA-1: streaming token-a-token', () => {
  it('o texto do agente aparece nos blocos aluy (stream agregado)', async () => {
    const resolver = new TuiAskResolver();
    const { controller } = buildController({
      responses: ['vou explicar a estrutura deste repo.'],
      askResolver: resolver,
    });
    await controller.submit('explique o repo');
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy?.kind).toBe('aluy');
    if (aluy?.kind === 'aluy') {
      expect(aluy.text).toContain('estrutura deste repo');
      expect(aluy.streaming).toBe(false); // fechou o turno
    }
    expect(controller.current.phase).toBe('done');
  });
});

describe('SessionController — CA-2: ask mostra efeito exato e respeita a escolha', () => {
  it('APROVAR ⇒ a tool de efeito roda (run_command executa)', async () => {
    // resolver automático que aprova e captura o request (prova o efeito exato).
    let seen: AskRequest | null = null;
    const autoApprove: AskResolver = {
      async resolve(req: AskRequest): Promise<AskResolution> {
        seen = req;
        return { kind: 'approve-once' };
      },
    };
    const { controller, ran } = buildController({
      responses: [toolCall('run_command', { command: 'echo oi' }), 'pronto.'],
      askResolver: autoApprove as unknown as TuiAskResolver,
    });
    await controller.submit('rode echo oi');
    // o ask recebeu o EFEITO EXATO (CLI-SEC-9):
    expect(seen).not.toBeNull();
    expect(seen!.effect.exact).toBe('$ echo oi');
    // aprovado ⇒ a tool rodou:
    expect(ran).toContain('echo oi');
  });

  it('NEGAR ⇒ a tool NÃO roda e registra um bloco de deny', async () => {
    const autoDeny: AskResolver = {
      async resolve(): Promise<AskResolution> {
        return { kind: 'deny', reason: 'usuário negou' };
      },
    };
    const resolver = new TuiAskResolver();
    // usamos o resolver real do controller p/ ver o deny-block (que é emitido em
    // resolveAsk). Aqui injetamos diretamente no resolver real via UI-resolve.
    const { controller, ran } = buildController({
      responses: [toolCall('run_command', { command: 'rm -rf node_modules' }), 'ok, não removi.'],
      askResolver: resolver,
    });
    // observa o pending e nega via a UI (caminho real, gera deny-block)
    resolver.subscribe((pending) => {
      if (pending) controller.resolveAsk({ kind: 'deny', reason: 'negado' });
    });
    void autoDeny; // (mantém a intenção documentada; o caminho real é o resolver)
    await controller.submit('remova node_modules');
    expect(ran).not.toContain('rm -rf node_modules');
    const deny = controller.current.blocks.find((b) => b.kind === 'deny');
    expect(deny?.kind).toBe('deny');
    if (deny?.kind === 'deny') {
      expect(deny.exact).toContain('rm -rf node_modules');
    }
  });

  // EST-1007 — FAIL-CLOSED do MODO HEADLESS (`-p`): sem TTY não há como CONFIRMAR a
  // catraca ⇒ o resolver em `setNonInteractive(true)` (o que o headless/run.tsx arma
  // ANTES do loop) NEGA toda categoria sempre-ask por INAÇÃO. A catraca `decide()` NÃO
  // é relaxada (CLI-SEC-H1): o ponto-único segue; só o resolvedor de permissão em
  // headless é deny-por-default no que precisaria perguntar. Prova de SEGURANÇA: um
  // `run_command` (sempre-ask) NÃO EXECUTA o efeito (deny por inação) e o loop segue
  // sem PENDURAR aguardando uma confirmação impossível — o objetivo conclui.
  it('HEADLESS fail-closed: ask sob setNonInteractive(true) ⇒ a tool de efeito NÃO roda', async () => {
    const resolver = new TuiAskResolver();
    resolver.setNonInteractive(true); // <- o que o headless/`-p` faz (sem TTY p/ aprovar).
    const { controller, ran } = buildController({
      responses: [toolCall('run_command', { command: 'rm -rf node_modules' }), 'não rodei.'],
      askResolver: resolver,
    });
    await controller.submit('remova node_modules');
    // a categoria sempre-ask foi NEGADA por inação — o efeito (destrutivo) NÃO rodou.
    expect(ran).not.toContain('rm -rf node_modules');
    expect(ran).toHaveLength(0);
    // e o loop não pendurou: o turno terminou (idle), com a fala final do modelo.
    expect(controller.current.phase === 'idle' || controller.current.phase === 'done').toBe(true);
  });

  // EST-1007 — contraste: a MESMA tool sempre-ask, num resolver INTERATIVO que aprova,
  // EXECUTA. Prova que a NEGAÇÃO acima é do fail-closed (não-interativo), não da catraca
  // recusar a tool por si — o ponto-único `decide()` é o MESMO nos dois (CLI-SEC-H1).
  it('contraste: a MESMA tool, aprovada por um resolver interativo, EXECUTA (catraca igual)', async () => {
    const autoApprove: AskResolver = {
      async resolve(): Promise<AskResolution> {
        return { kind: 'approve-once' };
      },
    };
    const { controller, ran } = buildController({
      responses: [toolCall('run_command', { command: 'rm -rf node_modules' }), 'feito.'],
      askResolver: autoApprove as unknown as TuiAskResolver,
    });
    await controller.submit('remova node_modules');
    expect(ran).toContain('rm -rf node_modules');
  });

  it('read puro NÃO passa por ask (default allow) — sem pending', async () => {
    let asked = false;
    const spyResolver: AskResolver = {
      async resolve(): Promise<AskResolution> {
        asked = true;
        return { kind: 'deny' };
      },
    };
    const { controller } = buildController({
      responses: [toolCall('read_file', { path: 'README.md' }), 'li o readme.'],
      files: { 'README.md': 'linha 1\nlinha 2\n' },
      askResolver: spyResolver as unknown as TuiAskResolver,
    });
    await controller.submit('leia o readme');
    expect(asked).toBe(false); // leitura pura não pergunta
    const tool = controller.current.blocks.find((b) => b.kind === 'tool');
    expect(tool?.kind).toBe('tool');
  });
});

describe('SessionController — fase thinking (§2.4) + tool in-flight (§2.6)', () => {
  it('submit entra em `thinking` ANTES do 1º token, depois `streaming`', async () => {
    // caller que adia o onStart (latência do broker) p/ flagrar a fase thinking.
    const phases: string[] = [];
    const { ports } = fakePorts();
    let ctrlRef: SessionController | null = null;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        // ANTES do 1º token: já deve estar em `thinking` (vácuo pré-stream).
        phases.push(`pre-token:${ctrlRef!.current.phase}`);
        ctrlRef!.sink.onStart?.(); // 1º token
        ctrlRef!.sink.onDelta('oi.');
        ctrlRef!.sink.onDone?.();
        return { request_id: 'r', content: 'oi.', finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    ctrlRef = controller;
    await controller.submit('oi');
    // a fase pré-token foi `thinking` (não pulou direto p/ streaming).
    expect(phases).toContain('pre-token:thinking');
    expect(controller.current.phase).toBe('done');
  });

  it('thinking carrega o workingLabel `pensando`', async () => {
    const { ports } = fakePorts();
    let ctrlRef: SessionController | null = null;
    let labelAtThinking: string | undefined;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        labelAtThinking = ctrlRef!.current.workingLabel;
        ctrlRef!.sink.onStart?.();
        ctrlRef!.sink.onDelta('ok.');
        ctrlRef!.sink.onDone?.();
        return { request_id: 'r', content: 'ok.', finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    ctrlRef = controller;
    await controller.submit('oi');
    expect(labelAtThinking).toBe('pensando');
    // F55 — ao streamar, o label NÃO é limpo: o Λ continua visível durante todo o turno.
    expect(controller.current.workingLabel).toBe('pensando');
  });

  it('tool LIBERADA passa por `running` (◌) e termina em `ok`/`err` — UMA linha', async () => {
    // read puro = allow ⇒ roda direto; capturamos os snapshots p/ ver o `running`.
    const seenStatuses: string[] = [];
    const resolver = new TuiAskResolver();
    const { controller } = buildController({
      responses: [toolCall('read_file', { path: 'README.md' }), 'li.'],
      files: { 'README.md': 'a\nb\nc\n' },
      askResolver: resolver,
    });
    controller.subscribe((s) => {
      const tool = s.blocks.find((b) => b.kind === 'tool');
      if (tool?.kind === 'tool') seenStatuses.push(tool.status);
    });
    await controller.submit('leia o readme');
    // passou por `running` em algum snapshot e terminou em `ok` (in-flight ◌→⏺).
    expect(seenStatuses).toContain('running');
    const tools = controller.current.blocks.filter((b) => b.kind === 'tool');
    // UMA linha de tool (a `running` foi ATUALIZADA in-place, não duplicada).
    expect(tools.length).toBe(1);
    expect(tools[0]!.kind === 'tool' && tools[0]!.status).toBe('ok');
  });
});

describe('SessionController — slash notes (/help, /model, /usage)', () => {
  it('pushNote empurra um bloco de nota e dismissa o boot', () => {
    const { controller } = buildController({ responses: ['x'], askResolver: new TuiAskResolver() });
    expect(controller.current.phase).toBe('boot');
    controller.pushNote('model', ['tier: turbo', '◍ via broker']);
    expect(controller.current.phase).not.toBe('boot');
    const note = controller.current.blocks.find((b) => b.kind === 'note');
    expect(note?.kind).toBe('note');
    if (note?.kind === 'note') {
      expect(note.title).toBe('model');
      expect(note.lines.join(' ')).toContain('turbo');
    }
  });

  it('usage expõe tokens/janela/tier da sessão', async () => {
    const { controller } = buildController({
      responses: ['ok.'],
      askResolver: new TuiAskResolver(),
    });
    await controller.submit('oi');
    const u = controller.usage;
    expect(u.tokens).toBe(30);
    expect(u.tier).toBe('aluy-flux');
  });
});

describe('SessionController — usage, erro de broker e clear', () => {
  it('acumula tokens da usage e deriva ⛁ % da janela', async () => {
    const resolver = new TuiAskResolver();
    const { controller } = buildController({
      responses: ['ok.'],
      askResolver: resolver,
    });
    expect(controller.current.meta.tokens).toBe(0);
    await controller.submit('oi');
    // scriptedCaller emite tokens_in 10 + tokens_out 20 = 30.
    expect(controller.current.meta.tokens).toBe(30);
    expect(controller.current.meta.windowPct).toBeGreaterThanOrEqual(0);
  });

  it('EST-0948 — meta.budgetPct reflete o % do TETO da sessão consumido (StatusBar ◷)', async () => {
    const resolver = new TuiAskResolver();
    // teto de 60 tokens; um turno consome 30 (10 in + 20 out) ⇒ 50% do teto.
    const { controller } = buildController({
      responses: ['ok.'],
      askResolver: resolver,
      limits: { maxIterations: 25, maxToolCalls: 50, maxTokens: 60 },
    });
    await controller.submit('oi');
    expect(controller.current.meta.budgetPct).toBe(50);
  });

  it('erro de broker ⇒ bloco NEUTRO (diz broker, nunca provider) + phase=error', async () => {
    // caller que lança BrokerError (503) — simula infra fora.
    const resolver = new TuiAskResolver();
    const { ports } = fakePorts();
    const failing: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        throw new BrokerError({ status: 502, code: 'PROVIDER_ERROR', title: 'broker fora' });
      },
    };
    const controller = new SessionController({
      model: failing,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      // EST-0948 (auto-retry) — sleep instantâneo: o 502 é retryable, então o
      // auto-retry esgota o ciclo (backoff visível) e SÓ ENTÃO mostra o broker-error
      // TERMINAL que este teste verifica (mensagem neutra). Sem esperar de verdade.
      retry: { sleep: () => Promise.resolve() },
    });
    await controller.submit('faça algo');
    expect(controller.current.phase).toBe('error');
    const err = controller.current.blocks.find((b) => b.kind === 'broker-error');
    expect(err?.kind).toBe('broker-error');
    if (err?.kind === 'broker-error') {
      // EST-0942 — 502 PROVIDER_ERROR ⇒ mensagem CLASSIFICADA "provedor do tier",
      // sempre NEUTRA quanto ao provider (HG-2): nunca cita o vendor.
      expect(err.message.toLowerCase()).toContain('provedor');
      expect(err.message.toLowerCase()).not.toMatch(/openai|anthropic|gpt/);
      expect(err.status).toBe(502);
    }
  });

  it('clear() esvazia os blocos e volta a idle', async () => {
    const resolver = new TuiAskResolver();
    const { controller } = buildController({ responses: ['oi.'], askResolver: resolver });
    await controller.submit('oi');
    expect(controller.current.blocks.length).toBeGreaterThan(0);
    controller.clear();
    expect(controller.current.blocks.length).toBe(0);
    expect(controller.current.phase).toBe('idle');
  });
});

describe('SessionController — <BrokerError>: r tentar / esc cancelar (EST-0989)', () => {
  // Caller que FALHA nas N primeiras chamadas (BrokerError) e depois RECUPERA,
  // emitindo a resposta scriptada — p/ provar que `retryLastGoal()` re-dispara o
  // mesmo turno e, com o broker de volta, conclui (phase=done).
  function flakyController(failTimes: number, response: string) {
    const { ports } = fakePorts();
    let ctrlRef: SessionController | null = null;
    let calls = 0;
    const sink: StreamSink = {
      onStart: () => ctrlRef?.sink.onStart?.(),
      onDelta: (c) => ctrlRef?.sink.onDelta(c),
      onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
      onDone: () => ctrlRef?.sink.onDone?.(),
    };
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        calls += 1;
        if (calls <= failTimes) {
          throw new BrokerError({ status: 503, code: 'UPSTREAM', title: 'broker fora' });
        }
        sink.onStart?.();
        for (const ch of response) sink.onDelta(ch);
        sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
        sink.onDone?.();
        return { request_id: 'r', content: response, finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      // EST-0948 (auto-retry) — estes testes exercitam o RETRY MANUAL (r/esc) após o
      // broker-error TERMINAL. Com auto-retry ligado, uma falha retryable se
      // auto-resolveria antes de cair no manual; `maxAttempts:1` desliga o auto-retry
      // (1 tentativa só ⇒ erro manual direto), isolando o caminho que ESTE bloco testa.
      // O auto-retry tem cobertura própria em `controller-retry.test.ts`.
      retry: { maxAttempts: 1 },
    });
    ctrlRef = controller;
    return { controller, callCount: () => calls };
  }

  it('retryLastGoal() RE-DISPARA o último objetivo e, com o broker de volta, conclui', async () => {
    const { controller, callCount } = flakyController(1, 'pronto, recuperei.');
    await controller.submit('faça algo');
    // 1ª tentativa falhou ⇒ erro de broker na tela.
    expect(controller.current.phase).toBe('error');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(true);
    expect(callCount()).toBe(1);

    // `r` ⇒ retenta o MESMO objetivo (agora o broker responde).
    controller.retryLastGoal();
    await new Promise((r) => setTimeout(r, 0)); // deixa o turno assíncrono concluir
    expect(callCount()).toBe(2); // re-chamou o broker
    expect(controller.current.phase).toBe('done');
    // o erro saiu da tela; a resposta entrou.
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy?.kind === 'aluy' && aluy.text).toContain('recuperei');
    // NÃO duplicou a fala do usuário (um único bloco `you`).
    expect(controller.current.blocks.filter((b) => b.kind === 'you').length).toBe(1);
  });

  it('retryLastGoal() é no-op fora da fase de erro (não dispara turno fantasma)', async () => {
    const { controller, callCount } = flakyController(0, 'ok.');
    await controller.submit('oi');
    expect(controller.current.phase).toBe('done');
    const before = callCount();
    controller.retryLastGoal(); // idle/done ⇒ no-op
    await new Promise((r) => setTimeout(r, 0));
    expect(callCount()).toBe(before);
  });

  it('dismissError() descarta o erro e volta ao composer (idle), limpando o bloco', async () => {
    const { controller } = flakyController(1, 'irrelevante');
    await controller.submit('faça algo');
    expect(controller.current.phase).toBe('error');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(true);

    controller.dismissError();
    expect(controller.current.phase).toBe('idle');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
    // a fala do usuário PERMANECE (esc só descarta o erro, não a conversa).
    expect(controller.current.blocks.some((b) => b.kind === 'you')).toBe(true);
  });

  it('dismissError() é no-op fora da fase de erro', () => {
    const { controller } = flakyController(0, 'ok.');
    controller.dismissError(); // ainda em boot
    expect(controller.current.phase).toBe('boot');
  });
});

describe('SessionController — BudgetGate [c] continuar PRESERVA a conversa (B1, §2.12)', () => {
  // teto de 0 iterações ⇒ o loop bate no limite na 1ª checagem (antes de iterar):
  // `stop.kind === 'limit'` ⇒ phase=budget, com a conversa (o `you`) já na tela.
  const HARD_LIMIT = { maxIterations: 0, maxToolCalls: 0, maxTokens: 1 } as const;

  it('atingir o teto ⇒ phase=budget e a conversa do usuário fica na tela', async () => {
    const resolver = new TuiAskResolver();
    const { controller } = buildController({
      responses: ['nunca chega aqui'],
      askResolver: resolver,
      limits: HARD_LIMIT,
    });
    await controller.submit('faça muita coisa');
    expect(controller.current.phase).toBe('budget');
    expect(controller.current.pendingBudget).toBeDefined();
    // a conversa NÃO foi apagada ao entrar no gate
    const you = controller.current.blocks.find((b) => b.kind === 'you');
    expect(you?.kind).toBe('you');
    if (you?.kind === 'you') expect(you.text).toBe('faça muita coisa');
  });

  it('continueAfterBudget() PRESERVA os blocos (nunca limpa) e ESTENDE+RETOMA', async () => {
    const resolver = new TuiAskResolver();
    // teto que estoura por ITERAÇÕES (maxIterations:0) mas com folga de tokens, p/ que
    // o `[c]` (que estende +50 iterações) consiga RETOMAR e o modelo concluir.
    const { controller } = buildController({
      responses: ['concluído.'],
      askResolver: resolver,
      limits: { maxIterations: 0, maxToolCalls: 50, maxTokens: 1_000_000 },
    });
    await controller.submit('continue por favor');
    expect(controller.current.phase).toBe('budget');
    const blocksAntes = controller.current.blocks.length;
    expect(blocksAntes).toBeGreaterThan(0);

    // EST-0948 — `[c]` estende o teto (tokens+iterações) e RETOMA o MESMO turno: como
    // agora há iterações (0+50) e folga de tokens, o modelo conclui ⇒ phase=done.
    await controller.continueAfterBudget();

    // a conversa é PRESERVADA (nunca o `clear()` antigo); a fala do usuário fica.
    const you = controller.current.blocks.find((b) => b.kind === 'you');
    expect(you?.kind).toBe('you');
    if (you?.kind === 'you') expect(you.text).toBe('continue por favor');
    // o turno RETOMOU e concluiu — saiu do gate, pending limpo.
    expect(controller.current.phase).toBe('done');
    expect(controller.current.pendingBudget).toBeUndefined();
    // o trabalho continuou: a resposta final do modelo apareceu (não foi descartada).
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy?.kind).toBe('aluy');
  });

  it('continueAfterBudget() RE-PAUSA se re-estourar (ciclo [c] funciona repetidamente)', async () => {
    const resolver = new TuiAskResolver();
    // teto MÍNIMO de iterações (1) + token MUITO baixo: cada extensão dá só +1 janela
    // de 1 token, então o turno re-estoura logo após retomar ⇒ o gate REAPARECE.
    const { controller } = buildController({
      // o modelo sempre pede uma tool (nunca conclui) ⇒ continua consumindo.
      responses: [toolCall('read_file', { path: 'a.ts' })],
      files: { 'a.ts': 'x' },
      askResolver: resolver,
      limits: { maxIterations: 1, maxToolCalls: 1, maxTokens: 1 },
    });
    await controller.submit('leia em loop');
    expect(controller.current.phase).toBe('budget');

    // 1º [c]: estende e retoma — re-estoura (teto de tokens ínfimo) ⇒ pausa de novo.
    await controller.continueAfterBudget();
    expect(controller.current.phase).toBe('budget');
    expect(controller.current.pendingBudget).toBeDefined();

    // 2º [c]: o ciclo repete — re-arma e re-pausa de novo (anti-runaway preservado).
    await controller.continueAfterBudget();
    expect(controller.current.phase).toBe('budget');
  });

  it('continueAfterBudget() é no-op fora do gate (nunca apaga por engano)', async () => {
    const resolver = new TuiAskResolver();
    const { controller } = buildController({ responses: ['oi.'], askResolver: resolver });
    await controller.submit('oi');
    const before = controller.current;
    await controller.continueAfterBudget(); // phase=done, não budget ⇒ no-op
    expect(controller.current).toBe(before);
    expect(controller.current.blocks.length).toBeGreaterThan(0);
  });

  it('o gate mostra o consumo em % do teto da sessão (não só tokens crus)', async () => {
    const resolver = new TuiAskResolver();
    // teto de tokens de 100; o modelo conclui após 1 turno (usa 30 tokens no caller
    // scriptado: 10 in + 20 out). maxIterations:0 ⇒ estoura ANTES de gastar, mas o
    // pendingBudget já carrega o % calculado do teto.
    const { controller } = buildController({
      responses: ['x'],
      askResolver: resolver,
      limits: { maxIterations: 0, maxToolCalls: 50, maxTokens: 100 },
    });
    await controller.submit('faça');
    expect(controller.current.phase).toBe('budget');
    const pb = controller.current.pendingBudget;
    expect(pb).toBeDefined();
    // % do teto presente (display legível) + o teto exposto p/ o texto.
    expect(pb?.budgetPct).toBeDefined();
    expect(pb?.maxTokens).toBe(100);
  });
});

describe('EST-0969 — loop degenerado: nota anti-runaway + done, SEM gate de [c] continuar', () => {
  it('o model que cospe a mesma coisa em loop ⇒ phase=done + nota anti-runaway (não budget)', async () => {
    const resolver = new TuiAskResolver();
    // model que SIMULA a guarda disparando dentro do stream (o que o acumulador
    // real faz): lança DegenerateLoopError ⇒ o loop devolve stop:'degenerate'.
    const degenModel: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        throw new DegenerateLoopError('line-repeat', 25, '<<<EDIT_STDIN>/>/>');
      },
    };
    const { controller } = buildController({
      responses: [],
      model: degenModel,
      askResolver: resolver,
    });

    await controller.submit('faça algo que degenere');

    // NÃO entra no gate de budget (retomar só re-degeneraria) — fecha em done.
    expect(controller.current.phase).toBe('done');
    expect(controller.current.pendingBudget).toBeUndefined();
    // a NOTA anti-runaway está na tela (consentimento informado: o usuário VÊ por quê).
    const note = controller.current.blocks.find(
      (b) => b.kind === 'note' && b.title === 'anti-runaway',
    );
    expect(note?.kind).toBe('note');
    if (note?.kind === 'note') {
      expect(note.lines.join(' ')).toContain('LOOP DE REPETIÇÃO');
    }
    // a fala do usuário fica preservada na tela.
    const you = controller.current.blocks.find((b) => b.kind === 'you');
    expect(you?.kind).toBe('you');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EST-0959 · ADR-0055 — eixo de MODO no controlador (Tab cicla; espelha a engine).
// ═══════════════════════════════════════════════════════════════════════════
describe('EST-1015 — nextMode: ciclo do Tab INVERTIDO normal→plan→unsafe→normal (opção (c))', () => {
  it('cicla normal→plan (lado seguro primeiro), plan→unsafe, unsafe→normal', () => {
    expect(nextMode('normal')).toBe('plan'); // Tab acidental de normal cai no SEGURO
    expect(nextMode('plan')).toBe('unsafe');
    expect(nextMode('unsafe')).toBe('normal');
  });
});

describe('EST-0959 — SessionController espelha e cicla o modo da engine', () => {
  it('o estado inicial reflete o modo da engine (plan)', () => {
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      engine: new PolicyPermissionEngine({ mode: 'plan' }),
    });
    expect(controller.mode).toBe('plan');
    expect(controller.current.mode).toBe('plan');
  });

  // EST-1015 (opção (c) do dono) — ciclo INVERTIDO `normal→plan→unsafe→normal` + confirmação no →unsafe.
  it('cycleMode() INVERTIDO: normal→plan (lado seguro), e →unsafe pede CONFIRMAÇÃO', () => {
    const { controller, engine } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      isRoot: () => false,
    });
    expect(controller.mode).toBe('normal');
    controller.cycleMode(); // normal → PLAN (lado seguro primeiro)
    expect(controller.mode).toBe('plan');
    expect(engine.isPlan).toBe(true);
    controller.cycleMode(); // plan → (seria unsafe) ⇒ NÃO troca; pede confirmação
    expect(controller.mode).toBe('plan'); // ainda plan
    expect(controller.current.pendingUnsafeConfirm).toBe(true);
    controller.confirmUnsafe(); // [s] confirma
    expect(controller.mode).toBe('unsafe');
    expect(controller.current.pendingUnsafeConfirm).toBeFalsy();
    controller.cycleMode(); // unsafe → normal (sem confirmação)
    expect(controller.mode).toBe('normal');
  });

  it('cancelUnsafe() [n/Esc] descarta a confirmação — NÃO entra em unsafe', () => {
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      engine: new PolicyPermissionEngine({ mode: 'plan' }),
      isRoot: () => false,
    });
    controller.cycleMode(); // plan → pede confirmação
    expect(controller.current.pendingUnsafeConfirm).toBe(true);
    controller.cancelUnsafe();
    expect(controller.current.pendingUnsafeConfirm).toBeFalsy();
    expect(controller.mode).toBe('plan'); // permaneceu seguro
  });

  // EST-1015 · ADR-0072 §3d (achado seguranca, AG-0008) — root-block na aresta →unsafe.
  it('como ROOT, →unsafe é RECUSADO (sem confirmação sequer) — root-block §3d', () => {
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      engine: new PolicyPermissionEngine({ mode: 'plan' }), // plan → próxima é unsafe
      isRoot: () => true,
    });
    expect(controller.mode).toBe('plan');
    controller.cycleMode(); // plan → (seria unsafe, mas root) ⇒ RECUSA, nem pede confirmação
    expect(controller.mode).toBe('plan'); // NÃO virou unsafe
    expect(controller.current.pendingUnsafeConfirm).toBeFalsy(); // nem armou confirmação
    const notes = controller.current.blocks
      .filter((b): b is Extract<typeof b, { kind: 'note' }> => b.kind === 'note')
      .flatMap((b) => b.lines);
    expect(notes.some((l) => /root/i.test(l) && /YOLO|recusad/i.test(l))).toBe(true);
  });

  it('confirmUnsafe() RE-CHECA root (defesa): se virar root entre o Tab e o [s], recusa', () => {
    let root = false;
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      engine: new PolicyPermissionEngine({ mode: 'plan' }),
      isRoot: () => root,
    });
    controller.cycleMode(); // plan → confirmação pendente (não-root)
    expect(controller.current.pendingUnsafeConfirm).toBe(true);
    root = true; // "virou root" — defesa em profundidade
    controller.confirmUnsafe();
    expect(controller.mode).toBe('plan'); // recusou no confirmar
    expect(controller.mode).not.toBe('unsafe');
  });

  it('🔴 CHOKEPOINT — setMode("unsafe") como ROOT é RECUSADO (fecha o bypass do painel /permissions)', () => {
    // O painel /permissions chama controller.setMode("unsafe") DIRETO (não cycleMode).
    // Sem o guard no chokepoint setMode, root entrava em YOLO por aí (gate AG-0008).
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      isRoot: () => true, // uid 0
    });
    expect(controller.mode).toBe('normal');
    controller.setMode('unsafe'); // caminho do painel: DIRETO, sem passar por cycleMode
    expect(controller.mode).toBe('normal'); // RECUSADO — não virou unsafe como root
    const notes = controller.current.blocks
      .filter((b): b is Extract<typeof b, { kind: 'note' }> => b.kind === 'note')
      .flatMap((b) => b.lines);
    expect(notes.some((l) => /root/i.test(l) && /YOLO|recusad/i.test(l))).toBe(true);
  });

  it('setMode como ROOT: →plan e →normal seguem LIVRES (só →unsafe bloqueia)', () => {
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      isRoot: () => true,
    });
    controller.setMode('plan');
    expect(controller.mode).toBe('plan');
    controller.setMode('normal');
    expect(controller.mode).toBe('normal');
  });

  it('setMode(plan) após começar unsafe ⇒ Plan vence, sem resíduo (R3 ponta-a-ponta)', async () => {
    // sessão arranca unsafe; o agente pede um efeito ⇒ rodaria (bypass). Após
    // Tab→plan, o MESMO efeito é negado pela engine: a tool NÃO roda.
    const { controller, ran } = buildController({
      responses: [toolCall('run_command', { command: 'rm -rf node_modules' }), 'feito.'],
      askResolver: new TuiAskResolver(),
      engine: new PolicyPermissionEngine({ mode: 'unsafe' }),
    });
    controller.setMode('plan'); // Tab → plan ANTES de submeter
    expect(controller.mode).toBe('plan');
    await controller.submit('limpe o projeto');
    // Plan negou o efeito por POLÍTICA ⇒ o comando NUNCA rodou (zero efeito —
    // a prova central de R3/R4 ponta-a-ponta: nenhum byte/comando de efeito).
    expect(ran).not.toContain('rm -rf node_modules');
    expect(ran).toEqual([]); // NADA rodou
    // E a negação foi DENY-por-política, NÃO `ask`: a sessão jamais ficou pendente
    // de uma confirmação que o usuário pudesse aprovar por engano.
    expect(controller.current.phase).not.toBe('asking');
    const ask = controller.current.pendingAsk;
    expect(ask).toBeUndefined();
  });

  it('cycleMode/setMode são no-op se a engine não expõe o controle de modo', () => {
    // engine "bare" (só `decide`), sem `mode`/`setMode` ⇒ o controlador não cicla.
    const bareEngine = {
      decide: () => ({ decision: 'deny' as const, reason: 'bare' }),
    };
    const { ports } = fakePorts();
    const sink: StreamSink = { onDelta: () => {} };
    const controller = new SessionController({
      model: scriptedCaller(['oi.'], sink),
      permission: bareEngine,
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    expect(controller.mode).toBe('normal'); // fallback default
    controller.cycleMode(); // no-op
    controller.setMode('plan'); // no-op
    expect(controller.mode).toBe('normal');
  });

  it('em Plan, read_file (leitura local) RODA — Plan não bloqueia leitura', async () => {
    const { controller, ran } = buildController({
      responses: [toolCall('read_file', { path: 'README.md' }), 'li o readme.'],
      files: { 'README.md': '# projeto' },
      askResolver: new TuiAskResolver(),
      engine: new PolicyPermissionEngine({ mode: 'plan' }),
    });
    await controller.submit('leia o readme');
    // leitura permitida ⇒ a sessão terminou sem ask nem deny da leitura.
    expect(controller.current.phase).toBe('done');
    expect(ran).toEqual([]); // nenhum comando de shell (read_file não é shell)
    const deny = controller.current.blocks.find((b) => b.kind === 'deny');
    expect(deny).toBeUndefined();
  });
});

// ── EST-0962 — troca de tier da sessão pelo seletor /model ────────────────────

/**
 * ModelCaller que satisfaz o TierControl (setTier/tier) — espelha o caller real
 * (StreamingModelCaller). ECOA o tier corrente na fala (via sink) p/ provar que a
 * troca chegou ao caller antes da próxima chamada.
 */
function tierCaller(
  initial: string,
  sink: StreamSink,
): ModelCaller & { tier: string; model?: string; setTier(t: string, m?: string): void } {
  let tier = initial;
  // EST-0962 (Custom) — espelha o caller real: o slug só vive sob tier:'custom'.
  let model: string | undefined;
  return {
    async call(): Promise<ModelCallResult> {
      const content = model !== undefined ? `[${tier}:${model}]` : `[${tier}]`;
      sink.onStart?.();
      for (const ch of content) sink.onDelta(ch);
      sink.onDone?.();
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
    get tier() {
      return tier;
    },
    get model() {
      return model;
    },
    setTier(t: string, m?: string) {
      tier = t;
      model = t === 'custom' ? m : undefined;
    },
  };
}

describe('SessionController — setTier (EST-0962)', () => {
  function build(initial = 'aluy-flux') {
    const { ports } = fakePorts();
    let ctrlRef: SessionController | null = null;
    const sink: StreamSink = {
      onStart: () => ctrlRef?.sink.onStart?.(),
      onDelta: (c) => ctrlRef?.sink.onDelta(c),
      onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
      onDone: () => ctrlRef?.sink.onDone?.(),
    };
    const model = tierCaller(initial, sink);
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: initial, tokens: 0, windowPct: 0 },
    });
    ctrlRef = controller;
    return { controller, model };
  }

  it('troca o tier no caller E espelha em meta.tier (StatusBar)', () => {
    const { controller, model } = build('aluy-flux');
    expect(controller.tier).toBe('aluy-flux');
    controller.setTier('aluy-deep');
    expect(model.tier).toBe('aluy-deep'); // a próxima chamada de modelo usa o novo tier
    expect(controller.tier).toBe('aluy-deep');
    expect(controller.current.meta.tier).toBe('aluy-deep');
  });

  // F134 (HUNT-COMPACT) — REGRESSÃO "wired ≠ working": o Compactor é construído UMA vez
  // no boot; seus orçamentos window-relativos (input 50% + cauda recente 40%) eram
  // STALE após um `/tier` (a janela mudava, mas o compactor não). Aqui provamos que
  // `setTier` PROPAGA a nova janela ao compactor (via `setWindow`).
  it('F134 — setTier RE-RESOLVE os orçamentos window-relativos do Compactor (não ficam stale)', () => {
    const { controller } = build('aluy-flux');
    const compactor = (
      controller as unknown as {
        compactor: { maxRecentTokens: number; summaryInputMaxTokens: number };
      }
    ).compactor;

    controller.setTier('aluy-strata'); // janela 128k (fallback)
    expect(compactor.maxRecentTokens).toBe(Math.floor(128_000 * 0.4)); // 51_200
    expect(compactor.summaryInputMaxTokens).toBe(Math.floor(128_000 * 0.5)); // 64_000

    controller.setTier('aluy-flux'); // janela 256k ⇒ orçamentos SOBEM junto
    expect(compactor.maxRecentTokens).toBe(Math.floor(256_000 * 0.4)); // 102_400
    expect(compactor.summaryInputMaxTokens).toBe(Math.floor(256_000 * 0.5)); // 128_000
  });

  it('F134 — trocar p/ Custom (janela 0) DESLIGA o size-aware do Compactor (maxRecent=0)', () => {
    const { controller } = build('aluy-strata');
    const compactor = (controller as unknown as { compactor: { maxRecentTokens: number } })
      .compactor;
    controller.setTier('aluy-flux'); // liga (256k ⇒ 102_400)
    expect(compactor.maxRecentTokens).toBeGreaterThan(0);
    controller.setTier('custom', 'x/y'); // janela desconhecida ⇒ OFF
    expect(compactor.maxRecentTokens).toBe(0);
  });

  it('a PRÓXIMA chamada de modelo usa o novo tier', async () => {
    const { controller } = build('aluy-flux');
    controller.setTier('aluy-strata');
    await controller.submit('oi');
    // o caller fake ecoa o tier corrente na fala — prova que a troca chegou nele.
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy && 'text' in aluy ? aluy.text : '').toContain('[aluy-strata]');
  });

  it('trocar p/ o MESMO tier é no-op (não re-renderiza à toa)', () => {
    const { controller, model } = build('aluy-flux');
    controller.setTier('aluy-flux');
    expect(model.tier).toBe('aluy-flux');
    expect(controller.current.meta.tier).toBe('aluy-flux');
  });

  it('via Custom: setTier("custom", slug) espelha tier+model em meta (StatusBar custom · slug)', () => {
    const { controller, model } = build('aluy-flux');
    controller.setTier('custom', 'meta-llama/llama-3.1-8b-instruct');
    expect(model.tier).toBe('custom');
    expect(model.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(controller.current.meta.tier).toBe('custom');
    expect(controller.current.meta.model).toBe('meta-llama/llama-3.1-8b-instruct');
  });

  it('via Custom: a PRÓXIMA chamada usa tier:custom + o slug', async () => {
    const { controller } = build('aluy-flux');
    controller.setTier('custom', 'openrouter/x');
    await controller.submit('oi');
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy && 'text' in aluy ? aluy.text : '').toContain('[custom:openrouter/x]');
  });

  it('voltar de Custom p/ tier canônico LIMPA meta.model (Custom não vaza — HG-2)', () => {
    const { controller } = build('aluy-flux');
    controller.setTier('custom', 'x/y');
    expect(controller.current.meta.model).toBe('x/y');
    controller.setTier('aluy-deep');
    expect(controller.current.meta.tier).toBe('aluy-deep');
    expect(controller.current.meta.model).toBeUndefined();
  });

  it('só o SLUG muda (segue custom) ⇒ NÃO é no-op — re-espelha o novo slug', () => {
    const { controller, model } = build('aluy-flux');
    controller.setTier('custom', 'a/b');
    controller.setTier('custom', 'c/d'); // mesmo tier, slug diferente
    expect(model.model).toBe('c/d');
    expect(controller.current.meta.model).toBe('c/d');
  });

  it('HUNT (fix): setTier p/ tier do broker FORA do mapa NÃO zera a janela — auto-proteção segue (windowPct finito, não 100%)', async () => {
    // O bug: trocar (via /model picker) p/ um tier que o BROKER conhece mas que ainda
    // não está no FALLBACK_CONTEXT_TOKENS resolvia contextWindow=0 ⇒ (a) a
    // auto-compactação ficava INERTE (overflow → stall) e (b) `windowPct = tokens/0`
    // colapsava em 100% sempre (o display de stall). Com o fix, cai no PADRÃO protetor
    // (200k): 170k/200k = 85% — FINITO e correto, a auto-compactação segue ativa.
    const { ports } = fakePorts();
    let ctrlRef: SessionController | null = null;
    let tier = 'aluy-flux';
    const model: ModelCaller & { tier: string; setTier(t: string): void } = {
      async call(): Promise<ModelCallResult> {
        const usage = { request_id: 'r', tier, tokens_in: 170_000, tokens_out: 5 };
        ctrlRef?.sink.onStart?.();
        ctrlRef?.sink.onDelta('ok');
        ctrlRef?.sink.onUsage?.(usage);
        ctrlRef?.sink.onDone?.();
        return { request_id: 'r', content: 'ok', finish_reason: 'stop', usage };
      },
      get tier() {
        return tier;
      },
      setTier(t: string) {
        tier = t;
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      watchdogEnv: { ALUY_STUCK_OFF: '1' },
      // auto-compactação DESLIGADA aqui (sem compactionModel): provamos só a JANELA
      // (denominador) — que o fix mantém >0 p/ o tier do broker fora do mapa.
      autoCompactEnv: { ALUY_AUTOCOMPACT_AT: '0' },
    });
    ctrlRef = controller;

    // Troca p/ um tier que o broker conhece mas que o mapa hardcoded NÃO tem.
    controller.setTier('aluy-nova');
    expect(controller.tier).toBe('aluy-nova');

    await controller.submit('oi');
    // 170k / 200k (padrão protetor) = 85% — FINITO. Antes do fix: 170k/0 ⇒ 100% (stall).
    expect(controller.current.meta.windowPct).toBe(85);
  });

  it('caller SEM setTier (stub antigo) ⇒ setTier é no-op seguro', () => {
    const { ports } = fakePorts();
    const plainModel: ModelCaller = {
      async call() {
        return { request_id: 'r', content: 'x', finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model: plainModel,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    controller.setTier('aluy-deep'); // não lança
    expect(controller.tier).toBe('aluy-flux'); // sem controle ⇒ inalterado
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EST-0962 · /provider — SessionController.setProvider: seta o provider do modo
// Custom no caller + espelha em meta.provider; fora de Custom é no-op; trocar de
// tier/modelo descarta o provider. HG-2: só o NOME, nunca credencial.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Caller que satisfaz o TierControl COM provider (setProvider/provider) — espelha o
 * StreamingModelCaller real: o provider só vale em par com um slug Custom; setTier
 * (troca de tier/modelo) o descarta.
 */
function providerCaller(): ModelCaller & {
  tier: string;
  model?: string;
  provider?: string;
  setTier(t: string, m?: string): void;
  setProvider(name: string | undefined): void;
} {
  let tier = 'aluy-flux';
  let model: string | undefined;
  let provider: string | undefined;
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '[x]', finish_reason: 'stop' };
    },
    get tier() {
      return tier;
    },
    get model() {
      return model;
    },
    get provider() {
      return provider;
    },
    setTier(t: string, m?: string) {
      tier = t;
      model = t === 'custom' ? m : undefined;
      provider = undefined; // trocar de tier/modelo descarta o provider (par anterior)
    },
    setProvider(name: string | undefined) {
      provider = tier === 'custom' && model !== undefined ? name : undefined;
    },
  };
}

describe('SessionController — setProvider (EST-0962 · /provider)', () => {
  function build() {
    const { ports } = fakePorts();
    const model = providerCaller();
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    return { controller, model };
  }

  it('sob Custom: setProvider seta no caller E espelha em meta.provider', () => {
    const { controller, model } = build();
    controller.setTier('custom', 'x/y');
    controller.setProvider('deepseek');
    expect(model.provider).toBe('deepseek');
    expect(controller.provider).toBe('deepseek');
    expect(controller.current.meta.provider).toBe('deepseek');
  });

  it('FORA de Custom: setProvider é no-op (par exige um slug — HG-2)', () => {
    const { controller, model } = build();
    controller.setProvider('deepseek'); // tier canônico ⇒ caller recusa
    expect(model.provider).toBeUndefined();
    expect(controller.provider).toBeUndefined();
    expect(controller.current.meta.provider).toBeUndefined();
  });

  it('trocar de tier/modelo (setTier) DESCARTA meta.provider', () => {
    const { controller } = build();
    controller.setTier('custom', 'x/y');
    controller.setProvider('deepseek');
    expect(controller.current.meta.provider).toBe('deepseek');
    controller.setTier('custom', 'a/b'); // novo slug ⇒ provider some
    expect(controller.current.meta.provider).toBeUndefined();
  });

  it('caller SEM setProvider (stub antigo) ⇒ setProvider é no-op seguro', () => {
    const { ports } = fakePorts();
    const plainModel: ModelCaller = {
      async call() {
        return { request_id: 'r', content: 'x', finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model: plainModel,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    controller.setProvider('deepseek'); // não lança
    expect(controller.provider).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EST-1117 — `/model` CONJUGADO: aplicar o TRIO (provider+model+effort) de uma vez.
// O handler (run.tsx) chama setTier[/setProvider]+setEffort; aqui provamos que o
// controller aplica os três e que os valores ficam corretos na sessão.
// ═══════════════════════════════════════════════════════════════════════════

/** Caller que satisfaz o TierControl COM provider E effort — espelha o caller real. */
function trioCaller(): ModelCaller & {
  tier: string;
  model?: string;
  provider?: string;
  effort?: string;
  setTier(t: string, m?: string): void;
  setProvider(name: string | undefined): void;
  setEffort(v: string | undefined): void;
} {
  let tier = 'aluy-flux';
  let model: string | undefined;
  let provider: string | undefined;
  let effort: string | undefined;
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '[x]', finish_reason: 'stop' };
    },
    get tier() {
      return tier;
    },
    get model() {
      return model;
    },
    get provider() {
      return provider;
    },
    get effort() {
      return effort;
    },
    setTier(t: string, m?: string) {
      tier = t;
      model = t === 'custom' ? m : undefined;
      provider = undefined;
    },
    setProvider(name: string | undefined) {
      provider = tier === 'custom' && model !== undefined ? name : undefined;
    },
    setEffort(v: string | undefined) {
      effort = v;
    },
  };
}

describe('SessionController — trio conjugado (EST-1117)', () => {
  function build() {
    const { ports } = fakePorts();
    const model = trioCaller();
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    });
    return { controller, model };
  }

  it('tier + effort aplicados juntos ⇒ controller.tier e controller.effort corretos', () => {
    const { controller, model } = build();
    // espelha o handler onSelectConjugated p/ {kind:tier} + {kind:set, value:high}
    controller.setTier('aluy-deep');
    controller.setEffort('high');
    expect(controller.tier).toBe('aluy-deep');
    expect(controller.effort).toBe('high');
    expect(model.tier).toBe('aluy-deep');
    expect(model.effort).toBe('high');
  });

  it('Custom slug + effort custom ⇒ slug em meta + effort passthrough', () => {
    const { controller, model } = build();
    controller.setTier('custom', 'meta-llama/llama-3.1-8b-instruct');
    controller.setEffort('reasoning:max');
    expect(controller.current.meta.tier).toBe('custom');
    expect(controller.current.meta.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(controller.effort).toBe('reasoning:max');
    expect(model.effort).toBe('reasoning:max');
  });

  it('effort "manter" (handler NÃO chama setEffort) ⇒ effort anterior preservado', () => {
    const { controller } = build();
    controller.setEffort('medium'); // estado anterior
    // handler com effort.kind==='keep' NÃO chama setEffort ⇒ segue medium
    controller.setTier('aluy-strata');
    expect(controller.tier).toBe('aluy-strata');
    expect(controller.effort).toBe('medium'); // mantido
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EST-0973 — `/compact`: compactar o contexto quando enche (resume + continua).
// ═══════════════════════════════════════════════════════════════════════════

/** Caller de compactação que registra a chamada e devolve um resumo fixo. */
function recordingCompactionCaller(summary: string): {
  model: ModelCaller;
  calls: { keys: string[]; sawSummaryPrompt: boolean[] };
} {
  const calls = { keys: [] as string[], sawSummaryPrompt: [] as boolean[] };
  const model: ModelCaller = {
    async call(args: {
      readonly messages: { role: string; content: string }[];
      readonly idempotencyKey: string;
    }): Promise<ModelCallResult> {
      calls.keys.push(args.idempotencyKey);
      const sys = args.messages.find((m) => m.role === 'system');
      calls.sawSummaryPrompt.push(!!sys && sys.content.includes('compactador de contexto'));
      return { request_id: 'r-compact', content: summary, finish_reason: 'stop' };
    },
  };
  return { model, calls };
}

describe('EST-0973 — /compact reduz o histórico ativo preservando o essencial', () => {
  it('compacta o histórico de uma conversa real e continua a sessão', async () => {
    // o modelo lê vários arquivos (várias tool-calls) e conclui ⇒ histórico longo
    // o bastante p/ valer a compactação (mais que os recentes preservados).
    const { model: compactionModel, calls } = recordingCompactionCaller(
      'decisões: leu README. estado: concluído. arquivos: README.md',
    );
    const { controller } = buildController({
      responses: [
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        'pronto, li o README.',
      ],
      files: { 'README.md': 'conteúdo do readme' },
      askResolver: new TuiAskResolver(),
      compactionModel,
    });
    await controller.submit('leia o README e resuma');
    expect(controller.current.phase).toBe('done');
    expect(controller.canCompact).toBe(true);

    await controller.compact();

    // a chamada de resumo foi pelo broker (caller dedicado), com prompt de resumo
    expect(calls.keys).toHaveLength(1);
    expect(calls.sawSummaryPrompt[0]).toBe(true);
    // a nota mostra o que foi compactado (DoD: "N turnos → sumário")
    const note = controller.current.blocks.find((b) => b.kind === 'note' && b.title === 'compact');
    expect(note?.kind).toBe('note');
    if (note?.kind === 'note') {
      expect(note.lines.join(' ')).toMatch(/turnos → sumário/);
    }
  });

  it('a sessão continua funcionando após compactar (próximo submit usa o sumário)', async () => {
    const { model: compactionModel } = recordingCompactionCaller('resumo: estado preservado.');
    const { controller } = buildController({
      // 1ª submit: lê arquivo + conclui. 2ª submit (pós-compact): conclui direto.
      responses: [
        toolCall('read_file', { path: 'a.ts' }),
        'li o a.ts.',
        'continuando com o contexto reduzido.',
      ],
      files: { 'a.ts': 'export const x = 1;' },
      askResolver: new TuiAskResolver(),
      compactionModel,
    });
    await controller.submit('leia a.ts');
    await controller.compact();

    // o próximo objetivo CONTINUA — não quebra; produz um turno do agente.
    await controller.submit('agora explique');
    expect(controller.current.phase).toBe('done');
    const aluyBlocks = controller.current.blocks.filter((b) => b.kind === 'aluy');
    expect(aluyBlocks.length).toBeGreaterThan(0);
  });

  it('/compact sem conversa: no-op honesto (nota), sem chamar o modelo', async () => {
    const { model: compactionModel, calls } = recordingCompactionCaller('x');
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      compactionModel,
    });
    await controller.compact(); // nada submetido ainda
    expect(calls.keys).toHaveLength(0);
    const note = controller.current.blocks.find((b) => b.kind === 'note');
    expect(note?.kind).toBe('note');
  });

  it('conversa curta: canCompact=false e /compact não chama o modelo', async () => {
    const { model: compactionModel, calls } = recordingCompactionCaller('x');
    const { controller } = buildController({
      responses: ['resposta curta.'],
      askResolver: new TuiAskResolver(),
      compactionModel,
    });
    await controller.submit('oi'); // histórico = [goal, model] (2 itens, <2 antigos)
    expect(controller.canCompact).toBe(false);
    await controller.compact();
    expect(calls.keys).toHaveLength(0); // NothingToCompact ⇒ nota, sem modelo
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EST-0973 — FEEDBACK de PROGRESSO no /compact: a fase `compacting` + `progress`
// aparecem ENQUANTO a chamada ao broker roda (não parece travado) e SOMEM ao
// concluir / cancelar / falhar. (DoD: indicador enquanto roda, some ao terminar.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Caller de compactação DIFERIDO: a chamada fica PENDENTE até o teste resolver/
 * rejeitar `gate` à mão — assim conseguimos inspecionar o estado MID-FLIGHT (com
 * o `compact()` ainda rodando) sem timers reais. Mock — não chama o modelo.
 */
function deferredCompactionCaller(): {
  model: ModelCaller;
  resolve: (summary: string) => void;
  reject: (err: unknown) => void;
} {
  let resolveFn!: (r: ModelCallResult) => void;
  let rejectFn!: (e: unknown) => void;
  const model: ModelCaller = {
    call() {
      return new Promise<ModelCallResult>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
    },
  };
  return {
    model,
    resolve: (summary) =>
      resolveFn({ request_id: 'r-compact', content: summary, finish_reason: 'stop' }),
    reject: (err) => rejectFn(err),
  };
}

/** Conversa longa o bastante p/ haver o que compactar (canCompact=true). */
async function seedCompactableConversation(controller: SessionController): Promise<void> {
  await controller.submit('leia o README e resuma');
}

describe('EST-0973 — /compact mostra PROGRESSO enquanto roda e some ao terminar', () => {
  function build(deferred: ModelCaller) {
    return buildController({
      responses: [
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        toolCall('read_file', { path: 'README.md' }),
        'pronto, li o README.',
      ],
      files: { 'README.md': 'conteúdo do readme' },
      askResolver: new TuiAskResolver(),
      compactionModel: deferred,
    });
  }

  it('ENQUANTO compacta: phase=compacting + progress INDETERMINADO (label, sem %)', async () => {
    const deferred = deferredCompactionCaller();
    const { controller } = build(deferred.model);
    await seedCompactableConversation(controller);
    expect(controller.canCompact).toBe(true);

    // dispara o /compact mas NÃO espera (a chamada ao broker fica pendente)
    const running = controller.compact();
    await Promise.resolve(); // deixa o microtask do `compact()` setar a fase

    expect(controller.current.phase).toBe('compacting');
    const prog = controller.current.progress;
    expect(prog).toBeDefined();
    expect(prog?.label).toBe('compactando a conversa');
    // INDETERMINADO: sem etapas mensuráveis ⇒ sem value/max (não finge %)
    expect(prog?.value).toBeUndefined();
    expect(prog?.max).toBeUndefined();
    expect(typeof prog?.startedAt).toBe('number');

    // conclui: o indicador SOME e a sessão volta ao repouso com a nota de ganho
    deferred.resolve('decisões: leu README. estado: concluído.');
    await running;
    expect(controller.current.phase).toBe('idle');
    expect(controller.current.progress).toBeUndefined();
    const note = controller.current.blocks.find((b) => b.kind === 'note' && b.title === 'compact');
    expect(note?.kind).toBe('note');
  });

  it('a fase compacting é OBSERVADA pelo subscribe (a TUI a vê para renderizar)', async () => {
    const deferred = deferredCompactionCaller();
    const { controller } = build(deferred.model);
    await seedCompactableConversation(controller);

    const seenPhases: string[] = [];
    const seenProgressLabels: (string | undefined)[] = [];
    const unsub = controller.subscribe((s) => {
      seenPhases.push(s.phase);
      seenProgressLabels.push(s.progress?.label);
    });

    const running = controller.compact();
    await Promise.resolve();
    deferred.resolve('resumo.');
    await running;
    unsub();

    expect(seenPhases).toContain('compacting'); // a TUI viu a fase
    expect(seenProgressLabels).toContain('compactando a conversa'); // e o progress
    // e ao final o progress foi LIMPO (último estado sem label)
    expect(controller.current.progress).toBeUndefined();
  });

  it('FALHA de broker durante o compact: progress some e a sessão NÃO quebra', async () => {
    const deferred = deferredCompactionCaller();
    const { controller } = build(deferred.model);
    await seedCompactableConversation(controller);

    const running = controller.compact();
    await Promise.resolve();
    expect(controller.current.phase).toBe('compacting');

    deferred.reject(new Error('broker fora do ar'));
    await running;

    // some gracioso: sem progress preso, volta ao repouso, nota neutra (HG-2)
    expect(controller.current.progress).toBeUndefined();
    expect(controller.current.phase).toBe('idle');
    const note = controller.current.blocks.find((b) => b.kind === 'note' && b.title === 'compact');
    expect(note?.kind).toBe('note');
    if (note?.kind === 'note') {
      expect(note.lines.join(' ').toLowerCase()).toContain('broker');
      // HG-2: nunca nomeia um provider
      expect(note.lines.join(' ').toLowerCase()).not.toMatch(/openai|anthropic|gpt|claude/);
    }
  });
});

describe('EST-0973 — BudgetGate OFERECE compactar e RETOMA o loop', () => {
  // teto de tool-calls: o modelo lê em loop, o loop bate o teto APÓS construir um
  // histórico real e LONGO (goal + 4×(model+observação) = 9 itens) ⇒ phase=budget
  // COM o que compactar (mais que os recentes preservados — canCompact=true).
  const TOOLCALL_LIMIT = { maxIterations: 25, maxToolCalls: 4, maxTokens: 1_000_000 } as const;

  it('ao bater o teto há histórico a compactar (canCompact) e o gate o oferece', async () => {
    const { model: compactionModel } = recordingCompactionCaller('resumo do progresso.');
    const { controller } = buildController({
      // sempre pede uma leitura ⇒ o loop itera até o teto de tool-calls
      responses: [toolCall('read_file', { path: 'a.ts' })],
      files: { 'a.ts': 'x' },
      askResolver: new TuiAskResolver(),
      limits: TOOLCALL_LIMIT,
      compactionModel,
    });
    await controller.submit('leia tudo em loop');
    expect(controller.current.phase).toBe('budget');
    expect(controller.canCompact).toBe(true);
  });

  it('compactAfterBudget() compacta (via broker) e RETOMA o loop com a janela liberada', async () => {
    const { model: compactionModel, calls } = recordingCompactionCaller('resumo do progresso.');
    const { controller } = buildController({
      // 1ª fase: 4 leituras (bate o teto de tool-calls). Após retomar, o modelo conclui.
      responses: [
        toolCall('read_file', { path: 'a.ts' }),
        toolCall('read_file', { path: 'a.ts' }),
        toolCall('read_file', { path: 'a.ts' }),
        toolCall('read_file', { path: 'a.ts' }),
        'concluído.',
      ],
      files: { 'a.ts': 'x' },
      askResolver: new TuiAskResolver(),
      limits: TOOLCALL_LIMIT,
      compactionModel,
    });
    await controller.submit('leia em loop');
    expect(controller.current.phase).toBe('budget');

    await controller.compactAfterBudget();

    // o resumo foi pelo broker (caller dedicado da compactação)
    expect(calls.keys).toHaveLength(1);
    // o gate saiu (não ficou pendente) e a sessão seguiu — o budget foi re-armado
    expect(controller.current.phase).not.toBe('budget');
    expect(controller.current.pendingBudget).toBeUndefined();
    // a nota de compactação apareceu
    const note = controller.current.blocks.find((b) => b.kind === 'note' && b.title === 'compact');
    expect(note?.kind).toBe('note');
  });

  it('compactAfterBudget() é no-op fora do gate (nunca compacta por engano)', async () => {
    const { model: compactionModel, calls } = recordingCompactionCaller('x');
    const { controller } = buildController({
      responses: ['oi.'],
      askResolver: new TuiAskResolver(),
      compactionModel,
    });
    await controller.submit('oi'); // phase=done, não budget
    await controller.compactAfterBudget();
    expect(calls.keys).toHaveLength(0);
  });

  it('continueAfterBudget() (sem compactar) ESTENDE+RETOMA preservando a conversa', async () => {
    const { controller } = buildController({
      // 4 leituras batem o teto de tool-calls; após o [c] estender, o modelo conclui.
      responses: [
        toolCall('read_file', { path: 'a.ts' }),
        toolCall('read_file', { path: 'a.ts' }),
        toolCall('read_file', { path: 'a.ts' }),
        toolCall('read_file', { path: 'a.ts' }),
        'concluído.',
      ],
      files: { 'a.ts': 'x' },
      askResolver: new TuiAskResolver(),
      limits: TOOLCALL_LIMIT,
    });
    await controller.submit('leia em loop');
    expect(controller.current.phase).toBe('budget');
    const you = controller.current.blocks.find((b) => b.kind === 'you');

    // EST-0948 — `[c]` estende (incl. tool-calls, que crescem com as iterações) e
    // RETOMA o MESMO turno: agora há teto p/ mais leituras + a conclusão ⇒ phase=done.
    await controller.continueAfterBudget();
    expect(controller.current.phase).toBe('done');
    // a fala do usuário foi PRESERVADA (não houve clear); o trabalho continuou.
    const youDepois = controller.current.blocks.find((b) => b.kind === 'you');
    expect(youDepois?.kind).toBe('you');
    if (you?.kind === 'you' && youDepois?.kind === 'you') {
      expect(youDepois.text).toBe(you.text);
    }
  });
});
