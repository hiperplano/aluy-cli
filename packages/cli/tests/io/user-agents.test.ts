// EST-1013 — UserAgentsLoader: ensureDir + load com .md válido/malformado/dir-ausente.
//
// Endurece a cobertura de packages/cli/src/io/user-agents.ts:
//   - ensureDir() cria o dir com mode 0700 (best-effort, nunca lança)
//   - load() com .md VÁLIDO devolve o perfil parseado
//   - load() com .md MALFORMADO (RES-MD-3) devolve erro, NÃO entra em profiles
//   - load() com DIR AUSENTE devolve { profiles: [], errors: [] } (fail-safe)
//   - load() pula arquivo não-.md / .md grande demais (readOne → null)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { UserAgentsLoader, AGENTS_DIRNAME } from '../../src/io/user-agents.js';

describe('EST-1013 · UserAgentsLoader — ensureDir + load (cobertura endurecida)', () => {
  let base: string;
  let agentsDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-ua-'));
    agentsDir = join(base, AGENTS_DIRNAME);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // ── (A) ensureDir ────────────────────────────────────────────────────────

  describe('ensureDir()', () => {
    it('cria o diretório de agentes com mode 0700 quando ausente', () => {
      const loader = new UserAgentsLoader({ baseDir: base });
      expect(existsSync(agentsDir)).toBe(false);
      loader.ensureDir();
      expect(existsSync(agentsDir)).toBe(true);
    });

    it('é idempotente — não lança se o diretório já existe', () => {
      mkdirSync(agentsDir, { recursive: true });
      const loader = new UserAgentsLoader({ baseDir: base });
      expect(() => loader.ensureDir()).not.toThrow();
      expect(existsSync(agentsDir)).toBe(true);
    });

    it('best-effort — nunca lança se o caminho do dir já existe como arquivo', () => {
      // Cria um arquivo no lugar do diretório agents para forçar erro no mkdirSync.
      writeFileSync(agentsDir, 'not-a-dir', { flag: 'wx' });
      const loader = new UserAgentsLoader({ baseDir: base });
      expect(() => loader.ensureDir()).not.toThrow();
    });
  });

  // ── (B) load() com .md VÁLIDO ────────────────────────────────────────────

  describe('load() — .md válido', () => {
    it('devolve um perfil parseado com origin=global', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'revisor.md'),
        '---\nname: revisor\ndescription: revisa\ntools: read_file, grep\nmodel: sonnet\n---\nVocê é o revisor.',
      );
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(errors).toEqual([]);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('revisor');
      expect(profiles[0]!.origin).toBe('global');
      expect(profiles[0]!.tools).toEqual(['read_file', 'grep']);
      expect(profiles[0]!.systemPrompt).toContain('revisor');
    });

    it('carrega múltiplos .md válidos ordenados alfabeticamente', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'b.md'), '---\nname: beta\n---\nbeta persona');
      writeFileSync(join(agentsDir, 'a.md'), '---\nname: alfa\n---\nalfa persona');
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(errors).toEqual([]);
      expect(profiles).toHaveLength(2);
      expect(profiles[0]!.name).toBe('alfa');
      expect(profiles[1]!.name).toBe('beta');
    });
  });

  // ── (C) load() com .md MALFORMADO (RES-MD-3) ────────────────────────────

  describe('load() — .md malformado (RES-MD-3)', () => {
    it('tools presente-vazio ⇒ erro coletado, perfil NÃO entra em profiles', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'bom.md'), '---\nname: bom\n---\ncorpo');
      writeFileSync(join(agentsDir, 'ruim.md'), '---\nname: ruim\ntools:\n---\ncorpo');
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(profiles.map((p) => p.name)).toEqual(['bom']);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/não carregado|inválida/);
    });

    it('name ausente ⇒ erro coletado, perfil NÃO entra', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'sem-nome.md'), '---\ndescription: x\n---\ncorpo');
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(profiles).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/sem "name" válido/);
    });

    it('corpo vazio ⇒ erro coletado, perfil NÃO entra', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'vazio.md'), '---\nname: vazio\n---\n');
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(profiles).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/corpo vazio/);
    });
  });

  // ── (D) load() DIR AUSENTE ───────────────────────────────────────────────

  describe('load() — dir ausente (fail-safe)', () => {
    it('sem o subdir agents ⇒ { profiles: [], errors: [] } sem lançar', () => {
      // agentsDir NÃO foi criado (base existe mas vazio).
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(profiles).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('baseDir inexistente ⇒ { profiles: [], errors: [] } sem lançar', () => {
      const inexistente = join(base, 'nunca-criado');
      const { profiles, errors } = new UserAgentsLoader({ baseDir: inexistente }).load();
      expect(profiles).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  // ── (E) load() pula não-.md / .md grande demais (readOne → null) ────────

  describe('load() — filtra não-.md e .md grande demais', () => {
    it('pula arquivo que não termina em .md', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'valido.md'), '---\nname: valido\n---\ncorpo');
      writeFileSync(join(agentsDir, 'nota.txt'), '---\nname: txt\n---\nignorado');
      writeFileSync(join(agentsDir, 'readme'), '---\nname: readme\n---\nignorado');
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('valido');
      expect(errors).toEqual([]);
    });

    it('pula .md maior que MAX_AGENT_BYTES (64KB)', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'pequeno.md'), '---\nname: pequeno\n---\ncorpo');
      // Cria um .md com 65KB (acima do teto de 64KB).
      const bigContent = '---\nname: gigante\n---\n' + 'x'.repeat(65 * 1024);
      writeFileSync(join(agentsDir, 'gigante.md'), bigContent);
      const { profiles, errors } = new UserAgentsLoader({ baseDir: base }).load();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('pequeno');
      expect(errors).toEqual([]);
    });
  });
});
