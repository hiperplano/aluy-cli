// F14 — retomada: contadores de uso voltam (persistidos) e notas efêmeras não reaparecem.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';
import { SessionStore } from '../../src/io/session-store.js';
import { SessionController } from '../../src/session/controller.js';
import type { SessionBlock } from '../../src/session/model.js';

const conversa: SessionBlock[] = [
  { kind: 'you', text: 'olá, tudo bem?' },
  { kind: 'aluy', text: 'tudo certo por aqui', streaming: false },
  { kind: 'note', title: 'comando desconhecido', lines: ['/xyz'] },
];

function novo(): SessionController {
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    },
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: {} as never,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('F14 — persistência e restauração do uso', () => {
  let base: string;
  let store: SessionStore;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-sess-usage-'));
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => 1000 });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('usage faz round-trip no record', () => {
    store.save({
      id: 's1',
      cwd: '/p',
      tier: 't',
      usage: { tokens: 37_600, windowPct: 4 },
      blocks: conversa,
    });
    expect(store.load('s1')!.usage).toEqual({ tokens: 37_600, windowPct: 4 });
  });

  it('usage inválido/ausente é descartado (record antigo continua válido)', () => {
    store.save({ id: 's2', cwd: '/p', tier: 't', blocks: conversa });
    expect(store.load('s2')!.usage).toBeUndefined();
  });

  it('restoreUsage com usage persistido restaura tokens e janela', () => {
    const c = novo();
    c.restoreUsage({ tokens: 37_600, windowPct: 4 }, conversa);
    expect(c.current.meta.tokens).toBe(37_600);
    expect(c.current.meta.windowPct).toBe(4);
    c.dispose();
  });

  it('record antigo (sem usage) estima os tokens pelo texto da conversa', () => {
    const c = novo();
    c.restoreUsage(undefined, conversa);
    expect(c.current.meta.tokens).toBeGreaterThan(0);
    c.dispose();
  });

  it('restoreBlocks NÃO reexibe notas efêmeras', () => {
    const c = novo();
    c.restoreBlocks(conversa);
    const kinds = c.current.blocks.map((b) => b.kind);
    expect(kinds).toContain('you');
    expect(kinds).toContain('aluy');
    expect(kinds).not.toContain('note');
    c.dispose();
  });
});
