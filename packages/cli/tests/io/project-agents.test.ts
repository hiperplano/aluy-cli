// EST-1013 — ProjectAgentsLoader: load() com .md válido/malformado/pasta-ausente.
//
// Endurece a cobertura de packages/cli/src/io/project-agents.ts:
//   - load() com .md VÁLIDO devolve o perfil parseado com origin='project'
//   - load() com .md MALFORMADO (RES-MD-3) devolve erro, NÃO entra em profiles
//   - load() com PASTA AUSENTE devolve { profiles: [], errors: [] } (fail-safe,
//     cobre as linhas 95-96 — catch { continue } no readdirSync)
//   - load() com .md em subdir de agents/ (não direto) é ignorado
//   - load() pula .md grande demais (> 64KB)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectAgentsLoader, PROJECT_AGENTS_DIRNAMES } from '../../src/io/project-agents.js';
import { NodeWorkspace } from '../../src/io/workspace.js';

describe('EST-1013 · ProjectAgentsLoader — load (cobertura endurecida)', () => {
  let root: string;
  let agentsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aluy-pa-'));
    agentsDir = join(root, PROJECT_AGENTS_DIRNAMES[0]!);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeLoader(): ProjectAgentsLoader {
    return new ProjectAgentsLoader({ workspace: new NodeWorkspace({ root }) });
  }

  // ── (A) load() com .md VÁLIDO ───────────────────────────────────────────

  describe('load() — .md válido', () => {
    it('devolve um perfil parseado com origin=project', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'revisor.md'),
        '---\nname: revisor\ndescription: revisa\ntools: read_file, grep\nmodel: sonnet\n---\nVocê é o revisor.',
      );
      const { profiles, errors } = makeLoader().load();
      expect(errors).toEqual([]);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('revisor');
      expect(profiles[0]!.origin).toBe('project');
      expect(profiles[0]!.tools).toEqual(['read_file', 'grep']);
      expect(profiles[0]!.systemPrompt).toContain('revisor');
    });

    it('F154 — SYMLINK p/ .md dentro do workspace ENTRA no discovery (o caso specs→.aluy do dono)', () => {
      // O setup real do dono: .aluy/agents/dev.md → symlink p/ aluy-specs/.claude/agents/dev.md
      // (alvo DENTRO do workspace). Dirent.isFile() não segue o link ⇒ o perfil sumia.
      mkdirSync(agentsDir, { recursive: true });
      const specsDir = join(root, 'aluy-specs');
      mkdirSync(specsDir, { recursive: true });
      writeFileSync(join(specsDir, 'dev.md'), '---\nname: dev-backend\n---\npersona dev');
      symlinkSync(join(specsDir, 'dev.md'), join(agentsDir, 'dev.md'));
      const { profiles, errors } = makeLoader().load();
      expect(errors).toEqual([]);
      expect(profiles.map((p) => p.name)).toContain('dev-backend');
    });

    it('F154 — symlink ESCAPANDO o workspace segue REJEITADO (confinamento intacto)', () => {
      mkdirSync(agentsDir, { recursive: true });
      const fora = mkdtempSync(join(tmpdir(), 'aluy-fora-'));
      writeFileSync(join(fora, 'mal.md'), '---\nname: intruso\n---\npersona');
      symlinkSync(join(fora, 'mal.md'), join(agentsDir, 'mal.md'));
      const { profiles } = makeLoader().load();
      expect(profiles.map((p) => p.name)).not.toContain('intruso');
      rmSync(fora, { recursive: true, force: true });
    });

    it('carrega múltiplos .md válidos ordenados alfabeticamente', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'b.md'), '---\nname: beta\n---\nbeta persona');
      writeFileSync(join(agentsDir, 'a.md'), '---\nname: alfa\n---\nalfa persona');
      const { profiles, errors } = makeLoader().load();
      expect(errors).toEqual([]);
      expect(profiles).toHaveLength(2);
      expect(profiles[0]!.name).toBe('alfa');
      expect(profiles[1]!.name).toBe('beta');
    });

    it('ignora arquivos que não terminam em .md', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'valido.md'), '---\nname: valido\n---\ncorpo');
      writeFileSync(join(agentsDir, 'nota.txt'), '---\nname: txt\n---\nignorado');
      const { profiles, errors } = makeLoader().load();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('valido');
      expect(errors).toEqual([]);
    });
  });

  // ── (B) load() com .md MALFORMADO (RES-MD-3) ────────────────────────────

  describe('load() — .md malformado (RES-MD-3)', () => {
    it('tools presente-vazio ⇒ erro coletado, perfil NÃO entra em profiles', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'bom.md'), '---\nname: bom\n---\ncorpo');
      writeFileSync(join(agentsDir, 'ruim.md'), '---\nname: ruim\ntools:\n---\ncorpo');
      const { profiles, errors } = makeLoader().load();
      expect(profiles.map((p) => p.name)).toEqual(['bom']);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/não carregado|inválida/);
    });

    it('name ausente ⇒ erro coletado, perfil NÃO entra', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'sem-nome.md'), '---\ndescription: x\n---\ncorpo');
      const { profiles, errors } = makeLoader().load();
      expect(profiles).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/sem "name" válido/);
    });

    it('corpo vazio ⇒ erro coletado, perfil NÃO entra', () => {
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, 'vazio.md'), '---\nname: vazio\n---\n');
      const { profiles, errors } = makeLoader().load();
      expect(profiles).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.reason).toMatch(/corpo vazio/);
    });
  });

  // ── (C) load() SEM a pasta .claude/agents (linhas 95-96) ─────────────────

  describe('load() — pasta .claude/agents ausente (fail-safe)', () => {
    it('sem o subdir .claude/agents ⇒ { profiles: [], errors: [] } sem lançar', () => {
      // root existe mas .claude/agents/ NÃO foi criado (só o root tmp vazio).
      const { profiles, errors } = makeLoader().load();
      expect(profiles).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('raiz do workspace inexistente ⇒ { profiles: [], errors: [] } sem lançar', () => {
      const inexistente = join(root, 'nunca-criado');
      const loader = new ProjectAgentsLoader({
        workspace: new NodeWorkspace({ root: inexistente }),
      });
      const { profiles, errors } = loader.load();
      expect(profiles).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  // ── (D) load() com subdir não-lido e .md grande demais ──────────────────

  describe('load() — filtra subdir e .md grande demais', () => {
    it('ignora .md dentro de subdiretório de agents/', () => {
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(join(agentsDir, 'subdir'));
      writeFileSync(join(agentsDir, 'valido.md'), '---\nname: valido\n---\ncorpo');
      writeFileSync(join(agentsDir, 'subdir', 'aninhado.md'), '---\nname: aninhado\n---\ncorpo');
      const { profiles, errors } = makeLoader().load();
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
      const { profiles, errors } = makeLoader().load();
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('pequeno');
      expect(errors).toEqual([]);
    });
  });
});
