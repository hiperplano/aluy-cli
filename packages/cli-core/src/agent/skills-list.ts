// EST-1112 · ADR-0116 (proposto) — `/skills` + `aluy skills`: o FORMATADOR PURO que
// lista as skills (`SKILL.md`) que o aluy MAPEOU. Espelha o `agents-list.ts` (EST-0977):
// reusa o resultado dos MESMOS loaders confinados (`UserSkillsLoader`/`ProjectSkillsLoader`
// no @hiperplano/aluy-cli) — aqui só FORMATAMOS o DADO já parseado (skills VÁLIDAS + erros RES-MD-3),
// sem reimplementar parse nem I/O.
//
// O que mostra:
//   • VÁLIDAS (✓): por skill, NOME, ESCOPO (global `~/.aluy/skills/` vs projeto
//     `.claude/skills/`) e 1 linha da description/1ª linha das instruções. NUNCA o
//     `SKILL.md` inteiro (1 linha — as instruções só entram no contexto quando a skill
//     é INVOCADA por `/skill <nome>`).
//   • REJEITADAS (⚠): nome + o MOTIVO EXATO (a `reason` fail-closed do parser) + a dica.
//   • VAZIO: aponta onde criar (`~/.aluy/skills/<nome>/SKILL.md`) e o manifesto mínimo.
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O). A LEITURA
// confinada dos diretórios é do locus concreto (@hiperplano/aluy-cli, io/); ela ENTREGA as skills
// + erros aqui. Determinístico/testável sem montar Ink nem tocar o filesystem.

import type { Skill, SkillError, SkillOrigin } from './skill.js';
import { boxTable } from '../util/box-table.js';

/** Uma nota (título + linhas) — espelha o `AgentsListNote`/`SlashNote`. */
export interface SkillsListNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** O DADO já carregado pelos loaders confinados. */
export interface SkillsListInput {
  /** Skills VÁLIDAS das DUAS camadas (origin distingue global/projeto). */
  readonly skills: readonly Skill[];
  /** Skills REJEITADAS (RES-MD-3, fail-closed) das duas camadas — carga visível. */
  readonly errors: readonly SkillError[];
  /**
   * O caminho do dir GLOBAL de skills (`~/.aluy/skills/`), abreviado p/ exibição.
   * Usado na mensagem de estado VAZIO (onde criar). Opcional — default `~/.aluy/skills`.
   */
  readonly globalDir?: string;
}

/** Rótulo legível do ESCOPO de uma skill (espelha o `agentOriginLabel`). */
export function skillOriginLabel(origin: SkillOrigin): string {
  return origin === 'global' ? 'global · ~/.aluy/skills/' : 'projeto · .claude/skills/';
}

/** Teto de chars da 1 linha de description/instrução exibida (anti-despejo). */
const MAX_DESC_LEN = 100;

/**
 * Deriva a 1 LINHA de description exibida: prefere a `description` do frontmatter; sem
 * ela, a 1ª linha não-vazia das `instructions` (corpo do `SKILL.md`). Colapsa espaços,
 * trunca com `…` no teto. NUNCA despeja o `SKILL.md` inteiro. PURO.
 */
export function skillDescriptionLine(skill: Skill): string {
  const raw =
    skill.description !== undefined && skill.description.trim() !== ''
      ? skill.description
      : (skill.instructions.split('\n').find((l) => l.trim() !== '') ?? '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_DESC_LEN) return flat;
  return `${flat.slice(0, MAX_DESC_LEN - 1).trimEnd()}…`;
}

/**
 * FORMATA a nota completa de `/skills` (e de `aluy skills`, via o mesmo builder): as
 * VÁLIDAS (✓, ordenadas por escopo depois por nome) com nome/escopo/description, e as
 * REJEITADAS (⚠) com o motivo EXATO + a dica de conserto. Estado VAZIO ⇒ a dica de onde
 * criar. PURO/determinístico — o caller (slash OU shell) só empurra/imprime as linhas.
 *
 * `skills` e `errors` vêm dos MESMOS loaders confinados (o caller os carrega); este
 * builder NÃO lê o filesystem nem re-parseia — só estrutura o que já foi mapeado.
 */
export function buildSkillsNote(input: SkillsListInput): SkillsListNote {
  const globalDir = input.globalDir ?? '~/.aluy/skills';
  const lines: string[] = [];

  const valid = [...input.skills].sort((a, b) => {
    // Globais antes de projeto (camada confiável primeiro); depois alfabético por nome.
    if (a.origin !== b.origin) return a.origin === 'global' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rejected = [...input.errors].sort((a, b) => a.name.localeCompare(b.name));

  // Estado VAZIO: nada mapeado (nem válida, nem rejeitada).
  if (valid.length === 0 && rejected.length === 0) {
    return {
      title: 'skills',
      lines: [
        `nenhuma skill mapeada — crie uma em ${globalDir}/<nome>/SKILL.md`,
        'manifesto mínimo: frontmatter com `name` e `description`;',
        'o corpo do SKILL.md são as instruções/capacidade injetadas quando invocada.',
        'invoque por nome: `/skill <nome>` (injeta as instruções no contexto sob demanda).',
      ],
    };
  }

  if (valid.length > 0) {
    lines.push(`válidas (${valid.length}) — invoque por nome com /skill <nome>:`);
    const rows = valid.map((s) => [
      s.name,
      s.origin === 'global' ? 'global' : 'projeto',
      skillDescriptionLine(s),
    ]);
    lines.push(...boxTable(['skill', 'escopo', 'sobre'], rows, { maxWidths: [20, 8, 50] }));
  }

  if (rejected.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`rejeitadas (${rejected.length}) — não foram carregadas por estarem inválidas:`);
    const rows = rejected.map((e) => [e.name, e.reason]);
    lines.push(...boxTable(['skill', 'motivo'], rows, { maxWidths: [22, 50] }));
    lines.push('  conserto: o SKILL.md precisa de `name` (ou herda o nome da pasta) e de um');
    lines.push('  corpo não-vazio (as instruções da skill).');
  }

  // Nota de proveniência/escopo (sempre que há algo a listar): global=dono confiável,
  // projeto=DADO. Curta, 1 linha.
  lines.push('');
  lines.push(
    'global (~/.aluy/skills/) = config do dono · projeto (.claude/skills/) = dado do repo.',
  );

  return { title: 'skills', lines };
}
