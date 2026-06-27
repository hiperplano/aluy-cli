// EST-0957 — hook do canal `@arquivo`: estado do picker + lista de chips anexados.
//
// Tira da App a máquina de estado do `@` (abrir/filtrar/navegar/confirmar/fechar) e
// a lista de anexos do turno (chips removíveis). O hook NÃO faz I/O de teclado (a
// App captura via `useInput` e chama os métodos daqui) nem decide confinamento (o
// `AttachReader` injetado faz). Mantém a App como casca fina e isto testável.
//
// O ÍNDICE de arquivos é carregado preguiçosamente na 1ª abertura do picker (uma
// varredura confinada, efêmera) e reusado enquanto a sessão vive.

import { useCallback, useMemo, useRef, useState } from 'react';
import { filterFuzzy, isPickable, type FuzzyHit } from '../../attach/index.js';
import type { FileIndexPort } from '../../io/index.js';
import type { AttachReader } from '../../attach/index.js';
import type { HistoryItem } from '@hiperplano/aluy-cli-core';

/** Um arquivo anexado ao turno (chip + o item rotulado p/ o loop). */
export interface Attachment {
  readonly path: string;
  readonly item: HistoryItem;
  readonly truncated: boolean;
}

export interface UseFilePickerArgs {
  readonly fileIndex: FileIndexPort;
  readonly attachReader: AttachReader;
}

export interface FilePickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Query corrente (texto após o `@`). */
  readonly query: string;
  /** Índice selecionado. */
  readonly selected: number;
  /** Resultados fuzzy correntes (já filtrados pela query). */
  readonly hits: readonly FuzzyHit[];
  /** Anexos do turno (chips). */
  readonly attachments: readonly Attachment[];
  /**
   * Motivo da ÚLTIMA recusa de anexo (path-deny `deny`/`ask`, escape, ilegível) —
   * `null` quando não há recusa pendente. A App surfaceia isto como aviso na TUI
   * (papel do DS) p/ a recusa nunca falhar MUDA (revisor #3). Some na próxima ação.
   */
  readonly notice: string | null;
  /** Abre o picker (1ª vez carrega o índice). */
  openPicker(): void;
  /** Fecha o picker (esc) sem anexar. */
  closePicker(): void;
  /** Atualiza a query (digitação) e recomputa os hits. */
  setQuery(query: string): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /** Confirma o item selecionado: lê+confina+anexa. Devolve o path ou null. */
  confirm(): Promise<string | null>;
  /** Remove o último chip (backspace no input vazio). */
  removeLast(): void;
  /** Limpa os anexos (após enviar o turno). */
  clear(): void;
  /** Descarta o aviso de recusa corrente (ex.: o usuário seguiu digitando). */
  dismissNotice(): void;
  /** Anexa um caminho LITERAL (fallback `@path`/teste). Devolve path ou null. */
  attachPath(path: string, confirmSensitive?: boolean): Promise<string | null>;
}

export function useFilePicker(args: UseFilePickerArgs): FilePickerController {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [selected, setSelected] = useState(0);
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const hits = useMemo(() => filterFuzzy(query, paths), [query, paths]);

  const loadIndex = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      // R1 (seguranca) + revisor: o picker NUNCA oferece caminhos sensíveis. `deny`
      // (chave/credencial) e `ask` (`.env`/`*token*`/`*secret*`) somem do índice por
      // padrão (a spec diz isso) — só entram por caminho LITERAL explícito + confirmação
      // (via `attachPath`/não-TTY). Espelha o path-deny da catraca: o `@` não vira bypass.
      const all = await args.fileIndex.list();
      setPaths(all.filter((p) => isPickable(p)));
    } catch {
      setPaths([]);
    }
  }, [args.fileIndex]);

  const openPicker = useCallback(() => {
    setOpen(true);
    setQueryState('');
    setSelected(0);
    void loadIndex();
  }, [loadIndex]);

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

  const doAttach = useCallback(
    async (path: string, confirmSensitive?: boolean): Promise<string | null> => {
      const res = await args.attachReader.attach(
        path,
        confirmSensitive !== undefined ? { confirmSensitive } : {},
      );
      if (res.kind === 'rejected') {
        // Revisor #3: a recusa NÃO falha muda — surfacea o motivo p/ a TUI mostrar
        // (o título do aviso já diz "anexo recusado"; aqui vai só `@path — motivo`).
        setNotice(`@${res.path || path} — ${res.reason}`);
        return null;
      }
      setNotice(null); // anexo OK limpa qualquer aviso anterior.
      // Dedup: mesmo caminho não anexa duas vezes.
      setAttachments((prev) =>
        prev.some((a) => a.path === res.path)
          ? prev
          : [...prev, { path: res.path, item: res.item, truncated: res.truncated }],
      );
      return res.path;
    },
    [args.attachReader],
  );

  const confirm = useCallback(async (): Promise<string | null> => {
    const hit = hits[selected];
    closePicker();
    if (!hit) return null;
    return doAttach(hit.path);
  }, [hits, selected, closePicker, doAttach]);

  // FU (não nesta entrega): remoção de chip ARBITRÁRIO (hoje só `removeLast`) —
  // ex.: `removeAt(index)`/`remove(path)` p/ tirar um anexo do meio sem desfazer
  // os posteriores (precisa de navegação entre chips na App).
  const removeLast = useCallback(() => {
    setAttachments((prev) => (prev.length === 0 ? prev : prev.slice(0, -1)));
  }, []);

  const clear = useCallback(() => setAttachments([]), []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    open,
    query,
    selected,
    hits,
    attachments,
    notice,
    openPicker,
    closePicker,
    setQuery,
    move,
    confirm,
    removeLast,
    clear,
    dismissNotice,
    attachPath: doAttach,
  };
}
