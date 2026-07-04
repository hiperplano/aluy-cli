// FIX (dono) — o indicador de backend "local" (`◍ local`/`◷ local · <provider> · <modelo>`)
// aparecia DUPLICADO: no HEADER (fixo, topo) E no FOOTER/StatusBar (vivo, rodapé) — tanto
// no modo INLINE quanto no modo COCKPIT (`--fullscreen`). O dono pediu que "local" apareça
// SÓ no rodapé. Este arquivo prova, ponta-a-ponta (via <App>, não componentes isolados):
//   1) inline: "local" some do header (banner E compacto), segue no rodapé;
//   2) cockpit/fullscreen: idem — o header (sempre compacto lá, `rows=1`) não repete
//      "local"; o rodapé continua sendo a ÚNICA casa do indicador.
// Unit-level (Header isolado, banner/compacto) já cobertos em `tests/ui/components.test.tsx`.

import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
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

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

function buildLocalController(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: {
      cwd: '/proj',
      tier: 'aluy-flux',
      tokens: 0,
      windowPct: 0,
      backend: 'local',
      provider: 'ollama',
      model: 'deepseek-v4-pro',
    },
    flush: { intervalMs: 0 },
  });
}

function renderApp(
  controller: SessionController,
  extra: Partial<AppProps> = {},
): ReturnType<typeof render> & { controller: SessionController } {
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} {...extra} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { ...r, controller } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Conta ocorrências de "local" como PALAVRA (não substring de outra palavra). */
function countLocalWord(text: string): number {
  return (text.match(/\blocal\b/gi) ?? []).length;
}

describe('Header × StatusBar — "local" NÃO duplica (dono) — modo INLINE', () => {
  it('backend local: "local" aparece 1x no frame inteiro (só no rodapé/StatusBar)', async () => {
    const controller = buildLocalController();
    const { lastFrame } = renderApp(controller);
    await flush();
    const out = plain(lastFrame());

    // some do header (banner, default rows=24 ≥ HEADER_BANNER_MIN_ROWS ⇒ modo banner)…
    expect(countLocalWord(out)).toBe(1);
    // …e a única ocorrência é na linha VIVA do rodapé (StatusBar abre com `◷`).
    const lines = out.split('\n');
    const statusLine = lines.find((l) => l.includes('◷'));
    expect(statusLine).toBeDefined();
    expect(statusLine ?? '').toMatch(/\blocal\b/);
    // as linhas do header (produto/wordmark, ANTES da 1ª linha `◷`) não têm "local".
    const statusIdx = lines.findIndex((l) => l.includes('◷'));
    const headerLines = lines.slice(0, statusIdx).join('\n');
    expect(countLocalWord(headerLines)).toBe(0);
    // o rodapé segue com o detalhe rico (provider/modelo) — não regrediu.
    expect(out).toContain('ollama');
    expect(out).toContain('deepseek-v4-pro');

    controller.dispose();
  });

  it('backend local: header COMPACTO (densidade compact) também não repete "local"', async () => {
    const controller = buildLocalController();
    const theme = { ...resolveTheme({ env: ENV }), density: 'compact' as const };
    const r = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    const out = plain(r.lastFrame());

    // "local" segue 1x só (rodapé) mesmo no header compacto (Λ Aluy Cli · <tier> · …).
    expect(countLocalWord(out)).toBe(1);
    const lines = out.split('\n');
    const statusIdx = lines.findIndex((l) => l.includes('◷'));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    const headerLines = lines.slice(0, statusIdx).join('\n');
    expect(countLocalWord(headerLines)).toBe(0);

    controller.dispose();
  });
});

describe('Header × StatusBar — "local" NÃO duplica (dono) — modo COCKPIT (fullscreen)', () => {
  beforeEach(() => vi.stubEnv('ALUY_FULLSCREEN', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('backend local + fullscreen: "local" aparece 1x (só no rodapé) dentro do cockpit', async () => {
    const controller = buildLocalController();
    const { lastFrame } = renderApp(controller, {
      initialFullscreen: true,
      cockpitScreen: { enter: vi.fn(), leave: vi.fn() },
      onFullscreenChange: vi.fn(),
    });
    await flush();
    const out = plain(lastFrame());

    // confirma que de fato caiu no cockpit (as regiões nomeadas aparecem).
    expect(out).toContain('conversa');
    expect(out).toContain('LOG');

    expect(countLocalWord(out)).toBe(1);
    const lines = out.split('\n');
    const statusIdx = lines.findIndex((l) => l.includes('◷'));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    const statusLine = lines[statusIdx] ?? '';
    expect(statusLine).toMatch(/\blocal\b/);
    const headerLines = lines.slice(0, statusIdx).join('\n');
    expect(countLocalWord(headerLines)).toBe(0);
    // rodapé segue rico (provider/modelo).
    expect(out).toContain('ollama');
    expect(out).toContain('deepseek-v4-pro');

    controller.dispose();
  });
});
