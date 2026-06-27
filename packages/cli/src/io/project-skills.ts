// EST-1112 · ADR-0116 (proposto) · CLI-SEC-11 (reaplicado) — LOADER CONFINADO das
// SKILLS de PROJETO (`.claude/skills/<nome>/SKILL.md` + `.aluy/skills/<nome>/SKILL.md`,
// ADR-0113 carve-out) no workspace. Espelha o `ProjectAgentsLoader` (EST-0977): MESMO
// mecanismo confinado, unidade = DIRETÓRIO por skill; reusa o parser PURO do core
// (`parseSkill`) com `origin='project'`.
//
// FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere — gate FORTE):
//   • `.claude/skills/` + `.aluy/skills/` são config de PROJETO = DADO confinado ao
//     workspace (vinda de repo possivelmente clonado/terceiro). POR ISSO
//     `origin='project'`: a description é DADO não-confiável (nunca decide sozinha o
//     que roda — só o usuário INVOCA a skill por nome). NÃO herda tratamento-confiável
//     por nome igual a uma global; NÃO relaxa a catraca (instruções de uma skill
//     seguem sob `decide()`, CLI-SEC-H1).
//   • CONFINAMENTO (WorkspacePort): cada pasta de skills é resolvida/canonicalizada SÓ
//     sob a raiz do workspace (symlink p/ fora ⇒ rejeitado). Descobre SÓ subdirs
//     DIRETOS e lê o `SKILL.md` DIRETO de cada um (sem recursão).
//
// RES-MD-3 (FALHA FECHADA): `SKILL.md` malformado ⇒ `SkillError` coletado em `errors`
// (carga visível), NUNCA "skill silenciosa". Dir ausente/escapa-a-raiz ⇒ lista VAZIA.

import { join } from 'node:path';
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { parseSkill, isSkillError, type Skill, type SkillError } from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';
import { SKILL_MANIFEST, type SkillLoadResult } from './user-skills.js';

/**
 * Pastas (relativas à raiz) das skills de PROJETO.
 * Padrão Claude Code: `.claude/skills` + Aluy: `.aluy/skills` (ADR-0113 carve-out).
 *
 * Precedência: `.claude/skills/` antes de `.aluy/skills/` (ordem da lista);
 * colisão de `name` entre elas ⇒ 1ª pasta vence (estável).
 */
export const PROJECT_SKILLS_DIRNAMES = ['.claude/skills', '.aluy/skills'] as const;

/** Teto defensivo de tamanho do `SKILL.md` (anti-arquivo-gigante). */
const MAX_SKILL_BYTES = 256 * 1024;

/** Teto defensivo de QUANTAS skills carregar (anti-dir gigante). */
const MAX_SKILLS = 256;

export interface ProjectSkillsLoaderOptions {
  /** Workspace confinado — as pastas de skills são resolvidas SÓ sob a raiz. */
  readonly workspace: WorkspacePort;
}

/**
 * Carregador das skills de PROJETO (`.claude/skills/<nome>/SKILL.md` +
 * `.aluy/skills/<nome>/SKILL.md`, no workspace confinado). Todas com `origin='project'`
 * (DADO). `load()` relê a cada chamada (sem cache). Determinístico. Dir ausente ⇒ vazio.
 */
export class ProjectSkillsLoader {
  private readonly workspace: WorkspacePort;

  constructor(opts: ProjectSkillsLoaderOptions) {
    this.workspace = opts.workspace;
  }

  /**
   * Descobre os subdirs DIRETOS de cada pasta de skills do projeto (confinado à raiz),
   * lê o `SKILL.md` de cada um e devolve as skills + erros (RES-MD-3). Precedência
   * entre as DUAS pastas: `.claude/skills/` antes de `.aluy/skills/`; colisão de `name`
   * entre elas ⇒ 1ª pasta vence (estável). Dir ausente/escapa-a-raiz ⇒ vazio.
   */
  load(): SkillLoadResult {
    const seen = new Set<string>();
    const skills: Skill[] = [];
    const errors: SkillError[] = [];

    for (const dirname of PROJECT_SKILLS_DIRNAMES) {
      // CONFINAMENTO: resolve a PASTA contra a raiz; escapa ⇒ pula (nada lido).
      let dir: string;
      try {
        dir = this.workspace.resolveInside(dirname);
      } catch {
        continue;
      }
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // dir ausente/ilegível ⇒ sem skills desta pasta (fail-safe).
      }
      const dirNames = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));

      for (const skillDir of dirNames) {
        if (skills.length >= MAX_SKILLS) break;
        const parsed = this.readOne(dirname, dir, skillDir);
        if (parsed === null) continue;
        if (isSkillError(parsed)) {
          errors.push(parsed); // RES-MD-3: carga visível, NÃO entra.
          continue;
        }
        if (seen.has(parsed.name)) continue; // colisão (intra-projeto): 1ª pasta vence.
        seen.add(parsed.name);
        skills.push(parsed);
      }
    }
    return { skills, errors };
  }

  /**
   * Lê+parseia o `SKILL.md` de UM subdir de skill (origin='project'). Subdir sem
   * `SKILL.md` / erro / tamanho / escape ⇒ `null`. Malformado ⇒ `SkillError`.
   */
  private readOne(dirname: string, dir: string, skillDir: string): Skill | SkillError | null {
    const rel = `${dirname}/${skillDir}/${SKILL_MANIFEST}`;
    const full = join(dir, skillDir, SKILL_MANIFEST);
    try {
      // CONFINAMENTO re-checado no arquivo (symlink interno p/ fora ⇒ rejeita).
      this.workspace.resolveInside(rel);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
      const raw = readFileSync(full, 'utf8');
      return parseSkill(skillDir, raw, 'project');
    } catch {
      return null; // subdir sem SKILL.md / escape ⇒ não é skill.
    }
  }
}
