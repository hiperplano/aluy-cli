// Anti-flicker (DoD) — splitBlocks: os turnos CONCLUÍDOS vão p/ a região `done`
// (que a App escreve no `<Static>`, uma vez); o histórico NÃO fica na região viva
// (dinâmica, re-renderizada por token/frame). Aqui provamos a ESTRUTURA do split
// (o flicker direto é difícil de testar; a prova sob PTY está no relatório).

import { describe, expect, it } from 'vitest';
import { splitBlocks, isLiveBlock, sanitizeOrphans } from '../../src/session/render-split.js';
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

// #13 (ghost "rodando") — o bloco VIVO segue VIVO até resolver, MESMO quando NÃO é o rabo.
// A premissa antiga (bloco vivo no meio ⇒ órfão ⇒ shove p/ Static) foi MOVIDA p/ a fonte
// (`sanitizeOrphans` no restore). Aqui provamos as DUAS metades do fix:
//   (A) `splitBlocks` NUNCA congela um bloco vivo no Static só porque um não-vivo o segue;
//   (B) `sanitizeOrphans` imobiliza órfãos PERSISTIDOS no instante da restauração.
describe('#13 — bloco vivo (running) segue FORA do Static mesmo sem ser o rabo', () => {
  const doctorLive = (): SessionBlock => ({
    kind: 'doctor',
    checks: [{ id: 'auth', label: 'credencial', status: 'pending' }],
  });
  const doctorDone = (): SessionBlock => ({
    kind: 'doctor',
    checks: [{ id: 'auth', label: 'credencial', status: 'ok' }],
    summary: '9 ok · 0 aviso · 1 falha',
  });

  it('RAIZ do bug: `!cmd` running + nota DEPOIS dele ⇒ o bang FICA vivo (não congela no Static)', () => {
    // O cenário do dono: um `!sleep 30` em voo (running) e uma nota (`↳ encaixado` / `turno
    // interrompido`) empurrada DEPOIS dele. Antes, a âncora arrastava o bang AINDA VIVO p/
    // done ⇒ `○ rodando` escrito UMA vez no scrollback e nunca repintado ao resolver = ghost.
    // Agora o sufixo a partir do bang (incl. a nota) permanece VIVO ⇒ resolve in-place.
    const blocks = [you('!sleep 30'), bang('running'), note()];
    const s = splitBlocks(blocks);
    expect(s.liveStart).toBe(1); // a região viva começa no bang
    expect(s.live).toEqual([bang('running'), note()]);
    expect(s.done.some((b) => b.kind === 'bang')).toBe(false); // o bang NÃO está no Static
  });

  it('tool running + aluy concluído depois ⇒ a tool segue VIVA (resolve in-place)', () => {
    const blocks = [you('roda'), tool('running'), aluy('texto', false)];
    const s = splitBlocks(blocks);
    expect(s.liveStart).toBe(1);
    expect(s.live).toEqual([tool('running'), aluy('texto', false)]);
  });

  it('NÃO-REGRESSÃO: turno ATIVO (último bloco vivo) preserva a região viva normal', () => {
    const blocks = [you('t1'), aluy('r1', false), aluy('r2 em curso', true)];
    const s = splitBlocks(blocks);
    expect(s.live).toEqual([aluy('r2 em curso', true)]);
    expect(s.liveStart).toBe(2);
  });

  it('NÃO-REGRESSÃO: doctor vivo durante turno ATIVO (rabo = tool running) segue na viva', () => {
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

  it('recomposição preservada (done + live = blocos originais)', () => {
    const blocks = [you('a'), bang('running'), note()];
    const s = splitBlocks(blocks);
    expect([...s.done, ...s.live]).toEqual(blocks);
  });
});

describe('sanitizeOrphans — órfãos persistidos (resume) imobilizados na fonte', () => {
  it('bang running órfão ⇒ err honesto, com o liveOutput virando saída final', () => {
    const blocks: SessionBlock[] = [
      you('!sleep 30'),
      { kind: 'bang', command: 'sleep 30', status: 'running', liveOutput: 'parcial…' },
    ];
    const [, b] = sanitizeOrphans(blocks);
    expect(b).toMatchObject({ kind: 'bang', status: 'err', output: 'parcial…' });
    expect(isLiveBlock(b!)).toBe(false); // imobilizado ⇒ desce p/ o Static no restore
    // sem liveOutput remanescente (não duplica saída).
    expect((b as { liveOutput?: string }).liveOutput).toBeUndefined();
  });

  it('tool running órfã ⇒ err (com result "interrompido" se vazio)', () => {
    const [b] = sanitizeOrphans([tool('running')]);
    expect(b).toMatchObject({ kind: 'tool', status: 'err', result: 'interrompido' });
    expect(isLiveBlock(b!)).toBe(false);
  });

  it('aluy streaming órfão ⇒ streaming:false', () => {
    const [b] = sanitizeOrphans([aluy('meio de uma fala', true)]);
    expect(b).toMatchObject({ kind: 'aluy', streaming: false });
    expect(isLiveBlock(b!)).toBe(false);
  });

  it('doctor sem summary ⇒ ganha resumo; broker-error retrying ⇒ retrying:false', () => {
    const doctor: SessionBlock = {
      kind: 'doctor',
      checks: [{ id: 'auth', label: 'credencial', status: 'pending' }],
    };
    const broker: SessionBlock = { kind: 'broker-error', message: 'x', retrying: true };
    const [d, b] = sanitizeOrphans([doctor, broker]);
    expect(isLiveBlock(d!)).toBe(false);
    expect(isLiveBlock(b!)).toBe(false);
  });

  it('subagents com filho running ⇒ filho cancelled (a11y honesta)', () => {
    const sa: SessionBlock = {
      kind: 'subagents',
      children: [
        { label: 'rust', status: 'running' },
        { label: 'go', status: 'done', summary: '1k tokens' },
      ],
    };
    const [b] = sanitizeOrphans([sa]);
    expect(isLiveBlock(b!)).toBe(false);
    expect((b as { children: { status: string }[] }).children[0]!.status).toBe('cancelled');
  });

  it('blocos JÁ terminais / imutáveis passam INTACTOS (cópia 1:1)', () => {
    const blocks = [you('a'), aluy('b', false), tool('ok'), bang('blocked'), note()];
    expect(sanitizeOrphans(blocks)).toEqual(blocks);
  });

  it('REGRESSÃO (bug do dono): sessão pesada com órfãos no meio, pós-saneamento ⇒ live=[]', () => {
    // A sessão retomada antes inflava a viva (89 linhas > rows) pela âncora. Agora o restore
    // saneia os órfãos ANTES de assentar o estado ⇒ splitBlocks vê tudo terminal ⇒ live=[].
    const raw: SessionBlock[] = [
      you('faça'),
      aluy('feito', false),
      { kind: 'doctor', checks: [{ id: 'a', label: 'cred', status: 'pending' }] },
      tool('running'),
      aluy('resposta final', false),
      note(),
    ];
    const s = splitBlocks(sanitizeOrphans(raw));
    expect(s.live).toEqual([]); // nada vivo após o saneamento
    expect(s.done.length).toBe(raw.length); // tudo desce p/ o <Static>
  });
});
