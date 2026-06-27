// EST-0970 · CLI-SEC-7 — heurística "este --env parece SEGREDO literal?" (avisa, não bloqueia).

import { describe, expect, it } from 'vitest';
import { inspectEnvSecret } from '../../src/mcp/secret-heuristic.js';

describe('inspectEnvSecret — alto recall p/ avisar (não bloquear)', () => {
  it('referência $VAR / ${VAR} / %VAR% NUNCA é segredo (forma recomendada)', () => {
    for (const v of ['$MY_TOKEN', '${GITHUB_TOKEN}', '%API_KEY%']) {
      expect(inspectEnvSecret('GITHUB_TOKEN', v).looksLikeSecret).toBe(false);
    }
  });

  it('chave com nome de segredo + valor não-vazio ⇒ avisa', () => {
    const r = inspectEnvSecret('GITHUB_TOKEN', 'abc');
    expect(r.looksLikeSecret).toBe(true);
    expect(r.signals).toContain('secret-key-name');
  });

  it('chave de segredo mas valor VAZIO (placeholder) ⇒ não avisa', () => {
    expect(inspectEnvSecret('API_KEY', '').looksLikeSecret).toBe(false);
  });

  it('valor alto-entropia (parece credencial) ⇒ avisa mesmo com chave neutra', () => {
    // string sintética alto-entropia (mistura de classes, longa) — NÃO tem forma de
    // token de provider (sem prefixo sk-/ghp_): testa só o sinal genérico de entropia.
    const r = inspectEnvSecret('CONFIG', 'Zq7Wn3Xb9Kc2Vf8Rt5Lp1Mh4Jd6Yg0');
    expect(r.looksLikeSecret).toBe(true);
    expect(r.signals).toContain('high-entropy');
  });

  it('valor comum (palavra/curto/caminho) NÃO avisa (evita falso-positivo)', () => {
    expect(inspectEnvSecret('NODE_ENV', 'production').looksLikeSecret).toBe(false);
    expect(inspectEnvSecret('LANG', 'pt_BR.UTF-8').looksLikeSecret).toBe(false);
    expect(inspectEnvSecret('PATH', '/usr/local/bin').looksLikeSecret).toBe(false);
    expect(inspectEnvSecret('HOME', '~/projects').looksLikeSecret).toBe(false);
  });

  it('chave de segredo com valor de REFERÊNCIA não avisa (caminho certo)', () => {
    expect(inspectEnvSecret('GITHUB_TOKEN', '$GH_TOKEN').looksLikeSecret).toBe(false);
  });
});

describe('inspectEnvSecret — guards de looksHighEntropy (EST-1015)', () => {
  // Usamos chave NEUTRA (não parece segredo) p/ isolar a heurística de entropia.
  // O único sinal possível é 'high-entropy'.

  it('(1) valor CURTO (< 20 chars) ⇒ sem high-entropy', () => {
    const r = inspectEnvSecret('PORT', 'abc123');
    expect(r.signals).not.toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(false);
  });

  it('(2) valor COM ESPAÇO ⇒ sem high-entropy', () => {
    const r = inspectEnvSecret('CONFIG', 'isto e uma frase com muitos caracteres');
    expect(r.signals).not.toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(false);
  });

  it('(3) valor que começa COM / (caminho) ⇒ sem high-entropy', () => {
    const r = inspectEnvSecret('CONFIG', '/usr/local/bin/aluy-binario-longo-aqui');
    expect(r.signals).not.toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(false);
  });

  it('(4) caractere NÃO permitido em credencial (ç,#) ⇒ sem high-entropy', () => {
    const r = inspectEnvSecret('CONFIG', 'texto-com-acento-ç-e-simbolo-#-aqui-longo');
    expect(r.signals).not.toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(false);
  });

  it('(5) 1 classe + length < 32 ⇒ sem high-entropy', () => {
    const r = inspectEnvSecret('CONFIG', 'aaaaaaaaaaaaaaaaaaaaaaa');
    expect(r.signals).not.toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(false);
  });

  it('(6) mix de maiúscula+minúscula+dígito e ≥ 20 ⇒ high-entropy', () => {
    const r = inspectEnvSecret('CONFIG', 'sk-AbCdEf0123456789XyZ');
    expect(r.signals).toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(true);
  });

  it('(7) length ≥ 32 (quase 1 classe) ⇒ high-entropy', () => {
    const r = inspectEnvSecret('CONFIG', 'abcdef0123456789abcdef0123456789ab');
    expect(r.signals).toContain('high-entropy');
    expect(r.looksLikeSecret).toBe(true);
  });

  it('(8) referência de env $VAR / ${VAR} / %VAR% ⇒ não parece segredo', () => {
    for (const val of ['$MINHA_VAR', '${VAR}', '%VAR%']) {
      const r = inspectEnvSecret('API_KEY', val);
      expect(r.looksLikeSecret).toBe(false);
      expect(r.signals).toEqual([]);
    }
  });

  it('(9) secret-key-name com valor não-vazio ⇒ sinal; vazio ⇒ não', () => {
    const r1 = inspectEnvSecret('API_KEY', 'um-valor-qualquer');
    expect(r1.signals).toContain('secret-key-name');
    expect(r1.looksLikeSecret).toBe(true);

    const r2 = inspectEnvSecret('API_KEY', '');
    expect(r2.signals).not.toContain('secret-key-name');
    expect(r2.looksLikeSecret).toBe(false);
  });
});
