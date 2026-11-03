// Auditoria — entrada no composer em REPOUSO (sem turno): nova linha por Alt+Enter, Ctrl+J e
// `\`+Enter, e o lote multi-linha (`a\rb\r` num chunk só) sem descartar linhas. O ramo
// "trabalhando" já tinha cobertura; o do repouso sobrevivia à mutação (o `isNewlineKey`, o
// `backslashNewline` e o `drainTypedChunk` do repouso podiam ser removidos sem teste falhar).

import React from 'react';
import { describe, expect, it } from 'vitest';
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

const ESC = String.fromCharCode(27);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ports = {
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
} as unknown as ToolPorts;

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

function montar() {
  const objetivos: string[] = [];
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      const ultimo = [...args.messages].reverse().find((m) => m.role === 'user');
      objetivos.push(typeof ultimo?.content === 'string' ? ultimo.content : '');
      await sleep(120);
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  c.dismissBoot();
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <App controller={c} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  const falas = (): string[] => c.current.blocks.flatMap((b) => (b.kind === 'you' ? [b.text] : []));
  return { c, r, objetivos, falas };
}

/** Digita uma tecla de cada vez, dando tempo ao Ink de re-assinar o handler entre elas. */
async function digitar(r: ReturnType<typeof render>, ...teclas: string[]): Promise<void> {
  for (const t of teclas) {
    r.stdin.write(t);
    await sleep(70);
  }
}

describe('composer em repouso · nova linha sem enviar', () => {
  it.each([
    ['Alt+Enter', ESC + '\r'],
    ['Ctrl+J', '\n'],
  ])('%s quebra a linha; o Enter limpo envia as duas linhas juntas', async (_nome, quebra) => {
    const { c, r, falas } = montar();
    await sleep(100);
    await digitar(r, 'abc', quebra, 'def');
    expect(falas()).toEqual([]); // nada foi enviado ainda
    await digitar(r, '\r');
    await esperar(() => falas().length === 1);
    expect(falas()[0]).toBe('abc\ndef');
    r.unmount();
    c.dispose();
  });

  it('`\\`+Enter troca a barra por quebra de linha (e não envia); o Enter seguinte envia', async () => {
    const { c, r, falas } = montar();
    await sleep(100);
    await digitar(r, 'abc\\', '\r', 'def');
    expect(falas()).toEqual([]);
    await digitar(r, '\r');
    await esperar(() => falas().length === 1);
    expect(falas()[0]).toBe('abc\ndef');
    r.unmount();
    c.dispose();
  });

  it('sem barra, o Enter envia na hora (a regra da barra não vaza)', async () => {
    const { c, r, falas } = montar();
    await sleep(100);
    await digitar(r, 'abc', '\r');
    await esperar(() => falas().length === 1);
    expect(falas()[0]).toBe('abc');
    r.unmount();
    c.dispose();
  });
});

describe('composer em repouso · lote multi-linha num chunk só', () => {
  it('`um\\rdois\\r` entrega as DUAS linhas (nenhuma é descartada em silêncio)', async () => {
    const { c, r, objetivos, falas } = montar();
    await sleep(100);
    r.stdin.write('um\rdois\r');
    await esperar(() => objetivos.length >= 1 && falas().length >= 1);
    // a 1ª linha é o objetivo; a 2ª chega com o turno vivo (encaixa/enfileira) — ambas aparecem.
    await esperar(() => objetivos.join('|').includes('dois') || falas().includes('dois'), 5000);
    expect(falas()[0]).toBe('um');
    const todas = objetivos.join('|') + '|' + falas().join('|');
    expect(todas).toContain('dois');
    r.unmount();
    c.dispose();
  });

  it('o texto depois da última quebra FICA no composer (não é enviado)', async () => {
    const { c, r, falas } = montar();
    await sleep(100);
    r.stdin.write('um\rrascunho');
    await esperar(() => falas().length === 1);
    await sleep(150);
    expect(falas()).toEqual(['um']);
    // o rascunho continua no composer: Enter o envia depois.
    await esperar(() => c.current.phase !== 'thinking' && c.current.phase !== 'streaming');
    await digitar(r, '\r');
    await esperar(() => falas().includes('rascunho'));
    r.unmount();
    c.dispose();
  });
});
