// SILÊNCIO-DO-PROVIDER (dogfooding real) — a sessão do dono parou com
//
//   ╭ ● provider local indisponível ──── ✗
//   │ não consegui falar com o provider local.
//
// e mais nada. Sem status, sem causa, sem log em lugar nenhum (`ALUY_DEBUG_RENDER` é
// só de render). A razão verdadeira — a sessão retomada tinha ~92k tokens e o provider
// recusou o payload — só apareceu depois de reproduzir a chamada À MÃO, por fora da
// ferramenta. Quem não tem o código do aluy na frente não tinha COMO chegar lá.
//
// A regra "nunca ecoa `err.message` cru" existe pela invariante HG-2: no broker
// HOSPEDADO, a mensagem não pode revelar QUAL vendor atende o tier. No backend LOCAL
// (BYO) isso não se aplica: o provider é do PRÓPRIO DONO, endpoint e credencial dele.
// Esconder a razão ali não protege ninguém — só cega quem pode corrigir. O mesmo
// arquivo já abre exceção idêntica no 422 ("a frase útil tem que chegar a ele").
//
// Estes testes travam os dois lados: o motivo APARECE no local e NÃO VAZA no broker.

import { describe, expect, it } from 'vitest';
import { classifyBrokerError } from '../../src/session/controller.js';

describe('classifyBrokerError — backend LOCAL diz o MOTIVO', () => {
  it('erro inesperado carrega a causa (o silêncio que custou o diagnóstico)', () => {
    const c = classifyBrokerError(new Error('400 context length exceeded: 92k > 64k'), 'local');
    expect(c.headline).toBe('provider local indisponível');
    expect(c.message).toContain('context length exceeded');
    expect(c.message).toContain('92k');
  });

  it('falha de TRANSPORTE também — "não conectei" sozinho não diz o que fazer', () => {
    const c = classifyBrokerError(new Error('connect ECONNREFUSED 127.0.0.1:8787'), 'local');
    expect(c.message).toContain('ECONNREFUSED');
  });

  it('o motivo é REDIGIDO — um eco de payload pode trazer o Authorization junto', () => {
    const c = classifyBrokerError(
      new Error('401 from provider: {"headers":{"authorization":"Bearer sk-or-v1-abcdef1234567890"}}'),
      'local',
    );
    expect(c.message).not.toContain('sk-or-v1-abcdef1234567890');
  });

  it('motivo LONGO é clampado a uma linha — não despeja um JSON inteiro no bloco', () => {
    const c = classifyBrokerError(new Error('x'.repeat(5000)), 'local');
    expect(c.message.length).toBeLessThan(400);
    expect(c.message.split('\n')).toHaveLength(1);
  });

  it('erro SEM mensagem degrada p/ a frase neutra — nunca " — " órfão', () => {
    const c = classifyBrokerError(new Error(''), 'local');
    expect(c.message).toBe('não consegui falar com o provider local.');
    expect(c.message.trimEnd()).not.toMatch(/—$/);
  });

  it('erro que não é Error (string/objeto) não quebra', () => {
    expect(classifyBrokerError('pane seca', 'local').message).toContain('pane seca');
    expect(() => classifyBrokerError({ estranho: true }, 'local')).not.toThrow();
    expect(classifyBrokerError(null, 'local').message).toBe(
      'não consegui falar com o provider local.',
    );
  });
});

describe('classifyBrokerError — backend BROKER continua NEUTRO (HG-2 intacta)', () => {
  it('a causa crua NÃO vaza no hospedado — é lá que a neutralidade protege', () => {
    const c = classifyBrokerError(new Error('openai.com respondeu 429 para a org acme'), 'broker');
    expect(c.message).not.toContain('openai');
    expect(c.message).not.toContain('acme');
    expect(c.message).toContain('broker');
  });

  it('o default do parâmetro é `broker` — quem não passar backend segue neutro', () => {
    const c = classifyBrokerError(new Error('vendor xyz caiu'));
    expect(c.message).not.toContain('xyz');
  });
});
