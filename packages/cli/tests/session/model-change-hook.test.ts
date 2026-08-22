// F-WIN (redescoberta) — trocar de modelo AVISA quem sabe perguntar a janela ao provider.
//
// O defeito, diagnosticado pelo próprio dono: "após selecionar o modelo ele não busca as
// informações de tamanho do modelo pra saber quando deve compactar". A descoberta rodava
// SÓ no boot, para o modelo do boot; um `/model` posterior deixava o slug novo sem janela
// conhecida e — quando ele também não está na tabela embutida (medido: `minimax/minimax-m3`
// e `gemini-3.7-flash`, nenhum dos dois está) — a janela caía em 0 e a auto-compactação
// ficava INERTE pelo resto da sessão.
//
// O gancho existe porque `setTier` tem NOVE pontos de chamada. Ligar a redescoberta em
// cada um garantiria esquecer um — que é exatamente como o defeito irmão (a janela
// descoberta não alcançar o loop) nasceu. Este arquivo trava o gancho, não os nove.

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

function ctl(): SessionController {
  return new SessionController({
    model: {
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    } as ModelCaller,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'custom', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
    tierControl: { tier: 'custom', model: 'antigo/modelo' },
  } as never);
}

describe('F-WIN — troca de modelo dispara a redescoberta da janela', () => {
  it('setTier com modelo NOVO avisa o gancho, com o slug', () => {
    const c = ctl();
    const vistos: string[] = [];
    c.setOnModelChanged((s) => vistos.push(s));
    c.setTier('custom', 'x/modelo-novo');
    expect(vistos).toEqual(['x/modelo-novo']);
    c.dispose();
  });

  // Os ramos que NÃO devem disparar: sem eles o gancho gastaria uma chamada de rede a
  // cada troca de tier sem modelo, e pior — pediria a janela de um slug vazio.
  it('setTier SEM modelo não dispara', () => {
    const c = ctl();
    const vistos: string[] = [];
    c.setOnModelChanged((s) => vistos.push(s));
    c.setTier('aluy-flux');
    expect(vistos).toEqual([]);
    c.dispose();
  });

  it('modelo em BRANCO não dispara', () => {
    const c = ctl();
    const vistos: string[] = [];
    c.setOnModelChanged((s) => vistos.push(s));
    c.setTier('custom', '   ');
    expect(vistos).toEqual([]);
    c.dispose();
  });

  it('o slug chega SEM espaços em volta (é chave de casamento rio-abaixo)', () => {
    const c = ctl();
    const vistos: string[] = [];
    c.setOnModelChanged((s) => vistos.push(s));
    c.setTier('custom', '  y/com-espaco  ');
    expect(vistos).toEqual(['y/com-espaco']);
    c.dispose();
  });

  it('SEM gancho ligado, setTier segue funcionando (o wiring é opcional)', () => {
    const c = ctl();
    expect(() => c.setTier('custom', 'z/sem-gancho')).not.toThrow();
    c.dispose();
  });
});
