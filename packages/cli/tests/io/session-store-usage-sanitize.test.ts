// Auditoria — sanitização do uso (tokens/janela) gravado no registro de sessão: o arquivo no
// disco pode vir adulterado/antigo; o que volta para a barra de uso da sessão retomada precisa
// ser inteiro, não-negativo e a janela ficar em 0–100.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';

let base: string;
let store: SessionStore;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-usage-san-'));
  store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => 1000 });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Salva com um uso "sujo" e devolve o que a LEITURA do disco entrega. */
function viaDisco(usage: unknown) {
  store.save({ id: 's', cwd: '/p', tier: 't', blocks: [], usage: usage as never });
  return store.load('s')?.usage;
}

describe('SessionStore · uso persistido', () => {
  it('janela acima de 100 é cortada em 100; abaixo de 0 em 0', () => {
    expect(viaDisco({ tokens: 10, windowPct: 250 })).toEqual({ tokens: 10, windowPct: 100 });
    expect(viaDisco({ tokens: 10, windowPct: -40 })).toEqual({ tokens: 10, windowPct: 0 });
  });

  it('arredonda tokens e janela para inteiros', () => {
    expect(viaDisco({ tokens: 1234.6, windowPct: 4.5 })).toEqual({ tokens: 1235, windowPct: 5 });
  });

  it('tokens negativos, ausentes ou inválidos descartam o uso inteiro', () => {
    expect(viaDisco({ tokens: -1, windowPct: 4 })).toBeUndefined();
    expect(viaDisco({ windowPct: 4 })).toBeUndefined();
    expect(viaDisco({ tokens: Number.NaN, windowPct: 4 })).toBeUndefined();
    expect(viaDisco('lixo')).toBeUndefined();
  });

  it('janela ausente/ inválida vira 0 (não inventa porcentagem), os tokens ficam', () => {
    expect(viaDisco({ tokens: 500 })).toEqual({ tokens: 500, windowPct: 0 });
    expect(viaDisco({ tokens: 500, windowPct: Number.NaN })).toEqual({ tokens: 500, windowPct: 0 });
  });

  it('também sanitiza o que JÁ está no arquivo (adulterado à mão)', () => {
    store.save({ id: 's2', cwd: '/p', tier: 't', blocks: [], usage: { tokens: 5, windowPct: 5 } });
    const caminho = store.pathFor('s2');
    const json = JSON.parse(readFileSync(caminho, 'utf8')) as Record<string, unknown>;
    json['usage'] = { tokens: 7, windowPct: 999 };
    writeFileSync(caminho, JSON.stringify(json));
    expect(store.load('s2')?.usage).toEqual({ tokens: 7, windowPct: 100 });
  });
});
