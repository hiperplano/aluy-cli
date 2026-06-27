// EST-1015 — ENDURECIMENTO de cobertura do registry-format.ts.
//
// Testes PUROS: monta RegistrySearchResult manualmente e afirma substrings na
// saída de formatSearchOutcome. Cobre os ramos de formatOne (transporte não-stdio,
// env requerida, server remoto, sem pacote local) e shellQuote (token com caractere
// especial). Reusa o shape EXATO de RegistrySearchResult e RegistrySearchOutcome.

import { describe, expect, it } from 'vitest';
import { formatSearchOutcome, type RegistrySearchOutcome } from '../../src/index.js';

/** Helper: monta um outcome ok com os results dados. */
function okOutcome(
  results: RegistrySearchOutcome extends { ok: true } ? RegistrySearchOutcome['results'] : never,
): string {
  return formatSearchOutcome({ ok: true, query: 'teste', results } as RegistrySearchOutcome & {
    ok: true;
  });
}

/** Helper: um result instalável (com command/args) mínimo. */
function installableResult(
  overrides: Partial<
    RegistrySearchOutcome extends { ok: true } ? RegistrySearchOutcome['results'][number] : never
  > = {},
) {
  return {
    name: 'io.github.test/my-server',
    description: 'A test server for coverage.',
    run: {
      command: 'npx',
      args: ['-y', '@test/server'],
      env: [],
      remoteUrls: [],
      ...overrides.run,
    },
    ...overrides,
  };
}

describe('formatSearchOutcome — cobertura EST-1015', () => {
  // ── (1) TRANSPORTE não-stdio ──────────────────────────────────────────────
  it('transporte não-stdio (sse) mostra o aviso de transporte', () => {
    const r = installableResult({
      run: {
        command: 'npx',
        args: ['-y', '@test/server'],
        transport: 'sse',
        env: [],
        remoteUrls: [],
      },
    });
    const text = okOutcome([r]);
    expect(text).toContain('transporte');
    expect(text).toContain('sse');
    expect(text).toContain('stdio');
  });

  // ── (2) ENV REQUERIDA ────────────────────────────────────────────────────
  it('env requerida mostra as variáveis obrigatórias', () => {
    const r = installableResult({
      run: {
        command: 'npx',
        args: ['-y', '@test/server'],
        transport: 'stdio',
        env: [
          { name: 'API_KEY', required: true },
          { name: 'OPTIONAL_VAR', required: false },
        ],
        remoteUrls: [],
      },
    });
    const text = okOutcome([r]);
    expect(text).toContain('requer env');
    expect(text).toContain('API_KEY');
    // A variável opcional NÃO aparece na linha "requer env" (só required)
    expect(text).not.toContain('OPTIONAL_VAR');
  });

  // ── (3) SERVER REMOTO (sem pacote local, com remoteUrls) ─────────────────
  it('server remoto (sem comando local, com remoteUrls) mostra REMOTO e a URL', () => {
    const r = {
      name: 'ac.inference.sh/mcp',
      description: 'Run AI apps remotely.',
      run: {
        command: undefined,
        args: [],
        env: [],
        remoteUrls: ['https://remoto.example/mcp'],
      },
    };
    const text = okOutcome([r]);
    expect(text).toContain('REMOTO');
    expect(text).toContain('https://remoto.example/mcp');
  });

  // ── (4) SEM PACOTE LOCAL (sem comando E sem remoteUrls) ──────────────────
  it('sem pacote local e sem remoteUrls mostra "sem pacote local"', () => {
    const r = {
      name: 'io.github.unknown/orphan',
      description: 'No package info available.',
      run: {
        command: undefined,
        args: [],
        env: [],
        remoteUrls: [],
      },
    };
    const text = okOutcome([r]);
    expect(text).toContain('sem pacote local');
  });

  // ── (5) shellQuote — token com caractere especial ────────────────────────
  it('arg com espaço é quotado com aspas simples no comando add', () => {
    // O addCommandFor faz shellQuote em cada arg. Um arg com espaço vira 'arg com espaco'.
    const r = installableResult({
      run: {
        command: 'npx',
        args: ['-y', '@test/server', '/caminho/com espaco'],
        env: [],
        remoteUrls: [],
      },
    });
    const text = okOutcome([r]);
    // O arg com espaço deve aparecer quotado com aspas simples
    expect(text).toContain("'/caminho/com espaco'");
  });

  it('token com aspas simples é escapado no shellQuote', () => {
    // shellQuote: `'` dentro do token vira `'\''` (a string 'it'\''s')
    const r = installableResult({
      name: "io.github.test/it's-broken",
      run: {
        command: 'npx',
        // O nome do server vira "it's-broken" via suggestServerName — que contém aspas
        args: ["it's-broken"],
        env: [],
        remoteUrls: [],
      },
    });
    const text = okOutcome([r]);
    // suggestServerName limpa o nome, mas o arg "it's-broken" contém aspas
    expect(text).toContain("'it'\\''s-broken'");
  });

  // ── (6) Sanity: outcome.ok = false ───────────────────────────────────────
  it('outcome com erro mostra o reason', () => {
    const text = formatSearchOutcome({
      ok: false,
      query: 'x',
      reason: 'registro MCP indisponível (host): timeout de 5000ms',
    });
    expect(text).toContain('⚠');
    expect(text).toContain('timeout de 5000ms');
  });

  // ── (7) Sanity: results vazios ───────────────────────────────────────────
  it('results vazios mostra "nenhum server encontrado"', () => {
    const text = formatSearchOutcome({ ok: true, query: 'nada', results: [] });
    expect(text).toContain('nenhum server encontrado');
    expect(text).toContain('nada');
  });
});
