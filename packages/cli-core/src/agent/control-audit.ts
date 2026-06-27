// EST-0982 · ADR-0063 · CLI-SEC-10 (GS-C1/GS-C5) — AUDITORIA do plano de CONTROLE.
//
// Os verbos de controle sobre a árvore de fluxos (PARAR, INTERAGIR) são AÇÕES DO
// USUÁRIO pela borda do CLI — não do modelo. CLI-SEC-10 exige que fiquem auditadas
// com `actor_type=cli` e o NÓ-ALVO. Esta é a trilha (portável, sem I/O): um sink em
// memória que o @hiperplano/aluy-cli LÊ (e, se quiser, persiste). VER (drill-in) é leitura pura
// e NÃO gera evento (não é uma ação — GS-C3/GS-C4).
//
// PORTÁVEL (ADR-0053 §8): só estrutura + relógio injetável. Nenhum segredo trafega
// por aqui — eventos carregam id/label do nó e (no caso de INTERAGIR) um RESUMO
// REDIGIDO do input, nunca o stream cru (RES-C-1 reaplicado à trilha de auditoria).

import { redactCommandSecrets } from './journal/redact.js';

/** O ator de um evento de controle. SEMPRE `cli` aqui (ação do usuário pela borda). */
export type ControlActorType = 'cli';

/** Os verbos auditáveis do plano de controle (VER não audita — é leitura). */
export type ControlVerb = 'cancel' | 'cancel-all' | 'inject-input';

/** UM evento de controle auditado (CLI-SEC-10). */
export interface ControlAuditEvent {
  /** SEMPRE `cli` — ação do usuário pela borda, não do modelo. */
  readonly actorType: ControlActorType;
  readonly verb: ControlVerb;
  /** id do nó-alvo na árvore de fluxos (`root`, `root/rust`, …). `*` p/ cancel-all. */
  readonly targetId: string;
  /** Rótulo de origem do nó-alvo (CLI-SEC-9) — QUEM foi alvo. */
  readonly targetLabel: string;
  /** Carimbo de tempo (ms epoch — do relógio injetável). */
  readonly at: number;
  /**
   * Só p/ `inject-input`: um RESUMO REDIGIDO do input injetado (CLI-SEC-6). NUNCA o
   * texto cru se contiver segredo. Ausente nos verbos de cancelamento.
   */
  readonly inputDigest?: string;
}

/** Relógio injetável (teste determinístico). Default `Date.now`. */
export type AuditClock = () => number;

/** Quantos eventos manter (anti-crescimento ilimitado da trilha em memória). */
const MAX_EVENTS = 256;

/**
 * Trilha de auditoria do plano de controle (CLI-SEC-10). Em memória; o @hiperplano/aluy-cli a
 * consome (e pode persistir). Determinística, sem I/O, nunca lança.
 */
export class ControlAudit {
  private readonly events: ControlAuditEvent[] = [];
  private readonly clock: AuditClock;

  constructor(opts?: { readonly clock?: AuditClock }) {
    this.clock = opts?.clock ?? Date.now;
  }

  /** Audita um PARAR de UM nó (GS-C1). */
  recordCancel(targetId: string, targetLabel: string): ControlAuditEvent {
    return this.push({
      actorType: 'cli',
      verb: 'cancel',
      targetId,
      targetLabel,
      at: this.clock(),
    });
  }

  /** Audita um PARAR TODOS (GS-C1). */
  recordCancelAll(): ControlAuditEvent {
    return this.push({
      actorType: 'cli',
      verb: 'cancel-all',
      targetId: '*',
      targetLabel: 'todos',
      at: this.clock(),
    });
  }

  /**
   * Audita um INTERAGIR (GS-C5): input injetado num nó vivo. Guarda só um RESUMO
   * REDIGIDO do input (CLI-SEC-6) — nunca o texto cru se contiver segredo, e clampado
   * p/ não inchar a trilha. O CONTEÚDO em si vai p/ o contexto do agente como dado do
   * usuário (input-injection.ts), pela MESMA catraca — esta trilha só registra que
   * HOUVE injeção, contra QUEM, e um resumo seguro.
   */
  recordInjectInput(targetId: string, targetLabel: string, input: string): ControlAuditEvent {
    return this.push({
      actorType: 'cli',
      verb: 'inject-input',
      targetId,
      targetLabel,
      at: this.clock(),
      inputDigest: digestOf(input),
    });
  }

  /** Todos os eventos, na ordem de ocorrência (mais antigo primeiro). */
  get log(): readonly ControlAuditEvent[] {
    return this.events;
  }

  private push(e: ControlAuditEvent): ControlAuditEvent {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    return e;
  }
}

const DIGEST_MAX = 120;

/** Resumo SEGURO de um input: redigido (CLI-SEC-6) e clampado. Nunca lança. */
function digestOf(input: string): string {
  const redacted = redactCommandSecrets(input).replace(/\s+/g, ' ').trim();
  return redacted.length > DIGEST_MAX ? `${redacted.slice(0, DIGEST_MAX)}…` : redacted;
}
