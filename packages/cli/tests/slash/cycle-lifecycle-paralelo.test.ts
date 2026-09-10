// EST-1158 (emenda) — os verbos de CICLO DE VIDA do `/cycle` não podem enfileirar.
//
// O relato (dono, 01/09): ele pôs um `/cycle` mandando mensagem no Telegram a cada minuto
// e, ao dar `/cycle stop`, "ele fica esperando o término do turno". Depois: "mesmo com esc
// ele não vai".
//
// UM defeito produzia os DOIS sintomas. Sem `parallelWhileBusy`/`parallelWhileBusyWith` o
// comando ENFILEIRA ("falta dos dois ⇒ enfileira", em `isParallelWhileBusy`). Então:
//   1. `/cycle stop` — cuja função é PARAR o que está rodando — só era executado depois
//      que aquilo parasse sozinho. Inútil por construção.
//   2. a fila que ele criou DESARMOU o Esc: `App.tsx` só interrompe em
//      `isDoubleEsc && !hasQueue` (com fila, o duplo-Esc preserva a fila em vez de abortar).
//
// Ou seja: pedir para parar tirava do dono o freio de emergência.

import { describe, expect, it } from 'vitest';
import {
  cycleIsLifecycle,
  NATIVE_COMMANDS,
  isParallelWhileBusy,
} from '../../src/slash/commands.js';

const CYCLE = NATIVE_COMMANDS.find((c) => c.id === 'cycle');

describe('cycleIsLifecycle — quem atua num ciclo JÁ rodando', () => {
  it('os quatro verbos de ciclo de vida rodam em paralelo', () => {
    for (const v of ['stop', 'pause', 'resume', 'status']) {
      expect(cycleIsLifecycle(v), `${v} tem de furar a fila`).toBe(true);
    }
  });

  it('`stop` é o caso do relato — é o que mais importa', () => {
    expect(cycleIsLifecycle('stop')).toBe(true);
    expect(cycleIsLifecycle('  STOP  ')).toBe(true);
  });

  it('INICIAR um ciclo continua enfileirando (deliberado: anti gasto dobrado)', () => {
    expect(cycleIsLifecycle('5m "manda um oi"')).toBe(false);
    expect(cycleIsLifecycle('--auto "faz algo"')).toBe(false);
    expect(cycleIsLifecycle('')).toBe(false);
  });

  it('verbo desconhecido enfileira (allowlist FECHADA, não denylist)', () => {
    expect(cycleIsLifecycle('edit intervalo 2m')).toBe(false);
    expect(cycleIsLifecycle('destruir')).toBe(false);
  });
});

describe('o registro do /cycle declara o predicado', () => {
  it('o comando existe e tem `parallelWhileBusyWith`', () => {
    expect(CYCLE, '/cycle sumiu do registro').toBeDefined();
    expect(
      CYCLE?.parallelWhileBusyWith,
      'sem isto o /cycle stop enfileira e o Esc para de funcionar',
    ).toBeDefined();
  });

  it('ponta-a-ponta: `/cycle stop` roda com a sessão OCUPADA', () => {
    expect(isParallelWhileBusy(CYCLE!, 'stop')).toBe(true);
  });

  it('ponta-a-ponta: iniciar um ciclo NÃO roda com a sessão ocupada', () => {
    expect(isParallelWhileBusy(CYCLE!, '1m "manda um oi no telegram"')).toBe(false);
  });
});
