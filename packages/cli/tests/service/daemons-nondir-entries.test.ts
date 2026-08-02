// ADR-0158 §6 — daemons.ts: fecha um sobrevivente de MUTAÇÃO (Stryker, pass 3) que
// `daemons-mutation-gaps.test.ts`/`daemons.test.ts` (alheios — NÃO editados aqui)
// não alcançavam: `listDeclaredDaemons` filtra `readdirSync(..., {withFileTypes:
// true}).filter((e) => e.isDirectory())` — um mutante que REMOVE esse `.filter(...)`
// sobrevive porque um ARQUIVO solto dentro de `daemons/` acaba tratado como nome de
// diretório de qualquer forma (o `readFileSync` subsequente falha com ENOTDIR/ENOENT
// e é ignorado do mesmo jeito "silencioso" — MAS com uma diferença observável: o
// caminho REAL (filtrado) nunca sequer TENTA ler `daemon.md` daquele nome, então
// NUNCA loga nada sobre ele; o caminho SEM filtro tenta, falha, e LOGA "sem
// daemon.md legível" mencionando o arquivo — essa linha de log é o que distingue os
// dois. Arquivo SEPARADO — só ESTENDE a cobertura.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDeclaredDaemons } from '../../src/service/daemons.js';

describe('listDeclaredDaemons — entradas que NÃO são diretório em daemons/ são EXCLUÍDAS antes de qualquer tentativa de leitura', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-nondir-'));
    logs.length = 0;
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('um ARQUIVO solto (não-diretório) dentro de daemons/ nunca aparece na lista NEM no log — só o daemon de verdade entra', () => {
    mkdirSync(join(serviceDir, 'daemons'), { recursive: true });
    writeFileSync(join(serviceDir, 'daemons', 'README.txt'), 'não é um daemon, é só um arquivo solto');
    mkdirSync(join(serviceDir, 'daemons', 'real'), { recursive: true });
    writeFileSync(join(serviceDir, 'daemons', 'real', 'daemon.md'), '---\ncommand: sleep 1\n---\n');

    const list = listDeclaredDaemons(serviceDir, log);

    expect(list.map((d) => d.name)).toEqual(['real']);
    // a exclusão acontece ANTES de qualquer tentativa de leitura — o arquivo nunca
    // gera log nenhum (nem "sem daemon.md legível", nem qualquer outra menção).
    expect(logs.some((l) => l.includes('README.txt'))).toBe(false);
    expect(logs).toHaveLength(0);
  });
});
