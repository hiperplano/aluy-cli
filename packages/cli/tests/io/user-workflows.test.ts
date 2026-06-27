// EST-1105 — UserWorkflowsLoader: ensureDir + load com .md válido/malformado/dir-ausente.
//
// Cobertura de packages/cli/src/io/user-workflows.ts:
//   - ensureDir() cria o dir com mode 0700 (best-effort, nunca lança)
//   - load() com .md VÁLIDO devolve o workflow parseado
//   - load() com .md MALFORMADO (RES-MD-3) devolve erro, NÃO entra em workflows
//   - load() com DIR AUSENTE devolve { workflows: [], errors: [] } (fail-safe)
//   - load() pula arquivo não-.md / .md grande demais (readOne → null)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { UserWorkflowsLoader, WORKFLOWS_DIRNAME } from '../../src/io/user-workflows.js';

describe('EST-1105 · UserWorkflowsLoader — ensureDir + load', () => {
  let base: string;
  let wfDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-uw-'));
    wfDir = join(base, WORKFLOWS_DIRNAME);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // ── ensureDir ────────────────────────────────────────────────────────────

  describe('ensureDir()', () => {
    it('cria o diretório de workflows quando ausente', () => {
      const loader = new UserWorkflowsLoader({ baseDir: base });
      expect(existsSync(wfDir)).toBe(false);
      loader.ensureDir();
      expect(existsSync(wfDir)).toBe(true);
    });

    it('é idempotente — não lança se o diretório já existe', () => {
      mkdirSync(wfDir, { recursive: true });
      const loader = new UserWorkflowsLoader({ baseDir: base });
      expect(() => loader.ensureDir()).not.toThrow();
      expect(existsSync(wfDir)).toBe(true);
    });

    it('best-effort — nunca lança se o caminho já existe como arquivo', () => {
      writeFileSync(wfDir, 'not-a-dir', { flag: 'wx' });
      const loader = new UserWorkflowsLoader({ baseDir: base });
      expect(() => loader.ensureDir()).not.toThrow();
    });
  });

  // ── load() com .md VÁLIDO ────────────────────────────────────────────────

  describe('load() — .md válido', () => {
    it('devolve um workflow parseado com origin=global', () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(
        join(wfDir, 'sdlc.md'),
        [
          '---',
          'name: sdlc-estoria',
          'description: Fluxo de implementação',
          '---',
          '1. entender — Leia a estória.',
          '2. implementar — Implemente o código.',
          '3. testar — Rode build/lint/testes.',
        ].join('\n'),
      );
      const { workflows } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(workflows).toHaveLength(1);
      expect(workflows[0]!.name).toBe('sdlc-estoria');
      expect(workflows[0]!.origin).toBe('global');
      expect(workflows[0]!.activities).toHaveLength(3);
    });

    it('carrega múltiplos .md válidos ordenados alfabeticamente', () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'b.md'), '---\nname: beta\n---\n1. a — goal b');
      writeFileSync(join(wfDir, 'a.md'), '---\nname: alfa\n---\n1. a — goal a');
      const { workflows, errors } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(errors).toEqual([]);
      expect(workflows).toHaveLength(2);
      expect(workflows[0]!.name).toBe('alfa');
      expect(workflows[1]!.name).toBe('beta');
    });
  });

  // ── load() com .md MALFORMADO (RES-MD-3) ────────────────────────────────

  describe('load() — .md malformado (RES-MD-3)', () => {
    it('sem name ⇒ erro coletado, workflow NÃO entra', () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'bom.md'), '---\nname: bom\n---\n1. a — goal');
      writeFileSync(join(wfDir, 'ruim.md'), '---\ndescription: sem nome\n---\n1. a — goal');
      const { workflows, errors } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(workflows.map((w) => w.name)).toEqual(['bom']);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/sem "name"/);
    });

    it('sem atividades ⇒ erro coletado, workflow NÃO entra', () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'sem-atv.md'), '---\nname: vazio\n---\nsem atividade');
      const { workflows, errors } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(workflows).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/nenhuma atividade/);
    });
  });

  // ── load() DIR AUSENTE ───────────────────────────────────────────────────

  describe('load() — dir ausente (fail-safe)', () => {
    it('sem o subdir workflows ⇒ { workflows: [], errors: [] } sem lançar', () => {
      const { workflows, errors } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(workflows).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('baseDir inexistente ⇒ { workflows: [], errors: [] } sem lançar', () => {
      const inexistente = join(base, 'nunca-criado');
      const { workflows, errors } = new UserWorkflowsLoader({ baseDir: inexistente }).load();
      expect(workflows).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  // ── load() pula não-.md / .md grande demais ──────────────────────────────

  describe('load() — filtra não-.md e .md grande demais', () => {
    it('pula arquivo que não termina em .md', () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'valido.md'), '---\nname: valido\n---\n1. a — goal');
      writeFileSync(join(wfDir, 'nota.txt'), '---\nname: txt\n---\n1. a — goal');
      const { workflows } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(workflows).toHaveLength(1);
      expect(workflows[0]!.name).toBe('valido');
    });

    it('pula .md maior que MAX_WORKFLOW_BYTES (64KB)', () => {
      mkdirSync(wfDir, { recursive: true });
      writeFileSync(join(wfDir, 'pequeno.md'), '---\nname: pequeno\n---\n1. a — goal');
      const bigContent = '---\nname: gigante\n---\n1. a — ' + 'x'.repeat(65 * 1024);
      writeFileSync(join(wfDir, 'gigante.md'), bigContent);
      const { workflows } = new UserWorkflowsLoader({ baseDir: base }).load();
      expect(workflows).toHaveLength(1);
      expect(workflows[0]!.name).toBe('pequeno');
    });
  });
});
