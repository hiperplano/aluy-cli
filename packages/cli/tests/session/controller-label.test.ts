// EST-0972 (rename) — o controller espelha o RÓTULO + COR em meta.label/labelColor
// (p/ o composer/StatusBar re-renderizarem o ●+nome) e os LIMPA juntos no clear.
//
// DoD:
//   - setLabel(nome, cor) ⇒ meta.label + meta.labelColor + getters refletem;
//   - setLabel(undefined) ⇒ LIMPA ambos (volta ao default sem rótulo);
//   - rótulo é DADO DE UI — coexiste com tier/model sem colidir.

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

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

function build(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('SessionController — setLabel (EST-0972 rename)', () => {
  it('arranca SEM rótulo', () => {
    const c = build();
    expect(c.label).toBeUndefined();
    expect(c.labelColor).toBeUndefined();
    expect(c.current.meta.label).toBeUndefined();
  });

  it('setLabel(nome, cor) ⇒ espelha em meta.label/labelColor + getters', () => {
    const c = build();
    c.setLabel('projeto-x', 'azul');
    expect(c.label).toBe('projeto-x');
    expect(c.labelColor).toBe('azul');
    expect(c.current.meta.label).toBe('projeto-x');
    expect(c.current.meta.labelColor).toBe('azul');
  });

  it('setLabel(undefined) ⇒ LIMPA o rótulo E a cor (volta ao default)', () => {
    const c = build();
    c.setLabel('projeto-x', 'azul');
    c.setLabel(undefined);
    expect(c.label).toBeUndefined();
    expect(c.labelColor).toBeUndefined();
    // os campos somem do meta (não ficam fantasma).
    expect('label' in c.current.meta).toBe(false);
    expect('labelColor' in c.current.meta).toBe(false);
  });

  it('setLabel("  ") (vazio) ⇒ tratado como SEM rótulo', () => {
    const c = build();
    c.setLabel('proj', 'verde');
    c.setLabel('   ');
    expect(c.label).toBeUndefined();
  });

  it('o rótulo NÃO mexe no tier/model (naturezas distintas)', () => {
    const c = build();
    c.setLabel('proj', 'teal');
    expect(c.tier).toBe('aluy-flux');
    expect(c.model).toBeUndefined();
  });
});
