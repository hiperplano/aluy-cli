// EST-0985 (polish) — a MOLDURA do composer é INCONDICIONAL: emoldura o composer
// SEMPRE (na época, régua acima + régua abaixo; hoje a barra `┃` — ver a nota de
// desenho abaixo), inclusive em sessão FRESCA e pós-`/clear` (sem turnos). Antes (EST-0987) ela COLAPSAVA quando a conversa
// estava vazia — herança do layout ANTIGO, em que a "sob o header" e a "acima do
// input" ficavam coladas. Hoje o header vive no <Static> no TOPO e o composer no
// rodapé da região viva, SEMPRE separados pelo corpo (Onboarding/histórico) — as
// duas nunca encostam. O gate só DESMOLDURAVA o composer numa sessão nova (sumia a
// de cima, ficava a de baixo). Bug reportado pelo Tiago ("a linha de cima do
// composer sumiu"). Este arquivo trava a moldura SIMÉTRICA e o NÃO-colapso.
//
// ─────────────────────────────────────────────────────────────────────────────────
// O QUE MUDOU NO DESENHO (reforma de UI pedida pelo dono) — a INTENÇÃO deste arquivo
// é a mesma; o que ele MEDE trocou junto com o desenho:
//
//   • F-SEM-REGUA ("as linhas no CLI deixam uma cara muito ruim… em vez de linhas
//     separando as seções, alguma outra coisa") — o `<Divider>` não desenha mais nada:
//     devolve uma linha VAZIA, preservando a ALTURA (o cockpit soma altura de região p/
//     fechar o grid sem tremer, ADR-0076 §5). Contar réguas viraria contar um desenho
//     que o dono mandou tirar.
//   • F-COMPOSER-CAIXA ("não sei se daria para deixar o composer com cara de uma caixa
//     de texto") — as DUAS réguas que cercavam o input viraram a MOLDURA do
//     `<ComposerBox>`: a barra `┃` (borderLeft do Ink) que abre a linha do input.
//
// Então o NÃO-COLAPSO — que é o bug do Tiago que este arquivo trava ("a linha de cima do
// composer sumiu" em sessão fresca) — passa a ser medido na MOLDURA de hoje: a barra `┃`
// abrindo a linha do prompt, presente em TODOS os estados:
//   idle / só-sistema ⇒ composer emoldurado, zero réguas
//   pós-`/clear`      ⇒ composer emoldurado, zero réguas
//   1+ turno real     ⇒ composer emoldurado, zero réguas (só entra o respiro por-turno)

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
} from '@hiperplano/aluy-cli-core';
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

// Remove sequências ANSI (cor/papel) — o frame de teste vem colorido.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
/** Linhas do frame, em texto puro. */
function rows(frame: string): string[] {
  return frame.split('\n').map((l) => l.replace(ANSI, ''));
}
/** RÉGUAS de largura total — o desenho ANTIGO. F-SEM-REGUA: hoje tem de ser ZERO. */
function chromeRules(frame: string): number {
  return rows(frame).filter((l) => /^[━─-]{20,}$/.test(l.trim())).length;
}
/** Traços SUTIS por-turno — também saíram (o respiro virou espaço). */
function subtleRules(frame: string): number {
  return rows(frame).filter((l) => /^[━─-]{4,16}$/.test(l.trim())).length;
}
/** A MOLDURA do composer HOJE: a barra `┃` do <ComposerBox> abrindo a linha do prompt
 * (`❯` em unicode, `>` em ASCII). É ela que não pode COLAPSAR em sessão fresca. */
function composerFramed(frame: string): boolean {
  return rows(frame).some((l) => /^[┃|]\s*[❯>]/.test(l));
}
/** Índice da linha do composer (a do prompt emoldurado). */
function composerRow(frame: string): number {
  return rows(frame).findIndex((l) => /^[┃|]\s*[❯>]/.test(l));
}
/** Índice da ÚLTIMA linha do bloco do header (a linha da marca). */
function headerRow(frame: string): number {
  return rows(frame).findIndex((l) => /Λluy Cli|Aluy Cli/.test(l));
}
/** O chrome do header e a moldura do composer NÃO se encostam (era a "régua dupla"):
 * entre os dois há o CORPO (Onboarding/histórico) — pelo menos uma linha de folga. */
function chromeColado(frame: string): boolean {
  const h = headerRow(frame);
  const c = composerRow(frame);
  if (h < 0 || c < 0) return false;
  return c - h <= 1;
}

/** Quantas linhas VAZIAS contíguas existem imediatamente ACIMA de `i`. */
function blankRunAbove(rs: readonly string[], i: number): number {
  let n = 0;
  while (i - 1 - n >= 0 && rs[i - 1 - n]!.trim() === '') n += 1;
  return n;
}

function renderApp(controller: SessionController) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
}

describe('App — a moldura do composer NÃO colapsa em sessão vazia (EST-0985)', () => {
  it('idle (sessão fresca) ⇒ composer EMOLDURADO pela barra `┃`, e nenhuma régua', async () => {
    const controller = buildController('irrelevante');
    const { lastFrame, unmount } = renderApp(controller);
    controller.dismissBoot(); // boot → idle (Onboarding no corpo)
    await waitFor(() => controller.current.phase === 'idle');
    await flush();

    expect(controller.current.blocks).toHaveLength(0);
    const frame = lastFrame() ?? '';
    // A moldura do composer NÃO some em sessão fresca (era o bug do Tiago) — hoje ela é
    // a barra `┃` do <ComposerBox>, não mais duas réguas.
    expect(composerFramed(frame)).toBe(true);
    expect(chromeRules(frame)).toBe(0); // F-SEM-REGUA: o chrome não risca mais a tela
    expect(subtleRules(frame)).toBe(0); // sem histórico ⇒ sem respiro por-turno
    // e o chrome do header não encosta na moldura do composer (era a "régua dupla"):
    // o corpo fica entre os dois.
    expect(chromeColado(frame)).toBe(false);
    unmount();
  });

  it('estado só com bloco de SISTEMA (note de /help) ⇒ moldura do composer INTACTA', async () => {
    const controller = buildController('irrelevante');
    const { lastFrame, unmount } = renderApp(controller);
    controller.dismissBoot();
    await waitFor(() => controller.current.phase === 'idle');
    // bloco NÃO-conversa (saída de slash-command): não é diálogo você↔aluy.
    controller.pushNote('help', ['linha de ajuda']);
    await flush();

    expect(controller.current.blocks.every((b) => b.kind === 'note')).toBe(true);
    // a moldura do composer não depende de turno real ⇒ segue lá, sem colar no header.
    expect(composerFramed(lastFrame() ?? '')).toBe(true);
    expect(chromeRules(lastFrame() ?? '')).toBe(0);
    expect(chromeColado(lastFrame() ?? '')).toBe(false);
    unmount();
  });

  it('pós-`/clear` (volta a 0 turnos) ⇒ a moldura do composer VOLTA inteira, sem colar', async () => {
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
    // a moldura do composer NÃO some pós-clear (era o bug do Tiago em sessão fresca).
    expect(composerFramed(frame)).toBe(true);
    expect(chromeRules(frame)).toBe(0);
    expect(chromeColado(frame)).toBe(false);
    unmount();
  });

  it('com 2 turnos REAIS (você↔aluy) ⇒ moldura INALTERADA + respiro por-turno', async () => {
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
    // com turnos ⇒ moldura do composer IGUAL à do vazio (ela é estável).
    expect(composerFramed(frame)).toBe(true);
    expect(chromeRules(frame)).toBe(0);
    // o RESPIRO por-turno (antes do 2º `you`) NÃO regrediu — mudou de traço p/ espaço:
    // "a separação de turno já é dada pelo próprio rótulo e pelo espaço; um traço solto
    // no meio da conversa é ruído com aparência de conteúdo" (decisão do dono).
    const rs = rows(frame);
    const yous = rs.map((l, i) => (/^▌ você$/.test(l.trimEnd()) ? i : -1)).filter((i) => i >= 0);
    expect(yous).toHaveLength(2);
    expect(blankRunAbove(rs, yous[1]!)).toBeGreaterThan(blankRunAbove(rs, yous[0]!));
    expect(subtleRules(frame)).toBe(0);
    unmount();
  });
});
