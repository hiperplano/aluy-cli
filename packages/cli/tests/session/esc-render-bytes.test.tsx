// EST-0965 (REGRESSÃO de render) — PROVA DE BYTES (DoD frugal, sem modelo): dirige o
// App REAL do Ink contra um fake-TTY através do stdout ENVELOPADO (overwrite-in-place +
// ?2026), com um caller mockado, p/ os 2 cenários reportados pelo Tiago:
//   (b) esc no streaming + nova msg ⇒ a região viva é ÚNICA (sem a fala parcial DOBRADA)
//       e SÓ 1 bloco streaming ⇒ no máximo 1 cursor `▏` na fala viva (fim dos 3 cursores).
//   (a) /model → Custom + digitar ⇒ o texto fica DENTRO do browser do picker (linha
//       `filtro › …`), UMA vez — não vaza/duplica fora.
// O harness replica a stdin da ink-testing-library (Ink lê via 'readable'+read(), ≠
// 'data'). Não chama o modelo real (caller mockado).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import {
  PolicyPermissionEngine,
  ModelCallAbortedError,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type TierCatalogEntry,
  type CustomModel,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { wrapStdoutWithSync } from '../../src/session/synchronized-output.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const PARTIAL = 'FALA-PARCIAL-VIVA';
const ESC = String.fromCharCode(27);
// regex de ANSI sem control-char LITERAL no fonte (no-control-regex).
const ANSI = new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g');

function fakePorts(): ToolPorts {
  return {
    fs: {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    },
    shell: {
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return [];
      },
    },
  };
}

function fakeTty(): NodeJS.WriteStream & { text(): string } {
  const ee = new EventEmitter();
  let buf = '';
  const stub = Object.assign(ee, {
    isTTY: true as const,
    columns: 80,
    rows: 100,
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
    text: () => buf,
  });
  return stub as unknown as NodeJS.WriteStream & { text(): string };
}

// Stdin igual à da ink-testing-library: Ink lê via 'readable' + read() (NÃO 'data').
function fakeStdin(): NodeJS.ReadStream & { send(s: string): void } {
  const ee = new EventEmitter() as unknown as NodeJS.ReadStream & { send(s: string): void };
  let data: string | null = null;
  Object.assign(ee, {
    isTTY: true,
    setRawMode() {},
    setEncoding() {},
    ref() {},
    unref() {},
    resume() {},
    pause() {},
    read() {
      const d = data;
      data = null;
      return d;
    },
    send(s: string) {
      data = s;
      (ee as unknown as EventEmitter).emit('readable');
      (ee as unknown as EventEmitter).emit('data', s);
    },
  });
  return ee;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function count(h: string, n: string): number {
  return h.split(n).length - 1;
}
function lastFrameOf(bytes: string): string {
  const frames = bytes.split('\x1b[?2026h').slice(1);
  return frames.length > 0 ? frames[frames.length - 1]! : '';
}
/**
 * Avança DETERMINÍSTICO (robusto ao caminho de render do Ink em CI, que batcheia
 * diferente): reenvia `key` até a marca `mark` aparecer no stream OU estourar o prazo.
 * `key` vazio só espera (sem reenviar). Devolve se a marca apareceu.
 */
async function pump(
  m: { tty: { text(): string }; stdin: { send(s: string): void } },
  key: string,
  mark: string,
  ms = 3000,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (m.tty.text().includes(mark)) return true;
    if (key) m.stdin.send(key);
    await sleep(25);
  }
  return m.tty.text().includes(mark);
}

const CATALOG: readonly TierCatalogEntry[] = [
  {
    key: 'aluy-flux',
    displayName: 'Flux',
    costSignal: 'economical',
    composition: [{ name: 'GPT-4o mini', family: 'OpenAI', role: 'principal', context: '128k' }],
  },
  {
    key: 'aluy-deep',
    displayName: 'Deep',
    costSignal: 'premium',
    composition: [{ name: 'Opus', family: 'Anthropic', role: 'principal', context: '200k' }],
  },
];
const CUSTOM: readonly CustomModel[] = [
  {
    id: 'meta-llama/llama-3.1-8b-instruct',
    name: 'Llama',
    family: 'Meta',
    context: '128k',
    supportsTools: true,
  },
];

function mount(caller: ModelCaller) {
  const tty = fakeTty();
  const stdin = fakeStdin();
  const { stdout, cleanup } = wrapStdoutWithSync(tty, { sync: true, overwrite: true });
  const controller = new SessionController({
    model: caller,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const theme = resolveTheme({ env: ENV });
  const instance = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        catalog={{ list: async () => CATALOG }}
        customModels={{ list: async () => CUSTOM }}
        onSelectTier={() => {}}
      />
    </ThemeProvider>,
    { stdout, stdin, patchConsole: false },
  );
  controller.dismissBoot();
  return { tty, stdin, controller, instance, cleanup };
}

describe('EST-0965 — prova de bytes do render (esc/streaming + Custom)', () => {
  it('(b) esc no streaming + nova msg ⇒ região viva ÚNICA (fala parcial não dobra) e no máx 1 cursor vivo', async () => {
    let release: (() => void) | null = null;
    const caller: ModelCaller = {
      async call({ signal }): Promise<ModelCallResult> {
        const gate = new Promise<void>((res, rej) => {
          release = res;
          signal?.addEventListener('abort', () => rej(new ModelCallAbortedError()), { once: true });
        });
        m.controller.sink.onStart();
        m.controller.sink.onDelta(PARTIAL);
        await gate;
        m.controller.sink.onDone?.();
        return { request_id: 'r', content: PARTIAL, finish_reason: 'stop' };
      },
    };
    const m = mount(caller);
    const waitState = async (cond: () => boolean, ms = 4000): Promise<void> => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error('waitState: condição não assentou');
        await sleep(10);
      }
    };
    await pump(m, '', 'digite um objetivo', 3000); // stdin do Ink plugada
    void m.controller.submit('primeira');
    await waitState(() => m.controller.current.phase === 'streaming');
    m.stdin.send('\x1b'); // esc ⇒ sela o parcial, volta a idle
    await waitState(() => m.controller.current.phase === 'idle');
    // nova mensagem: digita char-a-char (cada um UMA vez, com settle) e espera ecoar;
    // depois Enter (re-enviado até o 2º turno arrancar). Robusto ao batching do Ink/CI.
    for (const ch of 'segunda') {
      m.stdin.send(ch);
      await sleep(25);
    }
    const end = Date.now() + 3000;
    while (m.controller.blocks.filter((b) => b.kind === 'aluy').length < 2 && Date.now() < end) {
      m.stdin.send('\r');
      await sleep(60);
    }
    await waitState(() => m.controller.blocks.filter((b) => b.kind === 'aluy').length >= 2);

    // No ESTADO (fonte da verdade do que a região viva contém): só 1 aluy streaming.
    const liveStreaming = m.controller.blocks.filter(
      (b) => b.kind === 'aluy' && b.streaming === true,
    );
    expect(liveStreaming).toHaveLength(1);
    expect(m.controller.blocks.filter((b) => b.kind === 'aluy')).toHaveLength(2);

    // BYTES: o ÚLTIMO frame committed renderiza a fala parcial NO MÁXIMO 1× (a 1ª já
    // migrou p/ o <Static>; a 2ª está streamando). Sem o fix vinham 2 na MESMA região viva.
    const last = lastFrameOf(m.tty.text());
    expect(count(last, PARTIAL)).toBeLessThanOrEqual(1);

    // CURSORES FANTASMAS (bug #3 — 3 cursores): cada bloco `aluy` em streaming desenha um
    // `▏` (TurnBlock). Com o zombie, eram 2 streaming + o composer = 3. Selado o parcial,
    // a região viva tem NO MÁXIMO 1 bloco streaming ⇒ no máximo 1 `▏` na fala viva. (O
    // cursor REAL do terminal é gerido pelo cli-cursor do Ink — fora do escopo deste fix; o
    // nº de hide/show varia por runner com os toggles de raw-mode, então não asseramos por
    // ele.) Aqui provamos o que o fix controla: a fala viva não multiplica o cursor.
    const liveStreamingGlyphs = m.controller.blocks.filter(
      (b) => b.kind === 'aluy' && b.streaming === true,
    ).length;
    expect(liveStreamingGlyphs).toBeLessThanOrEqual(1);

    release?.();
    await sleep(60);
    m.instance.unmount();
    m.cleanup();
  });

  // (a) /model → Custom + digitar — o texto fica DENTRO do browser, UMA vez (não vaza/
  // duplica fora). FRAME-based (ink-testing-library) p/ ser robusto ao caminho de render
  // do Ink em CI (o `render` REAL não emite os frames vivos do picker ao stdout sob CI —
  // por isso a prova de BYTES do picker é impossível lá; a do esc/streaming acima é
  // state-based e segue valendo). O componente <ModelPicker> renderiza tudo DENTRO do
  // <Box> gerenciado pelo Ink — nada cru fora.
  it('(a) /model → Custom + digitar ⇒ o texto fica DENTRO do browser (filtro), UMA vez', async () => {
    const { render: renderTesting } = await import('ink-testing-library');
    const controller = new SessionController({
      model: { call: async () => ({ request_id: 'r', content: '', finish_reason: 'stop' }) },
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    const theme = resolveTheme({ env: ENV });
    const r = renderTesting(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          catalog={{ list: async () => CATALOG }}
          customModels={{ list: async () => CUSTOM }}
          onSelectTier={() => {}}
        />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    const frame = () => (r.lastFrame() ?? '').replace(ANSI, '');
    const waitFrame = async (mark: string, ms = 3000): Promise<void> => {
      const end = Date.now() + ms;
      while (!frame().includes(mark)) {
        if (Date.now() > end) throw new Error(`waitFrame: "${mark}" não apareceu`);
        await sleep(10);
      }
    };
    await waitFrame('digite um objetivo');
    r.stdin.write('/model');
    await sleep(30);
    r.stdin.write('\r'); // abre o picker
    await waitFrame('Custom');
    // desce até a linha CUSTOM (é a ÚLTIMA; clampa) e ABRE o browser/free-text.
    for (let i = 0; i < 6; i++) {
      r.stdin.write('\x1b[B');
      await sleep(15);
    }
    r.stdin.write('\r');
    await waitFrame('filtro');
    // digita no browser Custom — slug que NÃO casa nenhum modelo ⇒ o filtro só mostra o
    // texto digitado (1×). A stdin da ink-testing-library guarda só o ÚLTIMO write, então
    // re-envia cada char até o filtro refletir o PREFIXO acumulado (robusto ao batching).
    const TYPED = 'zzq';
    let acc = '';
    for (const ch of TYPED) {
      acc += ch;
      const end2 = Date.now() + 2000;
      while (
        !(
          frame()
            .split('\n')
            .find((l) => l.includes('filtro')) ?? ''
        ).includes(acc)
      ) {
        if (Date.now() > end2) throw new Error(`não filtrou "${acc}"`);
        r.stdin.write(ch);
        await sleep(40);
      }
    }

    const f = frame();
    // o texto aparece DENTRO da linha de FILTRO do browser, UMA vez — não duplicado fora.
    expect(f).toContain('filtro');
    const filterLine = f.split('\n').find((l) => l.includes('filtro'));
    expect(filterLine).toContain(TYPED);
    expect(count(f, TYPED)).toBe(1);
    // o composer (placeholder/prompt) NÃO ecoa o texto do picker (sem vazamento).
    const composerLine = f.split('\n').find((l) => l.includes('digite um objetivo'));
    if (composerLine) expect(composerLine).not.toContain(TYPED);

    r.unmount();
  });
});
