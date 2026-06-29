// EST-1133 · ADR-0123 §2.2-ter — testes do provisionador de sidecars.
//
// Testa `NodeSidecarProvisioner` e `runProvisioner` com fs/child_process mockados.
// Cobre: isProvisioned, provisionAll (perfil/toggles), recusa root, D3 (hash divergente/correto).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import {
  NodeSidecarProvisioner,
  runProvisioner,
  verifyManifestModelDigest,
  OLLAMA_MODEL_MEDIA_TYPE,
} from '../../src/provisioner/sidecar-provisioner.js';
import {
  type SidecarTarget,
  verifySha256,
  MEM0_PIP_PACKAGES,
  HEADROOM_PIP_PACKAGES,
} from '@hiperplano/aluy-cli-core';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({ kill: vi.fn(), unref: vi.fn() }),
  spawnSync: vi.fn(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return { ...actual, userInfo: vi.fn() };
});

// Mock do verifySha256 do cli-core — por padrão delega ao real.
vi.mock('@hiperplano/aluy-cli-core', async () => {
  const actual = await vi.importActual<typeof import('@hiperplano/aluy-cli-core')>('@hiperplano/aluy-cli-core');
  // Por padrão, usa a implementação real.
  const mockVerify = vi.fn((a: string, b: string) => actual.verifySha256(a, b));
  return { ...actual, verifySha256: mockVerify };
});

// Mock global fetch para download.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockExists = vi.mocked(existsSync);
const mockSpawnSync = vi.mocked(spawnSync);
const mockSpawn = vi.mocked(spawn);
const mockReadFile = vi.mocked(readFileSync);
const mockUserInfo = vi.mocked(userInfo);
const mockVerifySha256 = vi.mocked(verifySha256);

// ─── Helpers ────────────────────────────────────────────────────────────────

function resetAllMocks() {
  vi.resetAllMocks();
  // Default: não é root.
  mockUserInfo.mockReturnValue({ uid: 1000 } as ReturnType<typeof userInfo>);
  // Default: arquivos não existem (piso limpo).
  mockExists.mockReturnValue(false);
  // Default: spawn sucesso.
  mockSpawnSync.mockReturnValue({
    status: 0,
    stdout: '',
    stderr: '',
  } as ReturnType<typeof spawnSync>);
  // Default: `spawn` (ollama serve) devolve um proc com kill()+unref() — o reset limpa
  // o mock do factory, então re-estabelecemos aqui (o serve agora dá `.unref()`).
  mockSpawn.mockReturnValue({
    kill: vi.fn(),
    unref: vi.fn(),
  } as unknown as ReturnType<typeof spawn>);
  // Default: verifySha256 volta ao factory mock → delega ao real.
}

// ─── Suite: isProvisioned ───────────────────────────────────────────────────

describe('NodeSidecarProvisioner.isProvisioned', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });

  beforeEach(resetAllMocks);

  it('ollama: true quando o binário existe em ~/.aluy/ollama/bin/ollama', async () => {
    mockExists.mockImplementation((p) =>
      (p as string).replace(/\\/g, '/').includes('ollama/bin/ollama'),
    );
    expect(await provisioner.isProvisioned('ollama')).toBe(true);
  });

  it('ollama: false quando o binário NÃO existe', async () => {
    mockExists.mockReturnValue(false);
    expect(await provisioner.isProvisioned('ollama')).toBe(false);
  });

  it('mem0: true quando python3 do venv existe E pip funciona', async () => {
    mockExists.mockImplementation((p) =>
      (p as string).replace(/\\/g, '/').includes('venv/bin/python3'),
    );
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    expect(await provisioner.isProvisioned('mem0')).toBe(true);
  });

  it('mem0: false quando python3 do venv existe mas pip NÃO funciona', async () => {
    mockExists.mockImplementation((p) =>
      (p as string).replace(/\\/g, '/').includes('venv/bin/python3'),
    );
    mockSpawnSync.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(await provisioner.isProvisioned('mem0')).toBe(false);
  });

  it('mem0: false quando nem o python3 do venv existe', async () => {
    mockExists.mockReturnValue(false);
    expect(await provisioner.isProvisioned('mem0')).toBe(false);
  });

  it('alvo desconhecido ⇒ false', async () => {
    expect(await provisioner.isProvisioned('desconhecido' as SidecarTarget)).toBe(false);
  });
});

// ─── Suite: provisionAll (perfil + toggles) ─────────────────────────────────

describe('NodeSidecarProvisioner.provisionAll', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });

  beforeEach(resetAllMocks);

  it('LEVE ⇒ retorna resultado vazio, sem provisionar nada', async () => {
    const result = await provisioner.provisionAll('leve', new Set(['ollama']));
    expect(result.profile).toBe('leve');
    expect(result.targets).toHaveLength(0);
    expect(result.anySuccess).toBe(false);
    expect(result.allFailed).toBe(false);
    expect(mockExists).not.toHaveBeenCalled();
  });

  it('TURBO com toggle ollama ON ⇒ provisiona ollama', async () => {
    // Mock fetch: download retorna body vazio (hash não bate, mas o fluxo roda).
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await provisioner.provisionAll('turbo', new Set(['ollama']));
    expect(result.profile).toBe('turbo');
    expect(result.targets).toHaveLength(1);
  });

  it('TURBO sem toggles ⇒ provisiona nada mas retorna estrutura correta', async () => {
    const result = await provisioner.provisionAll('turbo', new Set());
    expect(result.profile).toBe('turbo');
    expect(result.targets).toHaveLength(0);
    expect(result.anySuccess).toBe(false);
    expect(result.allFailed).toBe(false);
  });

  it('TURBO com toggle ollama OFF (ausente do set) ⇒ NÃO provisiona ollama', async () => {
    const result = await provisioner.provisionAll('turbo', new Set(['mem0']));
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.target).toBe('mem0');
  });
});

// ─── Suite: roteamento p/ o AGENTE (decisão do dono — agente é o instalador) ──

describe('NodeSidecarProvisioner.provision — agentInstaller é PREFERIDO (qualquer SO)', () => {
  beforeEach(resetAllMocks);

  it('agentInstaller presente ⇒ usado MESMO no Linux (não cai no tarball direto)', async () => {
    const calls: SidecarTarget[] = [];
    const provisioner = new NodeSidecarProvisioner({
      platform: 'linux',
      agentInstaller: async (t) => {
        calls.push(t);
        return { target: t, hashOk: true, installed: true, message: 'via agente' };
      },
    });
    const r = await provisioner.provision('ollama');
    expect(calls).toEqual(['ollama']); // o agente foi chamado, no Linux
    expect(r.installed).toBe(true);
    expect(r.message).toContain('agente');
  });

  it('agentInstaller presente ⇒ usado p/ mem0 também (mesmo com python presente, parte do que existe)', async () => {
    let used = false;
    const provisioner = new NodeSidecarProvisioner({
      platform: 'linux',
      agentInstaller: async (t) => {
        used = true;
        return { target: t, hashOk: true, installed: true, message: 'via agente' };
      },
    });
    await provisioner.provision('mem0');
    expect(used).toBe(true);
  });

  it('SEM agentInstaller ⇒ caminho direto no Linux (comportamento --no-agent preservado)', async () => {
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });
    const r = await provisioner.provision('ollama');
    // sem agente, é o caminho direto (mockado) — não a mensagem "via agente"
    expect(r.message).not.toContain('via agente');
  });

  it('provisionAll passa o CTX de SEQUÊNCIA (i/N + fila) ao agente — cabeçalho sobrevive ao clear', async () => {
    const seen: { target: SidecarTarget; index?: number; total?: number; plan?: readonly SidecarTarget[] }[] = [];
    const provisioner = new NodeSidecarProvisioner({
      platform: 'linux',
      agentInstaller: async (t, ctx) => {
        seen.push({ target: t, index: ctx?.index, total: ctx?.total, plan: ctx?.plan });
        return { target: t, hashOk: true, installed: true, message: 'ok' };
      },
    });
    await provisioner.provisionAll('turbo', new Set(['ollama', 'mem0', 'headroom']));
    // cada alvo recebeu sua posição na fila + o total + a fila completa (p/ "2/3" no cabeçalho)
    expect(seen.map((s) => [s.target, s.index, s.total])).toEqual([
      ['ollama', 1, 3],
      ['mem0', 2, 3],
      ['headroom', 3, 3],
    ]);
    expect(seen[1]?.plan).toEqual(['ollama', 'mem0', 'headroom']); // fila completa visível
  });
});

// ─── Suite: provision (root refusal) ────────────────────────────────────────

describe('NodeSidecarProvisioner.provision — recusa root', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });

  beforeEach(resetAllMocks);

  it('uid=0 ⇒ recusa com mensagem de root e hashOk=false', async () => {
    mockUserInfo.mockReturnValue({ uid: 0 } as ReturnType<typeof userInfo>);

    const result = await provisioner.provision('ollama');
    expect(result.installed).toBe(false);
    expect(result.hashOk).toBe(false);
    expect(result.message).toMatch(/RECUSA ROOT/i);
  });

  it('uid≠0 ⇒ NÃO recusa e tenta provisionar', async () => {
    mockUserInfo.mockReturnValue({ uid: 1000 } as ReturnType<typeof userInfo>);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await provisioner.provision('ollama');
    expect(result.message).not.toMatch(/RECUSA ROOT/);
  });

  it('alvo desconhecido ⇒ retorna erro com mensagem', async () => {
    const result = await provisioner.provision('desconhecido' as SidecarTarget);
    expect(result.installed).toBe(false);
    expect(result.message).toMatch(/desconhecido/i);
  });
});

// ─── Suite: D3 — proveniência pinada (hash) ─────────────────────────────────
// CA-PROV-7: hash divergente ⇒ aborta com hashOk=false.
//             hash correto ⇒ hashOk:true.
//
// PUSHBACK: verificação de digest do modelo lê o manifest no disco
// ($OLLAMA_MODELS/manifests/registry.ollama.ai/library/<name>/<tag>)
// em vez de depender de "ollama show --json" (que NÃO emite digests).

describe('D3 — prova de proveniência pinada', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });

  beforeEach(resetAllMocks);

  // ── Pure: verifySha256 ──────────────────────────────────────────────────

  it('verifySha256: hashes iguais ⇒ true', () => {
    const h = 'abc123';
    expect(verifySha256(h, h)).toBe(true);
  });

  it('verifySha256: hashes diferentes ⇒ false', () => {
    expect(verifySha256('abc123', 'def456')).toBe(false);
  });

  it('verifySha256: tamanhos diferentes ⇒ false imediato (timing-safe)', () => {
    expect(verifySha256('abc', 'abcdef')).toBe(false);
  });

  // ── F102: digest verificado na layer de PESO (model), não em "qualquer layer" ──────
  const WEIGHT = 'sha256:GOOD_WEIGHT_DIGEST';

  it('F102: layer `model` com o digest pinado ⇒ aceita (null)', () => {
    const manifest = {
      layers: [
        { mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: WEIGHT },
        { mediaType: 'application/vnd.ollama.image.params', digest: 'sha256:other' },
      ],
    };
    expect(verifyManifestModelDigest(manifest, WEIGHT, 'qwen')).toBeNull();
  });

  it('F102: DECOY — peso pinado numa layer NÃO-model + `model` malicioso ⇒ REJEITA', () => {
    // O ataque que o antigo `layers.some(d===expected)` deixava passar: registry serve o
    // peso REAL como license-decoy e o peso MALICIOSO como a layer `model`.
    const attacker = {
      layers: [
        { mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: 'sha256:EVIL' },
        { mediaType: 'application/vnd.ollama.image.license', digest: WEIGHT },
      ],
    };
    const err = verifyManifestModelDigest(attacker, WEIGHT, 'qwen');
    expect(err).not.toBeNull();
    expect(err).toMatch(/DIGEST DIVERGENTE|CLI-SEC-H2/);
  });

  it('F137: DUAS layers `model` (decoy-pinado + malicioso) ⇒ REJEITA (ambíguo, completa o F102)', () => {
    // Próximo passo do decoy do F102: o registry serve um model-DECOY com o digest PINADO
    // (passaria o find antigo) + um 2º model MALICIOSO. Não há garantia de qual o ollama
    // carrega ⇒ o verificador recusa manifest com >1 layer de peso.
    const attacker = {
      layers: [
        { mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: WEIGHT }, // decoy com o digest pinado
        { mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: 'sha256:EVIL' }, // peso malicioso
      ],
    };
    const err = verifyManifestModelDigest(attacker, WEIGHT, 'qwen');
    expect(err).not.toBeNull();
    expect(err).toMatch(/AMBÍGUO|CLI-SEC-H2/);
  });

  it('F137: ordem inversa (malicioso-primeiro + decoy-pinado) ⇒ também REJEITA', () => {
    const attacker = {
      layers: [
        { mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: 'sha256:EVIL' },
        { mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: WEIGHT },
      ],
    };
    expect(verifyManifestModelDigest(attacker, WEIGHT, 'qwen')).toMatch(/AMBÍGUO|CLI-SEC-H2/);
  });

  it('F102: manifest sem layer `model` ⇒ erro (não passa por omissão)', () => {
    const manifest = {
      layers: [{ mediaType: 'application/vnd.ollama.image.license', digest: WEIGHT }],
    };
    expect(verifyManifestModelDigest(manifest, WEIGHT, 'qwen')).toMatch(/sem layer de peso/);
  });

  it('F102: manifest sem layers ⇒ erro', () => {
    expect(verifyManifestModelDigest({ layers: [] }, WEIGHT, 'qwen')).toMatch(/não contém layers/);
    expect(verifyManifestModelDigest({}, WEIGHT, 'qwen')).toMatch(/não contém layers/);
  });

  // ── Download hash diverge ⇒ hashOk:false ───────────────────────────────

  it('hash binário divergente ⇒ provision retorna hashOk:false', async () => {
    mockVerifySha256.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    } as ReturnType<typeof spawnSync>);

    const result = await provisioner.provision('ollama');

    expect(result.hashOk).toBe(false);
    expect(result.installed).toBe(false);
    expect(result.message).toMatch(/hash/i);
  });

  it('hash binário divergente ⇒ NÃO escreve arquivo em disco', async () => {
    mockVerifySha256.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await provisioner.provision('ollama');

    const { writeFileSync } = await import('node:fs');
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  // ── Manifest digest presente ⇒ hashOk:true ─────────────────────────────

  it('digest correto no manifest ⇒ provision sucesso (hashOk:true)', async () => {
    // Setup: binário já baixado e extraído, hash ok, manifest com digest correto.
    mockExists.mockReturnValue(true); // tudo "existe"
    mockReadFile.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('qwen2.5')) {
        // F102 — o digest pinado tem de estar na layer de PESO (mediaType `model`),
        // como no manifest real do ollama (+ uma layer params irrelevante de companhia).
        const layers = [
          {
            mediaType: OLLAMA_MODEL_MEDIA_TYPE,
            digest: 'sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515',
          },
          { mediaType: 'application/vnd.ollama.image.params', digest: 'sha256:ignored' },
        ];
        return Buffer.from(JSON.stringify({ layers }));
      }
      if (p.includes('nomic-embed-text')) {
        const layers = [
          {
            mediaType: OLLAMA_MODEL_MEDIA_TYPE,
            digest: 'sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6',
          },
        ];
        return Buffer.from(JSON.stringify({ layers }));
      }
      if (p.includes('bge-m3')) {
        // embedder DEFAULT atual (config-driven) — digest pinado do catálogo.
        const layers = [
          {
            mediaType: OLLAMA_MODEL_MEDIA_TYPE,
            digest: 'sha256:daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c',
          },
        ];
        return Buffer.from(JSON.stringify({ layers }));
      }
      return Buffer.from('dummy');
    });
    mockVerifySha256.mockReturnValue(true); // hash binário ok

    // Health-check fetch (ollama serve pronto).
    mockFetch.mockResolvedValue({ ok: true });

    // pull spawnSync → sucesso.
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    } as ReturnType<typeof spawnSync>);

    const result = await provisioner.provision('ollama');

    expect(result.hashOk).toBe(true);
    expect(result.installed).toBe(true);
  });

  // ── Manifest digest ausente ⇒ hashOk:false ─────────────────────────────

  it('digest ausente no manifest ⇒ hashOk:false com mensagem DIGEST', async () => {
    mockExists.mockReturnValue(true);
    // Manifest existe, a layer `model` tem um digest DIFERENTE do pinado (F102: checa a
    // layer de peso especificamente).
    mockReadFile.mockReturnValue(
      Buffer.from(
        JSON.stringify({
          layers: [{ mediaType: OLLAMA_MODEL_MEDIA_TYPE, digest: 'sha256:outro' }],
        }),
      ),
    );
    mockVerifySha256.mockReturnValue(true);
    mockFetch.mockResolvedValue({ ok: true });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    } as ReturnType<typeof spawnSync>);

    const result = await provisioner.provision('ollama');

    expect(result.hashOk).toBe(true); // hash do binário passou
    expect(result.installed).toBe(false); // falhou na verificação de digest do modelo
    expect(result.message).toMatch(/DIGEST DIVERGENTE/i);
  });

  // ── Manifest não encontrado ⇒ hashOk:false ─────────────────────────────

  it('manifest não encontrado após pull ⇒ hashOk:false', async () => {
    // Binário existe, mas manifest NÃO aparece após o pull (simula falha do pull).
    mockExists.mockImplementation((p) => {
      const s = (p as string).replace(/\\/g, '/');
      // Manifest NÃO existe.
      if (s.includes('manifests/registry.ollama.ai/library')) return false;
      // Tudo mais existe.
      return true;
    });
    mockReadFile.mockReturnValue(Buffer.from('dummy')); // downloadAndVerify
    mockVerifySha256.mockReturnValue(true);
    mockFetch.mockResolvedValue({ ok: true });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    } as ReturnType<typeof spawnSync>);

    const result = await provisioner.provision('ollama');

    expect(result.installed).toBe(false);
    expect(result.message).toMatch(/Manifest não encontrado/i);
  });
});

// ─── Suite: runProvisioner (integração) ─────────────────────────────────────

describe('runProvisioner', () => {
  beforeEach(resetAllMocks);

  it('sem argumentos ⇒ perfil turbo, toggles default (ollama + mem0)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await runProvisioner(undefined, undefined, { platform: 'linux', useAgent: false });
    expect(result.profile).toBe('turbo');
    expect(result.targets.length).toBeGreaterThanOrEqual(1);
  });

  it('perfil LEVE explícito ⇒ não provisiona nada', async () => {
    const result = await runProvisioner('leve', { ollama: true }, { platform: 'linux', useAgent: false });
    expect(result.profile).toBe('leve');
    expect(result.targets).toHaveLength(0);
    expect(result.anySuccess).toBe(false);
  });

  it('toggle ollama=false ⇒ só provisiona mem0', async () => {
    const result = await runProvisioner(
      'turbo',
      { ollama: false, mem0: true, headroom: false },
      { platform: 'linux', useAgent: false },
    );
    expect(result.profile).toBe('turbo');
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.target).toBe('mem0');
  });

  it('toggle mem0=false ⇒ só provisiona ollama', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    const result = await runProvisioner(
      'turbo',
      { ollama: true, mem0: false, headroom: false },
      { platform: 'linux', useAgent: false },
    );
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.target).toBe('ollama');
  });

  it('todos toggles false em perfil TURBO ⇒ provisiona nada', async () => {
    const result = await runProvisioner(
      'turbo',
      {
        ollama: false,
        mem0: false,
        headroom: false,
      },
      { platform: 'linux', useAgent: false },
    );
    expect(result.targets).toHaveLength(0);
    expect(result.anySuccess).toBe(false);
    expect(result.allFailed).toBe(false);
  });
});

// ─── Suite: idempotência ────────────────────────────────────────────────────

describe('NodeSidecarProvisioner.isProvisioned — idempotência', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });

  beforeEach(resetAllMocks);

  it('ollama já provisionado ⇒ isProvisioned=true sem refazer download', async () => {
    mockExists.mockImplementation((p) =>
      (p as string).replace(/\\/g, '/').includes('ollama/bin/ollama'),
    );
    expect(await provisioner.isProvisioned('ollama')).toBe(true);
  });
});

// ─── Suite: degradação (falha de um alvo não trava o outro) ─────────────────

describe('provisionAll — degradação', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });

  beforeEach(resetAllMocks);

  it('falha do ollama não impede sucesso do mem0', async () => {
    mockFetch.mockRejectedValue(new Error('rede fora'));
    mockExists.mockImplementation((p) => {
      const s = p as string;
      if (s.includes('venv/bin/python3')) return true;
      // EST-1138: o script servidor também precisa "existir" no venv.
      if (s.includes('aluy-mem0-server.py')) return true;
      return false;
    });
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: 'Python 3.10.12',
        stderr: '',
      } as ReturnType<typeof spawnSync>) // python3 --version
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
      } as ReturnType<typeof spawnSync>); // pip --version

    const result = await provisioner.provisionAll('turbo', new Set(['ollama', 'mem0']));

    expect(result.targets).toHaveLength(2);
    const ollamaR = result.targets.find((t) => t.target === 'ollama')!;
    expect(ollamaR.installed).toBe(false);
    const mem0R = result.targets.find((t) => t.target === 'mem0')!;
    expect(mem0R.installed).toBe(true);
    expect(result.anySuccess).toBe(true);
    expect(result.allFailed).toBe(false);
  });

  it('ambos falham ⇒ allFailed=true', async () => {
    mockFetch.mockRejectedValue(new Error('rede fora'));
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'not found',
    } as ReturnType<typeof spawnSync>);

    const result = await provisioner.provisionAll('turbo', new Set(['ollama', 'mem0']));

    expect(result.targets).toHaveLength(2);
    expect(result.anySuccess).toBe(false);
    expect(result.allFailed).toBe(true);
  });
});

// ─── EST-1133-bis: SO sem artefato pinado ⇒ delega ao agente ────────────────

describe('EST-1133-bis — delegação ao agente (SO não-Linux)', () => {
  beforeEach(resetAllMocks);

  it('win32 SEM agentInstaller ⇒ instrui (aluy bootstrap), não baixa', async () => {
    const provisioner = new NodeSidecarProvisioner({ platform: 'win32' });
    const result = await provisioner.provision('ollama');
    expect(result.installed).toBe(false);
    expect(result.message).toMatch(/aluy bootstrap/);
    // NÃO tentou baixar o tarball (fetch nunca chamado).
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('win32 COM agentInstaller ⇒ DELEGA (chama o installer) e devolve o resultado', async () => {
    const installer = vi.fn(async (target: SidecarTarget) => ({
      target,
      hashOk: true,
      installed: true,
      message: `instalado via agente: ${target}`,
    }));
    const provisioner = new NodeSidecarProvisioner({
      platform: 'win32',
      agentInstaller: installer,
    });

    const result = await provisioner.provision('ollama');

    expect(installer.mock.calls[0]?.[0]).toBe('ollama');
    expect(result.installed).toBe(true);
    expect(result.message).toMatch(/via agente/);
    // Caminho de download NÃO foi exercido.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('linux COM agentInstaller ⇒ DELEGA (decisão do dono: agente é o instalador, mesmo no Linux)', async () => {
    const installer = vi.fn(async (target: SidecarTarget) => ({
      target,
      hashOk: true,
      installed: true,
      message: `via agente: ${target}`,
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const provisioner = new NodeSidecarProvisioner({
      platform: 'linux',
      agentInstaller: installer,
    });

    const result = await provisioner.provision('ollama');

    // NOVO comportamento: o agente VENCE no Linux também — não cai no download direto.
    expect(installer.mock.calls[0]?.[0]).toBe('ollama');
    expect(result.message).toMatch(/via agente/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('linux SEM agentInstaller ⇒ caminho direto (download) preservado (--no-agent)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });
    await provisioner.provision('ollama');
    // sem agente, o Linux baixa o tarball pinado (comportamento --no-agent).
    expect(mockFetch).toHaveBeenCalled();
  });

  it('provisionAll em win32 com agentInstaller ⇒ delega cada toggle', async () => {
    const installer = vi.fn(async (target: SidecarTarget) => ({
      target,
      hashOk: true,
      installed: true,
      message: `via agente: ${target}`,
    }));
    const provisioner = new NodeSidecarProvisioner({
      platform: 'win32',
      agentInstaller: installer,
    });

    const result = await provisioner.provisionAll('turbo', new Set(['ollama', 'mem0']));

    expect(installer).toHaveBeenCalledTimes(2);
    expect(result.anySuccess).toBe(true);
    expect(result.targets.map((t) => t.target).sort()).toEqual(['mem0', 'ollama']);
  });
});

// ─── F104: todos os pacotes pip são PINADOS por versão (supply-chain) ────────
describe('F104 — pacotes pip pinados por versão (não puxa LATEST do PyPI)', () => {
  it('MEM0_PIP_PACKAGES: cada pacote tem `==<versão>`', () => {
    for (const pkg of MEM0_PIP_PACKAGES) {
      expect(pkg, `pacote mem0 não-pinado: "${pkg}"`).toMatch(/==\d/);
    }
  });

  it('HEADROOM_PIP_PACKAGES: cada pacote tem `==<versão>` (F104 — antes era latest)', () => {
    expect(HEADROOM_PIP_PACKAGES.length).toBeGreaterThan(0);
    for (const pkg of HEADROOM_PIP_PACKAGES) {
      expect(pkg, `pacote headroom não-pinado: "${pkg}"`).toMatch(/==\d/);
    }
  });
});

// ─── F103: mem0 venv NÃO baixa-e-executa get-pip remoto (CLI-SEC-H2) ─────────
describe('F103 — provisionMem0 sem ensurepip: fail-closed, NUNCA curl|exec get-pip', () => {
  const provisioner = new NodeSidecarProvisioner({ platform: 'linux' });
  beforeEach(resetAllMocks);

  it('venv falha por ensurepip ⇒ hashOk:false + guia p/ pip do SO; nenhum exec de get-pip', async () => {
    // python3 existe (checkPython ok); o venv do mem0 NÃO existe ⇒ tenta criar.
    mockExists.mockReturnValue(false);
    mockSpawnSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const a = (args as string[]) ?? [];
      if (a.includes('venv')) {
        // `python3 -m venv` falha porque ensurepip está ausente.
        return {
          status: 1,
          stdout: '',
          stderr: 'Error: Command ... returned non-zero exit status ... No module named ensurepip',
        } as ReturnType<typeof spawnSync>;
      }
      // `python3 --version` e quaisquer outros ⇒ ok.
      return { status: 0, stdout: 'Python 3.11.0', stderr: '' } as ReturnType<typeof spawnSync>;
    });

    const result = await provisioner.provision('mem0');

    expect(result.installed).toBe(false);
    expect(result.hashOk).toBe(false);
    expect(result.message).toMatch(/ensurepip|python3-pip|CLI-SEC-H2/);
    // CRÍTICO: NENHUM spawnSync executou get-pip remoto (o antigo curl|python).
    for (const call of mockSpawnSync.mock.calls) {
      const argv = (call[1] as string[] | undefined) ?? [];
      const joined = argv.join(' ');
      expect(joined).not.toMatch(/get-pip|urlopen|bootstrap\.pypa/);
      expect(joined).not.toContain('--without-pip');
    }
  });
});
