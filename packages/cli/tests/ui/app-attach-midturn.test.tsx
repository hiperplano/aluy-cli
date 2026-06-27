// EST-0982 (P1-3) — `@anexo` digitado DURANTE o trabalho não pode virar TEXTO MORTO.
//
// Bug (auditoria do type-ahead): o ramo de TRABALHO (thinking/streaming/retrying) do
// composer NÃO chama `syncPicker` (só o idle), então digitar `@src/auth.ts` enquanto o
// agente trabalha NÃO abre o FilePicker nem cria chip — a linha ENFILEIRA com o `@`
// LITERAL. Ao DRENAR a fila no repouso, a linha caía como `goal` cru com o `@` inútil:
// o usuário PENSA que anexou; anexou texto morto.
//
// FIX (menor blast-radius): o `submit` (via comum do idle E do dreno) RESOLVE as
// menções `@path` LITERAIS que sobraram no texto pelo MESMO `AttachReader` confinado/
// path-deny do fallback não-TTY (`resolveLinearMentions`) — o anexo vira DADO rotulado
// (observation `[arquivo: …]`) e o `@` é REMOVIDO do objetivo. Prova de PONTA: App +
// Ink + controller REAL; digitar `@` mid-turn ⇒ ao drenar, o reader é chamado com o
// path e o conteúdo entra como mensagem `user` rotulada (não o `@` cru).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  attachmentObservation,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type SearchPort,
  type ShellPort,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { AttachReader } from '../../src/attach/index.js';
import type { AttachResult } from '../../src/attach/reader.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

const ATTACH_MARKER = 'CONTEUDO_DO_ARQUIVO_ANEXADO_42';

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

/**
 * Caller controlável: o 1º `call` BLOQUEIA (mantém o controller em fase de TRABALHO
 * enquanto digitamos mid-turn) até `release()`; os seguintes retornam na hora. Registra
 * o TEXTO de todas as `messages` de cada chamada (p/ provar o que o modelo viu).
 */
function controllableCaller() {
  const seen: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const caller: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      seen.push(args.messages.map((m) => (typeof m.content === 'string' ? m.content : '')));
      calls += 1;
      if (calls === 1) await gate;
      return { request_id: `r${calls}`, content: 'pronto', finish_reason: 'stop' };
    },
  };
  return { caller, seen, release: () => release() };
}

/** Reader FAKE: registra os paths pedidos e devolve um anexo OK com marcador único. */
function recordingReader() {
  const asked: string[] = [];
  const reader = {
    async attach(path: string): Promise<AttachResult> {
      asked.push(path);
      return {
        kind: 'ok',
        path,
        item: attachmentObservation(path, ATTACH_MARKER),
        truncated: false,
      };
    },
  } as unknown as AttachReader;
  return { reader, asked };
}

function buildController(caller: ModelCaller): SessionController {
  return new SessionController({
    model: caller,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderApp(controller: SessionController, reader: AttachReader) {
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App controller={controller} animate={false} bootMs={0} attachReader={reader} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return r;
}

describe('App — `@anexo` mid-turn não vira texto morto (EST-0982 P1-3)', () => {
  it('digitar `@src/auth.ts` durante o trabalho ⇒ ao drenar, o anexo é RESOLVIDO (DADO rotulado, não `@` cru)', async () => {
    const { caller, seen, release } = controllableCaller();
    const { reader, asked } = recordingReader();
    const controller = buildController(caller);
    const { stdin, unmount } = renderApp(controller, reader);

    // 1) dispara o turno inicial — o caller BLOQUEIA ⇒ controller fica em TRABALHO.
    void controller.submit('faz a parte 1');
    await waitFor(() => seen.length === 1);
    await waitFor(
      () => controller.current.phase === 'thinking' || controller.current.phase === 'streaming',
    );

    // 2) MID-TURN: digita `@src/auth.ts olha isto` e Enter ⇒ ENFILEIRA (type-ahead).
    //    O `@` NÃO foi resolvido por picker aqui (o ramo de trabalho não tem syncPicker).
    stdin.write('@src/auth.ts olha isto');
    await tick();
    stdin.write('\r');
    await tick();

    // 3) libera o 1º turno ⇒ controller repousa ⇒ a fila DRENA ⇒ `submit` da linha `@…`.
    release();

    // 4) o reader foi chamado com o PATH (o `@` virou anexo de verdade) e o 2º turno do
    //    modelo VIU o conteúdo rotulado — não o `@` cru.
    await waitFor(() => asked.includes('src/auth.ts'));
    await waitFor(() => seen.length === 2);

    const secondCallMsgs = seen[1]!.join('\n');
    // O DADO rotulado chegou ao modelo (observation `[arquivo: …]` + conteúdo).
    expect(secondCallMsgs).toContain('[arquivo: src/auth.ts]');
    expect(secondCallMsgs).toContain(ATTACH_MARKER);
    // O objetivo NÃO carrega mais o `@path` LITERAL (foi resolvido + stripado), só a intenção.
    expect(secondCallMsgs).toContain('olha isto');
    expect(secondCallMsgs).not.toContain('@src/auth.ts');

    unmount();
  });

  it('SEM o fix, `@` mid-turn seria TEXTO MORTO — o reader é a prova: chamado 1× com o path', async () => {
    const { caller, seen, release } = controllableCaller();
    const { reader, asked } = recordingReader();
    const controller = buildController(caller);
    const { stdin, unmount } = renderApp(controller, reader);

    void controller.submit('parte 1');
    await waitFor(() => seen.length === 1);

    stdin.write('@docs/readme.md');
    await tick();
    stdin.write('\r');
    await tick();
    release();

    // O reader RESOLVE o anexo (path exato) — sem o fix, o `@` jamais tocaria o reader.
    await waitFor(() => asked.includes('docs/readme.md'));
    expect(asked).toEqual(['docs/readme.md']);

    unmount();
  });
});
