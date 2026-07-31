// F-SIDECAR-USO (pedido do dono, dogfooding) — CONTABILIDADE DE **USO** DOS SIDECARS.
//
// PORQUÊ EXISTE: o que havia até aqui media **DISPONIBILIDADE**, não uso. O `/doctor`
// faz health-probe (`GET /health` em headroom :8787 / ollama :11434 / mem0 :11435) e
// reporta `headroom ✓ (200)` — isso diz que o sidecar está DE PÉ, jamais que ele foi
// CONSULTADO. No modo turbo os três sobem sozinhos, então "de pé" é o estado normal e
// não informa nada: o dono ficava sem saber se a compressão de contexto rodou, se o
// juiz opinou, se a memória foi lida/gravada. Este módulo conta o que IMPORTA — a
// chamada que de fato SAIU e VOLTOU.
//
// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ INVARIANTE CENTRAL — USO ≠ TENTATIVA ≠ DISPONIBILIDADE                       ║
// ║                                                                              ║
// ║ Os três sidecars são FAIL-OPEN por projeto (CA-MA8): erro/timeout/recusa ⇒ o ║
// ║ aluy segue com o caminho degradado (mensagens originais, motor-a heurístico,  ║
// ║ recall vazio) SEM quebrar o turno. Se contássemos a tentativa como uso, o     ║
// ║ indicador acenderia justamente quando o sidecar NÃO serviu pra nada — o       ║
// ║ oposto do que o dono pediu enxergar. Por isso `ok` só é incrementado quando o ║
// ║ resultado foi APROVEITADO, e a falha vira `fail` (sinal de sidecar caído).    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// PURO (ADR-0053 §8): zero I/O, zero Ink, zero rede. As bordas que de fato falam com
// os sidecars vivem no `@hiperplano/aluy-cli` (headroom.ts / ollama-judge.ts /
// mem0-memory-engine.ts) e só chamam `record()`. Aqui mora a DECISÃO — os 3 estados
// que a StatusBar pinta e os contadores que o `/doctor` imprime — testável sem rede.

import type { SidecarKind } from './boot-contract.js';

/** Contagem de chamadas de UM sidecar nesta sessão. */
export interface SidecarUseCounts {
  /**
   * Chamadas que saíram, voltaram e o resultado foi APROVEITADO. É o único número
   * que prova USO — o que acende o chip da StatusBar em `accent`.
   */
  readonly ok: number;
  /**
   * Chamadas que saíram e NÃO serviram (rede fora, timeout, HTTP ruim, resposta
   * recusada pelas travas anti-SSRF/HR-SEC). Fail-open ⇒ o turno seguiu sem o
   * sidecar. `fail>0 && ok===0` é a assinatura de "sidecar ligado mas CAÍDO".
   */
  readonly fail: number;
}

/** Contagens dos três sidecars nesta sessão. */
export interface SidecarUsage {
  readonly headroom: SidecarUseCounts;
  readonly ollama: SidecarUseCounts;
  readonly mem0: SidecarUseCounts;
}

/** Zero absoluto — o estado de uma sessão que ainda não consultou ninguém. */
export const EMPTY_SIDECAR_USAGE: SidecarUsage = Object.freeze({
  headroom: Object.freeze({ ok: 0, fail: 0 }),
  ollama: Object.freeze({ ok: 0, fail: 0 }),
  mem0: Object.freeze({ ok: 0, fail: 0 }),
});

/** Ordem CANÔNICA de exibição (chip da StatusBar e linha do `/doctor`). */
export const SIDECAR_ORDER: readonly SidecarKind[] = Object.freeze([
  'headroom',
  'ollama',
  'mem0',
] as const);

/**
 * CÓDIGO CURTO por sidecar p/ o chip da StatusBar. 3 letras: cabe em barra estreita
 * e ainda é lido sem legenda (`hdr`/`oll`/`mem`). Nomes de PRODUTO não se traduzem
 * (mesma regra de `PLAN`/`YOLO`/`MCP`), então isto NÃO é i18n.
 */
export const SIDECAR_CODE: Readonly<Record<SidecarKind, string>> = Object.freeze({
  headroom: 'hdr',
  ollama: 'oll',
  mem0: 'mem',
});

/**
 * REDUTOR PURO — registra UMA chamada. Devolve um objeto NOVO (nunca muta): o
 * `SidecarUsage` é cache de render (vai parar no `SessionState`), e a TUI compara por
 * identidade p/ decidir re-render.
 */
export function recordSidecarUse(
  prev: SidecarUsage,
  kind: SidecarKind,
  ok: boolean,
): SidecarUsage {
  const cur = prev[kind];
  return {
    ...prev,
    [kind]: { ok: cur.ok + (ok ? 1 : 0), fail: cur.fail + (ok ? 0 : 1) },
  };
}

/**
 * Os 3 ESTADOS que o dono pediu ver:
 *   • `off`  — não está de pé / não está ligado nesta sessão.
 *   • `idle` — ligado e de pé, porém AINDA NÃO consultado neste sessão.
 *   • `used` — consultado COM PROVEITO ≥1 vez (o número de chamadas é a prova).
 */
export type SidecarUseState = 'off' | 'idle' | 'used';

/**
 * DERIVAÇÃO PURA do estado — sem probe de rede, e é de propósito.
 *
 * Um health-probe responde "a porta aceita conexão"; nós queremos "este sidecar
 * SERVIU". As duas evidências que temos são melhores que o probe:
 *   1. `enabled` — a sessão de fato LIGOU o sidecar (URL do headroom resolvida,
 *      toggle do ollama/mem0 ON). Desligado ⇒ `off`, sem ambiguidade.
 *   2. o histórico de chamadas — se TODA chamada falhou (`ok===0 && fail>0`), o
 *      sidecar está ligado mas CAÍDO: reportar `idle` ("de pé, sem uso") seria
 *      MENTIRA. Cai p/ `off`, que é a verdade observada NO CAMINHO REAL.
 * Sem nenhuma chamada ainda (`ok===0 && fail===0`) ⇒ `idle` (ligado, ocioso).
 */
export function sidecarUseState(counts: SidecarUseCounts, enabled: boolean): SidecarUseState {
  if (!enabled) return 'off';
  if (counts.ok > 0) return 'used';
  if (counts.fail > 0) return 'off'; // tentou e não respondeu ⇒ está fora, não ocioso
  return 'idle';
}

/** Quais sidecars a sessão LIGOU (não é probe — é o fio que o wiring de fato armou). */
export interface SidecarEnabled {
  readonly headroom: boolean;
  readonly ollama: boolean;
  readonly mem0: boolean;
}

/**
 * A VISÃO completa que atravessa o `SessionState` até a StatusBar / o `/doctor`.
 * Só DISPLAY: contagens e flags, zero credencial, zero conteúdo de mensagem (HG-2).
 */
export interface SidecarUsageView {
  /** Perfil ativo. O chip só existe em `turbo` — ver `buildSidecarChip`. */
  readonly profile: 'turbo' | 'leve';
  readonly enabled: SidecarEnabled;
  readonly usage: SidecarUsage;
}

/** Uma célula do chip — já com estado resolvido e o número que prova o uso. */
export interface SidecarChipEntry {
  readonly kind: SidecarKind;
  /** `hdr` | `oll` | `mem`. */
  readonly code: string;
  readonly state: SidecarUseState;
  readonly ok: number;
  readonly fail: number;
}

/**
 * MONTA o chip (puro) — ou `undefined` quando ele NÃO deve aparecer.
 *
 * Regra de não-poluir: em perfil **leve** os sidecars nem sobem, então o chip seria
 * três `off` eternos ocupando a barra de quem escolheu rodar magro. `undefined` ⇒ a
 * StatusBar não renderiza NADA (nem o glifo). Só o turbo paga o pixel.
 */
export function buildSidecarChip(view: SidecarUsageView): readonly SidecarChipEntry[] | undefined {
  if (view.profile !== 'turbo') return undefined;
  return SIDECAR_ORDER.map((kind) => {
    const counts = view.usage[kind];
    return {
      kind,
      code: SIDECAR_CODE[kind],
      state: sidecarUseState(counts, view.enabled[kind]),
      ok: counts.ok,
      fail: counts.fail,
    };
  });
}

/**
 * Texto de UMA célula, sem cor (a cor é papel do tema, resolvido na TUI):
 *   • `used` ⇒ `hdr·12` — o número É a prova de uso (a11y §3.3: o glifo/cor nunca
 *     carrega o significado sozinho; aqui quem carrega é o dígito).
 *   • `idle` ⇒ `hdr`    — de pé, ocioso. Nada a somar.
 *   • `off`  ⇒ `hdr✗`   — fora. `✗` é o MESMO vocabulário do `/doctor`.
 * `ascii` troca o `✗` por `x` (TERM=linux / locale não-UTF-8 / `--ascii`).
 */
export function sidecarChipCell(entry: SidecarChipEntry, ascii = false): string {
  if (entry.state === 'used') return `${entry.code}·${entry.ok}`;
  if (entry.state === 'off') return `${entry.code}${ascii ? 'x' : '✗'}`;
  return entry.code;
}

/**
 * Linha de DIAGNÓSTICO (`/doctor`) — verbosa de propósito: lá há espaço p/ os DOIS
 * números, e é a tela onde o dono investiga "por que o sidecar não está sendo usado".
 * Ex.: `headroom: 12 uso(s)` · `ollama: 0 uso · 3 falha(s)` · `mem0: desligado`.
 */
export function sidecarUsageSummary(view: SidecarUsageView): readonly string[] {
  return SIDECAR_ORDER.map((kind) => {
    const c = view.usage[kind];
    if (!view.enabled[kind]) return `${kind}: desligado`;
    const uso = `${c.ok} uso${c.ok === 1 ? '' : '(s)'}`;
    return c.fail > 0 ? `${kind}: ${uso} · ${c.fail} falha${c.fail === 1 ? '' : '(s)'}` : `${kind}: ${uso}`;
  });
}

/**
 * ACUMULADOR de sessão — a única peça com estado, e ainda assim SEM I/O (só um
 * campo + um observador). Mora no core, junto do redutor puro que ele aplica, pelo
 * mesmo motivo que o `PollSignalBus` mora aqui: é estado de sessão portável.
 *
 * As bordas (compress do headroom, judge do ollama, add/search do mem0) chamam
 * `record()`; o `SessionController` assina `subscribe()` e espelha o snapshot no
 * `SessionState` p/ a StatusBar redesenhar. Notifica SÓ quando algo mudou.
 */
export class SidecarUsageMeter {
  private current: SidecarUsage = EMPTY_SIDECAR_USAGE;
  private listener: ((usage: SidecarUsage) => void) | undefined;

  /** Snapshot IMUTÁVEL do acumulado. */
  snapshot(): SidecarUsage {
    return this.current;
  }

  /**
   * Registra UMA chamada ao sidecar. `ok:true` ⇒ saiu, voltou e FOI APROVEITADA;
   * `ok:false` ⇒ fail-open (não conta como uso — ver invariante no topo).
   */
  record(kind: SidecarKind, ok: boolean): void {
    this.current = recordSidecarUse(this.current, kind, ok);
    this.listener?.(this.current);
  }

  /**
   * Assina as mudanças (1 observador — é o controller). Devolve o cancelador. Uma
   * assinatura nova SUBSTITUI a anterior: não há caso de dois donos do mesmo medidor,
   * e um registro silenciosamente duplicado seria pior que a substituição.
   */
  subscribe(fn: (usage: SidecarUsage) => void): () => void {
    this.listener = fn;
    return () => {
      if (this.listener === fn) this.listener = undefined;
    };
  }
}
