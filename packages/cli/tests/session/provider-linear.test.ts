// EST-0962 · /provider — buildProviderEffect (lista/seta/inválido/igual) +
// runProviderLinear (não-TTY, §9) + o catálogo estático (resolveProviderName). Sem
// picker; espelha o theme-linear. HG-2: só o NOME do provider, nunca credencial.

import { describe, expect, it } from 'vitest';
import { buildProviderEffect } from '../../src/slash/handlers.js';
import { runProviderLinear, type LinearOut } from '../../src/session/linear.js';
import { PROVIDERS, resolveProviderName } from '../../src/model/providers.js';
import type { ProviderName } from '../../src/model/providers.js';

function makeOut(): { out: LinearOut; text: () => string } {
  let buf = '';
  return { out: { write: (c) => (buf += c) }, text: () => buf };
}

describe('providers catalog (seed)', () => {
  it('lista openrouter (default) + deepseek', () => {
    const names = PROVIDERS.map((p) => p.name);
    expect(names).toEqual(['openrouter', 'deepseek']);
    expect(PROVIDERS.find((p) => p.name === 'openrouter')?.isDefault).toBe(true);
  });

  it('resolveProviderName é case-insensitive + trim; desconhecido ⇒ undefined', () => {
    expect(resolveProviderName('DeepSeek')?.name).toBe('deepseek');
    expect(resolveProviderName('  openrouter ')?.name).toBe('openrouter');
    expect(resolveProviderName('anthropic')).toBeUndefined();
    expect(resolveProviderName('')).toBeUndefined();
  });
});

describe('buildProviderEffect', () => {
  it('sem arg ⇒ LISTA os providers, marca o ativo, não seta', () => {
    const e = buildProviderEffect('', 'deepseek');
    expect(e.kind).toBe('provider');
    if (e.kind === 'provider') {
      expect(e.provider).toBeUndefined(); // não seta
      const joined = e.note.lines.join('\n');
      expect(joined).toContain('openrouter');
      expect(joined).toContain('deepseek');
      expect(joined).toContain('● deepseek'); // marca o ativo
    }
  });

  it('`/provider deepseek` ⇒ seta deepseek', () => {
    const e = buildProviderEffect('deepseek', undefined);
    expect(e.kind).toBe('provider');
    if (e.kind === 'provider') {
      expect(e.provider).toBe('deepseek');
      expect(e.note.lines.join(' ')).toContain('DeepSeek');
    }
  });

  it('`/provider deepseek` quando já é o ativo ⇒ não re-aplica (provider undefined)', () => {
    const e = buildProviderEffect('deepseek', 'deepseek');
    expect(e.kind).toBe('provider');
    if (e.kind === 'provider') {
      expect(e.provider).toBeUndefined();
      expect(e.note.lines.join(' ')).toContain('já é');
    }
  });

  it('nome inválido ⇒ nota honesta, não seta', () => {
    const e = buildProviderEffect('anthropic', undefined);
    expect(e.kind).toBe('provider');
    if (e.kind === 'provider') {
      expect(e.provider).toBeUndefined();
      const joined = e.note.lines.join('\n');
      expect(joined).toContain('desconhecido');
      expect(joined).toContain('openrouter, deepseek'); // lista os disponíveis
    }
  });

  it('a nota NUNCA expõe credencial/base_url (HG-2/CLI-SEC-7)', () => {
    const joined = buildProviderEffect('', 'openrouter').note.lines.join('\n').toLowerCase();
    expect(joined).not.toContain('api_key');
    expect(joined).not.toContain('base_url');
    expect(joined).not.toContain('http');
  });
});

describe('runProviderLinear — não-TTY (§9)', () => {
  it('ignora o que não é /provider (devolve false)', () => {
    const { out } = makeOut();
    const deps = { currentProvider: undefined, setProvider: () => {} };
    expect(runProviderLinear('faça um café', out, deps)).toBe(false);
    expect(runProviderLinear('/model', out, deps)).toBe(false);
    expect(runProviderLinear('/providerx', out, deps)).toBe(false);
  });

  it('`/provider` lista os providers marcando o ativo (sem setar)', () => {
    const { out, text } = makeOut();
    let setTo: ProviderName | undefined;
    const handled = runProviderLinear('/provider', out, {
      currentProvider: 'deepseek',
      setProvider: (n) => (setTo = n),
    });
    expect(handled).toBe(true);
    expect(setTo).toBeUndefined(); // listar não seta
    const t = text();
    expect(t).toContain('[provider]');
    expect(t).toContain('openrouter');
    expect(t).toContain('● deepseek'); // ativo
  });

  it('`/provider deepseek` SETA o provider e confirma', () => {
    const { out, text } = makeOut();
    let setTo: ProviderName | undefined;
    const handled = runProviderLinear('/provider deepseek', out, {
      currentProvider: undefined,
      setProvider: (n) => (setTo = n),
    });
    expect(handled).toBe(true);
    expect(setTo).toBe('deepseek');
    expect(text()).toContain('DeepSeek');
  });

  it('`/provider nope` ⇒ nota de desconhecido, NÃO seta', () => {
    const { out, text } = makeOut();
    let setCalled = false;
    expect(
      runProviderLinear('/provider nope', out, {
        currentProvider: undefined,
        setProvider: () => (setCalled = true),
      }),
    ).toBe(true);
    expect(setCalled).toBe(false);
    expect(text().toLowerCase()).toContain('desconhecido');
  });
});
