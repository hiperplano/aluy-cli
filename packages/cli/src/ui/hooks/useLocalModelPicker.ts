// F161-FIX — hook do seletor de MODELO sob o backend LOCAL (BYO): estado do picker
// (abrir/filtrar/navegar/confirmar/fechar) sobre os slugs do provider ativo. Mesma
// MECÂNICA do `useFilePicker` (EST-0957): a App captura teclado e chama os métodos
// daqui; a apresentação é pura (`<LocalModelPicker>`).
//
// ACHADO (investigação): `/model` sem argumento SÓ abria o seletor de TIERS quando
// `props.catalog` (broker) estava injetado — sob `backend:'local'` (o caminho BYO,
// o default/principal do produto) caía numa nota estática ("os tiers do broker não
// se aplicam aqui... troque com /provider"), sem NENHUMA lista. Este hook fecha esse
// gap com um picker DEDICADO ao local, em vez de forçar os tiers do broker (que não
// fazem sentido ali) para dentro do `useModelPicker`.
//
// FONTE dos candidatos: injetada via `catalog.listNames()` — a MESMA porta
// `localModelCatalogPort` que o roteamento de sub-agente já usa (ADR-0152 D6c/
// ADR-0153 D2): os slugs DECLARADOS do provider ativo (`~/.aluy/providers.json` +
// built-ins, ADR-0118) UNIDOS aos registrados NESTA sessão (test-then-register).
// Reconsultada A CADA abertura (não cacheada) — se um slug foi registrado durante a
// sessão (ex.: por um sub-agente), a PRÓXIMA abertura do picker já o lista. Ausente/
// `undefined` ⇒ lista vazia (degrada p/ texto-livre puro — sem sugestão, mas Enter
// ainda funciona com o texto digitado).
//
// F-MODEL-LIVE — o DIAGNÓSTICO apurado em dogfooding: a lista acima é a DECLARADA no
// catálogo (embutido + `~/.aluy/config.json`), NUNCA a que o provider de fato expõe.
// Pro `openrouter` built-in isso são só 5 slugs fixos; o provider de verdade tem
// CENTENAS (confirmado em campo: 338 no dia da investigação) — e o modelo que o dono
// realmente usa (`xiaomi/mimo-v2.5-pro`) nem estava entre os 5, então o picker não
// conseguia sequer MOSTRAR o modelo ATIVO. `remoteNames` (opcional) é a busca AO VIVO
// (`run.tsx` → `listRemoteModelNames`, `GET {baseUrl}/models` via fetch PINADO) — ao
// ABRIR o picker, dispara a busca (com `loading=true` enquanto ela roda: a lista pode
// ter centenas de itens, então NUNCA travamos a UI nem mostramos lista vazia sem
// dizer o motivo) e, quando resolve, FUNDE o resultado com o que já estava mostrado
// (declarado ∪ sessão ∪ modelo ATIVO) — UNIÃO, nunca substituição: o modelo ativo
// aparece SEMPRE, mesmo que o `/models` do provider não o liste. Falha da busca
// (rede/401/timeout) ⇒ `usingFallback=true` — a UI avisa "não foi possível listar" e
// o picker continua plenamente utilizável com o que já tinha (nunca lista vazia
// silenciosa). Ausente ⇒ o picker se comporta EXATAMENTE como antes (só o catálogo).
//
// Fuzzy: reusa `filterFuzzy` — o MESMO módulo do picker `@arquivo` (EST-0957), só
// aplicado a slugs de modelo em vez de caminhos (é subsequência genérica sobre
// strings; os bônus de "borda de segmento" também ajudam em slugs tipo
// `deepseek-chat`/`claude-opus-4-8`, que usam os mesmos separadores `-`/`.`/`/`).
//
// Confirmar NÃO faz I/O: devolve o slug escolhido (da linha realçada OU, sem
// realce, o texto digitado LITERAL — warn-but-allow, o MESMO comportamento de hoje
// digitar `/model <slug>` p/ um modelo fora do catálogo curado). O chamador (App)
// aplica via `onSelectTier('custom', slug)` — o MESMO caminho (setTier+saveTier+
// nota) que `/model <slug>` digitado já usa: ZERO divergência de efeito entre picker
// e forma literal (mesmo contrato pedido pela spec).

import { useCallback, useMemo, useRef, useState } from 'react';
import { filterFuzzy, type FuzzyHit } from '../../attach/index.js';

/** Porta do catálogo LOCAL (ADR-0152/0153) — os slugs conhecidos do provider ativo. */
export interface LocalModelCatalogPort {
  /** Declarados ∪ registrados-na-sessão. `undefined` ⇒ catálogo não listável. */
  readonly listNames: () => readonly string[] | undefined;
}

/** F-MODEL-LIVE — resultado de UMA busca da lista viva do provider ativo. */
export interface RemoteModelNamesResult {
  /** Slugs anunciados pelo provider (pode ser `[]` em falha OU provider sem modelos). */
  readonly names: readonly string[];
  /** `true` ⇒ a busca respondeu de verdade; `false` ⇒ falhou (rede/401/timeout/etc.) —
   * a UI deve avisar o fallback. */
  readonly ok: boolean;
}

/** F-MODEL-LIVE — busca AO VIVO os slugs do provider LOCAL ativo. NUNCA lança/rejeita
 * (falha vira `{names:[], ok:false}` — ver `createProviderAwareListModelNamesPort`). */
export type RemoteModelNamesFetcher = () => Promise<RemoteModelNamesResult>;

export interface UseLocalModelPickerArgs {
  /** Fonte dos candidatos DECLARADOS. Ausente ⇒ o picker sempre degrada p/ texto-livre
   * (a menos que `remoteNames` sozinho já traga algo). */
  readonly catalog?: LocalModelCatalogPort;
  /**
   * F-MODEL-LIVE — busca AO VIVO do provider ativo, disparada a CADA abertura do
   * picker. Ausente ⇒ o picker fica só no catálogo DECLARADO ∪ sessão (comportamento
   * de sempre, sem regressão).
   */
  readonly remoteNames?: RemoteModelNamesFetcher;
  /** Slug do modelo LOCAL ativo (p/ a UI marcar o ●, e p/ SEMPRE entrar na união —
   * mesmo que nem o catálogo nem o `/models` do provider o listem). */
  readonly currentModel?: string;
}

export interface LocalModelPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Query corrente (filtra os candidatos por fuzzy). */
  readonly query: string;
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Resultados fuzzy correntes (já filtrados pela query). */
  readonly hits: readonly FuzzyHit[];
  /**
   * F-MODEL-LIVE — a busca AO VIVO (`remoteNames`) está em andamento? A lista pode ter
   * centenas de itens — enquanto `true`, a UI mostra um indicador (nunca trava/nunca
   * mostra lista vazia sem dizer o motivo). O catálogo DECLARADO já fica disponível
   * IMEDIATAMENTE (síncrono) — `loading` só cobre a busca de REDE por cima.
   */
  readonly loading: boolean;
  /**
   * F-MODEL-LIVE — a busca AO VIVO falhou (rede/401/timeout/provider sem `/models`) ⇒
   * a lista é só o catálogo DECLARADO ∪ sessão ∪ ativo — a UI mostra o aviso honesto.
   * `false` ⇒ a busca respondeu (mesmo que `[]`). `null` ⇒ sem `remoteNames` OU ainda
   * carregando (nenhum sinal a mostrar).
   */
  readonly usingFallback: boolean | null;
  /** Abre o picker (reconsulta o catálogo — pode ter crescido desde a última abertura;
   * dispara a busca AO VIVO de novo quando `remoteNames` está presente). */
  openPicker(): void;
  /** Fecha o picker (esc) sem trocar. */
  closePicker(): void;
  /** Atualiza a query (digitação) e recomputa os hits. */
  setQuery(query: string): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /**
   * Confirma: linha REALÇADA ⇒ seu slug. Sem linha (lista vazia / nada filtrado) ⇒ o
   * texto digitado LITERAL (trim). Digitado vazio + sem linha ⇒ `null` (nada a
   * aplicar — o picker continua aberto, o usuário segue digitando).
   */
  confirm(): string | null;
}

/** UNIÃO de slugs, case-insensitive (1ª grafia vista vence), preservando ORDEM de
 * chegada — usado p/ fundir catálogo/sessão/ativo/provider sem duplicar por
 * capitalização (`Xiaomi/Mimo` e `xiaomi/mimo` são o MESMO slug pro dono). */
function unionNames(...lists: readonly (readonly string[])[]): readonly string[] {
  const seen = new Map<string, string>();
  for (const list of lists) {
    for (const n of list) {
      const key = n.toLowerCase();
      if (!seen.has(key)) seen.set(key, n);
    }
  }
  return [...seen.values()];
}

export function useLocalModelPicker(args: UseLocalModelPickerArgs): LocalModelPickerController {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [selected, setSelected] = useState(0);
  const [names, setNames] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [usingFallback, setUsingFallback] = useState<boolean | null>(null);
  // F-MODEL-LIVE — geração da busca AO VIVO corrente: incrementada a CADA `openPicker`.
  // Uma resposta que chega DEPOIS de uma reabertura mais nova (ex.: o dono reabriu o
  // picker antes da 1ª busca terminar, ou um `/provider` trocou o provider ativo no
  // meio do voo) é DESCARTADA — nunca sobrescreve a lista de uma abertura mais nova
  // com dados do provider ERRADO/da rodada anterior.
  const genRef = useRef(0);

  const hits = useMemo(() => filterFuzzy(query, names), [query, names]);

  const openPicker = useCallback(() => {
    const declared = args.catalog?.listNames() ?? [];
    // F-MODEL-LIVE — o modelo ATIVO tem que aparecer SEMPRE, mesmo que ele não esteja
    // no catálogo declarado (o caso do dono: `xiaomi/mimo-v2.5-pro` não é um dos 5
    // slugs curados do `openrouter` embutido) — resolve o "picker não mostra nem o
    // modelo que já está em uso" sem depender da busca de rede terminar.
    const withActive = unionNames(declared, args.currentModel ? [args.currentModel] : []);
    setNames(withActive);
    setOpen(true);
    setQueryState('');
    setSelected(0);
    setUsingFallback(null);
    const gen = (genRef.current += 1);
    if (args.remoteNames === undefined) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void args
      .remoteNames()
      .then((res) => {
        if (gen !== genRef.current) return; // reaberto/trocado no meio do voo — descarta
        setLoading(false);
        setUsingFallback(!res.ok);
        // UNIÃO — nunca substituição: o que já estava mostrado (declarado + ativo)
        // continua presente mesmo quando a busca falha ou o provider omite o ativo.
        setNames((prev) => unionNames(prev, res.names));
      })
      .catch(() => {
        // `remoteNames` já não deveria lançar (contrato: falha vira `{ok:false}`), mas
        // um catch aqui garante que a UI nunca fica "carregando" pra sempre.
        if (gen !== genRef.current) return;
        setLoading(false);
        setUsingFallback(true);
      });
  }, [args.catalog, args.remoteNames, args.currentModel]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setQueryState('');
    setSelected(0);
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setSelected(0);
  }, []);

  const move = useCallback(
    (delta: number) => {
      setSelected((s) => {
        const max = Math.max(0, hits.length - 1);
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [hits.length],
  );

  const confirm = useCallback((): string | null => {
    const hit = hits[selected];
    if (hit) {
      closePicker();
      return hit.path;
    }
    const typed = query.trim();
    if (typed === '') return null;
    closePicker();
    return typed;
  }, [hits, selected, query, closePicker]);

  return {
    open,
    query,
    selected,
    hits,
    loading,
    usingFallback,
    openPicker,
    closePicker,
    setQuery,
    move,
    confirm,
  };
}
