// ADR aluy-cli 0002 — conversa pai ⇄ filho no controller real.
//
//  · agent_send do PAI alcança um filho DESACOPLADO (wait:false) ainda vivo, rotulado;
//  · a mensagem aparece em PT-BR na região viva (nota "agentes") e no nó da árvore;
//  · o que o filho manda de volta (ask_parent) entra no pai como OBSERVAÇÃO (dado);
//  · "lembrar esta decisão" persiste via onRememberTool (e o diálogo só oferece o permitido).
//
// FRUGAL: ModelCaller MOCK, nenhuma chamada real.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SPAWN_AGENT_TOOL_NAME,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { NoteBlock } from '../../src/session/model.js';

const toolCall = (name: string, input: Record<string, unknown>): string =>
  `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name, input })}\nALUY_TOOL_CALL>>>`;

function fakePorts(): ToolPorts {
  return {
    fs: {
      async readFile() {
        return 'x';
      },
      async writeFile() {},
      async exists() {
        return true;
      },
    },
    shell: {
      async exec() {
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  } as ToolPorts;
}

async function waitFor(cond: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const reply = (content: string): ModelCallResult => ({
  request_id: 'r',
  content,
  finish_reason: 'stop',
  usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
});

const sessionOf = (key: string): string =>
  key.lastIndexOf(':') > 0 ? key.slice(0, key.lastIndexOf(':')) : key;

const meta = { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 };

function notes(c: SessionController): string {
  return c.current.blocks
    .filter((b): b is NoteBlock => b.kind === 'note')
    .map((b) => b.lines.join(' '))
    .join('\n');
}

describe('ADR 0002 · agent_send no controller', () => {
  it('o pai despacha (wait:false), manda uma mensagem ao filho vivo e ela chega rotulada', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const childSeen: string[] = [];
    const childCounts = new Map<string, number>();
    const childModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const s = sessionOf(args.idempotencyKey);
        const n = childCounts.get(s) ?? 0;
        childCounts.set(s, n + 1);
        if (n === 0) {
          await gate; // o filho fica VIVO até o pai conversar com ele
          return reply(toolCall('read_file', { path: 'a.txt' }));
        }
        childSeen.push(args.messages.map((m) => String(m.content)).join('\n'));
        return reply('relatório do filho.');
      },
    };
    const parentSeen: string[] = [];
    const parentCounts = new Map<string, number>();
    const parentModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const s = sessionOf(args.idempotencyKey);
        const n = parentCounts.get(s) ?? 0;
        parentCounts.set(s, n + 1);
        parentSeen.push(args.messages.map((m) => String(m.content)).join('\n'));
        if (n === 0) {
          return reply(
            toolCall(SPAWN_AGENT_TOOL_NAME, {
              agents: [{ label: 'f1', goal: 'investigue' }],
              wait: false,
            }),
          );
        }
        if (n === 1)
          return reply(toolCall('agent_send', { to: 'f1', message: 'foque em src/auth' }));
        return reply('orientei o f1.');
      },
    };
    const controller = new SessionController({
      model: parentModel,
      subAgentModel: childModel,
      permission: new PolicyPermissionEngine(), // spawn_agent/agent_send: allow por padrão
      ports: fakePorts(),
      askResolver: {
        async resolve() {
          return { kind: 'deny' as const };
        },
      },
      meta,
      subAgents: { enabled: true, maxConcurrency: 1 },
    });

    const turno = controller.submit('delegue e oriente');
    await waitFor(() => parentSeen.some((m) => m.includes('mensagem entregue a "f1"')));
    release();
    await turno;
    await waitFor(() => childSeen.length > 0);

    expect(childSeen[0]).toContain('[do orquestrador] foque em src/auth');
    expect(notes(controller)).toContain('do orquestrador → f1: foque em src/auth');
  });

  it('agent_send para filho inexistente devolve erro claro ao modelo', async () => {
    const parentSeen: string[] = [];
    let n = 0;
    const parentModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        parentSeen.push(args.messages.map((m) => String(m.content)).join('\n'));
        return reply(n++ === 0 ? toolCall('agent_send', { to: 'fantasma', message: 'oi' }) : 'ok.');
      },
    };
    const controller = new SessionController({
      model: parentModel,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: {
        async resolve() {
          return { kind: 'deny' as const };
        },
      },
      meta,
      subAgents: { enabled: true, maxConcurrency: 1 },
    });
    await controller.submit('fale com o fantasma');
    expect(parentSeen.join('\n')).toContain('não está rodando');
    expect(parentSeen.join('\n')).toContain('spawne um novo');
  });
});

describe('ADR 0002 · filho → pai (ask_parent) chega como DADO', () => {
  it('a pergunta do filho entra no pai como observação rotulada, e a TUI mostra a nota', async () => {
    const childCounts = new Map<string, number>();
    const childModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const s = sessionOf(args.idempotencyKey);
        const n = childCounts.get(s) ?? 0;
        childCounts.set(s, n + 1);
        return reply(
          n === 0
            ? toolCall('ask_parent', { message: 'uso a lib X ou Y?', kind: 'pergunta' })
            : 'terminei com X.',
        );
      },
    };
    const parentSeen: string[] = [];
    let n = 0;
    const parentModel: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        parentSeen.push(args.messages.map((m) => String(m.content)).join('\n'));
        return reply(
          n++ === 0
            ? toolCall(SPAWN_AGENT_TOOL_NAME, { agents: [{ label: 'f1', goal: 'x' }] })
            : 'ok.',
        );
      },
    };
    const controller = new SessionController({
      model: parentModel,
      subAgentModel: childModel,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: {
        async resolve() {
          return { kind: 'deny' as const };
        },
      },
      meta,
      subAgents: { enabled: true, maxConcurrency: 1 },
    });
    await controller.submit('delegue');
    await waitFor(() => parentSeen.some((m) => m.includes('sub-agente f1 → orquestrador')));
    const visto = parentSeen.find((m) => m.includes('sub-agente f1 → orquestrador')) ?? '';
    // envelopado como DADO não-confiável (nunca instrução)
    expect(visto).toMatch(/DADO_NAO_CONFIAVEL[\s\S]*uso a lib X ou Y\?[\s\S]*DADO_NAO_CONFIAVEL/);
    expect(notes(controller)).toContain('f1 → orquestrador (pergunta): uso a lib X ou Y?');
  });
});

describe('ADR 0002 · lembrar esta decisão', () => {
  it('approve-always persiste o nome da tool via onRememberTool (spawn_agent configurado em ask)', async () => {
    const remembered: string[] = [];
    const tui = new TuiAskResolver();
    let n = 0;
    const parentModel: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        return reply(
          n++ === 0
            ? toolCall(SPAWN_AGENT_TOOL_NAME, { agents: [{ label: 'f1', goal: 'x' }] })
            : 'ok.',
        );
      },
    };
    const childModel: ModelCaller = {
      async call() {
        return reply('feito.');
      },
    };
    const engine = new PolicyPermissionEngine({
      policy: { rules: [], defaults: { [SPAWN_AGENT_TOOL_NAME]: 'ask' } },
    });
    const controller = new SessionController({
      model: parentModel,
      subAgentModel: childModel,
      permission: engine,
      ports: fakePorts(),
      askResolver: tui,
      meta,
      subAgents: { enabled: true, maxConcurrency: 1 },
      onRememberTool: (t) => remembered.push(t),
    });
    const turno = controller.submit('delegue');
    await waitFor(() => controller.current.pendingAsk !== undefined);
    expect(controller.current.pendingAsk?.request.alwaysAsk).toBe(false);
    controller.resolveAsk({ kind: 'approve-always' });
    await turno;
    expect(remembered).toEqual([SPAWN_AGENT_TOOL_NAME]);
    // a engine passou a liberar sem perguntar
    expect(
      engine.decide({ name: SPAWN_AGENT_TOOL_NAME, input: { agents: [{ goal: 'y' }] } }).decision,
    ).toBe('allow');
  });
});
