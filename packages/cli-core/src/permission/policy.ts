// EST-0945 · ADR-0053 §2.2 — a POLÍTICA é DADO do usuário (config), não código.
//
// A engine (allow/ask/deny + categorias + hooks) é CÓDIGO no pacote; a POLÍTICA
// CONCRETA (quais comandos o usuário liberou, quais negou, hooks) é DADO editável
// sem reinstalar. Este arquivo define o FORMATO desse dado e a sua avaliação —
// PORTÁVEL (sem I/O): quem LÊ o arquivo de settings do SO é o `@hiperplano/aluy-cli`
// (EST-0948); aqui só interpretamos o objeto já carregado.
//
// LIMITE DE ESCOPO (v1): a política é de SESSÃO/GLOBAL. Persistência POR WORKSPACE
// (aprovar num repo não vaza p/ outro) é CLI-SEC-H5, hardening de PROD — NÃO
// entregue aqui. Mantemos, porém, as categorias sempre-ask intactas (CLI-SEC-3):
// nenhuma regra de allow do usuário relaxa as categorias não-relaxáveis.

import type { PermissionDecision } from './gate.js';

/**
 * Uma regra de política do usuário: casa o nome da tool e (opcional) um padrão
 * sobre o `command`/`path`, e dá um veredito. Padrões são GLOB simples
 * (`*` = qualquer sequência), não regex — formato amigável p/ settings de
 * usuário. `match` ausente ⇒ casa qualquer input da tool.
 *
 * IMPORTANTE: uma regra `allow` NUNCA sobrepõe uma categoria sempre-ask
 * (CLI-SEC-3). A engine aplica as categorias ANTES de consultar regras de allow.
 */
export interface PolicyRule {
  /** Nome da tool (ex.: "run_command", "edit_file"). */
  readonly tool: string;
  /** Glob sobre o argumento principal (command/path). Opcional. */
  readonly match?: string;
  /** Veredito que esta regra concede. */
  readonly decision: PermissionDecision;
}

/**
 * A política do usuário (dado de config). `rules` são avaliadas em ordem; a
 * PRIMEIRA que casa decide (com a ressalva: allow não vence categoria sempre-ask).
 * `defaults` permite ajustar o default por tool (mas `run_command` nunca abaixo
 * de `ask` — a engine reforça o piso de CLI-SEC-3).
 */
export interface PermissionPolicy {
  readonly rules: readonly PolicyRule[];
  /** Default por tool. Ausente ⇒ a engine usa o piso seguro (ver engine.ts). */
  readonly defaults?: Readonly<Record<string, PermissionDecision>>;
}

/** Política vazia: nenhuma regra, sem overrides. Defaults seguros da engine valem. */
export const EMPTY_POLICY: PermissionPolicy = { rules: [], defaults: {} };

/** Resultado de avaliar a política contra um tool-call. */
export interface PolicyEvaluation {
  readonly decision: PermissionDecision;
  readonly reason: string;
  /** A regra que casou (p/ auditoria), se houve. */
  readonly matchedRule?: PolicyRule;
}

/**
 * Avalia as REGRAS do usuário contra um tool-call (NÃO aplica categorias nem
 * defaults — isso é responsabilidade da engine, que chama isto no momento certo
 * da ordem de precedência). Devolve a primeira regra que casa, ou `undefined`.
 */
export function evaluatePolicyRules(
  policy: PermissionPolicy,
  name: string,
  arg: string,
): PolicyRule | undefined {
  for (const rule of policy.rules) {
    if (rule.tool !== name) continue;
    if (rule.match === undefined || globMatch(rule.match, arg)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * GLOB simples: `*` casa qualquer sequência (inclusive vazia); todo o resto é
 * literal. Âncora total (a string inteira deve casar). Sem regex de usuário
 * (evita ReDoS e surpresa). Case-sensitive (paths/commands são).
 */
export function globMatch(pattern: string, value: string): boolean {
  // escapa tudo, depois troca o `*` escapado por `.*`
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
