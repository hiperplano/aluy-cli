// EST-0982 (type-ahead) — DIGITAR ENQUANTO O AGENTE TRABALHA, sem interromper.
//
// O problema (antes): o composer ficava DESABILITADO durante `thinking`/`streaming`/
// `retrying` — pra interagir você TINHA que dar `esc` (interromper). Agora o composer
// fica ATIVO durante o trabalho:
//   • Enter        → ENFILEIRA a linha (type-ahead). Ao TERMINAR o turno, a 1ª da fila
//                    é AUTO-SUBMETIDA como próximo objetivo (FIFO). Mostra as pendentes.
//   • Ctrl+Enter   → ENCAIXAR: injeta AGORA no agente vivo (`injectInput`, controle).
//                    (Detecção robusta entre terminais: `key.return && key.ctrl` OU um
//                    LF cru `\n` chegando como char — Ctrl+J / Ctrl+Enter de muitos terms.)
//   • esc / Ctrl-C → ainda INTERROMPEM (cancelam o trabalho) — mas não são mais o único
//                    jeito de digitar.
//   • `ask`/`budget` → o composer NÃO captura (a DECISÃO acima tem o foco).
//
// Cobertura do DoD: digitar+Enter durante `streaming` (mock) ⇒ entra na FILA (pendente
// visível) e NÃO interrompe; ao virar `done` ⇒ a fila AUTO-SUBMETE como próximo objetivo.
// Ctrl+Enter ⇒ chama `injectInput`. Em `asking` ⇒ o composer não captura. esc interrompe.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type AskRequest,
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
import type { SlashCommand } from '../../src/slash/commands.js';

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

/** Promessa adiável (defer) — controla quando o turno do modelo TERMINA. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Um `ModelCaller` que coloca a sessão em STREAMING e fica VIVO até o `gate` resolver.
 * Ao ser chamado: dispara `sink.onStart()` (a fase vira `streaming`, abre o turno do
 * aluy) e então AGUARDA o gate — simulando o agente "trabalhando". Quando o gate
 * resolve, fecha o turno (`onDone`) e devolve um resultado final (a fase vira `done`).
 * O `onCall` reporta cada chamada (p/ contar as auto-submissões da fila).
 */
function gatedStreamingCaller(opts: {
  sink: () => SessionController['sink'];
  nextGate: () => Promise<void>;
  onCall: (goalMessages: number) => void;
}): ModelCaller {
  return {
    async call(args): Promise<ModelCallResult> {
      opts.onCall(args.messages.length);
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

/** Reescreve um chunk até o efeito assentar (mesma razão de batch-enter.test.tsx). */
async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buildSession(opts: { onCommand?: (command: SlashCommand, args: string) => void } = {}) {
  // Fila de gates: cada turno do modelo consome o próximo gate. Pré-criamos alguns.
  const gates = [defer(), defer(), defer(), defer()];
  let gateIdx = 0;
  const callMessages: number[] = [];
  let controllerRef: SessionController | null = null;

  const model = gatedStreamingCaller({
    sink: () => controllerRef!.sink,
    nextGate: () => gates[gateIdx++]!.promise,
    onCall: (n) => callMessages.push(n),
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
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts.onCommand ? { onCommand: opts.onCommand } : {})}
      />
    </ThemeProvider>,
  );
  return {
    controller,
    callMessages,
    resolveGate: (i: number) => gates[i]!.resolve(),
    ...r,
  };
}

const CR = '\r'; // Enter limpo (queue)
const LF = '\n'; // LF cru (Ctrl+J / Ctrl+Enter de muitos terminais) → ENCAIXAR

describe('App — TYPE-AHEAD: digitar enquanto o agente trabalha (EST-0982)', () => {
  it('durante STREAMING, TEXTO PURO + Enter ⇒ ENCAIXA mid-turn (injectInput, sem fila) e NÃO interrompe', async () => {
    // EST-0982 (mid-turn fix) — o dono digita uma observação de TEXTO PURO enquanto o
    // agente trabalha e dá Enter limpo. ANTES isso ia p/ a fila e só era lido no FIM. Agora
    // é CONTEXTO do MESMO turno: ENCAIXA via `injectInput('root', …)` (fila VIVA, drenada
    // pelo loop na PRÓXIMA iteração). NÃO vira "na fila", NÃO interrompe, NÃO submete turno.
    const s = buildSession();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('minha proxima ideia'),
      () => plain(s.lastFrame()).includes('minha proxima ideia'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'minha proxima ideia'),
    );

    // ENCAIXOU mid-turn (não enfileirou): injectInput('root', texto) foi chamado, NÃO há
    // chrome "na fila", o trabalho NÃO foi interrompido e NÃO houve um novo `submit`.
    expect(injectSpy).toHaveBeenCalledWith('root', 'minha proxima ideia');
    expect(plain(s.lastFrame())).not.toContain('na fila');
    expect(s.controller.current.phase).toBe('streaming');
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(submitSpy.mock.calls.some((c) => c[0] === 'minha proxima ideia')).toBe(false);

    s.resolveGate(0);
    interruptSpy.mockRestore();
    injectSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  it('durante STREAMING, um `!bang` (AÇÃO) + Enter ⇒ ENFILEIRA (pendente visível) e NÃO encaixa', async () => {
    // Linha que NÃO é texto puro (aqui um `!bang`) é AÇÃO/comando: precisa do submit/route.
    // Segue o caminho ANTIGO da fila — NÃO injeta como contexto mid-turn.
    const s = buildSession();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const injectSpy = vi.spyOn(s.controller, 'injectInput');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('!echo ola'),
      () => plain(s.lastFrame()).includes('!echo ola'),
    );
    s.stdin.write(CR);

    await waitFor(() => plain(s.lastFrame()).includes('na fila'));
    expect(plain(s.lastFrame())).toContain('!echo ola');
    expect(injectSpy).not.toHaveBeenCalled();
    expect(s.controller.current.phase).toBe('streaming');
    expect(interruptSpy).not.toHaveBeenCalled();

    s.resolveGate(0);
    interruptSpy.mockRestore();
    injectSpy.mockRestore();
    s.unmount();
  });

  it('ao TERMINAR o turno (vira done), a FILA de AÇÃO (`!bang`) AUTO-SUBMETE no repouso', async () => {
    // A fila agora guarda AÇÕES (slash/bang/anexos). Prova que o auto-submit-em-repouso
    // segue intacto p/ elas: um `!bang` enfileirado durante o trabalho roda ao virar done.
    const s = buildSession();
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('!echo segundo'),
      () => plain(s.lastFrame()).includes('!echo segundo'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('na fila'));

    // Termina o 1º turno → o efeito de auto-submit consome a fila (roteia o `!bang`).
    s.resolveGate(0);
    await waitFor(() => bangSpy.mock.calls.some((c) => c[0] === 'echo segundo'));

    // A fila esvaziou (some o chrome).
    await waitFor(() => !plain(s.lastFrame()).includes('na fila'));
    expect(bangSpy.mock.calls.some((c) => c[0] === 'echo segundo')).toBe(true);

    bangSpy.mockRestore();
    s.unmount();
  });

  it('VÁRIAS AÇÕES na fila ⇒ auto-submetidas EM ORDEM (FIFO), uma por repouso', async () => {
    const s = buildSession();
    const bangSpy = vi.spyOn(s.controller, 'runBang').mockResolvedValue();

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Enfileira A, depois B (ambas AÇÕES — `!bang` — p/ ficarem na fila).
    await pressUntil(
      () => s.stdin.write('!echo A'),
      () => plain(s.lastFrame()).includes('!echo A'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('!echo A'));
    await pressUntil(
      () => s.stdin.write('!echo B'),
      () => plain(s.lastFrame()).includes('!echo B'),
    );
    s.stdin.write(CR);
    await waitFor(() => plain(s.lastFrame()).includes('2 na fila'));

    // 1º turno termina → A roda (B segue na fila). O `runBang` mockado volta a idle.
    s.resolveGate(0);
    await waitFor(() => bangSpy.mock.calls.some((c) => c[0] === 'echo A'));
    await waitFor(() => bangSpy.mock.calls.some((c) => c[0] === 'echo B'));

    // Ordem: A antes de B.
    const idxA = bangSpy.mock.calls.findIndex((c) => c[0] === 'echo A');
    const idxB = bangSpy.mock.calls.findIndex((c) => c[0] === 'echo B');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);

    bangSpy.mockRestore();
    s.unmount();
  });

  it('durante STREAMING, `/ask <pergunta>` + Enter ⇒ RODA JÁ (paralelo, via runCommand/onCommand) e NÃO enfileira — EST-0982 · ADR-0080', async () => {
    // BUG do dono (dogfood): o `/ask` (pergunta PARALELA read-only — ADR-0080) caía no
    // setQueue como qualquer `/slash` mid-turn e só era respondido AO FIM do turno, matando
    // o propósito dele. Agora ele é PARALELO-SEGURO (`parallelWhileBusy`): o handler de Enter-
    // OCUPADO o EXECUTA JÁ pelo MESMO caminho do idle (`runCommand` ⇒ `onCommand`, que no
    // wiring chama `controller.askParallel`). Prova: onCommand recebe o comando `ask` com o
    // argumento AGORA, mid-stream — e a linha NÃO vai p/ a fila ("na fila" ausente).
    const onCommand = vi.fn();
    const s = buildSession({ onCommand });
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('/ask qual o estado do build?'),
      () => plain(s.lastFrame()).includes('/ask qual o estado do build?'),
    );
    await pressUntil(
      () => s.stdin.write(CR),
      () => onCommand.mock.calls.some((c) => (c[0] as SlashCommand).id === 'ask'),
    );

    // RODOU JÁ (paralelo): onCommand foi chamado com o comando `ask` + o argumento. NÃO
    // enfileirou (sem chrome "na fila"), NÃO interrompeu, NÃO criou um novo submit/turno.
    const askCall = onCommand.mock.calls.find((c) => (c[0] as SlashCommand).id === 'ask');
    expect(askCall).toBeDefined();
    expect(askCall![1]).toBe('qual o estado do build?');
    expect(plain(s.lastFrame())).not.toContain('na fila');
    expect(s.controller.current.phase).toBe('streaming');
    expect(interruptSpy).not.toHaveBeenCalled();
    expect(submitSpy.mock.calls.some((c) => c[0] === 'qual o estado do build?')).toBe(false);

    s.resolveGate(0);
    interruptSpy.mockRestore();
    injectSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  it('durante STREAMING, `/compact` (MUTADOR) + Enter ⇒ AINDA ENFILEIRA (não roda mid-turn) — EST-0982', async () => {
    // Regressão-guard: SÓ o paralelo-seguro roda já. Um comando que MUTA estado/sessão
    // (`/compact`) NÃO é `parallelWhileBusy` ⇒ segue o caminho ANTIGO da fila (rodar mid-turn
    // quebraria o turno). onCommand NÃO é chamado agora; a linha aparece "na fila".
    const onCommand = vi.fn();
    const s = buildSession({ onCommand });

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('/compact'),
      () => plain(s.lastFrame()).includes('/compact'),
    );
    s.stdin.write(CR);

    await waitFor(() => plain(s.lastFrame()).includes('na fila'));
    expect(plain(s.lastFrame())).toContain('/compact');
    // NÃO rodou mid-turn: nenhum onCommand foi disparado AGORA (só será no repouso).
    expect(onCommand).not.toHaveBeenCalled();
    expect(s.controller.current.phase).toBe('streaming');

    s.resolveGate(0);
    s.unmount();
  });

  it('Ctrl+Enter (LF cru) ⇒ ENCAIXA AGORA (chama injectInput, NÃO enfileira)', async () => {
    const s = buildSession();
    const injectSpy = vi.spyOn(s.controller, 'injectInput');
    const submitSpy = vi.spyOn(s.controller, 'submit');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    // Digita e ENCAIXA com LF cru (Ctrl+J / Ctrl+Enter): injeta AGORA no agente vivo.
    await pressUntil(
      () => s.stdin.write('corrija o rumo'),
      () => plain(s.lastFrame()).includes('corrija o rumo'),
    );
    await pressUntil(
      () => s.stdin.write(LF),
      () => injectSpy.mock.calls.length > 0,
    );

    expect(injectSpy).toHaveBeenCalledWith('root', 'corrija o rumo');
    // NÃO virou fila (o composer limpou e não há chrome "na fila").
    expect(plain(s.lastFrame())).not.toContain('na fila');
    // E NÃO submeteu um NOVO objetivo: encaixar é injetar no turno corrente, não criar
    // outro (o único `submit` é o `objetivo inicial` que abriu o turno, não `corrija…`).
    expect(submitSpy.mock.calls.some((c) => c[0] === 'corrija o rumo')).toBe(false);
    expect(s.controller.current.phase).toBe('streaming');

    s.resolveGate(0);
    injectSpy.mockRestore();
    submitSpy.mockRestore();
    s.unmount();
  });

  it('esc DURANTE o trabalho ainda INTERROMPE (o freio segue valendo)', async () => {
    const s = buildSession();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write(ESC),
      () => interruptSpy.mock.calls.length > 0,
    );
    expect(interruptSpy).toHaveBeenCalled();

    interruptSpy.mockRestore();
    s.resolveGate(0);
    s.unmount();
  });

  it('ADR-0126(C) — ESC com TEXTO no composer ⇒ REDIRECIONA (injectInput) e NÃO interrompe', async () => {
    // O dono digitou uma msg e apertou ESC. ANTES: abortava + descartava. AGORA: ENCAIXA a
    // msg no agente vivo (prioriza) e NÃO aborta o turno — o agente a vê e decide o rumo.
    const s = buildSession();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const injectSpy = vi.spyOn(s.controller, 'injectInput');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('muda o rumo: foca no bug X'),
      () => plain(s.lastFrame()).includes('muda o rumo: foca no bug X'),
    );
    await pressUntil(
      () => s.stdin.write(ESC),
      () =>
        injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'muda o rumo: foca no bug X'),
    );

    expect(injectSpy).toHaveBeenCalledWith('root', 'muda o rumo: foca no bug X');
    expect(interruptSpy).not.toHaveBeenCalled(); // REDIRECIONOU, não abortou
    expect(s.controller.current.phase).toBe('streaming');

    s.resolveGate(0);
    interruptSpy.mockRestore();
    injectSpy.mockRestore();
    s.unmount();
  });

  it('ADR-0126(C) — ESC com `/ask <q>` ⇒ injeta SÓ a pergunta como msg real (prioriza)', async () => {
    const s = buildSession();
    const interruptSpy = vi.spyOn(s.controller, 'interrupt');
    const injectSpy = vi.spyOn(s.controller, 'injectInput');

    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');

    await pressUntil(
      () => s.stdin.write('/ask qual o status do deploy?'),
      () => plain(s.lastFrame()).includes('qual o status do deploy?'),
    );
    await pressUntil(
      () => s.stdin.write(ESC),
      () =>
        injectSpy.mock.calls.some((c) => c[0] === 'root' && c[1] === 'qual o status do deploy?'),
    );

    // o `/ask` foi descascado: o agente recebe a PERGUNTA como objetivo real, não o comando.
    expect(injectSpy).toHaveBeenCalledWith('root', 'qual o status do deploy?');
    expect(interruptSpy).not.toHaveBeenCalled();

    s.resolveGate(0);
    interruptSpy.mockRestore();
    injectSpy.mockRestore();
    s.unmount();
  });

  // A LINHA do composer é a que começa com o prompt `›` (sem o `…` de placeholder).
  // Extrai só o texto digitado, pra asserções precisas (sem colidir com o histórico
  // `go`/`w` ou o footer `esc interromper`).
  function composerLine(s: { lastFrame: () => string }): string {
    const row = plain(s.lastFrame())
      .split('\n')
      .find((l) => l.trimStart().startsWith('›'));
    const text = (row ?? '').replace(/^\s*›\s?/, '').trim();
    // Composer VAZIO mostra o placeholder dim — p/ as asserções de edição, vazio é ''.
    return text.startsWith('digite um objetivo') ? '' : text;
  }

  // Garante o listener de stdin do Ink JÁ attachado (só liga num efeito pós-1º-commit):
  // escreve um sentinela, espera ecoar, apaga. A partir daí cada write é entregue UMA
  // vez (sem reescrever ⇒ sem duplicar a edição) — padrão do composer-cursor-app.test.
  async function ensureListener(s: {
    stdin: { write: (x: string) => void };
    lastFrame: () => string;
  }) {
    await pressUntil(
      () => s.stdin.write('~'),
      () => composerLine(s) === '~',
    );
    s.stdin.write(String.fromCharCode(127));
    await waitFor(() => composerLine(s) !== '~'); // o `~` saiu (composer vazio → placeholder)
    await new Promise((r) => setTimeout(r, 20));
  }
  async function tap(s: { stdin: { write: (x: string) => void } }, seq: string) {
    s.stdin.write(seq);
    await new Promise((r) => setTimeout(r, 30));
  }

  it('BACKSPACE no type-ahead apaga (chunk MISTO texto+backspace) — EST-0965', async () => {
    // O bug medido no PTY: `XYZ`+backspace durante o trabalho ficava `XYZ` (o ramo de
    // digitação inseria o byte 0x7f literal). Agora o type-ahead roteia pela FONTE ÚNICA
    // `applyTypedChunk`, que honra o backspace EMBUTIDO. Prova: chunk grudado `XYZ\x7f\x7f`
    // ⇒ `X` (não `XYZ`); + backspace em tecla SEPARADA esvazia.
    const BS = String.fromCharCode(127);
    const s = buildSession();
    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');
    await ensureListener(s);

    // (a) chunk MISTO num único write: `XYZ` + 2 backspace ⇒ composer vira `X`.
    await tap(s, 'XYZ' + BS + BS);
    await waitFor(() => composerLine(s) === 'X');
    expect(composerLine(s)).toBe('X');

    // (b) backspace em tecla SEPARADA esvazia: `X` ⇒ ``.
    await tap(s, BS);
    await waitFor(() => composerLine(s) === '');
    expect(composerLine(s)).toBe('');

    s.resolveGate(0);
    s.unmount();
  });

  it('CURSOR no type-ahead: ← leva o caret p/ inserir no MEIO — EST-0965', async () => {
    // Edição posicional durante o trabalho usa a MESMA mecânica do composer idle
    // (composer-edit): digita `ac`, ← (caret antes do c), insere `b` ⇒ `abc`.
    const s = buildSession();
    void s.controller.submit('objetivo inicial');
    await waitFor(() => s.controller.current.phase === 'streaming');
    await ensureListener(s);

    await tap(s, 'a');
    await tap(s, 'c');
    await waitFor(() => composerLine(s) === 'ac');
    // ← move o caret 1 à esquerda (entre a e c); depois insere `b` no meio ⇒ `abc`.
    await tap(s, ESC + '[D'); // seta esquerda
    await tap(s, 'b');
    await waitFor(() => composerLine(s) === 'abc');
    expect(composerLine(s)).toBe('abc');

    s.resolveGate(0);
    s.unmount();
  });

  it('em ASKING o composer NÃO captura (a decisão tem o foco): Enter não enfileira', async () => {
    // Coloca a sessão em `asking` via o AskResolver (uma decisão pendente). O composer
    // fica dim e as teclas de decisão (a/s/n/esc) é que respondem — o type-ahead não
    // intercepta. Verificamos que um Enter ali NÃO cria fila.
    const resolver = new TuiAskResolver();
    const controller = new SessionController({
      model: {
        async call(): Promise<ModelCallResult> {
          return { request_id: 'r', content: '', finish_reason: 'stop' };
        },
      },
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: resolver,
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    controller.dismissBoot();
    const theme = resolveTheme({ env: ENV });
    const r = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );

    // Dispara uma pergunta da catraca → a fase vira `asking` (a UI mostra o diálogo).
    const askReq: AskRequest = {
      call: { name: 'run_command', input: { command: 'rm -rf build' } },
      effect: { kind: 'command', tool: 'run_command', exact: '$ rm -rf build' },
      category: 'always-ask:destructive',
      reason: 'comando destrutivo',
      alwaysAsk: true,
    };
    void resolver.resolve(askReq);
    await waitFor(() => controller.current.phase === 'asking');

    // Um Enter aqui é a tecla da DECISÃO (não o type-ahead): NÃO deve criar fila.
    r.stdin.write('texto ignorado');
    r.stdin.write(CR);
    await new Promise((res) => setTimeout(res, 50));
    expect(plain(r.lastFrame())).not.toContain('na fila');

    // Resolve a pergunta p/ não vazar timer.
    r.stdin.write('n');
    r.unmount();
  });
});
