// CRASH `RuntimeError: memory access out of bounds` em `getComputedWidth` (renderer.js:13, o
// bloco do `<Static>`) ao entrar no /fullscreen e mandar mensagem numa sessão retomada.
// CAUSA-RAIZ: o Ink NUNCA limpa `rootNode.staticNode` quando o `<Static>` sai da árvore ⇒ o
// Yoga libera o nó (freeRecursive) e o renderer segue lendo o ponteiro morto a cada frame.
// Estes testes provam (1) o defeito do Ink, (2) que o guard o neutraliza (inclusive no fluxo
// real inline → /fullscreen com histórico longo + statusline compact) e (3) a rede de
// segurança (falha de render do Yoga não mata o processo).
import './_scrub-ci-env.js';
import React, { useEffect, useRef } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Box, Static, Text, type DOMElement } from 'ink';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import {
  InkRootGuard,
  findInkRoot,
  installInkRootGuard,
  isAttachedTo,
} from '../../src/session/ink-root-guard.js';
import {
  isYogaRenderFault,
  onRenderFault,
  notifyRenderFault,
} from '../../src/session/render-fault.js';
import { registerRestoreHandlers, LEAVE_ALT_SCREEN } from '../../src/session/alt-screen.js';

const plain = (s: string): string =>
  s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g'), '');
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

interface RootLike {
  staticNode?: { parentNode?: unknown };
}

/** Expõe o `ink-root` real via ref (para inspecionar `staticNode`). */
function Probe(props: { onRoot: (r: RootLike) => void }): React.ReactElement {
  const ref = useRef<DOMElement>(null);
  useEffect(() => {
    const root = findInkRoot(ref.current);
    if (root) props.onRoot(root as RootLike);
  });
  return <Box ref={ref} display="none" />;
}

function Tree(props: {
  withStatic: boolean;
  guard: boolean;
  onRoot: (r: RootLike) => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {props.guard ? <InkRootGuard /> : null}
      <Probe onRoot={props.onRoot} />
      {props.withStatic ? (
        <Static items={['h1', 'h2', 'h3']}>{(i) => <Text key={i}>{i}</Text>}</Static>
      ) : null}
      <Text>vivo</Text>
    </Box>
  );
}

describe('rootNode.staticNode pendurado (defeito do Ink) × InkRootGuard', () => {
  it('SEM o guard: após o <Static> sair da árvore, staticNode segue apontando p/ nó solto', async () => {
    let root: RootLike | undefined;
    const r = render(<Tree withStatic guard={false} onRoot={(x) => (root = x)} />);
    await flush();
    expect(root?.staticNode).toBeDefined();
    r.rerender(<Tree withStatic={false} guard={false} onRoot={(x) => (root = x)} />);
    await flush();
    // O defeito: referência morta (nó desanexado da árvore) ainda exposta ao renderer.
    expect(root?.staticNode).toBeDefined();
    expect(isAttachedTo(root?.staticNode, root)).toBe(false);
    r.unmount();
  });

  it('COM o guard: o acessor devolve undefined p/ nó solto e o nó vivo enquanto montado', async () => {
    let root: RootLike | undefined;
    const r = render(<Tree withStatic guard onRoot={(x) => (root = x)} />);
    await flush();
    expect(root?.staticNode).toBeDefined(); // Static montado ⇒ devolvido
    expect(isAttachedTo(root?.staticNode, root)).toBe(true);
    r.rerender(<Tree withStatic={false} guard onRoot={(x) => (root = x)} />);
    await flush();
    expect(root?.staticNode).toBeUndefined(); // nunca expõe o ponteiro morto
    // e remontar um Static novo volta a funcionar (ciclo inline → cockpit → inline)
    r.rerender(<Tree withStatic guard onRoot={(x) => (root = x)} />);
    await flush();
    expect(isAttachedTo(root?.staticNode, root)).toBe(true);
    r.unmount();
  });

  it('installInkRootGuard é idempotente', () => {
    const fake = { nodeName: 'ink-root', staticNode: undefined, onImmediateRender: () => {} };
    expect(installInkRootGuard(fake)).toBe(true);
    expect(installInkRootGuard(fake)).toBe(false);
  });
});

describe('rede de segurança: falha de render do Yoga não mata o processo', () => {
  const wasmErr = (): Error => {
    const e = new Error('memory access out of bounds');
    e.name = 'RuntimeError';
    e.stack =
      'RuntimeError: memory access out of bounds\n    at wasm://wasm/000460e2:wasm-function[215]:0xd5ef\n' +
      '    at X.getComputedWidth (node_modules/yoga-layout/dist/binaries/yoga-wasm-base64-esm.js:33:52)\n' +
      '    at renderer (node_modules/ink/build/renderer.js:13:49)';
    return e;
  };

  it('isYogaRenderFault: só RuntimeError do wasm com pilha no Yoga/renderer', () => {
    expect(isYogaRenderFault(wasmErr())).toBe(true);
    expect(isYogaRenderFault(new Error('boom'))).toBe(false);
    expect(isYogaRenderFault(new TypeError('x is undefined'))).toBe(false);
    expect(isYogaRenderFault('string')).toBe(false);
    const rt = new Error('oob');
    rt.name = 'RuntimeError';
    rt.stack = 'RuntimeError: oob\n    at algumaCoisaNossa (src/foo.ts:1:1)';
    expect(isYogaRenderFault(rt)).toBe(false);
  });

  it('render imediato do Ink que lança falha do Yoga: engole, avisa a App; outro erro re-lança', () => {
    let calls = 0;
    const root = {
      nodeName: 'ink-root',
      onImmediateRender: () => {
        calls++;
        throw calls === 1 ? wasmErr() : new Error('bug de lógica');
      },
    };
    installInkRootGuard(root);
    const seen: unknown[] = [];
    const off = onRenderFault((e) => seen.push(e));
    expect(() => root.onImmediateRender()).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(() => root.onImmediateRender()).toThrow('bug de lógica');
    expect(seen).toHaveLength(1);
    off();
  });

  it('alt-screen onCrash: falha do Yoga NÃO restaura/re-lança (a TUI segue); erro real re-lança', () => {
    const writes: string[] = [];
    const stream = {
      isTTY: true,
      write: (s: string) => (writes.push(s), true),
    };
    const listeners = new Map<string, (...a: unknown[]) => void>();
    const scheduled: Array<() => void> = [];
    const proc = {
      on: (e: string, l: (...a: unknown[]) => void) => (listeners.set(e, l), proc),
      off: () => proc,
      removeListener: () => proc,
      once: (e: string, l: (...a: unknown[]) => void) => (listeners.set(e, l), proc),
      exit: () => undefined,
      nextTick: (cb: () => void) => scheduled.push(cb),
      stdin: undefined,
    };
    registerRestoreHandlers(stream as never, proc as never);
    const seen: unknown[] = [];
    const off = onRenderFault((e) => seen.push(e));
    listeners.get('uncaughtException')!(wasmErr());
    expect(seen).toHaveLength(1); // a App foi avisada
    expect(writes.join('')).not.toContain(LEAVE_ALT_SCREEN); // não derrubou a tela
    expect(scheduled).toHaveLength(0); // não re-lançou
    listeners.get('uncaughtException')!(new Error('erro real'));
    expect(writes.join('')).toContain(LEAVE_ALT_SCREEN);
    expect(scheduled).toHaveLength(1);
    off();
    notifyRenderFault(wasmErr()); // sem ouvintes: não lança
  });
});

// ── Fluxo do dono: sessão retomada LONGA, statusline compact, inline → /fullscreen → "olá" ──
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ports = (): ToolPorts => ({
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
});
const caller = (): ModelCaller => ({
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: 'oi', finish_reason: 'stop' };
  },
});

describe('App — inline → /fullscreen com sessão retomada longa (statusline compact)', () => {
  beforeEach(() => vi.stubEnv('ALUY_FULLSCREEN', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('após entrar no cockpit o renderer nunca vê um staticNode solto, nem ao enviar "olá"', async () => {
    const controller = new SessionController({
      model: caller(),
      permission: new PolicyPermissionEngine(),
      ports: ports(),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    const blocks = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0
        ? ({ kind: 'you', text: `pergunta ${i}` } as const)
        : ({ kind: 'aluy', text: `resposta ${i}\n`.repeat(6), streaming: false } as const),
    );
    controller.restoreBlocks(blocks as never);
    let root: RootLike | undefined;
    const r = render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <Probe onRoot={(x) => (root = x)} />
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          initialStatusline="compact"
          cockpitScreen={{ enter: () => {}, leave: () => {} }}
        />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    // O guard é montado pela ThemeRoot em produção; aqui o montamos ao lado da App.
    installInkRootGuard(root as never);
    expect(isAttachedTo(root?.staticNode, root)).toBe(true); // inline: Static vivo

    r.stdin.write('/fullscreen');
    await flush();
    r.stdin.write('\r');
    await flush();
    expect(r.lastFrame() ?? '').toContain('conversa'); // entrou no cockpit
    // Static saiu da árvore: o renderer não pode enxergar o nó liberado.
    expect(root?.staticNode).toBeUndefined();

    r.stdin.write('olá');
    await flush();
    r.stdin.write('\r');
    await flush();
    expect(root?.staticNode).toBeUndefined();
    expect(r.lastFrame() ?? '').toContain('olá');
    controller.dispose();
    r.unmount();
  });

  it('falha de render do Yoga com o cockpit ativo: volta ao inline com nota em PT-BR (não morre)', async () => {
    const leave = vi.fn();
    const controller = new SessionController({
      model: caller(),
      permission: new PolicyPermissionEngine(),
      ports: ports(),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    const r = render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          cockpitScreen={{ enter: () => {}, leave }}
        />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    r.stdin.write('/fullscreen');
    await flush();
    r.stdin.write('\r');
    await flush();
    expect(r.lastFrame() ?? '').toContain('conversa');
    const err = new Error('memory access out of bounds');
    err.name = 'RuntimeError';
    err.stack = 'RuntimeError: x\n at wasm://w\n at X.getComputedWidth (yoga-wasm.js)';
    notifyRenderFault(err);
    await flush();
    expect(leave).toHaveBeenCalledTimes(1);
    const frame = r.lastFrame() ?? '';
    const nota = controller.state.blocks.find((b) => b.kind === 'note' && b.title === 'cockpit');
    expect(JSON.stringify(nota)).toMatch(
      /falha ao desenhar a tela cheia|full-screen render failed/u,
    );
    expect(plain(frame)).not.toContain('▌ conversa'); // saiu do cockpit (sem rótulo de região)
    controller.dispose();
    r.unmount();
  });
});
