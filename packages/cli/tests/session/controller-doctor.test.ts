// EST-0970 (ticks AO VIVO) — o controller cria/atualiza o bloco `doctor` da checklist:
// a 1ª chamada cria (todos pending), as seguintes ATUALIZAM o MESMO bloco (cada tick
// acende ✓/⚠/✗), a final carrega o resumo — análogo ao upsert dos sub-agentes.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { DoctorCheckLine } from '../../src/session/model.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

function build(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

function doctorBlock(c: SessionController) {
  const blocks = c.current.blocks;
  const b = blocks[blocks.length - 1];
  return b?.kind === 'doctor' ? b : undefined;
}

describe('SessionController — upsertDoctor (ticks ao vivo)', () => {
  it('1ª chamada cria o bloco com todos pending; updates atualizam o MESMO bloco', () => {
    const c = build();
    const pending: DoctorCheckLine[] = [
      { id: 'auth', label: 'credencial', status: 'pending' },
      { id: 'broker', label: 'broker', status: 'pending' },
    ];
    c.upsertDoctor(pending);
    expect(c.current.blocks).toHaveLength(1);
    expect(doctorBlock(c)?.checks.every((x) => x.status === 'pending')).toBe(true);

    // tick: auth acendeu ⇒ MESMO bloco (não cria um 2º).
    c.upsertDoctor([
      { id: 'auth', label: 'credencial', status: 'ok', detail: 'u · autenticado' },
      { id: 'broker', label: 'broker', status: 'pending' },
    ]);
    expect(c.current.blocks).toHaveLength(1);
    expect(doctorBlock(c)?.checks.find((x) => x.id === 'auth')?.status).toBe('ok');
  });

  it('a chamada FINAL (com resumo) fecha o bloco; uma 2ª invocação inicia bloco novo', () => {
    const c = build();
    c.upsertDoctor([{ id: 'auth', label: 'credencial', status: 'pending' }]);
    c.upsertDoctor(
      [{ id: 'auth', label: 'credencial', status: 'ok', detail: 'ok' }],
      '1 ok · 0 aviso · 0 falha',
    );
    expect(c.current.blocks).toHaveLength(1);
    expect(doctorBlock(c)?.summary).toContain('1 ok');

    // bloco fechado (com summary) ⇒ a próxima checklist NÃO reusa: cria um 2º bloco.
    c.upsertDoctor([{ id: 'auth', label: 'credencial', status: 'pending' }]);
    expect(c.current.blocks).toHaveLength(2);
    expect(doctorBlock(c)?.summary).toBeUndefined();
  });

  // F141 — /doctor roda MID-TURN (caller próprio): o turno anexa blocos DEPOIS do doctor,
  // então ele deixa de ser o último. ANTES: cada tick empurrava um bloco NOVO ("vários
  // blocos do /doctor"), e como só o tick FINAL carrega summary, os intermediários ficavam
  // VIVOS p/ sempre ⇒ região viva inflada ⇒ tela cintilando mesmo após terminar.
  it('F141 — ticks MID-TURN (com blocos anexados depois) atualizam UM bloco e FECHAM (sem órfãos)', () => {
    const c = build();
    const doctors = () => c.current.blocks.filter((b) => b.kind === 'doctor');

    // 1º tick cria a checklist viva.
    c.upsertDoctor([
      { id: 'auth', label: 'credencial', status: 'pending' },
      { id: 'broker', label: 'broker', status: 'pending' },
    ]);
    // o TURNO segue streamando (aluy no RABO) ⇒ o doctor deixa de ser o último. (Pós-F143/F145
    // o output do turno é um aluy de stream, não uma nota — `pushNote` agora entra ACIMA do vivo.)
    c.sink.onStart?.();
    c.sink.onDelta('trabalhando no objetivo…');
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy'); // doctor não é mais o último

    // 2º tick (mid-turn): ANTES criava um 2º doctor; agora atualiza o vivo no lugar.
    c.upsertDoctor([
      { id: 'auth', label: 'credencial', status: 'ok' },
      { id: 'broker', label: 'broker', status: 'pending' },
    ]);
    c.sink.onDelta(' mais saída do turno…'); // turno segue streamando
    c.upsertDoctor([
      { id: 'auth', label: 'credencial', status: 'ok' },
      { id: 'broker', label: 'broker', status: 'ok' },
    ]);
    // UM único bloco doctor (não vários) ao longo dos ticks mid-turn.
    expect(doctors()).toHaveLength(1);
    expect(doctors()[0]!.summary).toBeUndefined(); // ainda vivo (sem summary)

    // tick FINAL (com summary): FECHA o MESMO bloco — nenhum órfão vivo permanece.
    c.upsertDoctor(
      [
        { id: 'auth', label: 'credencial', status: 'ok' },
        { id: 'broker', label: 'broker', status: 'ok' },
      ],
      '2 ok · 0 aviso · 0 falha',
    );
    expect(doctors()).toHaveLength(1);
    expect(doctors()[0]!.summary).toContain('2 ok');
    // INVARIANTE anti-flicker: zero bloco doctor VIVO (summary undefined) sobra.
    expect(
      c.current.blocks.filter((b) => b.kind === 'doctor' && b.summary === undefined),
    ).toHaveLength(0);
  });

  // F143 — /doctor DURANTE um STREAM vivo (aluy streamando no rabo): o doctor entra ANTES
  // do stream (não desaloja o rabo). ANTES: o doctor ia p/ DEPOIS do aluy ⇒ appendAluyDelta
  // virava no-op e finishAluyTurn NÃO assentava ⇒ aluy ÓRFÃO `streaming:true` (bolinha
  // piscando p/ sempre) + um 2º aluy depois do doctor ("aluy duas vezes, antes e depois").
  it('F143 — /doctor mid-STREAM não desaloja o aluy do rabo: 1 aluy, assenta, sem órfão piscando', () => {
    const c = build();
    const aluys = () => c.current.blocks.filter((b) => b.kind === 'aluy');
    const streamingAluys = () =>
      c.current.blocks.filter((b) => b.kind === 'aluy' && b.streaming === true);

    // turno em voo: o modelo começa a streamar a resposta.
    c.sink.onStart?.();
    c.sink.onDelta('resposta parcial');
    expect(streamingAluys()).toHaveLength(1); // 1 aluy streamando, no rabo
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy');

    // /doctor DISPARA mid-stream (caller próprio): deve entrar ANTES do aluy streamando.
    c.upsertDoctor([{ id: 'auth', label: 'credencial', status: 'pending' }]);
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy'); // o aluy CONTINUA no rabo (não desalojado)

    // o stream CONTINUA — appendAluyDelta tem de achar o aluy no rabo (não virar no-op).
    c.sink.onDelta(' e o resto');
    const aluyText = (aluys()[0] as { text: string }).text;
    expect(aluyText).toBe('resposta parcial e o resto'); // delta pós-doctor NÃO se perdeu

    // doctor fecha (findIndex F141) e o stream termina.
    c.upsertDoctor([{ id: 'auth', label: 'credencial', status: 'ok' }], '1 ok · 0 aviso · 0 falha');
    c.sink.onDone?.();

    // UM único aluy, ASSENTADO (sem streaming) ⇒ zero bolinha piscando órfã.
    expect(aluys()).toHaveLength(1);
    expect(streamingAluys()).toHaveLength(0);
    // ordem: doctor (fechado) ACIMA do aluy (a resposta segue por baixo).
    const kinds = c.current.blocks.map((b) => b.kind);
    expect(kinds.indexOf('doctor')).toBeLessThan(kinds.lastIndexOf('aluy'));
  });
});

// F145 (generaliza F143/F144) — QUALQUER slash-command paralelo-com-busy que só empurra uma
// NOTA (`/mcp`, `/effort`, …) usa `pushNote`. Antes do F145 o `pushNote` cru anexava no FIM
// ⇒ desalojava o aluy streaming do rabo ⇒ aluy órfão `streaming:true` (bolinha piscando) +
// flicker — exatamente como o `/doctor` do F143, mas p/ todo o resto. Agora `pushNote` insere
// antes do sufixo vivo de forma genérica (não comando-a-comando).
describe('SessionController — pushNote mid-STREAM é genérico (F145, ex.: /mcp)', () => {
  it('/mcp (note) durante stream vivo não desaloja o aluy do rabo: 1 aluy, assenta, sem órfão', () => {
    const c = build();
    const aluys = () => c.current.blocks.filter((b) => b.kind === 'aluy');
    const streamingAluys = () =>
      c.current.blocks.filter((b) => b.kind === 'aluy' && b.streaming === true);

    // turno em voo: modelo streamando.
    c.sink.onStart?.();
    c.sink.onDelta('resposta parcial');
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy');

    // /mcp dispara mid-stream e empurra UMA nota (saída read-only) — deve entrar ANTES do aluy.
    c.pushNote('mcp', ['2 servidores · 5 ferramentas']);
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy'); // aluy CONTINUA no rabo (não desalojado)

    // o stream continua — appendAluyDelta acha o aluy no rabo (não vira no-op).
    c.sink.onDelta(' e o resto');
    expect((aluys()[0] as { text: string }).text).toBe('resposta parcial e o resto');

    // turno termina ⇒ aluy assenta; nenhuma bolinha órfã.
    c.sink.onDone?.();
    expect(aluys()).toHaveLength(1);
    expect(streamingAluys()).toHaveLength(0);
    // a nota aparece ACIMA do aluy.
    const kinds = c.current.blocks.map((b) => b.kind);
    expect(kinds.indexOf('note')).toBeLessThan(kinds.lastIndexOf('aluy'));
  });

  it('NÃO-REGRESSÃO: pushNote no IDLE (sem sufixo vivo) anexa no FIM, como antes', () => {
    const c = build();
    c.pushNote('help', ['linha 1']);
    c.pushNote('usage', ['linha 2']);
    const kinds = c.current.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['note', 'note']); // ordem de chegada preservada
    expect(c.current.blocks.at(-1)?.kind).toBe('note');
  });

  it('replaceNote mid-STREAM também insere antes do sufixo vivo (não desaloja o aluy)', () => {
    const c = build();
    c.sink.onStart?.();
    c.sink.onDelta('streamando');
    c.replaceNote('cockpit', ['entrou no cockpit']);
    expect(c.current.blocks.at(-1)?.kind).toBe('aluy'); // aluy segue no rabo
    c.sink.onDelta(' ainda');
    expect(c.current.blocks.filter((b) => b.kind === 'aluy' && b.streaming === true)).toHaveLength(
      1,
    );
  });
});
