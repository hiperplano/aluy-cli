// EST-1015 (dono, dogfooding) — DUPLO Ctrl+C p/ sair. Um único Ctrl+C no composer ocioso
// derrubava a app na hora ("uma vez já mata"). Agora:
//   · composer VAZIO + 1º Ctrl+C ⇒ ARMA a saída (footer: "ctrl-c de novo para sair"), NÃO sai;
//   · qualquer outra tecla ⇒ DESARMA;
//   · composer COM TEXTO + Ctrl+C ⇒ LIMPA o texto (não arma, não sai).
// O 2º Ctrl+C (dentro da janela) encerra de fato — caminho de exit() do useApp, coberto
// pela lógica; aqui provamos o que é OBSERVÁVEL sem desmontar (a 1ª não sai + a dica arma).

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
import { CTRL_C_WINDOW_MS } from '../../src/session/composer-edit.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const CTRL_C = '\x03';

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

function mount(opts?: {
  fileIndex?: { list: () => Promise<readonly string[]> };
  attachReader?: { attach: (path: string, o?: unknown) => Promise<unknown> };
}): ReturnType<typeof render> & { controller: SessionController } {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts?.fileIndex !== undefined ? { fileIndex: opts.fileIndex as never } : {})}
        {...(opts?.attachReader !== undefined ? { attachReader: opts.attachReader as never } : {})}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { ...r, controller } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('App — duplo Ctrl+C p/ sair (EST-1015)', () => {
  it('1º Ctrl+C no composer VAZIO NÃO sai: arma a saída e mostra "ctrl-c de novo"', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write(CTRL_C);
    await flush();
    // a app SEGUE montada (não saiu) e o footer pede confirmação.
    expect(plain(lastFrame())).toContain('de novo');
    controller.dispose();
  });

  it('uma tecla qualquer DESARMA a saída pendente (a dica some)', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write(CTRL_C);
    await flush();
    expect(plain(lastFrame())).toContain('de novo'); // armado
    stdin.write('x'); // atividade ⇒ desarma
    await flush();
    expect(plain(lastFrame())).not.toContain('de novo');
    controller.dispose();
  });

  it('Ctrl+C com TEXTO no composer LIMPA o texto (não arma a saída)', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write('rascunho'); // digita algo
    await flush();
    expect(plain(lastFrame())).toContain('rascunho');
    stdin.write(CTRL_C); // 1º Ctrl+C ⇒ limpa, não arma
    await flush();
    const f = plain(lastFrame());
    expect(f).not.toContain('rascunho'); // texto sumiu
    expect(f).not.toContain('de novo'); // e NÃO armou a saída
    controller.dispose();
  });

  // F160 — dois Ctrl+C em eventos SÍNCRONOS (mesmo tick, SEM commit do React entre eles —
  // o `useEffect` do useInput ainda não re-subscreveu ⇒ o 2º evento roda no closure VELHO)
  // precisam SAIR: o armado vive num REF+timestamp, não no estado do closure. Antes, os
  // dois viam `armed=false` ⇒ só armavam ⇒ "duplo Ctrl-C instável" (3 tentativas p/ sair).
  // OBSERVÁVEL: o exit() desmonta a árvore ⇒ o frame CONGELA — uma tecla-marcador escrita
  // depois NÃO aparece. (A dica "de novo" PODE estar no frame congelado — foi commitada
  // pelo 1º Ctrl+C antes do unmount; não a assertamos.)
  it('F160: dois Ctrl+C no MESMO tick SAEM (ref síncrono, não estado stale)', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write(CTRL_C);
    stdin.write(CTRL_C); // mesmo tick — SEM flush entre os dois.
    await flush();
    stdin.write('zqzq'); // marcador: só apareceria se o composer seguisse VIVO.
    await flush();
    expect(plain(lastFrame())).not.toContain('zqzq');
    controller.dispose();
  });

  it('F160: 2º Ctrl+C DENTRO da janela (ticks separados) segue saindo', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write(CTRL_C);
    await flush();
    expect(plain(lastFrame())).toContain('de novo'); // armado e visível
    stdin.write(CTRL_C); // 2º dentro da janela (bem < 2.5s)
    await flush();
    stdin.write('zqzq');
    await flush();
    expect(plain(lastFrame())).not.toContain('zqzq'); // saiu — sem composer vivo.
    controller.dispose();
  });

  it('F160: 2º Ctrl+C FORA da janela NÃO sai (re-arma) — a app segue viva', async () => {
    vi.useFakeTimers();
    try {
      const { stdin, lastFrame, controller } = mount();
      await vi.advanceTimersByTimeAsync(20);
      stdin.write(CTRL_C);
      await vi.advanceTimersByTimeAsync(20);
      // Deixa a janela EXPIRAR (2.5s) — o timestamp do ref envelhece.
      await vi.advanceTimersByTimeAsync(CTRL_C_WINDOW_MS + 200);
      stdin.write(CTRL_C); // fora da janela ⇒ re-ARMA (não sai).
      await vi.advanceTimersByTimeAsync(20);
      stdin.write('zqzq'); // app viva ⇒ o marcador entra no composer…
      await vi.advanceTimersByTimeAsync(20);
      expect(plain(lastFrame())).toContain('zqzq');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // F174 — ANEXO pendente (@arquivo) conta como conteúdo do composer: o Ctrl-C com
  // texto vazio + chip deve LIMPAR o anexo (não armar a saída), e o chip não pode
  // sobreviver ao "limpar" e grudar no próximo objetivo.
  it('F174: Ctrl-C com só um chip de anexo pendente LIMPA o anexo (não arma saída)', async () => {
    const attachItem = {
      role: 'observation' as const,
      toolName: 'attach',
      text: 'conteúdo de xyzzy',
    };
    const fileIndex = { list: async (): Promise<readonly string[]> => ['src/xyzzy.ts'] };
    const attachReader = {
      attach: async (path: string): Promise<unknown> => ({
        kind: 'ok',
        path,
        item: attachItem,
        truncated: false,
      }),
    };
    const { stdin, lastFrame, controller } = mount({ fileIndex, attachReader });
    await flush();
    // @-picker: digita `@xyzzy`, Enter anexa ⇒ chip no composer.
    stdin.write('@xyzzy');
    await flush();
    stdin.write('\r');
    await flush();
    expect(plain(lastFrame())).toContain('xyzzy.ts'); // chip presente
    // Ctrl-C: texto vazio + chip ⇒ deve LIMPAR o chip (não armar saída).
    stdin.write(CTRL_C);
    await flush();
    const f = plain(lastFrame());
    expect(f).not.toContain('xyzzy.ts'); // anexo LIMPO
    expect(f).not.toContain('de novo'); // NÃO armou a saída
    controller.dispose();
  });
});
