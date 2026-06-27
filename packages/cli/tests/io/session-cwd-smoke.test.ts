// EST-0982 — SMOKE end-to-end do DIRETÓRIO DE TRABALHO DE SESSÃO (SEM modelo).
//
// Prova a costura REAL tool ↔ porta ↔ fs/shell que o problema original quebrava:
//   1. `change_dir ecommerce-app` ⇒ o sessionCwd vira a subpasta;
//   2. `edit_file data/produtos.json` (RELATIVO) ⇒ o arquivo é criado em
//      <root>/ecommerce-app/data/produtos.json — NÃO em <root>/data/ (o bug);
//   3. `run_command pwd` ⇒ roda NA subpasta (não na raiz fixa);
//   4. `read_file data/produtos.json` (relativo) ⇒ lê o arquivo da subpasta.
//
// Usa as tools NATIVAS do core ligadas às portas CONCRETAS do @hiperplano/aluy-cli (NodeWorkspace/
// FS/Shell), com a ÚNICA fonte de verdade do cwd (o workspace). Nenhum modelo é chamado.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changeDirTool,
  writeFileTool,
  readFileTool,
  runCommandTool,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeSearchPort } from '../../src/io/search-port.js';

describe('EST-0982 · SMOKE — cd subdir + edit relativo + run_command (sem modelo)', () => {
  let root: string;
  let ports: ToolPorts;
  let workspace: NodeWorkspace;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-smoke-'));
    root = join(base, 'project');
    // o agente "criou" um app numa subpasta (ex.: create-next-app ecommerce-app).
    mkdirSync(join(root, 'ecommerce-app', 'data'), { recursive: true });
    workspace = new NodeWorkspace({ root });
    // O MESMO workspace é o cwd-port E a fonte do shell/fs/search — fonte ÚNICA.
    ports = {
      fs: new NodeFileSystemPort({ workspace }),
      shell: new NodeShellPort({ workspace, timeoutMs: 30_000 }),
      search: new NodeSearchPort({ workspace }),
      cwd: workspace,
    };
  });

  afterEach(() => {
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('o arquivo do edit RELATIVO cai na SUBPASTA após o cd (não na raiz)', async () => {
    // 1. cd ecommerce-app
    const cd = await changeDirTool.run({ path: 'ecommerce-app' }, ports);
    expect(cd.ok).toBe(true);
    expect(workspace.cwd).toBe(join(realpathSync(root), 'ecommerce-app'));

    // 2. write_file data/produtos.json (RELATIVO ao sessionCwd) — cria arquivo novo
    const ed = await writeFileTool.run(
      { path: 'data/produtos.json', content: '[{"nome":"camiseta"}]\n' },
      ports,
    );
    expect(ed.ok).toBe(true);

    // O arquivo está na SUBPASTA…
    expect(existsSync(join(root, 'ecommerce-app', 'data', 'produtos.json'))).toBe(true);
    // …e NÃO no <root>/data/ (o bug que a estória conserta).
    expect(existsSync(join(root, 'data', 'produtos.json'))).toBe(false);
  });

  it('run_command roda NA subpasta (pwd mostra o ecommerce-app)', async () => {
    await changeDirTool.run({ path: 'ecommerce-app' }, ports);
    const r = await runCommandTool.run({ command: 'pwd' }, ports);
    expect(r.ok).toBe(true);
    // a saída do pwd é o cwd de sessão (a subpasta), não a raiz fixa.
    expect(r.observation).toContain(join(realpathSync(root), 'ecommerce-app'));
    expect(r.observation).not.toMatch(new RegExp(`${realpathSync(root)}\\n`)); // não a raiz pura
  });

  it('read_file relativo lê da subpasta após o cd (round-trip completo)', async () => {
    await changeDirTool.run({ path: 'ecommerce-app' }, ports);
    await writeFileTool.run({ path: 'data/x.json', content: 'conteudo-na-subpasta' }, ports);
    const rd = await readFileTool.run({ path: 'data/x.json' }, ports);
    expect(rd.ok).toBe(true);
    expect(rd.observation).toBe('conteudo-na-subpasta');
  });

  it('CONFINAMENTO — cd .. além da raiz é clampado; o edit segue preso à raiz', async () => {
    const cd = await changeDirTool.run({ path: '..' }, ports);
    expect(cd.ok).toBe(true);
    expect(workspace.cwd).toBe(realpathSync(root)); // clampado na raiz
    // um edit relativo de dentro do cwd (=raiz) cria na raiz, nunca fora.
    await writeFileTool.run({ path: 'na-raiz.txt', content: 'ok' }, ports);
    expect(existsSync(join(root, 'na-raiz.txt'))).toBe(true);
    expect(existsSync(join(root, '..', 'na-raiz.txt'))).toBe(false);
  });
});
