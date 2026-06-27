// EST-0948 · spec §2.15 · CA-3 — <SlashMenu>: lista filtrável de comandos.
//
// `/` abre o menu com filtro incremental (digitar filtra; ↑↓ navega; enter/tab
// completa). Comandos NATIVOS agrupados em SEÇÕES (conta/sessão/workspace) +
// comandos do USUÁRIO (dado de ~/.aluy/commands/) sob uma régua. `/model` mostra o
// TIER, nunca provider (HG-2). Selecionado em accent + prefixo `›` (a11y: não só
// cor). MATCH destacado: o trecho filtrado realça em âmbar dentro do nome.
//
// EST-0974 — o menu lista ENTRADAS (SlashMenuEntry): comandos E subcomandos achatados
// (`/mcp`, `/mcp search`, `/mcp add`, …) pra os subs serem DESCOBRÍVEIS no mesmo nível
// e filtráveis por substring. O sub renderiza o caminho completo (`/mcp search`),
// indentado sob o pai, com o realce casando o trecho filtrado no caminho.

import React from 'react';
import { Box, Text } from 'ink';
import { Role } from '../theme/index.js';
import {
  entryPath,
  entrySection,
  entrySummary,
  windowSlashEntries,
  type SlashMenuEntry,
  type SlashSection,
} from '../../slash/commands.js';

export interface SlashMenuProps {
  readonly commands: readonly SlashMenuEntry[];
  /** Índice do item selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Query corrente (após a `/`) p/ destacar o trecho que casa. */
  readonly query?: string;
  /**
   * EST-1015 (fix menu-fantasma) — TETO de linhas que o menu pode ocupar. Acima dele a lista é
   * JANELADA (centrada no selecionado) p/ a região viva NÃO estourar `rows` (senão o Ink entra
   * no caminho full-screen e o menu deixa fantasma ao fechar). Ausente ⇒ sem teto (comportamento
   * antigo — usado onde a altura já é bounded, ex.: o cockpit clipa por conta própria).
   */
  readonly maxRows?: number;
  /**
   * F89 (wrap-aware) — largura do terminal. Quando presente, a janela conta LINHAS VISUAIS
   * (cada entrada `/cmd  summary` QUEBRA num terminal estreito) em vez de itens, evitando o
   * estouro de `rows` em cols < ~44. Ausente ⇒ janela por linha-fonte (largo, inalterado).
   */
  readonly columns?: number;
}

/** Caminho (`mcp` ou `mcp search`) com o trecho que casa a query realçado em âmbar. */
function HighlightedPath(props: {
  path: string;
  query: string;
  sel: boolean;
  sub: boolean;
}): React.ReactElement {
  const base = props.sel ? 'accent' : props.sub ? 'fgDim' : 'fg';
  const q = props.query.trim().replace(/\s+/g, ' ').toLowerCase();
  const idx = q ? props.path.toLowerCase().indexOf(q) : -1;
  if (idx < 0 || q === '') {
    return <Role name={base}>/{props.path}</Role>;
  }
  const before = props.path.slice(0, idx);
  const match = props.path.slice(idx, idx + q.length);
  const after = props.path.slice(idx + q.length);
  return (
    <>
      <Role name={base}>/{before}</Role>
      <Role name="accent">{match}</Role>
      <Role name={base}>{after}</Role>
    </>
  );
}

export function SlashMenu(props: SlashMenuProps): React.ReactElement {
  const query = props.query ?? '';
  // EST-1015 (fix menu-fantasma) — JANELA a lista p/ caber em `maxRows` (centrada no selecionado).
  // Sem teto (`maxRows` ausente) ⇒ mostra tudo (comportamento antigo). O `start` reata o índice
  // selecionado ao da fatia p/ o `›` cair no item certo.
  const win =
    props.maxRows !== undefined
      ? windowSlashEntries(props.commands, props.selected, props.maxRows, props.columns)
      : { slice: props.commands, hiddenAbove: 0, hiddenBelow: 0 };
  const selectedInSlice = props.selected - win.hiddenAbove;
  // Render preservando a ORDEM (já é a ordem de filterCommands), inserindo um
  // cabeçalho de seção quando a seção muda em relação ao item anterior.
  let lastSection: SlashSection | null = null;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">/ para comandos · ↑↓ navega · enter executa · esc fecha</Role>
      </Box>
      {win.hiddenAbove > 0 && (
        <Box>
          <Role name="fgDim"> ↑ {win.hiddenAbove} acima</Role>
        </Box>
      )}
      {win.slice.map((entry, i) => {
        const isSel = i === selectedInSlice;
        const section = entrySection(entry);
        const header = section !== lastSection ? section : null;
        lastSection = section;
        const path = entryPath(entry);
        const isSub = entry.kind === 'subcommand';
        // Subcomando indenta mais (sob o pai) p/ a hierarquia ler de relance.
        const indent = isSel ? '› ' : isSub ? '    ' : '  ';
        return (
          <React.Fragment key={`${section}:${path}`}>
            {header && (
              <Box>
                <Role name="fgDim">{header === 'usuário' ? '─── seus comandos' : header}</Role>
              </Box>
            )}
            <Box>
              {/* prefixo › no selecionado (a11y: não só cor) */}
              <Role name={isSel ? 'accent' : 'fgDim'}>{indent}</Role>
              <HighlightedPath path={path} query={query} sel={isSel} sub={isSub} />
              <Text>{' '.repeat(Math.max(1, 18 - path.length))}</Text>
              <Role name="fgDim">{entrySummary(entry)}</Role>
            </Box>
          </React.Fragment>
        );
      })}
      {win.hiddenBelow > 0 && (
        <Box>
          <Role name="fgDim"> ↓ {win.hiddenBelow} mais (refine a busca)</Role>
        </Box>
      )}
    </Box>
  );
}
