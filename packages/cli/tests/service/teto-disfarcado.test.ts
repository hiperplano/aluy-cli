// TETO-DISFARÇADO (dogfooding real) — a atividade "scan" do dono rodou 30 minutos,
// bateu o teto duro e o `runner.log` registrou:
//
//   atividade 1/6 "scan": saída ilegível (exit 143) — [headroom] mensagens comprimidas…
//
// "Saída ilegível" acusa o FILHO de ter produzido lixo. Não foi nada disso: nós o
// matamos, na hora marcada, porque ele passou dos 1800s. O dono leria isso como bug do
// agente e procuraria no lugar errado — quando a ação certa é declarar um
// `activity-timeout:` maior no `service.md`.
//
// A causa: a detecção do teto olhava `signal !== null`. Só que o filho é um `aluy`, que
// TRATA o SIGTERM e sai graciosamente com CÓDIGO 143 — então `signal` chega `null` e a
// inferência falha. O fato autoritativo é outro: o timer do teto DISPAROU.

import { describe, expect, it } from 'vitest';
import { classifyActivityExit } from '../../src/service/runner.js';

describe('classifyActivityExit — teto é teto, mesmo com saída graciosa', () => {
  it('teto disparou + filho saiu SEM sinal (exit 143) ⇒ deadline, não "saída ilegível"', () => {
    // O caso exato do dono.
    expect(classifyActivityExit({ stopAborted: false, signal: null, deadlineFired: true })).toBe(
      'deadline',
    );
  });

  it('teto disparou E o filho morreu pelo sinal ⇒ deadline (o caminho que já funcionava)', () => {
    expect(
      classifyActivityExit({ stopAborted: false, signal: 'SIGTERM', deadlineFired: true }),
    ).toBe('deadline');
  });

  it('morto por sinal SEM o teto ter disparado ⇒ deadline (retrocompat preservada)', () => {
    expect(
      classifyActivityExit({ stopAborted: false, signal: 'SIGKILL', deadlineFired: false }),
    ).toBe('deadline');
  });

  it('STOP do runner vence o teto — parada do dono não vira "estourou o tempo"', () => {
    // Precedência importa: se o dono mandou parar, a causa é essa, não o relógio.
    expect(classifyActivityExit({ stopAborted: true, signal: 'SIGTERM', deadlineFired: true })).toBe(
      'cancelled',
    );
  });

  it('saída normal continua "continue" — nada vira teto por engano', () => {
    expect(classifyActivityExit({ stopAborted: false, signal: null, deadlineFired: false })).toBe(
      'continue',
    );
    // Sem o campo (chamador antigo): comportamento idêntico ao de antes.
    expect(classifyActivityExit({ stopAborted: false, signal: null })).toBe('continue');
  });
});
