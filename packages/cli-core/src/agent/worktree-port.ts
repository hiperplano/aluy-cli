// EST-1098 · ADR-0109 (WT-1) — SEAM de ISOLAMENTO POR WORKTREE de sub-agentes.
//
// PROBLEMA que resolve: vários sub-agentes (ou CLIs concorrentes) trabalhando no
// MESMO checkout se atropelam — um `git reset`/`git checkout` de um agente apaga a
// árvore de trabalho do outro (a "praga dos resets concorrentes", lição recorrente
// do dogfood). A cura é dar a cada filho ISOLADO o seu PRÓPRIO `git worktree`: um
// diretório de trabalho separado, ramo próprio, MESMO repositório `.git`.
//
// FRONTEIRA (ADR-0053 §8): este módulo é PORTÁVEL — declara só o CONTRATO (o QUANDO
// e o CICLO DE VIDA do isolamento) e um resolvedor PURO. O COMO (rodar `git worktree
// add/remove`, construir ports confinados ao novo dir) é do locus concreto (@aluy/
// cli), que injeta um `WorktreePort` real. Sem port injetado, o isolamento é INERTE
// (todo filho usa as ports do pai, exatamente como hoje — não-regressão).
//
// SEGURANÇA: um filho isolado recebe ports ENRAIZADAS no dir do worktree — o locus
// concreto as constrói CONFINADAS àquele dir (mesma disciplina path-deny/CLI-SEC-H1
// do pai, só que com raiz no worktree). O isolamento NÃO amplia capacidade: é ⊆ pai
// em política (a engine do filho segue derivada do pai) e troca apenas a RAIZ de I/O.
// O merge-de-volta (integrar o trabalho do worktree no ramo do pai) é DECISÃO humana
// e fica FORA deste seam (WT-3+); aqui só nasce o checkout isolado + o descarte.

import type { ToolPorts } from './tools/types.js';

/**
 * Um worktree git VIVO, alocado para UM filho isolado. Carrega as ports JÁ enraizadas
 * no diretório dele (construídas pelo locus concreto, confinadas ao `dir`) e o
 * `dispose()` que o remove ao fim — chamado pelo spawner em TODO caminho de saída do
 * filho (sucesso, timeout, cancelamento, erro), nunca vazando worktrees órfãos.
 */
export interface WorktreeHandle {
  /** Diretório ABSOLUTO do worktree (a raiz de I/O do filho isolado). */
  readonly dir: string;
  /** Ramo git criado para o worktree (efêmero — descartado no `dispose`). */
  readonly branch: string;
  /** Ports confinadas ao `dir` (fs/shell/search/cwd com raiz no worktree). */
  readonly ports: ToolPorts;
  /**
   * Remove o worktree e o ramo efêmero. Idempotente e best-effort: NUNCA lança (o
   * spawner o chama num `finally`; uma falha de limpeza não pode derrubar o desfecho
   * do filho). O locus concreto loga/coleta o que não conseguir remover.
   */
  dispose(): Promise<void>;
}

/**
 * Porta de ISOLAMENTO por worktree (OPCIONAL em `SubAgentSpawner`). Quando injetada,
 * um filho com `isolation: 'worktree'` é rodado num worktree próprio. Tipada como
 * contrato estreito: o concreto (@aluy/cli) faz `git worktree add` num tmpdir, monta
 * `NodeWorkspace`/ports confinados ali e devolve o handle.
 */
export interface WorktreePort {
  /**
   * Aloca um worktree NOVO para o filho `label`. O `label` entra no nome do dir/ramo
   * (rastreabilidade/origem — CLI-SEC-9), sanitizado pelo concreto. Lança se não
   * conseguir alocar (ex.: cwd não é repo git) — o spawner trata como falha do filho
   * (não derruba os irmãos).
   */
  checkout(label: string): Promise<WorktreeHandle>;
}

/** Decisão de isolamento de UM filho (campo `isolation` do perfil). */
export type ChildIsolation = 'worktree';

/**
 * Resolvedor PURO do isolamento de um filho — a face testável do seam. Centraliza a
 * regra do QUANDO: só isola se o perfil PEDIU (`isolation: 'worktree'`) E há port
 * injetado. Caso contrário devolve `undefined` ⇒ o filho usa as ports do pai (hoje).
 *
 * Mantém o spawner enxuto e dá um ponto único de teste (fake `WorktreePort`): provar
 * "pediu+port ⇒ checkout", "pediu-sem-port ⇒ inerte", "não-pediu ⇒ inerte (nem chama
 * checkout)".
 */
export async function resolveChildWorktree(
  profile: { readonly isolation?: ChildIsolation; readonly label: string },
  worktree: WorktreePort | undefined,
): Promise<WorktreeHandle | undefined> {
  if (profile.isolation === 'worktree' && worktree !== undefined) {
    return worktree.checkout(profile.label);
  }
  return undefined;
}
