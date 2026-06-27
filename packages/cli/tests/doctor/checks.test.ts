// EST-0970 — testes da camada PURA do `/doctor`: cada FATO coletado → o item certo
// vira ✓/⚠/✗ com a dica de conserto. Sem I/O (a camada é pura); aqui só o mapeamento.

import { describe, expect, it } from 'vitest';
import {
  buildDoctorReport,
  buildSingleCheck,
  hasFailure,
  hostOf,
  plannedCheckIds,
  summarize,
  type DoctorFacts,
  type DoctorStatus,
} from '../../src/doctor/checks.js';

/** Fatos "tudo verde" — base que cada teste muta no campo que exercita. */
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

function statusOf(facts: DoctorFacts, id: string): DoctorStatus {
  const c = buildDoctorReport(facts).checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} ausente`);
  return c.status;
}
function checkOf(facts: DoctorFacts, id: string) {
  const c = buildDoctorReport(facts).checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ${id} ausente`);
  return c;
}

describe('doctor/checks — mapeamento de fatos → ✓/⚠/✗', () => {
  it('tudo ok ⇒ todos os 10 checks ✓ e SEM falha', () => {
    const report = buildDoctorReport(okFacts());
    expect(report.checks).toHaveLength(10);
    expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(hasFailure(report)).toBe(false);
  });

  // ── #1 credencial ──────────────────────────────────────────────────────────
  it('credencial presente ⇒ ✓ com user/org', () => {
    const c = checkOf(okFacts(), 'auth');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('u@x');
    expect(c.detail).toContain('org-1');
  });

  it('credencial ausente ⇒ ✗ + dica `aluy login`', () => {
    const f = okFacts();
    const c = checkOf({ ...f, auth: { present: false, keychainAvailable: true } }, 'auth');
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('aluy login');
  });

  it('keychain indisponível ⇒ ✗ + dica de keychain', () => {
    const f = okFacts();
    const c = checkOf({ ...f, auth: { present: false, keychainAvailable: false } }, 'auth');
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/keychain/i);
  });

  // ── #2 broker ──────────────────────────────────────────────────────────────
  it('broker 200 ⇒ ✓ com host+status', () => {
    const c = checkOf(okFacts(), 'broker');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('broker.aluy.example');
    expect(c.detail).toContain('200');
  });

  it('broker timeout (inalcançável) ⇒ ✗ "broker pode estar fora"', () => {
    const f = okFacts();
    const c = checkOf(
      { ...f, broker: { url: 'https://broker.aluy.example', probe: { reached: false } } },
      'broker',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/inalcanç/i);
  });

  it('broker PLACEHOLDER inalcançável ⇒ ✗ "ALUY_BROKER_URL não configurado" (não "broker fora")', () => {
    // EST-1015 — host placeholder (ALUY_BROKER_URL não setado) ⇒ mensagem distingue
    // "não-configurado" de "configurado-mas-fora" (a mensagem enganosa que o dono viu).
    const f = okFacts();
    const c = checkOf(
      { ...f, broker: { url: 'https://broker.dev.aluy.example', probe: { reached: false } } },
      'broker',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/placeholder/i);
    expect(c.fix).toMatch(/ALUY_BROKER_URL não configurado/i);
    expect(c.fix).not.toMatch(/o broker pode estar fora/i);
  });

  it('broker CONFIGURADO (não-placeholder) inalcançável ⇒ ✗ "broker pode estar fora" (preservado)', () => {
    const f = okFacts();
    const c = checkOf(
      { ...f, broker: { url: 'https://broker.minhaorg.com', probe: { reached: false } } },
      'broker',
    );
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/o broker pode estar fora/i);
    expect(c.detail).not.toMatch(/placeholder/i);
  });

  it('broker 401 no /healthz ⇒ ✗ + dica de credencial', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        broker: { url: 'https://broker.aluy.example', probe: { reached: true, status: 401 } },
      },
      'broker',
    );
    expect(c.status).toBe('fail');
    expect(c.fix).toContain('aluy login');
  });

  it('broker 503 ⇒ ⚠ (respondeu não-ok, mas não é fim)', () => {
    const f = okFacts();
    expect(
      statusOf(
        {
          ...f,
          broker: { url: 'https://broker.aluy.example', probe: { reached: true, status: 503 } },
        },
        'broker',
      ),
    ).toBe('warn');
  });

  // ── #3 catálogo/tiers ──────────────────────────────────────────────────────
  it('catálogo 200 + custom 200 ⇒ ✓ com contagem', () => {
    const c = checkOf(okFacts(), 'catalog');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('3 modelo');
  });

  it('catálogo de tier 401 mas custom 200 ⇒ ⚠ fallback (NUNCA ✗)', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        catalog: {
          tiers: { reached: true, status: 401 },
          custom: { reached: true, status: 200 },
          customCount: 1,
        },
      },
      'catalog',
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/fallback/i);
  });

  it('broker fora (catálogo + custom inalcançáveis) ⇒ ⚠ fallback', () => {
    const f = okFacts();
    expect(
      statusOf(
        {
          ...f,
          catalog: { tiers: { reached: false }, custom: { reached: false } },
        },
        'catalog',
      ),
    ).toBe('warn');
  });

  // ── #4 MCP ─────────────────────────────────────────────────────────────────
  it('sem servers MCP ⇒ ✓ "nenhum server"', () => {
    const c = checkOf(okFacts(), 'mcp');
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/nenhum/i);
  });

  it('server com config legada `--` ⇒ ⚠ + a correção pronta como dica', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        mcp: {
          servers: [
            {
              name: 'legacy',
              origin: 'aluy-global',
              invalid: true,
              invalidWarning:
                'server "legacy": command "--" é inválido — rode `aluy mcp remove`...',
              disabled: false,
            },
          ],
          configErrors: [],
        },
      },
      'mcp',
    );
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('--');
  });

  it('config MCP com JSON inválido ⇒ ✗', () => {
    const f = okFacts();
    expect(
      statusOf(
        { ...f, mcp: { servers: [], configErrors: ['~/.aluy/mcp.json: JSON inválido.'] } },
        'mcp',
      ),
    ).toBe('fail');
  });

  it('server desativado ⇒ ✓ contando o desativado', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        mcp: {
          servers: [{ name: 's', origin: 'aluy-global', invalid: false, disabled: true }],
          configErrors: [],
        },
      },
      'mcp',
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/desativado/i);
  });

  // ── #5 perfis de agente (.md) — RES-MD-3 ───────────────────────────────────
  it('perfil .md rejeitado (tools ilegível) ⇒ ⚠ com o motivo + como consertar', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        agents: {
          validCount: 1,
          rejected: [{ file: 'saudador.md', reason: 'tools presente mas ilegível — RES-MD-3' }],
        },
      },
      'agents',
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('saudador.md');
    expect(c.detail).toContain('RES-MD-3');
    expect(c.fix).toMatch(/tools/i);
  });

  // ── #6 config ──────────────────────────────────────────────────────────────
  it('config ok ⇒ ✓ com limites + flags', () => {
    const f = okFacts();
    const c = checkOf(
      { ...f, config: { ...f.config, flags: ['--yolo', 'ALUY_NATIVE_TOOLS_OFF'] } },
      'config',
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('max-tokens 1000000');
    expect(c.detail).toContain('--yolo');
  });

  it('config corrompido (JSON inválido) ⇒ ✗ + dica de conserto', () => {
    const f = okFacts();
    const c = checkOf({ ...f, config: { ...f.config, corrupted: true } }, 'config');
    expect(c.status).toBe('fail');
    expect(c.fix).toMatch(/config\.json/);
  });

  // ── #8 memória ─────────────────────────────────────────────────────────────
  it('memória acessível ⇒ ✓ com a CONTAGEM (não despeja conteúdo)', () => {
    const c = checkOf(okFacts(), 'memory');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('4 fato');
  });

  it('store de memória ilegível ⇒ ✗', () => {
    const f = okFacts();
    expect(statusOf({ ...f, memory: { accessible: false, count: 0 } }, 'memory')).toBe('fail');
  });

  // ── hasFailure ─────────────────────────────────────────────────────────────
  it('hasFailure = true sse há ALGUM ✗', () => {
    const f = okFacts();
    const report = buildDoctorReport({
      ...f,
      auth: { present: false, keychainAvailable: true },
    });
    expect(hasFailure(report)).toBe(true);
  });

  it('hasFailure = false com só ⚠ (avisos não derrubam o exit)', () => {
    const f = okFacts();
    const report = buildDoctorReport({
      ...f,
      catalog: { tiers: { reached: true, status: 401 }, custom: { reached: true, status: 401 } },
    });
    expect(report.checks.some((c) => c.status === 'warn')).toBe(true);
    expect(hasFailure(report)).toBe(false);
  });
});

describe('doctor/checks — VALIDAÇÃO ATIVA (EST-0970)', () => {
  // ── credencial AUTENTICA via GET ───────────────────────────────────────────
  it('credencial presente + authValidated=true ⇒ ✓ "autenticado"', () => {
    const f = okFacts();
    const c = checkOf({ ...f, auth: { ...f.auth, authValidated: true, authStatus: 200 } }, 'auth');
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/autenticado/i);
  });

  it('credencial presente mas broker RECUSA (401) ⇒ ✗ "rode aluy login"', () => {
    const f = okFacts();
    const c = checkOf({ ...f, auth: { ...f.auth, authValidated: false, authStatus: 401 } }, 'auth');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('401');
    expect(c.fix).toContain('aluy login');
  });

  it('credencial presente sem validação possível (broker fora) ⇒ ✓ "não-validado" (NÃO ✗)', () => {
    const c = checkOf(okFacts(), 'auth'); // authValidated undefined
    expect(c.status).toBe('ok');
    expect(c.detail).toMatch(/não-validado/i);
  });

  // ── MCP CONECTA de verdade ─────────────────────────────────────────────────
  it('servers conectados ⇒ ✓ "playwright · 21 tools"', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        mcp: {
          servers: [
            {
              name: 'playwright',
              origin: 'aluy-global',
              invalid: false,
              disabled: false,
              connected: true,
              toolCount: 21,
            },
          ],
          configErrors: [],
        },
      },
      'mcp',
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('playwright · 21 tools');
  });

  it('um server FALHA ao conectar ⇒ ✗ "falhou ao conectar: <erro>"', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        mcp: {
          servers: [
            {
              name: 'ok-srv',
              origin: 'aluy-global',
              invalid: false,
              disabled: false,
              connected: true,
              toolCount: 3,
            },
            {
              name: 'broke',
              origin: 'aluy-global',
              invalid: false,
              disabled: false,
              connected: false,
              connectError: 'ENOENT npx',
            },
          ],
          configErrors: [],
        },
      },
      'mcp',
    );
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('broke');
    expect(c.detail).toContain('ENOENT npx');
  });

  // ── config VALIDA os VALORES (tema/tier no catálogo) ───────────────────────
  it('tema fora do catálogo ⇒ ⚠ (cai no default)', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        config: {
          ...f.config,
          theme: 'roxo-neon',
          themeKnown: false,
          tier: 'aluy-deep',
          tierKnown: true,
        },
      },
      'config',
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('roxo-neon');
    expect(c.fix).toMatch(/theme/i);
  });

  it('tier desconhecido ⇒ ⚠', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        config: {
          ...f.config,
          theme: 'aluy-dark',
          themeKnown: true,
          tier: 'tier-fantasma',
          tierKnown: false,
        },
      },
      'config',
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('tier-fantasma');
    expect(c.fix).toMatch(/model/i);
  });

  it('tema/tier conhecidos ⇒ ✓ (validação passou)', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        config: {
          ...f.config,
          theme: 'aluy-dark',
          themeKnown: true,
          tier: 'aluy-deep',
          tierKnown: true,
        },
      },
      'config',
    );
    expect(c.status).toBe('ok');
  });

  // ── --deep: linha do tier só com o fato presente ───────────────────────────
  it('sem facts.tier ⇒ relatório SEM o check de tier (default não chama modelo)', () => {
    const report = buildDoctorReport(okFacts());
    expect(report.checks.some((c) => c.id === 'tier')).toBe(false);
    expect(report.checks).toHaveLength(10);
  });

  it('com facts.tier respondendo ⇒ check tier ✓; sem responder ⇒ ✗', () => {
    const ok = buildDoctorReport({ ...okFacts(), tier: { tier: 'aluy-granito', responded: true } });
    expect(ok.checks.find((c) => c.id === 'tier')?.status).toBe('ok');
    const bad = buildDoctorReport({
      ...okFacts(),
      tier: { tier: 'aluy-flux', responded: false, error: 'sem crédito' },
    });
    expect(bad.checks.find((c) => c.id === 'tier')?.status).toBe('fail');
    expect(hasFailure(bad)).toBe(true);
  });
});

describe('doctor/checks — incremental (ticks ao vivo)', () => {
  it('plannedCheckIds: 10 sem deep, 11 com (tier no fim)', () => {
    expect(plannedCheckIds(false)).toHaveLength(10);
    const deep = plannedCheckIds(true);
    expect(deep).toHaveLength(11);
    expect(deep[deep.length - 1]?.id).toBe('tier');
  });

  it('buildSingleCheck: undefined enquanto o fato não chegou; o DoctorCheck quando chega', () => {
    expect(buildSingleCheck('auth', {})).toBeUndefined();
    const c = buildSingleCheck('auth', { auth: okFacts().auth });
    expect(c?.id).toBe('auth');
    expect(c?.status).toBe('ok');
  });

  it('summarize conta ok/aviso/falha', () => {
    const report = buildDoctorReport({
      ...okFacts(),
      auth: { present: false, keychainAvailable: true },
      catalog: { tiers: { reached: true, status: 401 }, custom: { reached: true, status: 401 } },
    });
    const s = summarize(report.checks);
    expect(s).toMatch(/\d+ ok · \d+ aviso · \d+ falha/);
    expect(s).toContain('1 falha');
  });
});

describe('doctor/checks — hostOf', () => {
  it('extrai só o host de uma URL', () => {
    expect(hostOf('https://broker.aluy.example/v1/x')).toBe('broker.aluy.example');
  });
  it('URL inválida ⇒ devolve cru (fail-safe)', () => {
    expect(hostOf('not a url')).toBe('not a url');
  });
});

// ── #10 sidecars do Maestro ──────────────────────────────────────────────
describe('doctor/checks — sidecars/Maestro', () => {
  it('todos os 3 sidecars up ⇒ ✓', () => {
    const c = checkOf(okFacts(), 'sidecars');
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('headroom');
    expect(c.detail).toContain('ollama');
    expect(c.detail).toContain('mem0');
    expect(c.detail).toContain('perfil TURBO');
    expect(c.detail).toContain('toggles: ollama, mem0');
  });

  it('headroom fora ⇒ ✗ com dica de provisionamento (aluy init)', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        sidecars: {
          ...f.sidecars,
          headroom: { reached: false },
        },
      },
      'sidecars',
    );
    expect(c.status).toBe('fail');
    // O hint correto aponta `aluy init` (o `aluy maestro start` não existe — EST-1133-bis).
    expect(c.fix).toContain('aluy init');
  });

  it('ollama fora ⇒ ✗', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        sidecars: {
          ...f.sidecars,
          ollama: { reached: false },
        },
      },
      'sidecars',
    );
    expect(c.status).toBe('fail');
  });

  it('mem0 fora ⇒ ✗ (hoje provavelmente, mas o check reporta)', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        sidecars: {
          ...f.sidecars,
          mem0: { reached: false },
        },
      },
      'sidecars',
    );
    expect(c.status).toBe('fail');
  });

  it('sidecar com status inesperado (503) ⇒ ⚠', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        sidecars: {
          ...f.sidecars,
          ollama: { reached: true, status: 503 },
        },
      },
      'sidecars',
    );
    expect(c.status).toBe('warn');
  });

  it('perfil LEVE com 0 toggles', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        sidecars: {
          headroom: { reached: true, status: 200 },
          ollama: { reached: true, status: 200 },
          mem0: { reached: true, status: 200 },
          profile: 'leve',
          toggles: [],
        },
      },
      'sidecars',
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('perfil LEVE');
    expect(c.detail).toContain('toggles: nenhum');
  });

  it('perfil TURBO com só ollama ON', () => {
    const f = okFacts();
    const c = checkOf(
      {
        ...f,
        sidecars: {
          ...f.sidecars,
          toggles: ['ollama'],
        },
      },
      'sidecars',
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('toggles: ollama');
  });

  it('hasFailure = true quando sidecar fora', () => {
    const f = okFacts();
    const report = buildDoctorReport({
      ...f,
      sidecars: {
        ...f.sidecars,
        headroom: { reached: false },
      },
    });
    expect(hasFailure(report)).toBe(true);
  });
});
