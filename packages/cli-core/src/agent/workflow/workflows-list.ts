// EST-1105 · ADR-workflows — FORMATADOR PURO que lista os workflows
// mapeados (válidos ✓ + rejeitados ⚠ com o motivo RES-MD-3). Reusa o
// resultado dos MESMOS loaders; não re-parseia nem lê o filesystem.
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O).

import type { WorkflowDef, WorkflowError, WorkflowOrigin } from './workflow-parse.js';
// Pedido do dono (UX das listagens) — alinha "N atividades"/escopo entre workflows
// irmãos. `gap: ' · '` (em vez do default 2-espaços) preserva o separador que os
// testes já fixam linha-a-linha (`✓ nome · desc · N atividades · escopo`) — SEM
// cabeçalho/régua aqui: com só 1 coluna variável (nome+descrição, que pode ficar
// ausente) um cabeçalho forçaria a régua a repetir o "·" fora de lugar.
import { tableLines } from '../../util/table-lines.js';

/** Uma nota (título + linhas) — espelha o `SlashNote` do @hiperplano/aluy-cli, sem acoplar a ele. */
export interface WorkflowsListNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** O DADO já carregado pelos loaders confinados. */
export interface WorkflowsListInput {
  /** Workflows VÁLIDOS das DUAS camadas. */
  readonly workflows: readonly WorkflowDef[];
  /** Workflows REJEITADOS (RES-MD-3, fail-closed). */
  readonly errors: readonly WorkflowError[];
  /** O caminho do dir GLOBAL de workflows (`~/.aluy/workflows/`), abreviado p/ exibição. */
  readonly globalDir?: string;
  /** O caminho do dir de PROJETO (`.claude/workflows/`), abreviado p/ exibição. */
  readonly projectDir?: string;
}

/** Rótulo legível do ESCOPO. */
export function workflowOriginLabel(origin: WorkflowOrigin): string {
  return origin === 'global' ? 'global · ~/.aluy/workflows/' : 'projeto · .claude/workflows/';
}

/** Teto de chars da 1 linha de descrição exibida. */
const MAX_DESC_LEN = 100;

/** Deriva a 1 LINHA de descrição exibida. PURO. */
export function workflowDescriptionLine(wf: WorkflowDef): string {
  const raw = wf.description ?? '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  if (flat.length <= MAX_DESC_LEN) return flat;
  return `${flat.slice(0, MAX_DESC_LEN - 1).trimEnd()}…`;
}

/**
 * FORMATA a nota completa de `/workflows`: os VÁLIDOS (✓) com nome/escopo/
 * descrição/N-atividades, e os REJEITADOS (⚠) com o motivo EXATO + dica.
 * Estado VAZIO ⇒ a dica de onde criar. PURO/determinístico.
 */
export function buildWorkflowsNote(input: WorkflowsListInput): WorkflowsListNote {
  const globalDir = input.globalDir ?? '~/.aluy/workflows';
  const projectDir = input.projectDir ?? '.claude/workflows';
  const lines: string[] = [];

  const valid = [...input.workflows].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === 'global' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rejected = [...input.errors].sort((a, b) => a.file.localeCompare(b.file));

  // Estado VAZIO
  if (valid.length === 0 && rejected.length === 0) {
    return {
      title: 'workflows',
      lines: [
        `nenhum workflow mapeado — crie um em ${globalDir}/<nome>.md`,
        'ou em .claude/workflows/<nome>.md (projeto).',
        'formato: frontmatter com `name` + descrição; corpo com atividades numeradas:',
        '  1. <id> — <objetivo>',
        '  2. <id> — <objetivo>',
        'o workflow coordena o agente por essas atividades (fatia 2: run).',
      ],
    };
  }

  if (valid.length > 0) {
    lines.push(`válidos (${valid.length}):`);
    // Alinha "N atividades"/escopo entre os workflows — a coluna nome+descrição varia
    // muito de tamanho, mas as outras duas ganham legibilidade ficando na mesma régua
    // vertical em vez de "empurradas" pra direita a esmo linha a linha.
    lines.push(
      ...tableLines(
        valid.map((wf) => {
          const desc = workflowDescriptionLine(wf);
          const descSuffix = desc !== '' ? ` · ${desc}` : '';
          return [
            `✓ ${wf.name}${descSuffix}`,
            `${wf.activities.length} atividades`,
            workflowOriginLabel(wf.origin),
          ];
        }),
        { gap: ' · ' },
      ),
    );
  }

  if (rejected.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`rejeitados (${rejected.length}) — não foram carregados por estarem inválidos:`);
    for (const e of rejected) {
      lines.push(`  ⚠ ${e.file}`);
      lines.push(`      ${e.reason}`);
    }
    lines.push('  conserto: frontmatter precisa de `name`; corpo precisa de atividades');
    lines.push('  numeradas ("1. id — objetivo", "2. id — objetivo", …).');
  }

  // Nota de proveniência
  lines.push('');
  lines.push(
    `global (${globalDir}/) = config do dono · ` + `projeto (${projectDir}/) = dado do repo.`,
  );

  return { title: 'workflows', lines };
}
