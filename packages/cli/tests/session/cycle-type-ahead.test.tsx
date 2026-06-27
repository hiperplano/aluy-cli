// EST-0981 · CLI-SEC-14 — a FILA do type-ahead × `/cycle` (guarda anti-colisão).
// O furo: ao auto-submitar, a fila podia disparar NO VÃO entre ciclos (quando a fase
// repousa por um instante) — criando um turno CONCORRENTE ao ciclo (gasto dobrado,
// blocos intercalados). Agora a fila é SEGURADA enquanto `state.cycleActive` (via
// `queueAtRest`) e re-tenta quando o ciclo TERMINA de verdade (fim/abort).
//
// FRUGAL: App real (Ink testing) + modelo MOCK gated — nenhuma chamada real.

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

/**
 * Sessão TUI com modelo GATED (cada chamada do modelo só termina quando o gate
 * correspondente resolve) — controla deterministicamente o fim de cada ciclo/turno.
 * Cada chamada vira `streaming` (sink.onStart) e devolve uma resposta final.
 */
function buildSession() {
  const gates = [defer(), defer(), defer(), defer(), defer()];
  let gateIdx = 0;
  const calls: string[] = [];
  let controllerRef: SessionController | null = null;

  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      calls.push(args.idempotencyKey);
      const sink = controllerRef!.sink;
      sink.onStart?.();
      sink.onDelta('trabalhando…');
      await gates[gateIdx++]!.promise;
      sink.onDone?.();
      return {
        request_id: 'r',
        content: 'trabalhando…',
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
      };
    },
  };

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
    calls,
    resolveGate: (i: number) => gates[i]!.resolve(),
    ...r,
  };
}

const CR = '\r';

describe('App — fila do type-ahead × /cycle (EST-0981 · CLI-SEC-14)', () => {
  it('TEXTO PURO durante o /cycle ⇒ ENCAIXA mid-turn (próxima iteração), NÃO espera o fim de TUDO', async () => {
    // EST-0982 (mid-turn fix) — o BUG do dono: com um /cycle vivo, uma observação de TEXTO
    // PURO ficava na fila e só era lida no FIM de TODOS os ciclos (`queueAtRest` segura por
    // `cycleActive`). Texto puro é CONTEXTO, não AÇÃO: agora ENCAIXA via `injectInput('root')`
    // (fila VIVA), drenada pelo loop na PRÓXIMA volta da catraca — entre ciclos, não no fim.
    const s = buildSession();
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    void s.controller.cycle('--max-iter 2 "tarefa em ciclo"');
    await waitFor(() => s.controller.current.phase === 'streaming');
    expect(s.controller.current.cycleActive).toBe(true);

    // Digita TEXTO PURO DURANTE o ciclo e dá Enter ⇒ ENCAIXA agora (não vira fila).
    await pressUntil(
      () => s.stdin.write('observacao no ciclo'),
      () => plain(s.lastFrame()).includes('observacao no ciclo'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'observacao no ciclo'),
    );

    // ENCAIXOU mid-turn (sem fila, sem novo submit, ciclo segue vivo). O loop drena a
    // injeção no topo da PRÓXIMA iteração (pollInjected) — não no fim de tudo.
    expect(injectSpy).toHaveBeenCalledWith('root', 'observacao no ciclo');
    expect(plain(s.lastFrame())).not.toContain('na fila');
    expect(submitSpy.mock.calls.some((c) => c[0] === 'observacao no ciclo')).toBe(false);
    expect(s.controller.current.cycleActive).toBe(true);

    // O ciclo termina suas iterações normalmente (a injeção não criou turno concorrente).
    s.resolveGate(0);
    await waitFor(() => s.calls.length === 2); // ciclo 2 chamou o modelo
    s.resolveGate(1);
    await waitFor(() => s.controller.current.cycleActive === false);

    injectSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  it('uma AÇÃO (`!bang`) durante o /cycle NÃO dispara no vão entre ciclos — segura até o FIM REAL', async () => {
    // O invariante anti-colisão (CLI-SEC-14) SEGUE valendo p/ AÇÕES (slash/bang): elas são
    // SUBMIT (próximo objetivo) e não podem rodar concorrentes ao ciclo. Só texto puro virou
    // mid-turn; uma AÇÃO enfileirada espera o ciclo TERMINAR de verdade.
    const s = buildSession();
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    void s.controller.cycle('--max-iter 2 "tarefa em ciclo"');
    await waitFor(() => s.controller.current.phase === 'streaming');
    expect(s.controller.current.cycleActive).toBe(true);

    // `!bang` DURANTE o ciclo ⇒ vai p/ a FILA (não interrompe o ciclo).
    await pressUntil(
      () => s.stdin.write('!echo depois'),
      () => plain(s.lastFrame()).includes('!echo depois'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));

    // Fim do CICLO 1 ⇒ VÃO entre ciclos ⇒ ciclo 2 começa. A fila SEGUROU.
    s.resolveGate(0);
    await waitFor(() => s.calls.length === 2);
    expect(bangSpy.mock.calls.some((c) => c[0] === 'echo depois')).toBe(false);
    expect(plain(s.lastFrame())).toContain('na fila');
    expect(s.controller.current.cycleActive).toBe(true);

    // Fim REAL do /cycle (teto de 2 iterações) ⇒ a flag limpa e a fila RE-TENTA.
    s.resolveGate(1);
    await waitFor(() => s.controller.current.cycleActive === false);
    await waitFor(() => bangSpy.mock.calls.some((c) => c[0] === 'echo depois'));

    bangSpy.mockRestore();
    s.unmount();
  });

  it('esc com fila vazia interrompe (freio intacto); esc com fila NÃO-vazia ENFILEIRA (F57)', async () => {
    const s = buildSession();
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    // Cenário 1: ESC com fila VAZIA → interrompe (comportamento original intacto).
    void s.controller.cycle('--max-iter 5 "tarefa em ciclo"');
    await waitFor(() => s.controller.current.phase === 'streaming');

    s.stdin.write(ESC);
    s.resolveGate(0);
    await waitFor(() => s.controller.current.cycleActive === false);
    expect(plain(s.lastFrame())).not.toContain('na fila');
    // Ciclo parou com ESC + fila vazia. ✓

    // Cenário 2: ESC com fila NÃO-VAZIA + input VAZIO → NÃO interrompe (F57).
    void s.controller.cycle('--max-iter 5 "tarefa em ciclo 2"');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('!echo item na fila'),
      () => plain(s.lastFrame()).includes('!echo item na fila'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));

    // ESC simples com fila NÃO-vazia + input vazio = no-op (NÃO interrompe, F57).
    s.stdin.write(ESC);
    await new Promise((r) => setTimeout(r, 80));
    // Ciclo CONTINUA ativo (ESC não interrompeu).
    expect(s.controller.current.cycleActive).toBe(true);
    expect(plain(s.lastFrame())).toContain('na fila');

    // Cenário 3: Duplo-ESC (2º ESC em <500ms) → INTERROMPE + DESCARTA fila.
    s.stdin.write(ESC);
    s.resolveGate(1);
    await waitFor(() => s.controller.current.cycleActive === false);
    await waitFor(() => !plain(s.lastFrame()).includes('na fila'));
    await new Promise((r) => setTimeout(r, 40));
    expect(bangSpy.mock.calls.some((c) => c[0] === 'item na fila')).toBe(false);

    bangSpy.mockRestore();
    s.unmount();
  });
});
