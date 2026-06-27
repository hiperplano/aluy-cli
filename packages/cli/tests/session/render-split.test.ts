// Anti-flicker (DoD) — splitBlocks: os turnos CONCLUÍDOS vão p/ a região `done`
// (que a App escreve no `<Static>`, uma vez); o histórico NÃO fica na região viva
// (dinâmica, re-renderizada por token/frame). Aqui provamos a ESTRUTURA do split
// (o flicker direto é difícil de testar; a prova sob PTY está no relatório).

import { describe, expect, it } from 'vitest';
import { splitBlocks, isLiveBlock } from '../../src/session/render-split.js';
import type { SessionBlock } from '../../src/session/model.js';

const you = (text: string): SessionBlock => ({ kind: 'you', text });
const aluy = (text: string, streaming: boolean): SessionBlock => ({
  kind: 'aluy',
  text,
  streaming,
});
const tool = (status: 'ok' | 'err' | 'running'): SessionBlock => ({
  kind: 'tool',
  verb: 'bash',
  target: 'npm test',
  result: status === 'running' ? '' : '0 erros',
  status,
});
const note = (): SessionBlock => ({ kind: 'note', title: '/help', lines: ['x'] });
const bang = (status: 'running' | 'ok' | 'err' | 'blocked'): SessionBlock => ({
  kind: 'bang',
  command: 'seq 1 9',
  status,
});

describe('isLiveBlock — só tool running / aluy streaming são mutáveis', () => {
  it('aluy streaming é vivo; aluy fechado é concluído', () => {
    expect(isLiveBlock(aluy('oi', true))).toBe(true);
    expect(isLiveBlock(aluy('oi', false))).toBe(false);
  });

  it('tool running é vivo; tool ok/err é concluído', () => {
    expect(isLiveBlock(tool('running'))).toBe(true);
    expect(isLiveBlock(tool('ok'))).toBe(false);
    expect(isLiveBlock(tool('err'))).toBe(false);
  });

  it('EST-0982 — `!comando` (bang) running é vivo; ok/err/blocked é concluído', () => {
    // Sem isto o bang running ia direto p/ o Static e o streaming nunca apareceria.
    expect(isLiveBlock(bang('running'))).toBe(true);
    expect(isLiveBlock(bang('ok'))).toBe(false);
    expect(isLiveBlock(bang('err'))).toBe(false);
    expect(isLiveBlock(bang('blocked'))).toBe(false);
  });

  it('you / note nunca são vivos (imutáveis ao existir)', () => {
    expect(isLiveBlock(you('oi'))).toBe(false);
    expect(isLiveBlock(note())).toBe(false);
  });

  it('EST-0970 — checklist do /doctor é VIVA sem resumo; concluída com resumo', () => {
    // Sem isto o bloco doctor caía no <Static> (escrito 1×): o seed pintava (versão ✓
    // síncrona) e os ticks ASSÍNCRONOS dos probes nunca repintavam (congelava em "testando…").
    const running: SessionBlock = {
      kind: 'doctor',
      checks: [{ id: 'auth', label: 'credencial', status: 'pending' }],
    };
    const done: SessionBlock = {
      kind: 'doctor',
      checks: [{ id: 'auth', label: 'credencial', status: 'ok' }],
      summary: '6 ok · 2 aviso · 0 falha',
    };
    expect(isLiveBlock(running)).toBe(true);
    expect(isLiveBlock(done)).toBe(false);
  });
});

describe('splitBlocks — histórico imutável (Static) vs região viva (dinâmica)', () => {
  it('sem blocos: done e live vazios', () => {
    const s = splitBlocks([]);
    expect(s.done).toEqual([]);
    expect(s.live).toEqual([]);
    expect(s.liveStart).toBe(0);
  });

  it('durante o stream: o you (concluído) vai p/ done; o aluy streaming fica vivo', () => {
    const blocks = [you('explique'), aluy('estou expli', true)];
    const s = splitBlocks(blocks);
    // o turno do usuário (histórico) está em DONE — irá p/ o <Static> (escrito 1x).
    expect(s.done).toEqual([you('explique')]);
    // a região VIVA (re-renderizada por token) NÃO contém o histórico.
    expect(s.live).toEqual([aluy('estou expli', true)]);
    expect(s.live.some((b) => b.kind === 'you')).toBe(false);
    expect(s.liveStart).toBe(1);
  });

  it('turno finalizado: tudo desce p/ done; live vazio (o último bloco entra no Static)', () => {
    const blocks = [you('oi'), aluy('resposta completa', false)];
    const s = splitBlocks(blocks);
    expect(s.done).toEqual(blocks);
    expect(s.live).toEqual([]);
  });

  it('tool running no rabo: o histórico anterior (you + aluy fechado) fica em done', () => {
    const blocks = [you('faça'), aluy('vou rodar os testes', false), tool('running')];
    const s = splitBlocks(blocks);
    expect(s.done).toEqual([you('faça'), aluy('vou rodar os testes', false)]);
    expect(s.live).toEqual([tool('running')]);
    // o histórico (2 blocos) está FORA da região viva.
    expect(s.done.length).toBe(2);
    expect(s.live.length).toBe(1);
  });

  it('múltiplos turnos passados ficam todos em done (só o sufixo vivo fica dinâmico)', () => {
    const blocks = [
      you('t1'),
      aluy('r1', false),
      you('t2'),
      aluy('r2', false),
      you('t3'),
      aluy('r3 em curso', true),
    ];
    const s = splitBlocks(blocks);
    // 5 blocos concluídos no Static; só o último (streaming) é dinâmico.
    expect(s.done.length).toBe(5);
    expect(s.live).toEqual([aluy('r3 em curso', true)]);
    // a ordem cronológica é preservada em done.
    expect(s.done.map((b) => (b.kind === 'you' ? b.text : ''))).toEqual(['t1', '', 't2', '', 't3']);
  });

  it('done + live recompõem os blocos originais na ordem (sem perda/reordem)', () => {
    const blocks = [you('a'), aluy('b', false), tool('running')];
    const s = splitBlocks(blocks);
    expect([...s.done, ...s.live]).toEqual(blocks);
  });
});

describe('splitBlocks — ÂNCORA F142: órfão vivo no meio não infla a região viva', () => {
  const doctorLive = (): SessionBlock => ({
    kind: 'doctor',
    checks: [{ id: 'auth', label: 'credencial', status: 'pending' }],
  });
  const doctorDone = (): SessionBlock => ({
    kind: 'doctor',
    checks: [{ id: 'auth', label: 'credencial', status: 'ok' }],
    summary: '9 ok · 0 aviso · 1 falha',
  });

  it('REGRESSÃO (bug do dono): doctor órfão (sem summary) no MEIO + rabo concluído ⇒ live=[]', () => {
    // Reproduz a sessão pesada resumida: 2 doctors vivos persistidos (de ANTES do F141) no
    // meio da lista, com note/aluy concluídos DEPOIS deles. Sem a âncora, liveStart caía no
    // 1º doctor e arrastava todo o sufixo p/ a viva (89 linhas > rows) ⇒ full-clear/frame.
    const blocks = [
      you('faça'),
      aluy('feito', false),
      doctorLive(),
      tool('err'),
      doctorLive(),
      aluy('resposta final', false),
      note(),
    ];
    const s = splitBlocks(blocks);
    expect(s.live).toEqual([]); // turno acabou (último é note) ⇒ nada vivo.
    expect(s.done).toEqual(blocks); // tudo desce p/ o <Static> (escrito uma vez).
    expect(s.liveStart).toBe(blocks.length);
  });

  it('GENERALIZA além do /doctor: tool órfã em running no meio + rabo concluído ⇒ live=[]', () => {
    // Stream interrompido por `/`/esc pode deixar uma tool `running` que nunca virou ok/err.
    const blocks = [you('roda'), tool('running'), aluy('respondi mesmo assim', false)];
    const s = splitBlocks(blocks);
    expect(s.live).toEqual([]);
    expect(s.done).toEqual(blocks);
  });

  it('NÃO-REGRESSÃO: turno ATIVO (último bloco vivo) preserva a região viva normal', () => {
    // Com rabo vivo a âncora NÃO dispara — o comportamento de stream segue idêntico.
    const blocks = [you('t1'), aluy('r1', false), aluy('r2 em curso', true)];
    const s = splitBlocks(blocks);
    expect(s.live).toEqual([aluy('r2 em curso', true)]);
    expect(s.liveStart).toBe(2);
  });

  it('NÃO-REGRESSÃO: doctor vivo durante turno ATIVO (rabo = tool running) segue na viva', () => {
    // F141 — /doctor roda mid-turn; enquanto a tool no rabo está running, o doctor (vivo)
    // legitimamente participa da região viva e anima. A âncora só age quando o turno acaba.
    const blocks = [you('/doctor'), doctorLive(), tool('running')];
    const s = splitBlocks(blocks);
    expect(s.live).toEqual([doctorLive(), tool('running')]);
    expect(s.liveStart).toBe(1);
  });

  it('doctor concluído (com summary) no meio nunca foi vivo ⇒ comportamento inalterado', () => {
    const blocks = [you('a'), doctorDone(), aluy('b', false)];
    const s = splitBlocks(blocks);
    expect(s.live).toEqual([]);
    expect(s.done).toEqual(blocks);
  });

  it('âncora preserva a recomposição (done + live = blocos originais)', () => {
    const blocks = [you('a'), doctorLive(), tool('err'), note()];
    const s = splitBlocks(blocks);
    expect([...s.done, ...s.live]).toEqual(blocks);
  });
});
