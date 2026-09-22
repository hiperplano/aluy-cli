// F-TREMOR-DE-RETRY + F-CAIXA-DE-RETRY-ÓRFÃ (22/09/2026, relato do dono no Windows):
// "tá flicando a cada xx segundos quando estoura um erro de conectividade" e depois "o
// flicker permanece mesmo não dando mais problema de conexão".
//
// Duas causas, os dois guardadas aqui:
//
// 1. O `sink.onStart` dispara ANTES de a requisição sair. Pintar nesse instante (fase →
//    `streaming`, caixa `Λluy` vazia) mudava a altura do frame por uma tentativa que nem
//    conectava; a cada retry a tela crescia e encolhia. Agora o que é visível espera o
//    PRIMEIRO byte.
// 2. O aviso `tentando de novo` (vivo, `retrying:true`) era removido só pelo `r`/`esc` da
//    fase de erro FINAL. Depois de um retry BEM-SUCEDIDO ninguém o tirava — e um bloco
//    vivo que nunca assenta PINA a região viva: nada depois dele migra para o scrollback,
//    a região cresce a cada turno e o relógio do rodapé (1×/s) reescreve tudo. Agora ele
//    sai no primeiro byte (mesmo patch da caixa nova) e, por segurança, no fim do turno.
import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type ModelCaller, type ToolPorts } from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { splitBlocks } from '../../src/session/render-split.js';

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

const kinds = (c: SessionController) => c.current.blocks.map((b) => b.kind);
const retry = (c: SessionController, n: number) =>
  c.noteCallerRetry({ attempt: n, max: 20, waitMs: 1000, reason: 'falha de rede' });

describe('1 · onStart sem byte NÃO pinta nada (a altura do frame não oscila)', () => {
  it('três tentativas que nem conectam: fase e blocos idênticos entre uma e outra', () => {
    const c = buildController();
    c.dismissBoot();
    // Um turno "pensando" em curso.
    c.sink.onStart?.();
    const faseAntes = c.current.phase;
    const blocosAntes = kinds(c);
    expect(faseAntes).not.toBe('streaming');
    expect(blocosAntes).not.toContain('aluy');

    for (let n = 1; n <= 3; n++) {
      retry(c, n);
      c.sink.onStart?.(); // a tentativa seguinte começa — e ainda não chegou byte nenhum
      expect(c.current.phase, 'tentativa ' + n).not.toBe('streaming');
      expect(kinds(c).filter((k) => k === 'aluy'), 'tentativa ' + n).toHaveLength(0);
      // Só o aviso de retry, e só UM.
      expect(kinds(c).filter((k) => k === 'broker-error')).toHaveLength(1);
    }
  });

  it('o primeiro byte abre a caixa E muda a fase no MESMO patch (delta ou raciocínio)', () => {
    for (const canal of ['delta', 'reasoning'] as const) {
      const c = buildController();
      c.dismissBoot();
      c.sink.onStart?.();
      if (canal === 'delta') c.sink.onDelta?.('oi');
      else c.sink.onReasoning?.('pensando…');
      expect(kinds(c), canal).toContain('aluy');
      expect(c.current.blocks.at(-1)?.kind, canal).toBe('aluy');
    }
  });

  it('turno que termina SEM byte (só tool-call) não deixa caixa vazia nem fase presa', () => {
    const c = buildController();
    c.dismissBoot();
    c.sink.onStart?.();
    c.sink.onDone?.();
    expect(kinds(c)).not.toContain('aluy');
  });
});

describe('2 · o aviso de retry não sobrevive a um retry bem-sucedido', () => {
  it('após reconectar, a caixa `tentando de novo` some no primeiro byte', () => {
    const c = buildController();
    c.dismissBoot();
    c.sink.onStart?.();
    retry(c, 1);
    expect(kinds(c)).toContain('broker-error');
    c.sink.onStart?.();
    c.sink.onDelta?.('voltei');
    expect(kinds(c)).not.toContain('broker-error');
    expect(c.current.blocks.at(-1)).toMatchObject({ kind: 'aluy', text: 'voltei' });
  });

  it('e a região viva ASSENTA no fim do turno (nada fica pinado)', () => {
    const c = buildController();
    c.dismissBoot();
    c.sink.onStart?.();
    retry(c, 1);
    retry(c, 2);
    c.sink.onStart?.();
    c.sink.onDelta?.('resposta completa');
    c.sink.onDone?.();
    const { live } = splitBlocks(c.current.blocks);
    expect(live, 'blocos ainda vivos: ' + JSON.stringify(live.map((b) => b.kind))).toHaveLength(0);
  });

  it('rede de segurança: turno que termina em erro também não deixa a caixa viva', () => {
    const c = buildController();
    c.dismissBoot();
    c.sink.onStart?.();
    retry(c, 1);
    c.sink.onDone?.();
    expect(splitBlocks(c.current.blocks).live).toHaveLength(0);
  });
});
