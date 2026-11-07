// Regressão: ver o comentário em `chegar` abaixo.
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

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function buildController(): SessionController {
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
  const ports = {
    fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    search: { search: async () => [] },
  } as unknown as ToolPorts;
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Empurra blocos pelo MESMO caminho do produto (`pushBlock` é privado — é teste de render). */
function empurrar(controller: SessionController, blocos: readonly Record<string, unknown>[]) {
  const c = controller as unknown as { pushBlock(b: Record<string, unknown>): void };
  for (const b of blocos) c.pushBlock(b);
}

/** As linhas da tela a partir da 1ª nota "encaixado", sem espaços à direita. */
function linhasDesdeOPrimeiro(frame: string): string[] {
  const linhas = plain(frame)
    .split('\n')
    .map((l) => l.trimEnd());
  const i = linhas.findIndex((l) => l.includes('↳ encaixado'));
  return i < 0 ? [] : linhas.slice(i);
}

function montar(controller: SessionController) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
}

// Relato do dono (rc.190): "ele pula uma linha quando mando duas encaixadas uma após a outra".
// O teste antigo só cobria o caso em que as duas notas já existem no MESMO render. Na vida
// real a 2ª chega DEPOIS: a 1ª já desceu p/ o `<Static>` (escrito uma vez, nunca repintado)
// COM o respiro de baixo, e a linha em branco ficava no meio. Aqui a chegada é SEQUENCIAL.
async function chegar(
  controller: SessionController,
  frame: () => string | undefined,
  bloco: Record<string, unknown>,
  marca: string,
) {
  empurrar(controller, [bloco]);
  await waitFor(() => plain(frame() ?? '').includes(marca));
  // deixa o `<Static>` assentar o bloco antes do próximo chegar
  await new Promise((r) => setTimeout(r, 60));
}

async function cena(blocos: readonly [Record<string, unknown>, string][], completo = false) {
  const controller = buildController();
  const { lastFrame, unmount } = montar(controller);
  controller.dismissBoot();
  for (const [b, marca] of blocos) await chegar(controller, lastFrame, b, marca);

  const todas = plain(lastFrame() ?? '')
    .split('\n')
    .map((x) => x.trim());
  const l = completo ? todas : linhasDesdeOPrimeiro(lastFrame() ?? '').map((x) => x.trim());
  unmount();
  return l;
}

describe('App — encaixados chegando em instantes DIFERENTES', () => {
  it('2ª nota chega depois da 1ª ter assentado: coladas', async () => {
    const l = await cena([
      [{ kind: 'inject', text: 'um' }, 'encaixado: um'],
      [{ kind: 'inject', text: 'dois' }, 'encaixado: dois'],
    ]);
    expect(l.slice(0, 2)).toEqual(['↳ encaixado: um', '↳ encaixado: dois']);
  });

  it('três em sequência: coladas', async () => {
    const l = await cena([
      [{ kind: 'inject', text: 'um' }, 'encaixado: um'],
      [{ kind: 'inject', text: 'dois' }, 'encaixado: dois'],
      [{ kind: 'inject', text: 'tres' }, 'encaixado: tres'],
    ]);
    expect(l.slice(0, 3)).toEqual(['↳ encaixado: um', '↳ encaixado: dois', '↳ encaixado: tres']);
  });

  it('bloco invisível (selfCheck) entre duas notas: coladas', async () => {
    const l = await cena([
      [{ kind: 'inject', text: 'um' }, 'encaixado: um'],
      [{ kind: 'aluy', text: 'oculto', streaming: false, selfCheck: true }, ''],
      [{ kind: 'inject', text: 'dois' }, 'encaixado: dois'],
    ]);
    expect(l.slice(0, 2)).toEqual(['↳ encaixado: um', '↳ encaixado: dois']);
  });

  it('bloco invisível entre a nota e o próximo bloco: UM respiro só', async () => {
    const l = await cena([
      [{ kind: 'inject', text: 'um' }, 'encaixado: um'],
      [{ kind: 'aluy', text: 'oculto', streaming: false, selfCheck: true }, ''],
      [{ kind: 'note', title: 'marco', lines: ['depois'] }, 'marco'],
    ]);
    expect(l.slice(0, 3)).toEqual(['↳ encaixado: um', '', expect.stringContaining('marco')]);
  });

  it.each([
    ['aluy', { kind: 'aluy', text: 'RESPOSTA', streaming: false }, 'RESPOSTA'],
    [
      'tool',
      { kind: 'tool', verb: 'ler', target: 'a.ts', result: '1 linha', status: 'ok' },
      'a.ts',
    ],
    ['note', { kind: 'note', title: 'marco', lines: ['depois'] }, 'marco'],
  ])('nota seguida de %s: exatamente UMA linha em branco', async (_n, bloco, marca) => {
    const l = await cena([
      [{ kind: 'inject', text: 'um' }, 'encaixado: um'],
      [bloco as Record<string, unknown>, marca],
    ]);
    expect(l[0]).toBe('↳ encaixado: um');
    expect(l[1]).toBe('');
    expect(l[2]).not.toBe('');
    // o 'aluy' tem o rótulo `Λ aluy` na 1ª linha; as demais têm o próprio conteúdo
    expect(l.join('\n')).toContain(marca);
  });

  it('nota seguida de you: o respiro vem ANTES da divisória do turno (como sempre)', async () => {
    const l = await cena([
      [{ kind: 'inject', text: 'um' }, 'encaixado: um'],
      [{ kind: 'you', text: 'VOCE' }, 'VOCE'],
    ]);
    // respiro, divisória (vazia sem largura no teste), respiro, rótulo — mesma estrutura de
    // quando o respiro era pago pela nota; só mudou QUEM paga.
    expect(l.slice(0, 6)).toEqual(['↳ encaixado: um', '', '', '', '▌ você', 'VOCE']);
  });

  it('fim do turno: sobra o MESMO nº de linhas em branco até o composer que após uma tool', async () => {
    const brancas = async (b: Record<string, unknown>, marca: string) => {
      const l = await cena([[b, marca]], true);
      const j = l.findIndex((x) => x.startsWith('┃❯'));
      let n = 0;
      for (let k = j - 1; k >= 0 && l[k] === ''; k -= 1) n += 1;
      return n;
    };
    const inj = await brancas({ kind: 'inject', text: 'um' }, 'encaixado: um');
    const tool = await brancas(
      { kind: 'tool', verb: 'ler', target: 'a.ts', result: '1 linha', status: 'ok' },
      'a.ts',
    );
    // A nota é UMA linha, como a `⏺ tool`: o respiro até o composer é o da região viva
    // (contêiner + rodapé), sem linha própria — e portanto sem a linha DUPLA que havia.
    expect(inj).toBe(tool);
    expect(inj).toBeGreaterThan(0);
  });
});
