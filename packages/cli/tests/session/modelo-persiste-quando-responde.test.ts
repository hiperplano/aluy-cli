// F-MODELO-FICA (relato do dono: "escolho o modelo e ele não fica") — o `/model` trocava
// a sessão e NADA gravava: `setTier('custom', slug)` mexia no caller e no `meta`, e o
// método que persiste (`saveLocalProvider`) era CÓDIGO MORTO — nenhum chamador em todo o
// repo. Na sessão seguinte o slug voltava ao do config, em silêncio.
//
// A REGRA é do dono: "se estiver respondendo (somente se estiver funcionando) deve ser
// persistido na hora". Por isso a escrita NÃO acontece na escolha — acontece quando um
// turno COMPLETA com aquele modelo. Um slug que o provider recusa nunca vira o padrão, e
// não gastamos uma chamada de teste só para descobrir: a prova é o turno que o dono ia
// fazer de qualquer jeito.
import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const noFs: FileSystemPort = {
  async readFile() {
    return '';
  },
  async writeFile() {},
  async exists() {
    return false;
  },
};
const noShell: ShellPort = {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};
const noSearch: SearchPort = {
  async grep() {
    return [];
  },
};

/** Controller com a porta de persistência espionada + um tierControl mínimo de verdade. */
function make(): { c: SessionController; gravados: string[] } {
  const gravados: string[] = [];
  const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch };
  // O `tierControl` do controller NÃO é uma opção própria: é derivado do `model` quando
  // ele expõe `tier` + `setTier` (`isTierControl`). O fake precisa ser as DUAS coisas —
  // caller de modelo E controle de tier —, senão `setTier` sai cedo e o teste mede nada.
  const caller = {
    tier: 'custom' as string,
    model: undefined as string | undefined,
    setTier(tier: string, model?: string) {
      caller.tier = tier;
      caller.model = model;
    },
    async call() {
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' as const };
    },
  };
  const c = new SessionController({
    model: caller as never,
    permission: new PolicyPermissionEngine({}),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'custom', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
    persistActiveLocalModel: (slug) => gravados.push(slug),
  });
  return { c, gravados };
}

/** Um turno que FECHA BEM: o stream do modelo abre e encerra sem erro. */
function turnoOk(c: SessionController): void {
  c.sink.onStart?.();
  c.sink.onDelta('resposta');
  c.sink.onDone?.();
}

describe('F-MODELO-FICA — persiste só o modelo que respondeu', () => {
  it('escolher NÃO grava na hora (o modelo ainda não provou nada)', () => {
    const { c, gravados } = make();
    c.setTier('custom', 'novo/modelo');
    expect(gravados).toEqual([]);
  });

  it('A REGRA — um turno que completa CONFIRMA e grava', () => {
    const { c, gravados } = make();
    c.setTier('custom', 'novo/modelo');
    turnoOk(c);
    expect(gravados).toEqual(['novo/modelo']);
  });

  it('turno que FALHA não grava — provider que recusa nunca vira padrão', () => {
    const { c, gravados } = make();
    c.setTier('custom', 'slug/inexistente');
    c.sink.onStart?.(); // abriu…
    // …e morreu antes do `onDone` (é por onde o caminho de erro passa).
    expect(gravados).toEqual([]);
  });

  it('grava UMA vez — o 2º turno com o mesmo modelo não reescreve o config', () => {
    const { c, gravados } = make();
    c.setTier('custom', 'novo/modelo');
    turnoOk(c);
    turnoOk(c);
    expect(gravados).toEqual(['novo/modelo']);
  });

  it('trocar de novo antes de confirmar persiste só o ÚLTIMO (o abandonado não vaza)', () => {
    const { c, gravados } = make();
    c.setTier('custom', 'primeiro/modelo');
    c.setTier('custom', 'segundo/modelo');
    turnoOk(c);
    expect(gravados).toEqual(['segundo/modelo']);
  });

  it('tier CANÔNICO não persiste nada (localModel é campo do BYO)', () => {
    const { c, gravados } = make();
    c.setTier('aluy-flux');
    turnoOk(c);
    expect(gravados).toEqual([]);
  });
});
