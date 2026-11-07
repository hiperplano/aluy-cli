// DESFECHO-DE-OUTRO-TURNO (dogfooding real) — a pior das falhas de honestidade que
// achei hoje: o aluy reportava o desfecho de OUTRO turno como se fosse o de agora.
//
// Na máquina do dono, duas execuções headless numa sessão retomada devolveram
//
//   aluy: erro de broker: não consegui falar com o provider local.
//   {"result":"","ok":false,"tier":"aluy-flux"}
//
// e as DUAS tinham terminado BEM. A transcrição prova, blocos 1111-1114:
// `you: responda apenas: ok` → `aluy: ok` · `you: responda apenas: ok` → `aluy: ok`.
// O erro citado era UM bloco só, do índice 1110 — de HORAS antes, de uma sessão de TUI.
//
// A causa: a extração do resultado varria `controller.blocks` INTEIRO, e numa sessão
// retomada (`--resume`/`--continue`) essa lista começa com a transcrição ANTIGA
// restaurada. O primeiro `broker-error` encontrado — de qualquer época — virava o
// veredito. Eu persegui esse erro inexistente por um bom tempo, com o código na frente.
//
// Contamina QUALQUER consumidor do contrato JSON, inclusive o runner de serviço: um
// `ok:false` grudado para sempre numa sessão que um dia teve um erro de rede.
//
// A regra agora: o desfecho só olha os blocos DESTE turno.

import { describe, expect, it } from 'vitest';
import { runHeadlessPrint } from '../../src/session/linear.js';
import { SessionController } from '../../src/session/controller.js';
import type { SessionBlock } from '../../src/session/model.js';

/**
 * Controller-fake de sessão RETOMADA: nasce com a transcrição antiga já restaurada e
 * o `submit` APENDA os blocos do turno novo — que é o que o controller real faz
 * (`restoreBlocks` no boot, `pushBlock` durante o turno).
 */
function controllerRetomado(
  antigos: readonly SessionBlock[],
  doTurno: readonly SessionBlock[],
): SessionController {
  let current: readonly SessionBlock[] = [...antigos];
  const ctrl = {
    async submit(): Promise<void> {
      current = [...current, ...doTurno];
    },
    get blocks(): readonly SessionBlock[] {
      return current;
    },
    get tier(): string {
      return 'aluy-flux';
    },
    get model(): string | undefined {
      return undefined;
    },
  };
  return ctrl as unknown as SessionController;
}

const ERRO_ANTIGO: SessionBlock = {
  kind: 'broker-error',
  message: 'não consegui falar com o provider local.',
};

describe('runHeadlessPrint — o desfecho é DESTE turno', () => {
  it('turno que deu CERTO não herda erro de broker do histórico restaurado', async () => {
    // O caso exato da máquina do dono.
    const ctrl = controllerRetomado(
      [
        { kind: 'you', text: 'objetivo de ontem' },
        ERRO_ANTIGO,
      ],
      [
        { kind: 'you', text: 'responda apenas: ok' },
        { kind: 'aluy', text: 'ok', streaming: false },
      ],
    );
    const res = await runHeadlessPrint(ctrl, 'responda apenas: ok');
    expect(res.ok).toBe(true);
    expect(res.result).toBe('ok');
    expect(res.diagnostic).toBeUndefined();
  });

  it('turno que deu CERTO não herda a RESPOSTA antiga quando não fala nada', async () => {
    // O espelho do bug, e mais perigoso: sem fala final, o laço para trás achava a
    // resposta do turno ANTERIOR e a devolvia como resultado — um sucesso INVENTADO.
    const ctrl = controllerRetomado(
      [{ kind: 'aluy', text: 'resposta de ontem, nada a ver', streaming: false }],
      [{ kind: 'tool', verb: 'bash', target: 'ls', result: '0 erros', status: 'ok' }],
    );
    const res = await runHeadlessPrint(ctrl, 'só rode o comando');
    expect(res.ok).toBe(false);
    expect(res.result).toBe('');
    expect(res.result).not.toContain('ontem');
  });

  it('erro de broker DESTE turno CONTINUA sendo reportado — nada foi engolido', async () => {
    const ctrl = controllerRetomado(
      [{ kind: 'aluy', text: 'tudo certo ontem', streaming: false }],
      [
        { kind: 'you', text: 'tente agora' },
        { kind: 'broker-error', message: 'o provider recusou (429).', status: 429, backend: 'local' },
      ],
    );
    const res = await runHeadlessPrint(ctrl, 'tente agora');
    expect(res.ok).toBe(false);
    expect(res.diagnostic).toContain('429');
    expect(res.diagnostic).toContain('provider local'); // rótulo backend-aware.
  });

  it('com DOIS erros (um velho, um novo), reporta o NOVO', async () => {
    const ctrl = controllerRetomado(
      [ERRO_ANTIGO],
      [{ kind: 'broker-error', message: 'o provider recusou (402).', status: 402 }],
    );
    const res = await runHeadlessPrint(ctrl, 'x');
    expect(res.diagnostic).toContain('402');
    expect(res.diagnostic).not.toContain('não consegui falar');
  });

  it('sessão NOVA (sem histórico) não regride — o caminho de sempre', async () => {
    const ctrl = controllerRetomado(
      [],
      [
        { kind: 'you', text: 'oi' },
        { kind: 'aluy', text: 'olá', streaming: false },
      ],
    );
    const res = await runHeadlessPrint(ctrl, 'oi');
    expect(res.ok).toBe(true);
    expect(res.result).toBe('olá');
  });

  it('turno que não empurra bloco NENHUM falha honesto (não herda nada)', async () => {
    const ctrl = controllerRetomado(
      [{ kind: 'aluy', text: 'eco do passado', streaming: false }],
      [],
    );
    const res = await runHeadlessPrint(ctrl, 'x');
    expect(res.ok).toBe(false);
    expect(res.result).toBe('');
  });
});
