// EST-0970 — comando `aluy mcp add/list/remove` (parser puro + runner sobre tmpdir + IO fake).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpCommand, runMcp, type McpCommandDeps } from '../../src/commands/mcp.js';
import type { TerminalIO } from '../../src/auth/io.js';
import { addCommandFor, parseMcpConfig, type RegistrySearchResult } from '@aluy/cli-core';

// IO fake: coleta as linhas escritas em out/err.
function io(): { io: TerminalIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => '',
    },
    out,
    err,
  };
}

describe('parseMcpCommand — parser puro', () => {
  it('add com args e env', () => {
    const c = parseMcpCommand(['add', 'foo', 'npx', '-y', 'pkg', '--env', 'K=V', '--env=A=B']);
    expect(c).toMatchObject({
      kind: 'add',
      name: 'foo',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: [
        ['K', 'V'],
        ['A', 'B'],
      ],
      project: false,
      force: false,
    });
  });

  it('add --project --force', () => {
    const c = parseMcpCommand(['add', 'foo', 'node', '--project', '--force']);
    expect(c).toMatchObject({ kind: 'add', project: true, force: true });
  });

  it('add sem command ⇒ erro', () => {
    expect(parseMcpCommand(['add', 'foo']).kind).toBe('error');
  });

  it('env com `=` no valor é preservado', () => {
    const c = parseMcpCommand(['add', 'f', 'x', '--env', 'URL=a=b=c']);
    expect(c).toMatchObject({ kind: 'add', env: [['URL', 'a=b=c']] });
  });

  it('env sem `=` ⇒ erro', () => {
    expect(parseMcpCommand(['add', 'f', 'x', '--env', 'BAD']).kind).toBe('error');
  });

  // EST-0970 (fix) — separador POSIX `--` entre <nome> e <command>: a forma que o
  // `mcp search` SUGERE (`aluy mcp add pw -- npx -y X`). O `--` é PULADO, nunca
  // vira command.
  it('add com `--` antes do command: separador é PULADO (≡ sem `--`)', () => {
    const withSep = parseMcpCommand(['add', 'pw', '--', 'npx', '-y', '@playwright/mcp']);
    const without = parseMcpCommand(['add', 'pw', 'npx', '-y', '@playwright/mcp']);
    expect(withSep).toMatchObject({
      kind: 'add',
      name: 'pw',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
    });
    // As duas formas produzem a MESMA config.
    expect(withSep).toEqual(without);
  });

  it('flags do aluy ANTES do `--` funcionam; depois do `--` tudo é do server', () => {
    const c = parseMcpCommand(['add', 'pw', '--project', '--force', '--', 'npx', '--env', 'K=V']);
    expect(c).toMatchObject({
      kind: 'add',
      name: 'pw',
      command: 'npx',
      // `--env K=V` veio DEPOIS do `--` ⇒ é arg literal do server, não flag do aluy.
      args: ['--env', 'K=V'],
      env: [],
      project: true,
      force: true,
    });
  });

  it('`--` literal como command ⇒ erro claro (nunca grava command:"--")', () => {
    const c = parseMcpCommand(['add', 'pw', '--', '--']);
    expect(c.kind).toBe('error');
    expect(c.kind === 'error' && c.message).toContain('separador');
  });

  it('`--` DEPOIS do command é arg literal do server (preservado)', () => {
    const c = parseMcpCommand(['add', 'pw', 'npx', '--', '-y']);
    expect(c).toMatchObject({ kind: 'add', command: 'npx', args: ['--', '-y'] });
  });

  // EST-0970 (UX, #103) — cobertura extra do separador que o prompt do agente ensina.
  it('flags do aluy ANTES do `--` com --env seguem valendo (--project --env K=V -- cmd)', () => {
    const c = parseMcpCommand(['add', 's', '--project', '--env', 'K=V', '--', 'node', 'srv.js']);
    expect(c).toMatchObject({
      kind: 'add',
      name: 's',
      command: 'node',
      args: ['srv.js'],
      project: true,
      env: [['K', 'V']],
    });
  });

  it('um 2º `--` após o 1º é arg LITERAL do server', () => {
    const c = parseMcpCommand(['add', 's', '--', 'sh', '-c', '--', 'x']);
    expect(c).toMatchObject({ kind: 'add', command: 'sh', args: ['-c', '--', 'x'] });
  });

  it('`--` sem command depois ⇒ erro (falta o <command>)', () => {
    expect(parseMcpCommand(['add', 's', '--']).kind).toBe('error');
  });

  it('remove e list', () => {
    expect(parseMcpCommand(['remove', 'foo']).kind).toBe('remove');
    expect(parseMcpCommand(['rm', 'foo', '--project'])).toMatchObject({
      kind: 'remove',
      project: true,
    });
    expect(parseMcpCommand(['list']).kind).toBe('list');
  });

  it('sem sub / --help ⇒ help; sub desconhecido ⇒ erro', () => {
    expect(parseMcpCommand([]).kind).toBe('help');
    expect(parseMcpCommand(['--help']).kind).toBe('help');
    expect(parseMcpCommand(['bogus']).kind).toBe('error');
  });
});

describe('runMcp — escrita/listagem sobre tmpdir', () => {
  let base: string;
  let aluyHome: string;
  let codexHome: string;
  let workspaceRoot: string;
  let deps: McpCommandDeps;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mcp-cmd-'));
    aluyHome = join(base, 'aluy');
    codexHome = join(base, 'codex');
    workspaceRoot = join(base, 'ws');
    mkdirSync(aluyHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    deps = { aluyHome, codexHome, workspaceRoot };
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function readGlobal(): unknown {
    return JSON.parse(readFileSync(join(aluyHome, 'mcp.json'), 'utf8'));
  }

  it('add grava ~/.aluy/mcp.json com o server (merge preserva existentes)', async () => {
    writeFileSync(
      join(aluyHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { keep: { command: 'node', args: [] } } }),
    );
    const { io: t, out } = io();
    const code = await runMcp(['add', 'foo', 'npx', 'pkg', '--env', 'K=V'], { ...deps, io: t });
    expect(code).toBe(0);
    const cfg = parseMcpConfig(readGlobal());
    expect(cfg.servers.map((s) => s.name).sort()).toEqual(['foo', 'keep']);
    expect(cfg.servers.find((s) => s.name === 'foo')!.env).toEqual({ K: 'V' });
    expect(out.join('\n')).toContain('adicionado');
  });

  it('add --project escreve no .mcp.json local', async () => {
    const { io: t } = io();
    const code = await runMcp(['add', 'p', 'node', '--project'], { ...deps, io: t });
    expect(code).toBe(0);
    const cfg = parseMcpConfig(JSON.parse(readFileSync(join(workspaceRoot, '.mcp.json'), 'utf8')));
    expect(cfg.servers.map((s) => s.name)).toEqual(['p']);
  });

  it('nome duplicado sem --force ⇒ exit !=0 e erro', async () => {
    const { io: t, err } = io();
    await runMcp(['add', 'foo', 'npx'], { ...deps, io: t });
    const code = await runMcp(['add', 'foo', 'node'], { ...deps, io: t });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('--force');
  });

  it('add com --env que parece SEGREDO ⇒ avisa (mas grava)', async () => {
    const { io: t, err } = io();
    // chave com nome de segredo (*_TOKEN) + valor SINTÉTICO sem forma de token de provider
    // (sem prefixo ghp_/sk-): dispara o aviso pelo NOME da chave, sem plantar um literal
    // que pareça credencial real (mantém o gate de secret-scan honesto/verde).
    const code = await runMcp(['add', 'gh', 'npx', '--env', 'API_TOKEN=meu-valor-aqui'], {
      ...deps,
      io: t,
    });
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('SEGREDO');
    // gravou assim mesmo (é DADO do usuário; só avisamos).
    const cfg = parseMcpConfig(readGlobal());
    expect(cfg.servers[0]!.env['API_TOKEN']).toBe('meu-valor-aqui');
  });

  it('remove tira o server', async () => {
    const { io: t, out } = io();
    await runMcp(['add', 'foo', 'npx'], { ...deps, io: t });
    const code = await runMcp(['remove', 'foo'], { ...deps, io: t });
    expect(code).toBe(0);
    expect(parseMcpConfig(readGlobal()).servers).toEqual([]);
    expect(out.join('\n')).toContain('removido');
  });

  it('remove de server que vem do Codex avisa que o aluy não o gerencia', async () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      '[mcp_servers.cx]\ncommand = "node"\nargs = []\n',
    );
    const { io: t, err } = io();
    const code = await runMcp(['remove', 'cx'], { ...deps, io: t });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Codex');
  });

  it('list mostra servers de todas as fontes com origem', async () => {
    writeFileSync(
      join(aluyHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { g: { command: 'a', args: [] } } }),
    );
    writeFileSync(
      join(workspaceRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { p: { command: 'b', args: [] } } }),
    );
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.cx]\ncommand = "c"\nargs = []\n');
    const { io: t, out } = io();
    const code = await runMcp(['list'], { ...deps, io: t });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('g');
    expect(text).toContain('p');
    expect(text).toContain('cx');
    expect(text).toContain('~/.aluy/mcp.json');
    expect(text).toContain('projeto');
    expect(text).toContain('Codex');
  });

  it('list vazio orienta o add', async () => {
    const { io: t, out } = io();
    await runMcp(['list'], { ...deps, io: t });
    expect(out.join('\n')).toContain('aluy mcp add');
  });

  // EST-0970 (fix) — o CAMINHO FELIZ sugerido: a linha EXATA que o `mcp search`
  // monta (`→ aluy mcp add <nome> -- <command> …`) funciona end-to-end
  // (parse → grava → list ok), sem `--` vazando p/ a config.
  it('a linha exata sugerida pelo `mcp search` funciona end-to-end', async () => {
    const result: RegistrySearchResult = {
      name: 'io.github.microsoft/playwright-mcp',
      description: 'Browser automation via Playwright.',
      run: { command: 'npx', args: ['-y', '@playwright/mcp'], env: [], remoteUrls: [] },
    };
    const line = addCommandFor(result)!;
    expect(line).toBe('aluy mcp add playwright-mcp -- npx -y @playwright/mcp');
    // Reproduz o copia/cola: o shell tokeniza por espaço; o binário roteia
    // `aluy mcp <resto>` ⇒ runMcp recebe a partir do "add".
    const argv = line.split(' ').slice(2);
    const { io: t, err } = io();
    const code = await runMcp(argv, { ...deps, io: t });
    expect(code).toBe(0);
    const cfg = parseMcpConfig(readGlobal());
    const pw = cfg.servers.find((s) => s.name === 'playwright-mcp')!;
    expect(pw.command).toBe('npx'); // NUNCA "--".
    expect(pw.args).toEqual(['-y', '@playwright/mcp']);
    // list mostra o server SEM aviso de config quebrada.
    const { io: t2, out: out2, err: err2 } = io();
    expect(await runMcp(['list'], { ...deps, io: t2 })).toBe(0);
    expect(out2.join('\n')).toContain('playwright-mcp');
    expect(out2.join('\n')).toContain('npx -y @playwright/mcp');
    expect([...err, ...err2].join('\n')).not.toContain('inválido');
  });

  // EST-0970 (fix) — config LEGADA quebrada (`command:"--"` gravado pelo parser antigo):
  // o list AVISA com a correção pronta, em vez de o server falhar silencioso.
  it('config legada com command:"--" ⇒ list avisa "re-adicione"', async () => {
    writeFileSync(
      join(aluyHome, 'mcp.json'),
      JSON.stringify({ mcpServers: { pw: { command: '--', args: ['npx', '-y', 'X'] } } }),
    );
    const { io: t, out, err } = io();
    const code = await runMcp(['list'], { ...deps, io: t });
    expect(code).toBe(0); // listar não FALHA — avisa.
    expect(out.join('\n')).toContain('pw');
    const warning = err.join('\n');
    expect(warning).toContain('command inválido "--"');
    expect(warning).toContain('Re-adicione');
    expect(warning).toContain('aluy mcp add pw --force -- npx -y X');
  });

  // EST-0970 (fix) — defesa em PROFUNDIDADE: mesmo que um chamador monte o add com
  // command:"--" (bypass do parser), a escrita é rejeitada com erro claro.
  it('add com command "--" forjado ⇒ erro claro, nada gravado', async () => {
    const { io: t, err } = io();
    const code = await runMcp(['add', 'pw', '--', '--', 'npx'], { ...deps, io: t });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('separador');
  });
});
