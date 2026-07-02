// EST-1000 · ADR-0076 — o MODO COCKPIT na <App>: `/fullscreen` entra (alt-screen via o
// hook injetado + 6 regiões), persiste, scroll/Tab funcionam, `<80col` recusa→inline, e
// o INLINE segue o DEFAULT intacto. ink-testing-library (sem PTY); a prova de bytes da
// restauração/anti-flicker vivem em alt-screen.test.ts e cockpit-bytes.test.tsx.

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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

// ink-testing-library fixa columns=100 (cabe no cockpit: ≥80 col, rows=24 ≥ piso).
function renderApp(
  _columns: number,
  extra: Partial<AppProps> = {},
): ReturnType<typeof render> & { controller: SessionController } {
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

// O cockpit está DESATIVADO p/ o usuário nesta versão; o escape hatch ALUY_FULLSCREEN=1
// religa o código (intacto) p/ estes testes exercitarem a entrada/render do cockpit.
beforeEach(() => vi.stubEnv('ALUY_FULLSCREEN', '1'));
afterEach(() => vi.unstubAllEnvs());

describe('App — MODO COCKPIT: entrada via /fullscreen', () => {
  it('default é INLINE (sem fullscreen) — não há rótulo de região da conversa', async () => {
    const { lastFrame, controller } = renderApp(100);
    await flush();
    // INLINE: a App mostra o composer/header inline, não os rótulos do cockpit.
    expect(plain(lastFrame() ?? '')).not.toContain('conversa');
    controller.dispose();
  });

  it('/fullscreen ENTRA no cockpit: chama enter() (alt-screen) e renderiza as 6 regiões', async () => {
    const enter = vi.fn();
    const leave = vi.fn();
    const onFullscreenChange = vi.fn();
    const { controller, lastFrame, stdin } = renderApp(100, {
      cockpitScreen: { enter, leave },
      onFullscreenChange,
    });
    await flush();
    // dispara o comando `/fullscreen` digitando-o no composer + Enter (mesmo caminho do
    // usuário: submit → routeInput → runCommand → toggleFullscreen).
    stdin.write('/fullscreen');
    await flush();
    stdin.write('\r');
    await flush();
    expect(enter).toHaveBeenCalledTimes(1); // ADR §2: entrou no alt-screen.
    expect(onFullscreenChange).toHaveBeenCalledWith(true); // persiste a pref.
    const frame = plain(lastFrame() ?? '');
    // as 6 regiões: rótulos de conversa + log + os componentes de chrome reusados.
    expect(frame).toContain('conversa');
    expect(frame).toContain('LOG');
    controller.dispose();
  });

  // EST-1000 · ADR-0076 — o cockpit é EXPERIMENTAL: ao ENTRAR, a nota efêmera avisa
  // (discreta, na região de notas; render do cockpit INALTERADO). inline é o recomendado.
  it('/fullscreen empurra a NOTA de INSTRUÇÃO ao entrar (sem "experimental" — #386)', async () => {
    const { controller, lastFrame, stdin } = renderApp(100, {
      cockpitScreen: { enter: vi.fn(), leave: vi.fn() },
      onFullscreenChange: vi.fn(),
    });
    await flush();
    stdin.write('/fullscreen');
    await flush();
    stdin.write('\r');
    await flush();
    const frame = plain(lastFrame() ?? '');
    // EST-1015 — a nota de entrada é INSTRUÇÃO (tab/scroll/sair), NÃO auto-depreciação: o
    // cockpit deixou de ser "experimental" (#386, render limpo provado). a App usa pt-BR.
    expect(frame).toContain('modo cockpit');
    expect(frame).not.toContain('experimental');
    controller.dispose();
  });

  // OBS: ink-testing-library fixa columns=100 e ignora um stdout injetado, então a
  // RECUSA narrow (<80 col) é provada no nível PURO (cockpit-layout.test.ts) — o caminho
  // App→resolveCockpitLayout→inline+aviso usa a MESMA função. Aqui cobrimos o fits=true.

  it('boot com initialFullscreen + tela larga ⇒ entra no alt-screen 1× (caminho legado/teste sem wiring)', async () => {
    const enter = vi.fn();
    const { controller } = renderApp(120, {
      initialFullscreen: true,
      cockpitScreen: { enter, leave: vi.fn() },
    });
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  // EST-1001 · ADR-0076 §2 (FIX #144) — o WIRING entra no alt-screen ANTES do 1º frame
  // (cockpitEnteredAtBoot=true). A App NÃO re-emite `?1049h` (evita o duplo enter que, no
  // boot, pintava o frame na tela PRIMÁRIA e deixava o alt-screen preto). Ela ainda monta
  // o cockpit (6 regiões), mas SEM chamar enter() de novo.
  it('boot com cockpitEnteredAtBoot=true ⇒ NÃO re-chama enter() (wiring já entrou), mas RENDERIZA o cockpit', async () => {
    const enter = vi.fn();
    const { controller, lastFrame } = renderApp(120, {
      initialFullscreen: true,
      cockpitEnteredAtBoot: true,
      cockpitScreen: { enter, leave: vi.fn() },
    });
    await flush();
    expect(enter).not.toHaveBeenCalled(); // o wiring já emitiu o ?1049h — nada de duplo enter.
    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('conversa'); // mas o cockpit ESTÁ na tela (6 regiões montadas).
    expect(frame).toContain('LOG');
    controller.dispose();
  });
});

describe('App — cockpit: foco (Tab) e export (ctrl+s)', () => {
  it('ctrl+s no cockpit chama o exportador redigido', async () => {
    const onExportTranscript = vi.fn(async () => ({ ok: true, path: '/tmp/x.md' }));
    const { controller, stdin } = renderApp(120, {
      initialFullscreen: true,
      cockpitScreen: { enter: vi.fn(), leave: vi.fn() },
      onExportTranscript,
    });
    await flush();
    // ctrl+s (\x13) no cockpit ativo.
    stdin.write('\x13');
    await flush();
    expect(onExportTranscript).toHaveBeenCalled();
    controller.dispose();
  });
});

describe('App — cockpit: notas de boot RELOCADAS expandem o LOG (EST-1015)', () => {
  it('nota `config` pré-turno aparece INTEIRA na região do LOG (o log não recolhe p/ 1 linha)', async () => {
    // FALHA-SEM/PASSA-COM: o sinal adaptativo (cockpitLogHint) ignorava as notas de boot
    // relocadas ⇒ hasActivity=false ⇒ log RECOLHIDO (1 linha) ⇒ as notas ficavam
    // invisíveis (a realocação do EST-1015 morria). Agora elas contam no hint.
    const { lastFrame, controller } = renderApp(100, {
      initialFullscreen: true,
      cockpitScreen: { enter: vi.fn(), leave: vi.fn() },
    });
    controller.restoreBlocks([
      { kind: 'note', title: 'config', lines: ['instruções: CLAUDE.md', '2 servers MCP'] },
    ]);
    await flush();
    const frame = plain(lastFrame() ?? '');
    // as DUAS linhas da nota estão visíveis no frame do cockpit (nenhum `…` as comeu).
    expect(frame).toContain('config');
    expect(frame).toContain('instruções: CLAUDE.md');
    expect(frame).toContain('2 servers MCP');
    // e a CONVERSA segue no boas-vindas (a nota foi relocada, não duplicada).
    expect(frame).toContain('Λluy — cockpit');
    controller.dispose();
  });
});
