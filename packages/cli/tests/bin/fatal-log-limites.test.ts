// Auditoria — log de término fatal: rotação por tamanho, limite do detalhe, permissões 0600/0700,
// serialização de causa que não é Error e a fiação no binário. Sem tocar o ~/.aluy real (dir temp).

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appendFatalLog } from '../../src/bin/fatal-log.js';

const dirs: string[] = [];
const novoDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'aluy-fatal-lim-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('appendFatalLog · limites e formato', () => {
  it('o detalhe é truncado em 8 KiB (um stack gigante não enche o disco)', () => {
    const dir = novoDir();
    appendFatalLog('k', 'x'.repeat(50_000), { dir });
    const txt = readFileSync(join(dir, 'crash.log'), 'utf8');
    expect(txt.length).toBeLessThan(8 * 1024 + 200);
    expect(txt.length).toBeGreaterThan(8 * 1024);
  });

  it('acima de 512 KiB o log antigo é rotacionado para crash.log.1 e um novo começa', () => {
    const dir = novoDir();
    writeFileSync(join(dir, 'crash.log'), 'a'.repeat(512 * 1024 + 10));
    appendFatalLog('k', 'novo', { dir });
    expect(existsSync(join(dir, 'crash.log.1'))).toBe(true);
    expect(statSync(join(dir, 'crash.log.1')).size).toBe(512 * 1024 + 10);
    const atual = readFileSync(join(dir, 'crash.log'), 'utf8');
    expect(atual).toContain('k: novo');
    expect(atual).not.toContain('aaaa');
  });

  it('abaixo do limite acrescenta ao mesmo arquivo (sem rotacionar)', () => {
    const dir = novoDir();
    appendFatalLog('k', 'um', { dir });
    appendFatalLog('k', 'dois', { dir });
    expect(existsSync(join(dir, 'crash.log.1'))).toBe(false);
    const linhas = readFileSync(join(dir, 'crash.log'), 'utf8').trim().split('\n');
    expect(linhas).toHaveLength(2);
  });

  it('arquivo 0600 e diretório 0700 (sem segredos legíveis por outros usuários)', () => {
    const base = novoDir();
    const dir = join(base, 'logs');
    appendFatalLog('k', 'x', { dir });
    expect(statSync(join(dir, 'crash.log')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('causa que não é Error nem string é serializada em JSON; o que não serializa vira String()', () => {
    const dir = novoDir();
    appendFatalLog('obj', { a: 1 }, { dir });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    appendFatalLog('circ', circular, { dir });
    const txt = readFileSync(join(dir, 'crash.log'), 'utf8');
    expect(txt).toContain('obj: {"a":1}');
    expect(txt).toContain('circ: [object Object]');
  });

  it('Error sem stack cai para "Nome: mensagem"', () => {
    const dir = novoDir();
    const e = new TypeError('sem pilha');
    e.stack = undefined;
    appendFatalLog('k', e, { dir });
    expect(readFileSync(join(dir, 'crash.log'), 'utf8')).toContain('k: TypeError: sem pilha');
  });
});

describe('fiação no binário', () => {
  it('o entrypoint instala o logger fatal e registra o término do filho do re-exec', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/bin/aluy.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toMatch(/installFatalLogger\(\);/);
    expect(src).toMatch(/logChildExit\(code, signal\);/);
  });
});
