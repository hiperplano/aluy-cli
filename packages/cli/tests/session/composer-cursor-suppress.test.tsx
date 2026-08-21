// EST-0965 — UM CURSOR SÓ NA TELA. Enquanto o agente TRABALHA (streaming), o
// <AluyBlock> pinta o cursor AMARELO de trabalho (●) na ponta do stream; nesse
// intervalo o ● BRANCO do COMPOSER fica OFF — nunca os DOIS ao mesmo tempo (o "3
// cursores" do #118 não pode voltar por este caminho). Composer e trabalho usam o MESMO
// ● grosso (mesma grossura); a COR (branco vs amarelo) e a REGIÃO separam os papéis.
// TYPE-AHEAD: assim que o usuário
// começa a digitar (`input !== ''`), o cursor do composer VOLTA (você precisa ver onde
// edita a fila). Idle ⇒ o composer manda no cursor normalmente.
//
// FRUGAL (DoD, sem modelo real): o `gatedStreamingCaller` deixa a sessão VIVA em
// `streaming` por um gate e dirigimos o stdin. App montada com `animate` LIGADO (com
// `animate=false` o composer já não mostra cursor por outro motivo — não provaria nada).

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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return (s ?? '').replace(ANSI, '');
}
// EST-0965 — composer e trabalho usam o MESMO ● (mesma grossura); o que os separa é a
// COR (composer branco/fg, trabalho amarelo/accent) e a REGIÃO (composer no `›` do
// rodapé; trabalho na fala viva do aluy). As asserções abaixo escopam por região, então
// continuam provando "um cursor só" mesmo com o glifo igual.
const COMPOSER_CURSOR = '●'; // o ● grosso do <Composer> (branco/fg), no rodapé `›`
const WORK_CURSOR = '●'; // o ● grosso/arredondado de trabalho do <AluyBlock> (amarelo)

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

/** ModelCaller que entra em STREAMING e fica vivo até o gate resolver. */
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
  const gates = [defer(), defer()];
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
      {/* animate LIGADO: queremos que o composer MOSTRARIA o cursor se não fosse
          suprimido — é o que torna a supressão observável. */}
      <App controller={controller} animate={true} bootMs={0} />
    </ThemeProvider>,
  );
  return { controller, resolveGate: (i: number) => gates[i]!.resolve(), ...r };
}

// F-COMPOSER-CAIXA / F-BLOCOS-PINTADOS (reforma de UI pedida pelo dono) — tanto o
// composer quanto os blocos de fala viraram CAIXAS: o Ink desenha a barra `┃`
// (borderLeft) no início de TODA linha do bloco. Descascar a moldura é o que devolve
// aos helpers abaixo o mesmo alcance que `trimStart()` tinha antes.
function unframe(line: string): string {
  return line.replace(/^[\s┃│|]+/, '');
}

// A última linha que começa com o prompt é o COMPOSER (o input fica no rodapé). Devolve o
// texto digitado (ou '' no placeholder).
// F-COMPOSER-CAIXA — o prompt passou de `›` para `❯` e ganhou a barra `┃` na frente.
function composerLine(s: { lastFrame: () => string | undefined }): string {
  const rows = plain(s.lastFrame() ?? '')
    .split('\n')
    .filter((l) => unframe(l).startsWith('❯'));
  const row = rows[rows.length - 1] ?? '';
  return row;
}

async function ensureListener(s: {
  stdin: { write: (x: string) => void };
  lastFrame: () => string | undefined;
}) {
  await pressUntil(
    () => s.stdin.write('~'),
    () => composerLine(s).includes('~'),
  );
  s.stdin.write(String.fromCharCode(127)); // backspace
  await waitFor(() => !composerLine(s).includes('~'));
  await new Promise((r) => setTimeout(r, 20));
}

async function tap(s: { stdin: { write: (x: string) => void } }, seq: string) {
  s.stdin.write(seq);
  await new Promise((r) => setTimeout(r, 30));
}

// O `●` é reusado noutros pontos da tela — então uma busca frame-wide por `●` é
// confundida. Esta helper isola a REGIÃO DE FALA viva do aluy (linhas DEPOIS do rótulo
// do bloco do agente, até o composer) onde o cursor de trabalho mora. Assim provamos a
// PRESENÇA/AUSÊNCIA do ● de trabalho sem o ruído do resto do chrome.
//
// O que mudou no desenho (pedido do dono) e por quê a busca mudou junto:
//   • o rótulo do bloco do agente deixou de ser `Λ aluy` (marca + palavra ao lado) e
//     passou a ser a ASSINATURA `Λluy` — "a marca é a primeira letra do nome, não um
//     ícone ao lado dele". Logo o `/ aluy$/` de antes não casa mais com nada;
//   • o bloco ganhou moldura: a barra `┃` abre TODA linha dele (daí o `unframe`);
//   • a RÉGUA que fechava a região saiu ("as linhas no CLI deixam uma cara muito ruim"):
//     o <Divider> devolve linha VAZIA. O fim da região passa a ser a linha do COMPOSER
//     (hoje `❯`), que é o que a régua marcava na prática.
function aluySpeechRegion(s: { lastFrame: () => string | undefined }): string {
  const lines = plain(s.lastFrame() ?? '').split('\n');
  // `Λluy` (unicode) ou `/\luy` (fallback ASCII) — a assinatura do bloco do agente.
  const start = lines.findIndex((l) => /^(?:Λ|\/\\)luy\b/.test(unframe(l)));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => unframe(l).startsWith('❯'));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

describe('App — UM CURSOR SÓ: composer ▏ suprimido durante o trabalho (EST-0965)', () => {
  it('STREAMING + composer vazio ⇒ mostra o ● de trabalho e NÃO o ▏ do composer', async () => {
    const s = buildSession();
    void s.controller.submit('objetivo');
    await waitFor(() => s.controller.current.phase === 'streaming');
    // o cursor de trabalho ● aparece NA REGIÃO DE FALA (pisca calmo: espera um frame aceso).
    await waitFor(() => aluySpeechRegion(s).includes(WORK_CURSOR));
    expect(aluySpeechRegion(s)).toContain(WORK_CURSOR);
    // … e a barra do composer está SUPRIMIDA — só UM cursor na tela.
    expect(composerLine(s)).not.toContain(COMPOSER_CURSOR);
    s.resolveGate(0);
    s.unmount();
  });

  it('TYPE-AHEAD: ao digitar durante o trabalho, o ▏ do composer VOLTA', async () => {
    const s = buildSession();
    void s.controller.submit('objetivo');
    await waitFor(() => s.controller.current.phase === 'streaming');
    await ensureListener(s);
    // digita uma letra (entra na fila do type-ahead) ⇒ `input !== ''` ⇒ cursor volta.
    await tap(s, 'x');
    await waitFor(() => composerLine(s).includes('x'));
    await waitFor(() => composerLine(s).includes(COMPOSER_CURSOR));
    // o composer agora tem o seu cursor (você vê onde edita), seguindo o texto.
    expect(composerLine(s)).toContain('x' + COMPOSER_CURSOR);
    s.resolveGate(0);
    s.unmount();
  });

  it('IDLE (fim do turno) ⇒ o composer volta a mostrar o ▏ normalmente', async () => {
    const s = buildSession();
    void s.controller.submit('objetivo');
    await waitFor(() => s.controller.current.phase === 'streaming');
    // termina o turno: gate resolve ⇒ done/idle.
    s.resolveGate(0);
    await waitFor(
      () => s.controller.current.phase === 'done' || s.controller.current.phase === 'idle',
    );
    // composer vazio e ativo ⇒ cursor no índice 0 (placeholder fantasma atrás).
    await waitFor(() => composerLine(s).includes(COMPOSER_CURSOR));
    expect(composerLine(s)).toContain(COMPOSER_CURSOR);
    // e o ● de trabalho NÃO está mais na fala (o turno desceu p/ o Static, sem cursor
    // vivo) — escopado na região de fala p/ não confundir com o `● broker` do header.
    expect(aluySpeechRegion(s)).not.toContain(WORK_CURSOR);
    s.unmount();
  });
});
