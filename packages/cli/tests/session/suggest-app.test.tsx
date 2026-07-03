// F197 — SUGESTÃO DE PRÓXIMO PROMPT na App (ghost + Tab), dirigida via controller/stdin
// (o mesmo caminho de um PTY real). Prova o DoD do dono:
//   • ao fim do turno (idle/done) com o composer VAZIO, o ghost da sugestão aparece;
//   • Tab ACEITA (a sugestão vira o texto do composer; Enter a submete);
//   • começar a DIGITAR descarta o ghost;
//   • a OPÇÃO desligada (initialSuggestions=false) ⇒ nenhum ghost;
//   • Tab com o composer NÃO-vazio mantém o comportamento ANTIGO (cicla o modo).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
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
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { i18n } from '../../src/i18n/index.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const t = i18n('pt-BR').t;
const PLACEHOLDER = 'digite um objetivo'; // placeholder padrão (pt-BR)
const SUGGESTION = t('suggest.nextStep'); // turno de conversa puro ⇒ fallback próximo passo
const TAB = '\t';
const ENTER = '\r';
const BACKSPACE = '\x7f';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

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

/** Caller roteirizado: streama `text` e fecha o turno (você + aluy concluídos ⇒ idle/done). */
function scriptedCaller(text: string, sink: StreamSink): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(text: string): SessionController {
  let ctrl: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrl?.sink.onStart?.(),
    onDelta: (c) => ctrl?.sink.onDelta(c),
    onUsage: (u) => ctrl?.sink.onUsage?.(u),
    onDone: () => ctrl?.sink.onDone?.(),
  };
  const controller = new SessionController({
    model: scriptedCaller(text, sink),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  ctrl = controller;
  return controller;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mountApp(opts: { suggestions?: boolean } = {}) {
  const controller = buildController('pronto.');
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts.suggestions !== undefined ? { initialSuggestions: opts.suggestions } : {})}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { controller, ...r };
}

/** Garante que o listener de stdin do Ink já attachou (só liga num efeito pós-commit). */
async function ensureListener(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!plain(lastFrame()).includes('~')) {
    if (Date.now() > deadline) throw new Error('listener não attachou');
    stdin.write('~');
    await new Promise((r) => setTimeout(r, 10));
  }
  stdin.write(BACKSPACE);
  await new Promise((r) => setTimeout(r, 15));
}

async function tap(stdin: { write: (s: string) => void }, seq: string): Promise<void> {
  stdin.write(seq);
  await new Promise((r) => setTimeout(r, 25));
}

/** Roda um turno completo (você→aluy) e espera assentar em idle/done. */
async function runTurn(controller: SessionController, goal = 'faça'): Promise<void> {
  await controller.submit(goal);
  await waitFor(() => controller.current.phase === 'done' || controller.current.phase === 'idle');
}

describe('F197 · App — sugestão de próximo prompt (ghost + Tab)', () => {
  it('ao fim do turno (idle/done, composer vazio) o GHOST da sugestão aparece', async () => {
    const { controller, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame()).includes(PLACEHOLDER));
    await runTurn(controller);
    // o ghost (placeholder = sugestão) aparece assim que o turno assenta.
    await waitFor(() => plain(lastFrame()).includes(SUGGESTION));
    expect(plain(lastFrame())).toContain(SUGGESTION);
    // e o footer ganha a afordância do Tab.
    expect(plain(lastFrame())).toContain('tab aceita a sugestão');
    unmount();
  });

  it('Tab ACEITA: a sugestão vira o texto do composer e Enter a submete', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame()).includes(PLACEHOLDER));
    // Attacha o listener ANTES do turno: o sentinela `~`+backspace do ensureListener
    // digita — e digitar DESCARTA a sugestão. Fazendo antes do turno, a sugestão nasce
    // DEPOIS (composer já vazio, listener vivo) e sobrevive até o Tab.
    await ensureListener(stdin, lastFrame);
    await runTurn(controller);
    await waitFor(() => plain(lastFrame()).includes(SUGGESTION));

    const submitSpy = vi.spyOn(controller, 'submit');
    await tap(stdin, TAB); // aceita ⇒ o composer passa a CONTER a sugestão (texto real)
    await tap(stdin, ENTER); // submete o texto aceito
    await waitFor(() => submitSpy.mock.calls.some((c) => c[0] === SUGGESTION));
    expect(submitSpy.mock.calls.some((c) => c[0] === SUGGESTION)).toBe(true);
    submitSpy.mockRestore();
    unmount();
  });

  it('começar a DIGITAR descarta o ghost da sugestão', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame()).includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame); // listener antes do turno (ver acima)
    await runTurn(controller);
    await waitFor(() => plain(lastFrame()).includes(SUGGESTION));
    await tap(stdin, 'x'); // digitou ⇒ o ghost some
    await waitFor(() => plain(lastFrame()).includes('x'));
    expect(plain(lastFrame())).not.toContain(SUGGESTION);
    unmount();
  });

  it('OPÇÃO desligada (initialSuggestions=false) ⇒ NENHUM ghost ao fim do turno', async () => {
    const { controller, lastFrame, unmount } = mountApp({ suggestions: false });
    await waitFor(() => plain(lastFrame()).includes(PLACEHOLDER));
    await runTurn(controller);
    // dá tempo p/ o efeito de fim-de-turno rodar (se fosse ligado, o ghost já teria vindo).
    await new Promise((r) => setTimeout(r, 60));
    expect(plain(lastFrame())).not.toContain(SUGGESTION);
    // o placeholder padrão segue valendo (composer vazio, sem sugestão).
    expect(plain(lastFrame())).toContain(PLACEHOLDER);
    unmount();
  });

  it('Tab com o composer NÃO-vazio mantém o comportamento ANTIGO (cicla o modo)', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    await waitFor(() => plain(lastFrame()).includes(PLACEHOLDER));
    await ensureListener(stdin, lastFrame);
    const cycleSpy = vi.spyOn(controller, 'cycleMode');
    // digita um texto (composer NÃO-vazio) — sem sugestão pendente (nenhum turno rodou).
    await tap(stdin, 'o');
    await tap(stdin, 'i');
    await waitFor(() => plain(lastFrame()).includes('oi'));
    await tap(stdin, TAB); // com texto ⇒ Tab NÃO aceita nada; cicla o modo (antigo)
    await waitFor(() => cycleSpy.mock.calls.length > 0);
    expect(cycleSpy.mock.calls.length).toBeGreaterThan(0);
    // o texto digitado permanece intacto (o Tab não o tocou).
    expect(plain(lastFrame())).toContain('oi');
    cycleSpy.mockRestore();
    unmount();
  });
});
