// PAUSA POR COTA — o coordenador COMPARTILHADO da sessão.
//
// Quando a cota do modelo acaba, o agente (principal OU sub-agente) NÃO morre: ele PAUSA.
// Todo o trabalho dele está vivo na pilha do `AgentLoop` (histórico, orçamento, ferramentas
// já feitas) — a pausa é só um `await` dentro da chamada de modelo, que volta quando a cota
// libera. Este módulo é esse `await`, compartilhado:
//
//   - UM episódio por sessão (a sessão fala com um provider/credencial). Quando um agente
//     bate na cota, os IRMÃOS não martelam o provider: ao tentar a próxima chamada eles
//     esperam no mesmo portão (`gate`). Os que já estavam em voo caem na mesma pausa.
//   - SONDAGEM controlada: no horário de reset (ou na escada de backoff, se o provider não
//     disse) UM agente é eleito sondador e refaz a PRÓPRIA chamada pendente. Deu certo ⇒
//     `ok()` libera todo mundo. Falhou de novo ⇒ o episódio recalcula e segue. Nunca há
//     mais de uma chamada de sondagem em voo, e nunca laço apertado (CLI-SEC-8).
//   - TETO de espera total por episódio (`maxWaitMs`). Estourou ⇒ "parar salvando"
//     automático: os agentes recebem `QuotaPauseStoppedError` (não é falha: é pausa durável).
//   - INTERROMPÍVEL: o `AbortSignal` de cada agente (ESC/Ctrl-C) tira o agente da pausa com
//     `ModelCallAbortedError`, exatamente como uma chamada de modelo cancelada.
//   - SNAPSHOTS: a cada agente que entra na pausa guardamos o histórico dele, para o locus
//     persistir (retomada após reinício do processo).
//
// NÃO toca a catraca (`decide()`): pausar não aprova, nega nem executa efeito algum.
// PORTÁVEL (ADR-0053 §8): sem Ink, sem I/O de terminal. Relógio e timers injetáveis.

import type { HistoryItem } from './context.js';
import { ModelCallAbortedError, QuotaPauseStoppedError } from '../model/errors.js';
import {
  BALANCE_MAX_WAIT_MS,
  classifyQuota,
  exceedsShortRetry,
  probeDelayMs,
  type QuotaPauseConfig,
  type QuotaScope,
} from '../model/quota-pause.js';

/** Dados mínimos de um perfil de sub-agente para re-spawnar na retomada. */
export interface PausedProfile {
  readonly label: string;
  readonly goal: string;
  readonly agent?: string;
  readonly context?: string;
  readonly model?: string;
}

/** Foto de um agente pausado — o que é preciso para ele continuar de onde parou. */
export interface PausedAgentSnapshot {
  readonly label: string;
  readonly kind: 'principal' | 'subagente';
  /** Histórico íntegro no instante da pausa (termina antes da chamada de modelo pendente). */
  readonly history: readonly HistoryItem[];
  /** Só sub-agente: como recriá-lo. */
  readonly profile?: PausedProfile;
  readonly pausedAt: number;
}

/** Visão do episódio para a TUI (sem históricos — leve, serializável). */
export interface QuotaPauseView {
  readonly scope: QuotaScope;
  readonly reason: string;
  /** Horário de reset informado pelo provider (epoch ms). `undefined` ⇒ sondagem periódica. */
  readonly resetAtMs: number | undefined;
  /** Próxima sondagem/retomada automática (epoch ms). */
  readonly nextProbeAtMs: number;
  readonly startedAt: number;
  /** Quando a espera máxima estoura e vira "parar salvando" (epoch ms). */
  readonly deadlineAtMs: number;
  readonly probes: number;
  /** Há uma sondagem em voo agora. */
  readonly probing: boolean;
  /** Só recarga resolve (saldo): a UI diz "recarregue e pressione ↵". */
  readonly manual: boolean;
  readonly agents: readonly { readonly label: string; readonly kind: 'principal' | 'subagente' }[];
}

/** Como o episódio terminou. */
export type QuotaPauseEnd = 'retomada' | 'parada' | 'tempo-maximo' | 'cancelada';

export type QuotaPauseEvent =
  | { readonly type: 'pausa'; readonly view: QuotaPauseView }
  | {
      readonly type: 'fim';
      readonly how: QuotaPauseEnd;
      /** Fotos dos agentes que estavam pausados (relevante para `parada`/`tempo-maximo`). */
      readonly snapshots: readonly PausedAgentSnapshot[];
    };

/** O que o loop passa a cada chamada do portão/tratamento. */
export interface QuotaPauseCallContext {
  readonly signal?: AbortSignal | undefined;
  /** Histórico VIVO do agente (cópia feita só se ele de fato pausar). */
  readonly history: () => readonly HistoryItem[];
}

/** A porta que o `AgentLoop` enxerga (uma por agente). */
export interface QuotaPausePort {
  /** Antes de cada chamada de modelo: bloqueia se a sessão está em pausa. */
  gate(ctx: QuotaPauseCallContext): Promise<void>;
  /**
   * Depois de uma chamada que LANÇOU: se for cota, pausa e só devolve quando for hora de
   * tentar de novo; senão RELANÇA o erro original. Lança `QuotaPauseStoppedError` /
   * `ModelCallAbortedError` se a pausa terminou sem retomar.
   */
  handle(err: unknown, ctx: QuotaPauseCallContext): Promise<void>;
  /** Depois de uma chamada que deu certo: a cota voltou, libera a sessão. */
  ok(): void;
}

export interface QuotaPauseCoordinatorOptions {
  readonly config: QuotaPauseConfig;
  readonly now?: () => number;
}

interface Waiter {
  readonly label: string;
  readonly signal: AbortSignal | undefined;
  readonly release: () => void;
  resolve(): void;
  reject(e: unknown): void;
  /** Remove o ouvinte de abort. */
  detach(): void;
}

interface Episode {
  scope: QuotaScope;
  reason: string;
  manual: boolean;
  resetAtMs: number | undefined;
  nextProbeAt: number;
  readonly startedAt: number;
  readonly deadlineAt: number;
  probes: number;
  probing: Waiter | null;
  probingLabel: string | null;
  waiters: Waiter[];
  readonly agents: Map<string, PausedAgentSnapshot>;
}

export interface AgentSpec {
  readonly label: string;
  readonly kind: 'principal' | 'subagente';
  readonly profile?: PausedProfile;
  /** Suspende o relógio de inatividade do filho enquanto ele espera (`IdleTimer.hold`). */
  readonly hold?: () => () => void;
}

export class QuotaPauseCoordinator {
  private readonly cfg: QuotaPauseConfig;
  private readonly now: () => number;
  private ep: Episode | null = null;
  private stopped: { why: 'usuario' | 'tempo-maximo' } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(e: QuotaPauseEvent) => void>();

  constructor(opts: QuotaPauseCoordinatorOptions) {
    this.cfg = opts.config;
    this.now = opts.now ?? ((): number => Date.now());
  }

  /** A pausa está habilitada? (`ALUY_QUOTA_PAUSE=off` desliga). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Observa o ciclo de vida. Devolve o desinscrever. */
  subscribe(fn: (e: QuotaPauseEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Visão atual (ou `null` se não há pausa). */
  get view(): QuotaPauseView | null {
    return this.ep ? this.toView(this.ep) : null;
  }

  /** Fotos dos agentes pausados agora. */
  snapshots(): readonly PausedAgentSnapshot[] {
    return this.ep ? [...this.ep.agents.values()] : [];
  }

  /** A sessão está em "parada" (o dono mandou parar salvando) até o próximo `rearm`? */
  get isStopped(): boolean {
    return this.stopped !== null;
  }

  /** Novo turno do dono / retomada explícita: limpa o estado "parada". */
  rearm(): void {
    this.stopped = null;
  }

  /** "Tentar agora": antecipa a sondagem sem esperar o horário. */
  resumeNow(): void {
    this.stopped = null;
    const ep = this.ep;
    if (!ep) return;
    ep.nextProbeAt = this.now();
    this.elect();
    this.schedule();
  }

  /** "Parar salvando": encerra a pausa SEM retomar; os agentes recebem o erro de parada. */
  stop(why: 'usuario' | 'tempo-maximo' = 'usuario'): void {
    const ep = this.ep;
    this.stopped = { why };
    if (!ep) return;
    const snapshots = [...ep.agents.values()];
    const all = [...ep.waiters, ...(ep.probing ? [ep.probing] : [])];
    this.ep = null;
    this.clearTimer();
    this.emit({ type: 'fim', how: why === 'usuario' ? 'parada' : 'tempo-maximo', snapshots });
    for (const w of all) {
      w.detach();
      w.release();
      w.reject(new QuotaPauseStoppedError(why));
    }
  }

  /** Cria a porta de UM agente. */
  forAgent(spec: AgentSpec): QuotaPausePort {
    return {
      gate: (ctx) => this.gate(spec, ctx),
      handle: (err, ctx) => this.handle(spec, err, ctx),
      ok: () => this.ok(),
    };
  }

  // ── núcleo ─────────────────────────────────────────────────────────────────

  private async gate(spec: AgentSpec, ctx: QuotaPauseCallContext): Promise<void> {
    if (!this.cfg.enabled) return;
    if (ctx.signal?.aborted) throw new ModelCallAbortedError();
    if (this.stopped) throw new QuotaPauseStoppedError(this.stopped.why);
    const ep = this.ep;
    if (!ep) return;
    // Irmão chegando durante a pausa: não martela. Se já passou da hora e ninguém sonda,
    // ele mesmo é o sondador; senão espera no portão.
    if (!ep.probing && ep.waiters.length === 0 && this.now() >= ep.nextProbeAt) {
      this.becomeProbe(ep, spec.label, ctx.signal);
      return;
    }
    this.snapshot(ep, spec, ctx);
    await this.park(ep, spec, ctx.signal);
  }

  private async handle(spec: AgentSpec, err: unknown, ctx: QuotaPauseCallContext): Promise<void> {
    const ep0 = this.ep;
    const wasProbe = ep0?.probingLabel === spec.label;
    let verdict = this.cfg.enabled ? classifyQuota(err, this.now()) : null;
    // Rate-limit CURTO (429 sem janela/saldo e sem reset longo) no agente PRINCIPAL: quem
    // cuida é a retentativa em camadas (`retry.ts` + auto-retry do controller), como sempre.
    // Já os sub-agentes não têm essa rede de proteção (N filhos num só provider esgotam o rate
    // limit à toa), então eles pausam. Se já há pausa em curso, o principal junta-se a ela.
    if (
      verdict?.scope === 'taxa' &&
      spec.kind === 'principal' &&
      !this.ep &&
      !exceedsShortRetry(err, this.now())
    ) {
      verdict = null;
    }
    if (verdict === null) {
      // Não é cota (definitivo, transitório já esgotado, cancelamento…): se era o sondador,
      // solta o posto e elege outro; o erro segue seu caminho de sempre.
      if (wasProbe && ep0) {
        this.dropProbe(ep0);
        this.elect();
        this.schedule();
      }
      throw err;
    }
    if (ctx.signal?.aborted) throw new ModelCallAbortedError();
    if (this.stopped) throw new QuotaPauseStoppedError(this.stopped.why);

    const now = this.now();
    let ep = this.ep;
    if (!ep) {
      ep = {
        scope: verdict.scope,
        reason: verdict.reason,
        manual: verdict.manual,
        resetAtMs: verdict.resetAtMs,
        nextProbeAt: verdict.resetAtMs ?? now + probeDelayMs(0, verdict.manual),
        startedAt: now,
        // Saldo esgotado: esperar não repõe. Não fica horas sondando — teto curto, e o
        // trabalho fica salvo (parar salvando) para retomar depois da recarga.
        deadlineAt:
          now +
          (verdict.manual ? Math.min(this.cfg.maxWaitMs, BALANCE_MAX_WAIT_MS) : this.cfg.maxWaitMs),
        probes: 0,
        probing: null,
        probingLabel: null,
        waiters: [],
        agents: new Map(),
      };
      this.ep = ep;
    } else {
      ep.scope = verdict.scope;
      ep.reason = verdict.reason;
      ep.manual = verdict.manual;
      if (wasProbe) {
        // A sondagem falhou de novo: recalcula a próxima espera.
        this.dropProbe(ep);
        ep.probes += 1;
        ep.resetAtMs = verdict.resetAtMs;
        ep.nextProbeAt = verdict.resetAtMs ?? now + probeDelayMs(ep.probes, ep.manual);
      } else if (verdict.resetAtMs !== undefined) {
        ep.resetAtMs = Math.max(ep.resetAtMs ?? 0, verdict.resetAtMs);
        ep.nextProbeAt = Math.max(ep.nextProbeAt, verdict.resetAtMs);
      }
    }
    if (now >= ep.deadlineAt) {
      this.stop('tempo-maximo');
      throw new QuotaPauseStoppedError('tempo-maximo');
    }
    this.snapshot(ep, spec, ctx);
    this.emit({ type: 'pausa', view: this.toView(ep) });
    await this.park(ep, spec, ctx.signal);
  }

  private ok(): void {
    const ep = this.ep;
    if (!ep) return;
    const all = [...ep.waiters, ...(ep.probing ? [ep.probing] : [])];
    this.ep = null;
    this.clearTimer();
    this.emit({ type: 'fim', how: 'retomada', snapshots: [] });
    for (const w of all) {
      w.detach();
      w.release();
      w.resolve();
    }
  }

  private snapshot(ep: Episode, spec: AgentSpec, ctx: QuotaPauseCallContext): void {
    ep.agents.set(spec.label, {
      label: spec.label,
      kind: spec.kind,
      history: [...ctx.history()],
      ...(spec.profile ? { profile: spec.profile } : {}),
      pausedAt: this.now(),
    });
  }

  private park(ep: Episode, spec: AgentSpec, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const release = spec.hold?.() ?? ((): void => undefined);
      const w: Waiter = {
        label: spec.label,
        signal,
        release,
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      const onAbort = (): void => {
        this.removeWaiter(w);
        release();
        reject(new ModelCallAbortedError());
      };
      if (signal?.aborted) {
        release();
        reject(new ModelCallAbortedError());
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      ep.waiters.push(w);
      this.emit({ type: 'pausa', view: this.toView(ep) });
      this.schedule();
    });
  }

  private removeWaiter(w: Waiter): void {
    const ep = this.ep;
    if (!ep) return;
    ep.waiters = ep.waiters.filter((x) => x !== w);
    ep.agents.delete(w.label);
    if (ep.probing === w) {
      this.dropProbe(ep);
      this.elect();
    }
    if (ep.waiters.length === 0 && !ep.probing) {
      // Ninguém mais espera (todos cancelaram): dissolve o episódio.
      this.ep = null;
      this.clearTimer();
      this.emit({ type: 'fim', how: 'cancelada', snapshots: [] });
      return;
    }
    this.schedule();
  }

  private dropProbe(ep: Episode): void {
    ep.probing?.detach();
    ep.probing = null;
    ep.probingLabel = null;
  }

  private becomeProbe(ep: Episode, label: string, signal: AbortSignal | undefined): void {
    ep.probingLabel = label;
    ep.probing = {
      label,
      signal,
      release: () => undefined,
      resolve: () => undefined,
      reject: () => undefined,
      detach: () => undefined,
    };
    this.emit({ type: 'pausa', view: this.toView(ep) });
    this.schedule();
  }

  /** Elege o próximo sondador, se já é hora e ninguém sonda. */
  private elect(): void {
    const ep = this.ep;
    if (!ep || ep.probing || ep.waiters.length === 0) return;
    if (this.now() < ep.nextProbeAt) return;
    const w = ep.waiters.shift()!;
    // O ouvinte de abort continua anexado: se o sondador for cancelado antes de chamar,
    // `removeWaiter` solta o posto (ver `onAbort`).
    ep.probing = w;
    ep.probingLabel = w.label;
    w.release();
    w.resolve();
    this.emit({ type: 'pausa', view: this.toView(ep) });
  }

  private schedule(): void {
    this.clearTimer();
    const ep = this.ep;
    if (!ep) return;
    const at = ep.probing ? ep.deadlineAt : Math.min(ep.nextProbeAt, ep.deadlineAt);
    const delay = Math.max(0, at - this.now());
    // NÃO usa `unref`: em execução headless este timer é o que mantém o processo vivo.
    this.timer = setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    this.timer = null;
    const ep = this.ep;
    if (!ep) return;
    if (this.now() >= ep.deadlineAt) {
      this.stop('tempo-maximo');
      return;
    }
    this.elect();
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private toView(ep: Episode): QuotaPauseView {
    return {
      scope: ep.scope,
      reason: ep.reason,
      resetAtMs: ep.resetAtMs,
      nextProbeAtMs: ep.nextProbeAt,
      startedAt: ep.startedAt,
      deadlineAtMs: ep.deadlineAt,
      probes: ep.probes,
      probing: ep.probing !== null,
      manual: ep.manual,
      agents: [...ep.agents.values()].map((a) => ({ label: a.label, kind: a.kind })),
    };
  }

  private emit(e: QuotaPauseEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch {
        /* observador é best-effort: nunca derruba a pausa. */
      }
    }
  }
}
