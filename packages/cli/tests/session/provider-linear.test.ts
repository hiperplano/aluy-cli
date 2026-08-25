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

// ESTÉTICA ÚNICA — o dono: "eu quero que vc deixe tudo na mesma estetica", depois de pedir
// "uma revisao de ux profunda na visualizacao... do que acontece quando aciono os menus".
// Onze listagens passaram a usar `tableLines` (cabeçalho + régua, sem quadriculado); o
// `/provider` sem argumento ficou para trás em linha corrida, onde o resumo empurrava o
// nome para uma coluna diferente a cada linha e o `●` do ativo se perdia no meio do texto.
describe('/provider sem argumento — listagem em TABELA, com o ativo na margem', () => {
  const catalogo = [
    { name: 'openrouter', summary: 'catálogo agregado' },
    { name: 'deepseek', summary: 'barato e rápido' },
    { name: 'gmicloud' },
  ];

  /** As linhas da nota do `/provider` sem argumento. */
  function linhas(ativo: string): readonly string[] {
    return buildProviderEffect('', ativo, catalogo).note?.lines ?? [];
  }

  it('tem cabeçalho + régua (é tabela, não linha corrida)', () => {
    const l = linhas('deepseek');
    const iCab = l.findIndex((x) => x.includes('provider') && x.includes('o que é'));
    expect(iCab, 'cabeçalho ausente').toBeGreaterThan(-1);
    expect(l[iCab + 1]).toMatch(/^\s*─+\s+─+\s*$/);
  });

  it('o `●` marca SÓ o ativo e fica na MARGEM (mesma coluna em toda linha)', () => {
    const l = linhas('deepseek');
    const doProvider = l.filter((x) => /\b(openrouter|deepseek|gmicloud)\b/.test(x));
    expect(doProvider.length).toBe(3);
    const comMarca = doProvider.filter((x) => x.includes('●'));
    expect(comMarca).toHaveLength(1);
    expect(comMarca[0]).toContain('deepseek');
    // A margem: o nome começa na MESMA coluna com e sem marcador — é o que faz o `●`
    // saltar aos olhos em vez de deslocar o texto.
    const col = (x: string): number => x.search(/[A-Za-z]/);
    expect(new Set(doProvider.map(col)).size).toBe(1);
  });

  it('o resumo vai na SEGUNDA coluna, alinhado entre linhas', () => {
    const l = linhas('openrouter');
    const a = l.find((x) => x.includes('openrouter'))!;
    const b = l.find((x) => x.includes('deepseek'))!;
    expect(a.indexOf('catálogo agregado')).toBe(b.indexOf('barato e rápido'));
  });
});
