// EST-0962 — hook do seletor de modelo (`/model`): estado do picker + carga do
// catálogo (broker) com FALLBACK, + a via CUSTOM (ADR-0030 §3 / ADR-0065).
//
// Mesma MECÂNICA do `useFilePicker` (EST-0957): abrir/navegar(↑↓)/confirmar(enter)/
// fechar(esc), apresentação pura (a App captura teclas e chama os métodos). A
// DIFERENÇA é a fonte: a lista de TIERS vem do CATÁLOGO do broker
// (`GET /v1/tiers/catalog`, a forma SANCIONADA de mostrar nome de modelo por tier —
// ADR-0030 §3), carregada na 1ª abertura. Falha do broker (offline/sem scope) ⇒
// FALLBACK de tiers conhecidos + um aviso NEUTRO (HG-2: "broker", nunca o provider).
//
// CUSTOM (ADR-0030 §3 / ADR-0065, warn-but-allow): além dos tiers, o picker tem uma
// linha CUSTOM (a última). Ao confirmá-la, abre o modo CUSTOM. Aqui mora a evolução
// EST-0962 (browser): o modo Custom não é mais SÓ autocomplete-por-digitação — é um
// BROWSER NAVEGÁVEL da lista DEDICADA (`GET /v1/models/custom`, os ~339 modelos):
//   · digitar FILTRA a lista (id + name + family, substring case-insensitive);
//   · ↑↓ NAVEGAM a lista filtrada (janela com scroll — não cabe tudo na tela);
//   · `t` ALTERNA o filtro "só com tools" (`supportsTools===true`) — evita escolher
//     um modelo que falha em ferramentas (o caso do playwright);
//   · enter na linha REALÇADA seleciona aquele `id`; enter SEM linha realçada (lista
//     vazia / nada filtrado) cai no TEXTO-LIVRE do que foi digitado (warn-but-allow).
// Cada linha mostra `id`, `family`, `context` e um BADGE de tools (✓/—/neutro). A
// digitação continua sendo a base do autocomplete (não regride #88): `customSuggestions`
// segue derivando do mesmo filtro. Selecionar um modelo com `supportsTools===false`
// dispara um AVISO curto (warn-but-allow: avisa mas DEIXA usar — ADR-0030 §4).
//
// DEGRADAÇÃO: lista Custom 401/fora ⇒ o browser fica VAZIO e o modo Custom cai no
// texto-livre puro (o usuário digita/cola o slug à mão), SEM sugestão e SEM aviso de
// "fora da lista" (não dá p/ saber). NÃO derruba os tiers (fonte separada).
//
// Confirmar um TIER NÃO faz I/O: devolve a chave do tier. Confirmar no Custom devolve
// `{ tier:'custom', model:<slug>, supportsTools? }`; o chamador (App) o aplica no
// controller (`setTier('custom', slug)`). HG-2 intocado: o slug é a CHAVE/nome do
// modelo, NUNCA credencial — o broker revalida e resolve a credencial server-side.

import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  CustomModel,
  CustomModelClient,
  TierCatalogClient,
  TierCatalogEntry,
  EffortOption,
  EffortChoice,
} from '@aluy/cli-core';
import {
  effortOptions,
  clampEffortIndex,
  effortChoiceAt,
  effortChoiceFromCustom,
  validateCustomEffort,
} from '@aluy/cli-core';
import { FALLBACK_TIERS } from '../../model/catalog.js';

/** Chave do tier Custom (ADR-0030 §3) — a ÚNICA via que carrega `model`. */
export const CUSTOM_TIER = 'custom';

/** Janela visível do browser Custom (linhas mostradas de cada vez). Densa, sem
 * roubar a tela inteira (#95): a lista tem ~339 itens; mostramos uma fatia + scroll. */
export const BROWSER_WINDOW = 10;

/**
 * Uma linha do BROWSER Custom já preparada p/ render (apresentação pura). Carrega o
 * `model` cru (p/ o load-bearing `id` e os campos de exibição) + se é a linha
 * REALÇADA. A UI não precisa recalcular nada — só desenhar.
 */
export interface CustomBrowseRow {
  /** O modelo (id/name/family/context/supportsTools) — `id` é o que se envia. */
  readonly model: CustomModel;
  /** É a linha atualmente REALÇADA (navegada por ↑↓)? */
  readonly highlighted: boolean;
}

/**
 * Resultado da confirmação do picker:
 *  - `{ kind:'tier', key }` — um tier canônico do catálogo/fallback (sem `model`).
 *  - `{ kind:'custom', model, supportsTools? }` — a via Custom com o slug escolhido
 *    (de uma linha do browser OU texto-livre). `supportsTools` acompanha SÓ quando
 *    veio de uma linha conhecida do browser (p/ o aviso warn-but-allow); ausente no
 *    texto-livre (não dá p/ saber).
 *  - `null` — nada a aplicar (lista vazia / input vazio sem linha realçada).
 */
export type ModelPickerChoice =
  | { readonly kind: 'tier'; readonly key: string }
  | { readonly kind: 'custom'; readonly model: string; readonly supportsTools?: boolean };

/**
 * EST-1117 — a escolha CONJUGADA do trio provider+model+effort, devolvida na confirmação
 * FINAL do fluxo `/model` (após o passo de effort). Carrega a parte de MODELO (`model`, o
 * mesmo `ModelPickerChoice` de antes — tier OU custom-slug) + a parte de EFFORT (`effort`,
 * `EffortChoice`: `keep` = não muda, ou `set` com o valor passthrough). O provider do modo
 * Custom segue setado pelo `/provider` (ortogonal, pareia com o slug) — o trio aqui é
 * model+effort; o provider do Custom é aplicado em par no chamador (App→run.tsx). HG-2/
 * CLI-SEC-7: tudo DADO público (tier/slug/effort), nunca credencial.
 */
export interface ConjugatedChoice {
  readonly model: ModelPickerChoice;
  readonly effort: EffortChoice;
}

export interface UseModelPickerArgs {
  /** Cliente do catálogo de TIERS (broker, mesma credencial do chat) — Flui/Granito/… */
  readonly catalog: Pick<TierCatalogClient, 'list'>;
  /**
   * EST-0962 — cliente da lista de modelos CUSTOM (`GET /v1/models/custom`, MESMA
   * credencial do chat). A FONTE DEDICADA do browser/autocomplete do modo Custom (os
   * ~339), SEPARADA do catálogo de tiers. Quando ausente, o Custom degrada p/
   * texto-livre puro (sem browser/sugestão/aviso) — compat com testes/wiring antigos.
   */
  readonly customModels?: Pick<CustomModelClient, 'list'>;
  /** Tier corrente da sessão (p/ marcar o item ativo e pré-selecioná-lo). */
  readonly currentTier: string;
  /**
   * EST-1117 — o `reasoning_effort` corrente da sessão (p/ marcar o ● no passo de effort).
   * `undefined` ⇒ default do provider (o item "manter" preserva esse default). DADO público.
   */
  readonly currentEffort?: string;
}

export interface ModelPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Índice selecionado (navegado por ↑↓). `tiers.length` = a linha CUSTOM. */
  readonly selected: number;
  /** Entradas correntes (catálogo do broker ou fallback) — SEM a linha Custom. */
  readonly tiers: readonly TierCatalogEntry[];
  /** Carregando o catálogo (1ª abertura, enquanto o broker responde). */
  readonly loading: boolean;
  /**
   * `true` quando a lista é o FALLBACK (broker indisponível) — a UI mostra o aviso
   * NEUTRO. `false` quando veio do catálogo do broker. `null` antes de carregar.
   */
  readonly usingFallback: boolean | null;
  // ── via CUSTOM (ADR-0030 §3) ───────────────────────────────────────────────
  /** A linha CUSTOM está SELECIONADA (índice = `tiers.length`)? */
  readonly customSelected: boolean;
  /** O modo CUSTOM (browser + input de texto) está aberto? */
  readonly customInputOpen: boolean;
  /** O texto digitado até agora (FILTRA o browser; é o slug no texto-livre). */
  readonly customInput: string;
  /**
   * Sugestões de autocomplete p/ o slug digitado — itens da lista CUSTOM
   * (`GET /v1/models/custom`) cujo `id`/`name`/`family` casa o texto. Cada string é
   * uma LINHA de exibição: o `id` (o slug que se envia) + dica `name`/`family`. VAZIO
   * se a lista não carregou (degrada) ou se nada casa. NUNCA contém provider/credencial.
   * (Mantido p/ compat com o autocomplete #88; o browser usa `customRows`.)
   */
  readonly customSuggestions: readonly string[];
  /**
   * `true` quando a lista CUSTOM CARREGOU e o slug digitado NÃO bate (exato) nenhum
   * `id` da lista ⇒ a UI mostra o aviso warn-but-allow ("⚠ fora da lista"). SEMPRE
   * `false` quando a lista não carregou (não inventa warning) ou input vazio.
   */
  readonly customWarnOutOfCatalog: boolean;
  // ── BROWSER Custom (EST-0962) ──────────────────────────────────────────────
  /** A lista CUSTOM carregou (não-vazia)? ⇒ o browser está disponível (não degradou). */
  readonly customBrowserAvailable: boolean;
  /** Total de modelos APÓS o filtro (texto + toggle tools) — p/ "N de M". */
  readonly customFilteredCount: number;
  /** Total de modelos carregados (antes do filtro) — p/ "N de M". */
  readonly customTotalCount: number;
  /** A janela VISÍVEL do browser (fatia de `BROWSER_WINDOW` linhas, com scroll). */
  readonly customRows: readonly CustomBrowseRow[];
  /** Índice (na lista FILTRADA) da linha realçada; `-1` se nada realçado (vazio). */
  readonly customBrowseIndex: number;
  /** Há itens ACIMA da janela visível (scroll p/ cima disponível)? */
  readonly customHasMoreAbove: boolean;
  /** Há itens ABAIXO da janela visível (scroll p/ baixo disponível)? */
  readonly customHasMoreBelow: boolean;
  /** O filtro "só com tools" está LIGADO? */
  readonly customToolsOnly: boolean;
  /**
   * AVISO de não-suporte a tools (warn-but-allow), DERIVADO da linha REALÇADA: o `id`
   * do modelo realçado quando `supportsTools===false` (preview ANTES de confirmar).
   * `null` quando a linha realçada suporta tools, é neutra (`undefined`), ou não há
   * linha. Informativo (não bloqueia) — enter seleciona mesmo assim (ADR-0030 §4).
   */
  readonly customNoToolsWarning: string | null;
  /** Abre o picker (1ª vez carrega o catálogo). */
  openPicker(): void;
  /** Fecha o picker (esc) sem trocar — também sai do modo Custom. */
  closePicker(): void;
  /** Move a seleção (+1/-1) na LISTA de tiers, clampeada (inclui a linha CUSTOM). */
  move(delta: number): void;
  /**
   * EST-1117 — confirma a etapa corrente do fluxo CONJUGADO. Em vez de aplicar o modelo
   * direto, escolher o modelo AVANÇA pro passo de EFFORT; só a confirmação do effort
   * devolve o trio:
   *  - escolher um TIER / linha CUSTOM realçada / texto-livre ⇒ guarda o modelo e ABRE o
   *    passo de effort, devolve `null` (ainda não aplica);
   *  - na linha "Custom" da lista ⇒ ABRE o browser Custom (como antes), devolve `null`;
   *  - no passo de EFFORT (nível/manter) ⇒ devolve `{model, effort}` (CONJUGADO) e FECHA;
   *  - no effort CUSTOM com texto válido ⇒ devolve `{model, effort:{set,…}}` e FECHA;
   *  - effort custom inválido (vazio/>32) ⇒ `null` (mantém o passo aberto + aviso).
   * `null` quando não há nada a aplicar / só avançou de etapa.
   */
  confirm(): ConjugatedChoice | null;
  /** Acrescenta caractere ao filtro/slug Custom (digitação). */
  appendCustom(ch: string): void;
  /** Apaga o último caractere do filtro/slug Custom (backspace). */
  backspaceCustom(): void;
  /** Move o REALCE do browser Custom (+1/-1), clampeado na lista filtrada. */
  browseMove(delta: number): void;
  /** Alterna o filtro "só com tools" (tecla `t`). */
  toggleToolsOnly(): void;
  // ── PASSO de EFFORT (EST-1117, conjugado) ──────────────────────────────────
  /**
   * O passo de EFFORT está aberto? (2ª etapa do `/model`: depois de escolher o modelo,
   * antes de aplicar o trio). Enquanto aberto, ↑↓ navegam as opções de effort.
   */
  readonly effortStepOpen: boolean;
  /** As opções de effort (manter/low/medium/high/custom) — DADO puro do core, p/ render. */
  readonly effortOptions: readonly EffortOption[];
  /** Índice selecionado no passo de effort (navegado por ↑↓). */
  readonly effortSelected: number;
  /** O `reasoning_effort` ATIVO da sessão (p/ marcar o ● "atual"). `undefined` ⇒ default. */
  readonly currentEffort: string | undefined;
  /** O modo CUSTOM de effort (texto-livre passthrough) está aberto? */
  readonly effortCustomOpen: boolean;
  /** O texto digitado no effort custom (passthrough; vazio/>32 não confirma). */
  readonly effortCustomInput: string;
  /**
   * Aviso de effort custom INVÁLIDO (preview, warn-but-block): `'empty'` (vazio) ou
   * `'too-long'` (>32). `null` quando o digitado é válido (ou o custom não está aberto).
   */
  readonly effortCustomWarn: 'empty' | 'too-long' | null;
  /** Move a seleção no passo de effort (+1/-1), clampeada. */
  effortMove(delta: number): void;
  /** Acrescenta caractere ao effort custom (digitação). */
  appendEffortCustom(ch: string): void;
  /** Apaga o último caractere do effort custom (backspace). */
  backspaceEffortCustom(): void;
  /**
   * VOLTA um passo (esc): effort-custom → lista de effort; lista de effort → etapa de
   * modelo. Devolve `true` se recuou; `false` se já estava na etapa de modelo (⇒ fechar).
   */
  backFromEffort(): boolean;
}

/** Casa um modelo contra o termo de busca (id ∪ name ∪ family, substring CI). */
function matchesQuery(m: CustomModel, q: string): boolean {
  return (
    m.id.toLowerCase().includes(q) ||
    m.name.toLowerCase().includes(q) ||
    m.family.toLowerCase().includes(q)
  );
}

export function useModelPicker(args: UseModelPickerArgs): ModelPickerController {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [tiers, setTiers] = useState<readonly TierCatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [usingFallback, setUsingFallback] = useState<boolean | null>(null);
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [customBrowseIndex, setCustomBrowseIndex] = useState(0);
  const [customToolsOnly, setCustomToolsOnly] = useState(false);
  // EST-1117 — passo de EFFORT (conjugado): o modelo já escolhido fica GUARDADO aqui até
  // o effort ser confirmado (o trio aplica os dois juntos). `pendingModel` non-null ⇒ o
  // passo de effort está aberto.
  const [pendingModel, setPendingModel] = useState<ModelPickerChoice | null>(null);
  const [effortSelected, setEffortSelected] = useState(0);
  const [effortCustomOpen, setEffortCustomOpen] = useState(false);
  const [effortCustomInput, setEffortCustomInput] = useState('');
  const loadedRef = useRef(false);
  // As opções de effort são DADO puro do core (estável) — memoizado p/ ref constante.
  const effortOpts = useMemo<readonly EffortOption[]>(() => effortOptions(), []);
  // EST-0962 (Custom) — a lista DEDICADA de modelos Custom (`GET /v1/models/custom`,
  // os ~339), a FONTE do browser/autocomplete/warn do modo Custom. SEPARADA do
  // catálogo de tiers: carrega em paralelo e falha de forma independente. VAZIA quando
  // a lista não carregou (401/erro/offline/sem cliente) ⇒ degrada p/ texto-livre puro.
  const [customList, setCustomList] = useState<readonly CustomModel[]>([]);

  /** Posição do tier corrente na lista (p/ pré-selecionar no item ativo). */
  const indexOfCurrent = useCallback(
    (list: readonly TierCatalogEntry[]): number => {
      const i = list.findIndex((t) => t.key === args.currentTier);
      return i >= 0 ? i : 0;
    },
    [args.currentTier],
  );

  const loadCatalog = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    // EST-0962 — as DUAS fontes carregam em paralelo e falham de forma INDEPENDENTE:
    //  · TIERS (`GET /v1/tiers/catalog`) ⇒ a lista Flui/Granito/Strata/Cortex (intocada);
    //  · CUSTOM (`GET /v1/models/custom`) ⇒ o browser/autocomplete do modo Custom.
    // Um cair NÃO derruba o outro: tier-catalog 401 não tira o Custom, e vice-versa.

    // ── fonte dos TIERS (inalterada) ─────────────────────────────────────────
    const loadTiers = async (): Promise<void> => {
      try {
        const entries = await args.catalog.list();
        // Catálogo vazio (provisionamento) também cai no fallback honesto.
        if (entries.length === 0) {
          setTiers(FALLBACK_TIERS);
          setUsingFallback(true);
        } else {
          setTiers(entries);
          setUsingFallback(false);
        }
        setSelected(indexOfCurrent(entries.length === 0 ? FALLBACK_TIERS : entries));
      } catch {
        // HG-2: erro NEUTRO de broker — nunca distingue provider/credencial. Qualquer
        // falha (BrokerError/transporte/login, incl. 401 de scope) ⇒ fallback de tiers
        // conhecidos. NÃO mexe na lista Custom (fonte separada).
        setTiers(FALLBACK_TIERS);
        setUsingFallback(true);
        setSelected(indexOfCurrent(FALLBACK_TIERS));
      }
    };

    // ── fonte do CUSTOM (`GET /v1/models/custom`) — DEDICADA ao modo Custom ───
    const loadCustom = async (): Promise<void> => {
      if (!args.customModels) {
        setCustomList([]); // sem cliente ⇒ texto-livre puro (degrada)
        return;
      }
      try {
        setCustomList(await args.customModels.list());
      } catch {
        // 401/erro/offline ⇒ degrada p/ texto-livre, SEM browser/sugestão/warning (não
        // dá p/ saber se o slug está "fora da lista" — não inventamos). HG-2: neutro.
        setCustomList([]);
      }
    };

    try {
      await Promise.all([loadTiers(), loadCustom()]);
    } finally {
      setLoading(false);
    }
  }, [args.catalog, args.customModels, indexOfCurrent]);

  const openPicker = useCallback(() => {
    setOpen(true);
    setCustomInputOpen(false);
    setCustomInput('');
    setCustomBrowseIndex(0);
    setCustomToolsOnly(false);
    // EST-1117 — sempre reabre na etapa de MODELO (passo de effort fechado).
    setPendingModel(null);
    setEffortSelected(0);
    setEffortCustomOpen(false);
    setEffortCustomInput('');
    // 1ª abertura carrega o catálogo e posiciona a seleção no tier ATIVO; reaberturas
    // mantêm a lista já carregada (estado de sessão) e a última seleção.
    void loadCatalog();
  }, [loadCatalog]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setCustomInputOpen(false);
    setCustomInput('');
    setCustomBrowseIndex(0);
    setCustomToolsOnly(false);
    // EST-1117 — fecha também o passo de effort e descarta o modelo pendente.
    setPendingModel(null);
    setEffortSelected(0);
    setEffortCustomOpen(false);
    setEffortCustomInput('');
  }, []);

  // A linha CUSTOM é a ÚLTIMA: índice == tiers.length. O clamp do `move` a inclui.
  const customIndex = tiers.length;
  const customSelected = open && selected === customIndex;

  const move = useCallback(
    (delta: number) => {
      // Enquanto o modo Custom está aberto, ↑↓ não navegam a LISTA de tiers (modal).
      if (customInputOpen) return;
      setSelected((s) => {
        const max = Math.max(0, tiers.length); // +1 p/ a linha CUSTOM
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [tiers.length, customInputOpen],
  );

  // ── BROWSER Custom: a lista FILTRADA (texto + toggle tools), derivada ─────────
  // O filtro do TEXTO casa id ∪ name ∪ family (substring CI). O toggle "só tools"
  // mantém apenas `supportsTools===true` (modelos `undefined`/`false` somem). A ordem
  // é a do broker (estável). Tudo memoizado p/ a janela/scroll não recomputar à toa.
  const customFiltered = useMemo<readonly CustomModel[]>(() => {
    const q = customInput.trim().toLowerCase();
    return customList.filter((m) => {
      if (customToolsOnly && m.supportsTools !== true) return false;
      if (q !== '' && !matchesQuery(m, q)) return false;
      return true;
    });
  }, [customList, customInput, customToolsOnly]);

  // Índice realçado clampeado na lista filtrada corrente; `-1` quando vazia (nada a
  // realçar ⇒ enter cai no texto-livre). NÃO usa state diretamente: deriva do state
  // bruto clampeado, p/ filtro/toggle que encolhem a lista não deixarem um índice solto.
  const clampedBrowseIndex =
    customFiltered.length === 0
      ? -1
      : Math.min(Math.max(0, customBrowseIndex), customFiltered.length - 1);

  // Janela visível: centra (best-effort) o realce dentro de `BROWSER_WINDOW`. Mostra
  // uma fatia contígua; o `start` desliza p/ manter o realce visível ao navegar.
  const windowStart = useMemo<number>(() => {
    if (customFiltered.length <= BROWSER_WINDOW || clampedBrowseIndex < 0) return 0;
    const half = Math.floor(BROWSER_WINDOW / 2);
    const maxStart = customFiltered.length - BROWSER_WINDOW;
    return Math.min(Math.max(0, clampedBrowseIndex - half), maxStart);
  }, [customFiltered.length, clampedBrowseIndex]);

  const customRows = useMemo<readonly CustomBrowseRow[]>(() => {
    return customFiltered
      .slice(windowStart, windowStart + BROWSER_WINDOW)
      .map((model, i) => ({ model, highlighted: windowStart + i === clampedBrowseIndex }));
  }, [customFiltered, windowStart, clampedBrowseIndex]);

  // Aviso de não-suporte a tools (warn-but-allow), DERIVADO do realce: o `id` quando a
  // linha realçada tem `supportsTools===false` (preview antes do enter). `null` quando
  // suporta, é neutra (undefined), ou não há linha. Confirmar NÃO bloqueia (ADR-0030 §4).
  const customNoToolsWarning = useMemo<string | null>(() => {
    if (!customInputOpen || clampedBrowseIndex < 0) return null;
    const row = customFiltered[clampedBrowseIndex];
    return row && row.supportsTools === false ? row.id : null;
  }, [customInputOpen, clampedBrowseIndex, customFiltered]);

  // EST-0962 (compat #88) — autocomplete textual sobre a lista DEDICADA: as mesmas
  // linhas filtradas pelo TEXTO (ignorando o toggle de tools, p/ não mudar a base do
  // autocomplete antigo), formatadas como antes (`id · name · family`). VAZIO se a
  // lista não carregou ou o input está vazio.
  const customSuggestions = useMemo<readonly string[]>(() => {
    const q = customInput.trim().toLowerCase();
    if (q === '' || customList.length === 0) return [];
    return customList
      .filter((m) => matchesQuery(m, q))
      .slice(0, 8)
      .map(suggestionLine);
  }, [customInput, customList]);

  // warn-but-allow: avisa SÓ quando a lista Custom carregou (não-vazia) E o slug
  // digitado não bate EXATAMENTE nenhum `id`. Sem lista ⇒ sem warning. Exato só por `id`.
  const customWarnOutOfCatalog = useMemo<boolean>(() => {
    const q = customInput.trim();
    if (q === '' || customList.length === 0) return false;
    const ql = q.toLowerCase();
    return !customList.some((m) => m.id.toLowerCase() === ql);
  }, [customInput, customList]);

  const browseMove = useCallback(
    (delta: number) => {
      if (!customInputOpen) return;
      setCustomBrowseIndex((i) => {
        const len = customFiltered.length;
        if (len === 0) return 0;
        return Math.min(len - 1, Math.max(0, i + delta));
      });
    },
    [customInputOpen, customFiltered.length],
  );

  const toggleToolsOnly = useCallback(() => {
    if (!customInputOpen) return;
    setCustomToolsOnly((v) => !v);
    setCustomBrowseIndex(0); // a lista muda de tamanho ⇒ realce volta ao topo
  }, [customInputOpen]);

  // EST-1117 — AVANÇA pro passo de EFFORT guardando o modelo escolhido (não fecha; o trio
  // só é devolvido quando o effort for confirmado). Pré-seleciona "manter" (1ª opção — o
  // menor atrito p/ quem só troca o modelo). Sai dos modos Custom/browser.
  const enterEffortStep = useCallback((model: ModelPickerChoice) => {
    setPendingModel(model);
    setEffortSelected(0);
    setEffortCustomOpen(false);
    setEffortCustomInput('');
    setCustomInputOpen(false);
  }, []);

  const confirm = useCallback((): ConjugatedChoice | null => {
    // ── PASSO DE EFFORT (EST-1117): o modelo já está guardado em `pendingModel` ──────
    if (pendingModel) {
      // (E1) effort CUSTOM aberto: confirma o texto-livre passthrough (válido ⇒ aplica).
      if (effortCustomOpen) {
        const choice = effortChoiceFromCustom(effortCustomInput);
        if (choice === null) return null; // inválido (vazio/>32): mantém aberto + aviso
        const model = pendingModel;
        closePicker();
        return { model, effort: choice };
      }
      // (E2) opção "custom" da lista ⇒ ABRE o texto-livre (não confirma ainda).
      const opt = effortOpts[clampEffortIndex(effortSelected)];
      if (opt?.kind === 'custom') {
        setEffortCustomOpen(true);
        setEffortCustomInput('');
        return null;
      }
      // (E3) "manter" ou um nível canônico ⇒ aplica o trio (model + effort) e FECHA.
      const choice = effortChoiceAt(clampEffortIndex(effortSelected));
      if (choice === null) return null;
      const model = pendingModel;
      closePicker();
      return { model, effort: choice };
    }

    // ── ETAPA DE MODELO: escolher o modelo AVANÇA pro passo de effort ────────────────
    // (1) No modo CUSTOM (browser/input): escolhe a linha realçada OU o texto-livre.
    if (customInputOpen) {
      // (1a) Linha REALÇADA do browser ⇒ seleciona o `id` daquela linha (load-bearing).
      const row = clampedBrowseIndex >= 0 ? customFiltered[clampedBrowseIndex] : undefined;
      if (row) {
        // supportsTools acompanha p/ o aviso warn-but-allow no chamador.
        enterEffortStep(
          row.supportsTools === undefined
            ? { kind: 'custom', model: row.id }
            : { kind: 'custom', model: row.id, supportsTools: row.supportsTools },
        );
        return null;
      }
      // (1b) Sem linha realçada (lista vazia / nada filtrado): texto-livre do digitado.
      const model = customInput.trim();
      if (model === '') return null; // nada a aplicar (segue digitando)
      enterEffortStep({ kind: 'custom', model });
      return null;
    }
    // (2) Na linha CUSTOM: ABRE o modo Custom (não fecha — vai navegar/digitar).
    if (selected === customIndex) {
      setCustomInputOpen(true);
      setCustomInput('');
      setCustomBrowseIndex(0);
      setCustomToolsOnly(false);
      return null;
    }
    // (3) Num TIER: AVANÇA pro passo de effort com a chave do tier.
    const entry = tiers[selected];
    if (!entry) return null;
    enterEffortStep({ kind: 'tier', key: entry.key });
    return null;
  }, [
    pendingModel,
    effortCustomOpen,
    effortCustomInput,
    effortOpts,
    effortSelected,
    tiers,
    selected,
    customIndex,
    customInputOpen,
    customInput,
    customFiltered,
    clampedBrowseIndex,
    closePicker,
    enterEffortStep,
  ]);

  // ── métodos do passo de EFFORT (EST-1117) ──────────────────────────────────────────
  const effortMove = useCallback(
    (delta: number) => {
      if (!pendingModel || effortCustomOpen) return; // texto-livre: ↑↓ não navegam a lista
      setEffortSelected((s) => clampEffortIndex(s + delta));
    },
    [pendingModel, effortCustomOpen],
  );

  const appendEffortCustom = useCallback(
    (ch: string) => {
      if (!effortCustomOpen) return;
      const clean = ch.replace(/[\r\n\t]/g, '');
      if (clean === '') return;
      setEffortCustomInput((s) => s + clean);
    },
    [effortCustomOpen],
  );

  const backspaceEffortCustom = useCallback(() => {
    if (!effortCustomOpen) return;
    setEffortCustomInput((s) => s.slice(0, -1));
  }, [effortCustomOpen]);

  // EST-1117 — VOLTA um passo no fluxo (esc): do effort-custom volta p/ a lista de effort;
  // da lista de effort volta p/ a etapa de MODELO (descarta o modelo pendente). `true` se
  // recuou um passo; `false` se já estava na etapa de modelo (o chamador então fecha tudo).
  const backFromEffort = useCallback((): boolean => {
    if (effortCustomOpen) {
      setEffortCustomOpen(false);
      setEffortCustomInput('');
      return true;
    }
    if (pendingModel) {
      setPendingModel(null);
      setEffortSelected(0);
      return true;
    }
    return false;
  }, [effortCustomOpen, pendingModel]);

  // Aviso (preview) de effort custom inválido — derivado do digitado. `null` quando válido
  // ou o custom não está aberto. warn-but-block: enter não aplica enquanto inválido.
  const effortCustomWarn = useMemo<'empty' | 'too-long' | null>(() => {
    if (!effortCustomOpen) return null;
    const v = validateCustomEffort(effortCustomInput);
    return v.ok ? null : v.reason;
  }, [effortCustomOpen, effortCustomInput]);

  const appendCustom = useCallback(
    (ch: string) => {
      if (!customInputOpen) return;
      // Só caracteres "imprimíveis" — controla colagem multi-char também (slug colado).
      const clean = ch.replace(/[\r\n\t]/g, '');
      if (clean === '') return;
      setCustomBrowseIndex(0); // o filtro muda ⇒ o realce volta ao topo da lista nova
      setCustomInput((s) => s + clean);
    },
    [customInputOpen],
  );

  const backspaceCustom = useCallback(() => {
    if (!customInputOpen) return;
    setCustomBrowseIndex(0);
    setCustomInput((s) => s.slice(0, -1));
  }, [customInputOpen]);

  return {
    open,
    selected,
    tiers,
    loading,
    usingFallback,
    customSelected,
    customInputOpen,
    customInput,
    customSuggestions,
    customWarnOutOfCatalog,
    customBrowserAvailable: customList.length > 0,
    customFilteredCount: customFiltered.length,
    customTotalCount: customList.length,
    customRows,
    customBrowseIndex: clampedBrowseIndex,
    customHasMoreAbove: windowStart > 0,
    customHasMoreBelow: windowStart + BROWSER_WINDOW < customFiltered.length,
    customToolsOnly,
    customNoToolsWarning,
    openPicker,
    closePicker,
    move,
    confirm,
    appendCustom,
    backspaceCustom,
    browseMove,
    toggleToolsOnly,
    // ── passo de EFFORT (EST-1117) ───────────────────────────────────────────
    effortStepOpen: pendingModel !== null,
    effortOptions: effortOpts,
    effortSelected: clampEffortIndex(effortSelected),
    currentEffort: args.currentEffort,
    effortCustomOpen,
    effortCustomInput,
    effortCustomWarn,
    effortMove,
    appendEffortCustom,
    backspaceEffortCustom,
    backFromEffort,
  };
}

/**
 * Linha de exibição de uma sugestão Custom (autocomplete textual, compat #88): o `id`
 * (o slug que se ENVIA, load-bearing) + dica `name`/`family` quando há. HG-2:
 * `id`/`name`/`family` são PÚBLICOS (ADR-0030 §3) — nenhum provider de credencial entra.
 */
function suggestionLine(m: CustomModel): string {
  const hint = [m.name, m.family].map((s) => s.trim()).filter((s) => s !== '');
  return hint.length > 0 ? `${m.id} · ${hint.join(' · ')}` : m.id;
}
