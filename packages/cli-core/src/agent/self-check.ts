// EST-0944 — SELF-CHECK de atenção (compensa modelo BARATO/FRACO que "perde o fio").
//
// Modelos econômicos (flux / custom de contexto pequeno) DERRAPAM em duas frentes
// num loop agêntico longo:
//   1) ESQUECEM o objetivo no meio de muitas iterações (o goal vai ficando longe no
//      topo do histórico e o modelo passa a otimizar o último passo, não a tarefa);
//   2) DECLARAM "pronto" sem ter feito (a alucinação clássica do "claimed done" —
//      respondem como se tivessem cumprido, sem conferir a EVIDÊNCIA real).
//
// Este módulo é a PARTE PURA dos dois mecanismos (a costura com o loop vive em
// loop.ts). Nada aqui faz I/O, chama modelo ou toca a catraca — só decide a CONFIG
// (a partir de flag/env/tier, sem efeito colateral) e REDIGE os lembretes/probes
// que o loop injeta no histórico. Testável isolado e determinístico.
//
// SEGURANÇA (CLI-SEC-4): os textos que este módulo produz são AUTORADOS POR NÓS
// (confiáveis), nunca conteúdo ingerido. O loop os anexa como `reanchor` — um
// AUTO-LEMBRETE do agente (canal `assistant`, ver context.ts), NÃO `user_inject`
// (não é o humano dando ordem nova) e NÃO `observation`/DADO_NAO_CONFIÁVEL (não é
// saída de ambiente). Não amplia escopo, não vira `system`, não destrava sempre-ask:
// qualquer efeito que o modelo dispare DEPOIS ainda RE-PASSA `decide()` (CLI-SEC-H1).

/**
 * Configuração RESOLVIDA do self-check de atenção para UMA execução do loop.
 * `enabled:false` ⇒ o loop roda IDÊNTICO ao baseline (nenhuma re-âncora, nenhuma
 * auto-verificação). Os números já vêm validados/clampados por `resolveSelfCheck`.
 */
export interface SelfCheckConfig {
  /** Liga os dois mecanismos. `false` ⇒ baseline puro (sem overhead). */
  readonly enabled: boolean;
  /**
   * RE-ÂNCORA: a cada `reanchorEveryK` iterações, re-injeta o objetivo original
   * como auto-lembrete curto. `>=1`. Só vale com `enabled:true`.
   */
  readonly reanchorEveryK: number;
  /**
   * AUTO-VERIFICAÇÃO pré-"pronto": quantas vezes, NO MÁXIMO, o loop pode pedir ao
   * modelo p/ reconferir uma resposta FINAL contra a evidência antes de aceitar o
   * "pronto". Cap anti-loop: após `maxVerifications` o done é aceito (com aviso),
   * mesmo que o modelo "ainda ache gaps". `>=1`. Só vale com `enabled:true`.
   */
  readonly maxVerifications: number;
}

/** RE-ÂNCORA default: a cada 8 iterações (barato — só contexto). */
export const DEFAULT_REANCHOR_EVERY_K = 8;
/** Piso/teto sãos do K da re-âncora (evita 0 = divisão por zero; teto = não exagerar). */
export const MIN_REANCHOR_EVERY_K = 1;
export const MAX_REANCHOR_EVERY_K = 1_000;

/** AUTO-VERIFICAÇÃO default: no máximo 2 passadas por turno (anti-loop). */
export const DEFAULT_MAX_VERIFICATIONS = 2;
/** Piso/teto sãos do cap de verificações (1 = ao menos uma; teto baixo = não vira loop). */
export const MIN_MAX_VERIFICATIONS = 1;
export const MAX_MAX_VERIFICATIONS = 10;

/** Config DESLIGADA (baseline). Reusada quando nada liga o self-check. */
export const SELF_CHECK_OFF: SelfCheckConfig = {
  enabled: false,
  reanchorEveryK: DEFAULT_REANCHOR_EVERY_K,
  maxVerifications: DEFAULT_MAX_VERIFICATIONS,
};

/**
 * TIERS reconhecidamente FRACOS — ligam o self-check por DEFAULT (sem flag), porque
 * é exatamente onde o ganho de atenção compensa o custo extra. A lista é por
 * SUBSTRING (case-insensitive) do nome do tier que o cliente envia (HG-2: o tier é
 * a única coisa que sai do cliente; o broker resolve o provider). Hoje SÓ:
 *  - `custom` → modelos CUSTOM (BYO): janela/qualidade DESCONHECIDAS e tipicamente
 *               menores; é o caso onde a atenção extra mais compensa.
 *
 * DELIBERADAMENTE NÃO inclui o tier ECONÔMICO default (`aluy-flux`): ele é o tier de
 * TODA sessão padrão, então ligá-lo aqui faria o self-check ser o de-facto default
 * GLOBAL (+tokens p/ todo mundo) — o oposto de "OFF por default, liga fácil". Quem
 * roda no flux e quer a rede extra liga com `--self-check`/`ALUY_SELF_CHECK=1`. O
 * default global é OFF; só `custom` (genuinamente incerto) liga sozinho. Sempre
 * desligável pela flag (que VENCE o tier). Conservador: lista curta e explícita.
 */
export const WEAK_TIERS: readonly string[] = ['custom'];

/**
 * `true` se o `tier` casa com um tier fraco conhecido (substring, case-insensitive).
 * `undefined`/'' ⇒ `false` (sem tier = não presume fraco; o gating cai na flag/env).
 * PURO.
 */
export function isWeakTier(tier: string | undefined): boolean {
  if (!tier) return false;
  const t = tier.toLowerCase();
  return WEAK_TIERS.some((w) => t.includes(w));
}

/** Parseia um valor booleano de env/flag (`'1'`,`'true'`,`'on'`,`'yes'` ⇒ true). */
function parseBoolSetting(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '') return undefined;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return undefined; // valor não reconhecido ⇒ ignorado (cai no próximo da precedência)
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

/** Entradas (cruas) para resolver a config do self-check. Tudo opcional. */
export interface SelfCheckInputs {
  /** `--self-check` (a flag VENCE o tier). `true` liga, `false` DESLIGA explícito. */
  readonly flag?: string | boolean | undefined;
  /** `ALUY_SELF_CHECK` (env). Mesma semântica da flag, com precedência menor. */
  readonly env?: string | undefined;
  /** Tier corrente (HG-2). Tier fraco LIGA por default quando flag/env não decidem. */
  readonly tier?: string | undefined;
  /** `ALUY_SELF_CHECK_EVERY` (env) — override do K da re-âncora. */
  readonly everyKEnv?: string | undefined;
  /** `ALUY_SELF_CHECK_MAX` (env) — override do cap de verificações. */
  readonly maxVerificationsEnv?: string | undefined;
  /**
   * ADR-0150 (balde b, Tier 2) — `config.advanced.selfCheck.everyK` (~/.aluy/config.json).
   * Nível ENTRE env e default (env > config > default); MESMO clamp de `everyKEnv`.
   */
  readonly everyKConfig?: number | undefined;
  /**
   * ADR-0150 (balde b, Tier 2) — `config.advanced.selfCheck.maxVerifications`. Nível
   * ENTRE env e default (env > config > default); MESMO clamp de `maxVerificationsEnv`.
   */
  readonly maxVerificationsConfig?: number | undefined;
}

/**
 * Resolve a `SelfCheckConfig` EFETIVA, determinística e pura. GATING:
 *
 *   1) `flag` (`--self-check`/`--no-self-check`) VENCE tudo — true liga, false
 *      DESLIGA mesmo em tier fraco (o usuário sempre pode desligar);
 *   2) senão `env` (`ALUY_SELF_CHECK=1/0`) — mesma semântica;
 *   3) senão AUTO por TIER: liga sozinho SÓ em tier fraco (`isWeakTier`), pois é
 *      onde compensa; tier forte ⇒ OFF por default (não onera quem não quer).
 *
 * Default global (sem flag, sem env, tier forte/ausente) = OFF: o self-check custa
 * +1 chamada por "done" + re-âncora periódica (mais tokens). Pra modelo BARATO isso
 * COMPENSA (mais confiável); pra modelo forte é desperdício — então só liga onde
 * vale, e é sempre DESLIGÁVEL. Os números (`everyK`/`maxVerifications`) vêm de env
 * própria (clampada) ou do default; valem só quando `enabled`.
 */
export function resolveSelfCheck(inputs: SelfCheckInputs): SelfCheckConfig {
  const fromFlag = parseBoolSetting(inputs.flag);
  const fromEnv = parseBoolSetting(inputs.env);
  const enabled = fromFlag ?? fromEnv ?? isWeakTier(inputs.tier);
  if (!enabled) return SELF_CHECK_OFF;
  return {
    enabled: true,
    // ADR-0150 (balde b, Tier 2) — precedência env > config > default (config é o
    // nível NOVO, "termina o padrão"; o env já existia e segue vencendo).
    reanchorEveryK:
      parseIntClamped(inputs.everyKEnv, MIN_REANCHOR_EVERY_K, MAX_REANCHOR_EVERY_K) ??
      parseIntClamped(inputs.everyKConfig, MIN_REANCHOR_EVERY_K, MAX_REANCHOR_EVERY_K) ??
      DEFAULT_REANCHOR_EVERY_K,
    maxVerifications:
      parseIntClamped(inputs.maxVerificationsEnv, MIN_MAX_VERIFICATIONS, MAX_MAX_VERIFICATIONS) ??
      parseIntClamped(
        inputs.maxVerificationsConfig,
        MIN_MAX_VERIFICATIONS,
        MAX_MAX_VERIFICATIONS,
      ) ??
      DEFAULT_MAX_VERIFICATIONS,
  };
}

/** Marcador estável do texto de re-âncora (p/ asserções e p/ a UX reconhecer). */
export const REANCHOR_MARKER = 'LEMBRETE — objetivo desta tarefa';
/** Marcador estável do texto da auto-verificação pré-"pronto". */
export const SELF_CHECK_MARKER = 'AUTO-VERIFICAÇÃO antes de concluir';

/** Clampa um trecho longo p/ não inflar o contexto da re-âncora/probe. */
function clampSnippet(s: string, max = 240): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

/**
 * RE-ÂNCORA — redige o auto-lembrete curto que o loop re-injeta a cada K iterações.
 * É um LEMBRETE (1ª pessoa do agente p/ si): o objetivo ORIGINAL + um resumo curto
 * das últimas ações + a pergunta "falta?". Barato (só contexto). NÃO é ordem nova
 * nem dado: o loop o anexa como `reanchor` (canal `assistant`, trusted) — não muda
 * a catraca, não amplia escopo. PURO.
 *
 * `recentActions` é uma lista JÁ resumida (rótulos curtos das últimas N ações, ex.:
 * "leu README.md", "rodou npm test"); o caller a deriva do histórico (sem dado cru).
 */
export function buildReanchor(goal: string, recentActions: readonly string[]): string {
  const did =
    recentActions.length > 0
      ? recentActions.map((a) => clampSnippet(a, 80)).join('; ')
      : '(ainda nada relevante)';
  return (
    `${REANCHOR_MARKER}: ${clampSnippet(goal)}. ` +
    `Você JÁ fez: ${did}. ` +
    `Pare e confira: o que você está fazendo AGORA ainda serve a esse objetivo? ` +
    `O que FALTA para cumpri-lo? Se desviou, retome o objetivo; não otimize só o último passo.`
  );
}

/**
 * AUTO-VERIFICAÇÃO pré-"pronto" — redige o probe que o loop injeta QUANDO o modelo
 * deu uma resposta FINAL, p/ uma passada extra de conferência ANTES de aceitar o
 * "pronto". Pede explicitamente p/ conferir a EVIDÊNCIA (arquivos/saídas REAIS), não
 * a memória; se faltou algo, LISTAR e CONTINUAR (o loop segue); se cumpriu, CONFIRMAR
 * (o loop encerra). É um auto-lembrete (canal `assistant`, trusted) — não toca a
 * catraca. PURO.
 *
 * `attempt`/`max` ficam no texto p/ o modelo saber que é uma passada finita (na
 * última, o loop aceita o done de qualquer forma — anti-loop).
 */
export function buildSelfCheckProbe(goal: string, attempt: number, max: number): string {
  return (
    `${SELF_CHECK_MARKER} (passada ${attempt}/${max}): você indicou que terminou. ` +
    `Antes de eu aceitar como concluído, confira o objetivo: "${clampSnippet(goal)}". ` +
    `Você REALMENTE o cumpriu? Verifique pela EVIDÊNCIA REAL (arquivos criados/editados, ` +
    `saídas de comando que você de fato viu) — NÃO pela sua memória nem por suposição. ` +
    `Se faltou QUALQUER coisa, liste o que falta e CONTINUE trabalhando (use as ferramentas). ` +
    // F-SC (fix) — SAÍDA EXPLÍCITA p/ "o que falta é DECISÃO DO USUÁRIO". Sem esta
    // cláusula o probe só oferecia duas saídas — "confirmo que cumpri" (mentira) ou
    // "continuo trabalhando" — então um modelo que havia PERGUNTADO ao usuário
    // ("Quer que eu reconfigure assim?") escolhia CONTINUAR e EXECUTAVA a decisão que
    // acabara de oferecer. O probe existe p/ pegar "claimed done" alucinado, NÃO p/
    // atropelar o dono. Decisão pendente é conclusão LEGÍTIMA de turno.
    `Se o que falta depende de uma DECISÃO ou AUTORIZAÇÃO do usuário (você fez uma pergunta, ` +
    `ofereceu opções, ou o próximo passo é destrutivo/irreversível), NÃO continue e NÃO execute: ` +
    `entregue a pergunta e pare — esperar a resposta é o certo. Se precisa da resposta p/ seguir, ` +
    `use a tool \`perguntar\`. ` +
    `Se estiver mesmo tudo cumprido e comprovado, responda confirmando — em texto, SEM tool-call.`
  );
}

/**
 * F-SC (fix) — `true` se a resposta FINAL do modelo está ESPERANDO O USUÁRIO: uma
 * pergunta, um pedido de confirmação, ou uma oferta de opções. Nesse caso o loop NÃO
 * deve sondar (`buildSelfCheckProbe`): a premissa do probe ("você indicou que terminou")
 * é FALSA, e a única "lacuna" é a resposta que só o dono pode dar.
 *
 * POR QUE ISTO É NECESSÁRIO além da cláusula no texto do probe: o self-check liga por
 * DEFAULT justamente nos tiers FRACOS (`WEAK_TIERS`), que são os que MENOS honram
 * instrução condicional. A defesa não pode depender do modelo ler o parágrafo certo —
 * o gate tem de ser nosso. Espelha o gate `successfulToolCalls > 0` (que já evita sondar
 * turno conversacional "por não haver evidência"): aqui não sondamos porque o que falta
 * NÃO É TRABALHO NOSSO.
 *
 * DIREÇÃO DO ERRO É SEGURA: um falso POSITIVO só faz o loop aceitar a resposta como
 * final — exatamente o baseline com self-check desligado (nenhum efeito extra, nenhuma
 * perda de segurança). Um falso NEGATIVO devolve o comportamento antigo (sonda), que a
 * cláusula do probe ainda cobre. Por isso a heurística pode ser generosa.
 *
 * Olha só o FIM do texto (últimas linhas): é onde vive o fechamento "quer que eu…?".
 * Uma `?` no meio de um relatório (ex.: "por quê? porque X") não conta. PURO.
 */
export function awaitsUserDecision(finalText: string): boolean {
  const text = (finalText ?? '').trim();
  if (text === '') return false;
  // CAUDA: as últimas linhas não-vazias — o fechamento do turno.
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const tail = lines.slice(-3).join(' ').toLowerCase();
  if (tail === '') return false;
  // (1) fechamento interrogativo — DELEGADO ao `endsWithUserQuestion` do seam de
  // continuação (FONTE ÚNICA): ele já lida com a decoração do fim (emoji/pictográficos,
  // ZWJ, `*_~\`` de markdown, aspas e parênteses de fechamento) antes de olhar o `?`, o
  // que um `/\?\s*$/` ingênuo perderia em `**Posso aplicar?**` ou `… assim? 🤔`.
  // Reusar em vez de reimplementar evita o que esta função nasceu para corrigir: DOIS
  // heurísticos divergentes para o MESMO conceito no mesmo diretório.
  if (endsWithUserQuestion(text)) return true;
  // (2) fórmulas de pedido de decisão/autorização (PT-BR + EN), na CAUDA. Cobrem o
  //     caso em que o modelo fecha sem `?` ("me diga qual opção prefere.").
  const ASKS: readonly RegExp[] = [
    /\bquer que eu\b/,
    /\bposso (seguir|prosseguir|continuar|aplicar|rodar|executar|fazer|apagar|remover)\b/,
    /\bdevo (seguir|prosseguir|continuar|aplicar|rodar|executar|fazer)\b/,
    /\b(confirma|confirme|autoriza|autorize)\b/,
    /\b(me diga|me avise|me confirme|diga qual|escolha (uma|qual))\b/,
    /\bqual (opção|delas|caminho|prefere)\b/,
    /\baguardo (sua |seu )?(resposta|ok|confirmação|decisão)\b/,
    /\b(shall i|should i|do you want|would you like|let me know|which option|please confirm)\b/,
  ];
  return ASKS.some((re) => re.test(tail));
}

/**
 * AVISO final quando o cap de verificações foi atingido e o done é aceito ASSIM
 * MESMO (o modelo fraco "sempre acha gap" — não viramos loop infinito). Entra como
 * `reanchor` no histórico p/ auditoria; NÃO altera a resposta final entregue.
 */
export function buildVerificationCapNote(max: number): string {
  return (
    `${SELF_CHECK_MARKER}: limite de ${max} passada(s) de auto-verificação atingido — ` +
    `a resposta foi aceita como final mesmo assim (anti-loop). Se ainda houver lacunas, ` +
    `o usuário pode pedir a continuação.`
  );
}

// F-SC — fonte ÚNICA do "fechou perguntando" (o `?` semântico, já sem decoração).
// `continuation.ts` não importa nada, então não há ciclo.
import { endsWithUserQuestion } from './continuation.js';

// EST-1124 — barramento do Maestro (opcional). Emissão ADITIVA.
import type { SignalCollector } from './maestro/bus.js';

/**
 * EST-1124 (MAESTRO-EMISSORES) — emite um SupervisorSignal ao barramento quando
 * o self-check decide intervir (re-âncora ou auto-verificação). ADITIVO: o probe
 * ainda é injetado no histórico normalmente — o freio DURO segue intacto.
 */
export function signalSelfCheck(
  bus: SignalCollector | undefined,
  checkKind: 'reanchor' | 'verify' | 'cap-reached',
  iteration?: number,
  attempt?: number,
  max?: number,
  ts?: number,
): void {
  if (!bus) return;
  bus.publish({
    origin: 'self-check',
    severity: 'info',
    ts: ts ?? Date.now(),
    payload: { checkKind, iteration, attempt, max },
  });
}
