// EST-0970 — testes do PROBE do `/doctor`: cada gatherer coleta o fato certo SEM I/O
// real (fetch mockado p/ broker 200/401/timeout; tmpdir p/ mcp.json com `--`, perfil
// .md rejeitado, config corrompido). Frugal: NUNCA toca rede/keychain/HOME reais.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherDoctorFacts, validateAuth, type DoctorProbeDeps } from '../../src/doctor/probe.js';
import type { McpServerConfig, McpToolDescriptor, McpTransport, StreamFetch } from '@hiperplano/aluy-cli-core';

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'doctor-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'doctor-ws-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** Fetch fake roteado por substring de URL → {status, json?} ou erro (timeout). */
function fakeFetch(
  routes: Record<string, { status: number; json?: unknown } | 'throw'>,
): StreamFetch {
  return (async (url: string) => {
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (res === 'throw') throw new Error('network down');
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.json ?? {},
        };
      }
    }
    throw new Error(`rota inesperada: ${url}`);
  }) as unknown as StreamFetch;
}

/** Base deps que NEUTRALIZAM keychain/memória reais (overrides de auth/memory). */
function baseDeps(extra: Partial<DoctorProbeDeps> = {}): DoctorProbeDeps {
  return {
    aluyHome: home,
    workspaceRoot: workspace,
    env: { ALUY_BROKER_URL: 'https://broker.test' },
    // auth real toca o keychain do SO — não na suíte; injetamos o fato direto.
    gatherAuth: async () => ({
      present: true,
      keychainAvailable: true,
      user: 'u',
      org: 'o',
      kind: 'device',
    }),
    memory: { count: async () => 0 },
    ...extra,
  };
}

describe('doctor/probe — broker (#2)', () => {
  it('healthz 200 ⇒ reached + status 200', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
      }),
    );
    expect(facts.broker.url).toBe('https://broker.test');
    expect(facts.broker.probe).toEqual({ reached: true, status: 200 });
  });

  it('healthz throw (timeout) ⇒ reached:false', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': 'throw', '/v1/': 'throw' }) }),
    );
    expect(facts.broker.probe.reached).toBe(false);
  });

  it('healthz 401 ⇒ reached:true status 401 (o mapeamento p/ ✗ é da camada de checks)', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 401 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.broker.probe).toEqual({ reached: true, status: 401 });
  });
});

describe('doctor/probe — catálogo/custom (#3)', () => {
  it('tiers 200 + custom 200 com data[] ⇒ conta os modelos', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        getAccessToken: async () => 'tok',
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/tiers/catalog': { status: 200 },
          '/v1/models/custom': { status: 200, json: { data: [{ id: 'a' }, { id: 'b' }] } },
        }),
      }),
    );
    expect(facts.catalog.tiers.status).toBe(200);
    expect(facts.catalog.custom.status).toBe(200);
    expect(facts.catalog.customCount).toBe(2);
  });

  it('tiers 401 (sem scope) ⇒ status 401 (a camada o trata como ⚠ fallback)', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        getAccessToken: async () => 'tok',
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/tiers/catalog': { status: 401 },
          '/v1/models/custom': { status: 401 },
        }),
      }),
    );
    expect(facts.catalog.tiers.status).toBe(401);
    expect(facts.catalog.customCount).toBeUndefined();
  });
});

describe('doctor/probe — MCP (#4)', () => {
  it('mcp.json com command `--` legado ⇒ server invalid + warning', async () => {
    const cfg = { mcpServers: { legacy: { command: '--', args: ['echo', 'hi'] } } };
    writeFileSync(join(home, 'mcp.json'), JSON.stringify(cfg));
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    const legacy = facts.mcp.servers.find((s) => s.name === 'legacy');
    expect(legacy?.invalid).toBe(true);
    expect(legacy?.invalidWarning).toBeDefined();
    expect(facts.mcp.configErrors).toHaveLength(0);
  });

  it('mcp.json com JSON inválido ⇒ configErrors não-vazio', async () => {
    writeFileSync(join(home, 'mcp.json'), '{ not json');
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.mcp.configErrors.length).toBeGreaterThan(0);
  });

  it('sem nenhuma config ⇒ zero servers, zero erros', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.mcp.servers).toHaveLength(0);
    expect(facts.mcp.configErrors).toHaveLength(0);
  });
});

describe('doctor/probe — perfis de agente (#5)', () => {
  it('um .md válido + um rejeitado (tools ilegível) ⇒ validCount=1, rejected=1', async () => {
    const agentsDir = join(home, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    // válido: frontmatter com name + corpo (tools ausente = herda, OK).
    writeFileSync(join(agentsDir, 'bom.md'), '---\nname: bom\n---\nfaz coisas boas.');
    // rejeitado: `tools:` PRESENTE mas ilegível (string solta, não-lista) ⇒ RES-MD-3.
    writeFileSync(join(agentsDir, 'saudador.md'), '---\nname: saudador\ntools: \n---\nsauda.');
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.agents.validCount).toBe(1);
    expect(facts.agents.rejected.map((r) => r.file)).toContain('saudador.md');
    expect(facts.agents.rejected[0]?.reason).toMatch(/RES-MD-3|tools/i);
  });

  it('sem dir de agentes ⇒ zero válidos, zero rejeitados (fail-safe)', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.agents.validCount).toBe(0);
    expect(facts.agents.rejected).toHaveLength(0);
  });
});

describe('doctor/probe — config (#6)', () => {
  it('config.json válido ⇒ exists, não-corrompido, lê theme/tier + limites efetivos', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ theme: 'aluy-dark', tier: 'aluy-deep' }),
    );
    const facts = await gatherDoctorFacts(
      baseDeps({
        env: { ALUY_BROKER_URL: 'https://broker.test', ALUY_MAX_ITERATIONS: '120' },
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
      }),
    );
    expect(facts.config.exists).toBe(true);
    expect(facts.config.corrupted).toBe(false);
    expect(facts.config.theme).toBe('aluy-dark');
    expect(facts.config.tier).toBe('aluy-deep');
    expect(facts.config.maxIterations).toBe(120);
  });

  it('config.json corrompido (JSON inválido) ⇒ exists + corrupted', async () => {
    writeFileSync(join(home, 'config.json'), '{ corrompido');
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.config.exists).toBe(true);
    expect(facts.config.corrupted).toBe(true);
  });

  it('config ausente ⇒ exists:false, não-corrompido (1ª execução = defaults)', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.config.exists).toBe(false);
    expect(facts.config.corrupted).toBe(false);
  });

  it('flags efetivas: ALUY_NATIVE_TOOLS_OFF + extraFlags (--yolo) aparecem', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        env: { ALUY_BROKER_URL: 'https://broker.test', ALUY_NATIVE_TOOLS_OFF: '1' },
        extraFlags: ['--yolo'],
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
      }),
    );
    expect(facts.config.flags).toContain('ALUY_NATIVE_TOOLS_OFF');
    expect(facts.config.flags).toContain('--yolo');
  });
});

describe('doctor/probe — memória (#8) e versão (#7)', () => {
  it('contador devolve null ⇒ store inacessível', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        memory: { count: async () => null },
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
      }),
    );
    expect(facts.memory.accessible).toBe(false);
  });

  it('contador devolve N ⇒ acessível com a contagem; versão traz aluy + node', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        memory: { count: async () => 7 },
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
      }),
    );
    expect(facts.memory).toEqual({ accessible: true, count: 7 });
    expect(facts.version.aluy).toBeTruthy();
    expect(facts.version.node).toBe(process.version);
  });
});

describe('doctor/probe — degradação independente', () => {
  it('broker fora NÃO impede ler mcp/config/agentes (cada check é isolado)', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ theme: 'aluy-dark' }));
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': 'throw', '/v1/': 'throw' }) }),
    );
    expect(facts.broker.probe.reached).toBe(false); // broker fora
    expect(facts.config.exists).toBe(true); // mas config foi lida
    expect(facts.config.theme).toBe('aluy-dark');
  });
});

// ── EST-0970: validação ATIVA da credencial via GET /v1/quota ─────────────────
// (testa `validateAuth` direto: o `gatherAuth` real toca o keychain do SO — fora da
// suíte; é o `gatherAuth` quem mescla este resultado no `AuthFact`.)
describe('doctor/probe — credencial AUTENTICA via GET (#1)', () => {
  const env = { ALUY_BROKER_URL: 'https://broker.test' };

  it('quota 200 ⇒ authValidated:true (GET sem body — #123)', async () => {
    const v = await validateAuth({
      env,
      getAccessToken: async () => 'tok',
      fetch: fakeFetch({ '/v1/quota': { status: 200, json: { windows: [] } } }),
    });
    expect(v.authValidated).toBe(true);
    expect(v.authStatus).toBe(200);
  });

  it('quota 401 ⇒ authValidated:false (credencial recusada — rode aluy login)', async () => {
    const v = await validateAuth({
      env,
      getAccessToken: async () => 'tok',
      fetch: fakeFetch({ '/v1/quota': { status: 401 } }),
    });
    expect(v.authValidated).toBe(false);
    expect(v.authStatus).toBe(401);
  });

  it('sem getAccessToken ⇒ não-validado (NÃO ✗): authValidated undefined', async () => {
    const v = await validateAuth({ env, fetch: fakeFetch({ '/v1/quota': { status: 200 } }) });
    expect(v.authValidated).toBeUndefined();
  });

  it('broker fora (timeout) ⇒ não-validado (degrada): authValidated undefined', async () => {
    const v = await validateAuth({
      env,
      getAccessToken: async () => 'tok',
      fetch: fakeFetch({ '/v1/quota': 'throw' }),
    });
    expect(v.authValidated).toBeUndefined();
  });
});

// ── EST-0970: MCP conecta de verdade (handshake real, conta tools) ────────────
/** Transport mock: por nome de server, devolve N tools ok OU lança (falha de conexão). */
function fakeTransport(
  plan: Record<string, number | 'throw'>,
): (s: McpServerConfig) => McpTransport {
  return (server) => ({
    async connect(): Promise<readonly McpToolDescriptor[]> {
      const v = plan[server.name];
      if (v === 'throw' || v === undefined) throw new Error(`não subiu: ${server.name}`);
      return Array.from({ length: v }, (_, i) => ({ name: `t${i}`, description: '' }));
    },
    async callTool() {
      return { ok: true, content: '' };
    },
    async close() {},
  });
}

describe('doctor/probe — MCP CONECTA de verdade (#4)', () => {
  it('1 server ok (3 tools) + 1 que falha ⇒ connected/toolCount e connectError', async () => {
    const cfg = {
      mcpServers: {
        good: { command: 'node', args: ['srv.js'] },
        bad: { command: 'node', args: ['nope.js'] },
      },
    };
    writeFileSync(join(home, 'mcp.json'), JSON.stringify(cfg));
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
        makeMcpTransport: fakeTransport({ good: 3, bad: 'throw' }),
      }),
    );
    const good = facts.mcp.servers.find((s) => s.name === 'good');
    const bad = facts.mcp.servers.find((s) => s.name === 'bad');
    expect(good?.connected).toBe(true);
    expect(good?.toolCount).toBe(3);
    expect(bad?.connected).toBe(false);
    expect(bad?.connectError).toContain('não subiu');
  });

  it('close() que PENDURA NÃO trava o doctor (timeout no cleanup — bug real do MCP/playwright)', async () => {
    const cfg = { mcpServers: { hangs: { command: 'node', args: ['srv.js'] } } };
    writeFileSync(join(home, 'mcp.json'), JSON.stringify(cfg));
    // connect OK, mas o close() NUNCA resolve (server que não fecha limpo — playwright
    // com browser aberto). ANTES do fix isso pendurava o gatherMcp ⇒ checklist eterna.
    const hangingClose = (): McpTransport => ({
      async connect(): Promise<readonly McpToolDescriptor[]> {
        return [{ name: 't0', description: '' }];
      },
      async callTool() {
        return { ok: true, content: '' };
      },
      close() {
        return new Promise<void>(() => {}); // PENDURA pra sempre
      },
    });
    const t0 = Date.now();
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
        makeMcpTransport: () => hangingClose(),
      }),
    );
    // COMPLETOU (não pendurou): o handshake pegou as tools E o close degradou no timeout.
    expect(facts.mcp.servers.find((s) => s.name === 'hangs')?.connected).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000); // bem longe de "infinito"
  }, 10_000);

  it('SEM makeMcpTransport ⇒ não conecta (só lê — sem regressão #120)', async () => {
    const cfg = { mcpServers: { good: { command: 'node', args: ['srv.js'] } } };
    writeFileSync(join(home, 'mcp.json'), JSON.stringify(cfg));
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.mcp.servers[0]?.connected).toBeUndefined();
  });

  // ── HUNT-MCP — VAZAMENTO no TIMEOUT GLOBAL da coleta MCP ──────────────────────
  // Bug (probe.ts `connectMcp`): o cleanup que FECHA os transports só rodava quando a
  // descoberta VENCIA a corrida contra o teto GLOBAL (15s). Se o teto global vencesse
  // (vários servers lentos ⇒ a descoberta SEQUENCIAL ultrapassa 15s), o `connectMcp`
  // retornava `Map()` e ABANDONAVA a descoberta viva — os servers que ela JÁ tinha
  // spawnado (handshake concluído) NUNCA eram fechados ⇒ processos ÓRFÃOS (handle vaza).
  // Prova: um server ATIVO conecta cedo (transport coletado) e outro pendura até DEPOIS
  // do teto global; quando a descoberta enfim resolve, o `close()` do transport coletado
  // DEVE ser chamado. SEM o fix, nunca é. Driver via fake timers (determinístico, sem
  // esperar 15s reais e SEM processo MCP real — transports injetados).
  it('timeout GLOBAL vence ⇒ os transports já spawnados são FECHADOS (não orfana)', async () => {
    vi.useFakeTimers();
    try {
      // A descoberta é SEQUENCIAL: `fast` conecta em ~5s (coletado), depois DOIS servers
      // que penduram — cada um cortado pelo teto POR-SERVER (6s). Total ≈ 5+6+6 = 17s >
      // 15s do teto GLOBAL ⇒ o global vence a corrida ENQUANTO a descoberta ainda corre.
      const cfg = {
        mcpServers: {
          fast: { command: 'node', args: ['a.js'] }, // conecta cedo (transport coletado)
          slow1: { command: 'node', args: ['b.js'] }, // pendura (cortado em 6s)
          slow2: { command: 'node', args: ['c.js'] }, // pendura (cortado em +6s ⇒ >15s)
        },
      };
      writeFileSync(join(home, 'mcp.json'), JSON.stringify(cfg));

      const fastClose = vi.fn(async () => {});
      const makeMcpTransport = (server: McpServerConfig): McpTransport => {
        if (server.name === 'fast') {
          return {
            connect: () =>
              new Promise<readonly McpToolDescriptor[]>((resolve) =>
                setTimeout(() => resolve([{ name: 't0', description: '' }]), 5_000),
              ),
            callTool: async () => ({ ok: true, content: '' }),
            close: fastClose,
          };
        }
        // `slowN`: connect que nunca assenta sozinho (deixa o teto por-server agir).
        return {
          connect: () => new Promise<readonly McpToolDescriptor[]>(() => {}),
          callTool: async () => ({ ok: true, content: '' }),
          close: async () => {},
        };
      };

      const factsP = gatherDoctorFacts(
        baseDeps({
          fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
          makeMcpTransport,
        }),
      );

      // Avança o relógio o suficiente p/ TODOS os timers correrem: `fast` conecta (5s),
      // o teto GLOBAL vence (15s) ⇒ gatherMcp degrada e RESOLVE, depois o `slow` é
      // rejeitado pelo teto por-server (6s a partir do connect dele) ⇒ a descoberta
      // abandonada resolve e o cleanup DEFERIDO fecha o transport do `fast`.
      await vi.advanceTimersByTimeAsync(60_000);
      const facts = await factsP;
      // O cleanup do `fast` é DEFERIDO sobre a descoberta abandonada (resolve em ~17s,
      // já dentro dos 60s acima). Drena timers + microtasks remanescentes p/ garantir
      // que a cadeia `discoveryPromise.then(close)` complete antes da asserção.
      await vi.runAllTimersAsync();
      await Promise.resolve();

      // gatherMcp degradou (timeout global ⇒ sem `connected`), mas o cleanup rodou.
      expect(facts.mcp.servers.some((s) => s.name === 'fast')).toBe(true);
      expect(fastClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── EST-0970: config valida os VALORES (tema/tier no catálogo) ────────────────
describe('doctor/probe — config valida VALORES (#6)', () => {
  it('tema/tier válidos ⇒ themeKnown/tierKnown true', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ theme: 'aluy-dark', tier: 'aluy-deep' }),
    );
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.config.themeKnown).toBe(true);
    expect(facts.config.tierKnown).toBe(true);
  });

  it('tema fora do catálogo + tier fantasma ⇒ themeKnown/tierKnown false', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ theme: 'roxo-neon', tier: 'tier-fantasma' }),
    );
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.config.themeKnown).toBe(false);
    expect(facts.config.tierKnown).toBe(false);
  });
});

// ── EST-0970: ticks AO VIVO (onCheck progressivo) + --deep opt-in ─────────────
describe('doctor/probe — ticks ao vivo (onCheck) + --deep', () => {
  it('onCheck dispara por check, terminando com TODOS os ids', async () => {
    const seen: string[] = [];
    await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
        onCheck: (id) => seen.push(id),
      }),
    );
    for (const id of [
      'auth',
      'broker',
      'catalog',
      'mcp',
      'agents',
      'config',
      'version',
      'memory',
    ]) {
      expect(seen).toContain(id);
    }
  });

  it('SEM tierTester ⇒ facts.tier ausente (default NÃO chama modelo)', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({ fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }) }),
    );
    expect(facts.tier).toBeUndefined();
  });

  it('COM tierTester (--deep, mockado) ⇒ facts.tier presente + onCheck("tier")', async () => {
    const seen: string[] = [];
    let tested = false;
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({ '/healthz': { status: 200 }, '/v1/': { status: 401 } }),
        onCheck: (id) => seen.push(id),
        tierTester: async () => {
          tested = true;
          return { tier: 'aluy-granito', responded: true };
        },
      }),
    );
    expect(tested).toBe(true);
    expect(facts.tier).toEqual({ tier: 'aluy-granito', responded: true });
    expect(seen).toContain('tier');
  });
});

// ── #9 sidecars do Maestro ──────────────────────────────────────────────
describe('doctor/probe — sidecars (#9)', () => {
  it('3 sidecars up + config TURBO ⇒ ok com toggles', async () => {
    const cfg = { profile: 'turbo', sidecarToggles: { ollama: true, mem0: true } };
    writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': { status: 200 },
          '127.0.0.1:11434/api/tags': { status: 200 },
          '127.0.0.1:11435/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.headroom).toEqual({ reached: true, status: 200 });
    expect(facts.sidecars.ollama).toEqual({ reached: true, status: 200 });
    expect(facts.sidecars.mem0).toEqual({ reached: true, status: 200 });
    expect(facts.sidecars.profile).toBe('turbo');
    expect(facts.sidecars.toggles).toEqual(['ollama', 'mem0']);
  });

  it('respeita ALUY_MEM0_URL — proba a URL CONFIGURADA, não a porta hardcodada', async () => {
    const cfg = { profile: 'turbo', sidecarToggles: { ollama: true, mem0: true } };
    writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
    const facts = await gatherDoctorFacts(
      baseDeps({
        env: { ALUY_BROKER_URL: 'https://broker.test', ALUY_MEM0_URL: 'http://10.9.8.7:5555' },
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': { status: 200 },
          '127.0.0.1:11434/api/tags': { status: 200 },
          // SÓ a URL CUSTOM responde. Se o doctor probasse :11435 (hardcoded), cairia
          // em "rota inesperada" ⇒ reached:false. reached:true PROVA que usou a env.
          '10.9.8.7:5555/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.mem0).toEqual({ reached: true, status: 200 });
  });

  it('headroom fora ⇒ SidecarsFact.headroom.reached=false', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ profile: 'turbo' }));
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': 'throw',
          '127.0.0.1:11434/api/tags': { status: 200 },
          '127.0.0.1:11435/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.headroom.reached).toBe(false);
    expect(facts.sidecars.ollama.reached).toBe(true);
    expect(facts.sidecars.mem0.reached).toBe(true);
  });

  it('config ausente ⇒ defaults TURBO + 3-ON', async () => {
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': { status: 200 },
          '127.0.0.1:11434/api/tags': { status: 200 },
          '127.0.0.1:11435/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.profile).toBe('turbo');
    expect(facts.sidecars.toggles).toEqual(['ollama', 'mem0']);
  });

  it('config LEVE ⇒ perfil leve, toggles vazios', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ profile: 'leve', sidecarToggles: { ollama: false, mem0: false } }),
    );
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': { status: 200 },
          '127.0.0.1:11434/api/tags': { status: 200 },
          '127.0.0.1:11435/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.profile).toBe('leve');
    expect(facts.sidecars.toggles).toEqual([]);
  });

  it('config corrompida ⇒ defaults (TURBO/3-ON) — não lança', async () => {
    writeFileSync(join(home, 'config.json'), '{ corrompido');
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': { status: 200 },
          '127.0.0.1:11434/api/tags': { status: 200 },
          '127.0.0.1:11435/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.profile).toBe('turbo');
    expect(facts.sidecars.toggles).toEqual(['ollama', 'mem0']);
  });

  it('sidecar fora NÃO impede os outros (cada probe é independente)', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ profile: 'turbo' }));
    const facts = await gatherDoctorFacts(
      baseDeps({
        fetch: fakeFetch({
          '/healthz': { status: 200 },
          '/v1/': { status: 401 },
          '127.0.0.1:8787/health': 'throw',
          '127.0.0.1:11434/api/tags': 'throw',
          '127.0.0.1:11435/health': { status: 200 },
        }),
      }),
    );
    expect(facts.sidecars.headroom.reached).toBe(false);
    expect(facts.sidecars.ollama.reached).toBe(false);
    expect(facts.sidecars.mem0.reached).toBe(true);
    // sidecars NÃO trava o doctor — auth/broker seguem intactos
    expect(facts.auth.present).toBe(true);
    expect(facts.version.aluy).toBeTruthy();
  });
});
