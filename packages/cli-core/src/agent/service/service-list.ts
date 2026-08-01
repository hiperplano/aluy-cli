// ADR-0158 §5/§11 — FORMATADOR PURO da listagem de serviços (`aluy service list` /
// `/service`, o canal PRINCIPAL — emenda 1 de aprovação, §10). Reusa o resultado do
// REGISTRY confinado (`@hiperplano/aluy-cli`, `io/services-store.ts`); não relê nada.
//
// Fase 1 = SEM runner (ADR-0158 §5 é a fatia 2): por isso todo serviço aparece com
// estado FIXO "parado" — não há processo pra estar em outro estado ainda. A "sala de
// controle" viva (rodando/dormindo/turno em andamento, §11) chega com o runner.
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O).

import type { ServiceManifest } from './service-parse.js';

/** Uma nota (título + linhas) — espelha o `SlashNote` do @hiperplano/aluy-cli, sem acoplar a ele. */
export interface ServicesListNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Um serviço já VALIDADO pelo registry (manifesto parseável + cron/workflow OK). */
export interface ServiceListEntry {
  readonly name: string;
  readonly manifest: ServiceManifest;
}

/** Um serviço REJEITADO pelo registry (RES-MD-3 do parser OU falha de validação do dir). */
export interface ServiceListRejection {
  /** Nome do diretório (basename) — pode divergir do `name:` interno se o `.md` nem parseou. */
  readonly dirName: string;
  readonly reason: string;
}

/** O DADO já carregado pelo registry confinado (`services-store.ts`). */
export interface ServicesListInput {
  readonly services: readonly ServiceListEntry[];
  readonly errors: readonly ServiceListRejection[];
  /** O caminho do dir de serviços (`~/.aluy/services/`), abreviado p/ exibição. */
  readonly servicesDir?: string;
}

/** Teto de chars da 1 linha de descrição exibida (espelha `workflowDescriptionLine`). */
const MAX_DESC_LEN = 100;

/** Deriva a 1 LINHA de descrição exibida. PURO. */
export function serviceDescriptionLine(m: ServiceManifest): string {
  const raw = m.description ?? '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  if (flat.length <= MAX_DESC_LEN) return flat;
  return `${flat.slice(0, MAX_DESC_LEN - 1).trimEnd()}…`;
}

/**
 * FORMATA a nota completa de `/service` (sem argumento) / `aluy service list`: os
 * VÁLIDOS (✓) com nome · estado (fase 1: sempre "parado") · próximo schedule ·
 * descrição, e os REJEITADOS (⚠) com o motivo exato. Estado VAZIO ⇒ dica de onde
 * instalar. PURO/determinístico.
 */
export function buildServicesNote(input: ServicesListInput): ServicesListNote {
  const servicesDir = input.servicesDir ?? '~/.aluy/services';
  const lines: string[] = [];

  const valid = [...input.services].sort((a, b) => a.name.localeCompare(b.name));
  const rejected = [...input.errors].sort((a, b) => a.dirName.localeCompare(b.dirName));

  if (valid.length === 0 && rejected.length === 0) {
    return {
      title: 'service',
      lines: [
        `nenhum serviço instalado — instale um diretório-manifesto em ${servicesDir}/<nome>/`,
        'com `aluy service install <path|git-url>` (ou `/service install` nesta sessão).',
        'um serviço é um diretório com `service.md` (frontmatter = contrato duro; corpo =',
        'o orquestrador) + subpastas agents/workflows/skills/… no formato já existente.',
      ],
    };
  }

  if (valid.length > 0) {
    lines.push(`instalados (${valid.length}):`);
    for (const s of valid) {
      const desc = serviceDescriptionLine(s.manifest);
      const descSuffix = desc !== '' ? ` · ${desc}` : '';
      const schedule = s.manifest.schedule !== undefined ? s.manifest.schedule : 'sem schedule';
      // Fase 1 — SEM runner: todo serviço instalado está "parado" (não há processo
      // ainda pra estar em outro estado; ADR-0158 §5 é a fatia 2 deste subsistema).
      lines.push(`  ✓ ${s.name} · parado · próximo turno: ${schedule}${descSuffix}`);
    }
  }

  if (rejected.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`rejeitados (${rejected.length}) — não foram carregados por estarem inválidos:`);
    for (const e of rejected) {
      lines.push(`  ⚠ ${e.dirName}`);
      lines.push(`      ${e.reason}`);
    }
  }

  lines.push('');
  lines.push(
    `serviços vivem em ${servicesDir}/<nome>/ · start/stop chegam na fase 2 (ADR-0158 §5).`,
  );

  return { title: 'service', lines };
}
