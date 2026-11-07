// ADR 0005 — os SINKS que escrevem em disco redigem o valor exato do cofre mesmo que ele
// já esteja no conteúdo (ex.: o dono colou o valor no chat ANTES de cadastrar o segredo).

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretVault } from '@hiperplano/aluy-cli-core';
import { SessionStore, NodeJournalStore } from '../../src/io/index.js';
import { PausaStore } from '../../src/io/pausa-store.js';
import { appendFatalLog } from '../../src/bin/fatal-log.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aluy-sinks-'));
  secretVault.set('API_KEY', CANARY);
});
afterEach(() => {
  secretVault.clear();
  rmSync(dir, { recursive: true, force: true });
});

function tudo(root: string): string {
  let s = '';
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    s += e.isDirectory() ? tudo(p) : readFileSync(p, 'utf8');
  }
  return s;
}

describe('sinks de disco', () => {
  it('registro de sessão: texto do chat com o valor vai redigido (cru e escapado)', () => {
    const store = new SessionStore({ baseDir: dir });
    store.save({
      id: 's1',
      cwd: '/p',
      tier: 'aluy-flux',
      blocks: [
        { kind: 'you', text: `minha chave: ${CANARY}` },
        { kind: 'aluy', text: `anotei "${CANARY}"` },
      ],
    } as never);
    const arquivo = tudo(store.sessionsDir);
    expect(arquivo).not.toContain(CANARY);
    expect(arquivo).toContain('‹redigido›');
    // continua um JSON válido e retomável
    expect(store.load('s1')?.blocks).toHaveLength(2);
  });

  it('journal: a linha do stack com o valor vai redigida', async () => {
    const j = new NodeJournalStore({ sessionId: 's1', baseDir: dir });
    await j.appendEntry({
      kind: 'barrier',
      seq: 0,
      ts: 1,
      tool: 'run_command',
      targets: [],
      command: `echo ${CANARY}`,
    } as never);
    expect(tudo(join(dir, 'undo'))).not.toContain(CANARY);
  });

  it('log de crash redige o valor', () => {
    appendFatalLog('uncaught', new Error(`falhou com ${CANARY}`), { dir });
    expect(tudo(dir)).not.toContain(CANARY);
  });

  it('pausas: o histórico guardado vai redigido', () => {
    const store = new PausaStore({ baseDir: dir });
    store.save({
      sessionId: 's1',
      scope: 'janela',
      reason: 'cota',
      agents: [
        {
          label: 'principal',
          kind: 'principal',
          history: [{ role: 'goal', text: `use ${CANARY}` }],
        },
      ],
    } as never);
    expect(tudo(join(dir, 'pausas'))).not.toContain(CANARY);
  });
});
