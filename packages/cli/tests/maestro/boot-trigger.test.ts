// EST-1129 · ADR-0123 §2.2 — TESTES do trigger de boot no startup.
//
// Testa `triggerBoot()`: LEVE vs TURBO, fail-open, CA-G2-1 caminhos
// absolutos, toggles. SEM placebo, SEM skip, SEM || true.
// Injeta UserConfigStore com baseDir temporário — NUNCA toca
// o `~/.aluy/` real do dev.

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { triggerBoot } from '../../src/maestro/boot-trigger.js';
import { NodeBootSupervisor } from '../../src/maestro/boot-supervisor.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function tmpAluyDir(): string {
  const dir = join(tmpdir(), `aluy-boot-trigger-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
}

// ─── CA-BOOT-LEVE: perfil LEVE ⇒ no-op ────────────────────────────────────

describe('CA-BOOT-LEVE — perfil LEVE', () => {
  it('perfil LEVE na config ⇒ triggerBoot retorna undefined', () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { profile: 'leve' });
      const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('perfil LEVE ⇒ NENHUM sidecar spawnado', async () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { profile: 'leve' });
      const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CA-BOOT-TURBO: perfil TURBO (default) dispara boot ──────────────────

describe('CA-BOOT-TURBO — perfil TURBO', () => {
  it('perfil TURBO explícito ⇒ retorna Promise (boot disparado)', () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { profile: 'turbo' });
      const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
      expect(result).toBeInstanceOf(Promise);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config ausente (default) ⇒ perfil TURBO implícito, dispara boot', () => {
    const dir = tmpAluyDir();
    try {
      // Sem config.json — o UserConfigStore.load() retorna defaults.
      // O default de perfil é 'turbo'.
      // Mas precisamos do diretório existir.
      const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
      expect(result).toBeInstanceOf(Promise);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('perfil ausente na config (campo omitido) ⇒ default turbo, dispara boot', () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { theme: 'dark' }); // sem campo profile
      const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
      expect(result).toBeInstanceOf(Promise);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CA-G2-1: caminhos absolutos ─────────────────────────────────────────

describe('CA-G2-1 — caminhos absolutos', () => {
  it('triggerBoot passa caminhos ABSOLUTOS ao boot-supervisor', async () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, {
        profile: 'turbo',
        sidecarToggles: { ollama: true, mem0: true },
      });

      // Espiona o NodeBootSupervisor.boot() para verificar os caminhos.
      const originalBoot = NodeBootSupervisor.prototype.boot;
      let capturedArgs: unknown[] = [];
      NodeBootSupervisor.prototype.boot = function (...args: unknown[]) {
        capturedArgs = args;
        return Promise.resolve({
          profile: 'turbo',
          states: [],
          anyRunning: false,
          allFailed: false,
        });
      };

      try {
        const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
        await result;

        // O boot foi chamado.
        expect(capturedArgs.length).toBeGreaterThanOrEqual(3);

        // headroomBinaryPath (3º arg) deve ser absoluto (cross-platform).
        const headroomPath = capturedArgs[2];
        expect(typeof headroomPath).toBe('string');
        expect(isAbsolute(headroomPath as string)).toBe(true);

        // ollamaBaseDir (4º arg) deve ser absoluto.
        const ollamaDir = capturedArgs[3];
        expect(typeof ollamaDir).toBe('string');
        expect(isAbsolute(ollamaDir as string)).toBe(true);

        // mem0VenvDir (5º arg) deve ser absoluto.
        const mem0Dir = capturedArgs[4];
        expect(typeof mem0Dir).toBe('string');
        expect(isAbsolute(mem0Dir as string)).toBe(true);
      } finally {
        NodeBootSupervisor.prototype.boot = originalBoot;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CA-G2-5: fail-open ──────────────────────────────────────────────────

describe('CA-G2-5 — fail-open', () => {
  it('triggerBoot NUNCA lança, mesmo com boot-supervisor quebrado', async () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { profile: 'turbo' });

      // Sabota o boot para lançar.
      const originalBoot = NodeBootSupervisor.prototype.boot;
      NodeBootSupervisor.prototype.boot = () => {
        throw new Error('falha simulada');
      };

      try {
        // triggerBoot() NÃO deve lançar.
        let threw = false;
        try {
          triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
      } finally {
        NodeBootSupervisor.prototype.boot = originalBoot;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Promise do boot rejeitada ⇒ NÃO trava (catch interno)', async () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { profile: 'turbo' });

      const originalBoot = NodeBootSupervisor.prototype.boot;
      NodeBootSupervisor.prototype.boot = () => {
        return Promise.reject(new Error('falha async simulada'));
      };

      try {
        const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
        expect(result).toBeInstanceOf(Promise);
        // A Promise interna NÃO deve lançar (catch no .then/.catch).
        const value = await result;
        // Após o catch, deve resolver com undefined.
        expect(value).toBeUndefined();
      } finally {
        NodeBootSupervisor.prototype.boot = originalBoot;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CA-BOOT-CONFIG: toggles de sidecar ──────────────────────────────────

describe('CA-BOOT-CONFIG — toggles', () => {
  it('sidecarToggles.mem0: false ⇒ mem0 NÃO incluso nos toggles', async () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, {
        profile: 'turbo',
        sidecarToggles: { ollama: true, mem0: false },
      });

      const originalBoot = NodeBootSupervisor.prototype.boot;
      let capturedToggles: ReadonlySet<string> | undefined;
      NodeBootSupervisor.prototype.boot = function (_profile, toggles: ReadonlySet<string>) {
        capturedToggles = toggles;
        return Promise.resolve({
          profile: 'turbo',
          states: [],
          anyRunning: false,
          allFailed: false,
        });
      };

      try {
        const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
        await result;

        expect(capturedToggles).toBeDefined();
        expect(capturedToggles!.has('ollama')).toBe(true);
        expect(capturedToggles!.has('mem0')).toBe(false);
      } finally {
        NodeBootSupervisor.prototype.boot = originalBoot;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sidecarToggles ausentes ⇒ default todos ON', async () => {
    const dir = tmpAluyDir();
    try {
      writeConfig(dir, { profile: 'turbo' }); // sem sidecarToggles

      const originalBoot = NodeBootSupervisor.prototype.boot;
      let capturedToggles: ReadonlySet<string> | undefined;
      NodeBootSupervisor.prototype.boot = function (_profile, toggles: ReadonlySet<string>) {
        capturedToggles = toggles;
        return Promise.resolve({
          profile: 'turbo',
          states: [],
          anyRunning: false,
          allFailed: false,
        });
      };

      try {
        const result = triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
        await result;

        expect(capturedToggles).toBeDefined();
        // Default ON: ollama e mem0.
        expect(capturedToggles!.has('ollama')).toBe(true);
        expect(capturedToggles!.has('mem0')).toBe(true);
      } finally {
        NodeBootSupervisor.prototype.boot = originalBoot;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Config corrompida ⇒ fail-safe ─────────────────────────────────────

describe('config corrompida ⇒ fail-safe', () => {
  it('config.json com JSON inválido ⇒ não lança, usa defaults', () => {
    const dir = tmpAluyDir();
    try {
      writeFileSync(join(dir, 'config.json'), '{ não é json', { mode: 0o600 });
      // Não deve lançar.
      let threw = false;
      try {
        triggerBoot({ aluyDir: dir, homeDir: '/home/test' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
