// ADR-0158 §5 — `runActivityTurn` spawna um processo FILHO de verdade (turno
// headless `aluy -p`), então não é mockado/replicado aqui (mesma disciplina de
// `runner-fatal.test.ts`: sem mockar `child_process` pesado). Em vez disso, este
// arquivo testa as TRÊS decisões PURAS que `runActivityTurn` extraiu de dentro de
// si — `resolveActivityTimeout` (guard "expediente encerrado" + clamp do teto),
// `classifyActivityExit` (cancelado × deadline × segue) e `parseActivityTurnOutput`
// (parse+valida a última linha do `stdout` do `aluy -p --output-format json`) — os
// três pontos que ficavam sem cobertura direta (76% dos mutantes de `runner.ts`
// sem cobertura nenhuma, achado numa auditoria anterior), agora testáveis sem
// spawnar nada.
import { describe, expect, it } from 'vitest';
import {
  resolveActivityTimeout,
  classifyActivityExit,
  parseActivityTurnOutput,
} from '../../src/service/runner.js';

describe('resolveActivityTimeout — PURA (ADR-0158 §5 pt.4)', () => {
  it('deadlineMs > 0 e < cap ⇒ hasTime:true, timeoutMs = deadlineMs (o restante É o teto)', () => {
    expect(resolveActivityTimeout(5_000, 30_000)).toEqual({ hasTime: true, timeoutMs: 5_000 });
  });

  it('deadlineMs > cap ⇒ hasTime:true, timeoutMs = cap (nunca acima do teto duro)', () => {
    expect(resolveActivityTimeout(60_000, 30_000)).toEqual({ hasTime: true, timeoutMs: 30_000 });
  });

  it('deadlineMs === cap (fronteira exata) ⇒ timeoutMs = cap', () => {
    expect(resolveActivityTimeout(30_000, 30_000)).toEqual({ hasTime: true, timeoutMs: 30_000 });
  });

  it('deadlineMs === 0 ⇒ hasTime:false (expediente encerrado, nunca um timeout de 0ms)', () => {
    expect(resolveActivityTimeout(0, 30_000)).toEqual({ hasTime: false });
  });

  it('deadlineMs negativo ⇒ hasTime:false (mesmo caminho de 0 — nunca "sobra" pro Math.min)', () => {
    expect(resolveActivityTimeout(-1, 30_000)).toEqual({ hasTime: false });
  });

  it('deadlineMs === 1 (fronteira mínima COM tempo) ⇒ hasTime:true, timeoutMs = 1', () => {
    expect(resolveActivityTimeout(1, 30_000)).toEqual({ hasTime: true, timeoutMs: 1 });
  });

  it('cap default (sem 2º argumento) é MAX_ACTIVITY_MS (30 minutos)', () => {
    const THIRTY_MIN_MS = 30 * 60_000;
    expect(resolveActivityTimeout(THIRTY_MIN_MS + 1)).toEqual({ hasTime: true, timeoutMs: THIRTY_MIN_MS });
    expect(resolveActivityTimeout(THIRTY_MIN_MS - 1)).toEqual({ hasTime: true, timeoutMs: THIRTY_MIN_MS - 1 });
  });

  it('cap:"unlimited" e untilRemainingMs undefined (sem "until:" declarado) ⇒ unlimited:true, SEM timeoutMs', () => {
    expect(resolveActivityTimeout(undefined, 'unlimited')).toEqual({ hasTime: true, unlimited: true });
  });

  it('cap:"unlimited" COM "until:" declarado ainda respeita o until (regras independentes)', () => {
    expect(resolveActivityTimeout(5_000, 'unlimited')).toEqual({ hasTime: true, timeoutMs: 5_000 });
  });

  it('cap:"unlimited" com until já vencido (<=0) ⇒ hasTime:false (until sempre tem prioridade)', () => {
    expect(resolveActivityTimeout(0, 'unlimited')).toEqual({ hasTime: false });
    expect(resolveActivityTimeout(-1, 'unlimited')).toEqual({ hasTime: false });
  });

  it('untilRemainingMs undefined SEM cap "unlimited" ⇒ cai no cap numérico normal', () => {
    expect(resolveActivityTimeout(undefined, 30_000)).toEqual({ hasTime: true, timeoutMs: 30_000 });
  });
});

describe('classifyActivityExit — PURA (ADR-0158 §5)', () => {
  it('stopAborted:true ⇒ "cancelled" — TEM PRIORIDADE, mesmo com um signal presente (corrida stop×deadline)', () => {
    expect(classifyActivityExit({ stopAborted: true, signal: null })).toBe('cancelled');
    expect(classifyActivityExit({ stopAborted: true, signal: 'SIGTERM' })).toBe('cancelled');
    expect(classifyActivityExit({ stopAborted: true, signal: 'SIGKILL' })).toBe('cancelled');
  });

  it('stopAborted:false + signal !== null ⇒ "deadline" (só pode ter vindo do killGracefully do timer)', () => {
    expect(classifyActivityExit({ stopAborted: false, signal: 'SIGTERM' })).toBe('deadline');
    expect(classifyActivityExit({ stopAborted: false, signal: 'SIGKILL' })).toBe('deadline');
  });

  it('stopAborted:false + signal === null ⇒ "continue" (saída normal — segue pro parse do stdout)', () => {
    expect(classifyActivityExit({ stopAborted: false, signal: null })).toBe('continue');
  });
});

describe('parseActivityTurnOutput — PURA (ADR-0158 §5)', () => {
  it('JSON válido na última linha, com result:string + ok:boolean ⇒ devolve os dois campos', () => {
    expect(parseActivityTurnOutput('{"result":"tudo certo","ok":true}')).toEqual({
      result: 'tudo certo',
      ok: true,
    });
  });

  it('ok:false também é válido (o CALLER decide o que fazer — aqui só extrai/valida forma)', () => {
    expect(parseActivityTurnOutput('{"result":"deu erro","ok":false}')).toEqual({
      result: 'deu erro',
      ok: false,
    });
  });

  it('só a ÚLTIMA linha de stdout importa (logs/ruído em linhas anteriores são ignorados)', () => {
    const stdout = ['algum log de ruído', '{"parcial": true}', '{"result":"final","ok":true}'].join('\n');
    expect(parseActivityTurnOutput(stdout)).toEqual({ result: 'final', ok: true });
  });

  it('trailing newline/whitespace ao redor da última linha não quebra o parse', () => {
    expect(parseActivityTurnOutput('{"result":"ok","ok":true}\n\n  ')).toEqual({ result: 'ok', ok: true });
  });

  it('stdout vazio ⇒ undefined (linha vazia não é JSON válido)', () => {
    expect(parseActivityTurnOutput('')).toBeUndefined();
  });

  it('JSON malformado (sintaxe inválida) ⇒ undefined', () => {
    expect(parseActivityTurnOutput('{isto nao é json}')).toBeUndefined();
  });

  it('JSON válido mas sem o campo "result" ⇒ undefined (forma errada)', () => {
    expect(parseActivityTurnOutput('{"ok":true}')).toBeUndefined();
  });

  it('JSON válido mas sem o campo "ok" ⇒ undefined', () => {
    expect(parseActivityTurnOutput('{"result":"x"}')).toBeUndefined();
  });

  it('"result" com tipo errado (não-string) ⇒ undefined', () => {
    expect(parseActivityTurnOutput('{"result":123,"ok":true}')).toBeUndefined();
  });

  it('"ok" com tipo errado (não-boolean, ex. string "true") ⇒ undefined', () => {
    expect(parseActivityTurnOutput('{"result":"x","ok":"true"}')).toBeUndefined();
  });

  it('JSON que é um array/primitivo (não objeto) ⇒ undefined', () => {
    expect(parseActivityTurnOutput('[1,2,3]')).toBeUndefined();
    expect(parseActivityTurnOutput('42')).toBeUndefined();
    expect(parseActivityTurnOutput('"uma string qualquer"')).toBeUndefined();
  });
});
