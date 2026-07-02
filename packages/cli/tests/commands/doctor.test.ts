// EST-0970 — `aluy doctor` (shell): contrato de EXIT CODE — ✗ ⇒ exit≠0; tudo ok/⚠ ⇒
// exit 0. Injeta o probe inteiro (fatos prontos) — sem keychain/rede/fs reais.

import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/commands/doctor.js';
import type { TerminalIO } from '../../src/auth/io.js';
import type { DoctorFacts } from '../../src/doctor/checks.js';
import type { DoctorProbeDeps } from '../../src/doctor/probe.js';

function fakeIO(): { io: TerminalIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => '',
    },
  };
}

function allOk(): DoctorFacts {
  return {
    auth: { present: true, keychainAvailable: true, user: 'u', org: 'o', kind: 'device' },
    broker: { url: 'https://b.test', probe: { reached: true, status: 200 } },
    catalog: {
      tiers: { reached: true, status: 200 },
      custom: { reached: true, status: 200 },
      customCount: 2,
    },
    mcp: { servers: [], configErrors: [] },
    agents: { validCount: 1, rejected: [] },
    config: {
      exists: true,
      corrupted: false,
      theme: 'aluy-dark',
      maxTokens: 1000,
      maxIterations: 300,
      flags: [],
    },
    version: { aluy: '0.0.0', node: 'v24' },
    memory: { accessible: true, count: 3 },
    sidecars: {
      headroom: { reached: true, status: 200 },
      ollama: { reached: true, status: 200 },
      mem0: { reached: true, status: 200 },
      profile: 'turbo',
      toggles: ['ollama', 'mem0'],
    },
    maestro: { enabled: true },
  };
}

/** Probe que devolve os fatos prontos (override de cada gatherer). */
function probeOf(facts: DoctorFacts): DoctorProbeDeps {
  return {
    gatherAuth: async () => facts.auth,
    gatherBroker: async () => facts.broker,
    gatherCatalog: async () => facts.catalog,
    gatherMcp: async () => facts.mcp,
    gatherAgents: async () => facts.agents,
    gatherConfig: async () => facts.config,
    gatherMemory: async () => facts.memory,
    gatherSidecars: async () => facts.sidecars,
  };
}

describe('aluy doctor — exit code', () => {
  it('tudo ok ⇒ exit 0 e imprime o relatório', async () => {
    const { io, out } = fakeIO();
    const code = await runDoctor({ io, probe: probeOf(allOk()) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('aluy doctor');
    expect(out.join('\n')).toContain('resumo:');
  });

  it('um ✗ (sem credencial) ⇒ exit 1', async () => {
    const facts = { ...allOk(), auth: { present: false, keychainAvailable: true } };
    const { io } = fakeIO();
    const code = await runDoctor({ io, probe: probeOf(facts) });
    expect(code).toBe(1);
  });

  it('broker fora ⇒ exit 1 (✗ no broker)', async () => {
    const facts: DoctorFacts = {
      ...allOk(),
      broker: { url: 'https://b.test', probe: { reached: false } },
    };
    const { io } = fakeIO();
    const code = await runDoctor({ io, probe: probeOf(facts) });
    expect(code).toBe(1);
  });

  it('só avisos (catálogo 401 fallback) ⇒ exit 0 (⚠ não derruba)', async () => {
    const facts: DoctorFacts = {
      ...allOk(),
      catalog: { tiers: { reached: true, status: 401 }, custom: { reached: true, status: 401 } },
    };
    const { io } = fakeIO();
    const code = await runDoctor({ io, probe: probeOf(facts) });
    expect(code).toBe(0);
  });

  it('config corrompido ⇒ exit 1', async () => {
    const facts: DoctorFacts = {
      ...allOk(),
      config: { ...allOk().config, corrupted: true },
    };
    const { io } = fakeIO();
    const code = await runDoctor({ io, probe: probeOf(facts) });
    expect(code).toBe(1);
  });

  it('ticks PROGRESSIVOS: imprime "testando…" antes e a linha final por check', async () => {
    const { io, out } = fakeIO();
    await runDoctor({ io, probe: probeOf(allOk()) });
    const text = out.join('\n');
    expect(text).toContain('testando…'); // a linha pendente de cada item
    expect(text).toContain('credencial:'); // a linha final do check de credencial
  });

  it('SEM --deep: NÃO há linha de tier (default não chama modelo)', async () => {
    const { io, out } = fakeIO();
    await runDoctor({ io, probe: probeOf(allOk()) });
    expect(out.join('\n')).not.toContain('tier (--deep)');
  });

  it('--deep (tierTester mockado): adiciona a linha de tier ✓; tier que falha ⇒ exit 1', async () => {
    const okProbe: DoctorProbeDeps = {
      // F182 — tier de BROKER exige backend broker explícito (num box local/BYO o
      // probe marca o tier N/A e o tester não roda).
      env: { ALUY_BACKEND: 'broker', ALUY_BROKER_URL: 'https://broker.test' },
      ...probeOf(allOk()),
      tierTester: async () => ({ tier: 'aluy-granito', responded: true }),
    };
    const ok = fakeIO();
    const okCode = await runDoctor({ io: ok.io, probe: okProbe });
    expect(okCode).toBe(0);
    expect(ok.out.join('\n')).toContain('tier (--deep)');

    const badProbe: DoctorProbeDeps = {
      env: { ALUY_BACKEND: 'broker', ALUY_BROKER_URL: 'https://broker.test' },
      ...probeOf(allOk()),
      tierTester: async () => ({ tier: 'aluy-flux', responded: false, error: 'sem crédito' }),
    };
    const bad = fakeIO();
    const badCode = await runDoctor({ io: bad.io, probe: badProbe });
    expect(badCode).toBe(1);
    expect(bad.out.join('\n')).toContain('sem crédito');
  });
});
