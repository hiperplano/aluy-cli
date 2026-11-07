// Relato do dono (22/09/2026): "quando dá um erro de conexão com o modelo ele duplica
// depois a caixa de texto do aluy pensando... a tela tremendo absurdamente".
//
// O MECANISMO sob prova: o laço de retry do `StreamingModelCaller` envolve o STREAM
// inteiro. Uma queda NO MEIO (já com texto parcial na tela) cai no `noteCallerRetry`, cujo
// filtro de órfãos só descarta o bloco `Λluy` VAZIO — o parcial fica. A tentativa seguinte
// chama `sink.onStart`, que SEMPRE anexa um bloco novo. Resultado: um `Λluy` a mais por
// tentativa. Com o teto de 20 tentativas a região viva cresce até cruzar `rows`, e aí o
// Ink reescreve a tela inteira a cada frame — a duplicação e o tremor têm a mesma causa.
//
// A queda ANTES do primeiro byte (conexão recusada) NÃO tem esse problema — medido na TUI
// real a 40/30/20 linhas: zero redesenhos, nada empilha. É só o meio do stream.
import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type ModelCaller, type ToolPorts } from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function buildController(): SessionController {
  const model: ModelCaller = {
    async call() {
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
    askResolver: { resolve: async () => ({ kind: 'approve-once' as const }) },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const blocosAluy = (c: SessionController) => c.current.blocks.filter((b) => b.kind === 'aluy');

/** Simula UMA tentativa que cai no meio: começa, fala um pouco, e o caller avisa o retry. */
function tentativaQueCaiNoMeio(c: SessionController, n: number): void {
  c.sink.onStart?.();
  c.sink.onDelta?.('parte ' + n + ' da resposta…');
  c.noteCallerRetry({ attempt: n, max: 20, waitMs: 1000, reason: 'falha de rede' });
}

describe('retry no MEIO do stream — o bloco parcial não pode empilhar', () => {
  it('três quedas no meio ⇒ NO MÁXIMO um bloco Λluy vivo (a regressão exata)', () => {
    const c = buildController();
    c.dismissBoot();
    for (let n = 1; n <= 3; n++) tentativaQueCaiNoMeio(c, n);
    // A 4ª tentativa começa: mais um `onStart`.
    c.sink.onStart?.();
    const vivos = blocosAluy(c);
    expect(vivos.length, 'blocos Λluy na tela: ' + JSON.stringify(vivos.map((b) => b.text))).toBe(1);
  });

  it('o aviso de retry continua ÚNICO (não empilha caixas de erro)', () => {
    const c = buildController();
    c.dismissBoot();
    for (let n = 1; n <= 3; n++) tentativaQueCaiNoMeio(c, n);
    expect(c.current.blocks.filter((b) => b.kind === 'broker-error').length).toBe(1);
  });

  // Não-regressão do caso que JÁ funcionava: queda ANTES do primeiro byte (sem onStart).
  it('queda antes do primeiro byte: nada empilha (como já era)', () => {
    const c = buildController();
    c.dismissBoot();
    for (let n = 1; n <= 3; n++) {
      c.noteCallerRetry({ attempt: n, max: 20, waitMs: 1000, reason: 'falha de rede' });
    }
    expect(blocosAluy(c).length).toBe(0);
    expect(c.current.blocks.filter((b) => b.kind === 'broker-error').length).toBe(1);
  });
});
