// EST-0985 / EST-0987 — as divisórias de CHROME na <App> + a divisória SUTIL por
// turno. Prova de wiring (o que o teste de componente do Divider não cobre):
//   EST-0985: a App emoldura o input (régua acima/abaixo) e respeita a DENSIDADE.
//   EST-0987 (1/3): régua ACIMA do header ⇒ o header também fica emoldurado.
//   EST-0985 (polish): a régua ACIMA do input é INCONDICIONAL — emoldura o composer
//     SEMPRE (sessão fresca/pós-`/clear` inclusive). NÃO colapsa mais por falta de
//     turnos (o gate antigo desmoldurava o composer). Densidade segue respeitada:
//     `compact` omite SÓ as do header, nunca as que emolduram o composer.
//   EST-0987 (3/3): respiro SUTIL (traço curto, papel apagado) ENTRE turnos
//     concluídos, no `<Static>` — nunca após o turno vivo.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme, type Density } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

/** Caller que faz STREAM do texto e fecha o turno (p/ semear turnos concluídos). */
function scriptedCaller(text: string, getSink: () => StreamSink): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      const sink = getSink();
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(model?: ModelCaller): SessionController {
  return new SessionController({
    model: model ?? inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

function buildStreamingController(text: string): SessionController {
  let ctrl: SessionController | null = null;
  const model = scriptedCaller(text, () => ctrl!.sink);
  ctrl = buildController(model);
  return ctrl;
}

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

/** Microtasks p/ o React/Ink FLUSHAR o re-render. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Linhas de régua de CHROME (largura cheia: só `─`, comprimento ≥ 20). */
function chromeDividers(frame: string): string[] {
  return plain(frame)
    .split('\n')
    .filter((ln) => /^─{20,}$/.test(ln));
}

/** Linhas de divisória SUTIL (traço curto, ≤ 16 células `─` e ≥ 4). */
function subtleDividers(frame: string): string[] {
  return plain(frame)
    .split('\n')
    .filter((ln) => /^─{4,16}$/.test(ln.trim()) && ln.trim() === ln.trimEnd());
}

async function renderEmptyApp(density: Density) {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV, density });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  await flush();
  return { ...r, controller };
}

describe('App — chrome: emoldura header + input, respeita densidade (EST-0985/0987)', () => {
  it('comfortable VAZIO: 4 réguas de chrome (acima/sob-header + acima/abaixo-input)', async () => {
    // EST-0985 (polish): a régua ACIMA do input é INCONDICIONAL ⇒ o composer fica
    // emoldurado mesmo sem turnos. 2 do header (acima/sob) + 2 do composer = 4.
    const { lastFrame } = await renderEmptyApp('comfortable');
    expect(chromeDividers(lastFrame() ?? '')).toHaveLength(4);
  });

  it('compact VAZIO: omite AMBAS as do header ⇒ sobram 2 (a MOLDURA do input)', async () => {
    // compact: sem réguas de header (gate de densidade). As 2 que emolduram o
    // composer ficam SEMPRE (acima + abaixo) — densidade não desmolddura o input.
    const { lastFrame } = await renderEmptyApp('compact');
    expect(chromeDividers(lastFrame() ?? '')).toHaveLength(2);
  });

  it('as réguas de chrome têm a MESMA largura (sem jitter de largura)', async () => {
    const lines = chromeDividers((await renderEmptyApp('comfortable')).lastFrame() ?? '');
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });

  it('há régua ACIMA do header (header emoldurado): 2 réguas antes do indicador de modo', async () => {
    // EST-0987 (1/3): a régua de cima + a régua sob o header emolduram o header.
    // Provamos pela ORDEM: ao menos 1 régua aparece ANTES da palavra-marca do header.
    const text = plain((await renderEmptyApp('comfortable')).lastFrame() ?? '');
    const rows = text.split('\n');
    // o header mostra o tier "aluy-flux"; a régua de cima vem antes dessa linha.
    const headerRow = rows.findIndex((ln) => /aluy-flux|aluy/i.test(ln));
    expect(headerRow).toBeGreaterThan(-1);
    const dividerRows = rows.map((ln, i) => (/^─{20,}$/.test(ln) ? i : -1)).filter((i) => i >= 0);
    expect(dividerRows.some((i) => i < headerRow)).toBe(true);
  });
});

describe('App — a moldura do composer é ESTÁVEL: vazio e com turnos têm a MESMA contagem (EST-0985)', () => {
  it('VAZIO e COM turnos ⇒ MESMA contagem de réguas de chrome (a moldura não pisca)', async () => {
    const controller = buildStreamingController('respondido.');
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    const empty = chromeDividers(lastFrame() ?? '').length;
    // EST-0985 (polish): a régua acima do input NÃO some mais em sessão fresca.
    expect(empty).toBe(4);

    await controller.submit('oi');
    await waitFor(() => controller.current.phase === 'done');
    await flush();
    const withTurns = chromeDividers(lastFrame() ?? '').length;

    // A moldura é ESTÁVEL: submeter o 1º turno NÃO faz a régua acima-do-input
    // "aparecer" (ela já estava lá). Mesma contagem ⇒ sem salto/pisca na transição.
    expect(withTurns).toBe(empty);
  });
});

describe('App — divisória SUTIL entre turnos concluídos (EST-0987 3/3)', () => {
  it('2 turnos concluídos ⇒ 1 divisória SUTIL entre eles (traço curto, papel apagado)', async () => {
    const controller = buildStreamingController('ok.');
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();

    await controller.submit('primeiro');
    await waitFor(() => controller.current.phase === 'done');
    await controller.submit('segundo');
    await waitFor(() => controller.current.phase === 'done');
    await flush();

    // 2 turnos (2 `you` + 2 `aluy`) concluídos ⇒ exatamente 1 traço sutil ENTRE eles.
    const subtle = subtleDividers(lastFrame() ?? '');
    expect(subtle).toHaveLength(1);
    // o traço sutil é CURTO (parcial), não a régua cheia de chrome.
    const chrome = chromeDividers(lastFrame() ?? '');
    expect(subtle[0]!.trim().length).toBeLessThan(chrome[0]!.length);
  });

  it('NÃO há divisória sutil quando há só 1 turno (nada a separar)', async () => {
    const controller = buildStreamingController('resposta.');
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    await controller.submit('único');
    await waitFor(() => controller.current.phase === 'done');
    await flush();
    expect(subtleDividers(lastFrame() ?? '')).toHaveLength(0);
  });
});
