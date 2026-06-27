// EST-0982 — SessionController ESPELHA o sessionCwd no StatusBar (meta.cwd).
//
// Prova que, ao o agente rodar `change_dir` (via tool-call do modelo), o controller
// re-espelha o cwd corrente da porta de cwd em `meta.cwd` (abreviado) — pro usuário
// VER onde está no rodapé. Sem modelo real: o `ModelCaller` é roteirizado p/ emitir
// um bloco de tool-call `change_dir` no 1º turno e texto final no 2º.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type CwdPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

const noFs: FileSystemPort = {
  async readFile() {
    return '';
  },
  async writeFile() {},
  async exists() {
    return false;
  },
};
const noShell: ShellPort = {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};
const noSearch: SearchPort = {
  async search() {
    return { matches: [], truncated: {} };
  },
};

/** CwdPort fake com clamp por prefixo (root = /home/u/projects/x). */
class FakeCwd implements CwdPort {
  readonly root = '/home/u/projects/x';
  private session = '/home/u/projects/x';
  private readonly dirs = new Set(['/home/u/projects/x', '/home/u/projects/x/ecommerce-app']);
  get cwd(): string {
    return this.session;
  }
  setCwd(requested: string): string {
    const base = requested.startsWith('/') ? requested : `${this.session}/${requested}`;
    const parts: string[] = [];
    for (const seg of base.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    let resolved = '/' + parts.join('/');
    if (resolved !== this.root && !resolved.startsWith(this.root + '/')) resolved = this.root;
    if (!this.dirs.has(resolved)) throw new Error(`inexistente: ${requested}`);
    this.session = resolved;
    return resolved;
  }
}

/** Modelo roteirizado pelo turno (sufixo `:N` da idempotency-key). */
function scriptedModel(turnScript: (turn: number) => string): ModelCaller {
  return {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const turn = Number(key.slice(key.lastIndexOf(':') + 1));
      return {
        request_id: 'r',
        content: turnScript(Number.isFinite(turn) ? turn : 0),
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
      };
    },
  };
}

describe('EST-0982 · controller — StatusBar reflete o sessionCwd', () => {
  it('change_dir do agente atualiza meta.cwd (abreviado) no estado', async () => {
    const cwd = new FakeCwd();
    const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch, cwd };
    const controller = new SessionController({
      model: scriptedModel((turn) =>
        turn === 0 ? toolCall('change_dir', { path: 'ecommerce-app' }) : 'pronto.',
      ),
      // change_dir é leitura pura ⇒ allow por default; HOME p/ a abreviação do cwd.
      permission: new PolicyPermissionEngine({}),
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' as const };
        },
      },
      meta: { cwd: '/home/u/projects/x', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });

    // antes: o StatusBar mostra a raiz (abreviada por HOME, se aplicável).
    const before = controller.current.meta.cwd;
    expect(before.endsWith('/projects/x')).toBe(true);

    await controller.submit('crie um e-commerce na subpasta');

    // depois do change_dir, o meta.cwd reflete a subpasta.
    expect(cwd.cwd).toBe('/home/u/projects/x/ecommerce-app');
    expect(controller.current.meta.cwd.endsWith('/projects/x/ecommerce-app')).toBe(true);
  });

  it('sem porta de cwd, meta.cwd não muda (não-regressão)', async () => {
    const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch };
    const controller = new SessionController({
      model: scriptedModel(() => 'pronto.'),
      permission: new PolicyPermissionEngine({}),
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' as const };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    await controller.submit('oi');
    expect(controller.current.meta.cwd).toBe('/proj');
  });
});
