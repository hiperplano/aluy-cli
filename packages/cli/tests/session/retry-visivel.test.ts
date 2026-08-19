// F-RETRY-VISÍVEL — a retentativa do caller PRECISA aparecer na tela.
//
// A ORIGEM (medida contra um provider que recusa com 429): quatro blocos `Λ aluy`
// VAZIOS empilhados em 24 segundos, um a cada espera de 5s, e NENHUMA palavra sobre o
// motivo. O dono lia aquilo como "o modelo não responde e o aluy repete sozinho".
//
// Duas causas somadas, as duas aqui:
//   1. a retentativa mora DENTRO do caller (`streaming-caller`, laço `decideRetry`), e
//      cada tentativa chama `sink.onStart` ⇒ um bloco `aluy` novo por tentativa. Sem
//      aviso ao controller, os anteriores ficavam ÓRFÃOS (`streaming: true`, vazios).
//   2. o `onRetry` existia em `StreamingModelCallerOptions` e NINGUÉM o ligava: a razão
//      da falha (`HTTP 429`, transporte, 5xx) morria dentro do caller.
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

function makeController(): SessionController {
  const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch };
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' as const };
      },
    },
    permission: new PolicyPermissionEngine({}),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  });
}

const erros = (c: SessionController) => c.state.blocks.filter((b) => b.kind === 'broker-error');
const aluys = (c: SessionController) => c.state.blocks.filter((b) => b.kind === 'aluy');

describe('F-RETRY-VISÍVEL — o aviso de retentativa do caller', () => {
  it('A ORIGEM — descarta o turno em voo VAZIO em vez de empilhar bloco mudo', () => {
    const c = makeController();
    c.sink.onStart?.(); // tentativa 1 abriu um bloco e não veio nada
    expect(aluys(c)).toHaveLength(1);
    c.noteCallerRetry({ attempt: 1, max: 20, waitMs: 5000, reason: 'HTTP 429' });
    expect(aluys(c)).toHaveLength(0);
  });

  it('MOSTRA o motivo, a contagem e a espera (antes: nada)', () => {
    const c = makeController();
    c.sink.onStart?.();
    c.noteCallerRetry({ attempt: 3, max: 20, waitMs: 5000, reason: 'HTTP 429' });
    const [e] = erros(c);
    expect(e).toMatchObject({
      kind: 'broker-error',
      retrying: true,
      attempt: 3,
      maxAttempts: 20,
      retryInSeconds: 5,
    });
    expect(String((e as { message: string }).message)).toContain('HTTP 429');
  });

  it('avisos consecutivos SUBSTITUEM (uma caixa viva, não vinte empilhadas)', () => {
    const c = makeController();
    for (let i = 1; i <= 5; i++) {
      c.sink.onStart?.();
      c.noteCallerRetry({ attempt: i, max: 20, waitMs: 5000, reason: 'HTTP 429' });
    }
    expect(erros(c)).toHaveLength(1);
    expect(aluys(c)).toHaveLength(0);
    expect(erros(c)[0]).toMatchObject({ attempt: 5 });
  });

  it('NÃO descarta um turno que já falou (fala parcial não se perde)', () => {
    const c = makeController();
    c.sink.onStart?.();
    c.sink.onDelta('metade da respost');
    c.noteCallerRetry({ attempt: 1, max: 20, waitMs: 5000, reason: 'transporte' });
    expect(aluys(c)).toHaveLength(1);
    expect(aluys(c)[0]).toMatchObject({ text: 'metade da respost' });
  });

  it('sem motivo declarado, a mensagem segue legível (degradação honesta)', () => {
    const c = makeController();
    c.noteCallerRetry({ attempt: 1, max: 20, waitMs: 3000 });
    expect(String((erros(c)[0] as { message: string }).message)).toContain('tentando de novo');
  });
});
