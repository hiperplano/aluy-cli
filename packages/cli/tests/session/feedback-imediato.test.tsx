// FEEDBACK-IMEDIATO — relato do dono: "quando mando uma mensagem às vezes demora e o
// `aluy pensando` só aparece depois, parece que travou".
//
// Os passos ANTES da chamada ao modelo (recall de memória até 2,5s, regência do Maestro,
// auto-compactação) rodam dentro do `loop.run`, e a fase `thinking` já estava na tela —
// mas com o rótulo `pensando`, que MENTIA (o modelo ainda não tinha sido chamado) e sem
// relógio. Agora: no instante do submit a tela mostra o eco da fala + `preparando… 0:00`;
// o rótulo vira `pensando` quando o loop sinaliza `model-call`; o tempo decorrido anda.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type MemoryEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const ports = {
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
      return [];
    },
  },
} as unknown as ToolPorts;

/** Memória cujo `search` só resolve quando o teste mandar — simula o recall lento. */
function slowMemory(): { engine: MemoryEngine; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const engine = {
    async search() {
      await gate;
      return { hits: [] };
    },
    async add() {
      return {};
    },
    async scope() {
      return {};
    },
  } as unknown as MemoryEngine;
  return { engine, release };
}

function build(opts: { memory?: MemoryEngine; clock?: () => number; model?: ModelCaller }) {
  const labelsAtCall: Array<string | undefined> = [];
  let ref: SessionController | null = null;
  const model: ModelCaller = opts.model ?? {
    async call(): Promise<ModelCallResult> {
      labelsAtCall.push(ref!.current.workingLabel);
      await new Promise((r) => setTimeout(r, 400));
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.memory ? { memoryEngine: opts.memory, memoryScope: 'proj' } : {}),
  });
  ref = controller;
  return { controller, labelsAtCall };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('feedback imediato no submit (controller)', () => {
  it('SÍNCRONO: logo após submit() já há eco `you` + thinking/`preparando` (sem await)', () => {
    const { engine } = slowMemory();
    const { controller } = build({ memory: engine });
    void controller.submit('oi');
    // nenhuma microtask rodou ainda: tudo isto veio do trecho síncrono do submit.
    expect(controller.current.phase).toBe('thinking');
    expect(controller.current.workingLabel).toBe('preparando');
    expect(controller.current.workingSince).toBeTypeOf('number');
    expect(controller.current.blocks.some((b) => b.kind === 'you' && b.text === 'oi')).toBe(true);
    controller.dispose();
  });

  it('honesto: segue `preparando` enquanto o recall pendura e vira `pensando` ao chamar o modelo', async () => {
    const { engine, release } = slowMemory();
    const { controller, labelsAtCall } = build({ memory: engine });
    const done = controller.submit('oi');
    await new Promise((r) => setTimeout(r, 30));
    expect(controller.current.workingLabel).toBe('preparando'); // recall ainda pendurado
    expect(labelsAtCall).toEqual([]); // o modelo nem foi chamado
    release();
    await waitFor(() => labelsAtCall.length === 1);
    expect(labelsAtCall[0]).toBe('pensando'); // já `pensando` no instante do model.call
    await done;
    controller.dispose();
  });
});

describe('feedback imediato no submit (App)', () => {
  it('Enter ⇒ eco da fala + `preparando… 0:00` na tela; o relógio anda; depois `pensando`', async () => {
    const { engine, release } = slowMemory();
    let t = 1_000_000;
    const { controller } = build({ memory: engine, clock: () => t });
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    const r = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} now={() => t} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await new Promise((res) => setTimeout(res, 100));

    // O Ink só anexa o listener de stdin após o 1º commit; reescreve até o submit assentar.
    const deadline = Date.now() + 2000;
    while (controller.current.phase !== 'thinking') {
      if (Date.now() > deadline) throw new Error('submit não assentou');
      r.stdin.write('ola\r');
      await new Promise((res) => setTimeout(res, 10));
    }
    await waitFor(() => /preparando/.test(plain(r.lastFrame() ?? '')));
    const f1 = plain(r.lastFrame() ?? '');
    expect(f1).toContain('ola'); // eco da mensagem
    expect(f1).toMatch(/preparando… 0:00/);
    expect(f1).not.toContain('pensando');

    // 3s depois, com o recall ainda pendurado: a linha segue VIVA e o relógio andou.
    t += 3000;
    await waitFor(() => /preparando… 0:03/.test(plain(r.lastFrame() ?? '')));

    release(); // recall termina ⇒ o loop chama o modelo ⇒ `pensando`
    await waitFor(() => /pensando… 0:0\d/.test(plain(r.lastFrame() ?? '')));
    r.unmount();
    controller.dispose();
  });
});
