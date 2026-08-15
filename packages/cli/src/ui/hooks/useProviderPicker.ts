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
// F-PROV — sob backend LOCAL (BYO, o caminho PRINCIPAL do produto), a lista acima NÃO faz
// sentido: o broker é uma fonte alheia à sessão local. Achado em dogfooding: o dono via a
// lista ESTÁTICA do broker (openrouter/deepseek) em vez dos providers que ELE de fato
// configurou. Quando `args.localCatalog` está presente, o picker IGNORA `providersClient`
// por completo e lista o catálogo LOCAL (built-ins do core + `~/.aluy/config.json`,
// `loadLocalProviderCatalog`, ADR-0118) — mais um item sentinela "+ adicionar provider
// custom" (ver `ADD_CUSTOM_PROVIDER_SENTINEL`) que abre um mini-formulário de 3 campos
// (id/baseURL/modelo default) DENTRO deste mesmo hook (`addCustomStep`/`addCustomDraft`/
// `startAddCustom`/`typeAddCustom`/`backspaceAddCustom`/`confirmAddCustom`/
// `cancelAddCustom`) — reusa o MESMO picker em vez de inventar um 2º componente.
//
// Confirmar NÃO faz I/O: devolve o NOME do provider; o chamador (App→run.tsx) o aplica no
// controller (`setProvider`/`setLocalProvider`), que pareia com o slug Custom corrente.
// HG-2/CLI-SEC-7: só o NOME (DADO de catálogo) atravessa — nunca credencial. O
// formulário "+ adicionar" só coleta id/baseURL/modelo (DADO público — CLI-SEC-7); a
// credencial continua fora daqui, resolvida via `aluy login --provider <id>`.

import { useCallback, useRef, useState } from 'react';
import type { ProvidersClient, LocalProviderEntry } from '@hiperplano/aluy-cli-core';
import {
  PROVIDERS,
  buildProviderEntries,
  buildLocalProviderEntries,
  type ProviderEntry,
} from '../../model/providers.js';

/** Valor sentinela do item "+ adicionar provider custom" — nunca um `id` real de
 * catálogo (o prefixo/sufixo duplo-underscore é convenção deste repo p/ sentinelas). */
export const ADD_CUSTOM_PROVIDER_SENTINEL = '__add_custom_provider__';

/** Passo corrente do formulário "+ adicionar provider custom". `null` fora do fluxo. */
export type AddCustomProviderStep = 'id' | 'baseUrl' | 'model' | null;

/** Rascunho do formulário "+ adicionar provider custom" (campo corrente = `addCustomStep`). */
export interface AddCustomProviderDraft {
  readonly id: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** DADO pronto p/ persistir (o chamador injeta `wireFormat:'openai-compat'` — BYO é
 * sempre OpenAI-compatible por definição do produto — e chama `addLocalProviderOverride`). */
export interface AddCustomProviderInput {
  readonly id: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
}

const EMPTY_DRAFT: AddCustomProviderDraft = { id: '', baseUrl: '', model: '' };

export interface UseProviderPickerArgs {
  /** Provider ATIVO da sessão (p/ marcar o item ● e pré-selecioná-lo). `undefined` =
   * nenhum setado ainda (o broker escolhe o default) ⇒ pré-seleciona o 1º. */
  readonly currentProvider?: string;
  /**
   * Cliente da lista de providers cadastrados (`GET /v1/providers`, MESMA credencial do
   * chat). A FONTE VIVA da lista (ADR-0076). Ausente ⇒ o picker usa o fallback estático
   * (`PROVIDERS`) — compat com testes/wiring antigos, degradação honesta. IGNORADO por
   * completo quando `localCatalog` (abaixo) está presente.
   */
  readonly providersClient?: Pick<ProvidersClient, 'list'>;
  /**
   * F-PROV (ADR-0118) — sob backend LOCAL, a FONTE de verdade da lista é o catálogo
   * local do usuário, NUNCA o broker. Uma FUNÇÃO (não um array estático) porque o
   * catálogo pode ter mudado NESTA sessão (um "+ adicionar" recém-confirmado) —
   * reconsultada a CADA abertura do picker (mesma disciplina do `useLocalModelPicker`).
   * Presente ⇒ o picker ignora `providersClient` inteiramente (fontes mutuamente
   * exclusivas — nunca mistura BYO com o catálogo do broker).
   */
  readonly localCatalog?: () => readonly LocalProviderEntry[];
}

export interface ProviderPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Entradas do catálogo de providers (lista VIVA do broker, catálogo LOCAL, ou fallback). */
  readonly providers: readonly ProviderEntry[];
  /** Carregando a lista (1ª abertura, enquanto o broker responde). Sempre `false` sob
   * catálogo LOCAL (leitura síncrona de disco, sem rede). */
  readonly loading: boolean;
  /**
   * `true` quando a lista é o FALLBACK estático (broker fora / vazio / sem cliente) — a UI
   * mostra a nota "(não foi possível listar os cadastrados)". `false` quando veio do broker
   * OU do catálogo local (que NUNCA "cai" — sempre tem ao menos os built-ins embutidos).
   * `null` antes de carregar (1ª abertura ainda não disparou).
   */
  readonly usingFallback: boolean | null;
  /** Abre o picker (1ª vez carrega a lista; pré-seleciona o provider ativo). */
  openPicker(): void;
  /** Fecha o picker (esc) sem trocar. */
  closePicker(): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /**
   * Confirma o item selecionado: devolve o nome do provider (ou `null` se vazio). Pode
   * devolver `ADD_CUSTOM_PROVIDER_SENTINEL` — o chamador (App) deve checar isso ANTES de
   * tratar como um nome de provider real e chamar `startAddCustom()` em vez de aplicar.
   */
  confirm(): string | null;
  /** Passo corrente do formulário "+ adicionar provider custom" (`null` fora do fluxo). */
  readonly addCustomStep: AddCustomProviderStep;
  /** Rascunho em digitação do formulário (campo corrente = `addCustomStep`). */
  readonly addCustomDraft: AddCustomProviderDraft;
  /** Inicia o formulário (a partir do item sentinela da lista). */
  startAddCustom(): void;
  /** Digita um caractere no campo corrente do formulário. No-op fora do fluxo. */
  typeAddCustom(ch: string): void;
  /** Apaga um caractere (backspace) do campo corrente. No-op fora do fluxo. */
  backspaceAddCustom(): void;
  /**
   * Confirma o campo corrente: `id`/`baseUrl` exigem texto não-vazio (senão no-op —
   * o Enter não avança um campo obrigatório vazio); `model` aceita vazio (default =
   * o `id`, mesma UX do `aluy onboard`). No ÚLTIMO campo, finaliza e devolve o input
   * pronto p/ persistir; nos demais, avança o passo e devolve `null`.
   */
  confirmAddCustom(): AddCustomProviderInput | null;
  /** Cancela o formulário (esc) e volta pra lista, sem persistir nada. */
  cancelAddCustom(): void;
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

  const [addCustomStep, setAddCustomStep] = useState<AddCustomProviderStep>(null);
  const [addCustomDraft, setAddCustomDraft] = useState<AddCustomProviderDraft>(EMPTY_DRAFT);

  const loadLocalProviders = useCallback((): readonly ProviderEntry[] => {
    const entries = buildLocalProviderEntries(args.localCatalog?.() ?? []);
    return [
      ...entries,
      {
        name: ADD_CUSTOM_PROVIDER_SENTINEL,
        label: '+ adicionar provider custom',
        summary: 'cadastra um provider OpenAI-compatível novo (id + baseURL + modelo)',
      },
    ];
  }, [args.localCatalog]);

  const loadProviders = useCallback(async () => {
    // F-PROV — catálogo LOCAL: RE-LÊ a CADA chamada (nunca cacheia — um "+ adicionar"
    // confirmado nesta sessão precisa aparecer na PRÓXIMA abertura). Síncrono (disco),
    // sem `loading`/rede — ignora `providersClient` por completo.
    if (args.localCatalog) {
      const entries = loadLocalProviders();
      setProviders(entries);
      setUsingFallback(false);
      setSelected(indexOfCurrent(entries, args.currentProvider));
      return;
    }
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
  }, [args.providersClient, args.currentProvider, args.localCatalog, loadLocalProviders]);

  const openPicker = useCallback(() => {
    // Reabrir re-ancora no provider ATIVO (consistente com o /model//theme); a lista já
    // carregada (estado de sessão) é mantida nas reaberturas (exceto sob catálogo LOCAL,
    // que RE-LÊ sempre — ver `loadProviders`).
    setSelected(indexOfCurrent(providers, args.currentProvider));
    setOpen(true);
    setAddCustomStep(null);
    setAddCustomDraft(EMPTY_DRAFT);
    void loadProviders();
  }, [args.currentProvider, providers, loadProviders]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setAddCustomStep(null);
    setAddCustomDraft(EMPTY_DRAFT);
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
    // F-PROV — o item sentinela "+ adicionar" NÃO é uma escolha final: a App (ao ver
    // este nome de volta) chama `startAddCustom()` em seguida, reusando o MESMO picker
    // pro formulário (`open` continua controlando o render em App.tsx). Fechar aqui
    // incondicionalmente deixava `startAddCustom()` armar o passo 'id' com `open=false`
    // — o <ProviderPicker> nunca chegava a renderizar o formulário, e o enter no item
    // "+ adicionar" virava um no-op silencioso (bug relatado: "clico e não acontece
    // nada"). Só fecha de fato quando a escolha é um provider REAL.
    if (entry?.name !== ADD_CUSTOM_PROVIDER_SENTINEL) {
      setOpen(false);
    }
    return entry ? entry.name : null;
  }, [providers, selected]);

  const startAddCustom = useCallback(() => {
    setAddCustomDraft(EMPTY_DRAFT);
    setAddCustomStep('id');
  }, []);

  const typeAddCustom = useCallback(
    (ch: string) => {
      if (addCustomStep === null) return;
      setAddCustomDraft((d) => ({ ...d, [addCustomStep]: d[addCustomStep] + ch }));
    },
    [addCustomStep],
  );

  const backspaceAddCustom = useCallback(() => {
    if (addCustomStep === null) return;
    setAddCustomDraft((d) => ({ ...d, [addCustomStep]: d[addCustomStep].slice(0, -1) }));
  }, [addCustomStep]);

  const confirmAddCustom = useCallback((): AddCustomProviderInput | null => {
    if (addCustomStep === null) return null;
    if (addCustomStep === 'id') {
      const id = addCustomDraft.id.trim();
      if (id === '') return null; // campo obrigatório — Enter não avança vazio.
      setAddCustomStep('baseUrl');
      return null;
    }
    if (addCustomStep === 'baseUrl') {
      const baseUrl = addCustomDraft.baseUrl.trim();
      if (baseUrl === '') return null; // campo obrigatório — Enter não avança vazio.
      setAddCustomStep('model');
      return null;
    }
    // último campo ('model') — aceita vazio: default = o `id` (mesma UX do onboard).
    const id = addCustomDraft.id.trim();
    const baseUrl = addCustomDraft.baseUrl.trim();
    const model = addCustomDraft.model.trim();
    setAddCustomStep(null);
    setAddCustomDraft(EMPTY_DRAFT);
    setOpen(false);
    return { id, baseUrl, defaultModel: model !== '' ? model : id };
  }, [addCustomStep, addCustomDraft]);

  const cancelAddCustom = useCallback(() => {
    setAddCustomStep(null);
    setAddCustomDraft(EMPTY_DRAFT);
  }, []);

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
    addCustomStep,
    addCustomDraft,
    startAddCustom,
    typeAddCustom,
    backspaceAddCustom,
    confirmAddCustom,
    cancelAddCustom,
  };
}
