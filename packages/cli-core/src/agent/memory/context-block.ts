// BLOCO DE MEMÓRIA NO `system` (ADR 0004 — decisão do dono: simplicidade, como o Claude).
//
// A memória entra no `system` a cada chamada, como o ALUY.md:
//   • fatos `usuario` (o dono pediu para lembrar) = PREFERÊNCIAS/INSTRUÇÕES que o agente SEGUE;
//   • fatos `derivado` (o agente inferiu) = conhecimento de fundo, corrigível se desatualizado.
// Isto RELAXA, de propósito e só para `usuario`, o antigo "recall = dado, nunca ordem"
// (CLI-SEC-15/GS-M3). Risco residual aceito: uma injeção que convença o modelo a gravar um fato
// marcado `usuario`; ele fica visível e removível em `/memory`. A catraca continua em todo efeito.
//
// PURO (sem I/O, sem `node:*`).

import type { MemoryFact } from './contract.js';

export const MEMORY_USER_HEADER =
  'MEMÓRIA DO DONO (preferências e instruções que ele pediu para lembrar — siga-as como se ele as dissesse agora, também ao delegar a sub-agentes):';
export const MEMORY_DERIVED_HEADER =
  'CONTEXTO LEMBRADO (conhecimento de fundo de sessões anteriores — use; se estiver desatualizado, corrija com `remember`):';

/** Teto de caracteres do bloco (anti-estouro de janela). Generoso e finito. */
export const MAX_MEMORY_CONTEXT_CHARS = 8_000;

/** Teto de caracteres de UM fato no bloco (o `.md` é editável à mão; não infla a janela). */
const MAX_LINE_CHARS = 2_000;

function line(f: MemoryFact): string {
  let text = f.text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS - 12) + ' …[truncado]';
  return `- ${f.scope === 'global' ? '[global] ' : ''}${text}`;
}

/**
 * Monta o bloco. Ordem de prioridade sob o teto: `usuario` primeiro (fixados, depois mais
 * recentes), depois `derivado`; o que não cabe é omitido COM aviso visível. Vazio ⇒ `undefined`.
 */
export function buildMemoryContext(facts: readonly MemoryFact[]): string | undefined {
  if (facts.length === 0) return undefined;
  const rank = (a: MemoryFact, b: MemoryFact): number =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.ts - a.ts;
  const user = facts.filter((f) => f.provenance === 'usuario').sort(rank);
  const derived = facts.filter((f) => f.provenance !== 'usuario').sort(rank);

  let used = MEMORY_USER_HEADER.length + MEMORY_DERIVED_HEADER.length + 200;
  let omittedUser = 0;
  let omittedDerived = 0;
  const keep = (list: MemoryFact[], onOmit: () => void): string[] => {
    const out: string[] = [];
    for (const f of list) {
      const l = line(f);
      if (used + l.length + 1 > MAX_MEMORY_CONTEXT_CHARS) onOmit();
      else {
        out.push(l);
        used += l.length + 1;
      }
    }
    return out;
  };
  const u = keep(user, () => omittedUser++);
  const d = keep(derived, () => omittedDerived++);
  const omitted = omittedUser + omittedDerived;

  const parts: string[] = [];
  if (u.length > 0) parts.push(MEMORY_USER_HEADER, ...u);
  if (d.length > 0) parts.push(...(parts.length > 0 ? [''] : []), MEMORY_DERIVED_HEADER, ...d);
  if (omitted > 0) {
    parts.push(
      '',
      `[…${omitted} fato(s) de memória omitido(s) por limite de tamanho` +
        (omittedUser > 0 ? ` (inclui ${omittedUser} do dono)` : ' (só contexto derivado)') +
        ' — veja e enxugue com /memory…]',
    );
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}
