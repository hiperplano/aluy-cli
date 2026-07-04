// EST-0972 — resolução da RETOMADA de sessão (`--continue`/`--resume [<id>]`).
//
// Decide, ANTES de fiar a sessão, QUAL registro carregar (se algum), a partir do
// pedido de retomada e do `SessionStore`. Fail-safe: nada casa ⇒ sessão NOVA (sem
// crash, sem id forçado). Lógica de orquestração separada do render Ink (run.tsx)
// p/ ser testável sem TUI.

import type { SessionRecord, SessionStore, SessionSummary } from '../io/index.js';
import { formatResumeOffer } from './session-persist.js';

/** O pedido de retomada vindo do parser (`cli.ts`). */
export type ResumeRequest = { kind: 'continue' } | { kind: 'resume'; id?: string };

// ── EST-0972 (BUG Custom) — restaurar tier + slug Custom de uma sessão retomada ─────
//
// A persistência (session-store) guarda o `model` (slug) SÓ sob `tier:'custom'`. Ao
// retomar, precisamos restaurar TIER **e** MODEL juntos — senão `setTier('custom',
// undefined)` zera o slug e a próxima chamada manda `tier:custom` SEM model ⇒ 422.
//
// DEFESA p/ record LEGADO (salvo ANTES deste fix): `tier:'custom'` SEM `model`. NÃO
// pode mandar `tier:custom` sem model. O menos surpreendente: cair num tier CANÔNICO
// default (flux) com um aviso — a sessão volta funcional num modelo válido, em vez de
// 422 silencioso ou de empurrar o usuário p/ reabrir o input Custom sem contexto.

/** Tier canônico de fallback p/ um record Custom legado sem slug. Espelha DEFAULT_TIER. */
export const RESUME_CUSTOM_FALLBACK_TIER = 'aluy-flux';

/** O tier + slug efetivos a aplicar ao retomar, + um aviso opcional (legado). */
export interface ResumedModel {
  /** Tier a aplicar (`setTier`). Pode diferir do record (fallback do legado). */
  readonly tier: string;
  /** Slug Custom a aplicar — só sob `tier:'custom'`; `undefined` caso contrário. */
  readonly model?: string;
  /**
   * HUNT-PERSIST — provider Custom a aplicar (`setProvider`) — só sob `tier:'custom'`
   * COM slug; `undefined` caso contrário (tier canônico ou fallback de legado). Sem
   * isto, retomar uma sessão Custom perdia o provider escolhido (provider default → 422
   * quando o slug existe em vários providers).
   */
  readonly provider?: string;
  /** Aviso ao usuário se houve fallback (record Custom legado sem slug). `undefined` se ok. */
  readonly warning?: string;
}

/**
 * EST-0972 (BUG Custom) — resolve o `{ tier, model }` a APLICAR ao retomar `record`,
 * tratando o record LEGADO (`tier:'custom'` SEM `model`). PURO (sem efeito):
 *   - tier canônico               ⇒ `{ tier }` (sem model — nunca slug fora de Custom);
 *   - `tier:'custom'` COM model    ⇒ `{ tier:'custom', model }` (o slug volta);
 *   - `tier:'custom'` SEM model    ⇒ FALLBACK p/ o tier canônico default + `warning`
 *                                    (NUNCA devolve `tier:custom` sem model);
 *   - tier vazio                   ⇒ `{ tier:'' }` (o caller decide; sem model).
 *
 * `fallbackTier` é injetável (default `RESUME_CUSTOM_FALLBACK_TIER`) p/ casar com o
 * DEFAULT_TIER do wiring sem acoplar este módulo a ele.
 */
export function resolveResumedModel(
  record: Pick<SessionRecord, 'tier' | 'model' | 'provider'>,
  fallbackTier: string = RESUME_CUSTOM_FALLBACK_TIER,
): ResumedModel {
  const tier = record.tier.trim();
  if (tier !== 'custom') {
    // tier canônico (ou vazio): nunca carrega slug/provider Custom.
    return { tier };
  }
  const model = record.model?.trim();
  if (model !== undefined && model !== '') {
    // HUNT-PERSIST — o provider acompanha o slug (só em par; provider sem slug é
    // descartado pelo store, então aqui já vem coerente). `undefined` ⇒ broker default.
    const provider = record.provider?.trim();
    return {
      tier: 'custom',
      model,
      ...(provider !== undefined && provider !== '' ? { provider } : {}),
    };
  }
  // LEGADO: Custom sem slug ⇒ cai no canônico default (não manda custom-sem-model).
  return {
    tier: fallbackTier,
    warning:
      'sessão Custom anterior sem o modelo salvo — retomada no tier ' +
      `${fallbackTier}. Use /model p/ reescolher o modelo Custom.`,
  };
}

/**
 * EST-0962 (BUG Custom — PREFERÊNCIA) — resolve o `{ tier, model }` a aplicar numa
 * sessão NOVA (não-resume) a partir da PREFERÊNCIA salva (`~/.aluy/config.json`). O
 * problema: a pref guardava só o `tier`; com `tier:'custom'` SEM slug, a sessão nova
 * caía em "custom sem modelo" ⇒ re-input/422. Agora a pref carrega o `model` junto
 * (quando Custom), e esta função aplica a MESMA decisão de legado do `resolveResumedModel`:
 *   - tier canônico            ⇒ `{ tier }` (sem slug);
 *   - `tier:'custom'` COM slug  ⇒ `{ tier:'custom', model }` (não re-inputa);
 *   - `tier:'custom'` SEM slug  ⇒ FALLBACK p/ o canônico default + `warning` (pref
 *                                 LEGADA, gravada antes deste fix) — NUNCA custom-sem-model.
 *
 * Delega ao `resolveResumedModel` (mesma natureza `{tier, model}`) p/ NÃO duplicar a
 * regra do legado: resume e pref convergem na MESMA decisão (DoD #5).
 */
export function resolvePreferredModel(
  pref: { readonly tier?: string; readonly model?: string; readonly provider?: string },
  fallbackTier: string = RESUME_CUSTOM_FALLBACK_TIER,
): ResumedModel {
  return resolveResumedModel(
    {
      tier: pref.tier ?? '',
      ...(pref.model !== undefined ? { model: pref.model } : {}),
      ...(pref.provider !== undefined ? { provider: pref.provider } : {}),
    },
    fallbackTier,
  );
}

/**
 * O que a retomada resolveu:
 *  - `none`     : sem retomada (sessão nova) — pedido ausente ou nada casou.
 *  - `resumed`  : carregou um `record` (a transcrição volta; o id é REUSADO p/ a
 *                 sessão continuar gravando no MESMO arquivo).
 *  - `pick`     : `--resume` sem id e HÁ sessões ⇒ apresentar a lista p/ escolher.
 *                 O caller (TUI) mostra `choices` e, com a escolha, recarrega.
 */
export type ResumeResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'resumed'; readonly record: SessionRecord }
  | { readonly kind: 'pick'; readonly choices: readonly SessionSummary[] }
  // F110 — `--resume <id>` pedido EXPLICITAMENTE mas o id não existe/corrompeu. Distinto
  // de `none` (nada pedido): o caller AVISA "sessão <id> não encontrada — iniciando nova"
  // em vez de silenciosamente abrir uma sessão em branco (intenção do usuário não-honrada).
  | { readonly kind: 'not-found'; readonly requestedId: string };

/**
 * Resolve a retomada a partir do pedido e do store. PURO quanto a efeito (só lê o
 * store, não monta sessão). Fail-safe em todo ramo:
 *   - `--continue`         ⇒ a ÚLTIMA sessão deste `cwd`; nenhuma ⇒ `none` (nova).
 *   - `--resume <id>`      ⇒ aquela sessão; ausente/corrompida ⇒ `none` (nova).
 *   - `--resume` (sem id)  ⇒ `pick` com a lista (se houver); lista vazia ⇒ `none`.
 *   - sem pedido           ⇒ `none`.
 */
export function resolveResume(
  request: ResumeRequest | undefined,
  store: SessionStore,
  cwd: string,
): ResumeResolution {
  if (request === undefined) return { kind: 'none' };

  if (request.kind === 'continue') {
    // F187 — `--continue` retoma a última sessão COM turno do usuário deste cwd. Se a
    // mais recente é SÓ do agente (install/conserto), pula p/ a última que o usuário
    // de fato iniciou (varre a lista, já ordenada por updatedAt). Nenhuma ⇒ `none`.
    const record = store.latestForCwd(cwd);
    if (record && countUserTurns(record.blocks) > 0) return { kind: 'resumed', record };
    for (const s of store.list()) {
      if (s.cwd !== cwd || s.title === undefined) continue;
      const rec = store.load(s.id);
      if (rec) return { kind: 'resumed', record: rec };
    }
    return { kind: 'none' };
  }

  // request.kind === 'resume'
  if (request.id !== undefined && request.id.trim() !== '') {
    const id = request.id.trim();
    const record = store.load(id);
    if (record) return { kind: 'resumed', record };
    // F169 (pedido do dono) — não achou por ID: tenta pelo NOME da sessão (`/rename`),
    // case-insensitive. `aluy --resume FLUIDER-ORCHESTRATOR` funciona como o id.
    //   · 1 sessão com o nome ⇒ retoma;
    //   · 2+ com o MESMO nome ⇒ `pick` FILTRADO nelas (ambiguidade é do usuário decidir);
    //   · nenhuma ⇒ `not-found` (aviso honesto de sempre, F110).
    const wanted = id.toLowerCase();
    const byName = store.list().filter((s) => (s.label ?? '').trim().toLowerCase() === wanted);
    if (byName.length === 1) {
      const rec = store.load(byName[0]!.id);
      if (rec) return { kind: 'resumed', record: rec };
    }
    if (byName.length > 1) return { kind: 'pick', choices: byName };
    // F110 — id EXPLÍCITO mas não achou ⇒ `not-found` (NÃO `none`): o boot avisa em vez
    // de cair calado numa sessão nova (e, no TTY, evita a auto-oferta de uma sessão ALHEIA).
    return { kind: 'not-found', requestedId: id };
  }
  // sem id: lista p/ escolher (se houver alguma sessão). F187 — oculta conversas SÓ do
  // agente (sem `title` = sem turno do usuário), mantendo as rotuladas (rename explícito).
  // Ficam gravadas e recuperáveis por id; só não poluem a lista.
  const choices = store.list().filter((s) => s.title !== undefined || s.label !== undefined);
  return choices.length > 0 ? { kind: 'pick', choices } : { kind: 'none' };
}

// ── EST-0972 (BUG 2) — AUTO-OFERTA de retomar no boot (sem flag explícita) ──────
//
// O auto-save JÁ grava por-turno (`~/.aluy/sessions/<id>.json`), mas reabrir o
// `aluy` SEM `--resume`/`--continue` começava uma sessão NOVA — a conversa voltava
// "do zero" apesar de estar no disco. A correção: quando NÃO há pedido explícito de
// sessão (nem `--new`), e existe uma sessão RECENTE para o MESMO cwd, o boot OFERECE
// retomá-la (`↻ retomar a conversa anterior?`). É a UX MENOS surpreendente — não
// auto-cola um histórico sem o usuário pedir, mas também não o joga fora calado.

/** Janela de "recente" default: só ofertamos sessões tocadas nas últimas 24h. */
export const DEFAULT_AUTORESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * ADR-0150 (balde b) — TETO-TETO de sanidade (não anti-runaway) da janela de
 * auto-oferta: acima de 7 dias, a "última conversa" já não é mais "recente" — não
 * faz sentido oferecer retomar algo tão velho sem pedido explícito (`--resume`).
 */
export const MAX_AUTORESUME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

/**
 * ADR-0150 — resolve a janela EFETIVA de auto-oferta a partir de
 * `config.session.autoResumeWindowMs`, clampada em `[1, MAX_AUTORESUME_WINDOW_MS]`.
 * Ausente/inválido ⇒ `DEFAULT_AUTORESUME_WINDOW_MS`. PURO — sem I/O.
 */
export function resolveAutoResumeWindowMs(config?: number | undefined): number {
  if (config !== undefined && Number.isFinite(config) && config > 0) {
    return Math.min(MAX_AUTORESUME_WINDOW_MS, Math.floor(config));
  }
  return DEFAULT_AUTORESUME_WINDOW_MS;
}

/**
 * O que a auto-oferta resolveu (boot SEM flag de sessão):
 *  - `explicit` : veio `--resume`/`--continue`/`--new` ⇒ NÃO auto-ofertar (o caller
 *                 segue o caminho explícito de `resolveResume`/sessão-nova).
 *  - `offer`    : há uma sessão RECENTE do MESMO cwd ⇒ oferecer retomar. Carrega o
 *                 `record` (p/ restaurar se o usuário aceitar) + metadados p/ o prompt.
 *  - `none`     : sem sessão recente do cwd ⇒ sessão nova silenciosa (fail-safe).
 */
export type AutoResumeResolution =
  | { readonly kind: 'explicit' }
  | {
      readonly kind: 'offer';
      readonly record: SessionRecord;
      readonly ageMs: number;
      readonly messageCount: number;
    }
  | { readonly kind: 'none' };

/**
 * Conta as MENSAGENS da conversa (`you`/`aluy`) numa transcrição — o nº exibido no
 * prompt de oferta (`N mensagens`). Ignora blocos de UI auxiliares (nota/tool/erro):
 * o usuário pensa em "mensagens trocadas", não em blocos de render.
 */
export function countMessages(blocks: SessionRecord['blocks']): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'you' || b.kind === 'aluy') n += 1;
  }
  return n;
}

/**
 * F187 — conta os TURNOS DO USUÁRIO (`you`) numa transcrição. Uma conversa SÓ do
 * agente (ex.: a instalação/conserto de sidecars via `/doctor fix` ou o boot de turbo:
 * notas + turnos `aluy` + tools, SEM nenhum `you`) NÃO é algo que o usuário iniciou —
 * não deve ser oferecida no boot ("retomar a última sessão?") nem listada no `--resume`,
 * senão o histórico fica poluído por conversas de sistema. `0` ⇒ sessão sem interação
 * do usuário. (A sessão segue GRAVADA e recuperável por id explícito — só é OCULTA.)
 */
export function countUserTurns(blocks: SessionRecord['blocks']): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === 'you') n += 1;
  }
  return n;
}

/**
 * Decide se o boot deve OFERECER retomar a sessão anterior do cwd. PURO (só lê o
 * store). Regras (fail-safe em todo ramo):
 *   - QUALQUER flag de sessão (`--continue`/`--resume`/`--new`) ⇒ `explicit` (o
 *     caminho explícito do usuário manda; nunca sobrepomos com uma oferta).
 *   - senão: a ÚLTIMA sessão deste `cwd`; se existe E foi tocada dentro da janela
 *     (`windowMs`) E tem ao menos 1 mensagem ⇒ `offer`. Caso contrário ⇒ `none`.
 *   - cwd diferente / sem sessão / sessão velha / vazia ⇒ `none` (nova silenciosa).
 *
 * `fresh` é o `--new`. `windowMs` evita ofertar uma conversa esquecida há dias
 * (surpresa pior que começar do zero); `now` é injetável p/ teste determinístico.
 */
export function resolveAutoResume(
  request: ResumeRequest | undefined,
  fresh: boolean,
  store: SessionStore,
  cwd: string,
  now: number = Date.now(),
  windowMs: number = DEFAULT_AUTORESUME_WINDOW_MS,
): AutoResumeResolution {
  // Pedido explícito (incl. `--new`) tem precedência ABSOLUTA: nunca auto-ofertamos.
  if (request !== undefined || fresh) return { kind: 'explicit' };

  const record = store.latestForCwd(cwd);
  if (!record) return { kind: 'none' }; // nenhuma sessão deste cwd ⇒ nova silenciosa.

  const ageMs = Math.max(0, now - record.updatedAt);
  if (ageMs > windowMs) return { kind: 'none' }; // velha demais p/ ofertar sem surpresa.

  const messageCount = countMessages(record.blocks);
  if (messageCount === 0) return { kind: 'none' }; // sessão vazia ⇒ nada a retomar.
  // F187 — não oferece conversa SÓ do agente (install/conserto de sidecars: notas +
  // turnos `aluy` + tools, sem `you`). O usuário não a iniciou ⇒ ofertá-la no boot
  // ("retomar a última sessão?") é ruído. Fica gravada/recuperável por id.
  if (countUserTurns(record.blocks) === 0) return { kind: 'none' };

  return { kind: 'offer', record, ageMs, messageCount };
}

/**
 * EST-0972 (BUG 2) — ORQUESTRA a retomada do boot num único ponto testável (sem Ink):
 * combina o caminho EXPLÍCITO (`resolveResume` p/ `--continue`/`--resume`) com a
 * AUTO-OFERTA (`resolveAutoResume` + prompt sim/não). Devolve a `ResumeResolution`
 * FINAL que o `runSession` aplica (restaura blocos + semeia contexto).
 *
 * Fluxo:
 *   1. `resolveResume` resolve o pedido explícito. Se ele já decidiu (`resumed`/`pick`)
 *      OU se não há TTY (sem prompt possível) ⇒ devolve isso direto.
 *   2. Senão (`none` + TTY + sem flag/`--new`): `resolveAutoResume`. Se houver uma
 *      sessão recente do cwd ⇒ PERGUNTA (`promptYesNo`). Sim ⇒ `resumed`; não ⇒ `none`.
 *
 * Fail-safe: qualquer erro no prompt vira `none` (sessão nova) — nunca derruba o boot.
 * `restoreFrom` (no caller) já restaura SÓ blocos estáticos (sem streaming/running).
 */
export async function decideBootResume(args: {
  readonly request: ResumeRequest | undefined;
  readonly fresh: boolean;
  readonly isTty: boolean;
  readonly store: SessionStore;
  readonly cwd: string;
  readonly promptYesNo: (prompt: string) => Promise<boolean>;
  readonly now?: number;
  readonly windowMs?: number;
}): Promise<ResumeResolution> {
  const explicit = resolveResume(args.request, args.store, args.cwd);
  // Pedido explícito já resolvido, ou sem TTY ⇒ não há auto-oferta a fazer.
  if (explicit.kind !== 'none' || !args.isTty) return explicit;

  const auto = resolveAutoResume(
    args.request,
    args.fresh,
    args.store,
    args.cwd,
    args.now ?? Date.now(),
    args.windowMs ?? DEFAULT_AUTORESUME_WINDOW_MS,
  );
  if (auto.kind !== 'offer') return { kind: 'none' };

  let accept = false;
  try {
    accept = await args.promptYesNo(formatResumeOffer(auto.messageCount, auto.ageMs));
  } catch {
    accept = false; // fail-safe: prompt falhou ⇒ sessão nova.
  }
  return accept ? { kind: 'resumed', record: auto.record } : { kind: 'none' };
}
