// EST-0970 — `/mcp`: a nota lista os servers + tools (mock da descoberta), origem e estado.

import { describe, expect, it } from 'vitest';
import { buildMcpNote } from '../../src/slash/handlers.js';
import { buildMcpListing, type McpSource } from '@hiperplano/aluy-cli-core';
import type { McpDiscoveryResult } from '@hiperplano/aluy-cli-core';

const sources: McpSource[] = [
  { origin: 'codex', config: { servers: [{ name: 'cx', command: 'c', args: [], env: {} }] } },
  {
    origin: 'aluy-global',
    config: { servers: [{ name: 'fs', command: 'npx', args: ['@x/fs'], env: { TOKEN: 'shh' } }] },
  },
];

// Mock da descoberta (handshake) — fs sobe com 2 tools; cx falha.
const discovery: McpDiscoveryResult = {
  servers: [
    {
      server: 'fs',
      ok: true,
      tools: [
        { server: 'fs', descriptor: { name: 'read' }, transport: {} as never },
        {
          server: 'fs',
          descriptor: { name: 'write', description: 'escreve' },
          transport: {} as never,
        },
      ],
    },
    { server: 'cx', ok: false, tools: [], error: 'spawn falhou' },
  ],
  tools: [],
  transports: [],
};

describe('buildMcpNote — /mcp lista servers + tools', () => {
  it('lista cada server com origem, estado e tools prefixadas', () => {
    const listing = buildMcpListing(sources, discovery);
    const note = buildMcpNote(listing);
    const text = note.lines.join('\n');
    expect(note.title).toBe('mcp');
    expect(text).toContain('fs');
    expect(text).toContain('2 tools');
    expect(text).toContain('mcp__fs__read');
    expect(text).toContain('mcp__fs__write');
    expect(text).toContain('cx');
    expect(text).toContain('erro · spawn falhou');
    // env só por CHAVE — o valor nunca aparece.
    expect(text).toContain('env: TOKEN');
    expect(text).not.toContain('shh');
  });

  // EST-0970 (fix) — server legado com command:"--" (separador gravado por engano):
  // a nota do /mcp AVISA com a correção pronta, em vez do server falhar mudo.
  it('server com command:"--" ⇒ linha de aviso com o re-add', () => {
    const broken: McpSource[] = [
      {
        origin: 'aluy-global',
        config: { servers: [{ name: 'pw', command: '--', args: ['npx', '-y', 'X'], env: {} }] },
      },
    ];
    const note = buildMcpNote(buildMcpListing(broken));
    const text = note.lines.join('\n');
    expect(text).toContain('command inválido "--"');
    expect(text).toContain('aluy mcp add pw --force -- npx -y X');
  });

  it('lista vazia ⇒ dica de add (na sessão)', () => {
    const note = buildMcpNote([]);
    expect(note.lines.join('\n')).toContain('/mcp add');
  });

  // EST-0970 (ciclo na sessão) — a lista mostra o ESTADO do interruptor:
  // `✓ ativo` p/ server conectado · `○ desativado` p/ `disabled: true` (sem tools).
  it('mostra ✓ ativo no conectado e ○ desativado no disabled', () => {
    const withDisabled: McpSource[] = [
      {
        origin: 'aluy-global',
        config: {
          servers: [
            { name: 'fs', command: 'npx', args: ['@x/fs'], env: {} },
            { name: 'off', command: 'npx', args: ['@x/off'], env: {}, disabled: true },
          ],
        },
      },
    ];
    const listing = buildMcpListing(withDisabled, discovery);
    const text = buildMcpNote(listing).lines.join('\n');
    expect(text).toContain('fs — ~/.aluy/mcp.json · ✓ ativo · 2 tools');
    expect(text).toContain('off — ~/.aluy/mcp.json · ○ desativado');
    // server desativado não lista tool nenhuma.
    expect(text).not.toContain('mcp__off__');
  });

  it('propaga erro de config (UX avisa)', () => {
    const note = buildMcpNote([], 'mcp.json: JSON inválido');
    expect(note.lines.join('\n')).toContain('JSON inválido');
  });

  it('Codex aparece como não-gerenciado', () => {
    const listing = buildMcpListing(sources, discovery);
    const note = buildMcpNote(listing);
    expect(note.lines.join('\n')).toContain('não-gerenciado');
  });
});
