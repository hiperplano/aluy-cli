// EST-XXXX — rewind de CONVERSA do SessionController: trunca a transcrição visível ao
// ponto E re-semeia o contexto do modelo a partir do prefixo (turnos posteriores somem
// da tela e do contexto). Reusa o caminho do /history-ao-vivo (resetResumeContext +
// seedHistory). Aqui provamos o COMPORTAMENTO observável: blocos truncados + nº
// descartado correto + guarda em turno-vivo (não roda no meio).

import { describe, expect, it } from 'vitest';
import type {
  HistoryItem,
  ModelCaller,
  ToolPorts,
  FileSystemPort,
  ShellPort,
  SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { blocksToHistory } from '../../src/io/index.js';
import type { SessionBlock } from '../../src/session/model.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      throw new Error('n/a');
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

const NOOP_CALLER: ModelCaller = {
  async call() {
    return { text: '', usage: { tokens_in: 0, tokens_out: 0, tokens: 0 } };
  },
};

function newController(): SessionController {
  return new SessionController({
    model: NOOP_CALLER,
    permission: { decide: async () => ({ kind: 'allow' }) } as never,
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    watchdogEnv: { ALUY_STUCK_OFF: '1' },
  });
}

/** Transcrição de teste: dois turnos (you/aluy) + um terceiro you/aluy. */
const TRANSCRIPT: readonly SessionBlock[] = [
  { kind: 'you', text: 'primeiro' },
  { kind: 'aluy', text: 'resposta 1', streaming: false },
  { kind: 'you', text: 'segundo' },
  { kind: 'aluy', text: 'resposta 2', streaming: false },
  { kind: 'you', text: 'terceiro' },
  { kind: 'aluy', text: 'resposta 3', streaming: false },
];

describe('SessionController.rewindConversation (EST-XXXX)', () => {
  it('trunca a transcrição visível ao blockCount e devolve o nº descartado', () => {
    const c = newController();
    c.restoreBlocks(TRANSCRIPT);
    expect(c.blocks).toHaveLength(6);

    // rebobina ao ponto após o 1º turno (blockCount=2: you+aluy do 1º).
    const dropped = c.rewindConversation(2, blocksToHistory);
    expect(dropped).toBe(4);
    expect(
      c.blocks.map((b) => (b.kind === 'you' ? b.text : `=${(b as { text: string }).text}`)),
    ).toEqual(['primeiro', '=resposta 1']);
    expect(c.current.phase).toBe('idle');
  });

  it('blockCount >= len ⇒ nada descartado (já está no ponto)', () => {
    const c = newController();
    c.restoreBlocks(TRANSCRIPT);
    expect(c.rewindConversation(6, blocksToHistory)).toBe(0);
    expect(c.rewindConversation(99, blocksToHistory)).toBe(0);
    expect(c.blocks).toHaveLength(6);
  });

  it('blockCount 0 ⇒ esvazia a transcrição', () => {
    const c = newController();
    c.restoreBlocks(TRANSCRIPT);
    const dropped = c.rewindConversation(0, blocksToHistory);
    expect(dropped).toBe(6);
    expect(c.blocks).toHaveLength(0);
  });

  it('blockCount negativo é clampado a 0 (sem estourar)', () => {
    const c = newController();
    c.restoreBlocks(TRANSCRIPT);
    expect(c.rewindConversation(-5, blocksToHistory)).toBe(6);
    expect(c.blocks).toHaveLength(0);
  });

  it('re-semeia o contexto do modelo com o PREFIXO (toHistory recebe só os mantidos)', () => {
    const c = newController();
    c.restoreBlocks(TRANSCRIPT);
    let seededWith: readonly SessionBlock[] | undefined;
    const spyToHistory = (blocks: readonly SessionBlock[]): readonly HistoryItem[] => {
      seededWith = blocks;
      return blocksToHistory(blocks);
    };
    c.rewindConversation(4, spyToHistory); // mantém os 2 primeiros turnos
    expect(seededWith?.map((b) => b.kind)).toEqual(['you', 'aluy', 'you', 'aluy']);
  });
});
