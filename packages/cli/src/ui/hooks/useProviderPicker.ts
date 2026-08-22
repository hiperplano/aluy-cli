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
//
// F-PROV-CRED (relato do dono: "mudei o provider no picker e ele não pediu nada" — trocou
// pra `google`/`mistral`, sem chave, e o aluy só AVISOU que faltava) — o `/provider` agora
// tem um passo NOVO, entre escolher o provider e aplicar: se o provider exige apikey
// (`requiresApiKey`) e NÃO há chave guardada (`needsCredentialStep`), o `confirm()` NÃO
// fecha o picker — abre um campo MASCARADO (`credentialStep`/`credentialDraft`, MESMO
// mecanismo Ink do formulário "+ adicionar" acima, nunca ecoado — ver `maskValue` no
// componente) em vez de aplicar o provider sem credencial. Só DEPOIS de gravar a chave
// (`args.storeCredential`, que o `run.tsx` liga a `storeApiKey` — ÚNICA escrita de
// credencial do produto, não duplicada aqui) o picker fecha e devolve o nome — o
// `switchLocalProvider` que o chamador já invoca em seguida acha a chave e TESTA a
// conexão (fail-closed) pelo caminho que já existia.
//
// Se esse teste REPROVAR (chave velha/errada), o chamador (fora deste hook — a troca é
// ASSÍNCRONA e só resolve DEPOIS do picker já ter fechado) chama `retryCredential(provider,
// detail)`: REABRE o mesmo campo, limpo, com o motivo do teste anterior visível (nunca a
// chave) — "colar outra key" em vez de só recusar (pedido explícito do dono). Keyless
// (Ollama, `auth:['none']`) nunca vê nenhum destes dois caminhos (`requiresApiKey` os
// filtra os dois).
//
// DI, não import direto: `hasStoredKey`/`storeCredential` são INJETADOS (mesmo padrão de
// `providersClient`/`localCatalog` acima) — este hook nunca importa `credential-resolver.ts`
// (keychain/cofre em arquivo) diretamente. Dois motivos: (1) a fronteira já estabelecida
// aqui é "I/O entra por prop, o hook só orquestra estado" (nenhum outro campo deste arquivo
// toca disco/rede direto); (2) SEM injeção, todo teste que já constrói `useProviderPicker`
// sem estas duas props (a suíte inteira de hoje) continua se comportando EXATAMENTE como
// antes — o passo de credencial só entra em vigor quando o `run.tsx`/`App.tsx` ligarem o
// fio (RELATADO no PR, arquivos fora do escopo desta mudança).

import { useCallback, useRef, useState } from 'react';
import type { ProvidersClient, LocalProviderEntry, LocalAuthMode } from '@hiperplano/aluy-cli-core';
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

/** Passo do campo de credencial ("colar a API key"). `null` fora do fluxo; `'key'` cobre
 * as DUAS entradas (1ª vez sem chave guardada, ou retry após teste reprovado) — o que
 * distingue as duas é só `credentialError` (vazio na 1ª vez, o `detail` do teste no retry). */
export type CredentialStep = 'key' | null;

/**
 * DECISÃO pura — este `auth` (modos aceitos por UM provider do catálogo local) EXIGE uma
 * credencial de API key? Espelha a MESMA regra que `defaultAuthFor` usa pra decidir
 * 'apikey' vs 'none' (`packages/cli/src/model/local/factory.ts`, não importada aqui pra
 * manter este hook livre de qualquer import de módulo de I/O — só a REGRA é replicada, um
 * one-liner): só é KEYLESS quando TODOS os modos declarados são `'none'` (ex.: Ollama,
 * `auth:['none']`) — `['apikey']`/`['apikey','oauth']`/qualquer mistura exige chave.
 * `undefined`/vazio (provider fora do catálogo local, ou lista vinda do BROKER — que não
 * tem este conceito) ⇒ `false`: sem o dado, não há como pedir a chave com segurança.
 */
export function requiresApiKey(auth: readonly LocalAuthMode[] | undefined): boolean {
  if (auth === undefined || auth.length === 0) return false;
  return !auth.every((m) => m === 'none');
}

/**
 * DECISÃO pura — ao CONFIRMAR um provider no picker, é preciso abrir o passo de
 * credencial ANTES de aplicar? Regra do dono ("mudei o provider no picker e ele não pediu
 * nada"): só pede quando FALTA a chave — `hasStoredKey=true` (já configurado) segue
 * DIRETO, sem incomodar; provider KEYLESS (`requiresApiKey=false`) nunca vê este passo.
 */
export function needsCredentialStep(
  auth: readonly LocalAuthMode[] | undefined,
  hasStoredKey: boolean,
): boolean {
  if (hasStoredKey) return false;
  return requiresApiKey(auth);
}

/**
 * DECISÃO pura — `switchLocalProvider` REPROVOU o teste de conexão de um provider que
 * este picker acabou de armar. Pedido do dono: "se a credencial não funcionar ele tem que
 * dar a opção de colocar outra key" — em vez de só uma nota de erro, REABRE o campo. Só
 * faz sentido quando o provider EXIGE apikey (`requiresApiKey`): um KEYLESS (Ollama) que
 * falhou é rede/serviço fora do ar, não credencial — reabrir um campo pra uma chave que
 * não existe seria confuso. `detail` é o motivo do teste (NUNCA a chave — CLI-SEC). `null`
 * ⇒ não reabre (a nota de erro que o chamador já empurra basta).
 */
export function planCredentialRetry(
  auth: readonly LocalAuthMode[] | undefined,
  detail: string,
): { readonly error: string } | null {
  if (!requiresApiKey(auth)) return null;
  return { error: detail };
}

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
   * exclusivas — nunca mistura BYO com o catálogo do broker). TAMBÉM é a fonte do
   * `auth[]` de cada entrada (usado pelo passo de credencial abaixo) — o catálogo do
   * broker não tem esse conceito, então o passo NUNCA se aplica sem `localCatalog`.
   */
  readonly localCatalog?: () => readonly LocalProviderEntry[];
  /**
   * F-PROV-CRED — presença de credencial JÁ guardada p/ um provider (síncrono, LOCAL:
   * keychain→cofre em arquivo, NUNCA rede). Decide se o passo de chave é necessário ao
   * confirmar (regra 1: quem já configurou não é incomodado). Injetada — ver o cabeçalho
   * do arquivo. AUSENTE ⇒ o picker aplica DIRETO, sem passo de chave (comportamento de
   * hoje) — o passo só entra em vigor quando `run.tsx` ligar `hasStoredApiKey` aqui.
   */
  readonly hasStoredKey?: (providerId: string) => boolean;
  /**
   * F-PROV-CRED — grava a chave colada no passo de credencial. `run.tsx` liga isto a
   * `storeApiKey` (`model/local/credential-resolver.ts`, a ÚNICA escrita de credencial do
   * produto — este hook não duplica). PODE LANÇAR (ex.: `MachineIdUnavailableError`): o
   * hook captura e mostra `e.message` no próprio campo — CLI-SEC: a mensagem nunca contém
   * a chave, só o motivo do backend. AUSENTE ⇒ o passo de credencial nunca é oferecido.
   */
  readonly storeCredential?: (providerId: string, apiKey: string) => void;
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
   *
   * F-PROV-CRED — quando o provider escolhido EXIGE chave e não há uma guardada
   * (`needsCredentialStep`), NÃO fecha e devolve `null`: abre `credentialStep` no lugar
   * (ver `confirmCredential`). O chamador só recebe o nome quando não há mais nada a
   * pedir — igual ao sentinela do "+ adicionar", reusa o MESMO picker aberto.
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

  // ── F-PROV-CRED — campo de credencial ("colar a API key") ────────────────────────
  /** Passo do campo de credencial (`null` fora do fluxo). */
  readonly credentialStep: CredentialStep;
  /** Provider ao qual a chave em digitação vai se aplicar (display só — CLI-SEC-7: é
   * NOME de catálogo, nunca credencial). */
  readonly credentialProviderId: string;
  /** Valor em digitação (cru, em memória — o COMPONENTE nunca o renderiza cru, só
   * mascarado). NUNCA persistido em lugar nenhum além do `storeCredential` injetado. */
  readonly credentialDraft: string;
  /** Motivo de uma tentativa ANTERIOR ter falhado (gravação OU teste de conexão do
   * chamador) — vazio na 1ª vez. NUNCA contém a chave, só o `detail`/mensagem do backend. */
  readonly credentialError: string;
  /** Digita um caractere no campo de chave. No-op fora do fluxo. */
  typeCredential(ch: string): void;
  /** Apaga um caractere (backspace) do campo de chave. No-op fora do fluxo. */
  backspaceCredential(): void;
  /**
   * Confirma o campo de chave: vazio ⇒ no-op (campo obrigatório, mesma UX do id/baseUrl
   * do "+ adicionar"). Não-vazio ⇒ chama `args.storeCredential`; se ele LANÇAR, mantém o
   * campo aberto com o erro em `credentialError` (nunca a chave) e devolve `null`; se
   * gravar, fecha o picker e devolve o NOME do provider — o mesmo contrato de `confirm()`,
   * pronto pro chamador aplicar (`onSelectProvider`).
   */
  confirmCredential(): string | null;
  /** Cancela o campo de chave (esc) e volta pra lista, sem gravar nada. */
  cancelCredential(): void;
  /**
   * REABRE o campo de chave (picker fechado ou não) depois que o chamador soube, de forma
   * ASSÍNCRONA, que `switchLocalProvider` reprovou o teste de conexão pra este provider —
   * ver `planCredentialRetry`. No-op p/ provider keyless (nada a pedir). `detail` nunca
   * contém a chave.
   */
  retryCredential(providerId: string, detail: string): void;
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

  // F-PROV-CRED — estado do campo de chave (ver os tipos/JSDoc no topo do arquivo).
  const [credentialStep, setCredentialStep] = useState<CredentialStep>(null);
  const [credentialProviderId, setCredentialProviderId] = useState('');
  const [credentialDraft, setCredentialDraft] = useState('');
  const [credentialError, setCredentialError] = useState('');
  // `auth[]` por provider (id em minúsculas), do catálogo LOCAL cru — NUNCA passa pelo
  // `ProviderEntry` de display (`buildLocalProviderEntries` descarta `auth`, e ele é
  // arquivo PROIBIDO nesta mudança). Ref (não state): só é LIDO em callbacks de evento
  // (confirm/retryCredential), nunca no render — não precisa disparar re-render.
  const authById = useRef<Map<string, readonly LocalAuthMode[]>>(new Map());

  const resetCredential = useCallback(() => {
    setCredentialStep(null);
    setCredentialProviderId('');
    setCredentialDraft('');
    setCredentialError('');
  }, []);

  const loadLocalProviders = useCallback((): readonly ProviderEntry[] => {
    const raw = args.localCatalog?.() ?? [];
    authById.current = new Map(raw.map((e) => [e.id.toLowerCase(), e.auth]));
    const entries = buildLocalProviderEntries(raw);
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
    resetCredential();
    void loadProviders();
  }, [args.currentProvider, providers, loadProviders, resetCredential]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setAddCustomStep(null);
    setAddCustomDraft(EMPTY_DRAFT);
    resetCredential();
  }, [resetCredential]);

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
    if (entry === undefined) return null;
    // F-PROV — o item sentinela "+ adicionar" NÃO é uma escolha final: a App (ao ver
    // este nome de volta) chama `startAddCustom()` em seguida, reusando o MESMO picker
    // pro formulário (`open` continua controlando o render em App.tsx). Fechar aqui
    // incondicionalmente deixava `startAddCustom()` armar o passo 'id' com `open=false`
    // — o <ProviderPicker> nunca chegava a renderizar o formulário, e o enter no item
    // "+ adicionar" virava um no-op silencioso (bug relatado: "clico e não acontece
    // nada"). Só fecha de fato quando a escolha é um provider REAL.
    if (entry.name === ADD_CUSTOM_PROVIDER_SENTINEL) {
      return entry.name;
    }
    // F-PROV-CRED — antes de aplicar, decide se falta pedir a chave (regra do dono:
    // "mudei o provider e ele não pediu nada"). Só entra em vigor quando o chamador
    // injetou os dois fios (senão o picker segue exatamente como hoje — ver JSDoc do
    // arquivo).
    if (args.hasStoredKey !== undefined && args.storeCredential !== undefined) {
      const auth = authById.current.get(entry.name.toLowerCase());
      if (needsCredentialStep(auth, args.hasStoredKey(entry.name))) {
        setCredentialProviderId(entry.name);
        setCredentialDraft('');
        setCredentialError('');
        setCredentialStep('key');
        return null; // fica na MESMA picker aberta — troca a vista p/ o campo de chave.
      }
    }
    setOpen(false);
    return entry.name;
  }, [providers, selected, args.hasStoredKey, args.storeCredential]);

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

  // ── F-PROV-CRED — campo de credencial ─────────────────────────────────────────────
  const typeCredential = useCallback(
    (ch: string) => {
      if (credentialStep === null) return;
      setCredentialDraft((d) => d + ch);
    },
    [credentialStep],
  );

  const backspaceCredential = useCallback(() => {
    if (credentialStep === null) return;
    setCredentialDraft((d) => d.slice(0, -1));
  }, [credentialStep]);

  const confirmCredential = useCallback((): string | null => {
    if (credentialStep === null) return null;
    const key = credentialDraft.trim();
    if (key === '') return null; // campo obrigatório — Enter não avança vazio.
    if (args.storeCredential === undefined) return null; // defensivo — só chega aqui injetado.
    try {
      args.storeCredential(credentialProviderId, key);
    } catch (e) {
      // CLI-SEC — a MENSAGEM nunca contém a chave (é o motivo do backend: keychain/cofre
      // em arquivo/machine-id), só `e.message`. Limpa o rascunho: não reexibe (nem
      // mascarado) o valor que falhou ao gravar — reforça "sempre recomeça do zero".
      setCredentialError(e instanceof Error ? e.message : String(e));
      setCredentialDraft('');
      return null;
    }
    const id = credentialProviderId;
    resetCredential();
    setOpen(false);
    return id;
  }, [credentialStep, credentialDraft, credentialProviderId, args.storeCredential, resetCredential]);

  const cancelCredential = useCallback(() => {
    resetCredential();
  }, [resetCredential]);

  const retryCredential = useCallback(
    (providerId: string, detail: string): void => {
      let auth = authById.current.get(providerId.toLowerCase());
      if (auth === undefined) {
        // `/provider <nome>` aplica DIRETO, sem abrir o picker — e é `loadLocalProviders`
        // (que só roda ao abrir) quem preenche o mapa de auth. Sem este carregamento sob
        // demanda, uma troca por nome que levasse 401 não reabriria campo nenhum: o
        // `planCredentialRetry` receberia `undefined`, concluiria "não exige apikey" e
        // devolveria `null` — o MESMO silêncio que este retry existe para acabar.
        loadLocalProviders();
        auth = authById.current.get(providerId.toLowerCase());
      }
      const plan = planCredentialRetry(auth, detail);
      if (plan === null) return; // keyless (ou provider desconhecido) — nada a pedir.
      setCredentialProviderId(providerId);
      setCredentialDraft('');
      setCredentialError(plan.error);
      setCredentialStep('key');
      setOpen(true);
    },
    [loadLocalProviders],
  );

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
    credentialStep,
    credentialProviderId,
    credentialDraft,
    credentialError,
    typeCredential,
    backspaceCredential,
    confirmCredential,
    cancelCredential,
    retryCredential,
  };
}
