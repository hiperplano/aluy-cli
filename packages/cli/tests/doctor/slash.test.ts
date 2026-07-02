// EST-0970 — `/doctor` é comando PRÓPRIO do menu (não subcomando) e o runner de sessão
// dirige a CHECKLIST PROGRESSIVA: semeia tudo `pending`, "acende" cada tick ao vivo e
// fecha com o resumo. Sem `--deep`, NÃO chama o modelo; com `--deep`, roda o tier ao vivo.

import { describe, expect, it } from 'vitest';
import { routeInput, NATIVE_COMMANDS } from '../../src/slash/commands.js';
import { runDoctorLive, type DoctorLiveState } from '../../src/doctor/slash.js';
import type { LoginService } from '@hiperplano/aluy-cli-core';
import type { DoctorFacts } from '../../src/doctor/checks.js';

function baseFacts(): DoctorFacts {
  return {
    auth: { present: true, keychainAvailable: true, user: 'u', org: 'o', kind: 'device' },
    broker: { url: 'https://b.test', probe: { reached: true, status: 200 } },
    catalog: {
      tiers: { reached: true, status: 200 },
      custom: { reached: true, status: 200 },
      customCount: 0,
    },
    mcp: { servers: [], configErrors: [] },
    agents: { validCount: 0, rejected: [] },
    config: { exists: false, corrupted: false, maxTokens: 1000, maxIterations: 300, flags: [] },
    version: { aluy: '0.0.0', node: 'v24' },
    memory: { accessible: true, count: 5 },
  };
}

function probeFromFacts(f: DoctorFacts) {
  return {
    gatherAuth: async () => f.auth,
    gatherBroker: async () => f.broker,
    gatherCatalog: async () => f.catalog,
    gatherMcp: async () => f.mcp,
    gatherAgents: async () => f.agents,
    gatherConfig: async () => f.config,
    gatherMemory: async () => f.memory,
  };
}

describe('/doctor — menu', () => {
  it('é um comando NATIVO próprio (id doctor), não um subcomando', () => {
    const cmd = NATIVE_COMMANDS.find((c) => c.id === 'doctor');
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe('doctor');
    expect(cmd?.subcommands).toBeUndefined();
  });

  it('`/doctor` roteia p/ o comando doctor', () => {
    const r = routeInput('/doctor');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.id).toBe('doctor');
  });
});

describe('/doctor — runner de sessão (ticks ao vivo)', () => {
  it('semeia tudo pending, usa o token da sessão, acende cada tick e fecha com o resumo', async () => {
    const login = { getAccessToken: async () => 'session-tok' } as unknown as LoginService;
    let tokenUsed = false;
    const facts = { ...baseFacts(), config: { ...baseFacts().config, flags: ['--yolo'] } };

    const states: DoctorLiveState[] = [];
    const final = await runDoctorLive(
      {
        login,
        memory: { count: async () => 5 },
        unsafe: true,
        probeOverride: {
          ...probeFromFacts(facts),
          gatherCatalog: async () => {
            await login.getAccessToken();
            tokenUsed = true;
            return facts.catalog;
          },
        },
      },
      (s) => states.push(s),
    );

    expect(tokenUsed).toBe(true);

    // 1º update: TODOS os checks `pending` (a checklist nasceu inteira pendente).
    const first = states[0]!;
    expect(first.checks.length).toBe(10); // sem --deep ⇒ 10 checks
    expect(first.checks.every((c) => c.status === 'pending')).toBe(true);
    expect(first.summary).toBeUndefined();

    // updates intermediários: ALGUM tick "acendeu" antes do final (progressivo).
    const someLit = states.slice(1, -1).some((s) => s.checks.some((c) => c.status !== 'pending'));
    expect(someLit).toBe(true);

    // estado FINAL: nenhum pendente, com resumo + a flag --yolo da sessão na config.
    expect(final.checks.every((c) => c.status !== 'pending')).toBe(true);
    expect(final.summary).toContain('ok');
    const cfg = final.checks.find((c) => c.id === 'config');
    expect(cfg?.detail).toContain('--yolo');
  });

  it('SEM --deep (sem tierTester): NÃO há check de tier (o modelo NUNCA é chamado)', async () => {
    const login = { getAccessToken: async () => 'tok' } as unknown as LoginService;
    const facts = baseFacts();

    const final = await runDoctorLive(
      {
        login,
        memory: { count: async () => 0 },
        // probeOverride SEM tierTester ⇒ deep=false ⇒ o probe nem agenda o teste de tier.
        probeOverride: { ...probeFromFacts(facts) },
      },
      () => {},
    );

    expect(final.checks.some((c) => c.id === 'tier')).toBe(false);
    expect(final.checks).toHaveLength(10);
  });

  it('COM --deep (tierTester injetado): adiciona o check de tier e o testa', async () => {
    const login = { getAccessToken: async () => 'tok' } as unknown as LoginService;
    let tierTested = false;
    const facts = baseFacts();

    const final = await runDoctorLive(
      {
        login,
        memory: { count: async () => 0 },
        env: { ALUY_BACKEND: 'broker', ALUY_BROKER_URL: 'https://broker.test' },
        probeOverride: {
          ...probeFromFacts(facts),
          tierTester: async () => {
            tierTested = true;
            return { tier: 'aluy-granito', responded: true };
          },
        },
      },
      () => {},
    );

    expect(tierTested).toBe(true);
    const tier = final.checks.find((c) => c.id === 'tier');
    expect(tier).toBeDefined();
    expect(tier?.status).toBe('ok');
    expect(tier?.detail).toContain('aluy-granito');
    expect(final.checks.length).toBe(11); // 10 + o tier do --deep
  });

  it('COM --deep e o tier que NÃO responde ⇒ ✗ no check de tier', async () => {
    const login = { getAccessToken: async () => 'tok' } as unknown as LoginService;
    const facts = baseFacts();

    const final = await runDoctorLive(
      {
        login,
        memory: { count: async () => 0 },
        env: { ALUY_BACKEND: 'broker', ALUY_BROKER_URL: 'https://broker.test' },
        probeOverride: {
          ...probeFromFacts(facts),
          tierTester: async () => ({
            tier: 'aluy-flux',
            responded: false,
            error: 'sem crédito',
          }),
        },
      },
      () => {},
    );

    const tier = final.checks.find((c) => c.id === 'tier');
    expect(tier?.status).toBe('fail');
    expect(tier?.detail).toContain('sem crédito');
    expect(final.summary).toContain('falha');
  });
});
