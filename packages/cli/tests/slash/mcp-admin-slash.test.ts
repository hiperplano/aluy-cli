// EST-0970 (ciclo MCP na sessão) — `/mcp add|remove|disable|enable` DENTRO da sessão,
// reusando o writer do #81 (atômico/merge/0600) sobre tmpdir (NUNCA o ~/.aluy real).
// FRUGAL: sem modelo, sem rede — parser puro + runner sobre fs-temp.
//
// E-B1: o slash é ATO DO USUÁRIO (digitado na composer) — mesmo estatuto do
// `aluy mcp add` shell. O AGENTE não alcança este caminho: slash NÃO é tool
// (nenhuma NativeTool invoca o writer) e a catraca segue NEGANDO escrita do agente
// em `~/.aluy/` (aluy-config-write-deny) — provado no fim desta bateria.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpAdminSlash, runMcpAdminSlash } from '../../src/slash/mcp-admin.js';
import { setupMcp } from '../../src/mcp/setup.js';
import { NATIVE_TOOLS, PolicyPermissionEngine, type McpTransport } from '@hiperplano/aluy-cli-core';

describe('parseMcpAdminSlash — parser puro dos subcomandos', () => {
  it('`add pw -- npx -y @playwright/mcp` ⇒ add com command/args após o --', () => {
    expect(parseMcpAdminSlash('add pw -- npx -y @playwright/mcp')).toEqual({
      kind: 'add',
      name: 'pw',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
      env: [],
      force: false,
    });
  });

  it('aceita --env K=V (antes do --) e --force', () => {
    const cmd = parseMcpAdminSlash('add gh --env TOKEN=$GH_TOKEN --force -- npx -y @x/gh');
    expect(cmd).toEqual({
      kind: 'add',
      name: 'gh',
      command: 'npx',
      args: ['-y', '@x/gh'],
      env: [['TOKEN', '$GH_TOKEN']],
      force: true,
    });
  });

  it('sem `--` ⇒ paridade com o shell (2º posicional é o command)', () => {
    expect(parseMcpAdminSlash('add pw npx -y @playwright/mcp')).toMatchObject({
      kind: 'add',
      name: 'pw',
      command: 'npx',
      args: ['-y', '@playwright/mcp'],
    });
  });

  it('depois do `--`, flags são do SERVER (não do aluy)', () => {
    expect(parseMcpAdminSlash('add s -- node srv.js --force --env X=1')).toMatchObject({
      kind: 'add',
      command: 'node',
      args: ['srv.js', '--force', '--env', 'X=1'],
      force: false,
      env: [],
    });
  });

  it('add malformado (sem nome / sem command / --env inválido) ⇒ nota de uso', () => {
    for (const bad of ['add', 'add pw', 'add pw --', 'add pw --env SEMIGUAL -- npx']) {
      const cmd = parseMcpAdminSlash(bad);
      expect(cmd?.kind).toBe('usage');
    }
  });

  it('remove/rm/disable/enable <nome>', () => {
    expect(parseMcpAdminSlash('remove pw')).toEqual({ kind: 'remove', name: 'pw' });
    expect(parseMcpAdminSlash('rm pw')).toEqual({ kind: 'remove', name: 'pw' });
    expect(parseMcpAdminSlash('disable pw')).toEqual({ kind: 'disable', name: 'pw' });
    expect(parseMcpAdminSlash('enable pw')).toEqual({ kind: 'enable', name: 'pw' });
    expect(parseMcpAdminSlash('disable')?.kind).toBe('usage');
  });

  it('NÃO captura listagem/search/desconhecido (#81/#94 intactos)', () => {
    expect(parseMcpAdminSlash('')).toBeNull();
    expect(parseMcpAdminSlash('search github')).toBeNull();
    expect(parseMcpAdminSlash('whatever')).toBeNull();
  });
});

describe('runMcpAdminSlash — ciclo completo sobre mock home (fs-temp)', () => {
  let base: string;
  let aluyHome: string;
  let codexHome: string;
  let file: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-mcp-admin-'));
    aluyHome = join(base, '.aluy');
    codexHome = join(base, '.codex');
    file = join(aluyHome, 'mcp.json');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function run(args: string): { title: string; lines: readonly string[] } {
    const cmd = parseMcpAdminSlash(args);
    expect(cmd).not.toBeNull();
    return runMcpAdminSlash(cmd!, { aluyHome, codexHome });
  }
  function readServers(): Record<string, Record<string, unknown>> {
    return (JSON.parse(readFileSync(file, 'utf8')) as never)['mcpServers'];
  }

  it('/mcp add pw -- npx -y @playwright/mcp ⇒ grava no mcp.json + nota com "reinicie"', () => {
    const note = run('add pw -- npx -y @playwright/mcp');
    expect(readServers()['pw']).toEqual({ command: 'npx', args: ['-y', '@playwright/mcp'] });
    const text = note.lines.join('\n');
    expect(text).toContain('adicionado "pw"');
    // a descoberta é no boot — a nota orienta (sem depender do /mcp reload existir).
    expect(text).toContain('reinicie');
    expect(text).toContain('catraca');
  });

  it('/mcp remove pw ⇒ tira do mcp.json', () => {
    run('add pw -- npx -y @playwright/mcp');
    run('add keep -- node srv.js');
    const note = run('remove pw');
    expect(note.lines.join('\n')).toContain('removido "pw"');
    expect(readServers()['pw']).toBeUndefined();
    expect(readServers()['keep']).toBeDefined(); // merge: vizinho intacto.
  });

  it('/mcp disable x ⇒ disabled:true (sem desinstalar) + aviso de próximo boot', () => {
    run('add x -- npx @x/srv');
    const note = run('disable x');
    expect(readServers()['x']).toEqual({ command: 'npx', args: ['@x/srv'], disabled: true });
    const text = note.lines.join('\n');
    expect(text).toContain('desativado "x"');
    expect(text).toContain('próximo boot');
  });

  it('/mcp enable x ⇒ volta a ativo (campo removido)', () => {
    run('add x -- npx @x/srv');
    run('disable x');
    const note = run('enable x');
    expect(readServers()['x']).toEqual({ command: 'npx', args: ['@x/srv'] });
    expect(note.lines.join('\n')).toContain('reativado "x"');
  });

  it('disable de server desconectado da escrita do aluy ⇒ nota honesta + dica Codex', () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, 'config.toml'),
      '[mcp_servers.cx]\ncommand = "npx"\nargs = ["@x/cx"]\n',
    );
    const note = run('disable cx');
    const text = note.lines.join('\n');
    expect(text).toContain('não está em ~/.aluy/mcp.json');
    expect(text).toContain('Codex');
    expect(existsSync(file)).toBe(false); // nada gravado.
  });

  it('--env que parece segredo ⇒ aviso preservado (grava mesmo assim)', () => {
    // chave com nome de segredo (*_TOKEN) + valor SINTÉTICO sem forma de token de
    // provider (sem prefixo ghp_/sk-): dispara o aviso pelo NOME da chave, sem plantar
    // um literal que pareça credencial real (mantém o secret-scan honesto/verde).
    const note = run('add gh --env API_TOKEN=meu-valor-aqui -- npx @x/gh');
    const text = note.lines.join('\n');
    expect(text).toContain('SEGREDO');
    expect(text).toContain('credencial');
    expect((readServers()['gh'] as { env: Record<string, string> }).env['API_TOKEN']).toBe(
      'meu-valor-aqui',
    );
  });

  it('--env por REFERÊNCIA ($VAR) ⇒ sem aviso de segredo', () => {
    const note = run('add gh --env TOKEN=$GH_TOKEN -- npx @x/gh');
    expect(note.lines.join('\n')).not.toContain('SEGREDO');
  });

  it('add duplicado sem --force ⇒ nota de erro honesta (config intacta)', () => {
    run('add pw -- npx a');
    const note = run('add pw -- npx b');
    expect(note.lines.join('\n')).toContain('--force');
    expect((readServers()['pw'] as { command: string }).command).toBe('npx');
    expect(readServers()['pw']!['args']).toEqual(['a']);
  });
});

describe('descoberta no boot PULA o server desativado (setupMcp sobre mock home)', () => {
  it('disabled:true ⇒ não conecta, zero tools dele; ativo segue descoberto', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-mcp-admin-setup-'));
    const aluyHome = join(base, '.aluy');
    mkdirSync(aluyHome, { recursive: true });
    writeFileSync(
      join(aluyHome, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          on: { command: 'x' },
          off: { command: 'x', disabled: true },
        },
      }),
    );
    const connected: string[] = [];
    const transport: McpTransport = {
      async connect(server) {
        connected.push(server.name);
        return [{ name: 'do', description: 'faz' }];
      },
      async callTool() {
        return { ok: true, content: '' };
      },
      async close() {},
    };
    const setup = await setupMcp({ aluyHome, makeTransport: () => transport });
    expect(connected).toEqual(['on']);
    expect(setup.tools.map((t) => t.name)).toEqual(['mcp__on__do']);
    await setup.close();
    rmSync(base, { recursive: true, force: true });
  });
});

describe('E-B1 — o AGENTE não alcança o writer (a catraca segue intocada)', () => {
  it('slash NÃO é tool: nenhuma NativeTool gerencia config MCP', () => {
    // O toolset nativo do agente não contém nada que invoque o McpConfigWriter —
    // o `/mcp …` roda no onCommand da TUI (caminho do USUÁRIO), fora do loop.
    const names = NATIVE_TOOLS.map((t) => t.name);
    expect(names).not.toContain('mcp');
    expect(names.some((n) => /mcp.*(add|remove|disable|enable|admin|config)/i.test(n))).toBe(false);
  });

  it('escrita do agente em ~/.aluy/mcp.json segue DENY (aluy-config-write-deny)', () => {
    const engine = new PolicyPermissionEngine();
    const edit = engine.decide({
      name: 'edit_file',
      input: { path: '~/.aluy/mcp.json', content: '{"mcpServers":{}}' },
    });
    expect(edit.decision).toBe('deny');
    const bash = engine.decide({
      name: 'run_command',
      input: { command: 'echo "{}" > ~/.aluy/mcp.json' },
    });
    expect(bash.decision).toBe('deny');
  });
});
