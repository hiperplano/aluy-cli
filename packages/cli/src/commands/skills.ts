// EST-1112 · ADR-0116 (proposto) · CLI-SEC-11 (reaplicado) — comando `aluy skills`.
//
// A face SHELL do `/skills`: lista as SKILLS (`SKILL.md`) que o aluy MAPEOU, das DUAS
// camadas CONFINADAS — GLOBAL (`~/.aluy/skills/<nome>/SKILL.md`, config do dono) e
// PROJETO (`.claude/skills/<nome>/SKILL.md` no cwd, dado do repo). Read-only, SEM
// modelo, SEM rede.
//
// REUSO (DoD): usa os MESMOS loaders confinados (`UserSkillsLoader` global e
// `ProjectSkillsLoader` projeto, confinado ao cwd via `NodeWorkspace`) e o MESMO
// formatador PURO do core (`buildSkillsNote`). O `/skills` da sessão e este shell
// produzem a MESMA listagem (válidas ✓ + rejeitadas ⚠ com o motivo RES-MD-3). Nada de
// parse/IO reimplementado aqui. Espelha `commands/agents.ts` (EST-0977).
//
// EXIT 0 SEMPRE: é uma LISTAGEM (como `aluy agents`), não um gate. Rejeitadas são
// EXIBIDAS (carga visível), não fazem o comando "falhar" — a falha-fechada já agiu no
// loader (a skill malformada NÃO entra no registro). Pasta ausente ⇒ "nenhuma".

import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSkillsNote } from '@hiperplano/aluy-cli-core';
import { UserSkillsLoader, SKILLS_DIRNAME, type SkillLoadResult } from '../io/user-skills.js';
import { ProjectSkillsLoader } from '../io/project-skills.js';
import { NodeWorkspace } from '../io/workspace.js';

/** Carregadores das duas camadas — injetáveis p/ teste (tmpdir, sem tocar a home real). */
export interface SkillsRunnerDeps {
  /** Carrega as skills GLOBAIS (`~/.aluy/skills/<nome>/SKILL.md`). Default: o real. */
  readonly loadGlobal?: () => SkillLoadResult;
  /** Carrega as skills de PROJETO (`.claude/skills/<nome>/SKILL.md`, confinado ao cwd). */
  readonly loadProject?: () => SkillLoadResult;
  /** Dir global (abreviado p/ exibição) — p/ a mensagem de estado vazio. */
  readonly globalDir?: string;
  /** Sink de saída (default: stdout). Injetável p/ capturar no teste. */
  readonly out?: (line: string) => void;
}

/** `~/.aluy/skills` abreviado (sem expandir a home) p/ a dica de "onde criar". */
function defaultGlobalDirLabel(): string {
  return join('~', '.aluy', SKILLS_DIRNAME);
}

/**
 * Executa `aluy skills`. Constrói os loaders reais (ou usa os injetados), agrega as
 * skills VÁLIDAS + os ERROS das DUAS camadas, formata com o MESMO `buildSkillsNote` do
 * `/skills` da sessão e imprime. Read-only — nunca escreve config, nunca chama o modelo,
 * nunca toca a rede. Cada loader já é fail-safe (dir ausente ⇒ vazio). SEMPRE exit 0.
 */
export function runSkills(deps: SkillsRunnerDeps = {}): number {
  const out = deps.out ?? ((line: string) => process.stdout.write(line + '\n'));

  const loadGlobal = deps.loadGlobal ?? (() => new UserSkillsLoader().load());
  const loadProject =
    deps.loadProject ?? (() => new ProjectSkillsLoader({ workspace: new NodeWorkspace() }).load());

  const global = loadGlobal();
  const project = loadProject();

  const note = buildSkillsNote({
    skills: [...global.skills, ...project.skills],
    errors: [...global.errors, ...project.errors],
    globalDir: deps.globalDir ?? defaultGlobalDirLabel(),
  });

  out('aluy skills — capacidades SKILL.md mapeadas');
  for (const line of note.lines) out(line);
  // Listagem, não gate: rejeitadas são EXIBIDAS, não derrubam o exit. Exit 0 sempre.
  return 0;
}

/** Re-export do default p/ a home real (usado quando nenhum dir é injetado). */
export function defaultUserSkillsDir(): string {
  return join(homedir(), '.aluy', SKILLS_DIRNAME);
}
