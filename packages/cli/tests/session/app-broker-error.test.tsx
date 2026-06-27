// EST-0989 — prova de PONTA (App + Ink): a afordância do <BrokerError> NÃO mente.
// Em `phase === 'error'` (broker indisponível), `r` RETENTA o último objetivo (re-
// dispara o turno pelo controller) e `esc` CANCELA (descarta o erro, volta ao
// composer). Captura o wiring useInput → controller que o teste de controller não
// cobre: as teclas precisam ser interceptadas ANTES de cair no composer.
//
// Também cobre o RODAPÉ do MODO (EST-0989): em `--unsafe` o banner gritante
// renderiza no FOOTER (perto do StatusBar/FooterHints), não acima do composer.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  BrokerError,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type SearchPort,
  type ShellPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

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

/** Caller que FALHA `failTimes` vezes (BrokerError) e depois RECUPERA com `response`. */
function buildFlakyController(
  failTimes: number,
  response: string,
): {
  controller: SessionController;
  callCount: () => number;
} {
  let ctrlRef: SessionController | null = null;
  let calls = 0;
  const sink: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      calls += 1;
      if (calls <= failTimes) {
        throw new BrokerError({ status: 503, code: 'UPSTREAM', title: 'broker fora' });
      }
      sink.onStart?.();
      for (const ch of response) sink.onDelta(ch);
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content: response, finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    // EST-0948 (auto-retry) — estes testes cobrem a afordância MANUAL (r/esc) do
    // broker-error TERMINAL. `maxAttempts:1` desliga o auto-retry p/ a 1ª falha
    // retryable cair DIRETO no erro manual (sem auto-resolver antes). O auto-retry
    // (backoff visível + cancel) tem prova própria em `controller-retry.test.ts`.
    retry: { maxAttempts: 1 },
  });
  ctrlRef = controller;
  return { controller, callCount: () => calls };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ink-testing-library só ATTACHA o listener de input após o 1º commit/settle; uma
// tecla escrita antes disso é DROPADA. Por isso re-escrevemos a tecla até o efeito
// assentar (a ação é IDEMPOTENTE: `r`/`esc` no broker-error só agem em phase=error;
// fora dela viram no-op). Mesma técnica dos demais testes de App (ensureListener).
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 12));
  }
}

function renderApp(controller: SessionController, mode?: 'unsafe') {
  const theme = resolveTheme({ env: ENV });
  if (mode === 'unsafe') controller.setMode('unsafe');
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}

describe('App — <BrokerError>: r tentar / esc cancelar funcionam (EST-0989)', () => {
  it('a afordância "r tentar agora · esc cancelar" aparece no erro de broker', async () => {
    const { controller } = buildFlakyController(1, 'x');
    const { lastFrame, unmount } = renderApp(controller);
    await controller.submit('faça algo');
    // EST-0942 — um 503 é classificado como "erro do broker" (5xx genérico); o ponto
    // do teste é a AFORDÂNCIA manual (r/esc) no erro TERMINAL, não o título exato.
    await waitFor(() => plain(lastFrame() ?? '').includes('erro do broker'));
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('r tentar agora');
    expect(out).toContain('esc cancelar');
    unmount();
  });

  it('`r` RETENTA: re-dispara o objetivo; com o broker de volta, o erro some e conclui', async () => {
    const { controller, callCount } = buildFlakyController(1, 'recuperei do broker');
    const { stdin, lastFrame, unmount } = renderApp(controller);
    await controller.submit('faça algo');
    await waitFor(() => controller.current.phase === 'error');
    expect(callCount()).toBe(1);

    // tecla `r` → controller.retryLastGoal() (re-escreve até sair do erro).
    await pressUntil(
      () => stdin.write('r'),
      () => controller.current.phase !== 'error',
    );
    await waitFor(() => controller.current.phase === 'done');
    expect(callCount()).toBe(2); // re-chamou o broker
    // o bloco de erro foi REMOVIDO do estado (fonte da verdade) — a App ainda bumpa
    // a staticKey + clear de tela p/ repintar o scrollback (testado no controller).
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
    // a fala do usuário NÃO foi duplicada (um único `you`).
    expect(controller.current.blocks.filter((b) => b.kind === 'you')).toHaveLength(1);
    // e a resposta da retomada entrou (na tela viva).
    expect(plain(lastFrame() ?? '')).toContain('recuperei do broker');
    unmount();
  });

  it('`esc` CANCELA: descarta o erro e volta ao composer (idle)', async () => {
    const { controller, callCount } = buildFlakyController(1, 'x');
    const { stdin, unmount } = renderApp(controller);
    await controller.submit('faça algo');
    await waitFor(() => controller.current.phase === 'error');

    // tecla `esc` → controller.dismissError() (re-escreve até virar idle).
    await pressUntil(
      () => stdin.write(ESC),
      () => controller.current.phase === 'idle',
    );
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
    expect(callCount()).toBe(1); // esc NÃO retenta
    unmount();
  });

  it('no erro, uma tecla qualquer (que não r/esc) NÃO vaza p/ o composer nem cancela', async () => {
    const { controller } = buildFlakyController(1, 'x');
    const { stdin, lastFrame, unmount } = renderApp(controller);
    await controller.submit('faça algo');
    await waitFor(() => controller.current.phase === 'error');

    // martela 'z' (tecla solta) por uma janela — o guard de erro a ENGOLE (return):
    // não vira retry/cancel e não chega ao composer.
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      stdin.write('z');
      await new Promise((r) => setTimeout(r, 12));
    }
    // o erro segue na tela (não virou idle ⇒ 'z' não disparou cancel/retry).
    expect(controller.current.phase).toBe('error');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(true);
    // e o 'z' não foi digitado no composer (a linha do prompt não mostra "zzz…").
    expect(plain(lastFrame() ?? '')).not.toContain('zzz');
    unmount();
  });
});

describe('App — MODO no RODAPÉ: o banner UNSAFE renderiza embaixo (EST-0989)', () => {
  it('em --unsafe o banner gritante aparece DEPOIS do StatusBar (no rodapé)', async () => {
    const { controller } = buildFlakyController(0, 'ok');
    const { lastFrame, unmount } = renderApp(controller, 'unsafe');
    // espera a SESSÃO (composer) montar — não a tela de boot (que também mostra o
    // banner, mas sem o StatusBar/composer do rodapé que queremos comparar).
    await waitFor(
      () =>
        plain(lastFrame() ?? '').includes('MODO YOLO') &&
        plain(lastFrame() ?? '').includes('digite um objetivo'),
    );
    const lines = plain(lastFrame() ?? '')
      .split('\n')
      .map((l) => l.trim());
    // o aviso loud persiste (CLI-SEC-3) e é inequívoco (glifo+palavra).
    // EST-0959 — o banner exibe o nome de PRODUTO do modo: YOLO (`--yolo`).
    const idxBanner = lines.findIndex((l) => l.includes('MODO YOLO'));
    expect(idxBanner).toBeGreaterThanOrEqual(0);
    expect(lines[idxBanner]).toContain('aprovação DESLIGADA');
    // RODAPÉ: o banner vem DEPOIS do composer (linha do prompt `›`) E da linha de
    // status (a do StatusBar, com o medidor de janela `%`). Antes da mudança ele
    // morava ACIMA do composer (idxBanner < idxComposer) — esta ordem PROVA o footer.
    const idxComposer = lines.findIndex((l) => l.includes('digite um objetivo'));
    // EST-0962 — o footer mostra o NOME DE EXIBIÇÃO do tier (`Flui`), não a key crua
    // (`aluy-flux`): o tier default `aluy-flux` aparece como `Flui` no rodapé.
    const idxStatus = lines.findIndex((l) => l.includes('Flui') && l.includes('%'));
    expect(idxComposer).toBeGreaterThanOrEqual(0);
    expect(idxStatus).toBeGreaterThanOrEqual(0);
    expect(idxBanner).toBeGreaterThan(idxComposer);
    expect(idxBanner).toBeGreaterThan(idxStatus);
    unmount();
  });
});

// EST-0962 — o footer (1º campo, ◷) mostra o NOME DE EXIBIÇÃO do tier, NÃO a key
// interna. Era o bug do Tiago: a barra mostrava `aluy-granito` em vez de `Granito`.
// Sem catálogo do broker (NOOP_CATALOG no App ⇒ `modelPicker.tiers === []`), o mapa
// LOCAL (FALLBACK_TIERS) resolve a key. Tier desconhecido cai na própria key.
describe('App — footer mostra o NOME de exibição do tier, não a KEY (EST-0962)', () => {
  /** Controller mínimo (sem rede) com o `tier` da sessão fixado pela key dada. */
  function bareController(tier: string): SessionController {
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    };
    return new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier, tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
      retry: { maxAttempts: 1 },
    });
  }

  it('key não-default `aluy-granito` ⇒ o footer mostra `Granito` (mapa local, sem catálogo)', async () => {
    const { lastFrame, unmount } = renderApp(bareController('aluy-granito'));
    await waitFor(() => plain(lastFrame() ?? '').includes('digite um objetivo'));
    const frame = plain(lastFrame() ?? '');
    expect(frame).toContain('Granito'); // nome de exibição
    expect(frame).not.toContain('aluy-granito'); // nunca a key crua
    unmount();
  });

  it('key desconhecida (sem mapa nem catálogo) ⇒ o footer cai na key crua (último recurso)', async () => {
    const { lastFrame, unmount } = renderApp(bareController('aluy-quartzo'));
    await waitFor(() => plain(lastFrame() ?? '').includes('digite um objetivo'));
    // Sem display conhecido, mostra a própria key — não inventa nome e não quebra.
    expect(plain(lastFrame() ?? '')).toContain('aluy-quartzo');
    unmount();
  });
});
