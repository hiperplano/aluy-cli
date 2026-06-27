// EST-1158 — os comandos de lifecycle do /cycle no controller (pause/resume/edit).
// Aqui cobrimos o path SEM ciclo ativo (nota de aviso, sem crash); a delegação ao
// engine ativo é coberta pelos testes determinísticos do CycleEngine + a suíte de
// session que exercita o cycle().

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

function loopModel(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' };
    },
  };
}

function makeController(): SessionController {
  return new SessionController({
    model: loopModel(),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
  });
}

describe('EST-1158 — /cycle pause/resume/edit no controller', () => {
  function cycleNotes(c: SessionController): { title: string; lines: readonly string[] }[] {
    return c.current.blocks.filter(
      (b): b is { kind: 'note'; title: string; lines: readonly string[] } =>
        b.kind === 'note' && b.title === '/cycle',
    );
  }

  it('SEM ciclo ativo ⇒ cada comando empurra a nota "nenhum /cycle ativo" (sem crash)', () => {
    const c = makeController();
    c.cyclePause();
    c.cycleResume();
    c.cycleEdit({ task: 'nova tarefa' });
    const notes = cycleNotes(c);
    expect(notes).toHaveLength(3);
    expect(JSON.stringify(notes)).toContain('nenhum /cycle');
  });
});
