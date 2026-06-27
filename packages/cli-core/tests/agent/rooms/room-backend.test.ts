// EST-1119 · ADR-0121 — Testes do resolveRoomBackend (portável).
//
// CA-4 (não-regressão DURA): sem opt-in = memory, zero side-effect.
// CA-SELEÇÃO: precedência env > config > default.
// CA-SELEÇÃO §5.2: env vence config.
// fail-closed: inválido ⇒ memory + aviso.
// CA-BROKER §9.5: seam loopback/broker são valores VÁLIDOS (erro LOUD é
//   responsabilidade do wiring, não do core).

import { describe, it, expect } from 'vitest';
import {
  resolveRoomBackend,
  ROOM_BACKENDS,
  DEFAULT_ROOM_BACKEND,
} from '../../../src/agent/rooms/room-backend.js';

// ---------------------------------------------------------------------------
// CA-4: Não-regressão DURA — sem opt-in = memory
// ---------------------------------------------------------------------------

describe('CA-4: não-regressão — sem opt-in = memory (default)', () => {
  it('sem env e sem config ⇒ memory', () => {
    const { backend, warning } = resolveRoomBackend(undefined, undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeUndefined();
  });

  it('env vazia e sem config ⇒ memory', () => {
    const { backend, warning } = resolveRoomBackend('', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeUndefined();
  });

  it('config vazio e sem env ⇒ memory', () => {
    const { backend, warning } = resolveRoomBackend(undefined, '');
    expect(backend).toBe('memory');
    expect(warning).toBeUndefined();
  });

  it('env=memory e sem config ⇒ memory (explícito)', () => {
    const { backend, warning } = resolveRoomBackend('memory', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeUndefined();
  });

  it('env=memory (case misto) ⇒ memory', () => {
    const { backend, warning } = resolveRoomBackend('Memory', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeUndefined();
  });

  it('env com espaços " memory " ⇒ memory', () => {
    const { backend, warning } = resolveRoomBackend('  memory  ', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CA-SELEÇÃO: seleção por valor
// ---------------------------------------------------------------------------

describe('CA-SELEÇÃO: seleção de backend por valor', () => {
  it('env=file ⇒ file', () => {
    const { backend, warning } = resolveRoomBackend('file', undefined);
    expect(backend).toBe('file');
    expect(warning).toBeUndefined();
  });

  it('config=file (sem env) ⇒ file', () => {
    const { backend, warning } = resolveRoomBackend(undefined, 'file');
    expect(backend).toBe('file');
    expect(warning).toBeUndefined();
  });

  it('env=loopback ⇒ loopback (valor válido)', () => {
    const { backend, warning } = resolveRoomBackend('loopback', undefined);
    expect(backend).toBe('loopback');
    expect(warning).toBeUndefined();
  });

  it('env=broker ⇒ broker (valor válido)', () => {
    const { backend, warning } = resolveRoomBackend('broker', undefined);
    expect(backend).toBe('broker');
    expect(warning).toBeUndefined();
  });

  it('todos os backends do ROOM_BACKENDS são reconhecidos', () => {
    for (const b of ROOM_BACKENDS) {
      const { backend, warning } = resolveRoomBackend(b, undefined);
      expect(backend).toBe(b);
      expect(warning).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// CA-SELEÇÃO §5.2: precedência env > config > default
// ---------------------------------------------------------------------------

describe('CA-SELEÇÃO §5.2: precedência env > config > default', () => {
  it('env=file vence config=memory', () => {
    const { backend } = resolveRoomBackend('file', 'memory');
    expect(backend).toBe('file');
  });

  it('env=memory vence config=file (env SEMPRE vence)', () => {
    const { backend } = resolveRoomBackend('memory', 'file');
    expect(backend).toBe('memory');
  });

  it('env=file vence config=loopback', () => {
    const { backend } = resolveRoomBackend('file', 'loopback');
    expect(backend).toBe('file');
  });

  it('sem env, config=file vence default=memory', () => {
    const { backend } = resolveRoomBackend(undefined, 'file');
    expect(backend).toBe('file');
  });

  it('sem env e sem config ⇒ default memory (não-regressão)', () => {
    const { backend } = resolveRoomBackend(undefined, undefined);
    expect(backend).toBe('memory');
  });
});

// ---------------------------------------------------------------------------
// fail-closed: inválido ⇒ memory + aviso
// ---------------------------------------------------------------------------

describe('fail-closed: valor inválido ⇒ memory + aviso', () => {
  it('env=foo ⇒ memory + aviso', () => {
    const { backend, warning } = resolveRoomBackend('foo', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeDefined();
    expect(warning!).toContain('foo');
    expect(warning!).toContain('memory');
  });

  it('config=invalid (sem env) ⇒ memory + aviso', () => {
    const { backend, warning } = resolveRoomBackend(undefined, 'invalid');
    expect(backend).toBe('memory');
    expect(warning).toBeDefined();
    expect(warning!).toContain('invalid');
  });

  it('env=FILE (case ok, mas "FILE" não é valor, "file" é — should pass)', () => {
    // Case-insensitive: "FILE" → "file" (válido)
    const { backend, warning } = resolveRoomBackend('FILE', undefined);
    expect(backend).toBe('file');
    expect(warning).toBeUndefined();
  });

  it('env=null_like_string ⇒ memory + aviso', () => {
    const { backend, warning } = resolveRoomBackend('null', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeDefined();
  });

  it('env=0 ⇒ memory + aviso', () => {
    const { backend, warning } = resolveRoomBackend('0', undefined);
    expect(backend).toBe('memory');
    expect(warning).toBeDefined();
  });

  it('NUNCA cai em transporte mais aberto (file) com valor inválido', () => {
    // Este é o teste de SEGURANÇA: um valor inválido NÃO pode resultar em file.
    for (const bad of ['foo', 'bar', 'x', 'unknown', 'none', 'off', 'disabled']) {
      const { backend } = resolveRoomBackend(bad, undefined);
      expect(backend).toBe('memory');
    }
  });

  it('NUNCA cai em loopback/broker com valor inválido', () => {
    for (const bad of ['foo', 'bar', 'xyz']) {
      const { backend } = resolveRoomBackend(bad, undefined);
      expect(backend).not.toBe('loopback');
      expect(backend).not.toBe('broker');
    }
  });

  it('config e env ambos inválidos ⇒ memory (não propaga erro do config)', () => {
    const { backend, warning } = resolveRoomBackend('bad1', 'bad2');
    expect(backend).toBe('memory');
    // warning menciona o valor da env (que é o que foi usado)
    expect(warning!).toContain('bad1');
  });
});

// ---------------------------------------------------------------------------
// CA-BROKER §9.5: seam loopback/broker são valores válidos
// ---------------------------------------------------------------------------

describe('CA-BROKER §9.5: seam loopback/broker são valores válidos', () => {
  it('loopback é reconhecido como valor válido', () => {
    const { backend, warning } = resolveRoomBackend('loopback', undefined);
    expect(backend).toBe('loopback');
    expect(warning).toBeUndefined();
  });

  it('broker é reconhecido como valor válido', () => {
    const { backend, warning } = resolveRoomBackend('broker', undefined);
    expect(backend).toBe('broker');
    expect(warning).toBeUndefined();
  });

  it('loopback e broker NÃO disparam fail-closed', () => {
    // Eles são válidos; o erro LOUD pela ausência da implementação
    // é responsabilidade do wiring (@hiperplano/aluy-cli), não do core.
    for (const b of ['loopback', 'broker'] as const) {
      const { backend, warning } = resolveRoomBackend(b, undefined);
      expect(backend).toBe(b);
      expect(warning).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ROOM_BACKEND e ROOM_BACKENDS sanity
// ---------------------------------------------------------------------------

describe('Constantes', () => {
  it('DEFAULT_ROOM_BACKEND é memory', () => {
    expect(DEFAULT_ROOM_BACKEND).toBe('memory');
  });

  it('ROOM_BACKENDS contém os 4 valores', () => {
    expect(ROOM_BACKENDS).toEqual(['memory', 'file', 'loopback', 'broker']);
  });

  it('DEFAULT_ROOM_BACKEND está em ROOM_BACKENDS', () => {
    expect(ROOM_BACKENDS).toContain(DEFAULT_ROOM_BACKEND);
  });
});
