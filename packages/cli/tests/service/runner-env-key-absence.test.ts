// ADR-0158 §4.1 — `buildActivityEnv`: fecha um sobrevivente de MUTAÇÃO achado numa
// auditoria (Stryker, pass 3) que `runner-activity-goal.test.ts` (teste alheio, NÃO
// editado aqui) não alcançava: `expect(env.ALUY_SERVICE_PERSONA).toBeUndefined()`
// passa IGUALMENTE se a chave está AUSENTE do objeto OU presente com valor
// `undefined` (`{ALUY_SERVICE_PERSONA: undefined}` via spread condicional) — as duas
// formas leem como `undefined` no acesso. O mutante `agent !== undefined ? {...} :
// {}` ⇒ `true ? {...} : {}` sobrevive porque SEMPRE espalha `{ALUY_SERVICE_PERSONA:
// agent}` (com `agent` undefined quando não declarado) — o "valor" lido é idêntico,
// só a PRESENÇA da chave difere. Arquivo SEPARADO — só ESTENDE a cobertura.
import { describe, expect, it } from 'vitest';
import { buildActivityEnv } from '../../src/service/runner.js';

describe('buildActivityEnv — ausência de agente ⇒ a CHAVE "ALUY_SERVICE_PERSONA" nem existe no objeto (não só "valor undefined")', () => {
  it('sem agent ⇒ "ALUY_SERVICE_PERSONA" in env é FALSE (nunca uma chave presente com undefined)', () => {
    const env = buildActivityEnv('/svc/trader', undefined, {});
    expect('ALUY_SERVICE_PERSONA' in env).toBe(false);
    expect(Object.keys(env)).toEqual(['ALUY_SERVICE_HOME']);
  });

  it('com agent ⇒ a chave está presente E com o valor certo', () => {
    const env = buildActivityEnv('/svc/trader', 'risco', {});
    expect('ALUY_SERVICE_PERSONA' in env).toBe(true);
    expect(env.ALUY_SERVICE_PERSONA).toBe('risco');
  });
});
