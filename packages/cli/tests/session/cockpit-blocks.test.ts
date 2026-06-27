// EST-1015 — partição dos blocos p/ o cockpit idle (opção A): notas de boot (config/
// agentes) → LOG; o resto → CONVERSA. Função PURA.

import { describe, it, expect } from 'vitest';
import {
  partitionCockpitBlocks,
  STARTUP_LOG_NOTE_TITLES,
} from '../../src/session/cockpit-blocks.js';
import type { SessionBlock } from '../../src/session/model.js';

const note = (title: string, ...lines: string[]): SessionBlock => ({ kind: 'note', title, lines });
const you = (text: string): SessionBlock => ({ kind: 'you', text });
const aluy = (text: string): SessionBlock => ({ kind: 'aluy', text, streaming: false });

describe('partitionCockpitBlocks (cockpit idle — opção A)', () => {
  it('realoca as notas de boot config/agentes p/ o LOG, conversa fica vazia', () => {
    const blocks = [note('config', 'instruções: CLAUDE.md'), note('agentes', 'revisor')];
    const { startupNotes, conversation } = partitionCockpitBlocks(blocks);
    expect(startupNotes.map((n) => n.title)).toEqual(['config', 'agentes']);
    expect(conversation).toEqual([]);
  });

  it('SÓ realoca títulos em STARTUP_LOG_NOTE_TITLES — notas acionáveis (login/model) FICAM', () => {
    const blocks = [note('config', 'x'), note('login', 'não logado'), note('agentes', 'y')];
    const { startupNotes, conversation } = partitionCockpitBlocks(blocks);
    expect(startupNotes.map((n) => n.title)).toEqual(['config', 'agentes']);
    // a nota de login (acionável) segue na conversa, na sua posição.
    expect(conversation).toHaveLength(1);
    expect((conversation[0] as { title: string }).title).toBe('login');
  });

  it('depois do 1º turno do usuário, uma nota config NÃO é mais "boot" (fica na conversa)', () => {
    const blocks = [
      note('config', 'boot'),
      you('faça X'),
      aluy('feito'),
      note('config', 'pós-turno'), // não é diagnóstico de startup — preserva na conversa
    ];
    const { startupNotes, conversation } = partitionCockpitBlocks(blocks);
    expect(startupNotes).toHaveLength(1); // só a 1ª (antes do `you`)
    expect(conversation.map((b) => b.kind)).toEqual(['you', 'aluy', 'note']);
  });

  it('conversa real (turnos) passa intacta e em ordem', () => {
    const blocks = [you('oi'), aluy('olá')];
    const { startupNotes, conversation } = partitionCockpitBlocks(blocks);
    expect(startupNotes).toEqual([]);
    expect(conversation).toEqual(blocks);
  });

  it('vazio ⇒ vazio dos dois lados', () => {
    expect(partitionCockpitBlocks([])).toEqual({ startupNotes: [], conversation: [] });
  });

  it('STARTUP_LOG_NOTE_TITLES é o conjunto puramente informativo (não inclui login/model/yolo)', () => {
    expect(STARTUP_LOG_NOTE_TITLES.has('config')).toBe(true);
    expect(STARTUP_LOG_NOTE_TITLES.has('agentes')).toBe(true);
    expect(STARTUP_LOG_NOTE_TITLES.has('login')).toBe(false);
    expect(STARTUP_LOG_NOTE_TITLES.has('model')).toBe(false);
    expect(STARTUP_LOG_NOTE_TITLES.has('yolo')).toBe(false);
  });
});
