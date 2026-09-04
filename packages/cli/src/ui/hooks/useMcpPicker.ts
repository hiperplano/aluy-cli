// PICKER DE MCP — o ESTADO da tela (busca → escolha → escopo → instala).
//
// Pedido do dono, repetido: "ele lista tudo, mas acho que deveria dizer no search via picker
// e nao numa tabela gigante para eu instalar fora". E, sobre onde gravar: "vc tem que
// perguntar se é para o projeto ou se é global, o usuario escolhe".
//
// A busca e a escrita são PORTAS (injetadas pelo wiring): o hook não conhece rede nem
// disco. É o que permite testar o fluxo inteiro — inclusive o caminho em que a busca falha
// — sem tocar no registro oficial nem no `~/.aluy/mcp.json` de quem roda os testes.

import { useCallback, useState } from 'react';
import { itensDaBusca, motivoParaNaoInstalar, type ItemMcp, type EscopoMcp } from '../../mcp/mcp-picker-model.js';
import type { RegistrySearchResult } from '@hiperplano/aluy-cli-core';

/** Busca no registro. Devolve os resultados CRUS (a dedup é do modelo). */
export type McpSearchPort = (
  query: string,
) => Promise<
  { readonly ok: true; readonly results: readonly RegistrySearchResult[] } | { readonly ok: false; readonly reason: string }
>;

/** Escreve o server na config do escopo escolhido. */
export type McpInstallPort = (
  item: ItemMcp,
  escopo: EscopoMcp,
) => Promise<{ readonly ok: boolean; readonly detail: string }>;

export interface UseMcpPickerOptions {
  readonly search?: McpSearchPort;
  readonly install?: McpInstallPort;
  /** Para onde vai o desfecho (nota na conversa). */
  readonly onNota?: (titulo: string, linhas: readonly string[]) => void;
}

export function useMcpPicker(opts: UseMcpPickerOptions) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [itens, setItens] = useState<readonly ItemMcp[]>([]);
  const [selected, setSelected] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | undefined>(undefined);
  /** Definido = estamos na 2ª tela (onde gravar). */
  const [escopoDe, setEscopoDe] = useState<ItemMcp | undefined>(undefined);
  const [escopoSelecionado, setEscopoSelecionado] = useState(0);

  const fechar = useCallback(() => {
    setOpen(false);
    setEscopoDe(undefined);
    setItens([]);
    setErro(undefined);
    setCarregando(false);
  }, []);

  const abrir = useCallback(
    (q: string): void => {
      const termo = q.trim();
      if (termo === '' || opts.search === undefined) return;
      setOpen(true);
      setQuery(termo);
      setItens([]);
      setSelected(0);
      setEscopoDe(undefined);
      setErro(undefined);
      setCarregando(true);
      void opts
        .search(termo)
        .then((r) => {
          setCarregando(false);
          if (!r.ok) {
            setErro(r.reason);
            return;
          }
          setItens(itensDaBusca(r.results));
        })
        .catch((e: unknown) => {
          setCarregando(false);
          // A falha é DITA na tela do picker. Antes ela ia para uma nota (ou pior, sumia).
          setErro(e instanceof Error ? e.message : String(e));
        });
    },
    [opts],
  );

  const move = useCallback(
    (delta: number): void => {
      if (escopoDe !== undefined) {
        setEscopoSelecionado((s) => (s + delta + 2) % 2);
        return;
      }
      setItens((atuais) => {
        setSelected((s) => (atuais.length === 0 ? 0 : (s + delta + atuais.length) % atuais.length));
        return atuais;
      });
    },
    [escopoDe],
  );

  /** enter: da lista vai para o escopo; do escopo, instala. */
  const confirm = useCallback((): void => {
    if (escopoDe === undefined) {
      const item = itens[selected];
      if (item === undefined) return;
      setEscopoDe(item);
      setEscopoSelecionado(0);
      return;
    }
    const impedimento = motivoParaNaoInstalar(escopoDe);
    if (impedimento !== undefined) {
      opts.onNota?.('mcp', [impedimento]);
      fechar();
      return;
    }
    const escopo: EscopoMcp = escopoSelecionado === 0 ? 'global' : 'projeto';
    const alvo = escopoDe;
    fechar();
    if (opts.install === undefined) return;
    void opts
      .install(alvo, escopo)
      .then((r) => {
        opts.onNota?.('mcp', [
          r.detail,
          // O que o server PEDE é repetido no desfecho: na hora de instalar o dono estava
          // olhando a lista, e a linha do escopo já tinha rolado para fora.
          ...(alvo.envObrigatorias.length > 0
            ? [`este server pede: ${alvo.envObrigatorias.join(', ')} — defina antes de usar.`]
            : []),
        ]);
      })
      .catch((e: unknown) => {
        opts.onNota?.('mcp', [
          `não consegui instalar: ${e instanceof Error ? e.message : String(e)}`,
        ]);
      });
  }, [escopoDe, escopoSelecionado, fechar, itens, opts, selected]);

  /** esc: do escopo volta para a lista; da lista fecha. */
  const cancel = useCallback((): void => {
    if (escopoDe !== undefined) {
      setEscopoDe(undefined);
      return;
    }
    fechar();
  }, [escopoDe, fechar]);

  return {
    open,
    query,
    itens,
    selected,
    carregando,
    erro,
    escopoDe,
    escopoSelecionado,
    abrir,
    move,
    confirm,
    cancel,
  };
}
