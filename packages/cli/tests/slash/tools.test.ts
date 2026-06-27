// F59 — teste do comando /tools (inventário unificado de ferramentas).

import { describe, expect, it } from 'vitest';
import { buildToolsNote } from '../../src/slash/handlers.js';
import { routeInput, NATIVE_COMMANDS } from '../../src/slash/commands.js';
import type { McpListedServer } from '@hiperplano/aluy-cli-core';

describe('F59 — /tools (inventário unificado)', () => {
  // ── Registro no slash-menu ──────────────────────────────────────────────
  it('está no NATIVE_COMMANDS com id tools, seção workspace, read-only', () => {
    const cmd = NATIVE_COMMANDS.find((c) => c.id === 'tools');
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('tools');
    expect(cmd?.section).toBe('workspace');
    expect(cmd?.source).toBe('native');
    // read-only: parallelWhileBusy=true
    expect(cmd?.parallelWhileBusy).toBe(true);
  });

  it('é roteado como comando nativo (não cai em goal nem unknown)', () => {
    const r = routeInput('/tools');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.id).toBe('tools');
  });

  // ── buildToolsNote (pura) ───────────────────────────────────────────────
  it('lista as 8 nativas com nome, efeito e 1-linha descritiva', () => {
    const note = buildToolsNote(undefined, false);
    expect(note.title).toBe('tools');

    const nativeLine = note.lines.findIndex((l) => l.includes('ferramentas nativas'));
    expect(nativeLine).toBeGreaterThanOrEqual(0);

    // As 8 nativas obrigatórias
    const nativeNames = [
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'run_command',
      'run_tests',
      'change_dir',
    ];
    for (const name of nativeNames) {
      const line = note.lines.find((l) => l.includes(name));
      expect(line, `nativa ${name} ausente`).toBeDefined();
      // cada linha (da tabela com bordas) tem o efeito
      expect(line).toMatch(/(leitura|escrita|execução)/);
    }
  });

  it('quando sem MCP, mostra direcionamento p/ /mcp', () => {
    const note = buildToolsNote(undefined, false);
    const mcpLine = note.lines.find((l) => l.includes('/mcp'));
    expect(mcpLine).toBeDefined();
  });

  it('com servers MCP, lista por server com estado e tools', () => {
    const servers: McpListedServer[] = [
      {
        name: 'desktop',
        origin: 'aluy-global',
        command: 'desktop-mcp',
        args: [],
        envKeys: [],
        managed: true,
        state: { kind: 'ok', toolCount: 2 },
        tools: [
          { qualifiedName: 'mcp__desktop__screenshot', description: 'Tira screenshot' },
          { qualifiedName: 'mcp__desktop__click', description: 'Clica na tela' },
        ],
      },
      {
        name: 'vision',
        origin: 'project',
        command: 'vision-mcp',
        args: [],
        envKeys: ['TOKEN'],
        managed: true,
        state: { kind: 'error', error: 'conexão recusada' },
        tools: [],
      },
    ];

    const note = buildToolsNote(servers, false);
    expect(note.lines.some((l) => l.includes('ferramentas MCP'))).toBe(true);

    // desktop: estado ok com 2 tools
    const desktopLine = note.lines.find((l) => l.includes('mcp__desktop'));
    expect(desktopLine).toBeDefined();
    expect(desktopLine).toMatch(/✓ 2/);

    // tools listadas
    expect(note.lines.some((l) => l.includes('mcp__desktop__screenshot'))).toBe(true);
    expect(note.lines.some((l) => l.includes('mcp__desktop__click'))).toBe(true);

    // vision: estado erro
    const visionLine = note.lines.find((l) => l.includes('mcp__vision'));
    expect(visionLine).toBeDefined();
    expect(visionLine).toMatch(/✗ erro/);
  });

  it('com server disabled, mostra ⚠ desabilitado', () => {
    const servers: McpListedServer[] = [
      {
        name: 'off',
        origin: 'project',
        command: 'off-cmd',
        args: [],
        envKeys: [],
        managed: true,
        state: { kind: 'disabled' },
        tools: [],
      },
    ];
    const note = buildToolsNote(servers, false);
    const offLine = note.lines.find((l) => l.includes('mcp__off'));
    expect(offLine).toMatch(/⚠ desabilitado/);
  });

  it('com server desconhecido, mostra ? desconhecido', () => {
    const servers: McpListedServer[] = [
      {
        name: 'unk',
        origin: 'project',
        command: 'unk-cmd',
        args: [],
        envKeys: [],
        managed: true,
        state: { kind: 'unknown' },
        tools: [],
      },
    ];
    const note = buildToolsNote(servers, false);
    const unkLine = note.lines.find((l) => l.includes('mcp__unk'));
    expect(unkLine).toMatch(/\? desconhecido/);
  });

  // ── Permissão ───────────────────────────────────────────────────────────
  it('com unsafe=false, mostra regra allow/ask/sempre-ask', () => {
    const note = buildToolsNote(undefined, false);
    const permIdx = note.lines.findIndex((l) => l.includes('permissão'));
    expect(permIdx).toBeGreaterThanOrEqual(0);
    const permLine = note.lines[permIdx + 1];
    expect(permLine).toMatch(/allow.*ask.*sempre-ask/);
  });

  it('com unsafe=true, avisa MODO YOLO', () => {
    const note = buildToolsNote(undefined, true);
    const yoloLine = note.lines.find((l) => l.includes('YOLO'));
    expect(yoloLine).toBeDefined();
    expect(yoloLine).toMatch(/DESLIGADA/);
  });

  // ── spawn_agent / room ──────────────────────────────────────────────────
  it('menciona spawn_agent e room_post/room_read na seção delegação', () => {
    const note = buildToolsNote(undefined, false);
    const delIdx = note.lines.findIndex((l) => l.includes('delegação'));
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(note.lines.some((l) => l.includes('spawn_agent'))).toBe(true);
    expect(note.lines.some((l) => l.includes('room_post'))).toBe(true);
    expect(note.lines.some((l) => l.includes('room_read'))).toBe(true);
  });
});
