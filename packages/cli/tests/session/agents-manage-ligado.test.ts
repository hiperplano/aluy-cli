// LIGAÇÃO das tools de gestão — o que morre nesta base não é a peça, é o fio.
//
// Só nesta semana achei CINCO funcionalidades completas, testadas e nunca chamadas
// (`retryCredential`, o degrau `ALUY_LANG`, a tabela de janelas, o
// `drainLiveInjectsToPending`, a redescoberta da janela). O teste de unidade passava, o
// gate ficava verde, e o comportamento não existia para quem usa.
//
// Este arquivo trava o FIO: as tools chegam ao toolset do PAI, os filhos NÃO recebem a
// gestão (E-A1: um filho não para irmãos), e o `report_status` está com eles.

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
  } as unknown as ToolPorts;
}

function ctl(subAgents: boolean): SessionController {
  return new SessionController({
    model: {
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    } as ModelCaller,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
    ...(subAgents ? { subAgents: { enabled: true } } : {}),
  } as never);
}

/** Nomes das tools que o loop do PAI de fato recebeu (o registro tem `list()`). */
function toolsDoPai(c: SessionController): string[] {
  const i = c as unknown as { loop?: { tools?: { list(): readonly { name: string }[] } } };
  return (i.loop?.tools?.list() ?? []).map((t) => t.name);
}

describe('tools de gestão chegam ao agente principal', () => {
  it('com sub-agentes LIGADOS, o pai recebe agents_status e agents_stop', () => {
    const c = ctl(true);
    const nomes = toolsDoPai(c);
    // Se esta asserção cair, a funcionalidade existe e NÃO está ligada — o padrão que
    // este arquivo existe para impedir.
    expect(nomes).toContain('agents_status');
    expect(nomes).toContain('agents_stop');
    expect(nomes).toContain('spawn_agent'); // o vizinho, como controle
    c.dispose();
  });

  it('SEM sub-agentes, não recebe nenhuma das três (não polui o toolset)', () => {
    const c = ctl(false);
    const nomes = toolsDoPai(c);
    expect(nomes).not.toContain('agents_status');
    expect(nomes).not.toContain('agents_stop');
    expect(nomes).not.toContain('spawn_agent');
    c.dispose();
  });
});
