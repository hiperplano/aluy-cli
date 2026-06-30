// EST-0982 — SLASH-MENU DURANTE O TRABALHO: o menu do `/` abre enquanto o agente roda.
//
// O bug (Tiago): "quando uso / e o agente tá rodando ele não apresenta o menu". O
// type-ahead (#66) já deixava DIGITAR durante `thinking`/`streaming`/`retrying`, mas o
// ramo de trabalho NÃO ligava o slash-menu (só o ramo idle chamava `setSlashOpen`).
//
// Agora o ramo de trabalho liga o menu pela MESMA regra do idle (helper `syncSlashMenu`):
//   • digitar `/`      → ABRE o `<SlashMenu>` (lista tudo); `/mem` filtra.
//   • ↑↓               → NAVEGA a seleção.
//   • Tab              → COMPLETA o `/comando` selecionado no composer (sem submeter).
//   • Enter            → ENFILEIRA o comando (type-ahead: auto-submete ao fim, NÃO
//                        interrompe) e FECHA o menu.
//   • esc              → FECHA o menu SEM cancelar o trabalho (o esc de interromper só
//                        vale com o menu fechado).
//   • espaço           → FECHA o menu (texto deixa de casar `isSlashMenuQuery`).
//
// FRUGAL (DoD): sem modelo real — o `gatedStreamingCaller` deixa a sessão VIVA em
// `streaming` por um gate, e dirigimos o stdin. No idle nada regride (coberto alhures).

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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return (s ?? '').replace(ANSI, '');
}

// A "marca" do menu aberto: o cabeçalho fixo do <SlashMenu>. Não colide com o composer.
const MENU_HEADER = '/ para comandos';

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

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** ModelCaller que entra em STREAMING e fica vivo até o gate resolver (agente "trabalhando"). */
function gatedStreamingCaller(opts: {
  sink: () => SessionController['sink'];
  nextGate: () => Promise<void>;
}): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      const sink = opts.sink();
      sink.onStart?.();
      sink.onDelta('trabalhando…');
      await opts.nextGate();
      sink.onDone?.();
      return { request_id: 'r', content: 'trabalhando…', finish_reason: 'stop' };
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buildSession() {
  const gates = [defer(), defer(), defer()];
  let gateIdx = 0;
  let controllerRef: SessionController | null = null;

  const model = gatedStreamingCaller({
    sink: () => controllerRef!.sink,
    nextGate: () => gates[gateIdx++]!.promise,
  });

  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  controllerRef = controller;
  controller.dismissBoot();

  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return {
    controller,
    resolveGate: (i: number) => gates[i]!.resolve(),
    ...r,
  };
}

const CR = '\r'; // Enter limpo
const ARROW_DOWN = ESC + '[B';
const ARROW_UP = ESC + '[A';
const TAB = '\t';

// A LINHA do composer começa com o prompt `›`. EST-0974 — o <SlashMenu> agora renderiza
// ABAIXO do composer (composer ANCORADO), e o item SELECIONADO também começa com `›`
// (`› /cmd`). Então o composer é a ÚLTIMA linha com `›` ANTES do cabeçalho do menu
// (`/ para comandos`); fatiamos o frame nesse cabeçalho e pegamos o último `›` da parte
// de CIMA (onde mora o input). Menu fechado ⇒ não há cabeçalho ⇒ usa o frame inteiro.
function composerLine(s: { lastFrame: () => string }): string {
  const frame = plain(s.lastFrame());
  const above = frame.split(MENU_HEADER)[0] ?? frame;
  const rows = above.split('\n').filter((l) => l.trimStart().startsWith('›'));
  const row = rows[rows.length - 1];
  const text = (row ?? '').replace(/^\s*›\s?/, '').trim();
  return text.startsWith('digite um objetivo') ? '' : text;
}

// Liga o listener de stdin do Ink (só attacha num efeito pós-1º-commit): escreve um
// sentinela, espera ecoar, apaga. A partir daí cada write é entregue UMA vez.
async function ensureListener(s: {
  stdin: { write: (x: string) => void };
  lastFrame: () => string;
}) {
  await pressUntil(
    () => s.stdin.write('~'),
    () => composerLine(s) === '~',
  );
  s.stdin.write(String.fromCharCode(127));
  await waitFor(() => composerLine(s) !== '~');
  await new Promise((r) => setTimeout(r, 20));
}

async function tap(s: { stdin: { write: (x: string) => void } }, seq: string) {
  s.stdin.write(seq);
  await new Promise((r) => setTimeout(r, 30));
}

/** Linha selecionada do menu (a que começa com `› /`), só o nome do comando.
 * EST-0974 — o menu está ABAIXO do composer; o input digitado (`› /mem`) também casa
 * `› /`. Procuramos só DEPOIS do cabeçalho do menu (`/ para comandos`), onde moram os
 * itens — assim a linha do composer (acima do cabeçalho) não é confundida com a seleção. */
function selectedCommand(s: { lastFrame: () => string }): string | null {
  const frame = plain(s.lastFrame());
  const idx = frame.indexOf(MENU_HEADER);
  const below = idx >= 0 ? frame.slice(idx) : frame;
  const row = below.split('\n').find((l) => l.trimStart().startsWith('› /'));
  if (!row) return null;
  const m = row.trim().match(/›\s+\/(\S+)/);
  return m ? m[1]! : null;
}

async function startStreaming() {
  const s = buildSession();
  void s.controller.submit('objetivo inicial');
  await waitFor(() => s.controller.current.phase === 'streaming');
  await ensureListener(s);
  return s;
}

describe('App — SLASH-MENU durante o trabalho (EST-0982)', () => {
  it('em STREAMING, digitar `/` ⇒ o <SlashMenu> ABRE (slashOpen)', async () => {
    const s = await startStreaming();

    await tap(s, '/');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));
    expect(plain(s.lastFrame())).toContain(MENU_HEADER);
    // Lista os nativos (ex.: /help, /model).
    expect(plain(s.lastFrame())).toContain('/help');
    expect(s.controller.current.phase).toBe('streaming');

    s.resolveGate(0);
    s.unmount();
  });

  it('`/mem` FILTRA o menu (mostra /memory, esconde /help)', async () => {
    const s = await startStreaming();

    await tap(s, '/mem');
    await waitFor(() => plain(s.lastFrame()).includes('/memory'));
    const frame = plain(s.lastFrame());
    expect(frame).toContain(MENU_HEADER);
    expect(frame).toContain('/memory');
    expect(frame).not.toContain('/help');

    s.resolveGate(0);
    s.unmount();
  });

  it('↑↓ NAVEGA a seleção do menu durante o trabalho', async () => {
    const s = await startStreaming();

    await tap(s, '/');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));
    const first = selectedCommand(s);
    expect(first).not.toBeNull();

    await tap(s, ARROW_DOWN);
    await waitFor(() => selectedCommand(s) !== first);
    const second = selectedCommand(s);
    expect(second).not.toBe(first);

    // ↑ volta p/ o primeiro.
    await tap(s, ARROW_UP);
    await waitFor(() => selectedCommand(s) === first);
    expect(selectedCommand(s)).toBe(first);

    s.resolveGate(0);
    s.unmount();
  });

  it('Tab COMPLETA o comando selecionado no composer (sem submeter)', async () => {
    const s = await startStreaming();
    const submitSpy = vi.spyOn(s.controller, 'submit');

    await tap(s, '/');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));
    const sel = selectedCommand(s);
    expect(sel).not.toBeNull();

    await tap(s, TAB);
    // O composer agora tem `/<comando>` completo; o menu segue aberto (texto ainda casa).
    await waitFor(() => composerLine(s) === `/${sel}`);
    expect(composerLine(s)).toBe(`/${sel}`);
    expect(plain(s.lastFrame())).toContain(MENU_HEADER);
    // Não submeteu nada (Tab completa, não executa).
    expect(submitSpy.mock.calls.some((c) => c[0] !== 'objetivo inicial')).toBe(false);

    submitSpy.mockRestore();
    s.resolveGate(0);
    s.unmount();
  });

  it('Enter com o menu aberto num MUTADOR ⇒ ENFILEIRA o comando (não interrompe) e FECHA o menu', async () => {
    const s = await startStreaming();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    // EST-0982 (P2-1) — filtra p/ um MUTADOR (`/compact`): com os read-only marcados
    // `parallelWhileBusy`, Enter num comando paralelo-seguro RODA já (não enfileira); o
    // caso de ENFILEIRAR-no-Enter vale p/ os mutadores, então miramos o /compact.
    await tap(s, '/compact');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));
    const sel = selectedCommand(s);
    expect(sel).toBe('compact');

    await tap(s, CR);
    // Enfileirou (chrome "na fila" aparece) e o menu FECHOU.
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));
    expect(plain(s.lastFrame())).toContain(`/${sel}`);
    expect(plain(s.lastFrame())).not.toContain(MENU_HEADER);
    // NÃO interrompeu o agente; segue em streaming.
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(s.controller.current.phase).toBe('streaming');

    // Ao terminar o turno, a fila AUTO-SUBMETE o `/comando` (mesma submit/routeInput do
    // type-ahead). Como `/comando` é roteado como command (não goal), `submit` NÃO é
    // chamado com ele — mas a fila esvazia (some o chrome) sem interromper.
    s.resolveGate(0);
    await waitFor(() => !plain(s.lastFrame()).includes('na fila'));

    interruptSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  it('esc com o menu aberto ⇒ FECHA o menu SEM cancelar o trabalho; o freio só volta com TUDO vazio', async () => {
    // ESPEC FINAL DO DONO (corrigida ao vivo) — o freio do ESC mudou: o ESC SÓ PARA o turno
    // quando está TUDO VAZIO (fila vazia E sem injects pendentes E composer vazio). Antes,
    // o "esc seguinte" (menu já fechado) parava direto; mas fechar o menu DEIXA o `/` no
    // composer ⇒ esse ESC agora ACELERA (redirect do `/`), NÃO para. Então o freio AINDA é
    // alcançável, só que exige esvaziar primeiro: apago o `/` (backspace) e, com o composer
    // vazio e sem pendência, o ESC volta a ser o freio (interrompe). (F8/Ctrl+C seguem stop
    // a qualquer momento — não exercitados aqui.)
    const BACKSPACE = '\x7f';
    const s = await startStreaming();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');

    await tap(s, '/');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));

    // (a) fechar o menu NÃO aborta o trabalho — e DEIXA o `/` no composer.
    await tap(s, ESC);
    await waitFor(() => !plain(s.lastFrame()).includes(MENU_HEADER));
    expect(plain(s.lastFrame())).not.toContain(MENU_HEADER);
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(s.controller.current.phase).toBe('streaming');
    // O `/` SOBROU no composer (pendência) ⇒ o composer NÃO está vazio.
    expect(composerLine(s).replace(/^›\s*/, '').trim()).toBe('/');

    // (b) o freio AINDA é alcançável (NÃO trivial): com o `/` no composer, o ESC ACELERA
    //     (não para). Esvazio o composer (apago o `/`) e SÓ então, com TUDO vazio (fila vazia,
    //     sem injects, composer vazio), o ESC volta a ser o freio (interrompe).
    await pressUntil(
      () => s.stdin.write(BACKSPACE),
      () => composerLine(s).replace(/^›\s*/, '').trim() === '',
    );
    expect(interruptSpy).not.toHaveBeenCalled(); // até aqui NADA parou (só fechou o menu + editou)
    await pressUntil(
      () => s.stdin.write(ESC),
      () => interruptSpy.mock.calls.length > 0,
    );
    expect(interruptSpy).toHaveBeenCalled();

    interruptSpy.mockRestore();
    s.resolveGate(0);
    s.unmount();
  });

  it('espaço (texto que não casa) ⇒ FECHA o menu (igual idle)', async () => {
    const s = await startStreaming();

    await tap(s, '/mem');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));

    // Um espaço entra nos "args": `isSlashMenuQuery` vira false ⇒ menu fecha.
    await tap(s, ' ');
    await waitFor(() => !plain(s.lastFrame()).includes(MENU_HEADER));
    expect(plain(s.lastFrame())).not.toContain(MENU_HEADER);
    expect(s.controller.current.phase).toBe('streaming');

    s.resolveGate(0);
    s.unmount();
  });

  it('backspace que apaga a `/` ⇒ FECHA o menu', async () => {
    const BS = String.fromCharCode(127);
    const s = await startStreaming();

    await tap(s, '/');
    await waitFor(() => plain(s.lastFrame()).includes(MENU_HEADER));

    await tap(s, BS);
    await waitFor(() => !plain(s.lastFrame()).includes(MENU_HEADER));
    expect(plain(s.lastFrame())).not.toContain(MENU_HEADER);

    s.resolveGate(0);
    s.unmount();
  });
});
