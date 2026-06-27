// EST-0982 · /add-dir — SMOKE end-to-end (SEM modelo, fs-temp): a costura REAL
// slash (ato do USUÁRIO) → NodeWorkspace (multi-raiz) → portas concretas → tools
// nativas do core. Prova o DoD da estória:
//   1. ANTES do /add-dir: read_file/edit_file/change_dir em /tmp/extra ⇒ BARRADOS
//      (não-regressão do confinamento single-root, #68/AG-0009);
//   2. `/add-dir <extra>` (runAddDir, o MESMO handler do run.tsx) ⇒ as MESMAS tools
//      passam a funcionar no extra — na hora (mesma instância de workspace);
//   3. fora das raízes ⇒ ESCAPE segue barrado (symlink/.. inclusive);
//   4. `/add-dir` sem args LISTA as raízes; path inválido ⇒ erro claro;
//   5. o path-deny do journal/`~/.aluy/` VALE nas raízes extras: a catraca
//      classifica pelo TEXTO do path e NÃO consulta raízes — autorizar a home
//      não libera `~/.aluy/`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PolicyPermissionEngine,
  changeDirTool,
  writeFileTool,
  readFileTool,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import { NodeSearchPort } from '../../src/io/search-port.js';
import { runAddDir } from '../../src/slash/handlers.js';

describe('EST-0982 · /add-dir — smoke slash → workspace → tools (sem modelo)', () => {
  let base: string;
  let root: string;
  let extra: string;
  let outside: string;
  let workspace: NodeWorkspace;
  let ports: ToolPorts;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-adddir-smoke-'));
    root = join(base, 'project');
    extra = join(base, 'extra');
    outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(extra, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(extra, 'nota.md'), 'conteudo-do-extra\n');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
    workspace = new NodeWorkspace({ root });
    ports = {
      fs: new NodeFileSystemPort({ workspace }),
      search: new NodeSearchPort({ workspace }),
      // shell não é usado neste smoke (frugal); cwd é o PRÓPRIO workspace.
      shell: { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      cwd: workspace,
    };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('ANTES do /add-dir as tools são BARRADAS no extra; DEPOIS, funcionam', async () => {
    // ANTES: read_file/edit_file/change_dir no extra falham (confinamento intacto).
    const rd0 = await readFileTool.run({ path: join(extra, 'nota.md') }, ports);
    expect(rd0.ok).toBe(false);
    const ed0 = await writeFileTool.run({ path: join(extra, 'novo.txt'), content: 'x' }, ports);
    expect(ed0.ok).toBe(false);
    expect(existsSync(join(extra, 'novo.txt'))).toBe(false);
    const cd0 = await changeDirTool.run({ path: extra }, ports);
    // o cd clampa (não escapa): o cwd segue na raiz primária.
    expect(workspace.cwd).not.toContain('extra');

    // O USUÁRIO roda /add-dir <extra> (o MESMO handler que o run.tsx invoca).
    const note = runAddDir(extra, workspace);
    expect(note.lines[0]).toContain('✓');
    expect(note.lines[0]).toContain('adicionado');
    expect(note.lines[0]).toMatch(/ler\/editar\/navegar/);

    // DEPOIS: as MESMAS tools funcionam no extra — sem reconstruir nada.
    const rd1 = await readFileTool.run({ path: join(extra, 'nota.md') }, ports);
    expect(rd1.ok).toBe(true);
    expect(rd1.observation).toContain('conteudo-do-extra');
    const ed1 = await writeFileTool.run(
      { path: join(extra, 'novo.txt'), content: 'criado' },
      ports,
    );
    expect(ed1.ok).toBe(true);
    expect(existsSync(join(extra, 'novo.txt'))).toBe(true);
    const cd1 = await changeDirTool.run({ path: extra }, ports);
    expect(cd1.ok).toBe(true);
    expect(workspace.cwd).toBe(workspace.roots[1]);
    // e cd0 não tinha navegado (sanidade do ANTES).
    expect(cd0.ok).toBe(true); // clampado não é erro — mas NÃO entrou no extra.
  });

  it('fora das raízes o ESCAPE segue barrado: symlink e `..` (com extra autorizado)', async () => {
    runAddDir(extra, workspace);
    // symlink DENTRO do extra apontando p/ fora ⇒ leitura barrada (canonicaliza).
    symlinkSync(join(outside, 'secret.txt'), join(extra, 'link-escape'));
    const viaLink = await readFileTool.run({ path: join(extra, 'link-escape') }, ports);
    expect(viaLink.ok).toBe(false);
    // `..` a partir do extra ⇒ barrado.
    await changeDirTool.run({ path: extra }, ports);
    const viaDotDot = await readFileTool.run({ path: '../outside/secret.txt' }, ports);
    expect(viaDotDot.ok).toBe(false);
    // nada do conteúdo vazou p/ a observação.
    expect(viaLink.observation).not.toContain('TOP SECRET');
    expect(viaDotDot.observation).not.toContain('TOP SECRET');
  });

  it('/add-dir sem args LISTA as raízes ativas (a primária marcada)', () => {
    runAddDir(extra, workspace);
    const note = runAddDir('', workspace);
    expect(note.lines.join('\n')).toContain('raízes autorizadas');
    expect(note.lines.some((l) => l.includes('(raiz do workspace)'))).toBe(true);
    expect(note.lines.some((l) => l.includes('extra'))).toBe(true);
  });

  it('/add-dir com path inválido ⇒ erro CLARO e nada muda', () => {
    const before = workspace.roots.length;
    const note = runAddDir(join(base, 'nao-existe'), workspace);
    expect(note.lines[0]).toMatch(/não existe|não foi possível/);
    expect(note.lines.join('\n')).toContain('nada mudou');
    expect(workspace.roots.length).toBe(before);
  });

  it('/add-dir repetido (ou subdir já coberto) ⇒ nota idempotente', () => {
    runAddDir(extra, workspace);
    const again = runAddDir(extra, workspace);
    expect(again.lines[0]).toContain('já está autorizado');
    expect(workspace.roots.length).toBe(2);
  });

  it('o path-deny do journal/~/.aluy VALE nas raízes extras (catraca não consulta raízes)', () => {
    // A engine decide pelo TEXTO do path (categorias) — não recebe workspace/raízes.
    // Mesmo que o usuário autorize a própria home como raiz extra, ler `~/.aluy/`
    // segue DENY (journal-read-deny, acima até do --unsafe).
    const engine = new PolicyPermissionEngine();
    const denied = engine.decide({
      name: 'read_file',
      input: { path: '/home/tester/.aluy/undo/sess/blob' },
    });
    expect(denied.decision).toBe('deny');
    expect(denied.category).toBe('always-ask:journal-read-deny');
    // escrita na config do aluy também segue negada.
    const deniedWrite = engine.decide({
      name: 'edit_file',
      input: { path: '~/.aluy/hooks.json', content: 'pwn' },
    });
    expect(deniedWrite.decision).toBe('deny');
  });
});
