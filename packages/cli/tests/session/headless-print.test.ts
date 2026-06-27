// EST-1007 — MODO HEADLESS one-shot (`aluy -p "prompt"`, igual `claude -p`).
//
// Prova do `runHeadlessPrint`: roda o objetivo pelo MESMO loop/catraca (via
// `controller.submit`) e devolve SÓ o TEXTO FINAL do assistente — sem o chrome
// rotulado do `runLinear` (`[aluy]`/`[tool]`/notas). É a LÓGICA de extração do
// resultado scriptável + o veredito (ok/falha) que o binário liga ao exit code.
//
// Usamos um controller-fake que implementa o contrato que `runHeadlessPrint` toca:
// `submit` (publica os blocos finais), o getter `blocks` e `tier`/`model` (json).

import { describe, expect, it } from 'vitest';
import { runHeadlessPrint } from '../../src/session/linear.js';
import { SessionController } from '../../src/session/controller.js';
import type { SessionBlock } from '../../src/session/model.js';

/** Detecta QUALQUER sequência de escape ANSI (CSI / OSC) — prova "sem ANSI". */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^]*/;

/**
 * Controller-fake: ao `submit`, "publica" a lista final de blocos (o que o loop real
 * deixaria ao terminar o turno). `runHeadlessPrint` os lê pelo getter `blocks`.
 */
function fakeController(
  finalBlocks: readonly SessionBlock[],
  meta: { tier?: string; model?: string } = {},
): SessionController {
  let current: readonly SessionBlock[] = [];
  const ctrl = {
    async submit(): Promise<void> {
      current = finalBlocks;
    },
    get blocks(): readonly SessionBlock[] {
      return current;
    },
    get tier(): string {
      return meta.tier ?? 'aluy-flux';
    },
    get model(): string | undefined {
      return meta.model;
    },
  };
  return ctrl as unknown as SessionController;
}

describe('runHeadlessPrint — resultado LIMPO + veredito (EST-1007)', () => {
  it('devolve SÓ o texto final do assistente (sem rótulo [aluy], sem chrome)', async () => {
    const ctrl = fakeController([
      { kind: 'you', text: 'qual é a capital da França?' },
      { kind: 'tool', verb: 'read', target: 'x', result: 'ok', status: 'ok' },
      { kind: 'aluy', text: 'A capital da França é Paris.', streaming: false },
    ]);
    const res = await runHeadlessPrint(ctrl, 'qual é a capital da França?');
    expect(res.ok).toBe(true);
    expect(res.result).toBe('A capital da França é Paris.');
    // SEM o rótulo [aluy], SEM as linhas de tool, SEM o eco [você].
    expect(res.result).not.toMatch(/\[aluy\]|\[tool\]|\[você\]/);
    expect(res.diagnostic).toBeUndefined();
  });

  it('o resultado é texto PLANO sem ANSI (scriptável)', async () => {
    const ctrl = fakeController([{ kind: 'aluy', text: 'resposta simples', streaming: false }]);
    const res = await runHeadlessPrint(ctrl, 'oi');
    expect(res.result).not.toMatch(ANSI);
  });

  it('pega a ÚLTIMA fala aluy estabilizada (ignora um aluy ainda streaming)', async () => {
    const ctrl = fakeController([
      { kind: 'aluy', text: 'parcial…', streaming: true },
      { kind: 'aluy', text: 'resposta final completa.', streaming: false },
    ]);
    const res = await runHeadlessPrint(ctrl, 'x');
    expect(res.result).toBe('resposta final completa.');
  });

  it('broker-error ⇒ ok:false, resultado VAZIO, diagnóstico p/ o stderr (HG-2 neutro)', async () => {
    const ctrl = fakeController([
      { kind: 'you', text: 'faça x' },
      { kind: 'broker-error', message: 'broker indisponível', status: 503 },
    ]);
    const res = await runHeadlessPrint(ctrl, 'faça x');
    expect(res.ok).toBe(false);
    expect(res.result).toBe('');
    expect(res.diagnostic).toMatch(/broker/i);
    expect(res.diagnostic).toMatch(/503/);
    // HG-2: o diagnóstico não revela provider/credencial.
    expect(res.diagnostic).not.toMatch(/api[_-]?key|openrouter|anthropic|provider/i);
  });

  it('turno SEM fala final (só-tool) ⇒ ok:false (exit≠0 confiável p/ script)', async () => {
    const ctrl = fakeController([
      { kind: 'you', text: 'faça x' },
      { kind: 'tool', verb: 'edit', target: 'a.txt', result: 'ok', status: 'ok' },
    ]);
    const res = await runHeadlessPrint(ctrl, 'faça x');
    expect(res.ok).toBe(false);
    expect(res.result).toBe('');
    expect(res.diagnostic).toMatch(/resposta final/i);
  });

  it('limpa marcadores de protocolo da fala (cleanAluyForDisplay) — mesma limpeza do linear', async () => {
    // Um texto com prefixo/marcador de protocolo deve sair limpo (sem o ruído).
    const ctrl = fakeController([
      { kind: 'aluy', text: '  Paris é a resposta.  ', streaming: false },
    ]);
    const res = await runHeadlessPrint(ctrl, 'x');
    expect(res.result).toBe('Paris é a resposta.'); // trim aplicado.
  });
});
