// EST-1133 · ADR-0123 §2.2-ter — funções PURAS do contrato de provisionamento de
// sidecars (agent/maestro/provisioner-contract.ts): `verifySha256` (comparação em
// tempo constante), `isRoot` (recusa CLI-SEC-H2), `shouldProvision` (LEVE nunca /
// TURBO sempre) e `resolveSidecarToggles` (default-ON, §2.2-bis). PURO — zero I/O;
// a implementação concreta (download/hash real/venv) mora em `@hiperplano/aluy-cli`
// e é testada lá (`packages/cli/tests/provisioner/sidecar-provisioner.test.ts`).

import { describe, expect, it } from 'vitest';
import {
  verifySha256,
  isRoot,
  shouldProvision,
  resolveSidecarToggles,
  embedderSpec,
  EMBEDDER_CATALOG,
  DEFAULT_EMBEDDER_MODEL,
} from '../../../src/index.js';

describe('verifySha256 — comparação em tempo constante', () => {
  it('hashes idênticos ⇒ true', () => {
    expect(verifySha256('abc123', 'abc123')).toBe(true);
  });

  it('hashes diferentes (mesmo tamanho) ⇒ false', () => {
    expect(verifySha256('abc123', 'abc124')).toBe(false);
  });

  it('tamanhos diferentes ⇒ false (short-circuit, sem comparar char a char)', () => {
    expect(verifySha256('abc', 'abcdef')).toBe(false);
    expect(verifySha256('abcdef', 'abc')).toBe(false);
  });

  it('strings vazias ⇒ true (ambas vazias, diff acumulado = 0)', () => {
    expect(verifySha256('', '')).toBe(true);
  });

  it('case-sensitive: hex maiúsculo ≠ minúsculo', () => {
    expect(verifySha256('ABCDEF', 'abcdef')).toBe(false);
  });
});

describe('isRoot — recusa CLI-SEC-H2', () => {
  it('uid 0 ⇒ true (root)', () => {
    expect(isRoot(0)).toBe(true);
  });

  it('uid não-zero ⇒ false', () => {
    expect(isRoot(1000)).toBe(false);
    expect(isRoot(-1)).toBe(false); // Windows sem uid ⇒ -1, não é "root" no sentido POSIX
  });
});

describe('shouldProvision — LEVE nunca provisiona, TURBO sempre', () => {
  it('leve ⇒ false', () => {
    expect(shouldProvision('leve')).toBe(false);
  });
  it('turbo ⇒ true', () => {
    expect(shouldProvision('turbo')).toBe(true);
  });
});

describe('resolveSidecarToggles — default-ON (§2.2-bis)', () => {
  it('sem opts ⇒ os 3 alvos ligados por default', () => {
    const toggles = resolveSidecarToggles({});
    expect([...toggles].sort()).toEqual(['headroom', 'mem0', 'ollama']);
  });

  it('ollama:false ⇒ só mem0+headroom', () => {
    const toggles = resolveSidecarToggles({ ollama: false });
    expect(toggles.has('ollama')).toBe(false);
    expect(toggles.has('mem0')).toBe(true);
    expect(toggles.has('headroom')).toBe(true);
  });

  it('todos false ⇒ conjunto vazio', () => {
    const toggles = resolveSidecarToggles({ ollama: false, mem0: false, headroom: false });
    expect(toggles.size).toBe(0);
  });

  it('explicitamente true ⇒ ligado (mesmo comportamento do default)', () => {
    const toggles = resolveSidecarToggles({ ollama: true, mem0: true, headroom: true });
    expect([...toggles].sort()).toEqual(['headroom', 'mem0', 'ollama']);
  });
});

describe('embedderSpec — lookup no catálogo', () => {
  it('modelo no catálogo ⇒ devolve o spec completo', () => {
    const spec = embedderSpec(DEFAULT_EMBEDDER_MODEL);
    expect(spec).toBeDefined();
    expect(spec?.model).toBe(DEFAULT_EMBEDDER_MODEL);
    expect(spec?.dim).toBeGreaterThan(0);
  });

  it('modelo fora do catálogo ⇒ undefined', () => {
    expect(embedderSpec('modelo-que-nao-existe')).toBeUndefined();
  });

  it('todo modelo do EMBEDDER_CATALOG é resolvível por si mesmo', () => {
    for (const e of EMBEDDER_CATALOG) {
      expect(embedderSpec(e.model)).toEqual(e);
    }
  });
});
