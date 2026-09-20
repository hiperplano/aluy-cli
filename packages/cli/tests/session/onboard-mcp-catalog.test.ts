// O passo de MCPs do `aluy onboard` (multi-select opcional, antes dos sidecars) grava os
// escolhidos no ~/.aluy/mcp.json. Este teste cobre o RISCO real: que cada entrada do
// catálogo curado seja BEM-FORMADA (command/args não-vazios) e seja ACEITA pelo writer
// real, produzindo um mcp.json válido. (A UI/Ink em si é verificada no TTY pelo dono.)

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpCatalog } from '../../src/session/onboard.js';
import { McpConfigWriter } from '../../src/mcp/mcp-config-writer.js';

describe('onboard — catálogo de MCPs', () => {
  it('toda entrada é bem-formada (id/label/command/args)', () => {
    const cat = mcpCatalog();
    expect(cat.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const m of cat) {
      expect(m.id).toMatch(/^[a-z0-9-]+$/); // id seguro (vira chave do mcp.json)
      expect(ids.has(m.id)).toBe(false); // sem duplicata
      ids.add(m.id);
      expect(m.label.trim()).not.toBe('');
      expect(m.command.trim()).not.toBe('');
      expect(m.args.length).toBeGreaterThan(0);
      // os curados rodam via npx (Node) ou uvx (Python, ex.: RPA) — fetch na 1ª vez.
      expect(['npx', 'uvx']).toContain(m.command);
    }
  });

  // ACHADO REAL: o catálogo oferecia `uvx aluy-mcp-rpa`, e o pacote NÃO existe no PyPI
  // (`/pypi/aluy-mcp-rpa/json` ⇒ 404). Quem aceitava a oferta no onboard recebia um erro
  // no PRIMEIRO contato com o produto. O teste acima passava: a entrada era BEM-FORMADA,
  // só apontava para o nada. Bem-formado não é instalável — por isso este teste olha o
  // ALVO, e não a forma. Quando o pacote for publicado, é só trocar a expectativa para o
  // nome puro (e tirar o `--from`).
  it('o RPA aponta para uma origem que EXISTE (git), não para um nome ausente no PyPI', () => {
    const rpa = mcpCatalog().find((m) => m.id === 'rpa');
    expect(rpa, 'a entrada rpa sumiu do catálogo').toBeDefined();
    expect(rpa!.command).toBe('uvx');
    expect(rpa!.args).toEqual([
      '--from',
      'git+https://github.com/hiperplano/aluy-mcp-rpa',
      'aluy-mcp-rpa',
    ]);
  });

  it('cada entrada é ACEITA pelo writer real e vira um mcp.json válido', () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-onboard-mcp-'));
    try {
      const file = join(base, 'mcp.json');
      const writer = new McpConfigWriter({ file });
      for (const m of mcpCatalog()) {
        expect(() =>
          writer.add(
            { name: m.id, command: m.command, args: [...m.args], env: {} },
            { force: true },
          ),
        ).not.toThrow();
      }
      expect(existsSync(file)).toBe(true);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      const names = Object.keys(parsed.mcpServers ?? {});
      // todos os do catálogo entraram.
      for (const m of mcpCatalog()) expect(names).toContain(m.id);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
