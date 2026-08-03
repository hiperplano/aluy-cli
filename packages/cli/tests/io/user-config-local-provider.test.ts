// F-PROV-FIX — dono, dogfooding: "pq quando muda o provider dentro da sessão ele não
// fixa (persiste)?". `saveLocalProvider` é a ÚNICA escrita nova deste fix (açúcar sobre
// o `save()` de sempre — nenhum mecanismo de escrita novo). Este arquivo prova o
// contrato mais importante do fix inteiro: o ROUND-TRIP — o que `saveLocalProvider`
// grava é EXATAMENTE o que `resolveLocalProviderConfig` (o que o BOOT lê) devolve na
// sessão seguinte. Sem essa prova, "save" seria um botão que não faz nada.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore, CONFIG_FILENAME } from '../../src/io/user-config.js';
import { resolveLocalProviderConfig } from '../../src/model/local/config.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-local-provider-cfg-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('UserConfigStore.saveLocalProvider — escrita', () => {
  it('grava provider+modelo e relê de volta (mesmos campos que o boot consome)', () => {
    const store = new UserConfigStore({ baseDir: base });
    expect(store.saveLocalProvider('openai', 'gpt-4o-mini')).toBe(true);
    const cfg = new UserConfigStore({ baseDir: base }).load();
    expect(cfg.localProvider).toBe('openai');
    expect(cfg.localModel).toBe('gpt-4o-mini');
  });

  it('sem `model`: grava só o provider, PRESERVANDO o `localModel` já salvo antes', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveLocalProvider('anthropic', 'claude-opus-4-8');
    // 2ª chamada, agora só trocando o provider (ex.: /provider save logo após um
    // /provider <novo> — o modelo default ainda não foi customizado nesta sessão).
    store.saveLocalProvider('tokenrouter');
    const cfg = store.load();
    expect(cfg.localProvider).toBe('tokenrouter');
    expect(cfg.localModel).toBe('claude-opus-4-8'); // NÃO apagou o modelo salvo antes
  });

  it('preserva OUTRAS preferências já salvas (tema, tier) — merge, não sobrescreve tudo', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveTier('aluy-granito');
    store.saveTheme('aluy-light');
    store.saveLocalProvider('deepseek', 'deepseek-chat');
    const cfg = store.load();
    expect(cfg.tier).toBe('aluy-granito');
    expect(cfg.theme).toBe('aluy-light');
    expect(cfg.localProvider).toBe('deepseek');
  });

  it('provider vazio/só espaço: NÃO grava (recusa lixo, devolve false)', () => {
    const store = new UserConfigStore({ baseDir: base });
    expect(store.saveLocalProvider('   ')).toBe(false);
    expect(store.load().localProvider).toBeUndefined();
  });

  it('FAIL-SAFE — falha de escrita (disco indisponível) devolve `false`, NUNCA lança', () => {
    // `base` é um ARQUIVO (não diretório) ⇒ `mkdirSync(base, {recursive:true})` falha
    // (ENOTDIR) — simula disco cheio/permissão sem depender de bits de permissão (que
    // se comportam diferente sob root/CI). A chamada NUNCA deve lançar.
    const fileAsBase = join(base, 'not-a-dir');
    writeFileSync(fileAsBase, 'eu sou um arquivo, não um diretório');
    const store = new UserConfigStore({ baseDir: fileAsBase });
    expect(() => store.saveLocalProvider('openai', 'gpt-4o')).not.toThrow();
    expect(store.saveLocalProvider('openai', 'gpt-4o')).toBe(false);
  });

  it('NUNCA persiste credencial — só provider/modelo (DADO de catálogo) chegam ao disco', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveLocalProvider('openai', 'gpt-4o-mini');
    const raw = readFileSync(join(base, CONFIG_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // só os DOIS campos de catálogo — nada de apiKey/token/secret/credential.
    expect(Object.keys(parsed).sort()).toEqual(['localModel', 'localProvider']);
    expect(raw.toLowerCase()).not.toMatch(/apikey|api_key|token|secret|credential|bearer/);
  });
});

describe('round-trip — o que saveLocalProvider grava é o que resolveLocalProviderConfig lê no boot seguinte', () => {
  it('provider+modelo salvos SÃO os resolvidos no boot (sem flag/env, config vence o default)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveLocalProvider('openai', 'gpt-4o-mini');

    // "próxima sessão": um NOVO store aponta pro MESMO baseDir e lê do zero (nenhum
    // estado em memória sobrevive — só o arquivo).
    const bootConfig = new UserConfigStore({ baseDir: base }).load();
    const resolved = resolveLocalProviderConfig({ env: {}, config: bootConfig });

    expect(resolved.provider).toBe('openai');
    expect(resolved.model).toBe('gpt-4o-mini');
  });

  it('trocar o provider salvo (sem modelo novo) resolve o par (provider novo · modelo antigo preservado)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveLocalProvider('anthropic', 'claude-opus-4-8');
    store.saveLocalProvider('openai'); // só o provider — modelo antigo fica no config

    const bootConfig = new UserConfigStore({ baseDir: base }).load();
    const resolved = resolveLocalProviderConfig({ env: {}, config: bootConfig });

    expect(resolved.provider).toBe('openai');
    // o `localModel` salvo (`claude-opus-4-8`) NÃO é um modelo do catálogo openai, mas
    // `resolveLocalProviderConfig` não valida contra o catálogo do provider (o slug é
    // OPACO/passthrough, como o tier Custom) — prova que o valor gravado É o lido, sem
    // reescrita silenciosa por trás.
    expect(resolved.model).toBe('claude-opus-4-8');
  });

  it('SEM nada salvo (1ª execução): resolve o default do catálogo, nunca lança', () => {
    const bootConfig = new UserConfigStore({ baseDir: base }).load();
    const resolved = resolveLocalProviderConfig({ env: {}, config: bootConfig });
    // default de fábrica (1ª entrada wave:1 do catálogo embutido) — comportamento
    // pré-existente, intocado por este fix.
    expect(resolved.provider).toBe('anthropic');
  });

  it('flag/env de boot AINDA vencem o padrão salvo (precedência intocada por este fix)', () => {
    const store = new UserConfigStore({ baseDir: base });
    store.saveLocalProvider('openai', 'gpt-4o-mini');
    const bootConfig = new UserConfigStore({ baseDir: base }).load();

    const resolvedWithFlag = resolveLocalProviderConfig({
      flags: { localProvider: 'deepseek' },
      env: {},
      config: bootConfig,
    });
    expect(resolvedWithFlag.provider).toBe('deepseek'); // flag > config salva

    const resolvedWithEnv = resolveLocalProviderConfig({
      env: { ALUY_LOCAL_PROVIDER: 'ollama' },
      config: bootConfig,
    });
    expect(resolvedWithEnv.provider).toBe('ollama'); // env > config salva
  });
});
