// EST-ASK · ADR-0080 — SessionController.askParallel: o `/ask` (pergunta PARALELA
// read-only). Manda a pergunta ao caller DEDICADO (sem tools), mostra a resposta num
// note, e NÃO toca o loop/histórico. Sem o caller ⇒ indisponível (não chama modelo).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

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
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

function loopModel(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' };
    },
  };
}

/** Caller que CAPTURA as mensagens recebidas (pra provar que a pergunta chegou). */
function captureCaller(content: string): { caller: ModelCaller; seen: { blob?: string } } {
  const seen: { blob?: string } = {};
  return {
    seen,
    caller: {
      async call(args): Promise<ModelCallResult> {
        seen.blob = (args.messages ?? []).map((m) => m.content).join('\n');
        return { request_id: 'r', content, finish_reason: 'stop' };
      },
    },
  };
}

function makeController(sideQueryModel?: ModelCaller): SessionController {
  return new SessionController({
    model: loopModel(),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    ...(sideQueryModel ? { sideQueryModel } : {}),
  });
}

function noteBlocks(c: SessionController): { title: string; lines: readonly string[] }[] {
  return c.current.blocks.filter(
    (b): b is { kind: 'note'; title: string; lines: readonly string[] } => b.kind === 'note',
  );
}

describe('EST-ASK · SessionController.askParallel — /ask paralela read-only (ADR-0080)', () => {
  it('manda a pergunta ao caller dedicado e mostra a resposta num note', async () => {
    const { caller, seen } = captureCaller('Você tem 3 falhas.');
    const c = makeController(caller);
    await c.askParallel('quantas falhas?');
    // a pergunta chegou ao caller read-only
    expect(seen.blob).toContain('quantas falhas?');
    // a resposta apareceu num note de /ask
    const note = noteBlocks(c).find((b) => b.title.includes('/ask'));
    expect(note).toBeDefined();
    expect(note?.lines.join('\n')).toContain('Você tem 3 falhas.');
  });

  it('sem caller dedicado ⇒ note "indisponível" e NÃO chama modelo', async () => {
    const c = makeController(undefined);
    await c.askParallel('oi?');
    expect(JSON.stringify(noteBlocks(c))).toContain('indisponível');
  });

  it('pergunta vazia ⇒ note de uso (não dispara side-query)', async () => {
    const { caller, seen } = captureCaller('x');
    const c = makeController(caller);
    await c.askParallel('   ');
    expect(seen.blob).toBeUndefined(); // não chamou o caller
    expect(JSON.stringify(noteBlocks(c))).toContain('uso:');
  });

  // F144 — /ask DURANTE um STREAM vivo: a nota da resposta entra ANTES do aluy streamando
  // (não desaloja o rabo). ANTES: pushNote ia p/ DEPOIS do aluz ⇒ appendAluyDelta no-op +
  // finishAluyTurn não assentava ⇒ aluy ÓRFÃO streaming:true (bolinha piscando) + 2º aluy.
  it('F144 — /ask mid-stream não desaloja o aluy do rabo: 1 aluy assenta, nota acima, sem órfão', async () => {
    const { caller } = captureCaller('resposta da pergunta paralela.');
    const c = makeController(caller);
    const aluys = () => c.current.blocks.filter((b) => b.kind === 'aluy');
    const streamingAluys = () =>
      c.current.blocks.filter((b) => b.kind === 'aluy' && b.streaming === true);

    // turno em voo: o modelo streamando a resposta.
    c.sink.onStart?.();
    c.sink.onDelta('trabalhando');
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy');

    // /ask dispara em paralelo; a resposta chega como nota — deve entrar ANTES do aluy.
    await c.askParallel('como está?');
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy'); // o aluy CONTINUA no rabo

    // o stream segue: o delta pós-/ask NÃO se perde.
    c.sink.onDelta(' e fim');
    expect((aluys()[0] as { text: string }).text).toBe('trabalhando e fim');

    c.sink.onDone?.();
    // 1 aluy assentado, zero órfão piscando; a nota de /ask ficou ACIMA do aluy.
    expect(aluys()).toHaveLength(1);
    expect(streamingAluys()).toHaveLength(0);
    const kinds = c.current.blocks.map((b) => b.kind);
    expect(kinds.indexOf('note')).toBeLessThan(kinds.lastIndexOf('aluy'));
  });
});
