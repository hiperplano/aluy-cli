// EST-0985 (polish) — a divisória ACIMA do composer é INCONDICIONAL: emoldura o
// composer SEMPRE (régua acima + régua abaixo), inclusive em sessão FRESCA e
// pós-`/clear` (sem turnos). Antes (EST-0987) ela COLAPSAVA quando a conversa
// estava vazia — herança do layout ANTIGO, em que a "sob o header" e a "acima do
// input" ficavam coladas. Hoje o header vive no <Static> no TOPO e o composer no
// rodapé da região viva, SEMPRE separados pelo corpo (Onboarding/histórico) — as
// duas nunca encostam. O gate só DESMOLDURAVA o composer numa sessão nova (sumia a
// de cima, ficava a de baixo). Bug reportado pelo Tiago ("a linha de cima do
// composer sumiu"). Este arquivo trava a moldura SIMÉTRICA e o NÃO-colapso.
//
// Como medimos: contamos no FRAME RENDIDO (o que o usuário vê) as réguas de
// CHROME — linhas inteiras de `─` com a LARGURA DO TERMINAL (`columns`). O traço
// SUTIL por-turno (`subtle`) tem largura PARCIAL (12) e é contado à parte. O
// chrome tem 4 réguas (acima/sob o header, acima/abaixo do input); NENHUMA colapsa
// por falta de turnos:
//   idle / só-sistema ⇒ 4 réguas de chrome   (2 entre header e input)
//   1+ turno real      ⇒ 4 réguas de chrome   (inalterado — só entra o traço sutil)

import React from 'react';
import { describe, expect, it } from 'vitest';
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
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

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
    flush: { intervalMs: 0 }, // flush imediato no teste
  });
  ctrl = controller;
  return controller;
}

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const DASH = '─';
// Remove sequências ANSI (cor/papel) — o frame de teste vem colorido; a régua é
// `─` envolto em códigos de papel DIM. Contamos o GLIFO, não a tinta.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
/** Linhas feitas SÓ de `─` (qualquer largura), já aparadas, com seu comprimento. */
function dashLines(frame: string): number[] {
  return frame
    .split('\n')
    .map((l) => l.replace(ANSI, '').trim())
    .filter((l) => l.length > 0 && [...l].every((c) => c === DASH))
    .map((l) => [...l].length);
}
/** A largura de CHROME = a régua MAIS LARGA (largura cheia do terminal). */
function chromeWidth(frame: string): number {
  const lens = dashLines(frame);
  return lens.length ? Math.max(...lens) : 0;
}
/** Réguas de CHROME: linhas de `─` com a largura cheia (a maior do frame). */
function chromeDividers(frame: string): number {
  const w = chromeWidth(frame);
  return dashLines(frame).filter((len) => len === w).length;
}
/** Traços SUTIS por-turno: linhas de `─` mais CURTAS que a régua cheia. */
function subtleDividers(frame: string): number {
  const w = chromeWidth(frame);
  return dashLines(frame).filter((len) => len < w).length;
}

/** Há uma régua de chrome IMEDIATAMENTE seguida por outra (dupla colada)? */
function hasAdjacentChromeDividers(frame: string): boolean {
  const w = chromeWidth(frame);
  const isChrome = (l: string): boolean => {
    const t = l.replace(ANSI, '').trim();
    return t.length === w && [...t].every((c) => c === DASH);
  };
  const lines = frame.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (isChrome(lines[i - 1]!) && isChrome(lines[i]!)) return true;
  }
  return false;
}

function renderApp(controller: SessionController) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
}

describe('App — a moldura do composer é SIMÉTRICA e NÃO colapsa em sessão vazia (EST-0985)', () => {
  it('idle (só a placa de boas-vindas) ⇒ 4 réguas de chrome (composer EMOLDURADO acima E abaixo)', async () => {
    const controller = buildController('irrelevante');
    const { lastFrame, unmount } = renderApp(controller);
    controller.dismissBoot(); // boot → idle (Onboarding no corpo)
    await waitFor(() => controller.current.phase === 'idle');
    await flush();

    expect(controller.current.blocks).toHaveLength(0);
    const frame = lastFrame() ?? '';
    // 2 do header (acima/sob) + 2 do composer (acima/abaixo) — a de ACIMA do
    // composer NÃO some mais em sessão fresca (era o bug do Tiago).
    expect(chromeDividers(frame)).toBe(4);
    expect(subtleDividers(frame)).toBe(0); // sem histórico ⇒ sem traço por-turno
    // e NENHUMA régua de chrome fica colada com outra (o header e o composer estão
    // separados pelo corpo Onboarding) — sem "régua dupla" visual.
    expect(hasAdjacentChromeDividers(frame)).toBe(false);
    unmount();
  });

  it('estado só com bloco de SISTEMA (note de /help) ⇒ AINDA 4 réguas (moldura intacta)', async () => {
    const controller = buildController('irrelevante');
    const { lastFrame, unmount } = renderApp(controller);
    controller.dismissBoot();
    await waitFor(() => controller.current.phase === 'idle');
    // bloco NÃO-conversa (saída de slash-command): não é diálogo você↔aluy.
    controller.pushNote('help', ['linha de ajuda']);
    await flush();

    expect(controller.current.blocks.every((b) => b.kind === 'note')).toBe(true);
    // a moldura do composer não depende de turno real ⇒ segue 4, sem dupla colada.
    expect(chromeDividers(lastFrame() ?? '')).toBe(4);
    expect(hasAdjacentChromeDividers(lastFrame() ?? '')).toBe(false);
    unmount();
  });

  it('pós-`/clear` (volta a 0 turnos) ⇒ a moldura do composer VOLTA inteira: 4 réguas, sem dupla', async () => {
    const controller = buildController('pronto.');
    const { lastFrame, unmount } = renderApp(controller);
    controller.dismissBoot();
    // 1 turno real e depois LIMPA — `/clear` zera blocos+contexto (`patch blocks:[]`).
    await controller.submit('faça'); // turno real
    await waitFor(() => controller.current.phase === 'done');
    controller.clear(); // o caminho do `/clear`
    await waitFor(() => controller.current.phase === 'idle');
    await flush();

    expect(controller.current.blocks).toHaveLength(0); // estado fresco de novo
    const frame = lastFrame() ?? '';
    // a régua acima do composer NÃO some pós-clear (era o bug do Tiago em sessão fresca).
    expect(chromeDividers(frame)).toBe(4);
    expect(hasAdjacentChromeDividers(frame)).toBe(false);
    unmount();
  });

  it('com 2 turnos REAIS (você↔aluy) ⇒ 4 réguas de chrome (INALTERADO) + traço sutil por-turno', async () => {
    const controller = buildController('pronto.');
    const { lastFrame, unmount } = renderApp(controller);
    controller.dismissBoot();
    await controller.submit('faça'); // turno real 1 (you @ i=0 + aluy)
    await waitFor(() => controller.current.phase === 'done');
    await controller.submit('de novo'); // turno real 2 (you @ i>0 ⇒ traço sutil)
    await waitFor(() => controller.current.phase === 'done');
    await flush();

    const frame = lastFrame() ?? '';
    expect(controller.current.blocks.some((b) => b.kind === 'you' || b.kind === 'aluy')).toBe(true);
    // com turnos ⇒ 4 réguas de chrome (IGUAL ao vazio: a moldura é estável).
    expect(chromeDividers(frame)).toBe(4);
    // o traço SUTIL por-turno (antes do 2º `you`) NÃO regrediu.
    expect(subtleDividers(frame)).toBeGreaterThanOrEqual(1);
    unmount();
  });
});
