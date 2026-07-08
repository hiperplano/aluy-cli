// ADR-0147 — testes da `SessionCommandPort` (o EXECUTOR concreto de `session_command`):
// o roteamento por classe de efeito (`agentEffect`) contra o registro real
// (`NATIVE_COMMANDS`), cobrindo o checklist de validação da estória:
//   (1) um comando SEGURO (read-only) executa direto;
//   (2) um DESTRUTIVO (`/clear full`) RE-PASSA `decide()` e pede confirmação —
//       negado/sem confirmação ⇒ nada é executado; aprovado ⇒ executa de verdade;
//   (3) `human-only` nega SEM tocar a catraca/controller;
//   (4) comando NÃO-classificado (não-nativo) nega (fail-closed);
//   (5) `/cycle` via a porta INICIA o ciclo (Q-4 do ADR-0147).

import { describe, expect, it, vi } from 'vitest';
import {
  PolicyPermissionEngine,
  type AskRequest,
  type AskResolution,
  type AskResolver,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { createSessionCommandPort, type SessionCommandPortDeps } from '../../src/session/session-command-port.js';
import type { SessionController } from '../../src/session/controller.js';

/** AskResolver fake: grava os pedidos e responde conforme a fila (default: aprova). */
function fakeAskResolver(resolutions: readonly AskResolution['kind'][] = []): {
  resolver: AskResolver;
  requests: AskRequest[];
} {
  const requests: AskRequest[] = [];
  let i = 0;
  const resolver: AskResolver = {
    async resolve(request): Promise<AskResolution> {
      requests.push(request);
      const kind = resolutions[i] ?? 'approve-once';
      i += 1;
      return kind === 'deny' ? { kind: 'deny' } : { kind: 'approve-once' };
    },
  };
  return { resolver, requests };
}

function fakePorts(): ToolPorts {
  return {
    fs: { readFile: vi.fn(), writeFile: vi.fn(), exists: vi.fn() },
    shell: { exec: vi.fn() },
    search: { search: vi.fn() },
  } as unknown as ToolPorts;
}

/** Controller fake: só implementa o que a porta toca nos cenários testados. */
function fakeController(overrides: Record<string, unknown> = {}): SessionController {
  const blocks: unknown[] = [];
  return {
    get current() {
      return { blocks };
    },
    get usage() {
      return { tokens: 123, windowPct: 4, tier: 'strata' };
    },
    pushNote: vi.fn((title: string, lines: string[]) => {
      blocks.push({ kind: 'note', title, lines });
    }),
    clear: vi.fn(),
    compact: vi.fn(async () => undefined),
    cycle: vi.fn(async () => ({ started: true, ran: true })),
    cyclePause: vi.fn(),
    cycleResume: vi.fn(),
    cycleStop: vi.fn(),
    cycleStatus: vi.fn(),
    cycleEdit: vi.fn(),
    setEffort: vi.fn(),
    setProvider: vi.fn(),
    setLabel: vi.fn(),
    label: undefined,
    labelColor: undefined,
    ...overrides,
  } as unknown as SessionController;
}

function baseDeps(over: Partial<SessionCommandPortDeps> = {}): SessionCommandPortDeps {
  const { resolver } = fakeAskResolver();
  return {
    controller: fakeController(),
    engine: new PolicyPermissionEngine(),
    askResolver: resolver,
    ports: fakePorts(),
    ...over,
  };
}

describe('ADR-0147 (1) — comando SEGURO (read-only) executa direto', () => {
  it('/usage devolve o texto real (tokens/janela/tier), sem tocar a catraca de confirmação', async () => {
    const { resolver, requests } = fakeAskResolver();
    const port = createSessionCommandPort(baseDeps({ askResolver: resolver }));
    const outcome = await port.run('usage', '');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('123');
    expect(outcome.text).toMatch(/strata/);
    expect(requests).toHaveLength(0); // read-only nunca pede confirmação.
  });
});

describe('ADR-0147 (2) — /clear full é DESTRUTIVO: re-passa decide(), pede confirmação', () => {
  it('memória com fatos + usuário APROVA ⇒ executa (clearAll + clear da sessão)', async () => {
    const { resolver, requests } = fakeAskResolver(['approve-once']);
    const clearAll = vi.fn(async () => 3);
    const memory = { list: vi.fn(async () => [{ id: '1' }, { id: '2' }, { id: '3' }]), clearAll } as unknown;
    const controller = fakeController();
    const port = createSessionCommandPort(
      baseDeps({ askResolver: resolver, memory: memory as never, controller }),
    );
    const outcome = await port.run('clear', 'full');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.category).toBe('always-ask:destructive');
    expect(requests[0]!.alwaysAsk).toBe(true);
    expect(clearAll).toHaveBeenCalledTimes(1);
    expect((controller as unknown as { clear: ReturnType<typeof vi.fn> }).clear).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/3 fato/);
  });

  it('memória com fatos + usuário NEGA ⇒ NADA executa (fail-closed)', async () => {
    const { resolver, requests } = fakeAskResolver(['deny']);
    const clearAll = vi.fn(async () => 3);
    const memory = { list: vi.fn(async () => [{ id: '1' }]), clearAll } as unknown;
    const controller = fakeController();
    const port = createSessionCommandPort(
      baseDeps({ askResolver: resolver, memory: memory as never, controller }),
    );
    const outcome = await port.run('clear', 'full');
    expect(requests).toHaveLength(1);
    expect(clearAll).not.toHaveBeenCalled();
    expect((controller as unknown as { clear: ReturnType<typeof vi.fn> }).clear).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/NEGADO|sem confirmação/i);
  });

  it('--yolo/--unsafe NÃO relaxa a confirmação destrutiva (decisão do dono, ADR-0147)', async () => {
    const { resolver, requests } = fakeAskResolver(['deny']);
    const memory = { list: vi.fn(async () => [{ id: '1' }]), clearAll: vi.fn(async () => 1) } as unknown;
    const unsafeEngine = new PolicyPermissionEngine({ unsafe: true });
    const port = createSessionCommandPort(
      baseDeps({ askResolver: resolver, memory: memory as never, engine: unsafeEngine }),
    );
    const outcome = await port.run('clear', 'full');
    // mesmo sob --yolo, a catraca AINDA pergunta (o teste do engine.ts já prova o
    // porquê); aqui provamos que a PORTA não contorna isso na prática.
    expect(requests).toHaveLength(1);
    expect(outcome.ok).toBe(false);
  });

  it('memória VAZIA ⇒ não pede confirmação (nada a apagar)', async () => {
    const { resolver, requests } = fakeAskResolver();
    const memory = { list: vi.fn(async () => []), clearAll: vi.fn(async () => 0) } as unknown;
    const port = createSessionCommandPort(baseDeps({ askResolver: resolver, memory: memory as never }));
    const outcome = await port.run('clear', 'full');
    expect(requests).toHaveLength(0);
    expect(outcome.ok).toBe(true);
  });
});

describe('ADR-0147 (3) — human-only nega SEM tocar a catraca/controller', () => {
  it('/theme é recusado com mensagem honesta, sem chamar askResolver nem mutar o controller', async () => {
    const { resolver, requests } = fakeAskResolver();
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ askResolver: resolver, controller }));
    const outcome = await port.run('theme', 'dark');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/terminal do humano|recomende/i);
    expect(requests).toHaveLength(0);
    expect((controller as unknown as { pushNote: ReturnType<typeof vi.fn> }).pushNote).not.toHaveBeenCalled();
  });

  it('/quit e /logout(login humano)/split/fullscreen também negam', async () => {
    const port = createSessionCommandPort(baseDeps());
    for (const name of ['quit', 'split', 'fullscreen', 'subagent', 'back', 'login', 'add-dir']) {
      const outcome = await port.run(name, '');
      expect(outcome.ok, `esperava deny para /${name}`).toBe(false);
    }
  });
});

describe('ADR-0147 (4) — comando NÃO-classificado (não-nativo) nega, fail-closed', () => {
  it('nome inexistente no registro ⇒ deny honesto', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('frobnicate-o-universo', '');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/desconhecido|não-classificado/i);
  });
});

describe('ADR-0147 (5) — /cycle via a porta INICIA o ciclo (Q-4)', () => {
  it('args com intervalo+tarefa ⇒ controller.cycle(args) é chamado, e o resultado reporta o desfecho', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('cycle', '30s "revisar os testes"');
    const cycleFn = (controller as unknown as { cycle: ReturnType<typeof vi.fn> }).cycle;
    expect(cycleFn).toHaveBeenCalledWith('30s "revisar os testes"');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/concluído/);
  });

  it('sem teto (refused: no-ceiling) ⇒ ok:false com o motivo exato', async () => {
    const controller = fakeController({
      cycle: vi.fn(async () => ({ started: false, refused: 'no-ceiling', message: 'sem teto' })),
    });
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('cycle', 'blah');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('no-ceiling');
  });

  it('/cycle status é read-only (subcommandEffects) e NÃO chama controller.cycle (só cycleStatus)', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    await port.run('cycle', 'status');
    const cycleFn = (controller as unknown as { cycle: ReturnType<typeof vi.fn> }).cycle;
    const statusFn = (controller as unknown as { cycleStatus: ReturnType<typeof vi.fn> }).cycleStatus;
    expect(cycleFn).not.toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledTimes(1);
  });
});
