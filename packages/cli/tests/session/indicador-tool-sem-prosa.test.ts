// Auditoria — SEM INDICADOR DUPLICADO: numa iteração só de tool-call (o modelo não escreveu
// nenhuma prosa, a fase segue `thinking`), a linha `◌ rodando…` da tool já anima sozinha; a
// fase passa a `streaming` para o `Λluy pensando…` não aparecer junto. O teste de
// `indicador-continuo` só cobre o caso COM prosa (fase já `streaming`), então esta costura
// ficava sem teste. Quando o modelo volta a calcular, a fase reabre `thinking`.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const ports = {
  fs: {
    async readFile() {
      await new Promise((r) => setTimeout(r, 30));
      return 'conteudo';
    },
    async writeFile() {},
    async exists() {
      return true;
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

describe('tool-call SEM prosa: a fase sai de `thinking` enquanto a tool roda', () => {
  it('assentada a linha `running`, a fase é `streaming`; antes dela é `thinking`', async () => {
    let n = 0;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        const k = n++;
        // NENHUM sink.onStart/onDelta: iteração só de tool-call.
        if (k === 0) {
          return {
            request_id: 'r0',
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [{ id: 'c0', name: 'read_file', input: { path: 'a.txt' } }],
          } as ModelCallResult;
        }
        return { request_id: 'r1', content: 'pronto', finish_reason: 'stop' };
      },
    };
    const c = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' as const };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    const duranteATool: string[] = [];
    const antes: string[] = [];
    c.subscribe((s) => {
      const rodando = s.blocks.some((b) => b.kind === 'tool' && b.status === 'running');
      if (rodando) duranteATool.push(s.phase);
      else if (n === 1) antes.push(s.phase);
    });
    await c.submit('leia');
    expect(duranteATool.length).toBeGreaterThan(0);
    // (o push do bloco `running` e o patch de fase são síncronos: o 1º estado ainda pode ser
    // `thinking`, mas o ASSENTADO — o que a tela desenha — não pode)
    expect(duranteATool[duranteATool.length - 1]).toBe('streaming');
    expect(antes).toContain('thinking'); // a espera ao modelo ANTES da tool tinha o indicador
    c.dispose();
  });
});
