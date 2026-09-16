// O COMPOSER NÃO SOBE E DESCE QUANDO A TELA JÁ ESTÁ CHEIA.
//
// Relato do dono (16/09): "quando ele chegar no footer não ficar subindo e descendo, isso
// acontece quando aparece uma nova caixa de pensamento do aluy". Medido no tmux (40 linhas,
// tela cheia, provider falso): o composer ia da linha 33 (repouso) para a 35 ao começar o turno
// e voltava para a 33 ao terminar.
//
// Com a tela cheia, o composer só fica parado se a parte de baixo do frame nunca ENCOLHER
// (o Ink não rola de volta: linhas liberadas viram vazio embaixo e tudo sobe). A garantia
// geral mora na escrita (`frame-anchor.ts`); este arquivo trava as duas causas que eram do
// próprio layout:
//   1. o respiro abaixo do composer só existia em repouso (`done`) — trabalhando, o composer
//      ficava 1 linha mais perto do fim, com ou sem âncora;
//   2. a fase `streaming` era publicada antes da caixa do aluy existir.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };

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

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Linhas do frame ABAIXO da linha do composer (`❯`). */
function rowsBelowComposer(frame: string): number {
  const ls = plain(frame).split('\n');
  const i = ls.findIndex((l) => /^[┃|]\s*[❯>]/.test(l));
  if (i < 0) throw new Error(`composer não encontrado:\n${plain(frame)}`);
  return ls.length - 1 - i;
}

/**
 * Turno 1 completo; o turno 2 PENSA, fala e fica PARADO no meio do stream até `release`.
 */
function scenario() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ctrl: SessionController | null = null;
  let calls = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      calls += 1;
      const sink: StreamSink = ctrl!.sink;
      sink.onStart?.();
      if (calls === 2) {
        sink.onReasoning?.('pensando no pedido');
        sink.onDelta('começo da resposta');
        await gate;
      } else {
        sink.onDelta('resposta do primeiro turno');
      }
      sink.onDone?.();
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  ctrl = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  return { controller: ctrl, release };
}

describe('composer parado com a tela cheia', () => {
  it('as linhas ABAIXO do composer são as mesmas em repouso e durante o stream', async () => {
    const { controller, release } = scenario();
    const r = render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    // O `ink-testing-library` não informa a altura do terminal; o respiro só existe em telas
    // altas (`RESPIRO_MIN_ROWS`), então declaramos 40 linhas como no tmux.
    const out = r.stdout as unknown as { rows?: number; emit(ev: string): void };
    out.rows = 40;
    out.emit('resize');
    controller.dismissBoot();
    await controller.submit('primeiro');
    await flush();
    const atRest = rowsBelowComposer(r.lastFrame() ?? '');

    const second = controller.submit('segundo');
    await flush();
    expect(controller.current.phase).toBe('streaming');
    const streaming = rowsBelowComposer(r.lastFrame() ?? '');

    release();
    await second;
    await flush();
    const atRestAgain = rowsBelowComposer(r.lastFrame() ?? '');

    expect(streaming, 'o composer muda de altura ao começar o turno').toBe(atRest);
    expect(atRestAgain, 'o composer muda de altura ao terminar o turno').toBe(streaming);
    r.unmount();
    controller.dispose();
  });
});

describe('o turno do aluy abre num único estado', () => {
  it('nenhum estado publicado tem fase `streaming` SEM a caixa do aluy', async () => {
    // Um patch para a fase e outro para o bloco davam um quadro intermediário: o indicador
    // "pensando" (2 linhas) já tinha sumido e a caixa (2 linhas) ainda não existia — o frame
    // encolhia 2 linhas por um instante e o composer piscava para cima (medido no tmux).
    const { controller, release } = scenario();
    const orphanFrames: string[] = [];
    controller.subscribe((s) => {
      const last = s.blocks.at(-1);
      // (A caixa já ASSENTADA com a fase ainda em `streaming` é o fim normal do turno: mesma
      // altura da viva, nada encolhe.)
      if (s.phase === 'streaming' && last?.kind !== 'aluy') {
        orphanFrames.push(`${s.phase} / último bloco: ${last?.kind ?? 'nenhum'}`);
      }
    });
    await controller.submit('primeiro');
    release();
    expect(orphanFrames).toEqual([]);
    controller.dispose();
  });
});

describe('composer parado durante um pedido de aprovação', () => {
  it('as linhas ABAIXO do composer não mudam enquanto o ask está aberto', async () => {
    // Durante o ask a linha de dicas do rodapé some (o diálogo tem as dele) — sem ocupar o
    // lugar dela, o composer descia 1 linha a cada aprovação (medido no tmux: 47 → 48 → 47).
    const resolver = new TuiAskResolver();
    let n = 0;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        n += 1;
        const content =
          n === 2
            ? '<<<ALUY_TOOL_CALL\n' +
              JSON.stringify({ name: 'run_command', input: { command: 'ls' } }) +
              '\nALUY_TOOL_CALL>>>'
            : 'ok.';
        return { request_id: 'r', content, finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports: ports(),
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    const r = render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    const out = r.stdout as unknown as { rows?: number; emit(ev: string): void };
    out.rows = 40;
    out.emit('resize');
    controller.dismissBoot();
    await controller.submit('primeiro');
    await flush();
    const atRest = rowsBelowComposer(r.lastFrame() ?? '');

    const second = controller.submit('roda um comando');
    for (let i = 0; i < 50 && controller.current.phase !== 'asking'; i++) await flush();
    expect(controller.current.phase).toBe('asking');
    const asking = rowsBelowComposer(r.lastFrame() ?? '');

    resolver.pending?.resolve({ kind: 'deny', reason: 'não' } as never);
    await second;
    await flush();
    expect(asking, 'o composer muda de altura com o ask aberto').toBe(atRest);
    r.unmount();
    controller.dispose();
  });
});
