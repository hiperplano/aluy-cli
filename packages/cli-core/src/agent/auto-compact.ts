// EST-0973 — AUTO-COMPACTAÇÃO da JANELA de contexto (sem intervenção do usuário).
//
// O problema (Tiago, dogfooding): o agente EXPLORA demais (lê muito), a JANELA de
// contexto enche e ele STALLA em 100% — em vez de COMPACTAR sozinho (resumir o que
// já leu) e CONTINUAR pros edits. Já existe `/compact` MANUAL + `[k]` + o budget
// gate; faltava o automático: quando a janela cruza ~85%, compactar e seguir o loop.
//
// Este módulo é a PARTE PURA/PORTÁVEL (a costura com o loop vive em loop.ts; a
// compactação concreta — chamar o broker p/ resumir — vem por uma PORTA injetada):
//   • `resolveAutoCompact` decide a CONFIG (a partir de env/flag, sem efeito);
//   • `windowRatio` mede a OCUPAÇÃO da janela (tokens do prompt / janela do modelo);
//   • `decideAutoCompact` é o JUÍZO determinístico + ANTI-LOOP — diz se compacta
//     agora, ou se DESISTE (janela cheia mesmo após compactar) p/ não compactar em
//     loop. NÃO faz I/O, não chama modelo, não toca a catraca/budget.
//
// RELAÇÃO COM O BUDGET GATE (CLI-SEC-8) — são ORTOGONAIS:
//   • o BUDGET (limits.ts / SessionBudget) cerca o TOTAL de tokens/iterações/tool-
//     calls da SESSÃO (anti-runaway de CUSTO) — quando estoura, PAUSA e pergunta;
//   • a JANELA (este módulo) é o tamanho do CONTEXTO que cabe numa ÚNICA chamada ao
//     modelo (anti-overflow de PROMPT) — quando enche, COMPACTA e CONTINUA, sozinho.
// Um pode disparar sem o outro: um prompt gigante enche a JANELA muito antes de o
// TOTAL de tokens da sessão bater o budget; e uma sessão longa de turnos pequenos
// pode bater o budget sem nunca encher a janela. A auto-compactação age na JANELA;
// o budget gate segue intacto na sua função (teto de custo).
//
// SEGURANÇA (CLI-SEC-6): este módulo NÃO vê texto de conversa — só NÚMEROS (tokens
// e razões). A compactação em si reusa o MESMO caminho do `/compact` (Compactor →
// broker), cujo resumo é gerado a partir do histórico JÁ REDIGIDO (a redação da
// saída de tool ocorre no core, antes de o item entrar no histórico) — então um
// segredo lido NÃO vaza pro sumário. Aqui não há texto a redigir; é só o gatilho.

/**
 * Configuração RESOLVIDA da auto-compactação para UMA execução do loop.
 * `at:0` ⇒ DESLIGADA (o loop roda IDÊNTICO ao baseline — nenhuma auto-compactação).
 * Os números já vêm validados/clampados por `resolveAutoCompact`.
 */
export interface AutoCompactConfig {
  /**
   * LIMIAR de ocupação da janela (razão 0..1) que dispara a compactação automática.
   * `0` ⇒ DESLIGADA. Default `DEFAULT_AUTOCOMPACT_AT` (0.85 = 85% da janela). Clampado
   * a `(0, MAX_AUTOCOMPACT_AT]` quando ligado (0 é o único valor "off"; nunca >0.98,
   * p/ sempre haver folga antes do overflow real do provider).
   */
  readonly at: number;
  /**
   * Tamanho da JANELA de contexto do modelo (tokens). Denominador da razão de
   * ocupação. Vem do locus concreto (catálogo/tier). `<=0` ⇒ auto-compactação inerte
   * (sem janela conhecida, não há % a medir — fail-safe, baseline).
   */
  readonly contextWindow: number;
  /**
   * ANTI-LOOP: nº MÁXIMO de auto-compactações CONSECUTIVAS sem progresso real (a
   * janela não baixou do limiar e nenhuma tool rodou no intervalo). Atingido o teto,
   * o loop PARA de auto-compactar e cai no comportamento atual (avisa o usuário). `>=1`.
   */
  readonly maxConsecutive: number;
}

/** LIMIAR default: 85% da janela (a estória). Antes da chamada que estouraria. */
export const DEFAULT_AUTOCOMPACT_AT = 0.85;
/** Piso são do limiar quando ligado (abaixo disso compactaria cedo demais/sempre). */
export const MIN_AUTOCOMPACT_AT = 0.5;
/** Teto são: SEMPRE deixa folga antes do overflow real do provider (nunca 100%). */
export const MAX_AUTOCOMPACT_AT = 0.98;

/** ANTI-LOOP default: no máximo 2 compactações seguidas sem progresso ⇒ desiste. */
export const DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT = 2;
/** Piso/teto sãos do anti-loop (1 = tenta ao menos 1×; teto baixo = não vira loop). */
export const MIN_MAX_CONSECUTIVE_AUTOCOMPACT = 1;
export const MAX_MAX_CONSECUTIVE_AUTOCOMPACT = 5;

/** Config DESLIGADA (baseline). Reusada quando nada liga a auto-compactação. */
export const AUTOCOMPACT_OFF: AutoCompactConfig = {
  at: 0,
  contextWindow: 0,
  maxConsecutive: DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT,
};

/**
 * Ocupação da JANELA (razão 0..1): tokens do PROMPT da última chamada / janela do
 * modelo. O numerador honesto é o `tokens_in` reportado pelo broker (o tamanho REAL
 * do prompt enviado = system + histórico) — não um palpite local. Clampa em `[0,1]`.
 * `contextWindow<=0` ou `tokensIn` inválido ⇒ 0 (fail-safe: sem sinal, não dispara).
 * PURA.
 */
export function windowRatio(tokensIn: number | undefined, contextWindow: number): number {
  if (!Number.isFinite(tokensIn) || tokensIn === undefined || tokensIn <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(0, Math.min(1, tokensIn / contextWindow));
}

/**
 * Estado MUTÁVEL do anti-loop por execução (vive no runLoop). `consecutive` conta
 * auto-compactações SEGUIDAS sem progresso real; `gaveUp` trava (one-shot) a
 * auto-compactação após estourar o teto — o loop volta ao baseline e avisa 1×.
 */
export interface AutoCompactState {
  /** Auto-compactações consecutivas sem progresso real (janela não baixou / sem tool). */
  consecutive: number;
  /** `true` após o anti-loop desistir — não tenta mais auto-compactar neste run. */
  gaveUp: boolean;
}

/** Estado inicial do anti-loop (nada compactado ainda). */
export function newAutoCompactState(): AutoCompactState {
  return { consecutive: 0, gaveUp: false };
}

/** Decisão do juízo de auto-compactação para a iteração corrente. */
export type AutoCompactDecision =
  // Compacta AGORA (a janela cruzou o limiar e o anti-loop permite). O loop chama a
  // porta de compactação e CONTINUA.
  | { readonly action: 'compact' }
  // DESISTE: a janela está cheia MESMO após compactar (sem progresso) e o teto do
  // anti-loop estourou. O loop avisa o usuário UMA vez e cai no baseline (não
  // compacta em loop). `firstTime` marca a transição (p/ emitir a nota só 1×).
  | { readonly action: 'give-up'; readonly firstTime: boolean }
  // Nada a fazer: janela abaixo do limiar (ou auto-compactação desligada/inerte).
  | { readonly action: 'none' };

/**
 * JUÍZO determinístico + ANTI-LOOP da auto-compactação. PURO — não muta o estado
 * (o loop aplica a mutação via `noteAutoCompacted`/`noteProgress`). Decide, a partir
 * da ocupação corrente da janela e do estado do anti-loop:
 *
 *  • `none`     — a janela está ABAIXO do limiar (`ratio < at`), ou a auto-compactação
 *                 está desligada (`at<=0`) / inerte (sem janela). Segue o loop normal.
 *  • `give-up`  — a janela está NO/ACIMA do limiar MAS o anti-loop já estourou
 *                 (`consecutive >= maxConsecutive`): compactar de novo não ajudou
 *                 (a janela não baixou). NÃO compacta — avisa e cai no baseline.
 *                 `firstTime=true` só na PRIMEIRA vez (transição p/ `gaveUp`), p/ a
 *                 nota sair uma vez só.
 *  • `compact`  — a janela cruzou o limiar e ainda há orçamento anti-loop: compacta.
 *
 * O anti-loop GARANTE que nunca se compacta PIOR que hoje: se a compactação não
 * libera o suficiente (turno gigante sozinho, ou sumário ainda > limiar), depois de
 * `maxConsecutive` tentativas seguidas o loop DESISTE e segue como antes (o budget
 * gate / os tetos seguem cercando o runaway).
 */
export function decideAutoCompact(
  cfg: AutoCompactConfig,
  ratio: number,
  state: AutoCompactState,
): AutoCompactDecision {
  // Desligada (at<=0) ou inerte (sem janela conhecida) ⇒ baseline.
  if (cfg.at <= 0 || cfg.contextWindow <= 0) return { action: 'none' };
  // Janela ainda com folga ⇒ nada a fazer.
  if (ratio < cfg.at) return { action: 'none' };
  // Cruzou o limiar. Já desistimos antes? Não re-avisa (nota foi 1×); segue baseline.
  if (state.gaveUp) return { action: 'give-up', firstTime: false };
  // Anti-loop: estourou o teto de compactações seguidas sem progresso ⇒ DESISTE agora.
  if (state.consecutive >= cfg.maxConsecutive) return { action: 'give-up', firstTime: true };
  // Há orçamento anti-loop e a janela está cheia ⇒ compacta e continua.
  return { action: 'compact' };
}

/**
 * Parseia o valor de `ALUY_AUTOCOMPACT_AT` (env/flag). Aceita:
 *  - `'off'`/`'0'`/`'false'`/`'no'` ⇒ DESLIGA (`0`);
 *  - uma RAZÃO `0..1` (ex.: `0.85`) ⇒ usada direto;
 *  - uma PORCENTAGEM `>1` e `<=100` (ex.: `85`) ⇒ dividida por 100 (conveniência);
 * Inválido/vazio/undefined ⇒ `undefined` (cai no default). PURO.
 */
export function parseAutoCompactAt(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'off' || s === 'false' || s === 'no' || s === 'none') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return 0; // 0 (ou negativo) ⇒ desliga
  // porcentagem amigável (85 ⇒ 0.85): aceita até 100; >1 vira razão.
  const ratio = n > 1 ? n / 100 : n;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return ratio;
}

/** Parseia um inteiro positivo clampado em `[min,max]`; inválido ⇒ `undefined`. */
function parseIntClamped(
  v: string | number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Entradas (cruas) para resolver a config da auto-compactação. Tudo opcional. */
export interface AutoCompactInputs {
  /**
   * `--autocompact-at` (flag) OU `ALUY_AUTOCOMPACT_AT` (env): o LIMIAR. A flag VENCE
   * o env. `'off'`/`0` desliga; razão `0..1` ou porcentagem `>1` ligam. Ausente ⇒ default.
   */
  readonly atFlag?: string | number | undefined;
  readonly atEnv?: string | undefined;
  /** ADR-0136 balde(a): `config.context.autocompactAt` — entra ENTRE env e default. */
  readonly atConfig?: string | number | undefined;
  /** Tamanho da janela do modelo (tokens). `<=0`/ausente ⇒ auto-compactação inerte. */
  readonly contextWindow?: number | undefined;
  /** `ALUY_AUTOCOMPACT_MAX` (env) — override do teto do anti-loop. */
  readonly maxConsecutiveEnv?: string | undefined;
  /** ADR-0136 balde(a): `config.context.autocompactMax` — entra ENTRE env e default. */
  readonly maxConsecutiveConfig?: string | number | undefined;
}

/**
 * Resolve a `AutoCompactConfig` EFETIVA, determinística e pura. GATING:
 *
 *   1) o LIMIAR vem da FLAG (`--autocompact-at`), senão do ENV (`ALUY_AUTOCOMPACT_AT`),
 *      senão do DEFAULT (0.85). `off`/`0` em qualquer um DESLIGA (at=0).
 *   2) ligado, o limiar é clampado a `[MIN_AUTOCOMPACT_AT, MAX_AUTOCOMPACT_AT]` — nunca
 *      compacta cedo demais nem tão tarde a ponto de não haver folga antes do overflow.
 *   3) sem `contextWindow` (>0) a auto-compactação fica INERTE (sem janela, sem %).
 *
 * Default LIGADO (0.85): diferente do self-check (off por default), encher a janela e
 * STALLAR é uma falha DURA do agente (trava o trabalho) — então o comportamento são é
 * compactar e seguir por default, sempre DESLIGÁVEL (`ALUY_AUTOCOMPACT_AT=0`).
 */
export function resolveAutoCompact(inputs: AutoCompactInputs): AutoCompactConfig {
  const contextWindow = inputs.contextWindow ?? 0;
  const fromFlag = parseAutoCompactAt(inputs.atFlag);
  const fromEnv = parseAutoCompactAt(inputs.atEnv);
  const fromConfig = parseAutoCompactAt(inputs.atConfig);
  // Precedência ADR-0136: flag > env > config > default. `off`/0 em qualquer um desliga.
  const rawAt = fromFlag ?? fromEnv ?? fromConfig ?? DEFAULT_AUTOCOMPACT_AT;
  if (rawAt <= 0 || contextWindow <= 0) {
    return { ...AUTOCOMPACT_OFF, contextWindow: Math.max(0, contextWindow) };
  }
  const at = Math.min(MAX_AUTOCOMPACT_AT, Math.max(MIN_AUTOCOMPACT_AT, rawAt));
  const maxConsecutive =
    parseIntClamped(
      inputs.maxConsecutiveEnv,
      MIN_MAX_CONSECUTIVE_AUTOCOMPACT,
      MAX_MAX_CONSECUTIVE_AUTOCOMPACT,
    ) ??
    parseIntClamped(
      inputs.maxConsecutiveConfig,
      MIN_MAX_CONSECUTIVE_AUTOCOMPACT,
      MAX_MAX_CONSECUTIVE_AUTOCOMPACT,
    ) ??
    DEFAULT_MAX_CONSECUTIVE_AUTOCOMPACT;
  return { at, contextWindow, maxConsecutive };
}

/** Marcador estável da nota "desisti de auto-compactar" (p/ a UX e p/ asserções). */
export const AUTOCOMPACT_GAVEUP_MARKER = 'janela cheia mesmo após compactar';
