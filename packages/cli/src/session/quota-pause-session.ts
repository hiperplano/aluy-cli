// PAUSA POR COTA — cola entre o coordenador do core e a sessão da TUI.
//
// O core decide QUANDO pausar/retomar (`QuotaPauseCoordinator`). Aqui fica o que é do
// locus: persistir a foto do trabalho pausado (`PausaStore`), avisar o dono em PT-BR e
// formatar o texto do banner/contagem regressiva (PURO, testável sem Ink).

import {
  QuotaPauseCoordinator,
  quotaScopeLabel,
  resolveQuotaPause,
  type HistoryItem,
  type PausedAgentSnapshot,
  type QuotaPauseConfig,
  type QuotaPauseEvent,
  type QuotaPauseView,
} from '@hiperplano/aluy-cli-core';
import type { PausaStore } from '../io/pausa-store.js';

/** Config da pausa a partir do env da sessão (`ALUY_QUOTA_PAUSE`, `ALUY_QUOTA_MAX_WAIT`). */
export function quotaPauseConfigFromEnv(env: Record<string, string | undefined>): QuotaPauseConfig {
  return resolveQuotaPause({
    pauseEnv: env['ALUY_QUOTA_PAUSE'],
    maxWaitEnv: env['ALUY_QUOTA_MAX_WAIT'],
  });
}

/** "2h 05min", "12min 04s", "37s". PURO. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m > 0) return `${m}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Hora local "HH:MM" (ou "dd/mm HH:MM" se não for hoje). PURO (relógio injetado). */
export function formatClock(epochMs: number, nowMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const same = new Date(nowMs).toDateString() === d.toDateString();
  return same ? hm : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${hm}`;
}

/**
 * As linhas do banner de pausa (PT-BR), SEM glifos/cores — a TUI decorra. O primeiro item
 * é o título; depois vêm o estado, o relógio e as escolhas do dono.
 */
export function quotaPauseLines(view: QuotaPauseView, nowMs: number): string[] {
  const who = view.agents.map((a) => a.label).join(', ');
  const lines: string[] = [];
  if (view.manual) {
    // Saldo esgotado: esperar NÃO repõe. Diz isso, sonda de forma esparsa e pede a recarga.
    lines.push(`pausado — ${quotaScopeLabel(view.scope)}: recarregue o saldo`);
    if (who !== '')
      lines.push(`agentes pausados: ${who} — o trabalho está guardado, nada foi perdido`);
    lines.push('esperar não repõe saldo: recarregue no provedor e pressione ↵ para retomar');
    lines.push(
      view.probing
        ? 'tentando retomar agora…'
        : `verificação automática (esparsa) em ${formatCountdown(view.nextProbeAtMs - nowMs)} ` +
            `(${formatClock(view.nextProbeAtMs, nowMs)})`,
    );
    lines.push(
      `se nada mudar, o trabalho é salvo sozinho em ${formatCountdown(view.deadlineAtMs - nowMs)} ` +
        '— retome depois com `aluy --continue`',
    );
    return lines;
  }
  lines.push(`pausado — cota esgotada (${quotaScopeLabel(view.scope)})`);
  if (who !== '')
    lines.push(`agentes pausados: ${who} — o trabalho está guardado, nada foi perdido`);
  if (view.probing) {
    lines.push('tentando retomar agora…');
  } else if (view.resetAtMs !== undefined && view.resetAtMs > nowMs) {
    lines.push(
      `a cota deve liberar às ${formatClock(view.resetAtMs, nowMs)} ` +
        `(em ${formatCountdown(view.resetAtMs - nowMs)}) — retoma sozinho`,
    );
  } else {
    lines.push(
      `sem horário do provedor — nova tentativa em ${formatCountdown(view.nextProbeAtMs - nowMs)} ` +
        `(${formatClock(view.nextProbeAtMs, nowMs)}), a cada vez mais espaçada`,
    );
  }
  lines.push(`espera máxima restante: ${formatCountdown(view.deadlineAtMs - nowMs)}`);
  return lines;
}

/** A linha das escolhas (afordância). */
export const QUOTA_PAUSE_CHOICES =
  'esperar (automático) · ↵ tentar agora · ctrl+g parar salvando · esc cancela o turno';

export interface QuotaPauseSessionOptions {
  readonly config: QuotaPauseConfig;
  readonly store: () => PausaStore | null;
  readonly sessionId: () => string;
  /** A TUI recebe a visão atual (ou `undefined` quando a pausa acabou). */
  readonly onView: (view: QuotaPauseView | undefined) => void;
  /** Avisos ao dono (viram nota no transcript / linha no headless). */
  readonly note: (title: string, lines: readonly string[]) => void;
  readonly now?: () => number;
}

/** Dono do coordenador da sessão + persistência da pausa. */
export class QuotaPauseSession {
  readonly coordinator: QuotaPauseCoordinator;
  private lastKey = '';
  private stopped: readonly PausedAgentSnapshot[] = [];
  private lastView: QuotaPauseView | undefined;

  constructor(private readonly opts: QuotaPauseSessionOptions) {
    this.coordinator = new QuotaPauseCoordinator({
      config: opts.config,
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.coordinator.subscribe((e) => this.onEvent(e));
  }

  private persist(agents: readonly PausedAgentSnapshot[], view: QuotaPauseView | undefined): void {
    const store = this.opts.store();
    if (!store || agents.length === 0) return;
    const v = view ?? this.lastView;
    store.save({
      sessionId: this.opts.sessionId(),
      scope: v?.scope ?? 'desconhecido',
      reason: v?.reason ?? '',
      ...(v?.resetAtMs !== undefined ? { resetAtMs: v.resetAtMs } : {}),
      agents,
    });
  }

  private onEvent(e: QuotaPauseEvent): void {
    if (e.type === 'pausa') {
      const first = this.lastView === undefined;
      this.lastView = e.view;
      this.opts.onView(e.view);
      const key = e.view.agents.map((a) => a.label).join('|');
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.persist(this.coordinator.snapshots(), e.view);
      }
      if (first) {
        this.opts.note('pausado por cota', quotaPauseLines(e.view, this.now()).slice(0, 3));
      }
      return;
    }
    // fim
    const view = this.lastView;
    this.lastView = undefined;
    this.lastKey = '';
    this.opts.onView(undefined);
    if (e.how === 'retomada') {
      this.opts.store()?.remove(this.opts.sessionId());
      this.opts.note('cota liberada', [
        'a cota voltou — os agentes pausados retomaram de onde pararam.',
      ]);
    } else if (e.how === 'cancelada') {
      this.opts.store()?.remove(this.opts.sessionId());
    } else {
      this.stopped = e.snapshots;
      this.persist(e.snapshots, view);
      this.opts.note('pausado e salvo', [
        e.how === 'tempo-maximo'
          ? 'a espera máxima por cota esgotou — o trabalho foi salvo.'
          : 'você parou a espera — o trabalho foi salvo.',
        'retome depois com `aluy --continue` (ou `aluy --resume <id>`): os agentes continuam de onde pararam.',
      ]);
    }
  }

  /** Depois de parar: acrescenta o histórico do agente principal à foto salva. */
  attachPrincipal(history: readonly HistoryItem[]): void {
    const others = this.stopped.filter((a) => a.kind !== 'principal');
    const agents: PausedAgentSnapshot[] = [
      ...others,
      { label: 'principal', kind: 'principal', history: [...history], pausedAt: this.now() },
    ];
    this.stopped = agents;
    this.persist(agents, undefined);
  }

  /** Foto dos filhos pausados da última parada (para o controller enriquecer/usar). */
  get stoppedAgents(): readonly PausedAgentSnapshot[] {
    return this.stopped;
  }

  /** O dono retomou/descartou: esquece o que estava salvo. */
  clearSaved(): void {
    this.stopped = [];
    this.opts.store()?.remove(this.opts.sessionId());
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
