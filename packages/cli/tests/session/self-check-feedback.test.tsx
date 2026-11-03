// SELF-CHECK sem ar morto — relato do dono: depois do processamento há um "hiato" (a
// auto-verificação faz 1..N chamadas extras de modelo) em que a tela não mostrava nada.
//
// Prova aqui: (1) a resposta candidata JÁ está visível quando a passada de verificação
// começa; (2) durante a chamada extra há um indicador vivo `conferindo o trabalho (1/N)`
// com relógio, e o texto da verificação NÃO aparece; (3) confirmou ⇒ só a nota
// `✓ auto-verificado`; (4) achou lacuna e agiu ⇒ nota "corrigindo" + rótulo próprio;
// (5) interrompida ⇒ não afirma "verificado".

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type SelfCheckConfig,
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
      return 'conteúdo';
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

const TOOL = `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name: 'read_file', input: { path: 'a.txt' } })}\nALUY_TOOL_CALL>>>`;
const REAL = 'Pronto — li o arquivo e está tudo certo.';
const VERIF = 'Confirmo: EVIDÊNCIA conferida, está cumprido.';

/**
 * Caller scriptado que emite a resposta pelo sink e, a partir da chamada `gateFrom`, só
 * devolve depois que o teste liberar — a janela em que a tela precisa estar viva.
 */
function build(responses: readonly string[], gateAt: number, sc?: Partial<SelfCheckConfig>) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let turn = 0;
  let ref: SessionController | null = null;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const idx = turn;
      turn += 1;
      const content = responses[Math.min(idx, responses.length - 1)] ?? '';
      const sink = ref!.sink;
      sink.onStart?.();
      for (const ch of content) sink.onDelta(ch);
      if (idx === gateAt) await gate; // a chamada "em voo": já falou, ainda não terminou
      sink.onDone?.();
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'custom', tokens: 0, windowPct: 0 },
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
    selfCheck: { enabled: true, reanchorEveryK: 1000, maxVerifications: 2, ...sc },
    flush: { intervalMs: 0 },
  });
  ref = controller;
  return { controller, release };
}

const aluyTexts = (c: SessionController): string[] =>
  c.current.blocks.flatMap((b) => (b.kind === 'aluy' ? [b.text] : []));
const visibleAluyTexts = (c: SessionController): string[] =>
  c.current.blocks.flatMap((b) =>
    b.kind === 'aluy' && b.selfCheck !== true && !b.text.includes('ALUY_TOOL_CALL') ? [b.text] : [],
  );
const notes = (c: SessionController): string[] =>
  c.current.blocks.flatMap((b) => (b.kind === 'note' && b.title === 'self-check' ? b.lines : []));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('self-check sem ar morto (controller)', () => {
  it('resposta candidata visível ANTES da verificação; rótulo vivo durante; confirma ⇒ só a nota', async () => {
    // turno 0 = tool, 1 = final real, 2 = passada de verificação (segurada pelo gate)
    const { controller, release } = build([TOOL, REAL, VERIF], 2);
    const done = controller.submit('leia a.txt');
    await waitFor(() => controller.current.workingLabel?.startsWith('conferindo') === true);

    // a resposta real JÁ está na tela e a fase é viva (thinking, não `streaming` sem indicador)
    expect(visibleAluyTexts(controller)).toContain(REAL);
    expect(controller.current.phase).toBe('thinking');
    expect(controller.current.workingLabel).toBe('conferindo o trabalho (1/2)');
    expect(controller.current.workingSince).toBeTypeOf('number');
    // a tagarelice da verificação está marcada e não é visível
    expect(visibleAluyTexts(controller).join(' ')).not.toContain('EVIDÊNCIA');

    release();
    await done;
    expect(controller.current.phase).toBe('done');
    expect(notes(controller)).toEqual(['✓ auto-verificado']);
    expect(visibleAluyTexts(controller)).toEqual([REAL]);
    expect(aluyTexts(controller).join(' ')).not.toContain('EVIDÊNCIA');
    controller.dispose();
  });

  it('achou lacuna e AGIU: nota "corrigindo" + rótulo próprio; a resposta nova é visível', async () => {
    // 0 tool, 1 final, 2 verificação que volta a agir (tool), 3 nova final, 4 re-verificação
    const FIXED = 'Corrigido: agora sim está completo.';
    const { controller, release } = build([TOOL, REAL, TOOL, FIXED, VERIF], 99);
    release();
    await controller.submit('leia a.txt');
    expect(notes(controller)).toContain('↳ a verificação achou pendências — corrigindo');
    expect(visibleAluyTexts(controller)).toContain(REAL);
    expect(visibleAluyTexts(controller)).toContain(FIXED);
    expect(controller.current.phase).toBe('done');
    controller.dispose();
  });

  it('interrompida durante a verificação: NÃO afirma "auto-verificado"', async () => {
    const { controller } = build([TOOL, REAL, VERIF], 2);
    void controller.submit('leia a.txt');
    await waitFor(() => controller.current.workingLabel?.startsWith('conferindo') === true);
    // a chamada em voo termina (usuário interrompeu): o turno de verificação fecha como cancelado
    (controller as unknown as { finishAluyTurn(m: string): void }).finishAluyTurn('cancelled');
    expect(notes(controller)).not.toContain('✓ auto-verificado');
    expect(notes(controller).join(' ')).toContain('verificação interrompida');
    controller.dispose();
  });

  it('gates intactos: turno conversacional (0 tools) não sonda nem mostra "conferindo"', async () => {
    const labels: Array<string | undefined> = [];
    const { controller, release } = build(['Olá!'], 99);
    release();
    controller.subscribe((s) => labels.push(s.workingLabel));
    await controller.submit('oi');
    expect(labels.some((l) => l?.startsWith('conferindo'))).toBe(false);
    expect(notes(controller)).toEqual([]);
    controller.dispose();
  });
});

describe('self-check sem ar morto (App)', () => {
  it('a tela mostra a resposta + `conferindo o trabalho (1/2)… (N s)`, sem o texto da verificação', async () => {
    const { controller, release } = build([TOOL, REAL, VERIF], 2);
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    const r = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await new Promise((res) => setTimeout(res, 100));
    const deadline = Date.now() + 2000;
    while (controller.current.phase === 'idle') {
      if (Date.now() > deadline) throw new Error('submit não assentou');
      r.stdin.write('leia a.txt\r');
      await new Promise((res) => setTimeout(res, 10));
    }
    await waitFor(() =>
      /conferindo o trabalho \(1\/2\)… \(.*\d+s\)/.test(plain(r.lastFrame() ?? '')),
    );
    const frame = plain(r.lastFrame() ?? '');
    expect(frame).toContain('Pronto — li o arquivo');
    expect(frame).not.toContain('EVIDÊNCIA');
    release();
    await waitFor(() => controller.current.phase === 'done');
    r.unmount();
    controller.dispose();
  });
});
