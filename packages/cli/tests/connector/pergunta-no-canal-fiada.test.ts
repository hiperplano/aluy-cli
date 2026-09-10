// GUARDA — as duas pontas do "pergunta no canal" são fiadas em lugares que NENHUM teste de
// comportamento alcança, e as duas falham em SILÊNCIO se alguém as desfizer:
//
//  1. `run.tsx` chama `controller.ligarPerguntaNoCanal(...)`. É composição (fora da
//     cobertura). Sem essa linha, `canalDaPergunta` fica `undefined`, o espelho devolve
//     `false` e tudo volta ao defeito de 02/09 — sem um teste vermelho, sem erro de build.
//  2. O sink chama `alvo.responderPeloCanal?.(...)` com `?.` — porta OPCIONAL por desenho
//     (para não exigir a versão nova do controller nos dublês). Renomeie o método no
//     controller e a chamada vira no-op mudo.
//
// É exatamente a classe do `telegram-portas-fiadas.test.ts` (o 👀 que eu dei por instalado
// depois de conferir só a CHAMADA, sem nunca conferir quem FORNECIA a porta). Metade certa,
// conclusão errada.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type FileSystemPort,
  type ModelCallResult,
  type ModelCaller,
  type SearchPort,
  type ShellPort,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import type { AlvoDeInjecao } from '../../src/connector/telegram-sink.js';

const RUN_TSX = readFileSync(new URL('../../src/session/run.tsx', import.meta.url), 'utf8');

describe('run.tsx fia o canal da pergunta na ponte', () => {
  it('o arquivo foi mesmo lido — senão as asserções abaixo passariam por vacuidade', () => {
    expect(RUN_TSX.length).toBeGreaterThan(1_000);
    expect(RUN_TSX).toContain('telegramController = built.controller;');
  });

  it('LIGA o canal no controller — sem isto a pergunta nunca sai do terminal', () => {
    expect(RUN_TSX).toContain('ligarPerguntaNoCanal');
  });

  it('o egresso usado é o `notificar` da ponte (alvo travado + catraca)', () => {
    expect(RUN_TSX).toContain('.notificar(');
  });

  it('a ligação está DENTRO do bloco da ponte — fora dele o canal não existe', () => {
    const bloco = RUN_TSX.slice(
      RUN_TSX.indexOf('telegramController = built.controller;'),
      RUN_TSX.indexOf('telegramController = built.controller;') + 900,
    );
    expect(bloco).toContain('ligarPerguntaNoCanal');
  });
});

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const inerte: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

describe('o SessionController CUMPRE a porta que o sink chama', () => {
  const controller = new SessionController({
    model: inerte,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
  });

  it('serve como `AlvoDeInjecao` — o encaixe de tipos que o `run.tsx` faz de fato', () => {
    // Se o método for renomeado no controller, o `?.` do sink deixaria de achá-lo em
    // silêncio; aqui o compilador não deixa passar e o `typeof` fecha em runtime.
    const alvo: AlvoDeInjecao = controller;
    expect(typeof alvo.responderPeloCanal).toBe('function');
  });

  it('expõe `ligarPerguntaNoCanal` com o nome que o `run.tsx` chama', () => {
    expect(typeof controller.ligarPerguntaNoCanal).toBe('function');
  });
});
