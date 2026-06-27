// EST-0962 · /provider — hook do seletor de PROVIDER (par do modelo Custom): estado do
// picker (abrir/navegar/confirmar/fechar) + carga da lista VIVA do broker. MESMA mecânica
// do `useModelPicker`: a App captura as teclas (↑↓/enter/esc) e chama estes métodos; a
// apresentação é pura.
//
// FONTE DA LISTA (ADR-0076): em vez do catálogo ESTÁTICO chumbado, o picker carrega na 1ª
// abertura os NOMES dos providers REALMENTE cadastrados no broker (`GET /v1/providers` via
// `ProvidersClient`) e os FUNDE com os metadados de display do seed (`buildProviderEntries`,
// função PURA). Broker fora / lista vazia / sem cliente ⇒ FALLBACK estático conhecido
// (`PROVIDERS`) + `usingFallback=true` (a UI mostra "não foi possível listar os
// cadastrados") — NUNCA lista vazia silenciosa.
//
// Confirmar NÃO faz I/O: devolve o NOME do provider; o chamador (App→run.tsx) o aplica no
// controller (`setProvider`), que pareia com o slug Custom corrente. HG-2/CLI-SEC-7: só o
// NOME (DADO de catálogo) atravessa — o broker resolve `(provider, model)` → credencial
// server-side. `ProvidersClient`/`parseProviders` já descartaram qualquer api_key_ref.

import { useCallback, useRef, useState } from 'react';
import type { ProvidersClient } from '@hiperplano/aluy-cli-core';
import { PROVIDERS, buildProviderEntries, type ProviderEntry } from '../../model/providers.js';

export interface UseProviderPickerArgs {
  /** Provider ATIVO da sessão (p/ marcar o item ● e pré-selecioná-lo). `undefined` =
   * nenhum setado ainda (o broker escolhe o default) ⇒ pré-seleciona o 1º. */
  readonly currentProvider?: string;
  /**
   * Cliente da lista de providers cadastrados (`GET /v1/providers`, MESMA credencial do
   * chat). A FONTE VIVA da lista (ADR-0076). Ausente ⇒ o picker usa o fallback estático
   * (`PROVIDERS`) — compat com testes/wiring antigos, degradação honesta.
   */
  readonly providersClient?: Pick<ProvidersClient, 'list'>;
}

export interface ProviderPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Entradas do catálogo de providers (lista VIVA do broker ou fallback estático). */
  readonly providers: readonly ProviderEntry[];
  /** Carregando a lista (1ª abertura, enquanto o broker responde). */
  readonly loading: boolean;
  /**
   * `true` quando a lista é o FALLBACK estático (broker fora / vazio / sem cliente) — a UI
   * mostra a nota "(não foi possível listar os cadastrados)". `false` quando veio do broker.
   * `null` antes de carregar (1ª abertura ainda não disparou).
   */
  readonly usingFallback: boolean | null;
  /** Abre o picker (1ª vez carrega a lista; pré-seleciona o provider ativo). */
  openPicker(): void;
  /** Fecha o picker (esc) sem trocar. */
  closePicker(): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /** Confirma o item selecionado: devolve o nome do provider (ou null se vazio). */
  confirm(): string | null;
}

/** Posição do provider corrente na lista (p/ pré-selecionar no item ativo). */
function indexOfCurrent(list: readonly ProviderEntry[], current: string | undefined): number {
  if (current === undefined) return 0;
  const i = list.findIndex((p) => p.name.toLowerCase() === current.toLowerCase());
  return i >= 0 ? i : 0;
}

export function useProviderPicker(args: UseProviderPickerArgs): ProviderPickerController {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<readonly ProviderEntry[]>(PROVIDERS);
  const [selected, setSelected] = useState(() => indexOfCurrent(PROVIDERS, args.currentProvider));
  const [loading, setLoading] = useState(false);
  const [usingFallback, setUsingFallback] = useState<boolean | null>(null);
  const loadedRef = useRef(false);

  const loadProviders = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    if (!args.providersClient) {
      // Sem cliente ⇒ fallback estático honesto (compat com wiring/testes antigos).
      setProviders(PROVIDERS);
      setUsingFallback(true);
      setSelected(indexOfCurrent(PROVIDERS, args.currentProvider));
      return;
    }
    setLoading(true);
    try {
      const live = await args.providersClient.list();
      // FUNDE a lista viva (name+adapter) com os metadados de display do seed. Lista viva
      // vazia ⇒ buildProviderEntries devolve o FALLBACK (PROVIDERS) — usingFallback=true.
      const entries = buildProviderEntries(live);
      const fellBack = live.length === 0;
      setProviders(entries);
      setUsingFallback(fellBack);
      setSelected(indexOfCurrent(entries, args.currentProvider));
    } catch {
      // HG-2: erro NEUTRO de broker (offline/401/transporte) ⇒ fallback estático, NUNCA
      // lista vazia. A UI mostra a nota honesta. NÃO distingue provider/credencial.
      setProviders(PROVIDERS);
      setUsingFallback(true);
      setSelected(indexOfCurrent(PROVIDERS, args.currentProvider));
    } finally {
      setLoading(false);
    }
  }, [args.providersClient, args.currentProvider]);

  const openPicker = useCallback(() => {
    // Reabrir re-ancora no provider ATIVO (consistente com o /model//theme); a lista já
    // carregada (estado de sessão) é mantida nas reaberturas.
    setSelected(indexOfCurrent(providers, args.currentProvider));
    setOpen(true);
    void loadProviders();
  }, [args.currentProvider, providers, loadProviders]);

  const closePicker = useCallback(() => {
    setOpen(false);
  }, []);

  const move = useCallback(
    (delta: number) => {
      setSelected((s) => {
        const max = Math.max(0, providers.length - 1);
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [providers.length],
  );

  const confirm = useCallback((): string | null => {
    const entry = providers[selected];
    setOpen(false);
    return entry ? entry.name : null;
  }, [providers, selected]);

  return {
    open,
    selected,
    providers,
    loading,
    usingFallback,
    openPicker,
    closePicker,
    move,
    confirm,
  };
}
