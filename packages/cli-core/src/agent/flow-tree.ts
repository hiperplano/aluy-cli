// EST-0982 · ADR-0063 (VER/PARAR/INTERAGIR) · GS-C1..C5 + RES-C-1/2/3 —
// A ÁRVORE DE FLUXOS: a abstração comum sobre o que está VIVO numa sessão.
//
// Com sub-agentes PARALELOS (EST-0969/ADR-0057) e — futuramente — ciclos de `/loop`
// (ADR-0062), uma sessão tem N fluxos vivos ao mesmo tempo: o PAI (sessão) + M
// filhos. Esta classe os torna NAVEGÁVEIS (ver/parar/interagir) sem reinventar nada:
//   • a identidade de cada nó é o RÓTULO DE ORIGEM que já carregamos (CLI-SEC-9);
//   • o PARAR reusa o abort/signal já existente do loop (EST-0948) — um AbortController
//     por nó, com a semântica de árvore (pai cancela subárvore; filho não derruba
//     irmãos/pai — anti-deadlock, ADR-0057 §1(e)/RES-C-3);
//   • a contabilidade (tokens + TEMPO) usa o usage que o budget/broker já reporta
//     (EST-0969) + o relógio injetável.
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Só estado + mecânica + relógio
// injetável. O drill-in/UI/contabilidade-visível são do @aluy/cli, que LÊ esta árvore.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ INVARIANTES (gate MÉDIO do `seguranca` — GS-C1..C4 + RES-C-1/3):           ║
// ║                                                                            ║
// ║ • RES-C-1 / GS-C3 — VER NÃO VAZA O QUE O CONFINAMENTO ESCONDE. A visão de   ║
// ║   drill-in passa toda atividade observável por `redactCommandSecrets`       ║
// ║   (CLI-SEC-6): segredo redigido na resposta-ao-usuário SEGUE redigido aqui. ║
// ║   A árvore NUNCA referencia o journal de `/undo` (~/.aluy/) nem a memória —  ║
// ║   ela só conhece a ATIVIDADE (fase/tool-calls/usage), nunca o conteúdo       ║
// ║   confinado. Um "stream cru" observável seria um bypass — e não existe aqui. ║
// ║                                                                            ║
// ║ • GS-C1 — PARAR É SEGURO POR CONSTRUÇÃO. `cancel*` só ABORTA (cessar≠agir):  ║
// ║   dispara o AbortSignal do nó; NÃO chama `decide()`, NÃO executa efeito.     ║
// ║                                                                            ║
// ║ • RES-C-3 / GS-C2 — SEM DEADLOCK. Cancelar o PAI cancela a subárvore;       ║
// ║   cancelar um FILHO não toca os irmãos nem o pai; um filho pendurado não     ║
// ║   trava o cancelamento dos demais (cada nó tem o SEU AbortController).       ║
// ║                                                                            ║
// ║ • GS-C4 — VER preserva o RÓTULO DE ORIGEM (CLI-SEC-9): cada nó/atividade     ║
// ║   carrega QUEM é. A observabilidade é LEITURA — não transforma `result` de   ║
// ║   um filho em instrução do pai (CLI-SEC-4 intacto: isto não toca contexto).  ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { redactCommandSecrets, redactOutputSecrets } from './journal/redact.js';

/** O papel de um nó na árvore de fluxos. `loop` reservado p/ ADR-0062 (`/loop`). */
export type FlowKind = 'root' | 'subagent' | 'loop';

/** Fase corrente de um fluxo vivo (o que o drill-in mostra como estado). */
export type FlowPhase =
  | 'thinking' // chamando o modelo / pré-1º-token
  | 'tool' // executando uma tool liberada
  | 'asking' // aguardando uma `ask` (confirmação) do usuário
  | 'done' // concluído (resposta final)
  | 'cancelled' // cancelado pelo usuário (PARAR)
  | 'failed'; // teto/timeout/erro

/** Como um fluxo terminou (espelha `SubAgentOutcome.stop` + `cancelled`). */
export type FlowStop = 'final' | 'limit' | 'timeout' | 'error' | 'cancelled';

/** Contabilidade de UM fluxo: tokens (do budget/broker) + TEMPO (do relógio). */
export interface FlowAccounting {
  readonly tokens: number;
  readonly toolCalls: number;
  readonly iterations: number;
  /** Início do fluxo (ms epoch — do relógio injetável). */
  readonly startedAt: number;
  /** Fim do fluxo (ms epoch) — `undefined` enquanto vivo. */
  readonly endedAt?: number;
  /** Duração corrente em ms: (endedAt ?? agora) − startedAt. */
  readonly durationMs: number;
}

/**
 * UMA atividade observável (tool-call em curso/recente) de um fluxo. O `display`
 * JÁ vem REDIGIDO (RES-C-1): segredo na linha de comando vira `‹redigido›` antes de
 * ser observável. NUNCA o stream cru.
 *
 * EST-0982 (Fase 0 — enriquecer o DADO): além de `tool`/`target`/`running`/`ok`, a
 * atividade carrega agora o que dá SUBSTÂNCIA ao log — quando/quanto/o-quê. TODOS os
 * campos novos são OPCIONAIS e TOLERANTES (UI antiga não quebra; ausência = não
 * mostra; o tool que não expõe a métrica simplesmente a omite — degrada). O que é
 * DERIVADO de saída/comando passa por redação NA ORIGEM (`summary`/`tail` — RES-C-1).
 */
export interface FlowActivity {
  /** Nome da tool (`run_command`, `read_file`, …). */
  readonly tool: string;
  /** Alvo legível JÁ REDIGIDO (comando/path/padrão) — seguro p/ exibir. */
  readonly target: string;
  /** `true` enquanto a tool roda; `false` quando terminou. */
  readonly running: boolean;
  /** `ok`/`err` quando terminou (`undefined` enquanto running). */
  readonly ok?: boolean;
  /**
   * EST-0982 — INÍCIO desta atividade (ms epoch, do `Clock` injetável — determinístico
   * em teste). Quando/em-que-momento a tool disparou. `undefined` só p/ atividades
   * pré-enriquecimento (tolerância à árvore antiga).
   */
  readonly ts?: number;
  /**
   * EST-0982 — DURAÇÃO desta atividade (ms): start→end de CADA tool-call (hoje só o NÓ
   * tinha duração agregada). Enquanto `running`, é a duração AO VIVO (tail: agora−ts);
   * quando termina, é congelada no fim real. `undefined` se não houver `ts`.
   */
  readonly durationMs?: number;
  /**
   * EST-0982 — DIFFSTAT de um edit/write: linhas adicionadas/removidas. Vem do
   * resultado do tool de edição (ou derivado do diff). Se o tool não expõe e não dá
   * p/ derivar, OMITE (degrada — campo ausente = não mostra `+/−`).
   */
  readonly added?: number;
  readonly removed?: number;
  /**
   * EST-0982 — RESUMO curto do resultado, REDIGIDO (RES-C-1/CLI-SEC-6): `48 linhas`,
   * `38 hits`, `exit 0`, `aplicado`. Vem do resultado quantificado do tool, passado por
   * `redactOutputSecrets` na origem — segredo NUNCA aparece no resumo. `undefined`
   * enquanto running / quando o tool não quantifica.
   */
  readonly summary?: string;
  /**
   * EST-0982 — TOKENS desta atividade (custo da tool-call, quando aplicável — chamadas
   * ao modelo/tools que custam). Accounting POR atividade (hoje só por nó). Omitido
   * quando a tool não custa tokens (read/grep local = 0 ⇒ ausente, degrada).
   */
  readonly tokens?: number;
  /**
   * EST-0982 — TAIL ao vivo: últimas linhas REDIGIDAS do comando em curso (`run_command`
   * streamando). Reusa o stream JÁ redigido (`redactOutputSecrets`/CLI-SEC-6) — re-
   * redigido aqui na origem por defesa-em-profundidade. Bounded (últimas N linhas).
   * `undefined` p/ tools que não streamam / quando não há saída ainda.
   */
  readonly tail?: string;
}

/**
 * EST-0982 — os detalhes OPCIONAIS que o ponto de nota passa ao FECHAR uma atividade
 * (`noteToolEnd`/`noteLastToolEnd`). Tudo opcional/tolerante: o que o tool não expõe é
 * omitido (degrada). O `summary` é REDIGIDO na origem (`redactOutputSecrets`).
 */
export interface ToolEndDetail {
  /** Resumo curto do resultado (`48 linhas`, `exit 0`) — REDIGIDO na origem. */
  readonly summary?: string;
  /** Linhas adicionadas por um edit/write (diffstat). */
  readonly added?: number;
  /** Linhas removidas por um edit/write (diffstat). */
  readonly removed?: number;
  /** Tokens custados por esta tool-call (quando aplicável). `≤0` é ignorado. */
  readonly tokens?: number;
}

/** EST-0982 — quantas linhas de `tail` ao vivo guardar (anti-crescimento + anti-flicker). */
const MAX_TAIL_LINES = 4;

/** EST-0982 — recorta a cauda redigida do stream em ≤ `MAX_TAIL_LINES` linhas (do fim). */
function clipTail(text: string): string {
  const lines = redactOutputSecrets(text).split('\n');
  // Remove a última linha vazia (stream costuma terminar em \n) sem perder conteúdo.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-MAX_TAIL_LINES).join('\n');
}

/** O que o drill-in (VER) de UM nó expõe — só ATIVIDADE, nunca conteúdo confinado. */
export interface FlowDrillIn {
  readonly id: string;
  readonly kind: FlowKind;
  /** Rótulo de origem (CLI-SEC-9) — QUEM é este fluxo. */
  readonly label: string;
  readonly phase: FlowPhase;
  readonly accounting: FlowAccounting;
  /** Atividades recentes (mais nova por último), JÁ redigidas (RES-C-1). */
  readonly recent: readonly FlowActivity[];
  readonly stop?: FlowStop;
}

/** Relógio injetável (teste determinístico). Default `Date.now`. */
export type Clock = () => number;

/** Quantas atividades recentes guardar por nó (anti-crescimento ilimitado). */
const MAX_RECENT = 12;

/**
 * EST-1011 (Bug 5 do bug-hunt — `FlowTree` cresce sem teto) — quantos nós FILHOS
 * TERMINAIS (done/cancelled/failed) a árvore guarda. Em sessão longa / `/loop` /
 * muitos sub-agentes, `ensureChild` acumulava nós para SEMPRE (`byId` + `children`):
 * `cancel()`/`finish()` só marcam terminal, NADA removia. Acima deste teto, a árvore
 * faz EVICT dos nós terminais MAIS ANTIGOS (por `endedAt`), removendo-os de `byId` e
 * de `parent.children` — mas DOBRANDO a contabilidade do que sai num AGREGADO
 * (`evictedAggregate`), de modo que o total de tokens/tool-calls/iterações da sessão
 * NÃO se perde (só os nós VIVOS + os N terminais recentes ficam navegáveis). Os nós
 * VIVOS nunca são coletados (um sub-agente pendurado segue visível). A raiz nunca sai.
 */
const MAX_TERMINAL_NODES = 32;

/**
 * UM nó da árvore de fluxos. Encapsula: identidade (label/origem), fase, atividade
 * recente (REDIGIDA), contabilidade (tokens+tempo) e o SEU AbortController (PARAR).
 * Os filhos referenciam o pai p/ a semântica de subárvore (cancelar pai → filhos).
 */
export class FlowNode {
  readonly id: string;
  readonly kind: FlowKind;
  readonly label: string;
  readonly parent: FlowNode | null;
  private readonly children: FlowNode[] = [];
  private readonly abortController: AbortController;
  // EST-0982 (semântica do esc) — sinal de CASCATA, SEPARADO do sinal de execução
  // PRÓPRIA (`abortController`). Os FILHOS encadeiam NESTE sinal (não no próprio):
  // ele só dispara no PARAR-TUDO (`cancel()`), nunca no `cancelOwn()` (esc). Assim o
  // esc cessa SÓ o turno do pai e os sub-agentes seguem trabalhando (decisão de
  // produto, EST-0982/ADR-0063) — cercados pelos MESMOS tetos (E-A2/heartbeat).
  private readonly cascadeController = new AbortController();
  private readonly clock: Clock;

  private phaseValue: FlowPhase = 'thinking';
  private stopValue: FlowStop | undefined;
  private readonly startedAt: number;
  private endedAt: number | undefined;
  private tokensValue = 0;
  private toolCallsValue = 0;
  private iterationsValue = 0;
  private readonly recentActivity: FlowActivity[] = [];
  /**
   * EST-1011 — hook disparado QUANDO este nó vira terminal (`finish`/`cancel`). A
   * árvore o usa p/ rodar o evict no MOMENTO da terminação (não só na próxima
   * `ensureChild`), de modo que o último nó a terminar também seja cercado. Idempotente
   * por construção (só dispara na transição viva→terminal). `undefined` na raiz/teste.
   */
  private readonly onTerminal: (() => void) | undefined;

  constructor(opts: {
    readonly id: string;
    readonly kind: FlowKind;
    readonly label: string;
    readonly parent?: FlowNode | null;
    readonly clock?: Clock;
    /**
     * Encadeia o cancelamento do PAI: quando o pai aborta, este nó aborta junto
     * (subárvore). É o `signal` do pai — quando dado, abortá-lo aborta este nó.
     */
    readonly parentSignal?: AbortSignal;
    /** EST-1011 — chamado uma vez quando o nó vira terminal (a árvore varre o teto). */
    readonly onTerminal?: () => void;
  }) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.label = opts.label;
    this.parent = opts.parent ?? null;
    this.clock = opts.clock ?? Date.now;
    this.onTerminal = opts.onTerminal;
    this.abortController = new AbortController();
    this.startedAt = this.clock();
    // RES-C-3: o sinal do PAI encadeia no FILHO (cancelar pai → subárvore), mas o
    // sinal do filho NÃO encadeia de volta no pai (filho cancelado não derruba o pai).
    if (opts.parentSignal) {
      if (opts.parentSignal.aborted) this.abortController.abort();
      else
        opts.parentSignal.addEventListener('abort', () => this.abortController.abort(), {
          once: true,
        });
    }
  }

  /** O AbortSignal DESTE nó — é o MESMO que o loop/spawner já consome (EST-0948). */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * EST-0982 (semântica do esc) — o sinal de CASCATA que os FILHOS encadeiam. Dispara
   * SÓ no PARAR-TUDO (`cancel()`); o `cancelOwn()` (esc) o deixa intacto — os filhos
   * continuam vivos quando só o turno do pai cessa.
   */
  get cascadeSignal(): AbortSignal {
    return this.cascadeController.signal;
  }

  /** `true` se este nó já foi cancelado/abortado. */
  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  get phase(): FlowPhase {
    return this.phaseValue;
  }

  get stop(): FlowStop | undefined {
    return this.stopValue;
  }

  /** Filhos diretos (leitura — a árvore é profundidade ≤1 hoje). */
  get childNodes(): readonly FlowNode[] {
    return this.children;
  }

  /**
   * EST-1011 — fim deste nó em ms epoch (`undefined` enquanto vivo). Lido pela
   * árvore p/ ordenar o evict de nós TERMINAIS por recência (descarta o mais antigo).
   */
  get endedAtMs(): number | undefined {
    return this.endedAt;
  }

  /** Registra um filho (subagente/ciclo). O filho já encadeia o `signal` deste pai. */
  addChild(child: FlowNode): void {
    this.children.push(child);
  }

  /**
   * EST-1011 — REMOVE um filho TERMINAL da lista (evict anti-crescimento). Só remove
   * a referência da lista de filhos deste pai; a árvore é quem mantém o agregado de
   * contabilidade do que saiu (a contabilidade NÃO se perde — vira número agregado).
   * No-op se o nó não é filho direto.
   */
  removeChild(child: FlowNode): boolean {
    const idx = this.children.indexOf(child);
    if (idx < 0) return false;
    this.children.splice(idx, 1);
    return true;
  }

  /** Atualiza a fase do fluxo (thinking/tool/asking/…) — observação pura. */
  setPhase(phase: FlowPhase): void {
    // Um nó cancelado/concluído não regride de fase (estado terminal é pegajoso).
    if (this.isTerminal()) return;
    this.phaseValue = phase;
  }

  /** `true` quando o fluxo já chegou a um estado terminal. */
  isTerminal(): boolean {
    return (
      this.phaseValue === 'done' || this.phaseValue === 'cancelled' || this.phaseValue === 'failed'
    );
  }

  /**
   * Marca o INÍCIO de uma tool observável. O `target` é REDIGIDO (RES-C-1/CLI-SEC-6)
   * ANTES de entrar na atividade — um `curl -H "Authorization: Bearer sk-…"` vira
   * `‹redigido›`. Mantém só `MAX_RECENT` atividades (anti-crescimento).
   *
   * EST-0982 — carimba o `ts` (do `Clock` injetável): cada atividade ganha QUANDO
   * começou; a duração ao vivo (`durationMs`) é derivada disto no `drillIn`.
   */
  noteToolStart(tool: string, rawTarget: string): void {
    this.pushRecent({
      tool,
      target: redactCommandSecrets(rawTarget),
      running: true,
      ts: this.clock(),
    });
  }

  /**
   * Marca o FIM da última tool em curso desta tool (running→ok/err). EST-0982 — preenche
   * a DURAÇÃO real (agora−ts, congelada) e os detalhes opcionais REDIGIDOS na origem
   * (`summary`/diffstat/tokens). Qualquer detalhe ausente é OMITIDO (degrada).
   */
  noteToolEnd(tool: string, ok: boolean, detail?: ToolEndDetail): void {
    for (let i = this.recentActivity.length - 1; i >= 0; i--) {
      const a = this.recentActivity[i]!;
      if (a.tool === tool && a.running) {
        this.recentActivity[i] = this.closeActivity(a, ok, detail);
        return;
      }
    }
  }

  /**
   * Marca o FIM da ÚLTIMA tool em curso (qualquer tool) — quando o nome não bate. Aceita
   * os mesmos detalhes opcionais (EST-0982) que `noteToolEnd`.
   */
  noteLastToolEnd(ok: boolean, detail?: ToolEndDetail): void {
    for (let i = this.recentActivity.length - 1; i >= 0; i--) {
      const a = this.recentActivity[i]!;
      if (a.running) {
        this.recentActivity[i] = this.closeActivity(a, ok, detail);
        return;
      }
    }
  }

  /**
   * EST-0982 — TAIL ao vivo: atualiza as últimas linhas REDIGIDAS do `run_command` em
   * curso (a atividade `running` mais recente). Reusa o stream já redigido (e re-redige
   * na origem por defesa-em-profundidade, CLI-SEC-6). No-op se não há atividade viva.
   */
  noteToolTail(rawTail: string): void {
    for (let i = this.recentActivity.length - 1; i >= 0; i--) {
      const a = this.recentActivity[i]!;
      if (a.running) {
        this.recentActivity[i] = { ...a, tail: clipTail(rawTail) };
        return;
      }
    }
  }

  /**
   * EST-0982 — fecha UMA atividade (running→terminal): congela a duração (agora−ts) e
   * mescla os detalhes opcionais REDIGIDOS. Centraliza a redação na ORIGEM (`summary`
   * passa por `redactOutputSecrets`; diffstat/tokens são números, sem segredo).
   */
  private closeActivity(a: FlowActivity, ok: boolean, detail?: ToolEndDetail): FlowActivity {
    const next: FlowActivity = { ...a, running: false, ok };
    const withDur =
      a.ts !== undefined ? { ...next, durationMs: Math.max(0, this.clock() - a.ts) } : next;
    if (!detail) return withDur;
    return {
      ...withDur,
      ...(detail.summary !== undefined ? { summary: redactOutputSecrets(detail.summary) } : {}),
      ...(detail.added !== undefined ? { added: detail.added } : {}),
      ...(detail.removed !== undefined ? { removed: detail.removed } : {}),
      ...(detail.tokens !== undefined && detail.tokens > 0 ? { tokens: detail.tokens } : {}),
    };
  }

  private pushRecent(a: FlowActivity): void {
    this.recentActivity.push(a);
    if (this.recentActivity.length > MAX_RECENT) this.recentActivity.shift();
  }

  /** Acumula tokens (do budget/broker — EST-0969). Síncrono, idempotente quanto a ≤0. */
  addTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.tokensValue += n;
  }

  /** Espelha o usage agregado (tokens/toolCalls/iterations) reportado pelo loop. */
  setUsage(usage: { tokens: number; toolCalls: number; iterations: number }): void {
    if (Number.isFinite(usage.tokens) && usage.tokens >= 0) this.tokensValue = usage.tokens;
    if (Number.isFinite(usage.toolCalls) && usage.toolCalls >= 0)
      this.toolCallsValue = usage.toolCalls;
    if (Number.isFinite(usage.iterations) && usage.iterations >= 0)
      this.iterationsValue = usage.iterations;
  }

  /** Fecha o fluxo: carimba o fim (relógio) e a fase/stop terminal. */
  finish(stop: FlowStop): void {
    const wasTerminal = this.isTerminal();
    if (this.endedAt === undefined) this.endedAt = this.clock();
    this.stopValue = stop;
    this.phaseValue = stop === 'final' ? 'done' : stop === 'cancelled' ? 'cancelled' : 'failed';
    // EST-1011 — na transição viva→terminal, avisa a árvore p/ varrer o teto de
    // terminais (cerca também o ÚLTIMO nó a terminar). Só na 1ª vez (anti-reentrada).
    if (!wasTerminal && this.onTerminal) this.onTerminal();
  }

  /**
   * PARAR (GS-C1) — cancela ESTE nó e, recursivamente, sua SUBÁRVORE. Só ABORTA
   * (cessar≠agir): dispara o AbortSignal; NÃO chama `decide()`, NÃO executa efeito.
   * Idempotente. RES-C-3: NÃO toca o pai nem os irmãos — só desce. Carimba `cancelled`
   * nos nós ainda vivos (os já-terminais mantêm seu desfecho real).
   */
  cancel(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
    // EST-0982 — PARAR-TUDO dispara a CASCATA: filhos encadeados no `cascadeSignal`
    // caem junto (e um filho criado DEPOIS já nasce abortado — anti-corrida).
    if (!this.cascadeController.signal.aborted) this.cascadeController.abort();
    if (!this.isTerminal()) this.finish('cancelled');
    // Encadeamento explícito (defesa-em-profundidade): mesmo que um filho não tenha
    // recebido o `parentSignal`, o cancelamento desce a subárvore.
    for (const child of this.children) child.cancel();
  }

  /**
   * EST-0982 (semântica do esc) — cancela SÓ ESTE nó (a execução PRÓPRIA), SEM
   * cascatear aos filhos: aborta o `signal` (o loop deste nó cessa), carimba
   * `cancelled`, e NÃO toca o `cascadeSignal` nem desce a subárvore. É o que o esc
   * usa na RAIZ: o turno do pai cessa, os sub-agentes SEGUEM trabalhando (cercados
   * pelos MESMOS tetos — SharedBudget/iterações/heartbeat, E-A2). Idempotente.
   */
  cancelOwn(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
    if (!this.isTerminal()) this.finish('cancelled');
  }

  /** A contabilidade corrente (tokens + TEMPO) deste fluxo. */
  accounting(): FlowAccounting {
    const end = this.endedAt ?? this.clock();
    return {
      tokens: this.tokensValue,
      toolCalls: this.toolCallsValue,
      iterations: this.iterationsValue,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      durationMs: Math.max(0, end - this.startedAt),
    };
  }

  /**
   * A visão de drill-in (VER) deste nó — só ATIVIDADE redigida, nunca conteúdo.
   *
   * EST-0982 — uma atividade ainda `running` que tenha `ts` ganha a duração AO VIVO
   * (agora−ts) no SNAPSHOT da leitura: o log mostra o tempo correndo (tail) sem mutar o
   * estado guardado (a duração só é congelada de fato no `closeActivity`). Leitura pura.
   */
  drillIn(): FlowDrillIn {
    const now = this.clock();
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      phase: this.phaseValue,
      accounting: this.accounting(),
      recent: this.recentActivity.map((a) =>
        a.running && a.ts !== undefined ? { ...a, durationMs: Math.max(0, now - a.ts) } : a,
      ),
      ...(this.stopValue !== undefined ? { stop: this.stopValue } : {}),
    };
  }
}

/** Resumo de UM nó na visão GERAL da árvore (sem o detalhe do drill-in). */
export interface FlowSummary {
  readonly id: string;
  readonly kind: FlowKind;
  readonly label: string;
  readonly phase: FlowPhase;
  readonly accounting: FlowAccounting;
  readonly stop?: FlowStop;
}

/**
 * A ÁRVORE DE FLUXOS de uma sessão: o nó RAIZ (pai) + os filhos vivos. É o registro
 * navegável que o @aluy/cli LÊ p/ ver/parar/interagir. Cria/encontra nós por id e
 * roteia o cancelamento (um nó / todos). Determinística e sem I/O.
 */
export class FlowTree {
  private readonly root: FlowNode;
  private readonly byId = new Map<string, FlowNode>();
  private readonly clock: Clock;
  /** EST-1011 — teto de nós terminais navegáveis (injetável p/ teste). */
  private readonly maxTerminalNodes: number;
  /**
   * EST-1011 — contabilidade AGREGADA dos nós terminais já EVICTADOS: o que sai da
   * árvore tem seu total dobrado aqui para que o `totalAccounting`/contadores da
   * sessão NÃO percam o histórico (evict ≠ esquecer o custo). Só números — sem
   * referência a nó, sem conteúdo (nada a vazar).
   */
  private evictedTokens = 0;
  private evictedToolCalls = 0;
  private evictedIterations = 0;
  private evictedNodes = 0;
  /**
   * EST-1011 — trava anti-reentrada do evict: o `onTerminal` de um filho pode disparar
   * DURANTE um `cancel()` em cascata (que itera `root.children`). Remover nós nesse
   * meio corromperia a iteração — então adiamos: durante uma cascata só MARCAMOS, e a
   * varredura roda 1× ao fim (`cancelAll`/`cancelOne` chamam `evictTerminalNodes`).
   */
  private evicting = false;

  constructor(opts?: {
    readonly rootLabel?: string;
    readonly clock?: Clock;
    /** EST-1011 — teto de nós terminais antes do evict (default 32). */
    readonly maxTerminalNodes?: number;
  }) {
    this.clock = opts?.clock ?? Date.now;
    this.maxTerminalNodes =
      opts?.maxTerminalNodes !== undefined && opts.maxTerminalNodes >= 0
        ? opts.maxTerminalNodes
        : MAX_TERMINAL_NODES;
    this.root = new FlowNode({
      id: 'root',
      kind: 'root',
      label: opts?.rootLabel ?? 'aluy',
      clock: this.clock,
    });
    this.byId.set(this.root.id, this.root);
  }

  /** O nó RAIZ (o agente principal / pai). */
  get rootNode(): FlowNode {
    return this.root;
  }

  /** Encontra um nó por id (`undefined` se não existe). */
  node(id: string): FlowNode | undefined {
    return this.byId.get(id);
  }

  /**
   * Cria (ou retorna) um nó FILHO sob o pai dado (default: raiz). O filho encadeia o
   * `signal` do pai (cancelar pai → filho — RES-C-3) e usa o MESMO relógio. id estável
   * por (parentId, label) — re-chamar com o mesmo par devolve o mesmo nó.
   */
  ensureChild(label: string, kind: FlowKind = 'subagent', parentId = 'root'): FlowNode {
    const parent = this.byId.get(parentId) ?? this.root;
    const id = `${parent.id}/${label}`;
    const existing = this.byId.get(id);
    if (existing) return existing;
    const child = new FlowNode({
      id,
      kind,
      label,
      parent,
      clock: this.clock,
      // EST-0982 (semântica do esc) — o filho encadeia o sinal de CASCATA do pai (não
      // o de execução própria): PARAR-TUDO (`cancel()`) derruba a subárvore; o esc
      // (`cancelOwn()` na raiz) NÃO — os sub-agentes seguem trabalhando.
      parentSignal: parent.cascadeSignal,
      // EST-1011 — ao terminar, o filho avisa a árvore p/ varrer o teto NO MOMENTO da
      // terminação (cerca também o último a terminar, sem depender de uma nova
      // `ensureChild`). A trava anti-reentrada cobre a cascata de `cancel()`.
      onTerminal: () => this.evictTerminalNodes(),
    });
    parent.addChild(child);
    this.byId.set(id, child);
    // EST-1011 — toda vez que um nó NOVO entra, varremos o teto de terminais: em
    // sessão longa / `/loop` os terminais não se acumulam sem limite (evict do mais
    // antigo, contabilidade preservada no agregado). Barato (só roda acima do teto).
    this.evictTerminalNodes();
    return child;
  }

  /**
   * EST-1011 (Bug 5) — EVICT dos nós FILHOS TERMINAIS mais ANTIGOS quando passam do
   * teto (`maxTerminalNodes`). Mantém os `maxTerminalNodes` terminais mais recentes
   * (por `endedAt`) + TODOS os vivos + a raiz. Cada nó evictado tem sua contabilidade
   * DOBRADA no agregado (`evicted*`) — o total da sessão (`totalAccounting`) não muda;
   * só o nº de nós navegáveis é cercado. Idempotente (no-op abaixo do teto). Hoje a
   * árvore é profundidade ≤1 (só filhos da raiz têm evict; a raiz nunca sai).
   */
  private evictTerminalNodes(): void {
    // Anti-reentrada: se já estamos varrendo (ou dentro de uma cascata de cancel que
    // dispara `onTerminal` por nó), não mexe na lista agora — quem iniciou termina.
    if (this.evicting) return;
    this.evicting = true;
    try {
      this.evictTerminalNodesUnsafe();
    } finally {
      this.evicting = false;
    }
  }

  private evictTerminalNodesUnsafe(): void {
    const terminals: FlowNode[] = [];
    for (const c of this.root.childNodes) {
      if (c.isTerminal()) terminals.push(c);
    }
    if (terminals.length <= this.maxTerminalNodes) return;
    // Mais ANTIGO primeiro: ordena por fim (endedAt; quem não tem cai no fim da fila
    // de "manter" — tratado como recém-terminado p/ não evictar um sem timestamp).
    terminals.sort((a, b) => (a.endedAtMs ?? Infinity) - (b.endedAtMs ?? Infinity));
    const toEvict = terminals.slice(0, terminals.length - this.maxTerminalNodes);
    for (const n of toEvict) {
      const acc = n.accounting();
      this.evictedTokens += acc.tokens;
      this.evictedToolCalls += acc.toolCalls;
      this.evictedIterations += acc.iterations;
      this.evictedNodes += 1;
      this.root.removeChild(n);
      this.byId.delete(n.id);
    }
  }

  /** Visão GERAL: resumo de TODOS os nós (raiz primeiro, depois filhos em ordem). */
  overview(): readonly FlowSummary[] {
    const out: FlowSummary[] = [];
    const visit = (n: FlowNode): void => {
      out.push({
        id: n.id,
        kind: n.kind,
        label: n.label,
        phase: n.phase,
        accounting: n.accounting(),
        ...(n.stop !== undefined ? { stop: n.stop } : {}),
      });
      for (const c of n.childNodes) visit(c);
    };
    visit(this.root);
    return out;
  }

  /** Os nós FILHOS ainda VIVOS (não-terminais) — p/ "parar todos os filhos". */
  liveChildren(): readonly FlowNode[] {
    return this.root.childNodes.filter((c) => !c.isTerminal());
  }

  /**
   * PARAR UM (GS-C1/RES-C-3) — cancela o nó `id` e sua subárvore. Cancelar um FILHO
   * NÃO toca os irmãos nem o pai (anti-deadlock). `false` se o id não existe.
   */
  cancelOne(id: string): boolean {
    const n = this.byId.get(id);
    if (!n) return false;
    n.cancel();
    // EST-1011 — a cascata de `cancel()` dispara `onTerminal` por nó sob a trava
    // anti-reentrada; varre o teto 1× ao fim (os terminais recém-criados são cercados).
    this.evictTerminalNodes();
    return true;
  }

  /**
   * PARAR TODOS (GS-C1) — cancela a raiz, que desce a subárvore inteira. O pai recebe
   * estado COERENTE: todo nó vivo vira `cancelled`; os já-terminais mantêm o desfecho.
   */
  cancelAll(): void {
    this.root.cancel();
    // EST-1011 — varredura final pós-cascata (a trava suprimiu o evict por-nó).
    this.evictTerminalNodes();
  }

  /**
   * EST-0982 (semântica do esc) — PARAR SÓ O PAI: cancela a execução PRÓPRIA da raiz
   * (o turno do agente principal cessa) SEM cascatear aos filhos — os sub-agentes
   * SEGUEM trabalhando, cercados pelos MESMOS tetos (SharedBudget/iterações/
   * heartbeat — E-A2, sem runaway órfão). O PARAR-TUDO explícito segue sendo
   * `cancelAll()` (F8 / painel Ctrl+T→P). Idempotente.
   */
  cancelRoot(): void {
    this.root.cancelOwn();
  }

  /** Contabilidade do TURNO/SESSÃO (raiz) — tokens + tempo do agente principal. */
  rootAccounting(): FlowAccounting {
    return this.root.accounting();
  }

  /**
   * EST-1011 — contabilidade AGREGADA da sessão inteira: raiz + todos os filhos VIVOS
   * + os terminais ainda navegáveis + os JÁ EVICTADOS (que sobrevivem só como número).
   * É a fonte de verdade do total de tokens/tool-calls/iterações que NÃO regride
   * quando o evict descarta nós antigos — o painel pode somar isto sem perder custo.
   */
  totalAccounting(): { tokens: number; toolCalls: number; iterations: number } {
    let tokens = this.evictedTokens;
    let toolCalls = this.evictedToolCalls;
    let iterations = this.evictedIterations;
    for (const n of this.byId.values()) {
      const acc = n.accounting();
      tokens += acc.tokens;
      toolCalls += acc.toolCalls;
      iterations += acc.iterations;
    }
    return { tokens, toolCalls, iterations };
  }

  /** EST-1011 — nº de nós VIVOS na árvore (raiz + filhos navegáveis) — anti-vazamento. */
  get nodeCount(): number {
    return this.byId.size;
  }

  /** EST-1011 — nº de nós terminais já EVICTADOS (contabilidade preservada no agregado). */
  get evictedCount(): number {
    return this.evictedNodes;
  }

  /** O drill-in (VER) de um nó por id — só atividade redigida. `undefined` se ausente. */
  drillIn(id: string): FlowDrillIn | undefined {
    return this.byId.get(id)?.drillIn();
  }
}
