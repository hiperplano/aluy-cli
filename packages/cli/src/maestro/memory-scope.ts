// F-MEM (ADR-0123 §4) — derivação do ESCOPO de memória por projeto.
//
// O escopo é o `user_id` do mem0 — a FRONTEIRA de isolamento entre projetos.
// A sanitização legada (`cwd.replace(/[^a-zA-Z0-9]+/g, '_')`) colapsava QUALQUER
// corrida de não-alfanuméricos num único `_` ⇒ caminhos distintos colidiam no
// MESMO escopo e VAZAVAM memória entre projetos:
//   /work/client/app  ≡  /work/client-app   ⇒  proj_work_client_app
//   /work/foo-bar      ≡  /work/foo_bar      ⇒  proj_work_foo_bar
// Como o escopo é o user_id, colisão de escopo = recall de um projeto trazendo
// memórias de OUTRO (bleed). Aqui o escopo carrega um HASH do caminho absoluto
// normalizado (colisão-resistente) + o basename legível p/ debug.

import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

const NON_ALNUM_RUN = /[^a-zA-Z0-9]+/g;
const EDGE_UNDERSCORES = /^_+|_+$/g;

function squashToUnderscores(s: string): string {
  return s.replace(NON_ALNUM_RUN, '_').replace(EDGE_UNDERSCORES, '');
}

/**
 * Sanitização LEGADA (não-injetiva). Mantida APENAS p/ o recall retrocompatível
 * — memórias já gravadas vivem sob este escopo; sem isto, o fix as deixaria
 * inalcançáveis (reset silencioso). Usa o `cwd` CRU (como o código antigo), não o
 * resolvido, p/ bater byte-a-byte com o que foi gravado antes.
 */
export function legacyMemoryScope(cwd: string): string {
  return `proj_${squashToUnderscores(cwd)}`;
}

/**
 * Escopo de memória INJETIVO por projeto + os escopos de RECALL (novo + legado).
 *
 * - `scope` — alvo de STORE: `proj_<basename>_<hash12 do caminho absoluto>`.
 *   O hash torna a derivação colisão-resistente (dois caminhos distintos ⇒
 *   escopos distintos w.h.p.); o basename mantém legibilidade p/ debug/doctor.
 * - `recallScopes` — `[novo, legado]`: lê dos DOIS p/ NÃO perder memória já
 *   gravada (migração sem reset). Escreve só no novo ⇒ dados novos ficam
 *   corretamente isolados; o legado (que podia ter bleed) só afeta dados antigos
 *   e envelhece. Nunca PIORA o status quo.
 */
export function deriveMemoryScope(cwd: string): {
  readonly scope: string;
  readonly legacy: string;
  readonly recallScopes: readonly string[];
} {
  const abs = resolve(cwd);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 12);
  const base = squashToUnderscores(basename(abs)) || 'root';
  const scope = `proj_${base}_${hash}`;
  const legacy = legacyMemoryScope(cwd);
  const recallScopes = scope === legacy ? [scope] : [scope, legacy];
  return { scope, legacy, recallScopes };
}
