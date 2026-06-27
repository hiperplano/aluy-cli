// EST-0948 — BRACKETED PASTE na <App>: colar MULTI-LINHA enche o composer (NÃO submete).
//
// O bug do dogfood: colar um bloco multi-linha submetia na 1ª `\n` e descartava o resto.
// Com o `?2004` ligado, o terminal envelopa o colado em `\x1b[200~`…`\x1b[201~`. A App
// detecta os marcadores no canal CRU (`'data'`), insere o conteúdo LITERAL no cursor
// (multi-linha) e NÃO submete; o `useInput` SUPRIME os mesmos bytes (gate) p/ o detector
// de lote (EST-0948) não submeter a 1ª linha. Cobertura do DoD:
//   (1) paste multi-linha ENVELOPADO (1 chunk) ⇒ o composer fica com as 3 linhas; submit
//       NÃO é chamado;
//   (2) paste PARTIDO em 2 chunks (marcador cruzando) ⇒ bufferiza e monta certo, sem submit;
//   (3) NÃO-REGRESSÃO: Enter LIMPO ainda submete; o input-em-lote de DIGITAÇÃO real (sem
//       envelope, EST-0948) ainda submete; digitação char-a-char intacta.

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
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { PASTE_START, PASTE_END } from '../../src/session/bracketed-paste.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

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

function buildController(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A stdin-mock da ink-testing-library guarda só a ÚLTIMA escrita e o efeito do paste é
 * assíncrono (canal `'data'` + commit do React). Reescrevemos o chunk até o efeito
 * assentar. IDEMPOTENTE p/ os nossos casos: reescrever o MESMO paste com a máquina já
 * fechada só re-insere o mesmo bloco — o teste para no 1º momento em que a condição vale.
 *
 * IMPORTANTE: o paste é um BLOCO atômico — para o caso PARTIDO em 2 chunks, escrevemos os
 * dois em sequência a cada tentativa (a máquina bufferiza o 1º e fecha no 2º).
 */
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mountApp() {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { controller, ...r };
}

describe('App — BRACKETED PASTE: cola MULTI-LINHA enche o composer (NÃO submete) (EST-0948)', () => {
  it('(1) paste envelopado de 3 linhas (1 chunk) ⇒ as 3 linhas no composer, sem submit', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // o paste ENVELOPADO: `\x1b[200~linha1\nlinha2\nlinha3\x1b[201~` num write só.
    await pressUntil(
      () => stdin.write(`${PASTE_START}linha1\nlinha2\nlinha3${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes('linha3'),
    );

    const frame = plain(lastFrame() ?? '');
    // as 3 linhas estão NO COMPOSER (texto multi-linha), não foram submetidas.
    expect(frame).toContain('linha1');
    expect(frame).toContain('linha2');
    expect(frame).toContain('linha3');
    // NÃO submeteu na 1ª `\n` (o bug): submit não foi chamado de forma alguma.
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });

  it('(2) paste PARTIDO em 2 chunks (marcador cruzando) ⇒ monta certo, sem submit', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // o paste chega PARTIDO: 1º chunk abre + parte do conteúdo; 2º chunk fecha.
    await pressUntil(
      () => {
        stdin.write(`${PASTE_START}alpha\nbe`);
        stdin.write(`ta\ngama${PASTE_END}`);
      },
      () => plain(lastFrame() ?? '').includes('gama'),
    );

    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
    expect(frame).toContain('gama');
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });

  it('(2b) Enter (sem envelope) DEPOIS de um paste SUBMETE o bloco multi-linha colado', async () => {
    // o paste enche o composer; um Enter LIMPO subsequente submete o que está lá.
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write(`${PASTE_START}uma linha\noutra linha${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes('outra linha'),
    );
    // Enter LIMPO (char-a-char, sem envelope) ⇒ submete o composer multi-linha INTEIRO.
    await pressUntil(
      () => stdin.write('\r'),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('uma linha\noutra linha');
    submitSpy.mockRestore();
    unmount();
  });
});

describe('App — BRACKETED PASTE: NÃO-REGRESSÃO do input de DIGITAÇÃO (EST-0948)', () => {
  it('input-em-lote de DIGITAÇÃO real (SEM envelope, `\\r` grudado) ainda SUBMETE', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    // xrdp/SSH: texto+Enter num chunk SEM `\x1b[200~` ⇒ a máquina de paste NÃO toca;
    // o detector de lote (EST-0948) submete a linha. Não regride.
    await pressUntil(
      () => stdin.write('liste arquivos\r'),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('liste arquivos');
    expect(submitSpy.mock.calls[0]?.[0]).not.toContain('\r');
    submitSpy.mockRestore();
    unmount();
  });

  it('Enter LIMPO (char-a-char) ainda submete o objetivo digitado', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').length > 0);

    await pressUntil(
      () => stdin.write('oi'),
      () => plain(lastFrame() ?? '').includes('oi'),
    );
    await pressUntil(
      () => stdin.write('\r'),
      () => submitSpy.mock.calls.length > 0,
    );
    expect(submitSpy.mock.calls[0]?.[0]).toBe('oi');
    submitSpy.mockRestore();
    unmount();
  });

  it('digitação char-a-char ecoa no composer e NÃO submete sozinha', async () => {
    const PLACEHOLDER = 'digite um objetivo'; // prefixo do placeholder do composer ATIVO
    const { controller, stdin, lastFrame, unmount } = mountApp();
    const submitSpy = vi.spyOn(controller, 'submit');
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));

    // 1º char some o fantasma (sinal determinístico de que a tecla assentou); depois o
    // 2º forma "oi". Re-escrever o MESMO char é idempotente no resultado visível.
    await pressUntil(
      () => stdin.write('o'),
      () => !plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    await pressUntil(
      () => stdin.write('i'),
      () => plain(lastFrame() ?? '').includes('oi'),
    );
    expect(plain(lastFrame() ?? '')).toContain('oi');
    // sem `\r`/`\n` e sem envelope ⇒ nada submete sozinho.
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    unmount();
  });
});
