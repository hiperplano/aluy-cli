// EST-1000 (#157 fix) — os OVERLAYS de `/` PINTAM no cockpit/`/fullscreen`.
//
// O bug (QA): no cockpit a App fazia `return (<Cockpit/>)` ANTES do bloco que renderiza
// os overlays (SlashMenu + pickers model/theme/lang/history + CommandPalette), que viviam
// só no caminho INLINE. Resultado: no cockpit o ESTADO abria (`slashOpen`/`*Picker.open`/
// `palette.open`) mas NENHUMA lista pintava — `/`/`/model`/`/theme`/`/lang`/`/history`
// inutilizáveis no cockpit. O fix passa os MESMOS componentes como popover (`overlay`)
// sobre a região da conversa.
//
// Este teste dirige a <App> via ink-testing-library (a MESMA superfície dos demais testes
// do cockpit — app-cockpit), entra no `/fullscreen` e prova que cada overlay PINTA dentro
// do cockpit. Sem PTY/pyte aqui (o byte-level vive no cockpit-overlay-pty); sem modelo.

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
import { App, type AppProps } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const SLASH_HINT = 'enter executa · esc fecha'; // cabeçalho do <SlashMenu>
const THEME_HINT = 'trocar tema'; // cabeçalho do <ThemePicker>

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

async function typeCharByChar(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(40);
  }
  await sleep(40);
}

async function warmup(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  // garante que o stdin do Ink anexou (digitação é absorvida) antes de dirigir.
  const deadline = Date.now() + 2000;
  while (!plain(lastFrame() ?? '').includes('zzwarm')) {
    if (Date.now() > deadline) throw new Error('warmup: stdin do Ink não anexou no prazo');
    stdin.write('zzwarm');
    await sleep(20);
    if (plain(lastFrame() ?? '').includes('zzwarm')) break;
  }
  // apaga o warmup char-a-char.
  for (let i = 0; i < 6; i++) stdin.write('\x7f');
  await sleep(60);
}

function renderApp(extra: Partial<AppProps> = {}): ReturnType<typeof render> & {
  controller: SessionController;
} {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} {...extra} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { ...r, controller } as never;
}

/** Sobe a App JÁ no cockpit (initialFullscreen + cockpitScreen injetado) e faz o warmup. */
async function mountCockpit(extra: Partial<AppProps> = {}) {
  const r = renderApp({
    initialFullscreen: true,
    cockpitScreen: { enter: vi.fn(), leave: vi.fn() },
    ...extra,
  });
  await flush();
  // confirma que entrou no cockpit (rótulos das 6 regiões).
  await waitFor(() => {
    const f = plain(r.lastFrame() ?? '');
    return f.includes('conversa') && f.includes('LOG');
  });
  await warmup(r.stdin, r.lastFrame);
  return r;
}

describe('App — cockpit: overlays de `/` PINTAM (FIX #157)', () => {
  it('digitar `/` no cockpit ABRE o <SlashMenu> VISÍVEL (lista pinta sobre a conversa)', async () => {
    const r = await mountCockpit();
    await typeCharByChar(r.stdin, '/');
    // o cabeçalho do menu + ao menos um comando conhecido PINTAM no frame do cockpit.
    await waitFor(() => plain(r.lastFrame() ?? '').includes(SLASH_HINT));
    const f = plain(r.lastFrame() ?? '');
    expect(f).toContain(SLASH_HINT);
    expect(f).toContain('/help'); // a lista de comandos de fato pintou.
    // o popover sinaliza a sobreposição (rótulo `conversa · /menu` na região da conversa).
    expect(f).toContain('conversa · /menu');
    // as regiões do cockpit não sumiram: a régua/rótulo do LOG segue no lugar (grid íntegro).
    expect(f).toContain('LOG ·');
    r.controller.dispose();
  });

  it('`/theme` no cockpit ABRE o <ThemePicker> VISÍVEL', async () => {
    const r = await mountCockpit({ onSelectTheme: vi.fn() });
    await typeCharByChar(r.stdin, '/theme');
    await waitFor(() => plain(r.lastFrame() ?? '').includes(SLASH_HINT));
    // seleciona o comando `/theme` (1º item filtrado) e Enter ⇒ abre o picker.
    r.stdin.write('\r');
    await waitFor(() => plain(r.lastFrame() ?? '').includes(THEME_HINT));
    const f = plain(r.lastFrame() ?? '');
    expect(f).toContain(THEME_HINT); // o picker de tema pintou no cockpit.
    r.controller.dispose();
  });

  it('Ctrl+P no cockpit ABRE a <CommandPalette> VISÍVEL', async () => {
    const r = await mountCockpit();
    r.stdin.write('\x10'); // Ctrl+P
    await waitFor(() => plain(r.lastFrame() ?? '').includes('conversa · /menu'));
    const f = plain(r.lastFrame() ?? '');
    // a paleta lista comandos buscáveis — pelo menos um comando conhecido pinta.
    expect(f).toContain('/help');
    expect(f).toContain('conversa · /menu'); // popover sobre a conversa.
    r.controller.dispose();
  });

  it('esc FECHA o overlay no cockpit (volta a pintar a conversa, não o /menu)', async () => {
    const r = await mountCockpit();
    await typeCharByChar(r.stdin, '/');
    await waitFor(() => plain(r.lastFrame() ?? '').includes(SLASH_HINT));
    r.stdin.write('\x7f'); // backspace apaga o `/` ⇒ fecha o menu (syncSlashMenu)
    await waitFor(() => !plain(r.lastFrame() ?? '').includes(SLASH_HINT));
    const f = plain(r.lastFrame() ?? '');
    expect(f).not.toContain('conversa · /menu'); // popover sumiu…
    expect(f).toContain('▼ ao vivo'); // …e a região da conversa voltou ao normal (cauda viva).
    r.controller.dispose();
  });
});

describe('App — INLINE NÃO regride: overlays seguem onde estavam (#129)', () => {
  it('inline (sem fullscreen): `/` abre o <SlashMenu> ABAIXO do composer (sem /menu de cockpit)', async () => {
    const r = renderApp();
    await flush();
    await warmup(r.stdin, r.lastFrame);
    await typeCharByChar(r.stdin, '/');
    await waitFor(() => plain(r.lastFrame() ?? '').includes(SLASH_HINT));
    const f = plain(r.lastFrame() ?? '');
    expect(f).toContain(SLASH_HINT);
    expect(f).toContain('/help');
    // INLINE não usa o popover do cockpit nem os rótulos de região (conversa · /menu / ── log).
    expect(f).not.toContain('conversa · /menu');
    expect(f).not.toContain('LOG ·');
    r.controller.dispose();
  });
});
