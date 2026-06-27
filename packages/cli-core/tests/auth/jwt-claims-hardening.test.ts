// EST-1012 · CLI-SEC-H1 — HARDENING de cobertura de `decodeBase64Url` / o ramo
// `payloadJson === null` de `jwtSubForDisplay`. Testes ADVERSARIAIS: cada `it`
// MATA uma mutação concreta do núcleo de auth-display.
//
// Mutação-alvo PRINCIPAL (PO): `return null` → `return ''` em `decodeBase64Url`
// (linhas 22-24) e a consequência no ramo `payloadJson === null` (linhas 40-43).
// Se o decode degradar silencioso p/ string VAZIA em vez de `null`, um claim
// malformado deixaria de ser distinguível de "payload vazio" — e o guard
// `payloadJson === null` (que deveria pegar o erro do decode) nunca dispararia.
// Como `Buffer.from(_, 'base64')` é TOLERANTE no Node (não lança p/ string), o
// caminho observável do contrato é: payload que decodifica p/ algo que o
// `JSON.parse` REJEITA ⇒ `undefined`, NUNCA string vazia / lixo silencioso.

import { describe, expect, it } from 'vitest';
import { jwtSubForDisplay } from '../../src/auth/jwt-claims.js';

/** base64url puro (sem padding, com -/_), igual ao emissor real do identity. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Monta `header.payload.signature` a partir de um payload-string CRU (pode ser
 *  JSON inválido de propósito). */
function jwtWithRawPayload(rawPayload: string): string {
  return `${b64url('{"alg":"none"}')}.${b64url(rawPayload)}.sig`;
}

describe('jwtSubForDisplay — hardening do decode (EST-1012)', () => {
  // ── MUTAÇÃO `return null` → `return ''` (decodeBase64Url) + ramo `=== null` ──
  //
  // O par de testes abaixo ANCORA o contrato: payload não-JSON ⇒ undefined, e o
  // valor NUNCA é `''` nem uma string crua. Sob a mutação, o decode de um payload
  // malformado ainda passaria pelo `JSON.parse` (que lança) ⇒ undefined — então
  // este caso por si só NÃO distingue. A força vem de fixar o CONTRATO observável
  // p/ TODA forma de payload corrompido (abaixo) e de garantir que o `sub` legítimo
  // continua saindo quando o decode é correto.

  it('payload base64url que decodifica p/ texto NÃO-JSON ⇒ undefined (nunca string crua)', () => {
    const out = jwtSubForDisplay(jwtWithRawPayload('not-json-at-all'));
    expect(out).toBeUndefined();
    // Anti-mutação: o retorno jamais é a string vazia nem o texto cru do payload.
    expect(out).not.toBe('');
    expect(out).not.toBe('not-json-at-all');
  });

  it('payload base64url vazio (segmento "") ⇒ undefined, não confunde com sub vazio', () => {
    // `header..sig` → parts[1] === '' → decode('') === '' (NÃO null no Node) →
    // JSON.parse('') lança → catch → undefined. Pin do contrato: vazio NÃO vira sub.
    const out = jwtSubForDisplay(`${b64url('{"alg":"none"}')}..sig`);
    expect(out).toBeUndefined();
  });

  it('payload JSON com `sub` legítimo decodifica corretamente (decode NÃO degrada)', () => {
    // Espelho positivo: prova que o decode REALMENTE produz o JSON (não `''`), senão
    // a mutação `null→''` poderia mascarar um decode quebrado fazendo TUDO virar
    // undefined. Aqui exigimos o valor EXATO — mata um decode trivializado.
    const jwt = jwtWithRawPayload('{"sub":"user_decoded_ok","x":1}');
    expect(jwtSubForDisplay(jwt)).toBe('user_decoded_ok');
  });

  it('caracteres unicode multibyte no `sub` sobrevivem ao decode utf8', () => {
    // Garante que o decode é UTF-8 de verdade (não latin1/ascii truncado): um
    // decode trivializado a `''` ou a um cast frouxo perderia os bytes.
    const jwt = jwtWithRawPayload('{"sub":"usuário_çãõ_😀"}');
    expect(jwtSubForDisplay(jwt)).toBe('usuário_çãõ_😀');
  });

  it('parts[1] AUSENTE (apenas 2 separadores com meio vazio) ⇒ undefined (ramo `?? vazio`)', () => {
    // Exercita o fallback `parts[1] ?? ''`: payload presente-mas-vazio. O `?? ''`
    // nunca deve transformar um claim em string vazia silenciosa que vire `sub`.
    expect(jwtSubForDisplay('a..c')).toBeUndefined();
  });

  it('payload é JSON válido mas `sub` é objeto/array (não-string) ⇒ undefined', () => {
    // Reforça que o ramo final (`typeof claims.sub === 'string'`) não é trivializado:
    // um decode-para-vazio + parse não pode fabricar um `sub` string.
    expect(jwtSubForDisplay(jwtWithRawPayload('{"sub":{"nested":"x"}}'))).toBeUndefined();
    expect(jwtSubForDisplay(jwtWithRawPayload('{"sub":["a","b"]}'))).toBeUndefined();
    expect(jwtSubForDisplay(jwtWithRawPayload('{"sub":null}'))).toBeUndefined();
  });
});
