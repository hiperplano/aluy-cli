// EST-1010 (BUG-0020) — teto de BYTES por turno de stream: o acumulador puro
// `StreamByteCap` e a fábrica `newStreamByteCap` (toggle/teto via env). Cobre o
// contrato: NÃO lança (sinaliza), bounded, idempotente, desligável.

import { describe, expect, it } from 'vitest';
import {
  StreamByteCap,
  newStreamByteCap,
  DEFAULT_MAX_STREAM_BYTES,
} from '../../src/agent/stream-cap.js';

describe('StreamByteCap — contrato do teto de bytes', () => {
  it('addText soma bytes UTF-8 e SINALIZA no chunk que cruza o teto (não lança)', () => {
    const cap = new StreamByteCap(10);
    expect(cap.addText('12345')).toBe(false); // 5 ≤ 10
    expect(cap.tripped).toBe(false);
    expect(cap.addText('67890')).toBe(false); // 10, não > 10
    expect(cap.addText('!')).toBe(true); // 11 > 10 ⇒ cruzou
    expect(cap.tripped).toBe(true);
    // idempotente: continua tripped.
    expect(cap.addText('')).toBe(true);
  });

  it('conta bytes UTF-8 reais (multibyte), não chars', () => {
    const cap = new StreamByteCap(5);
    // "é" = 2 bytes em UTF-8; "ção" = 4 bytes ⇒ 'éç' = 4 bytes, +'a' = 5 (não cruza)
    expect(cap.addText('éç')).toBe(false); // 4 bytes
    expect(cap.bytes).toBe(4);
    expect(cap.addText('ab')).toBe(true); // 6 > 5
  });

  it('addToolCall soma id+name+JSON dos args e tolera input cíclico (não lança)', () => {
    const cap = new StreamByteCap(1_000_000);
    expect(cap.addToolCall({ id: 'tc_1', name: 'read_file', input: { path: 'a.txt' } })).toBe(
      false,
    );
    expect(cap.bytes).toBeGreaterThan(0);
    // input cíclico ⇒ JSON.stringify lança ⇒ fallback de piso, sem propagar erro.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => cap.addToolCall({ id: 'x', name: 'y', input: cyclic })).not.toThrow();
  });

  it('teto 0 (sentinela de desligado) ⇒ NUNCA corta, por mais bytes que entrem', () => {
    const cap = new StreamByteCap(0);
    expect(cap.addText('x'.repeat(1_000_000))).toBe(false);
    expect(cap.tripped).toBe(false);
    expect(cap.limit).toBe(0);
  });

  it('newStreamByteCap: default ligado com o teto padrão; env baixa o teto', () => {
    const def = newStreamByteCap({});
    expect(def.limit).toBe(DEFAULT_MAX_STREAM_BYTES);

    const low = newStreamByteCap({ ALUY_STREAM_MAX_BYTES: '128' });
    expect(low.limit).toBe(128);
    // valor inválido ⇒ cai no default (não quebra).
    expect(newStreamByteCap({ ALUY_STREAM_MAX_BYTES: 'lixo' }).limit).toBe(
      DEFAULT_MAX_STREAM_BYTES,
    );
  });

  it('newStreamByteCap: ALUY_STREAM_CAP_OFF desliga (limit 0 ⇒ nunca corta)', () => {
    const off = newStreamByteCap({ ALUY_STREAM_CAP_OFF: '1' });
    expect(off.limit).toBe(0);
    expect(off.addText('x'.repeat(50_000_000))).toBe(false);
  });
});
