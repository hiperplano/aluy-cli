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

// Reorg (queixa do Tiago: "cadê os mcp's organizados") — a lista agora tem um resumo
// no topo, AGRUPA por estado (ativos < erro < desativado < sem descoberta) em vez da
// ordem arbitrária de declaração, separa cada server com linha em branco (sem virar
// texto corrido) e mostra as tools numa TABELA (não bullets soltos).
describe('buildMcpNote — reorganização da lista (resumo + grupos + tabela)', () => {
  const mixed: McpSource[] = [
    // Declarados FORA de ordem de estado de propósito — a saída deve reordenar.
    { origin: 'codex', config: { servers: [{ name: 'zeta', command: 'z', args: [], env: {} }] } },
    {
      origin: 'aluy-global',
      config: {
        servers: [
          { name: 'alpha', command: 'a', args: [], env: {} }, // ok
          { name: 'beta', command: 'b', args: [], env: {}, disabled: true }, // desativado
          { name: 'gamma', command: 'g', args: [], env: {} }, // erro
        ],
      },
    },
  ];
  const disc: McpDiscoveryResult = {
    servers: [
      {
        server: 'alpha',
        ok: true,
        tools: [{ server: 'alpha', descriptor: { name: 'do', description: 'faz algo' }, transport: {} as never }],
      },
      { server: 'gamma', ok: false, tools: [], error: 'timeout' },
      // zeta: sem entrada ⇒ fica 'unknown'.
    ],
    tools: [],
    transports: [],
  };

  it('resumo no topo conta servers/estados/tools', () => {
    const note = buildMcpNote(buildMcpListing(mixed, disc));
    expect(note.lines[0]).toBe(
      '4 servers MCP — ✓ 1 ativo · ✗ 1 erro · ○ 1 desativado · ? 1 sem descoberta · 1 tool no total',
    );
  });

  it('agrupa: ativos aparecem antes de erro, erro antes de desativado, desativado antes de sem-descoberta', () => {
    const text = buildMcpNote(buildMcpListing(mixed, disc)).lines.join('\n');
    const iAlpha = text.indexOf('alpha —');
    const iGamma = text.indexOf('gamma —');
    const iBeta = text.indexOf('beta —');
    const iZeta = text.indexOf('zeta —');
    expect(iAlpha).toBeGreaterThan(-1);
    expect(iGamma).toBeGreaterThan(iAlpha);
    expect(iBeta).toBeGreaterThan(iGamma);
    expect(iZeta).toBeGreaterThan(iBeta);
  });

  it('cada grupo tem cabeçalho com a contagem', () => {
    const lines = buildMcpNote(buildMcpListing(mixed, disc)).lines;
    expect(lines).toContain('ativos (1) — conectados, com as tools descobertas:');
    expect(lines).toContain('com erro (1) — falharam a conexão:');
    expect(lines).toContain('desativados (1) — off na config, a descoberta pulou:');
    expect(lines).toContain('sem descoberta (1) — sem handshake nesta vista:');
  });

  it('separa cada server com linha em branco — não é mais texto corrido', () => {
    const lines = buildMcpNote(buildMcpListing(mixed, disc)).lines;
    const iAlphaLine = lines.findIndex((l) => l.startsWith('alpha —'));
    expect(iAlphaLine).toBeGreaterThan(0);
    expect(lines[iAlphaLine - 1]).toBe('ativos (1) — conectados, com as tools descobertas:');
    const iGammaLine = lines.findIndex((l) => l.startsWith('gamma —'));
    // gamma é o único do grupo "com erro" — precedido pelo cabeçalho do grupo, não colado no server anterior.
    expect(lines[iGammaLine - 1]).toBe('com erro (1) — falharam a conexão:');
  });

  it('tools aparecem numa tabela com bordas (não bullets soltos)', () => {
    const text = buildMcpNote(buildMcpListing(mixed, disc)).lines.join('\n');
    expect(text).toContain('┌');
    expect(text).toContain('│ tool');
    expect(text).toContain('descrição');
    expect(text).toContain('mcp__alpha__do');
    expect(text).toContain('faz algo');
    expect(text).not.toContain('• mcp__alpha__do'); // não é mais bullet solto.
  });
});
