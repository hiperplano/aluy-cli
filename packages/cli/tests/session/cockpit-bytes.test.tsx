// EST-1000 · ADR-0076 §5 — PROVA DE BYTES (do COMPONENTE): no cockpit a tela é FIXA (soma
// das regiões == rows) e NÃO há `<Static>`. Provamos por construção, no FRAME que o
// componente produz:
//   (a) o cockpit NÃO usa `<Static>` (o mecanismo do inline cujo crescimento dispara o
//       redesenho do histórico); logo não há cascata de scrollback.
//   (b) o frame do cockpit cabe em `rows` linhas (nunca estoura/reflui).
//   (c) o CONTEÚDO do componente NÃO contém bytes de clear de tela (`\x1b[2J`/`\x1b[3J`).
// Contraste com o INLINE, que USA `<Static>` (anti-flicker EST-0965 por outra via).
//
// NOTA (EST-0965): o `\x1b[2J` que importa p/ o FLICKER NÃO nasce no componente — nasce no
// RENDERER do Ink. Como o cockpit ENCHE `rows`, o Ink TOMA o caminho `outputHeight>=rows`,
// que escreve `ansiEscapes.clearTerminal` (`\x1b[2J\x1b[3J\x1b[H`) + frame a cada render.
// Quem NEUTRALIZA esse `\x1b[2J` é o ENVELOPE de stdout (`cockpitOverwriteInPlace`, §5),
// provado nos bytes do STDOUT em `synchronized-output.test.ts` (transform puro) e
// `cockpit-flicker.test.tsx` (Ink REAL + envelope). Este arquivo prova só o lado do COMPONENTE.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Espiona o `<Static>` do Ink: conta quantas vezes é RENDERIZADO (com itens).
const staticRenders: number[] = [];
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    Static: ({ items }: { items: unknown[] }) => {
      staticRenders.push(items.length);
      return null;
    },
  };
});

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
import { App } from '../../src/session/App.js';
import { Cockpit } from '../../src/session/Cockpit.js';
import { I18nProvider, i18n as makeI18n } from '../../src/i18n/index.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { resolveCockpitLayout } from '../../src/session/cockpit-layout.js';
import type { SessionState } from '../../src/session/model.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

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

function controller(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 1234, windowPct: 12 },
    flush: { intervalMs: 0 },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Um estado com VÁRIOS turnos (mais que cabem na conversa) p/ provar que não estoura. */
function busyState(): SessionState {
  const blocks = Array.from({ length: 40 }, (_, i) => ({
    kind: 'you' as const,
    text: `linha de conversa número ${i} — texto razoavelmente comprido p/ testar wrap`,
  }));
  return {
    phase: 'idle',
    blocks,
    mode: 'normal',
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 1234, windowPct: 12 },
  } as unknown as SessionState;
}

describe('PROVA DE BYTES (§5) — cockpit não usa Static (sem cascata) e cabe em rows', () => {
  it('o INLINE usa <Static> (≥1 render); o COCKPIT NÃO (zero)', async () => {
    // INLINE (default): a App monta o <Static> p/ o histórico (anti-flicker EST-0965).
    staticRenders.length = 0;
    const ctrlInline = controller();
    const theme = resolveTheme({ env: ENV });
    const inline = render(
      <ThemeProvider theme={theme}>
        <App controller={ctrlInline} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    ctrlInline.dismissBoot();
    await flush();
    const inlineStaticRenders = staticRenders.length;
    inline.unmount();
    ctrlInline.dispose();
    expect(inlineStaticRenders).toBeGreaterThan(0); // inline USA Static.

    // COCKPIT: renderiza a 2ª superfície direto (sem Static — grid fixo).
    staticRenders.length = 0;
    const rows = 24;
    const cols = 100;
    const layout = resolveCockpitLayout(rows, cols);
    expect(layout.kind).toBe('cockpit');
    if (layout.kind !== 'cockpit') return;
    const cockpit = render(
      <ThemeProvider theme={theme}>
        <I18nProvider value={makeI18n('pt-BR')}>
          <Cockpit
            state={busyState()}
            layout={layout}
            logSections={[]}
            focus="conversa"
            conversaScroll={0}
            logScroll={0}
            input=""
            cursorPos={0}
            composerActive
            showCursor={false}
            hintState="idle"
            tierDisplay="Flux"
            isDefaultTier
            columns={cols}
            frame={0}
            cwd="/proj"
          />
        </I18nProvider>
      </ThemeProvider>,
    );
    await flush();
    // O COCKPIT NÃO renderiza Static ⇒ não há mecanismo de cascata de scrollback.
    expect(staticRenders.length).toBe(0);
    cockpit.unmount();
  });

  it('o frame do cockpit CABE em rows (nunca estoura ⇒ sem reflow/clear)', async () => {
    const rows = 24;
    const cols = 100;
    const layout = resolveCockpitLayout(rows, cols);
    if (layout.kind !== 'cockpit') throw new Error('layout deveria caber');
    const theme = resolveTheme({ env: ENV });
    const r = render(
      <ThemeProvider theme={theme}>
        <I18nProvider value={makeI18n('pt-BR')}>
          <Cockpit
            state={busyState()}
            layout={layout}
            logSections={[]}
            focus="conversa"
            conversaScroll={0}
            logScroll={0}
            input=""
            cursorPos={0}
            composerActive
            showCursor={false}
            hintState="idle"
            tierDisplay="Flux"
            isDefaultTier
            columns={cols}
            frame={0}
            cwd="/proj"
          />
        </I18nProvider>
      </ThemeProvider>,
    );
    await flush();
    const frame = r.lastFrame() ?? '';
    // (c) o cockpit NÃO emite clear de tela/scrollback (esses bytes não existem no frame).
    expect(frame).not.toContain('\x1b[2J');
    expect(frame).not.toContain('\x1b[3J');
    // (b) o conteúdo cabe em `rows` linhas (com 40 turnos, a conversa JANELA — não despeja
    //     tudo). A região mostra só a cauda que cabe; a árvore total ≤ rows.
    const lines = plain(frame).split('\n');
    expect(lines.length).toBeLessThanOrEqual(rows);
    r.unmount();
  });
});
