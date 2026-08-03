// F-PROV-FIX — dono, dogfooding: "pq quando muda o provider dentro da sessão ele não
// fixa (persiste)?". Resposta do produto: escopo-de-sessão CONTINUA sendo o default
// (EST-0962/F-PROV não mudam — zero regressão); o que faltava era um ATO EXPLÍCITO
// ("/provider save") para o dono dizer "gostei, fixa isso" sem transformar toda
// troca exploratória num efeito colateral silencioso.
//
// Este módulo é a lógica PURA (sem I/O) de "o que persistir, dado o estado da
// sessão agora": só faz sentido sob backend LOCAL (BYO) — é o único backend onde
// `/provider` de fato TROCA o provider ativo (F-PROV); no broker, o provider Custom
// pareia com o slug e é resolvido pelo broker, sem "padrão" local a gravar (ADR não
// relaxado aqui — ver o comentário em `run.tsx` / `onSelectProvider`).
//
// O CALLER (run.tsx) injeta o estado corrente (via `SessionController`) + o default
// resolvido no BOOT (via `resolveLocalProviderConfig`, `model/local/config.ts`) e
// aplica o plano com `UserConfigStore.saveLocalProvider` — a ÚNICA escrita.

/** Estado observável da sessão + do boot, o bastante p/ decidir o que fixar. */
export interface SaveProviderInput {
  /** Backend efetivo da sessão (`meta.backend`). Só `local` tem "padrão" a fixar. */
  readonly backend: string | undefined;
  /** Provider ATIVO agora (`controller.provider` — undefined antes de qualquer troca). */
  readonly currentProvider: string | undefined;
  /** Slug do modelo ATIVO agora (`controller.model` — só setado sob `tier:'custom'`). */
  readonly currentModel: string | undefined;
  /** Provider resolvido no BOOT (flag > env > config > default catálogo). */
  readonly bootProvider: string | undefined;
  /** Modelo resolvido no BOOT (mesma precedência). */
  readonly bootModel: string | undefined;
}

/** O que fazer: `applicable:false` ⇒ nada a gravar (com o motivo em `reason`). */
export type SaveProviderPlan =
  | { readonly applicable: false; readonly reason: 'not-local' | 'no-provider' }
  | { readonly applicable: true; readonly provider: string; readonly model?: string };

/**
 * Decide o que persistir p/ o ato explícito "fixar como padrão". PURA/testável: sem
 * `UserConfigStore`, sem `SessionController` — só os valores já lidos pelo caller.
 *
 * Precedência do valor a gravar: o EFETIVO da sessão AGORA (`current*` — reflete uma
 * troca via `/provider`/`/model` nesta sessão) vence; na ausência (sessão ainda no
 * default do boot, sem nenhuma troca), cai no valor do BOOT (`boot*` — re-gravar o
 * mesmo default é idempotente e inofensivo, nunca some com uma preferência boa).
 */
export function planSaveProvider(input: SaveProviderInput): SaveProviderPlan {
  if (input.backend !== 'local') return { applicable: false, reason: 'not-local' };
  const provider = input.currentProvider ?? input.bootProvider;
  if (provider === undefined || provider.trim() === '') {
    return { applicable: false, reason: 'no-provider' };
  }
  const model = input.currentModel ?? input.bootModel;
  return {
    applicable: true,
    provider,
    ...(model !== undefined && model.trim() !== '' ? { model } : {}),
  };
}
