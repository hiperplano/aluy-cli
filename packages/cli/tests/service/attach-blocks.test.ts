// ADR-0158 §11 (FASE 4 — attach) — attach-blocks.ts: tail dos blocos NOVOS da sessão
// ATIVA do serviço (`<serviceDir>/.state/sessions/`, o MESMO `SessionStore` escopado
// que `run.tsx` usa via `ALUY_SERVICE_HOME`).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pollNewServiceBlocks,
  newAttachBlockTailState,
  summarizeSessionBlockForAttach,
} from '../../src/service/attach-blocks.js';
import { SessionStore } from '../../src/io/session-store.js';
import type { SessionBlock } from '../../src/session/model.js';

describe('summarizeSessionBlockForAttach', () => {
  it('you/aluy — texto direto', () => {
    expect(summarizeSessionBlockForAttach({ kind: 'you', text: 'oi' })).toEqual({ role: 'you', text: 'oi' });
    expect(summarizeSessionBlockForAttach({ kind: 'aluy', text: 'olá', streaming: false })).toEqual({
      role: 'aluy',
      text: 'olá',
    });
  });
  it('you/aluy vazios ⇒ undefined (nada a mostrar)', () => {
    expect(summarizeSessionBlockForAttach({ kind: 'you', text: '  ' })).toBeUndefined();
    expect(summarizeSessionBlockForAttach({ kind: 'aluy', text: '', streaming: false })).toBeUndefined();
  });
  it('tool — verbo+alvo+resultado', () => {
    const b: SessionBlock = { kind: 'tool', verb: 'read', target: 'a.ts', result: '10 linhas', status: 'ok' };
    expect(summarizeSessionBlockForAttach(b)).toEqual({ role: 'tool', text: 'read a.ts → 10 linhas' });
  });
  it('bang — comando+status', () => {
    const b: SessionBlock = { kind: 'bang', command: 'ls', status: 'ok' };
    expect(summarizeSessionBlockForAttach(b)).toEqual({ role: 'bang', text: '! ls (ok)' });
  });
  it('note — título+linhas', () => {
    const b: SessionBlock = { kind: 'note', title: 'aviso', lines: ['linha 1', 'linha 2'] };
    expect(summarizeSessionBlockForAttach(b)).toEqual({ role: 'note', text: 'aviso: linha 1 linha 2' });
  });
  it('inject (F193 — encaixe mid-turno) ⇒ voz "you"', () => {
    expect(summarizeSessionBlockForAttach({ kind: 'inject', text: 'na verdade...' })).toEqual({
      role: 'you',
      text: 'na verdade...',
    });
  });
  it('broker-error — mensagem', () => {
    expect(summarizeSessionBlockForAttach({ kind: 'broker-error', message: 'timeout' })).toEqual({
      role: 'erro',
      text: 'timeout',
    });
  });
  it('deny/doctor/subagents ⇒ undefined (UI/sistema, sem sentido no espelho textual)', () => {
    expect(summarizeSessionBlockForAttach({ kind: 'deny', verb: 'run', exact: 'rm -rf /' })).toBeUndefined();
    expect(summarizeSessionBlockForAttach({ kind: 'doctor', checks: [] })).toBeUndefined();
  });
});

describe('pollNewServiceBlocks', () => {
  let serviceDir: string;
  let store: SessionStore;

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-blocks-'));
    // `now` INJETADO e crescente — evita empate de `updatedAt` entre saves rápidos
    // no mesmo teste (o `pollNewServiceBlocks` usa `list()`, ordenado por
    // `updatedAt` DESC; um empate deixaria a ordem dependente do `readdirSync`, não
    // determinística). `pollNewServiceBlocks` cria o SEU PRÓPRIO `SessionStore`
    // (sem `now` injetado) — aqui só controlamos o RELÓGIO DA ESCRITA (`store`,
    // usado p/ preparar o fixture); a LEITURA (dentro da função testada) usa
    // `Date.now()` real, mas isso não afeta a ORDENAÇÃO (já gravada no disco).
    let clock = 1_000;
    store = new SessionStore({ baseDir: join(serviceDir, '.state'), now: () => clock++ });
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('sem sessão nenhuma ⇒ []', () => {
    const state = newAttachBlockTailState();
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([]);
  });

  it('1ª chamada devolve TODOS os blocos existentes; a 2ª só os NOVOS', () => {
    store.save({ id: 'sess1', cwd: serviceDir, tier: 'default', blocks: [{ kind: 'you', text: 'oi' }] });
    const state = newAttachBlockTailState();
    const first = pollNewServiceBlocks(serviceDir, state);
    expect(first).toEqual([{ role: 'you', text: 'oi' }]);

    // Nenhum bloco novo ainda — a 2ª chamada não repete o que já saiu.
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([]);

    // Adiciona um bloco novo ao MESMO record (mesma sessão) — só ele deve sair.
    store.save({
      id: 'sess1',
      cwd: serviceDir,
      tier: 'default',
      blocks: [
        { kind: 'you', text: 'oi' },
        { kind: 'aluy', text: 'olá, tudo bem?', streaming: false },
      ],
    });
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([{ role: 'aluy', text: 'olá, tudo bem?' }]);
  });

  it('sessão NOVA (id diferente, próxima atividade do workflow) reseta o contador — emite tudo dela', () => {
    store.save({ id: 'sess1', cwd: serviceDir, tier: 'default', blocks: [{ kind: 'you', text: 'atividade 1' }] });
    const state = newAttachBlockTailState();
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([{ role: 'you', text: 'atividade 1' }]);

    // `list()` ordena por `updatedAt` DESC — `now` cresce por chamada de `Date.now`
    // real aqui é suficiente (uma sessão nova sempre tem `updatedAt` >= a anterior).
    store.save({ id: 'sess2', cwd: serviceDir, tier: 'default', blocks: [{ kind: 'you', text: 'atividade 2' }] });
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([{ role: 'you', text: 'atividade 2' }]);
  });

  it('blocos que resumem p/ undefined (deny/doctor) são pulados mas ainda AVANÇAM o contador', () => {
    store.save({
      id: 'sess1',
      cwd: serviceDir,
      tier: 'default',
      blocks: [
        { kind: 'you', text: 'oi' },
        { kind: 'deny', verb: 'run', exact: 'rm -rf /' },
      ],
    });
    const state = newAttachBlockTailState();
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([{ role: 'you', text: 'oi' }]);
    // Nada de novo — o `deny` foi contado (emittedCount avançou) mas não teve summary.
    expect(pollNewServiceBlocks(serviceDir, state)).toEqual([]);
  });
});
