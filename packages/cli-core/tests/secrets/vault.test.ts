// ADR 0005 — cofre de segredos: validação, redação por VALOR EXATO (inclusive em stream) e
// o gancho no ponto único de CLI-SEC-6.

import { afterEach, describe, expect, it } from 'vitest';
import {
  SECRET_REDACTED,
  SecretVault,
  StreamRedactor,
  redactCommandSecrets,
  redactOutputSecrets,
  secretVault,
  secretsPromptBlock,
  validateSecretName,
} from '../../src/index.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';

afterEach(() => secretVault.clear());

describe('validação', () => {
  it('só aceita NOME em MAIÚSCULAS/dígitos/_ e recusa nomes reservados', () => {
    expect(validateSecretName('API_KEY').ok).toBe(true);
    expect(validateSecretName('api_key').ok).toBe(false);
    expect(validateSecretName('1ABC').ok).toBe(false);
    expect(validateSecretName('A-B').ok).toBe(false);
    const r = validateSecretName('PATH');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('reserved-name');
  });

  it('a mensagem de nome inválido NÃO ecoa o que foi digitado (pode ser o valor)', () => {
    const r = validateSecretName(CANARY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(CANARY);
  });

  it('recusa valor < 8 chars sem force; com force guarda e marca weak', () => {
    const v = new SecretVault();
    const curto = v.set('TOK', '123');
    expect(curto.ok).toBe(false);
    if (!curto.ok) expect(curto.code).toBe('too-short');
    expect(v.has('TOK')).toBe(false);
    const forcado = v.set('TOK', '123', { force: true });
    expect(forcado).toEqual({ ok: true, weak: true });
    expect(v.has('TOK')).toBe(true);
  });

  it('recusa vazio', () => {
    expect(new SecretVault().set('TOK', '').ok).toBe(false);
  });
});

describe('redação por valor exato', () => {
  it('troca todas as ocorrências por ‹redigido› e some após remove', () => {
    const v = new SecretVault();
    v.set('API_KEY', CANARY);
    expect(v.redact(`a ${CANARY} b ${CANARY}`)).toBe(`a ${SECRET_REDACTED} b ${SECRET_REDACTED}`);
    expect(v.remove('API_KEY')).toBe(true);
    expect(v.redact(`a ${CANARY}`)).toBe(`a ${CANARY}`);
    expect(v.has('API_KEY')).toBe(false);
  });

  it('cobre a forma escapada para JSON (corpo de requisição / registro de sessão)', () => {
    const v = new SecretVault();
    const raro = 'pa"ss\\word-xyz-123';
    v.set('DB_PASSWORD', raro);
    const json = JSON.stringify({ t: `senha ${raro}` });
    expect(v.redact(json)).not.toContain('pa\\"ss');
    expect(JSON.parse(v.redact(json)).t).toBe(`senha ${SECRET_REDACTED}`);
  });

  it('o valor mais longo ganha de um valor que o contém (não sobra resto)', () => {
    const v = new SecretVault();
    v.set('CURTO', 'abcdefgh');
    v.set('LONGO', 'abcdefgh-ijklmnop');
    expect(v.redact('x abcdefgh-ijklmnop y')).toBe(`x ${SECRET_REDACTED} y`);
  });

  it('está plugado no PONTO ÚNICO de CLI-SEC-6 (redactCommandSecrets/redactOutputSecrets)', () => {
    secretVault.set('API_KEY', CANARY);
    // um valor que NENHUMA regra por padrão reconheceria
    expect(redactOutputSecrets(`token=nada e ${CANARY}`)).not.toContain(CANARY);
    expect(redactCommandSecrets(`echo ${CANARY}`)).not.toContain(CANARY);
    expect(redactOutputSecrets(CANARY)).toBe(SECRET_REDACTED);
  });
});

describe('referência e env', () => {
  it('referencedBy respeita a fronteira de identificador', () => {
    const v = new SecretVault();
    v.set('API_KEY', CANARY);
    expect(v.referencedBy('curl -H "x: $API_KEY"')).toEqual(['API_KEY']);
    expect(v.referencedBy('echo ${API_KEY}')).toEqual(['API_KEY']);
    expect(v.referencedBy('echo $MY_API_KEY_2')).toEqual([]);
    expect(v.referencedBy('echo oi')).toEqual([]);
  });

  it('envFor devolve SÓ os citados; envAll todos', () => {
    const v = new SecretVault();
    v.set('A_KEY', 'aaaaaaaa1');
    v.set('B_KEY', 'bbbbbbbb2');
    expect(v.envFor('echo $A_KEY')).toEqual({ A_KEY: 'aaaaaaaa1' });
    expect(v.envFor('ls')).toEqual({});
    expect(Object.keys(v.envAll()).sort()).toEqual(['A_KEY', 'B_KEY']);
  });
});

describe('StreamRedactor — valor partido entre chunks', () => {
  it.each([1, 2, 3, 5, 7])('chunks de %i caractere(s): o valor nunca vaza', (size) => {
    secretVault.set('API_KEY', CANARY);
    const texto = `inicio ${CANARY} fim\n`;
    const r = new StreamRedactor();
    let saida = '';
    for (let i = 0; i < texto.length; i += size) saida += r.push(texto.slice(i, i + size));
    saida += r.flush();
    expect(saida).toBe(`inicio ${SECRET_REDACTED} fim\n`);
  });

  it('prefixo que nunca se completa é devolvido no flush (nada some)', () => {
    secretVault.set('API_KEY', CANARY);
    const r = new StreamRedactor();
    const a = r.push('abc ZIMBRO-can');
    expect(a).toBe('abc ');
    expect(a + r.flush()).toBe('abc ZIMBRO-can');
  });

  it('sem segredos é passa-direto (sem retenção)', () => {
    const r = new StreamRedactor();
    expect(r.push('ZIMBRO-can')).toBe('ZIMBRO-can');
  });
});

describe('prompt: só os NOMES', () => {
  it('lista os nomes e NUNCA o valor; vazio ⇒ nenhum bloco', () => {
    expect(secretsPromptBlock()).toEqual([]);
    secretVault.set('API_KEY', CANARY);
    const bloco = secretsPromptBlock().join('\n');
    expect(bloco).toContain('$API_KEY');
    expect(bloco).not.toContain(CANARY);
    expect(bloco).toMatch(/NUNCA deve pedi-lo/);
  });
});
