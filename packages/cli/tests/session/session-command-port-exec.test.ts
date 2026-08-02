// ADR-0147 — cobertura das rotas `execute()` da `SessionCommandPort` que o suite
// original (`session-command-port.test.ts`) NÃO exercita: cada comando
// `read-only`/`session-effect` tem seu PRÓPRIO `exec*` (todo/provider/effort/model/
// rename/whoami/agents/skills/workflows/inventory/rooms/ask/memory/compact/cron) —
// o switch de `execute()` (session/session-command-port.ts) roteia por `found.id`, e
// sem teste direto cada branch fica invisível ao gate de cobertura.
//
// `homedir()` é MOCKADO p/ um tmpdir isolado (mesmo padrão de `tests/commands/cron.test.ts`):
// `execSkills`/`execWorkflows` (bare) e `execCron` tocam `~/.aluy/...` de verdade
// (skills/workflows loaders, jobs.json do cron) — sem o mock, os testes leriam/
// escreveriam na HOME REAL da máquina (não-determinístico, e no caso do cron,
// `execFileSync`/`execSync` do node:child_process poderiam mexer no crontab real do
// usuário). `node:child_process` também é mockado, pela mesma razão de segurança.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

const { testHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { testHome: fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-scp-exec-test-')) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: execFileSyncMock, execSync: execSyncMock };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => testHome };
});

import {
  PolicyPermissionEngine,
  type AskResolver,
  type LoginService,
  type ToolPorts,
  type TodoItem,
  type TodoStorePort,
} from '@hiperplano/aluy-cli-core';
import {
  createSessionCommandPort,
  type SessionCommandPortDeps,
} from '../../src/session/session-command-port.js';
import type { SessionController } from '../../src/session/controller.js';

void testHome; // usado só pelo mock acima (referência p/ o linter não acusar não-uso).

const noopResolver: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' };
  },
};

function fakePorts(todo?: TodoStorePort): ToolPorts {
  return {
    fs: { readFile: vi.fn(), writeFile: vi.fn(), exists: vi.fn() },
    shell: { exec: vi.fn() },
    search: { search: vi.fn() },
    ...(todo ? { todo } : {}),
  } as unknown as ToolPorts;
}

/** Controller fake: expõe os métodos que os `exec*` sob teste tocam, como spies. */
function fakeController(overrides: Record<string, unknown> = {}): SessionController {
  const blocks: unknown[] = [];
  return {
    get current() {
      return { blocks };
    },
    get usage() {
      return { tokens: 1, windowPct: 1, tier: 'strata' };
    },
    pushNote: vi.fn((title: string, lines: string[]) => {
      blocks.push({ kind: 'note', title, lines });
    }),
    setProvider: vi.fn(),
    setEffort: vi.fn(),
    setLabel: vi.fn(),
    label: undefined,
    labelColor: undefined,
    compact: vi.fn(async () => undefined),
    workflowRun: vi.fn(async () => undefined),
    workflowsUse: vi.fn(async () => undefined),
    roomList: vi.fn(async () => undefined),
    roomNew: vi.fn(async () => undefined),
    roomRead: vi.fn(async () => undefined),
    roomWatch: vi.fn(async () => undefined),
    askParallel: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SessionController;
}

function baseDeps(over: Partial<SessionCommandPortDeps> = {}): SessionCommandPortDeps {
  return {
    controller: fakeController(),
    engine: new PolicyPermissionEngine(),
    askResolver: noopResolver,
    ports: fakePorts(),
    ...over,
  };
}

function fakeTodoStore(items: TodoItem[] = []): TodoStorePort {
  return {
    add: vi.fn(async (text: string) => {
      const id = String(items.length + 1);
      items.push({ id, text, createdAt: Date.now(), done: false });
      return id;
    }),
    list: vi.fn(async () => items),
    done: vi.fn(async (id: string) => {
      const it = items.find((i) => i.id === id);
      if (!it) return false;
      (it as { done: boolean }).done = true;
      return true;
    }),
    clearDone: vi.fn(async () => {
      const n = items.filter((i) => i.done).length;
      for (let i = items.length - 1; i >= 0; i -= 1) if (items[i]!.done) items.splice(i, 1);
      return n;
    }),
  };
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();
});

// ── /todo ──────────────────────────────────────────────────────────────────

describe('execTodo (session/session-command-port.ts)', () => {
  it('ports.todo ausente ⇒ unavailable (ok:false, honesto)', async () => {
    const port = createSessionCommandPort(baseDeps({ ports: fakePorts() }));
    const outcome = await port.run('todo', '');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/NÃO foi executado/i);
  });

  it('/todo (list) com backlog vazio ⇒ ok:true, nota "backlog vazio"', async () => {
    const store = fakeTodoStore();
    const port = createSessionCommandPort(baseDeps({ ports: fakePorts(store) }));
    const outcome = await port.run('todo', '');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/backlog vazio/);
  });

  it('/todo done <id> marca concluído via a store injetada', async () => {
    const store = fakeTodoStore([{ id: '1', text: 'comprar leite', createdAt: 1, done: false }]);
    const port = createSessionCommandPort(baseDeps({ ports: fakePorts(store) }));
    const outcome = await port.run('todo', 'done 1');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/concluído/);
    expect(await store.list()).toEqual([{ id: '1', text: 'comprar leite', createdAt: 1, done: true }]);
  });
});

// ── /provider ─────────────────────────────────────────────────────────────

describe('execProvider (session/session-command-port.ts)', () => {
  it('bare ⇒ abre o picker (kind "provider", não "note") — fallback devolve ok:false honesto', async () => {
    // buildSlashEffect('provider', …) sempre devolve kind:'provider' (efeito de UI
    // interativa), nunca 'note' — fromSlashEffectFallback só sabe converter 'note' em
    // ok:true; qualquer outro kind cai no default "ainda não tem execução completa".
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('provider', '');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/ainda não tem execução completa/);
  });

  it('/provider deepseek ⇒ controller.setProvider("deepseek"), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('provider', 'deepseek');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('deepseek');
    expect(
      (controller as unknown as { setProvider: ReturnType<typeof vi.fn> }).setProvider,
    ).toHaveBeenCalledWith('deepseek');
  });
});

// ── /effort ───────────────────────────────────────────────────────────────

describe('execEffort (session/session-command-port.ts)', () => {
  it('bare ⇒ fallback read-only (mostra valor atual), ok:true', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('effort', '');
    expect(outcome.ok).toBe(true);
  });

  it('/effort high ⇒ controller.setEffort("high"), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('effort', 'high');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { setEffort: ReturnType<typeof vi.fn> }).setEffort,
    ).toHaveBeenCalledWith('high');
  });

  it('valor > 32 chars ⇒ ok:false, erro de tamanho (sem chamar setEffort)', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const tooLong = 'x'.repeat(33);
    const outcome = await port.run('effort', tooLong);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/32 caracteres/);
    expect(
      (controller as unknown as { setEffort: ReturnType<typeof vi.fn> }).setEffort,
    ).not.toHaveBeenCalled();
  });
});

// ── /model ────────────────────────────────────────────────────────────────

describe('execModel (session/session-command-port.ts)', () => {
  it('bare ⇒ fallback read-only (tier atual), ok:true', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('model', '');
    expect(outcome.ok).toBe(true);
  });

  it('/model strata ⇒ ainda NÃO implementado via agente, ok:false honesto (tier NÃO trocou)', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('model', 'strata');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/NÃO foi trocado/);
  });
});

// ── /rename ───────────────────────────────────────────────────────────────

describe('execRename (session/session-command-port.ts)', () => {
  it('/rename foo ⇒ controller.setLabel(foo,cor), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rename', 'foo');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/sessão renomeada: foo/);
    expect(
      (controller as unknown as { setLabel: ReturnType<typeof vi.fn> }).setLabel,
    ).toHaveBeenCalledWith('foo', expect.any(String));
  });

  it('/rename --limpar ⇒ controller.setLabel(undefined), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rename', '--limpar');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/rótulo removido/);
    expect(
      (controller as unknown as { setLabel: ReturnType<typeof vi.fn> }).setLabel,
    ).toHaveBeenCalledWith(undefined);
  });

  it('/rename (bare, sem rótulo) ⇒ show, ok:true, "sem rótulo"', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('rename', '');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/não tem rótulo/);
  });

  it('/rename foo --cor cor-inexistente ⇒ NÃO aborta: aplica o nome com cor automática (F176), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rename', 'foo --cor cor-que-nao-existe-no-ds');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/renomeada: foo/);
    expect(
      (controller as unknown as { setLabel: ReturnType<typeof vi.fn> }).setLabel,
    ).toHaveBeenCalledWith('foo', expect.any(String));
  });

  it('/rename --cor azul (sem nome) ⇒ error, ok:false ("a cor identifica um nome")', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('rename', '--cor azul');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/identifica um nome/);
  });
});

// ── /whoami ───────────────────────────────────────────────────────────────

describe('execWhoami (session/session-command-port.ts)', () => {
  it('deps.login ausente ⇒ unavailable, ok:false', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('whoami', '');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/NÃO foi executado/i);
  });

  it('deps.login presente ⇒ runAsyncSlash("whoami", …), ok:true com dado da credencial', async () => {
    const login = {
      whoami: vi.fn(async () => ({
        user: 'tiago',
        organization_id: 'org-1',
        scopes: ['read'],
        kind: 'pat' as const,
        token_hint: 'abcd…',
      })),
      logout: vi.fn(async () => ({ revoked: true })),
    } as unknown as LoginService;
    const port = createSessionCommandPort(baseDeps({ login }));
    const outcome = await port.run('whoami', '');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('org-1');
  });
});

// ── /agents, /skills, /workflows, /inventory ────────────────────────────────

describe('execAgents / execInventory (session/session-command-port.ts)', () => {
  it('agentRegistry ausente ⇒ lista vazia, ok:true', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outAgents = await port.run('agents', '');
    expect(outAgents.ok).toBe(true);
    const outInv = await port.run('inventory', '');
    expect(outInv.ok).toBe(true);
    expect(outInv.text).toMatch(/agentes \(0\)/);
  });

  it('agentRegistry com perfis ⇒ /inventory lista os nomes', async () => {
    const agentRegistry = { list: () => [{ name: 'revisor' }, { name: 'redator' }] } as never;
    const port = createSessionCommandPort(baseDeps({ agentRegistry }));
    const outcome = await port.run('inventory', '');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('revisor');
    expect(outcome.text).toContain('redator');
  });
});

describe('execSkills (session/session-command-port.ts)', () => {
  it('sem workspace ⇒ só carrega o global (tmpdir vazio), ok:true', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('skills', '');
    expect(outcome.ok).toBe(true);
  });
});

describe('execWorkflows (session/session-command-port.ts)', () => {
  it('/workflows run <nome> ⇒ controller.workflowRun("<nome>"), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('workflows', 'run revisao');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { workflowRun: ReturnType<typeof vi.fn> }).workflowRun,
    ).toHaveBeenCalledWith('revisao');
  });

  it('/workflows use <nome> ⇒ controller.workflowsUse("<nome>"), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('workflows', 'use revisao');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { workflowsUse: ReturnType<typeof vi.fn> }).workflowsUse,
    ).toHaveBeenCalledWith('revisao');
  });

  it('/workflows (bare) ⇒ lista (tmpdir vazio), ok:true', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('workflows', '');
    expect(outcome.ok).toBe(true);
  });
});

// ── /rooms ────────────────────────────────────────────────────────────────

describe('execRooms (session/session-command-port.ts)', () => {
  it('bare/list ⇒ controller.roomList(), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rooms', '');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { roomList: ReturnType<typeof vi.fn> }).roomList,
    ).toHaveBeenCalledTimes(1);
  });

  it('new ⇒ controller.roomNew(), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rooms', 'new');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { roomNew: ReturnType<typeof vi.fn> }).roomNew,
    ).toHaveBeenCalledTimes(1);
  });

  it('read <código> ⇒ controller.roomRead(código), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rooms', 'read ABC123');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { roomRead: ReturnType<typeof vi.fn> }).roomRead,
    ).toHaveBeenCalledWith('ABC123');
  });

  it('read sem código ⇒ ok:false, "código ausente"', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('rooms', 'read');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/código ausente/);
  });

  it('watch <código> ⇒ controller.roomWatch(código), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('rooms', 'watch XYZ');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { roomWatch: ReturnType<typeof vi.fn> }).roomWatch,
    ).toHaveBeenCalledWith('XYZ');
  });

  it('subcomando desconhecido ⇒ ok:false', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('rooms', 'teleport');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/subcomando desconhecido/);
  });
});

// ── /ask ──────────────────────────────────────────────────────────────────

describe('execAsk (session/session-command-port.ts)', () => {
  it('pergunta vazia ⇒ ok:false, uso', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('ask', '  ');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/pergunta ausente/);
  });

  it('pergunta não-vazia ⇒ controller.askParallel(pergunta), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('ask', 'qual a capital da Bahia?');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { askParallel: ReturnType<typeof vi.fn> }).askParallel,
    ).toHaveBeenCalledWith('qual a capital da Bahia?');
  });
});

// ── /compact ──────────────────────────────────────────────────────────────

describe('execCompact (session/session-command-port.ts)', () => {
  it('chama controller.compact(signal), ok:true', async () => {
    const controller = fakeController();
    const port = createSessionCommandPort(baseDeps({ controller }));
    const outcome = await port.run('compact', '');
    expect(outcome.ok).toBe(true);
    expect(
      (controller as unknown as { compact: ReturnType<typeof vi.fn> }).compact,
    ).toHaveBeenCalledTimes(1);
  });
});

// ── /memory (não-forget: list/edit/pin/unpin) ───────────────────────────────

describe('execMemory (session/session-command-port.ts)', () => {
  it('deps.memory ausente ⇒ unavailable, ok:false', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('memory', '');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/NÃO foi executado/i);
  });

  it('/memory (list, sem fatos) ⇒ ok:true', async () => {
    const memory = { list: vi.fn(async () => []) } as unknown;
    const port = createSessionCommandPort(baseDeps({ memory: memory as never }));
    const outcome = await port.run('memory', '');
    expect(outcome.ok).toBe(true);
  });
});

// ── /cron (execCron: session-effect/read-only — 'list'/'add'; 'rm' é destructive) ──

describe('execCron (session/session-command-port.ts) — jobs.json isolado em tmpdir', () => {
  it('/cron (bare, sem jobs) ⇒ lista vazia via runCron, ok:true', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('cron', '');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/Nenhum job agendado/);
  });

  it('/cron add "0 9 * * 1-5" "revisar PRs" ⇒ grava o job (jobs.json no tmpdir mockado)', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('cron', 'add "0 9 * * 1-5" "revisar PRs"');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/adicionado/);
    // syncCrontab (Linux) chamou os mocks do node:child_process — NUNCA o real.
    expect(execFileSyncMock.mock.calls.length + execSyncMock.mock.calls.length).toBeGreaterThan(0);
    // e o job aparece agora no /cron list subsequente.
    const list = await port.run('cron', 'list');
    expect(list.text).toMatch(/revisar PRs/);
  });
});

describe('runDestructiveCronRm via a porta (session/session-command-port.ts)', () => {
  it('sem id ⇒ ok:false, uso (sem pedir confirmação)', async () => {
    const port = createSessionCommandPort(baseDeps());
    const outcome = await port.run('cron', 'rm');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/id ausente/);
  });

  it('com id, aprovado ⇒ RE-PASSA decide() (always-ask), remove o job', async () => {
    // cria o job primeiro (mesmo caminho do teste acima).
    const port = createSessionCommandPort(baseDeps());
    await port.run('cron', 'add "0 9 * * 1-5" "revisar PRs 2"');
    const listBefore = await port.run('cron', 'list');
    const idMatch = /^\s*([0-9a-f]{8})\s/m.exec(listBefore.text);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;
    const outcome = await port.run('cron', `rm ${id}`);
    expect(outcome.ok).toBe(true);
  });
});
