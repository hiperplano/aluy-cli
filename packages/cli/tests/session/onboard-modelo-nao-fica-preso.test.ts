// BUG (relato do dono) — "instalei setando outro modelo e ele FORÇOU o mesmo".
//
// A causa: o onboarding só gravava `localModel` quando o campo não estava vazio, e
// `store.save` é MERGE — então o modelo de uma instalação ANTERIOR sobrevivia. Como a
// resolução dá precedência a `config.localModel` sobre o `defaultModel` do provider, o
// modelo VELHO vencia o provider NOVO. Em máquina limpa não havia valor velho: o
// sintoma só aparecia em REINSTALAÇÃO, que é exatamente como ele o descreveu.
//
// Dois níveis: a DECISÃO (pura) e o EFEITO em disco (round-trip real no store).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOnboardLocalModel } from '../../src/session/onboard.js';
import { UserConfigStore } from '../../src/io/user-config.js';

describe('decisão — o onboarding nunca deixa o modelo por conta do valor anterior', () => {
  it('modelo escolhido num built-in é o que vale', () => {
    expect(
      resolveOnboardLocalModel({ providerId: 'openrouter', model: 'a/b', customModel: '' }),
    ).toBe('a/b');
  });

  it('caminho CUSTOM lê o campo do custom, não o do built-in', () => {
    expect(
      resolveOnboardLocalModel({ providerId: '__custom__', model: 'ignorado', customModel: 'x/y' }),
    ).toBe('x/y');
  });

  it('A CAUSA — campo vazio devolve `undefined` (LIMPA), nunca "não mexe"', () => {
    expect(
      resolveOnboardLocalModel({ providerId: '__custom__', model: '', customModel: '   ' }),
    ).toBeUndefined();
    expect(
      resolveOnboardLocalModel({ providerId: 'openrouter', model: '  ', customModel: 'x' }),
    ).toBeUndefined();
  });

  it('espaço em volta não vira modelo (o slug vai para uma requisição HTTP)', () => {
    expect(
      resolveOnboardLocalModel({ providerId: 'openrouter', model: '  a/b  ', customModel: '' }),
    ).toBe('a/b');
  });
});

describe('efeito em disco — reinstalar não pode herdar o modelo antigo', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-onb-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('REGRESSÃO — provider novo sem modelo escolhido não herda o modelo velho', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.save({ localProvider: 'antigo', localModel: 'modelo/velho' });
    // o onboarding roda de novo: outro provider, campo de modelo vazio
    store.save({
      localProvider: 'novo',
      localModel: resolveOnboardLocalModel({
        providerId: '__custom__',
        model: '',
        customModel: '',
      }),
    } as never);
    const cfg = store.load();
    expect(cfg.localProvider).toBe('novo');
    expect(cfg.localModel).toBeUndefined(); // ANTES: seguia 'modelo/velho'
  });

  it('modelo escolhido SUBSTITUI o anterior (não-regressão do caminho comum)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.save({ localProvider: 'antigo', localModel: 'modelo/velho' });
    store.save({
      localProvider: 'novo',
      localModel: resolveOnboardLocalModel({
        providerId: 'novo',
        model: 'modelo/novo',
        customModel: '',
      }),
    } as never);
    expect(store.load().localModel).toBe('modelo/novo');
  });
});
