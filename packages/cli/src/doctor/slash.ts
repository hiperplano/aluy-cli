// EST-0970 — `/doctor` na SESSÃO: monta os fatos com o CONTEXTO da sessão (token
// real p/ os probes autenticados + a validação de credencial; transport p/ CONECTAR
// os servers MCP de verdade; contagem da memória já montada; raiz do workspace; modo
// --yolo) e dirige uma CHECKLIST PROGRESSIVA: cada item nasce `pending` (spinner) e
// "acende" (✓/⚠/✗) quando o probe resolve aquele check — os ticks AO VIVO (#120→EST-0970).
//
// Espelha o `aluy doctor` do shell (commands/doctor.ts) — MESMA camada pura
// (gatherDoctorFacts → buildSingleCheck/buildDoctorReport → render). Read-only, sem
// gasto de modelo no default. O teste do tier ao vivo (`--deep`) GASTA 1 chamada mínima
// e SÓ roda quando o caller injeta o `tierTester` (opt-in).

import type { LoginService } from '@aluy/cli-core';
import { gatherDoctorFacts, type DoctorProbeDeps, type MemoryCounter } from './probe.js';
import {
  buildDoctorReport,
  buildSingleCheck,
  plannedCheckIds,
  summarize,
  type DoctorFacts,
} from './checks.js';

/** UMA linha da checklist viva (espelha `DoctorCheckLine` do model, sem o import). */
export interface DoctorLiveCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'pending' | 'ok' | 'warn' | 'fail';
  readonly detail?: string;
  readonly fix?: string;
}

/** Estado corrente da checklist (passado a cada update + no final, com o resumo). */
export interface DoctorLiveState {
  readonly checks: readonly DoctorLiveCheck[];
  /** Resumo `N ok · N aviso · N falha` — só presente no estado FINAL. */
  readonly summary?: string;
}

/** Nota (bloco) que a TUI empurra — mesmo formato do `SlashNote` dos handlers. */
export interface DoctorSlashNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Contexto da SESSÃO p/ o `/doctor` — o que o run.tsx já tem montado. */
export interface DoctorSlashContext {
  /** LoginService da sessão — provê o token p/ os probes autenticados + validação de auth. */
  readonly login: LoginService;
  /** Contador de memória já montado (AgentMemory da sessão). */
  readonly memory: MemoryCounter;
  /** Raiz do workspace (p/ ler o `.mcp.json` de projeto). */
  readonly workspaceRoot?: string;
  /** A sessão está em modo YOLO/unsafe? (vira a flag `--yolo` na seção config). */
  readonly unsafe?: boolean;
  /** `fetch`/glifos/env injetáveis p/ teste (sem rede real). */
  readonly env?: NodeJS.ProcessEnv;
  readonly probeOverride?: Partial<DoctorProbeDeps>;
}

/**
 * EST-0970 (ticks AO VIVO) — dirige a checklist PROGRESSIVA do `/doctor`:
 *  1. semeia TODOS os checks em `pending` (`onUpdate` 1× com a lista inteira pendente);
 *  2. roda o probe — cada fato que resolve "acende" o tick daquele check (`onUpdate`);
 *  3. ao fim, emite o estado FINAL com o resumo.
 *
 * Read-only, sem gasto de modelo (a validação de credencial é GET; o tier ao vivo só roda
 * sob `--deep` via `probeOverride.tierTester`). Cada check degrada isolado (o probe blinda
 * os gatherers). `onUpdate` é chamado de forma síncrona dentro do `onCheck` do probe.
 */
export async function runDoctorLive(
  ctx: DoctorSlashContext,
  onUpdate: (state: DoctorLiveState) => void,
): Promise<DoctorLiveState> {
  const deep = ctx.probeOverride?.tierTester !== undefined;
  const planned = plannedCheckIds(deep);

  // estado vivo: começa tudo `pending`.
  const lines: DoctorLiveCheck[] = planned.map((p) => ({
    id: p.id,
    label: p.label,
    status: 'pending',
  }));
  const byId = new Map(lines.map((l, i) => [l.id, i] as const));
  onUpdate({ checks: [...lines] });

  const extraFlags = ctx.unsafe === true ? ['--yolo'] : [];
  const probeDeps: DoctorProbeDeps = {
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx.workspaceRoot !== undefined ? { workspaceRoot: ctx.workspaceRoot } : {}),
    getAccessToken: () => ctx.login.getAccessToken(),
    memory: ctx.memory,
    extraFlags,
    ...(ctx.probeOverride ?? {}),
    // O `onCheck` é o motor dos ticks AO VIVO — vai por ÚLTIMO p/ NUNCA ser clobberado
    // por um `probeOverride` (teste injeta gatherers/tierTester, não o onCheck).
    onCheck: (id, facts) => {
      const check = buildSingleCheck(id, facts);
      const idx = byId.get(id);
      if (check && idx !== undefined) {
        lines[idx] = {
          id,
          label: check.label,
          status: check.status,
          ...(check.detail !== undefined ? { detail: check.detail } : {}),
          ...(check.fix !== undefined ? { fix: check.fix } : {}),
        };
        onUpdate({ checks: [...lines] });
      }
    },
  };

  const facts: DoctorFacts = await gatherDoctorFacts(probeDeps);
  // estado FINAL pelo relatório completo (fonte da verdade; reconcilia qualquer linha).
  const report = buildDoctorReport(facts);
  const finalLines: DoctorLiveCheck[] = report.checks.map((c) => ({
    id: c.id,
    label: c.label,
    status: c.status,
    detail: c.detail,
    ...(c.fix !== undefined ? { fix: c.fix } : {}),
  }));
  const final: DoctorLiveState = { checks: finalLines, summary: summarize(report.checks) };
  onUpdate(final);
  return final;
}
