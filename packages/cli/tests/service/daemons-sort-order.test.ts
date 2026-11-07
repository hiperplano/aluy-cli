// ADR-0158 §6 — daemons.ts: `listDeclaredDaemons` ordena os daemons por nome
// (`.sort((a,b)=>a.localeCompare(b))`) — mas o `readdirSync` REAL, neste ambiente
// de teste, JÁ devolve os nomes em ordem alfabética por conta própria (achado ao
// tentar provar a ordenação com diretórios reais: um teste ingênuo com 3 daemons
// "fora de ordem" passava IGUAL mesmo removendo o `.sort()` — o "natural order"
// do filesystem local mascarava o mutante). Pra provar que É o `.sort()` (não uma
// coincidência do SO) que ordena, este arquivo intercepta SÓ o `readdirSync` (via
// mock parcial de `node:fs`, resto real) e devolve os Dirents FORA de ordem —
// nunca mocka `readFileSync`/etc., os `daemon.md` no disco continuam reais.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDeclaredDaemons } from '../../src/service/daemons.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const mockReaddirSync = vi.mocked(readdirSync);

function fakeDirent(name: string): Dirent {
  return { name, isDirectory: () => true } as unknown as Dirent;
}

describe('listDeclaredDaemons — o `.sort()` é quem ordena (não um acidente do filesystem)', () => {
  let serviceDir: string;

  beforeEach(async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-sortorder-'));
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    mockReaddirSync.mockImplementation(actualFs.readdirSync);
    for (const name of ['zulu', 'mike', 'alpha']) {
      const dir = join(serviceDir, 'daemons', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'daemon.md'), '---\ncommand: sleep 1\n---\n');
    }
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('readdirSync devolve os Dirents FORA de ordem alfabética ⇒ listDeclaredDaemons devolve ORDENADO mesmo assim', () => {
    // Ordem PROPOSITALMENTE não-alfabética (nem a ordem de criação: mistura tudo)
    // — só o `.sort()` de dentro de `listDeclaredDaemons` pode corrigir isto.
    mockReaddirSync.mockReturnValueOnce([fakeDirent('zulu'), fakeDirent('alpha'), fakeDirent('mike')] as never);

    const names = listDeclaredDaemons(serviceDir, () => {}).map((d) => d.name);

    expect(names).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('mesmo com a entrada JÁ invertida (z, m, a) ⇒ ainda sai alfabética (prova que não é "só inverter")', () => {
    mockReaddirSync.mockReturnValueOnce([fakeDirent('zulu'), fakeDirent('mike'), fakeDirent('alpha')] as never);

    const names = listDeclaredDaemons(serviceDir, () => {}).map((d) => d.name);

    expect(names).toEqual(['alpha', 'mike', 'zulu']);
  });
});
