// F-RAC · degrau 2 — o CONTROLLER guarda o raciocínio no bloco do turno, SEPARADO da
// fala. Exercita o seam REAL (`controller.sink`), o mesmo objeto que o
// StreamingModelCaller alimenta ao consumir o stream do provider.
//
// A separação é a propriedade que importa: o raciocínio é RASCUNHO. Se vazasse para o
// `text`, a resposta do turno passaria a carregar o pensamento do modelo — e esse texto
// é o que vira histórico, resumo e contexto das próximas chamadas.
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
        return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' as const };
      },
    },
    permission: new PolicyPermissionEngine({}),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

function blocoAluy(c: SessionController): { text: string; reasoning?: string } {
  const b = c.state.blocks.filter((x) => x.kind === 'aluy').at(-1);
  if (b === undefined || b.kind !== 'aluy') throw new Error('sem bloco aluy');
  return { text: b.text, ...(b.reasoning !== undefined ? { reasoning: b.reasoning } : {}) };
}

describe('F-RAC — o raciocínio entra no bloco sem contaminar a fala', () => {
  it('acumula em `reasoning`, deixando `text` intacto', () => {
    const c = makeController();
    c.sink.onStart?.();
    c.sink.onReasoning?.('penso, ');
    c.sink.onReasoning?.('logo existo');
    c.sink.onDelta('ok');
    expect(blocoAluy(c)).toEqual({ text: 'ok', reasoning: 'penso, logo existo' });
  });

  it('A ORIGEM — turno que só pensou guarda o pensamento (antes: bloco em branco)', () => {
    // É o caso do `finish_reason: 'length'` gasto dentro do raciocínio: nenhum delta de
    // fala chega. Sem guardar isto, o turno não deixava UMA palavra na tela.
    const c = makeController();
    c.sink.onStart?.();
    c.sink.onReasoning?.('pensei muito e não respondi');
    expect(blocoAluy(c)).toEqual({ text: '', reasoning: 'pensei muito e não respondi' });
  });

  it('turno sem raciocínio não ganha o campo (não-regressão do modelo comum)', () => {
    const c = makeController();
    c.sink.onStart?.();
    c.sink.onDelta('oi');
    expect(blocoAluy(c)).toEqual({ text: 'oi' });
  });

  it('raciocínio é BOUNDED e guarda a CAUDA (onde o pensamento chegou)', () => {
    const c = makeController();
    c.sink.onStart?.();
    // muito além do teto: o começo é descartado, o FIM permanece.
    c.sink.onReasoning?.('x'.repeat(20_000));
    c.sink.onReasoning?.('FIM');
    const { reasoning } = blocoAluy(c);
    expect(reasoning!.length).toBeLessThanOrEqual(16_000);
    expect(reasoning!.endsWith('FIM')).toBe(true);
  });
});
