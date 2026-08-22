// HUNT-RESUME-RACE — o contexto da sessão retomada não pode ficar refém de I/O.
//
// Relato do dono: "às vezes ele se perde no que estava fazendo antes quando fechei e
// reabri o aluy recarregando uma seção anterior". "Às vezes" é a assinatura de uma
// CORRIDA, e havia uma: no boot, `restoreBlocks` repunha a TELA cedo, mas o
// `seedHistory` do contexto do modelo só rodava DEPOIS do render e DEPOIS de
// `await memory.recall()`. Entre os dois, a TUI já aceitava Enter — quem digitasse
// rápido enviava um turno com a conversa inteira na tela e o contexto VAZIO.
//
// O conserto separa as duas fontes: o histórico (síncrono) é semeado junto da tela; a
// memória PREPENDA quando chegar. O que este arquivo trava é a propriedade que torna
// isso possível — `prependSeed` acrescenta SEM APAGAR — porque `seedHistory` substitui,
// e substituir na segunda chamada era o que impedia separá-las.

import { describe, expect, it } from 'vitest';
import { SessionController } from '../../src/session/controller.js';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

function ports(): ToolPorts {
  return {
    fs: {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    },
    shell: {
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  };
}
function caller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}
function ctl(): SessionController {
  return new SessionController({
    model: caller(),
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  });
}
const item = (t: string) => ({ role: 'goal', content: t }) as never;

describe('retomada — a semente do contexto não pode ser perdida', () => {
  it('prependSeed ACRESCENTA ao histórico já semeado (não apaga)', () => {
    const c = ctl();
    c.seedHistory([item('histórico-da-sessão')]);
    c.prependSeed([item('memória')]);
    // A ordem original do boot é memória PRIMEIRO, histórico depois.
    expect(c.peekPendingSeed().map((h) => (h as { content: string }).content)).toEqual([
      'memória',
      'histórico-da-sessão',
    ]);
    c.dispose();
  });

  it('prependSeed com lista VAZIA é no-op (não zera o histórico)', () => {
    const c = ctl();
    c.seedHistory([item('histórico')]);
    c.prependSeed([]);
    expect(c.peekPendingSeed()).toHaveLength(1);
    c.dispose();
  });

  // O ramo que prova o defeito antigo: se a memória tivesse continuado usando
  // `seedHistory`, ela APAGARIA o histórico da sessão retomada.
  it('seedHistory na segunda chamada SUBSTITUI — é por isso que a memória usa prependSeed', () => {
    const c = ctl();
    c.seedHistory([item('histórico')]);
    c.seedHistory([item('memória')]);
    expect(c.peekPendingSeed().map((h) => (h as { content: string }).content)).toEqual(['memória']);
    c.dispose();
  });
});
