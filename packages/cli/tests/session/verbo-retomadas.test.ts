// VERBO POR TURNO nas retomadas — o verbo (`Costurando…`) é sorteado UMA vez quando o
// turno nasce e fica o MESMO em todo passo e em toda retomada do MESMO turno (aviso de
// travamento [r]/[c], BudgetGate [c], compactação do gate, retomada de pausa por cota); o
// turno seguinte sorteia outro. O relógio (`workingSince`) é re-carimbado em cada retomada
// (senão o `0:00` mostraria o tempo da espera do usuário no aviso, não o do modelo).
// Sem rede: modelo roteirizado, relógio injetado.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController, type SessionState } from '../../src/session/controller.js';

const OPEN = '<<<ALUY_TOOL_CALL';
const CLOSE = 'ALUY_TOOL_CALL>>>';
const leitura = `${OPEN}\n${JSON.stringify({ name: 'read_file', input: { path: 'a.ts' } })}\n${CLOSE}`;

const ports = {
  fs: {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  },
  shell: {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as unknown as ToolPorts;

let ref: SessionController | null = null;
/** `avanca`: a cada chamada o relógio anda (e a resposta STREAMA, p/ a fase ir a `streaming`). */
function roteiro(respostas: readonly string[], avanca = false): ModelCaller {
  let i = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const content = respostas[i] ?? 'pronto.';
      i += 1;
      if (avanca) {
        agora += 1_000;
        ref?.sink.onStart?.();
        for (const ch of content) ref?.sink.onDelta(ch);
        ref?.sink.onDone?.();
      }
      return {
        request_id: 'r',
        content,
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
      };
    },
  };
}

const resumidor: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'rc', content: 'resumo.', finish_reason: 'stop' };
  },
};

let agora = 1_000;

function novo(
  respostas: readonly string[],
  extra: {
    limits?: { maxIterations: number; maxToolCalls: number; maxTokens: number };
    avanca?: boolean;
    selfCheck?: boolean;
  } = {},
  watchdogOff = true,
): SessionController {
  const c = new SessionController({
    model: roteiro(respostas, extra.avanca === true),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    clock: () => agora,
    compactionModel: resumidor,
    ...(watchdogOff ? { watchdogEnv: { ALUY_STUCK_OFF: '1' } } : {}),
    ...(extra.limits ? { limits: extra.limits } : {}),
    ...(extra.selfCheck
      ? { selfCheck: { enabled: true, reanchorEveryK: 1000, maxVerifications: 2 } }
      : {}),
  });
  ref = c;
  return c;
}

beforeEach(() => {
  agora = 1_000;
  // verbos ligados (o modo "simples" tiraria o verbo do estado e o teste ficaria vazio).
  vi.stubEnv('ALUY_VERBOS', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Estados `thinking` vistos depois que `desde()` virou verdadeiro. */
function espiar(c: SessionController): SessionState[] {
  const vistos: SessionState[] = [];
  c.subscribe((s) => vistos.push(s));
  return vistos;
}

describe('verbo por turno · retomadas do MESMO turno', () => {
  it('BudgetGate [c]: mesmo verbo, relógio re-carimbado; o turno seguinte sorteia outro', async () => {
    const c = novo(['concluído.', 'outro turno.'], {
      limits: { maxIterations: 0, maxToolCalls: 50, maxTokens: 1_000_000 },
    });
    await c.submit('faça');
    expect(c.current.phase).toBe('budget');
    const verbo = c.current.workingVerb;
    expect(verbo).toBeDefined();

    agora = 777_000;
    const vistos = espiar(c);
    await c.continueAfterBudget();
    const pensando = vistos.filter((s) => s.phase === 'thinking');
    expect(pensando.length).toBeGreaterThan(0);
    for (const s of pensando) expect(s.workingVerb).toBe(verbo);
    // o 1º frame da retomada já carrega o relógio NOVO (não o do início do turno).
    expect(pensando[0]!.workingSince).toBe(777_000);

    await c.submit('próximo');
    expect(c.current.workingVerb).toBeDefined();
    expect(c.current.workingVerb).not.toBe(verbo);
    c.dispose();
  });

  it('compactação do gate (resume): mesmo verbo e relógio re-carimbado', async () => {
    const c = novo(Array.from({ length: 6 }, () => leitura).concat(['concluído.']), {
      limits: { maxIterations: 25, maxToolCalls: 4, maxTokens: 1_000_000 },
    });
    await c.submit('leia em loop');
    expect(c.current.phase).toBe('budget');
    const verbo = c.current.workingVerb;
    expect(verbo).toBeDefined();

    agora = 888_000;
    const vistos = espiar(c);
    await c.compactAfterBudget();
    const pensando = vistos.filter((s) => s.phase === 'thinking');
    expect(pensando.length).toBeGreaterThan(0);
    for (const s of pensando) expect(s.workingVerb).toBe(verbo);
    // o PRIMEIRO frame da retomada já traz o relógio novo (não um carimbo herdado do gate).
    expect(pensando[0]!.workingSince).toBe(888_000);
    c.dispose();
  });

  it('aviso de travamento: [r] redirecionar e [c] continuar mantêm o verbo e re-carimbam o relógio', async () => {
    for (const via of ['redirect', 'continue'] as const) {
      agora = 1_000;
      const repetida = `${OPEN}\n${JSON.stringify({ name: 'run_command', input: { command: 'ls' } })}\n${CLOSE}`;
      const c = novo([repetida, repetida, repetida, repetida, 'segui.'], {}, false);
      let verboNoAviso: string | undefined;
      let pensandoDepois: SessionState | undefined;
      let resolvido = false;
      c.subscribe((s) => {
        if (s.phase === 'stuck' && !resolvido) {
          resolvido = true;
          verboNoAviso = s.workingVerb;
          agora = 555_000;
          if (via === 'redirect') c.redirectAfterStuck('leia o README');
          else c.continueAfterStuck();
        } else if (resolvido && s.phase === 'thinking' && pensandoDepois === undefined) {
          pensandoDepois = s;
        }
      });
      await c.submit('faça');
      expect(resolvido).toBe(true);
      expect(verboNoAviso).toBeDefined();
      expect(pensandoDepois?.workingVerb).toBe(verboNoAviso);
      expect(pensandoDepois?.workingSince).toBe(555_000);
      c.dispose();
    }
  });

  it('retomada de pausa por cota (resumePausedMain): mantém o verbo do turno e re-carimba o relógio', async () => {
    const c = novo(['retomei.']);
    await c.submit('tarefa');
    const verbo = c.current.workingVerb;
    expect(verbo).toBeDefined();

    agora = 999_000;
    const vistos = espiar(c);
    await (
      c as unknown as { resumePausedMain(h: readonly unknown[]): Promise<void> }
    ).resumePausedMain([{ kind: 'goal', text: 'tarefa' }]);
    const pensando = vistos.filter((s) => s.phase === 'thinking');
    expect(pensando.length).toBeGreaterThan(0);
    expect(pensando[0]!.workingSince).toBe(999_000);
    for (const s of pensando) expect(s.workingVerb).toBe(verbo);
    c.dispose();
  });
});

describe('relógio da linha viva · cada ENTRADA em `thinking` carimba o instante corrente', () => {
  /** Invariante: ao ir de outra fase para `thinking`, `workingSince` === o relógio AGORA. */
  function vigiar(c: SessionController): { entradas: number; violacoes: string[] } {
    const out = { entradas: 0, violacoes: [] as string[] };
    let anterior: string = c.current.phase;
    c.subscribe((s) => {
      if (s.phase === 'thinking' && anterior !== 'thinking') {
        out.entradas += 1;
        if (s.workingSince !== agora)
          out.violacoes.push(
            `${String(s.workingSince)} != ${String(agora)} (${String(s.workingLabel)})`,
          );
      }
      anterior = s.phase;
    });
    return out;
  }

  it('2ª chamada do modelo, depois de uma tool (streaming → thinking), re-zera o relógio', async () => {
    const c = novo([leitura, 'pronto.'], { avanca: true });
    const v = vigiar(c);
    await c.submit('leia');
    expect(v.entradas).toBeGreaterThanOrEqual(2); // 1ª chamada + a que vem depois da tool
    expect(v.violacoes).toEqual([]);
    c.dispose();
  });

  it('passada de auto-verificação (`conferindo o trabalho`) abre com o relógio zerado', async () => {
    const c = novo(
      [
        leitura,
        'Pronto — li o arquivo e está tudo certo.',
        'Confirmo: EVIDÊNCIA conferida, está cumprido.',
      ],
      {
        avanca: true,
        selfCheck: true,
      },
    );
    const rotulos: string[] = [];
    c.subscribe((s) => {
      if (s.workingLabel?.startsWith('conferindo')) rotulos.push(s.workingLabel);
    });
    const v = vigiar(c);
    await c.submit('leia');
    expect(rotulos.length).toBeGreaterThan(0); // a passada de fato aconteceu
    expect(v.violacoes).toEqual([]);
    c.dispose();
  });
});
