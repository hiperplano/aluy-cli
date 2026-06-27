// EST-1105 · ADR-workflows — comando `/workflows`.
//
// A face do `/workflows`: lista os workflows `.md` que o aluy MAPEOU, das DUAS
// camadas CONFINADAS — GLOBAL (`~/.aluy/workflows/*.md`, config do dono) e PROJETO
// (`.claude/workflows/*.md` no cwd, dado do repo). Read-only, SEM modelo, SEM rede.
//
// REUSO: usa os MESMOS loaders — `UserWorkflowsLoader` (global) e
// `ProjectWorkflowsLoader` (projeto, confinado ao cwd via `NodeWorkspace`) — e o
// MESMO formatador PURO do core (`buildWorkflowsNote`).
//
// EXIT 0 SEMPRE: é uma LISTAGEM.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflowsNote } from '@aluy/cli-core';
import { UserWorkflowsLoader, WORKFLOWS_DIRNAME } from '../io/user-workflows.js';
import type { WorkflowLoadResult } from '../io/user-workflows.js';
import { ProjectWorkflowsLoader } from '../io/project-workflows.js';
import { NodeWorkspace } from '../io/workspace.js';

/** Carregadores das duas camadas — injetáveis p/ teste. */
export interface WorkflowsRunnerDeps {
  readonly loadGlobal?: () => WorkflowLoadResult;
  readonly loadProject?: () => WorkflowLoadResult;
  readonly globalDir?: string;
  readonly projectDir?: string;
  readonly out?: (line: string) => void;
}

/** `~/.aluy/workflows` abreviado p/ a dica de "onde criar". */
function defaultGlobalDirLabel(): string {
  return join('~', '.aluy', WORKFLOWS_DIRNAME);
}

/**
 * Executa o `/workflows`. Constrói os loaders reais (ou usa os injetados),
 * agrega os workflows VÁLIDOS + os ERROS das DUAS camadas, formata com o
 * MESMO `buildWorkflowsNote` e imprime. Read-only. SEMPRE exit 0.
 */
export function runWorkflows(deps: WorkflowsRunnerDeps = {}): number {
  const out = deps.out ?? ((line: string) => process.stdout.write(line + '\n'));

  const loadGlobal = deps.loadGlobal ?? (() => new UserWorkflowsLoader().load());
  const loadProject =
    deps.loadProject ??
    (() => new ProjectWorkflowsLoader({ workspace: new NodeWorkspace() }).load());

  const global = loadGlobal();
  const project = loadProject();

  const note = buildWorkflowsNote({
    workflows: [...global.workflows, ...project.workflows],
    errors: [...global.errors, ...project.errors],
    globalDir: deps.globalDir ?? defaultGlobalDirLabel(),
    projectDir: deps.projectDir ?? '.claude/workflows',
  });

  out(`workflows — fluxos .md mapeados`);
  for (const line of note.lines) out(line);
  return 0;
}

/** Re-export do default p/ a home real. */
export function defaultUserWorkflowsDir(): string {
  return join(homedir(), '.aluy', WORKFLOWS_DIRNAME);
}
