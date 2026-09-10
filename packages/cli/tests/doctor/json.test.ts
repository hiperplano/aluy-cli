// EST-0970 — `aluy doctor --json`: testa que o JSON impresso no stdout é parseável e
// contém os campos esperados (id, status, label, detail) para cada check, sem os ticks
// da saída normal. Exit code segue o mesmo contrato (≠0 se houver ✗).

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../src/commands/doctor.js';
import type { DoctorFacts } from '../../src/doctor/checks.js';
import type { DoctorProbeDeps } from '../../src/doctor/probe.js';

/** Cria um probe fake a partir de fatos prontos (sem I/O real). */
function probeFromFacts(f: DoctorFacts): Partial<DoctorProbeDeps> {
  return {
    // AMBIENTE DETERMINÍSTICO — sem isto o teste dependia da máquina de quem o rodava.
    //
    // `probeFromFacts` dubla nove coletores, mas o fato do PROVIDER LOCAL não tem um
    // `gather*` injetável: ele é produzido dentro do probe, lendo config e env REAIS
    // (`gatherLocalProvider` em probe.ts). Na máquina do dev há credencial e o check passa;
    // na CI, com HOME limpo, não há — `provider-local` vira `fail` e o exit vira 1. Um
    // teste que se propõe a provar "tudo ok ⇒ exit 0" passava a depender de quem executava.
    //
    // CONSEQUÊNCIA MEDIDA: foi o que reprovou o job `ci` desde a rc.139. Sem release, a
    // dist-tag `rc` do npm congelou na 139 — e era ela que o autoupdate consultava, então
    // nenhuma máquina instalada pelo npm recebeu atualização por ~10 dias.
    //
    // A correção usa as deps que JÁ existem para isso: `aluyHome` (tmpdir, documentado como
    // "injetável p/ tmpdir em teste") e `env` com o backend local + a chave catch-all. Nada
    // é afrouxado: o check continua rodando e continua podendo falhar — só deixa de ler o
    // ambiente de quem roda a suíte.
    aluyHome: mkdtempSync(join(tmpdir(), 'aluy-doctor-')),
    env: { ALUY_BACKEND: 'local', ALUY_LOCAL_API_KEY: 'chave-sintetica-de-teste' },
    gatherAuth: async () => f.auth,
    gatherBroker: async () => f.broker,
    gatherCatalog: async () => f.catalog,
    gatherMcp: async () => f.mcp,
    gatherAgents: async () => f.agents,
    gatherConfig: async () => f.config,
    gatherMemory: async () => f.memory,
    gatherSidecars: async () => f.sidecars,
    gatherMaestro: async () => f.maestro,
  };
}

/** Fatos "tudo ok" (base). */
function okFacts(): DoctorFacts {
  return {
    auth: { present: true, keychainAvailable: true, user: 'u@x', org: 'org-1', kind: 'device' },
    broker: { url: 'https://broker.aluy.example', probe: { reached: true, status: 200 } },
    catalog: {
      tiers: { reached: true, status: 200 },
      custom: { reached: true, status: 200 },
      customCount: 3,
    },
    mcp: { servers: [], configErrors: [] },
    agents: { validCount: 2, rejected: [] },
    config: {
      exists: true,
      corrupted: false,
      theme: 'aluy-dark',
      tier: 'aluy-deep',
      maxTokens: 1_000_000,
      maxIterations: 300,
      flags: [],
    },
    version: { aluy: '0.0.0', node: 'v24.0.0' },
    memory: { accessible: true, count: 4 },
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

describe('aluy doctor --json', () => {
  it('com --json e tudo ok: imprime JSON array com 10 checks, exit 0', async () => {
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s) };

    const exitCode = await runDoctor({
      io,
      json: true,
      probe: probeFromFacts(okFacts()),
    });

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1); // só 1 linha: o JSON.stringify

    const parsed = JSON.parse(lines[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(11); // F-DOCTOR-BYO: + `provider (BYO)` sob backend local;

    for (const item of parsed) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('label');
      expect(item).toHaveProperty('detail');
      expect(item.status).toMatch(/^(ok|warn|fail)$/);
      // Não tem fix no JSON
      expect(item).not.toHaveProperty('fix');
    }

    // Nenhum é fail
    expect(parsed.every((c: { status: string }) => c.status === 'ok')).toBe(true);
  });

  it('com --json e auth ausente: JSON inclui o fail, exit ≠0', async () => {
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s) };

    const facts = okFacts();
    facts.auth = { present: false, keychainAvailable: true };

    const exitCode = await runDoctor({
      io,
      json: true,
      probe: probeFromFacts(facts),
    });

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    const authCheck = parsed.find((c: { id: string }) => c.id === 'auth');
    expect(authCheck).toBeDefined();
    expect(authCheck.status).toBe('fail');
    expect(authCheck.detail).toContain('não autenticado');
  });

  it('sem --json (json:false): saída NORMAL com ticks (não é JSON)', async () => {
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s) };

    const exitCode = await runDoctor({
      io,
      json: false,
      probe: probeFromFacts(okFacts()),
    });

    expect(exitCode).toBe(0);
    // Deve ter mais de 1 linha (cabeçalho + ticks + checks + resumo)
    expect(lines.length).toBeGreaterThan(5);
    // A primeira linha é o título, não JSON
    expect(lines[0]).toBe('aluy doctor — diagnóstico');
    // A última linha (resumo) NÃO começa com [
    expect(lines[lines.length - 1]?.startsWith('[')).toBe(false);
  });

  it('com --json e --deep: JSON tem 11 checks (inclui tier + maestro)', async () => {
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s) };

    const exitCode = await runDoctor({
      io,
      json: true,
      deep: true,
      probe: {
        // F182 — o teste do tier de BROKER exige backend broker explícito (senão, num
        // box de config local/BYO, o probe marca o tier N/A e o tester não roda).
        ...probeFromFacts(okFacts()),
        // O `env` vem DEPOIS do spread de propósito: `probeFromFacts` passou a injetar um
        // ambiente LOCAL determinístico (ver lá) e este caso precisa do backend BROKER.
        // Sem a inversão o local venceria, o `provider-local` entraria no relatório e a
        // contagem iria a 12. A ORDEM é a asserção: quem declara depois manda.
        env: { ALUY_BACKEND: 'broker', ALUY_BROKER_URL: 'https://broker.test' },
        tierTester: async () => ({
          tier: 'aluy-granito',
          responded: true,
        }),
      },
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toHaveLength(11);
    const tierCheck = parsed.find((c: { id: string }) => c.id === 'tier');
    expect(tierCheck).toBeDefined();
    expect(tierCheck.status).toBe('ok');
    expect(tierCheck.detail).toContain('aluy-granito');
  });
});
