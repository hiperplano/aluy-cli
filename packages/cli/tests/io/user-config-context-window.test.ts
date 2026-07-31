// F-WIN (descoberta) — PERSISTÊNCIA da janela descoberta em
// `providers[<id>].contextByModel` (`UserConfigStore.registerModelContextWindow`). É o
// que faz "descobre uma vez, nunca mais": da 2ª sessão em diante o número já está no
// config e o `modelWindowFromConfig` o acha ANTES de qualquer chamada de rede.
//
// Bateria (mesma disciplina do `registerLocalModel` do ADR-0153):
//   - grava preservando TODO o resto (outras entradas e os demais campos DAQUELA);
//   - IDEMPOTENTE (não sobrescreve — inclusive um número ajustado à mão pelo dono);
//   - fail-safe: provider sem entrada / valor inválido ⇒ `false` SEM gravar;
//   - o número volta pelo `load()` já sanitizado (round-trip real em disco).
//
// Tudo sobre um tmpdir (baseDir injetado) — a suíte NUNCA toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore, CONFIG_FILENAME } from '../../src/io/user-config.js';

let base: string;
let store: UserConfigStore;

const PROVIDER = {
  id: 'tokenrouter',
  wireFormat: 'openai-compat' as const,
  baseUrl: 'https://gateway.test/v1',
  defaultModel: 'zai/glm-4.6',
  auth: ['api-key'],
  models: ['zai/glm-4.6'],
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-ctxwin-'));
  store = new UserConfigStore({ baseDir: base });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Config CRU em disco (p/ provar que nada além do esperado foi tocado). */
function raw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(base, CONFIG_FILENAME), 'utf8')) as Record<string, unknown>;
}

describe('registerModelContextWindow — grava a janela descoberta', () => {
  it('grava o par slug→tokens e PRESERVA o resto da entrada', () => {
    store.save({ providers: [PROVIDER] });
    expect(store.registerModelContextWindow('tokenrouter', 'zai/glm-4.6', 200_000)).toBe(true);

    const entry = store.load().providers?.[0];
    expect(entry?.contextByModel).toEqual({ 'zai/glm-4.6': 200_000 });
    // Nada mais mudou — nem `models` (do test-then-register), nem baseUrl/auth.
    expect(entry?.baseUrl).toBe(PROVIDER.baseUrl);
    expect(entry?.auth).toEqual(PROVIDER.auth);
    expect(entry?.models).toEqual(PROVIDER.models);
    // E NENHUMA credencial foi parar no arquivo (só DADO público).
    expect(JSON.stringify(raw())).not.toMatch(/sk-|api[_-]?key["']?\s*:/i);
  });

  it('não mexe nas OUTRAS entradas de provider', () => {
    const outro = { ...PROVIDER, id: 'outro', baseUrl: 'https://outro.test/v1' };
    store.save({ providers: [PROVIDER, outro] });
    store.registerModelContextWindow('tokenrouter', 'zai/glm-4.6', 200_000);
    const providers = store.load().providers ?? [];
    expect(providers).toHaveLength(2);
    expect(providers[1]?.contextByModel).toBeUndefined();
  });

  it('IDEMPOTENTE: já declarado ⇒ `true` sem sobrescrever (o número do dono manda)', () => {
    store.save({ providers: [{ ...PROVIDER, contextByModel: { 'zai/glm-4.6': 131_072 } }] });
    expect(store.registerModelContextWindow('tokenrouter', 'zai/glm-4.6', 200_000)).toBe(true);
    expect(store.load().providers?.[0]?.contextByModel).toEqual({ 'zai/glm-4.6': 131_072 });
  });

  it('idempotência é case-insensitive (não cria DUAS chaves p/ o mesmo modelo)', () => {
    store.save({ providers: [{ ...PROVIDER, contextByModel: { 'Zai/GLM-4.6': 131_072 } }] });
    expect(store.registerModelContextWindow('tokenrouter', 'zai/glm-4.6', 200_000)).toBe(true);
    expect(Object.keys(store.load().providers?.[0]?.contextByModel ?? {})).toEqual(['Zai/GLM-4.6']);
  });

  it('SOMA um slug novo ao mapa existente (append, não substituição)', () => {
    store.save({ providers: [{ ...PROVIDER, contextByModel: { 'a/b': 32_000 } }] });
    store.registerModelContextWindow('tokenrouter', 'c/d', 128_000);
    expect(store.load().providers?.[0]?.contextByModel).toEqual({ 'a/b': 32_000, 'c/d': 128_000 });
  });

  it('provider SEM entrada em `providers[]` (built-in) ⇒ `false`, sem gravar', () => {
    store.save({ providers: [PROVIDER] });
    expect(store.registerModelContextWindow('ollama', 'llama3', 128_000)).toBe(false);
    expect(store.load().providers?.[0]?.contextByModel).toBeUndefined();
  });

  it('valor inválido ⇒ `false`, sem gravar (2ª trava contra denominador podre)', () => {
    store.save({ providers: [PROVIDER] });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(store.registerModelContextWindow('tokenrouter', 'zai/glm-4.6', bad)).toBe(false);
    }
    expect(store.registerModelContextWindow('tokenrouter', '   ', 128_000)).toBe(false);
    expect(store.registerModelContextWindow('  ', 'zai/glm-4.6', 128_000)).toBe(false);
    expect(store.load().providers?.[0]?.contextByModel).toBeUndefined();
  });

  it('convive com o `registerLocalModel` (ADR-0153) — os dois campos coexistem', () => {
    store.save({ providers: [PROVIDER] });
    expect(store.registerLocalModel('tokenrouter', 'novo/slug')).toBe(true);
    expect(store.registerModelContextWindow('tokenrouter', 'novo/slug', 128_000)).toBe(true);
    const entry = store.load().providers?.[0];
    expect(entry?.models).toEqual(['zai/glm-4.6', 'novo/slug']);
    expect(entry?.contextByModel).toEqual({ 'novo/slug': 128_000 });
  });
});
