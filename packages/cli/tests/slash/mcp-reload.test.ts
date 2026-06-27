// `/mcp reload` é um STUB HONESTO: a descoberta de MCP roda SÓ no boot (setupMcp),
// e recarregar ao vivo exigiria re-plumbar o toolset fixado na construção
// (spawner/mcpSetup) + catraca p/ o ato de CONECTAR — adiado. Esta bateria prova:
//   (1) isMcpReload: parse exato (`reload`, case-insensitive), sem engolir search/lista;
//   (2) mcpReloadStubNote: diz a VERDADE (reiniciar; descoberta no boot);
//   (3) NÃO regride o /mcp existente (#81/#94): `/mcp` puro e `search` seguem como eram.
//
// FRUGAL: puro (sem rede, sem modelo, sem processo).

import { describe, expect, it } from 'vitest';
import { isMcpReload, mcpReloadStubNote, parseMcpSlash } from '../../src/slash/handlers.js';

describe('isMcpReload — só `reload` exato vira o stub', () => {
  it('`/mcp reload` ⇒ true (com espaços e case-insensitive)', () => {
    expect(isMcpReload('reload')).toBe(true);
    expect(isMcpReload('  reload  ')).toBe(true);
    expect(isMcpReload('RELOAD')).toBe(true);
  });

  it('NÃO engole a listagem nem a busca (#81/#94 intactos)', () => {
    expect(isMcpReload('')).toBe(false); // `/mcp` puro ⇒ listagem
    expect(isMcpReload('search github')).toBe(false); // busca segue p/ o search
    expect(isMcpReload('reloaded')).toBe(false); // não confunde prefixo
    expect(isMcpReload('reload agora')).toBe(false); // reload não tem args
  });

  it('parseMcpSlash NÃO mudou: `reload` continua null p/ o parser de search', () => {
    // (a rota do reload é checada ANTES no run.tsx; o parser de search fica intacto)
    expect(parseMcpSlash('reload')).toBeNull();
    expect(parseMcpSlash('search x')).toEqual({ query: 'x' });
    expect(parseMcpSlash('')).toBeNull();
  });
});

describe('mcpReloadStubNote — stub HONESTO (não finge recarregar)', () => {
  it('explica que a descoberta é no BOOT e manda REINICIAR a sessão', () => {
    const note = mcpReloadStubNote();
    const text = note.lines.join('\n');
    expect(note.title).toBe('mcp');
    expect(text).toContain('BOOT');
    expect(text).toContain('reinicie a sessão');
    expect(text).toContain('aluy mcp add');
  });

  it('aponta o follow-up registrado (FU-VAU-002)', () => {
    const text = mcpReloadStubNote().lines.join('\n');
    expect(text).toContain('FU-VAU-002');
  });

  it('NÃO promete reload ao vivo (sem "recarregado"/"feito")', () => {
    const text = mcpReloadStubNote().lines.join('\n').toLowerCase();
    expect(text).not.toContain('recarregado');
    expect(text).not.toContain('reconectado');
  });
});
