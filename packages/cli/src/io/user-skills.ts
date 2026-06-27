// EST-1112 · ADR-0116 (proposto) · CLI-SEC-11 (reaplicado) — LOADER CONFINADO das
// SKILLS GLOBAIS do usuário (`~/.aluy/skills/<nome>/SKILL.md`). Espelha o
// `UserAgentsLoader` (EST-0977), MAS a unidade de descoberta é um DIRETÓRIO por skill
// (não um `.md` flat): cada subdir de `~/.aluy/skills/` com um `SKILL.md` é uma skill.
// Parseia com o parser PURO do core (`parseSkill`) e devolve as skills GLOBAIS
// (origin='global').
//
// FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere):
//   • `~/.aluy/skills/` é CONFIG DO DONO (como os agentes/commands): confiável.
//     POR ISSO `origin='global'`. "Confiável" ≠ "relaxa a catraca": uma skill só
//     INJETA INSTRUÇÕES; tudo o que o modelo fizer a partir delas segue sob `decide()`
//     (CLI-SEC-H1). O loader NÃO executa nada — só lê o DADO e estrutura as skills.
//   • Confinado a `~/.aluy/skills/` com mode 0700 no dir. Descobre SÓ subdirs DIRETOS
//     (sem recursão; `isDirectory()` em dirent NÃO segue symlink de tipo) e lê o
//     `SKILL.md` DIRETO de cada um. Os recursos auxiliares ao lado do `SKILL.md` NÃO
//     são lidos aqui (são referenciados pelo corpo e lidos sob a catraca quando/se a
//     skill os usa).
//
// RES-MD-3 (FALHA FECHADA): um `SKILL.md` malformado (sem `name`/corpo vazio) NÃO vira
// "skill silenciosa" — o parser devolve `SkillError` e o loader o COLETA em `errors`
// (carga visível). Dir ausente/ilegível ⇒ lista VAZIA, NUNCA lança. QoL jamais derruba
// o startup.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync, statSync, type Dirent } from 'node:fs';
import { parseSkill, isSkillError, type Skill, type SkillError } from '@hiperplano/aluy-cli-core';

/** Permissão restrita do dir `~/.aluy/skills/` (espelha o user-agents/commands). */
const DIR_MODE = 0o700;

/** Subdir (dentro de `~/.aluy/`) onde moram as skills globais do usuário. */
export const SKILLS_DIRNAME = 'skills';

/** Nome canônico do manifesto de uma skill (dentro do diretório da skill). */
export const SKILL_MANIFEST = 'SKILL.md';

/** Teto defensivo de tamanho do `SKILL.md` (anti-arquivo-gigante). */
const MAX_SKILL_BYTES = 256 * 1024;

/** Teto defensivo de QUANTAS skills carregar (anti-dir gigante). */
const MAX_SKILLS = 256;

/** Resultado de uma carga: as skills VÁLIDAS + os ERROS visíveis (RES-MD-3). */
export interface SkillLoadResult {
  readonly skills: readonly Skill[];
  /** Skills rejeitadas (malformadas) — carga visível, NÃO entram no registro. */
  readonly errors: readonly SkillError[];
}

export interface UserSkillsLoaderOptions {
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir). */
  readonly baseDir?: string;
}

/**
 * Carregador das skills GLOBAIS de `~/.aluy/skills/<nome>/SKILL.md`. Idempotente:
 * `load()` relê o dir a cada chamada (skills são DADO de config — sem cache). Todas
 * com `origin='global'` (dono=confiável).
 */
export class UserSkillsLoader {
  private readonly dir: string;

  constructor(opts: UserSkillsLoaderOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(base, SKILLS_DIRNAME);
  }

  /** O caminho do dir de skills (p/ mensagens/teste). */
  get skillsDir(): string {
    return this.dir;
  }

  /** Garante `~/.aluy/skills/` com mode 0700 (idempotente, best-effort). */
  ensureDir(): void {
    try {
      mkdirSync(this.dir, { mode: DIR_MODE, recursive: true });
    } catch {
      /* best-effort — fail-safe */
    }
  }

  /**
   * Descobre os subdirs DIRETOS de `~/.aluy/skills/`, lê o `SKILL.md` de cada um e
   * devolve as skills parseadas + os erros (RES-MD-3). Determinístico (ordenado por
   * nome de diretório). Colisão de `name` (após parse) ⇒ 1º (ordem alfabética) vence —
   * estável. Dir ausente ⇒ `{ skills: [], errors: [] }` (fail-safe).
   */
  load(): SkillLoadResult {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return { skills: [], errors: [] }; // dir ausente/ilegível ⇒ sem skills.
    }
    // Só subdirs DIRETOS. `isDirectory()` em dirent NÃO segue symlink de tipo — 1ª
    // linha contra descoberta fora do dir confinado.
    const dirNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const seen = new Set<string>();
    const skills: Skill[] = [];
    const errors: SkillError[] = [];
    for (const dirName of dirNames) {
      if (skills.length >= MAX_SKILLS) break;
      const parsed = this.readOne(dirName);
      if (parsed === null) continue; // sem SKILL.md / erro de I/O puro ⇒ pula (não é skill).
      if (isSkillError(parsed)) {
        errors.push(parsed); // RES-MD-3: carga visível, NÃO entra.
        continue;
      }
      if (seen.has(parsed.name)) continue; // colisão intra-camada: 1º (alfabético) vence.
      seen.add(parsed.name);
      skills.push(parsed);
    }
    return { skills, errors };
  }

  /**
   * Lê+parseia o `SKILL.md` de UM subdir de skill (origin='global'). Subdir sem
   * `SKILL.md` / erro de I/O / tamanho excedido ⇒ `null` (não é skill, sem ruído).
   * `SKILL.md` malformado ⇒ `SkillError` (RES-MD-3, carga visível).
   */
  private readOne(dirName: string): Skill | SkillError | null {
    const manifest = join(this.dir, dirName, SKILL_MANIFEST);
    try {
      const st = statSync(manifest);
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
      const raw = readFileSync(manifest, 'utf8');
      return parseSkill(dirName, raw, 'global');
    } catch {
      return null; // subdir sem SKILL.md (ENOENT) ⇒ não é skill — silencioso.
    }
  }
}
