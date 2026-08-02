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

import { useCallback, useMemo, useState } from 'react';
import { filterFuzzy, type FuzzyHit } from '../../attach/index.js';

/** Porta do catálogo LOCAL (ADR-0152/0153) — os slugs conhecidos do provider ativo. */
export interface LocalModelCatalogPort {
  /** Declarados ∪ registrados-na-sessão. `undefined` ⇒ catálogo não listável. */
  readonly listNames: () => readonly string[] | undefined;
}

export interface UseLocalModelPickerArgs {
  /** Fonte dos candidatos. Ausente ⇒ o picker sempre degrada p/ texto-livre. */
  readonly catalog?: LocalModelCatalogPort;
  /** Slug do modelo LOCAL ativo (p/ a UI marcar o ●). Cosmético — não afeta `confirm`. */
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
  /** Abre o picker (reconsulta o catálogo — pode ter crescido desde a última abertura). */
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

export function useLocalModelPicker(args: UseLocalModelPickerArgs): LocalModelPickerController {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [selected, setSelected] = useState(0);
  const [names, setNames] = useState<readonly string[]>([]);

  const hits = useMemo(() => filterFuzzy(query, names), [query, names]);

  const openPicker = useCallback(() => {
    setNames(args.catalog?.listNames() ?? []);
    setOpen(true);
    setQueryState('');
    setSelected(0);
  }, [args.catalog]);

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
    openPicker,
    closePicker,
    setQuery,
    move,
    confirm,
  };
}
