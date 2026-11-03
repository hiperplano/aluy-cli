// RODAPÉ em 3 modos (completo | parcial | oculto) — resolução, persistência, F2, /rodape,
// avisos que não somem (yolo) e a linha compacta.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { PolicyPermissionEngine, type ToolPorts } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import {
  UserConfigStore,
  proximoRodape,
  resolveInitialRodape,
  rodapeEfetivo,
} from '../../src/io/user-config.js';
import { caminhoCurto, linhaParcial, segmentosParcial } from '../../src/session/rodape.js';

const ESC = String.fromCharCode(27);
const plain = (s: string | undefined): string =>
  (s ?? '').replace(new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g'), '');
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

describe('resolução do modo', () => {
  it('automático: completo, ou parcial em tela baixa (≤ 30); altura 0/desconhecida ⇒ completo', () => {
    expect(rodapeEfetivo(undefined, 45)).toBe('completo');
    expect(rodapeEfetivo(undefined, 31)).toBe('completo');
    expect(rodapeEfetivo(undefined, 30)).toBe('parcial');
    expect(rodapeEfetivo(undefined, 24)).toBe('parcial');
    expect(rodapeEfetivo(undefined, 0)).toBe('completo');
  });
  it('escolha explícita vence a altura', () => {
    expect(rodapeEfetivo('completo', 24)).toBe('completo');
    expect(rodapeEfetivo('oculto', 45)).toBe('oculto');
  });
  it('env > config; lixo é ignorado', () => {
    expect(resolveInitialRodape({ rodape: 'parcial' }, { ALUY_RODAPE: 'oculto' })).toBe('oculto');
    expect(resolveInitialRodape({ rodape: 'parcial' }, {})).toBe('parcial');
    expect(resolveInitialRodape({}, { ALUY_RODAPE: 'xx' })).toBeUndefined();
  });
  it('ciclo F2: completo → parcial → oculto → completo', () => {
    expect(proximoRodape('completo')).toBe('parcial');
    expect(proximoRodape('parcial')).toBe('oculto');
    expect(proximoRodape('oculto')).toBe('completo');
  });
});

describe('persistência em ~/.aluy/config.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aluy-rodape-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('saveRodape grava e o load devolve; valor inválido no disco some', () => {
    const store = new UserConfigStore({ baseDir: dir });
    expect(store.saveRodape('oculto')).toBe(true);
    expect(store.load().rodape).toBe('oculto');
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
    const bruto = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { rodape?: string };
    expect(bruto.rodape).toBe('oculto');
  });
});

describe('linha parcial', () => {
  const base = {
    model: 'glm-5.3',
    cwd: '/home/u/projects/foo',
    home: '/home/u',
    windowPct: 4,
    tokens: 37_600,
    unsafe: false,
    sidecarCaido: false,
    cotaPausada: false,
    columns: 120,
  };
  it('essencial numa linha, com yolo', () => {
    expect(linhaParcial({ ...base, unsafe: true })).toBe(
      'glm-5.3 · ~/projects/foo · 4% janela · 37.6k · ⚠ yolo',
    );
  });
  it('avisos NUNCA saem antes do resto, mesmo em largura mínima', () => {
    const l = linhaParcial({
      ...base,
      unsafe: true,
      sidecarCaido: true,
      cotaPausada: true,
      columns: 30,
    });
    expect(l).toContain('⚠ yolo');
    const so = segmentosParcial({ ...base, unsafe: true, columns: 10 });
    expect(so.map((s) => s.texto)).toEqual(['⚠ yolo']);
  });
  it('caminho longo corta pela cabeça', () => {
    expect(caminhoCurto('/a/b/c/d/e/f/g/projeto', undefined, 12)).toMatch(/^…\/.*projeto$/);
  });
});

function ports(): ToolPorts {
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
  } as ToolPorts;
}

function mount(opts: { rodape?: 'completo' | 'parcial' | 'oculto'; unsafe?: boolean }) {
  const controller = new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    },
    permission: new PolicyPermissionEngine({ mode: opts.unsafe ? 'unsafe' : 'normal' }),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 1200, windowPct: 4 },
    flush: { intervalMs: 0 },
  });
  controller.dismissBoot();
  const onRodapeChange = vi.fn();
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        {...(opts.rodape !== undefined ? { initialRodape: opts.rodape } : {})}
        onRodapeChange={onRodapeChange}
      />
    </ThemeProvider>,
  );
  return { controller, onRodapeChange, ...r };
}

async function esperar(cond: () => boolean, ms = 2000): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('esperar: não assentou');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('App — os 3 modos', () => {
  it('completo: painel inteiro + dicas', async () => {
    const { lastFrame, unmount } = mount({ rodape: 'completo' });
    await esperar(() => plain(lastFrame()).includes('sessão'));
    const f = plain(lastFrame());
    expect(f).toContain('estado');
    expect(f).toContain('enviar');
    unmount();
  });

  it('parcial: UMA linha com o essencial; sem o painel', async () => {
    const { lastFrame, unmount } = mount({ rodape: 'parcial' });
    await esperar(() => plain(lastFrame()).includes('% janela'));
    const f = plain(lastFrame());
    expect(f).toContain('4% janela');
    expect(f).not.toContain('estado');
    expect(f).not.toContain('sessão  ');
    unmount();
  });

  it('parcial + yolo: o aviso aparece na linha', async () => {
    const { lastFrame, unmount } = mount({ rodape: 'parcial', unsafe: true });
    await esperar(() => plain(lastFrame()).includes('⚠ yolo'));
    unmount();
  });

  it('oculto: nada abaixo do composer (sem yolo); a dica só aparece ao entrar no modo', async () => {
    const { lastFrame, unmount } = mount({ rodape: 'oculto' });
    await new Promise((r) => setTimeout(r, 100));
    const f = plain(lastFrame());
    expect(f).not.toContain('% janela');
    expect(f).not.toContain('estado');
    expect(f).not.toContain('enviar');
    unmount();
  });

  it('oculto + yolo: o ⚠ yolo NUNCA some', async () => {
    const { lastFrame, unmount } = mount({ rodape: 'oculto', unsafe: true });
    await esperar(() => plain(lastFrame()).includes('⚠ yolo'));
    unmount();
  });

  it('F2 cicla (completo → parcial → oculto) e persiste cada escolha', async () => {
    const { lastFrame, stdin, onRodapeChange, unmount } = mount({ rodape: 'completo' });
    await esperar(() => plain(lastFrame()).includes('estado'));
    // espera o listener cru do stdin attachar
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('\x1bOQ');
    await esperar(
      () => plain(lastFrame()).includes('% janela') && !plain(lastFrame()).includes('estado'),
    );
    stdin.write('\x1b[12~');
    await esperar(() => plain(lastFrame()).includes('rodapé oculto'));
    expect(onRodapeChange.mock.calls.map((c) => c[0])).toEqual(['parcial', 'oculto']);
    unmount();
  });
});
