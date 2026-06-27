// EST-1015 (#fullscreen) — `replaceNote` COALESCE notas de mesmo título: o `/fullscreen`
// toggle deixava N notas `cockpit` (entrou/saiu/estreito) empilhadas no scrollback a cada
// alternância. `replaceNote` mantém só a ÚLTIMA; notas de outro título ficam intactas.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';

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
  async grep() {
    return [];
  },
};

function makeController(): SessionController {
  const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch };
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' as const };
      },
    },
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
}

const cockpitNotes = (c: SessionController) =>
  c.current.blocks.filter((b) => b.kind === 'note' && b.title === 'cockpit');

describe('SessionController.replaceNote — coalesce por título (#fullscreen)', () => {
  it('N alternâncias de cockpit ⇒ só UMA nota cockpit (não empilha)', () => {
    const c = makeController();
    c.replaceNote('cockpit', ['entrou']);
    c.replaceNote('cockpit', ['saiu']);
    c.replaceNote('cockpit', ['entrou de novo']);
    const notes = cockpitNotes(c);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.kind === 'note' && notes[0]!.lines).toEqual(['entrou de novo']);
  });

  it('preserva notas de OUTRO título (só coalesce o mesmo)', () => {
    const c = makeController();
    c.pushNote('export', ['arquivo salvo']);
    c.replaceNote('cockpit', ['entrou']);
    c.replaceNote('cockpit', ['saiu']);
    expect(cockpitNotes(c)).toHaveLength(1);
    expect(c.current.blocks.filter((b) => b.kind === 'note' && b.title === 'export')).toHaveLength(
      1,
    );
  });

  it('pushNote (não-coalescente) ainda EMPILHA — contraste', () => {
    const c = makeController();
    c.pushNote('cockpit', ['a']);
    c.pushNote('cockpit', ['b']);
    expect(cockpitNotes(c)).toHaveLength(2); // pushNote acumula (comportamento legado)
  });
});
