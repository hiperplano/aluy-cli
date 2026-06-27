// EST-XXXX — helpers PUROS do `/rewind`: seleção (recente-first + teto) e formatação
// da linha do checkpoint. Sem Ink, sem I/O.

import { describe, expect, it } from 'vitest';
import type { Checkpoint } from '@aluy/cli-core';
import {
  selectRewindCheckpoints,
  formatRewindEntry,
  REWIND_ACTIONS,
  rewindActionKey,
} from '../../src/session/rewind.js';

function cp(ordinal: number, ts: number, label = `p${ordinal}`): Checkpoint {
  return { id: `cp${ordinal}`, ordinal, ts, label, journalSeq: ordinal, blockCount: ordinal };
}

describe('rewind helpers (EST-XXXX)', () => {
  it('selectRewindCheckpoints inverte p/ recente-first e aplica o teto', () => {
    const list = [cp(1, 100), cp(2, 200), cp(3, 300)];
    expect(selectRewindCheckpoints(list).map((c) => c.id)).toEqual(['cp3', 'cp2', 'cp1']);
    expect(selectRewindCheckpoints(list, 2).map((c) => c.id)).toEqual(['cp3', 'cp2']);
  });

  it('selectRewindCheckpoints vazio ⇒ vazio (não estoura)', () => {
    expect(selectRewindCheckpoints([])).toEqual([]);
  });

  it('formatRewindEntry monta `#N · HH:MM · label`', () => {
    // 1970-01-01T00:00:00Z + offset local; só asseguramos a forma, não o fuso.
    const line = formatRewindEntry(cp(7, 0, 'arruma o login'));
    expect(line).toMatch(/^#7 · \d{2}:\d{2} · arruma o login$/);
  });

  it('REWIND_ACTIONS na ordem both/conversation/code', () => {
    expect([...REWIND_ACTIONS]).toEqual(['both', 'conversation', 'code']);
  });

  it('rewindActionKey mapeia cada ação à sua chave i18n', () => {
    expect(rewindActionKey('both')).toBe('picker.rewind.action.both');
    expect(rewindActionKey('conversation')).toBe('picker.rewind.action.conversation');
    expect(rewindActionKey('code')).toBe('picker.rewind.action.code');
  });
});
