// ADR-0158 §11 (FASE 4 — attach) — protocolo NDJSON puro (encode/parse/format), sem
// socket/fs real (isso é `cli/tests/service/attach-server.test.ts`).

import { describe, it, expect } from 'vitest';
import {
  encodeServiceAttachServerEvent,
  encodeServiceAttachClientEvent,
  parseServiceAttachServerLine,
  parseServiceAttachClientLine,
  formatServiceAttachEventForTerminal,
  formatOwnerSayInjection,
  type ServiceAttachServerEvent,
} from '@hiperplano/aluy-cli-core';

describe('encode/parse round-trip (servidor → cliente)', () => {
  it('log: codifica e faz o parse de volta idêntico', () => {
    const ev: ServiceAttachServerEvent = { t: 'log', line: 'runner iniciado', atIso: '2026-08-01T00:00:00.000Z' };
    const line = encodeServiceAttachServerEvent(ev);
    expect(line.endsWith('\n')).toBe(true);
    expect(parseServiceAttachServerLine(line)).toEqual(ev);
  });

  it('state: com detail', () => {
    const ev: ServiceAttachServerEvent = {
      t: 'state',
      turnState: 'awaiting-owner',
      detail: 'Aumento a posição?',
      atIso: '2026-08-01T00:00:01.000Z',
    };
    expect(parseServiceAttachServerLine(encodeServiceAttachServerEvent(ev))).toEqual(ev);
  });

  it('state: sem detail (campo ausente, não `undefined` explícito)', () => {
    const ev: ServiceAttachServerEvent = {
      t: 'state',
      turnState: 'sleeping',
      atIso: '2026-08-01T00:00:02.000Z',
    };
    const parsed = parseServiceAttachServerLine(encodeServiceAttachServerEvent(ev));
    expect(parsed).toEqual(ev);
    expect(parsed && 'detail' in parsed).toBe(false);
  });

  it('block: role+text', () => {
    const ev: ServiceAttachServerEvent = {
      t: 'block',
      role: 'aluy',
      text: 'fechamento do turno ok.',
      atIso: '2026-08-01T00:00:03.000Z',
    };
    expect(parseServiceAttachServerLine(encodeServiceAttachServerEvent(ev))).toEqual(ev);
  });

  it('múltiplas linhas NDJSON (uma por evento) fazem parse independente', () => {
    const a: ServiceAttachServerEvent = { t: 'log', line: 'a', atIso: 'x' };
    const b: ServiceAttachServerEvent = { t: 'log', line: 'b', atIso: 'y' };
    const blob = encodeServiceAttachServerEvent(a) + encodeServiceAttachServerEvent(b);
    const lines = blob.split('\n').filter((l) => l !== '');
    expect(lines.map(parseServiceAttachServerLine)).toEqual([a, b]);
  });
});

describe('parseServiceAttachServerLine — entrada hostil/malformada nunca lança', () => {
  it('linha vazia ⇒ undefined', () => {
    expect(parseServiceAttachServerLine('')).toBeUndefined();
    expect(parseServiceAttachServerLine('   \n')).toBeUndefined();
  });
  it('JSON inválido ⇒ undefined', () => {
    expect(parseServiceAttachServerLine('{isto não é json')).toBeUndefined();
  });
  it('JSON válido mas não-objeto ⇒ undefined', () => {
    expect(parseServiceAttachServerLine('42')).toBeUndefined();
    expect(parseServiceAttachServerLine('"string"')).toBeUndefined();
    expect(parseServiceAttachServerLine('null')).toBeUndefined();
  });
  it('`t` desconhecido ⇒ undefined', () => {
    expect(parseServiceAttachServerLine('{"t":"desconhecido"}')).toBeUndefined();
  });
  it('`t:"state"` com turnState fora da união ⇒ undefined', () => {
    expect(parseServiceAttachServerLine('{"t":"state","turnState":"acordado"}')).toBeUndefined();
  });
  it('`t:"log"` sem `line` ⇒ undefined', () => {
    expect(parseServiceAttachServerLine('{"t":"log"}')).toBeUndefined();
  });
});

describe('say (cliente → servidor)', () => {
  it('round-trip', () => {
    const line = encodeServiceAttachClientEvent({ t: 'say', text: 'aumenta pra 3 lotes' });
    expect(parseServiceAttachClientLine(line)).toEqual({ t: 'say', text: 'aumenta pra 3 lotes' });
  });
  it('texto vazio ainda é um `say` válido no protocolo (quem decide descartar é o runner)', () => {
    expect(parseServiceAttachClientLine('{"t":"say","text":""}')).toEqual({ t: 'say', text: '' });
  });
  it('entrada hostil ⇒ undefined (nunca lança)', () => {
    expect(parseServiceAttachClientLine('{"t":"say"}')).toBeUndefined();
    expect(parseServiceAttachClientLine('não é json')).toBeUndefined();
    expect(parseServiceAttachClientLine('{"t":"outracoisa","text":"x"}')).toBeUndefined();
  });
});

describe('formatServiceAttachEventForTerminal', () => {
  it('log', () => {
    expect(formatServiceAttachEventForTerminal({ t: 'log', line: 'x', atIso: 'y' })).toBe('· x');
  });
  it('state com detail', () => {
    const s = formatServiceAttachEventForTerminal({
      t: 'state',
      turnState: 'running-turn',
      detail: 'atividade 1/3',
      atIso: 'y',
    });
    expect(s).toContain('turno em andamento');
    expect(s).toContain('atividade 1/3');
  });
  it('state sem detail', () => {
    const s = formatServiceAttachEventForTerminal({ t: 'state', turnState: 'sleeping', atIso: 'y' });
    expect(s).toContain('dormindo');
  });
  it('block', () => {
    const s = formatServiceAttachEventForTerminal({ t: 'block', role: 'you', text: 'oi', atIso: 'y' });
    expect(s).toBe('[you] oi');
  });
});

describe('formatOwnerSayInjection (ADR-0158 §11 — degrade documentado)', () => {
  it('uma fala', () => {
    const text = formatOwnerSayInjection(['aumenta pra 3 lotes']);
    expect(text).toContain('aumenta pra 3 lotes');
    expect(text).toContain('aluy service attach');
  });
  it('múltiplas falas acumuladas — todas presentes, em ordem', () => {
    const text = formatOwnerSayInjection(['primeira', 'segunda']);
    const iPrimeira = text.indexOf('primeira');
    const iSegunda = text.indexOf('segunda');
    expect(iPrimeira).toBeGreaterThan(-1);
    expect(iSegunda).toBeGreaterThan(iPrimeira);
  });
});
