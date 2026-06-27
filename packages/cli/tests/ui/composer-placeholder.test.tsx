// Bug de UX (Tiago) — o placeholder do composer era tratado como TEXTO de verdade:
// o cursor caía no FIM da frase e o que se digitava entrava DEPOIS do placeholder.
// Fix: placeholder FANTASMA/sombra (papel `fgDim` do DS), visível SÓ com o input
// vazio, com o CURSOR no índice 0 (antes do fantasma), e que NÃO é parte do `value`
// submetido — some no 1º caractere e reaparece ao apagar tudo.
//
// Cobertura do DoD:
//   (a) vazio ⇒ placeholder esmaecido (fgDim) visível + cursor no índice 0
//   (b) 1 char ⇒ placeholder some, texto começa do início, valor submetido NÃO o contém
//   (c) apagar tudo ⇒ placeholder reaparece
//   (d) NO_COLOR/a11y ⇒ o placeholder ainda se distingue (atributo dim, não só cor)

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
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Composer } from '../../src/ui/components/Composer.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CURSOR = '●'; // EST-0965: glifo do cursor do composer — ● grosso/arredondado (Unicode)
const PLACEHOLDER = 'digite um objetivo';

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv = ENV) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

// FORCE_COLOR=3 (vitest.config.ts) fragmenta o texto com ANSI; removemos a cor p/
// afirmar POSIÇÃO/ordem de texto contíguo (cursor antes do fantasma etc.).
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

describe('Composer — placeholder FANTASMA (sombra, não-parte-do-valor)', () => {
  it('(a) vazio + ativo ⇒ placeholder esmaecido (fgDim) com o CURSOR no índice 0', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} />);
    const raw = lastFrame() ?? '';
    const out = plain(raw);

    // o fantasma está visível…
    expect(out).toContain(PLACEHOLDER);
    // …e o cursor vem ANTES do fantasma (pos 0), não depois da frase.
    const idxCursor = out.indexOf(CURSOR);
    const idxGhost = out.indexOf(PLACEHOLDER);
    expect(idxCursor).toBeGreaterThanOrEqual(0);
    expect(idxGhost).toBeGreaterThan(idxCursor);

    // o fantasma é esmaecido: sai pelo papel fgDim, que emite o atributo DIM (SGR 2).
    // (em truecolor há cor + dimColor; aqui provamos que o trecho do placeholder
    // carrega o atributo dim — não é texto fg normal.)
    const dimOpen = ESC + '[2m';
    expect(raw).toContain(dimOpen);
  });

  it('(b) com 1+ caractere ⇒ o fantasma SOME e o texto começa do início, cursor na ponta', () => {
    const { lastFrame } = wrap(<Composer value="t" active={true} />);
    const out = plain(lastFrame() ?? '');
    // fantasma sumiu assim que entrou texto…
    expect(out).not.toContain(PLACEHOLDER);
    // …o texto digitado começa logo após o prompt (não depois de uma frase fantasma)…
    expect(out).toContain('t');
    // …e o cursor segue o texto (vem DEPOIS do `t`).
    const idxT = out.indexOf('t');
    const idxCursor = out.indexOf(CURSOR);
    expect(idxCursor).toBeGreaterThan(idxT);
  });

  it('(c) inativo ⇒ sem fantasma e sem cursor; mostra a dica `esc interromper`', () => {
    const { lastFrame } = wrap(<Composer value="" active={false} hint="esc interromper" />);
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain(PLACEHOLDER); // fantasma só com input ativo
    expect(out).not.toContain(CURSOR); // cursor só quando ativo
    expect(out).toContain('esc interromper');
  });

  it('(d) a11y NO_COLOR (mono) ⇒ o fantasma ainda se distingue pelo atributo dim (não só cor)', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} />, { NO_COLOR: '1', ...ENV });
    const raw = lastFrame() ?? '';
    // sem cor (mono não emite SGR de cor p/ fgDim), mas o DIM (SGR 2) permanece —
    // é o que distingue o fantasma do texto real numa tela monocromática.
    const dimOpen = ESC + '[2m';
    expect(raw).toContain(dimOpen);
    expect(plain(raw)).toContain(PLACEHOLDER);
    // o cursor segue no começo (índice 0) mesmo em mono.
    const out = plain(raw);
    expect(out.indexOf(CURSOR)).toBeLessThan(out.indexOf(PLACEHOLDER));
  });

  it('FALLBACK sem Unicode (TERM=linux): cursor ASCII `*` no índice 0, fantasma ainda dim', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} />, { TERM: 'linux' });
    const out = plain(lastFrame() ?? '');
    expect(out).toContain(PLACEHOLDER);
    // EST-0965: cursor degrada p/ `*` (MESMO fallback do thinkingCursor) e continua ANTES
    // do fantasma.
    const idxCursor = out.indexOf('*');
    expect(idxCursor).toBeGreaterThanOrEqual(0);
    expect(out.indexOf(PLACEHOLDER)).toBeGreaterThan(idxCursor);
  });
});

// ── App-level: o placeholder NÃO É PARTE DO VALOR submetido ───────────────────
// Prova de ponta: ao digitar 1 caractere e dar Enter num composer que mostrava o
// fantasma, o controller recebe SÓ o que foi digitado — nunca o texto do placeholder.

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

/**
 * Espera DETERMINÍSTICA por uma condição rendida (em vez de um único `tick`): o
 * `useInput` do Ink processa a tecla de forma assíncrona, então fazemos polling
 * até o frame refletir o efeito, com teto só p/ não pendurar a suíte.
 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * O Ink só ATTACHA o listener de stdin num efeito pós-commit do 1º render, e a
 * stdin-mock da ink-testing-library guarda só a ÚLTIMA escrita (eventos podem se
 * perder sob escalonamento do vitest). Para um teste DETERMINÍSTICO, reescrevemos a
 * tecla até o efeito desejado aparecer (idempotente p/ os nossos casos: digitar
 * `o` até o fantasma sumir; backspace até ele voltar; Enter até o submit registrar).
 */
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito da tecla não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('App — o placeholder fantasma NÃO entra no valor submetido', () => {
  it('digitar "o" + Enter ⇒ o controller submete "o", nunca o texto do placeholder', async () => {
    const controller = buildController();
    const submitSpy = vi.spyOn(controller, 'submit');
    const theme = resolveTheme({ env: ENV });
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));

    // estado inicial: composer vazio mostra o fantasma (sombra).
    expect(plain(lastFrame() ?? '')).toContain(PLACEHOLDER);

    // digita 1 caractere — o fantasma deve sumir e o valor passa a ser só "o".
    await pressUntil(
      () => stdin.write('o'),
      () => !plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    expect(plain(lastFrame() ?? '')).not.toContain(PLACEHOLDER);

    // Enter submete. (re-escrever `\r` é idempotente: após o 1º submit o input está
    // vazio ⇒ Enter num composer vazio não roteia objetivo ⇒ submit só 1 vez.)
    await pressUntil(
      () => stdin.write('\r'),
      () => submitSpy.mock.calls.length > 0,
    );

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submitted = submitSpy.mock.calls[0]?.[0];
    expect(submitted).toBe('o');
    // garantia explícita do DoD: o placeholder JAMAIS faz parte do que é enviado.
    expect(submitted).not.toContain(PLACEHOLDER);
    submitSpy.mockRestore();
    unmount();
  });

  it('digitar e APAGAR tudo ⇒ o fantasma REAPARECE (input voltou a vazio)', async () => {
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await waitFor(() => plain(lastFrame() ?? '').includes(PLACEHOLDER));

    // digita
    await pressUntil(
      () => stdin.write('o'),
      () => !plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    expect(plain(lastFrame() ?? '')).not.toContain(PLACEHOLDER);

    // backspace (DEL 0x7f) apaga tudo — re-escrever e idempotente em input vazio.
    await pressUntil(
      () => stdin.write('\x7f'),
      () => plain(lastFrame() ?? '').includes(PLACEHOLDER),
    );
    // de volta ao vazio ⇒ o fantasma reaparece.
    expect(plain(lastFrame() ?? '')).toContain(PLACEHOLDER);
    unmount();
  });
});
