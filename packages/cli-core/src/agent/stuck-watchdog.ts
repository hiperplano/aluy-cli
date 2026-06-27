// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — detector de "o agente
// está girando sem ir a lugar nenhum". PORTÁVEL (ADR-0053 §8): estado/dado puro,
// sem Ink/IO de terminal, sem rede. Alimentado pelos MESMOS sinais que o
// `AgentLoop` já produz (tool-call name+input, erro de tool, turno vazio,
// progresso real). Quando dispara, o loop PAUSA e PEDE DIREÇÃO ao usuário (via um
// `StuckResolver`, mesma costura async do `AskResolver`) — NÃO mata.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ POR QUE EXISTE (o que as guardas atuais NÃO cobrem):                       ║
// ║                                                                            ║
// ║  - `stopAtDegenerate` (degeneration.ts) pega REPETIÇÃO no STREAM do modelo  ║
// ║    (mesma linha/ciclo curto) e MATA seco o turno. Não pega "o modelo        ║
// ║    re-chama a MESMA tool / erra a MESMA tool em loop / responde vazio".     ║
// ║  - heartbeat (ProgressSignal) MATA um sub-agente SEM SINAL DE VIDA — mas um  ║
// ║    agente que re-chama a mesma tool ESTÁ vivo (emite sinais), então o       ║
// ║    heartbeat nunca dispara.                                                 ║
// ║  - teto de iterações PAUSA, mas só no fim (e por VOLUME, não por LOOP).      ║
// ║                                                                            ║
// ║  Este watchdog é COMPLEMENTAR: pega o caso "vivo + dentro do teto, MAS      ║
// ║  repetindo sem avançar" e o vira um PEDIDO DE DIREÇÃO acionável ao humano    ║
// ║  ("travei em X — redirecionar?"), em vez de girar em silêncio até o teto.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// SEGURANÇA: é SÓ pausa+ask. NÃO toca a catraca (`decide()`), NÃO relaxa
// sempre-ask, NÃO amplia escopo. O `[r] redirecionar` entra pela MESMA costura de
// INPUT DO USUÁRIO (`user_inject` → `pollInjected`); qualquer efeito que o modelo
// derive da nova direção RE-PASSA `decide()`. Ver GS-C5 / RES-C-2.
//
// NÃO-FALSO-POSITIVO: progresso REAL (tool NOVA, edição/comando bem-sucedido,
// conteúdo novo do modelo) RESETA os contadores. Uma tarefa legítima longa com
// muitas tools DIFERENTES avançando NUNCA dispara — o objetivo é pegar
// LOOP/REPETIÇÃO, não "demorou". Limiares CONSERVADORES (3-4×), configuráveis por
// env, p/ não falar demais.

/**
 * Configuração do watchdog. Defaults CONSERVADORES (3-4×) — pegam o loop óbvio
 * (mesma tool/erro/vazio) sem incomodar uma tarefa legítima que avança. Todos
 * configuráveis por env (ver {@link resolveWatchdogConfig}).
 */
export interface WatchdogConfig {
  /**
   * Quantas vezes a MESMA tool-call (mesmo `name`+`input`) pode repetir
   * CONSECUTIVAMENTE — sem que um SINAL DE PROGRESSO REAL apareça no meio — antes
   * de pedir direção. Uma tool-call com input DIFERENTE, ou um progresso real,
   * zera o contador. Default 4 (o Tiago citou "5× o mesmo run_command").
   */
  readonly maxSameToolCall: number;
  /**
   * Quantas vezes o MESMO ERRO de tool (mesma `name`+assinatura de erro) pode
   * ocorrer SEGUIDO antes de pedir direção (ex.: "run_command requer command" 5×,
   * ou um seletor que falha em loop). Um erro DIFERENTE, ou um sucesso, zera.
   * Default 3.
   */
  readonly maxSameToolError: number;
  /**
   * Quantos TURNOS VAZIOS consecutivos (o modelo respondeu sem conteúdo NEM
   * tool-call — o "▏ nada") antes de pedir direção. Conteúdo/tool real zera.
   * Default 3.
   */
  readonly maxEmptyTurns: number;
  /**
   * Quantas ITERAÇÕES seguidas SEM PROGRESSO REAL (nenhuma tool nova, nenhuma
   * edição/comando bem-sucedido, nenhum conteúdo novo) antes de pedir direção.
   * É o detector "está girando devagar mas não vai a lugar nenhum" — distinto de
   * "trabalhando devagar" (uma única tool nova/sucesso/conteúdo zera). Default 6
   * (folgado: só dispara depois de várias voltas estéreis seguidas).
   */
  readonly maxStaleIterations: number;
}

export const DEFAULT_MAX_SAME_TOOL_CALL = 4;
export const DEFAULT_MAX_SAME_TOOL_ERROR = 3;
export const DEFAULT_MAX_EMPTY_TURNS = 3;
export const DEFAULT_MAX_STALE_ITERATIONS = 6;

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  maxSameToolCall: DEFAULT_MAX_SAME_TOOL_CALL,
  maxSameToolError: DEFAULT_MAX_SAME_TOOL_ERROR,
  maxEmptyTurns: DEFAULT_MAX_EMPTY_TURNS,
  maxStaleIterations: DEFAULT_MAX_STALE_ITERATIONS,
};

/** Knobs de env (consolidação `ALUY_*`). */
export const WATCHDOG_SAME_TOOL_CALL_ENV = 'ALUY_STUCK_SAME_TOOL';
export const WATCHDOG_SAME_TOOL_ERROR_ENV = 'ALUY_STUCK_SAME_ERROR';
export const WATCHDOG_EMPTY_TURNS_ENV = 'ALUY_STUCK_EMPTY_TURNS';
export const WATCHDOG_STALE_ITERATIONS_ENV = 'ALUY_STUCK_STALE_ITERS';
/** Desliga o watchdog inteiro (escape hatch consciente). Default: ligado. */
export const WATCHDOG_DISABLE_ENV = 'ALUY_STUCK_OFF';

/**
 * Resolve a config do ambiente, tolerante: valor inválido/≤0 cai no default
 * (NUNCA desarma por engano). Cada limiar tem um PISO sensato (≥2) p/ um valor
 * minúsculo não virar falso-positivo na 1ª repetição honesta. `env` injetável.
 */
export function resolveWatchdogConfig(
  env: Record<string, string | undefined> = procEnv(),
): WatchdogConfig {
  return {
    maxSameToolCall: floorAtLeast(env[WATCHDOG_SAME_TOOL_CALL_ENV], 2, DEFAULT_MAX_SAME_TOOL_CALL),
    maxSameToolError: floorAtLeast(
      env[WATCHDOG_SAME_TOOL_ERROR_ENV],
      2,
      DEFAULT_MAX_SAME_TOOL_ERROR,
    ),
    maxEmptyTurns: floorAtLeast(env[WATCHDOG_EMPTY_TURNS_ENV], 2, DEFAULT_MAX_EMPTY_TURNS),
    maxStaleIterations: floorAtLeast(
      env[WATCHDOG_STALE_ITERATIONS_ENV],
      2,
      DEFAULT_MAX_STALE_ITERATIONS,
    ),
  };
}

/** O watchdog está LIGADO? (default: sim; só `ALUY_STUCK_OFF` truthy desliga). */
export function isWatchdogEnabled(env: Record<string, string | undefined> = procEnv()): boolean {
  const raw = (env[WATCHDOG_DISABLE_ENV] ?? '').trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on');
}

/** Qual padrão de travamento disparou (DADO de UX/auditoria, sem segredo). */
export type StuckKind = 'same-tool-call' | 'same-tool-error' | 'empty-turns' | 'no-progress';

/**
 * O alerta de travamento entregue ao locus concreto (controller/TUI) p/
 * renderizar a pausa-pede-direção. Resume O QUE travou (DADO, sem texto cru
 * extenso) p/ o usuário decidir com contexto: o padrão, a contagem, e uma amostra
 * curta REDIGÍVEL (nome da tool / assinatura do erro). NÃO carrega input cru de
 * tool (que poderia ter segredo) — só o nome + um rótulo do que se repetiu.
 */
export interface StuckAlert {
  readonly kind: StuckKind;
  /** Quantas repetições/voltas estéreis foram observadas ao disparar. */
  readonly count: number;
  /**
   * Amostra CURTA do que travou, já num formato seguro p/ exibir:
   *  - same-tool-call: o NOME da tool (ex.: `run_command`);
   *  - same-tool-error: o nome da tool + assinatura clampada do erro;
   *  - empty-turns / no-progress: um rótulo do padrão.
   * NUNCA o input cru da tool (anti-vazamento — quem redige detalhe é o locus).
   */
  readonly sample: string;
}

/**
 * A decisão do usuário ao ver a pausa-pede-direção. Mesma família do
 * `AskResolution` (3 opções acionáveis):
 *  - `redirect`: o usuário deu uma NOVA INSTRUÇÃO (`text`) — entra pela MESMA
 *    costura de input do usuário (`user_inject`), e o loop SEGUE incorporando-a;
 *  - `continue`: ignora o aviso e segue mesmo assim (o detector é RESETADO);
 *  - `end`: encerra o turno.
 */
export type StuckResolution =
  | { readonly kind: 'redirect'; readonly text: string }
  | { readonly kind: 'continue' }
  | { readonly kind: 'end' };

/**
 * A interface que o locus concreto (controller/TUI) implementa p/ a
 * pausa-pede-direção. O loop a invoca quando o watchdog dispara. Async (há I/O de
 * terminal). `signal` propaga Ctrl-C: ao abortar, DEVE resolver como `end`
 * (fail-safe — nunca seguir girando por timeout de input). MESMA mecânica do
 * `AskResolver` (EST-0945) — pausa o loop, pergunta, retoma com a decisão.
 */
export interface StuckResolver {
  resolve(alert: StuckAlert, signal?: AbortSignal): Promise<StuckResolution>;
}

/** Quantos chars da assinatura de erro expor na amostra (auditoria sem flood). */
const ERROR_SAMPLE_MAX = 80;

/**
 * Detector incremental de travamento. UM por execução do loop (estado = as séries
 * recentes de tool-calls/erros/turnos). Barato: O(1) por evento (comparação de
 * string + contadores). NÃO guarda histórico — só o último valor de cada série e
 * seu contador, então a memória é O(1).
 *
 * CONTRATO DE ALIMENTAÇÃO (o que o `AgentLoop` chama, nos pontos onde JÁ produz o
 * sinal equivalente):
 *  - `noteIteration()`     — no topo de cada iteração (avança o relógio de "stale").
 *  - `noteToolCall(name,input)` — quando uma tool-call é DESPACHADA (antes do run).
 *  - `noteToolResult(name, ok, observation)` — quando a tool TERMINA. `ok=true`
 *    (sucesso) é PROGRESSO REAL; `ok=false` alimenta a série de erro.
 *  - `noteModelContent(text)` — quando o turno do modelo tem CONTEÚDO (texto).
 *  - `noteProgress()`      — algo REAL do mundo chegou ao contexto (ex.: evento de
 *    monitor drenado) SEM ser ordem do dono: zera stale/empty/erro (NÃO a série de
 *    call — não é redirect). Ver EST-MON-1.
 *  - `noteEmptyTurn()`     — quando o turno do modelo NÃO teve conteúdo nem tool.
 *  - `noteRedirect()`      — o usuário deu nova direção (`[r]`/btw): zera TUDO (a
 *    direção fresca é progresso máximo — o turno mudou de rumo).
 *  - `reset()`             — `[c] continuar`: zera p/ não re-disparar no mesmo padrão.
 *
 * Cada método de PROGRESSO REAL (tool NOVA, sucesso, conteúdo novo) zera os
 * contadores de "stale" e de turno-vazio — é isso que evita o falso-positivo numa
 * tarefa longa que de fato avança.
 *
 * `take()` devolve o alerta PENDENTE (se algum detector cruzou o limiar) e o
 * LIMPA. O loop o chama após cada bloco de eventos do turno; se há alerta, pausa.
 */
/**
 * EST-F54 — Pattern BROAD de "anúncio-sem-tool": verbos no futuro próximo
 * (1ª pessoa) seguidos de ação. Ex.: "vou agora: screenshot", "vou criar",
 * "deixa eu rodar". NÃO é sensible a maiúsculas/minúsculas.
 */
const ANNOUNCE_NO_TOOL_BROAD_RE =
  /\b(vou\s+(agora\s*[:;]?\s*)?(fazer|rodar|executar|criar|editar|escrever|chamar|usar|tirar|buscar|ler|procurar|testar|compilar|instalar|salvar|commitar|enviar|abrir|pegar|mostrar|listar|verificar|checar|conferir)|deixa\s+eu\s+(fazer|rodar|executar|ver|pegar)|farei|vou\s+te\s+mostrar|vou\s+agora|vamos?\s+(fazer|rodar|executar))\b/i;

export class StuckWatchdog {
  private readonly cfg: WatchdogConfig;

  // EST-1124 — barramento do Maestro (opcional). Se presente, emite
  // SupervisorSignal quando um alerta de travamento é gerado.
  private readonly bus: import('./maestro/bus.js').SignalCollector | undefined;

  // série: mesma tool-call consecutiva.
  private lastCallKey: string | undefined;
  private sameCallCount = 0;

  // série: mesmo erro de tool consecutivo.
  private lastErrorKey: string | undefined;
  private sameErrorCount = 0;

  // série: turnos vazios consecutivos.
  private emptyTurnCount = 0;

  // série: iterações sem progresso real.
  private staleIterations = 0;

  // EST-F54 — detector de "anúncio-sem-tool": o modelo anunciou uma ação
  // ("vou agora: X") mas NÃO emitiu tool-call. Ligado por `noteModelContent`
  // quando o texto casa com o padrão; desligado por `noteToolCall` (tool real)
  // e por `resetAll()`/`markProgress()`. Consumido pelo loop no seam de
  // continuação.
  private _announceNoToolDetected = false;

  // alerta pendente (setado quando um limiar cruza; drenado por take()).
  private pending: StuckAlert | undefined;

  constructor(
    cfg: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG,
    bus?: import('./maestro/bus.js').SignalCollector,
  ) {
    this.cfg = cfg;
    this.bus = bus;
  }

  /** Topo de uma iteração: conta uma volta "estéril" até que algo a marque viva. */
  noteIteration(): void {
    this.staleIterations += 1;
    if (this.pending === undefined && this.staleIterations >= this.cfg.maxStaleIterations) {
      // EST-1124 — emite sinal ao barramento (ADITIVO: freio DURO segue).
      this.bus?.publish({
        origin: 'stuck',
        severity: 'warning',
        ts: Date.now(),
        payload: {
          stuckKind: 'no-progress',
          count: this.staleIterations,
          sample: 'várias iterações sem avanço (nenhum arquivo/edição/comando novo)',
        },
      });
      this.pending = {
        kind: 'no-progress',
        count: this.staleIterations,
        sample: 'várias iterações sem avanço (nenhum arquivo/edição/comando novo)',
      };
    }
  }

  /**
   * Uma tool-call vai ser DESPACHADA. Mesma chave (name+input) que a anterior, sem
   * progresso real no meio ⇒ a série de repetição sobe. Chave NOVA ⇒ é progresso
   * (o modelo tentou algo DIFERENTE): zera a repetição E o "stale" (avançou de
   * fato). NUNCA expõe `input` no alerta — só `name`.
   */
  noteToolCall(name: string, input: Readonly<Record<string, unknown>>): void {
    this._announceNoToolDetected = false; // EST-F54 — tool real ⇒ não é "anúncio vazio"
    const key = `${name} ${stableInput(input)}`;
    if (key === this.lastCallKey) {
      this.sameCallCount += 1;
      if (this.pending === undefined && this.sameCallCount >= this.cfg.maxSameToolCall) {
        this.pending = { kind: 'same-tool-call', count: this.sameCallCount, sample: name };
      }
    } else {
      // tool-call DIFERENTE = o agente está explorando, não travado: zera a
      // repetição E marca a iteração como produtiva (não-stale).
      this.lastCallKey = key;
      this.sameCallCount = 1;
      this.staleIterations = 0;
    }
  }

  /**
   * Uma tool TERMINOU. `ok=true` (sucesso) é PROGRESSO REAL: zera as séries de
   * erro/stale/empty (algo de fato aconteceu). `ok=false` alimenta a série de
   * MESMO ERRO (assinatura = name + 1ª linha clampada da observação): mesmo erro
   * seguido ⇒ a série sobe; erro DIFERENTE ⇒ reinicia em 1.
   */
  noteToolResult(name: string, ok: boolean, observation: string): void {
    if (ok) {
      this.markProgress();
      return;
    }
    const sig = errorSignature(observation);
    // FIX EST-0969 (falso-positivo same-tool-error): a chave do erro usa a
    // IDENTIDADE da call (lastCallKey = name+input, do noteToolCall imediatamente
    // anterior), NAO so o name. Erros genericos compartilham a 1a linha entre
    // inputs distintos (todo run_command que falha comeca com "exit=N"): chavear
    // so por name fazia 3 comandos DIFERENTES que por acaso falham colidirem na
    // MESMA serie e dispararem "mesmo erro 3x" (falso-positivo de exploracao). O
    // falso-NEGATIVO oposto (mesma call, 1a linha do erro varia 1 byte) ja e pego
    // por same-tool-call (mesmo name+input sobe sameCallCount, independe do texto).
    // parser (sem call casada) cai no name via ?? name.
    const key = `${this.lastCallKey ?? name} ${sig}`;
    if (key === this.lastErrorKey) {
      this.sameErrorCount += 1;
    } else {
      this.lastErrorKey = key;
      this.sameErrorCount = 1;
    }
    if (this.pending === undefined && this.sameErrorCount >= this.cfg.maxSameToolError) {
      // EST-1124 — emite sinal ao barramento (ADITIVO: freio DURO segue).
      this.bus?.publish({
        origin: 'stuck',
        severity: 'warning',
        ts: Date.now(),
        payload: {
          stuckKind: 'same-tool-error',
          count: this.sameErrorCount,
          sample: `${name}: ${sig}`,
        },
      });
      this.pending = {
        kind: 'same-tool-error',
        count: this.sameErrorCount,
        sample: `${name}: ${sig}`,
      };
    }
  }

  /**
   * Algo REAL do MUNDO chegou ao contexto nesta volta (ex.: um evento de MONITOR
   * drenado — DADO de ambiente fresco que muda o que o modelo vê) SEM ser uma
   * ordem do dono. É PROGRESSO: zera as séries de stale/empty/erro (a volta não é
   * estéril — entrou informação nova). NÃO é um redirect do dono ⇒ NÃO zera a
   * série de repetição de CALL (mesma tool consecutiva segue sendo loop). DISTINTO
   * de `noteIteration` (que CONTA a volta como estéril) e de `noteRedirect` (que
   * zera TUDO, inclusive a série de call). Ver EST-MON-1 / loop.ts (drenagem de
   * monitor).
   */
  noteProgress(): void {
    this.markProgress();
  }

  /** O turno teve CONTEÚDO (texto do modelo): progresso — zera vazio/stale. */
  noteModelContent(text: string): void {
    if (text.trim().length === 0) return;
    this.emptyTurnCount = 0;
    this.staleIterations = 0;
    // EST-F54 — detector de "anúncio-sem-tool": se o texto parece anunciar
    // uma ação ("vou agora fazer X", "vou criar Y", "deixa eu rodar Z"),
    // marca p/ o loop decidir se continua (em vez de devolver o controle).
    this._announceNoToolDetected = ANNOUNCE_NO_TOOL_BROAD_RE.test(text);
  }

  /** EST-F54 — o modelo anunciou ação SEM emitir tool-call neste turno? */
  isAnnounceNoTool(): boolean {
    return this._announceNoToolDetected;
  }

  /**
   * O turno do modelo NÃO teve conteúdo NEM tool-call (o "▏ nada"). Série de
   * turnos vazios sobe; ao cruzar o limiar, pede direção.
   */
  noteEmptyTurn(): void {
    this.emptyTurnCount += 1;
    if (this.pending === undefined && this.emptyTurnCount >= this.cfg.maxEmptyTurns) {
      // EST-1124 — emite sinal ao barramento (ADITIVO: freio DURO segue).
      this.bus?.publish({
        origin: 'stuck',
        severity: 'warning',
        ts: Date.now(),
        payload: {
          stuckKind: 'empty-turns',
          count: this.emptyTurnCount,
          sample: 'respostas vazias seguidas (sem texto nem ação)',
        },
      });
      this.pending = {
        kind: 'empty-turns',
        count: this.emptyTurnCount,
        sample: 'respostas vazias seguidas (sem texto nem ação)',
      };
    }
  }

  /**
   * O usuário deu NOVA DIREÇÃO (`[r]` / "btw" mid-turn): zera TUDO. A direção
   * fresca é o progresso máximo (o turno mudou de rumo) — não faz sentido manter
   * nenhuma série do padrão anterior.
   */
  noteRedirect(): void {
    this.resetAll();
  }

  /**
   * `[c] continuar mesmo assim`: zera os contadores p/ NÃO re-disparar no MESMO
   * padrão imediatamente (o usuário escolheu seguir; respeitamos sem voltar a
   * incomodar na próxima volta). Limpa também qualquer alerta pendente.
   */
  reset(): void {
    this.resetAll();
  }

  /**
   * Drena o alerta PENDENTE (se um detector cruzou o limiar) e o limpa. O loop o
   * chama após processar os eventos do turno; alerta presente ⇒ pausa-pede-direção.
   */
  take(): StuckAlert | undefined {
    const a = this.pending;
    this.pending = undefined;
    return a;
  }

  /** PROGRESSO REAL (sucesso de tool): zera erro/stale/empty (não a repetição de call). */
  private markProgress(): void {
    this.lastErrorKey = undefined;
    this.sameErrorCount = 0;
    this.emptyTurnCount = 0;
    this.staleIterations = 0;
    this._announceNoToolDetected = false; // EST-F54
  }

  private resetAll(): void {
    this.lastCallKey = undefined;
    this.sameCallCount = 0;
    this.lastErrorKey = undefined;
    this.sameErrorCount = 0;
    this.emptyTurnCount = 0;
    this.staleIterations = 0;
    this.pending = undefined;
    this._announceNoToolDetected = false; // EST-F54
  }
}

/**
 * Fábrica do watchdog p/ o loop (DRY: pai e sub-agentes usam a MESMA config). Lê
 * o toggle + a config do env; `env` injetável p/ teste. Devolve `undefined` quando
 * DESLIGADO (`ALUY_STUCK_OFF`) — o loop então roda idêntico ao baseline (sem
 * pausa-pede-direção). Ligado por default.
 */
export function newStuckWatchdog(
  env?: Record<string, string | undefined>,
): StuckWatchdog | undefined {
  if (!isWatchdogEnabled(env)) return undefined;
  return new StuckWatchdog(resolveWatchdogConfig(env));
}

/**
 * Serializa um valor de forma ESTÁVEL e RECURSIVA (deep): cada objeto tem as
 * chaves ordenadas em TODOS os níveis, e todo o conteúdo aninhado entra no
 * resultado. Arrays preservam a ordem (posição é semântica). NÃO usa o 2º arg
 * (replacer-array) do `JSON.stringify` — esse arg é uma allowlist de chaves
 * aplicada RECURSIVAMENTE, que apagava qualquer campo aninhado e fazia inputs
 * DIFERENTES colidirem na mesma chave (falso-positivo do watchdog #122).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // primitivos (e null/undefined): JSON.stringify cobre string/number/boolean/
    // null; undefined/funções viram `undefined` → marcador estável.
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * Serialização ESTÁVEL do input de uma tool-call p/ comparar "mesma chamada".
 * Chaves ordenadas RECURSIVAMENTE (`{a,b}` e `{b,a}` colidem de propósito) E
 * todo o conteúdo aninhado conta (inputs que diferem só num sub-objeto produzem
 * chaves DIFERENTES ⇒ não é "mesma chamada repetida"). Determinística e barata;
 * NUNCA é exposta no alerta (fica só na chave interna). Tolerante a valores
 * não-serializáveis (ciclos etc.) — cai num marcador estável.
 */
function stableInput(input: Readonly<Record<string, unknown>>): string {
  try {
    return stableStringify(input);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Assinatura de um erro de tool: a 1ª linha não-vazia da observação, clampada e
 * normalizada (espaços colapsados). Estável o bastante p/ "o MESMO erro" sem ser
 * sensível a um sufixo variável longo. Sem segredo cru extenso (clampada).
 */
function errorSignature(observation: string): string {
  const firstLine = observation
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const sig = (firstLine ?? observation).replace(/\s+/g, ' ').trim();
  return sig.length <= ERROR_SAMPLE_MAX ? sig : `${sig.slice(0, ERROR_SAMPLE_MAX)}…`;
}

function procEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/**
 * Lê um inteiro positivo do env com um PISO (`min`) e um default. Inválido/vazio
 * ⇒ default; abaixo do piso ⇒ piso (um `1` minúsculo não vira falso-positivo).
 */
function floorAtLeast(raw: string | undefined, min: number, dflt: number): number {
  if (raw === undefined) return dflt;
  const s = raw.trim();
  if (s === '') return dflt;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(min, Math.floor(n));
}
