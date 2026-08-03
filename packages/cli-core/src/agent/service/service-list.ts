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
// ADR-0158 §5 pt.4 (FASE 3, item 4 da missão) — "status/list mostram 'aguardando
// dono (pergunta enviada há X)'": reusa o MESMO formatador de elapsed do canal.
import { formatElapsedSince } from './service-messages.js';

/** Uma nota (título + linhas) — espelha o `SlashNote` do @hiperplano/aluy-cli, sem acoplar a ele. */
export interface ServicesListNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * ADR-0158 §5 (fase 2) — o estado REAL de um serviço (pidfile+kill-0 do runner
 * concreto, `@hiperplano/aluy-cli`, `service/status.ts`). Campo OPCIONAL: quando
 * AUSENTE, `buildServicesNote` mantém o comportamento da fase 1 ("parado" fixo,
 * NÃO editamos os testes da fase 1 — eles continuam passando sem este campo).
 */
export interface ServiceRuntimeStatusInput {
  readonly running: boolean;
  /** Só quando `running` (best-effort, pode faltar num runner recém-morto). */
  readonly turnState?: 'sleeping' | 'running-turn' | 'awaiting-owner';
  readonly nextFireIso?: string;
  /**
   * ADR-0158 §5 pt.4 (FASE 3) — ISO do momento em que a pergunta PENDENTE foi
   * enviada ao canal (só relevante quando `turnState === 'awaiting-owner'`) — usado
   * p/ exibir "pergunta enviada há X" (missão item 4). Ausente ⇒ mostra sem o "há X"
   * (não regressão de quem não tem o dado, ex.: snapshot de uma versão anterior).
   */
  readonly pendingSinceIso?: string;
}

/** Um serviço já VALIDADO pelo registry (manifesto parseável + cron/workflow OK). */
export interface ServiceListEntry {
  readonly name: string;
  readonly manifest: ServiceManifest;
  /** ADR-0158 §5 (fase 2) — estado REAL, opcional (ver `ServiceRuntimeStatusInput`). */
  readonly runtimeStatus?: ServiceRuntimeStatusInput;
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
  /** Relógio INJETÁVEL (teste) p/ o "há X" do `pendingSinceIso` — default `Date.now()`
   * no caller (esta função é PURA; não lê o relógio sozinha se isto for passado). */
  readonly nowMs?: number;
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
  const nowMs = input.nowMs ?? Date.now();
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
      // ADR-0158 §5 (fase 2) — `runtimeStatus` presente ⇒ estado REAL; AUSENTE ⇒
      // mantém o "parado" fixo da fase 1 (não-regressão dos testes da fase 1).
      const rt = s.runtimeStatus;
      // ADR-0158 §5 pt.4 (FASE 3, missão item 4) — "aguardando dono (pergunta
      // enviada há X)": só quando temos `pendingSinceIso` (ausência = não regride
      // p/ quem ainda não tem o dado — snapshot antigo, ou dado apagado por erro).
      const pendingSuffix =
        rt?.turnState === 'awaiting-owner' && rt.pendingSinceIso !== undefined
          ? ` (pergunta enviada há ${formatElapsedSince(nowMs - Date.parse(rt.pendingSinceIso))})`
          : '';
      const stateLabel =
        rt === undefined
          ? 'parado'
          : !rt.running
            ? 'parado'
            : rt.turnState === 'running-turn'
              ? 'RODANDO · turno em andamento'
              : rt.turnState === 'awaiting-owner'
                ? `RODANDO · ⚠ aguardando dono${pendingSuffix}`
                : 'RODANDO · dormindo';
      const nextSuffix =
        rt?.running === true && rt.turnState === 'sleeping' && rt.nextFireIso !== undefined
          ? ` (${rt.nextFireIso})`
          : '';
      lines.push(`  ✓ ${s.name} · ${stateLabel} · próximo turno: ${schedule}${nextSuffix}${descSuffix}`);
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
    `serviços vivem em ${servicesDir}/<nome>/ · "aluy service start|stop <nome>" liga/desliga.`,
  );

  return { title: 'service', lines };
}
