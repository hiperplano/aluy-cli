// <McpPicker> — o resultado da busca de MCP como LISTA NAVEGÁVEL, e a escolha do escopo.
//
// Pedido do dono, repetido: "ele lista tudo, mas acho que deveria dizer no search via picker
// e nao numa tabela gigante para eu instalar fora". Antes, o `/mcp search` despejava texto e
// mandava você sair da TUI para montar `aluy mcp add <nome> -- <comando>` na mão.
//
// DUAS TELAS, porque são duas decisões:
//   1. QUAL server (↑↓ navega, enter escolhe, esc fecha)
//   2. ONDE gravar — global ou projeto. PERGUNTADO, nunca adivinhado: "vc tem que perguntar
//      se é para o projeto ou se é global, o usuario escolhe".
//
// Cada linha carrega o que decide a escolha: nome, descrição, versão e — o que mais importa
// — as variáveis OBRIGATÓRIAS que o server pede. Saber que ele vai exigir uma chave DEPOIS
// de instalar, com o server falhando, é a classe de silêncio que este projeto persegue.
//
// Apresentação PURA: a captura de teclas é da App; aqui só desenhamos.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { PickerFrame } from './PickerFrame.js';
import type { ItemMcp, EscopoMcp } from '../../mcp/mcp-picker-model.js';
import { motivoParaNaoInstalar } from '../../mcp/mcp-picker-model.js';

export interface McpPickerProps {
  /** O que o usuário buscou (fica no cabeçalho: sem isto ele esquece o termo). */
  readonly query: string;
  readonly itens: readonly ItemMcp[];
  readonly selected: number;
  /** `undefined` = escolhendo o server; definido = escolhendo ONDE gravar. */
  readonly escopoDe?: ItemMcp;
  /** Índice do escopo selecionado (0 = global, 1 = projeto). */
  readonly escopoSelecionado?: number;
  /** Buscando ainda? (a busca vai à rede) */
  readonly carregando?: boolean;
  /** Falha da busca — dita aqui, não num stderr que a TUI apaga. */
  readonly erro?: string;
  /** Teto de linhas da lista (a região viva não pode estourar — F88). */
  readonly maxRows?: number;
}

const ESCOPOS: readonly { readonly id: EscopoMcp; readonly rotulo: string; readonly onde: string }[] =
  [
    { id: 'global', rotulo: 'global', onde: '~/.aluy/mcp.json — vale em todos os projetos' },
    { id: 'projeto', rotulo: 'projeto', onde: '.mcp.json — vale só neste diretório' },
  ];

export function McpPicker(props: McpPickerProps): React.ReactElement {
  if (props.carregando === true) {
    return (
      <PickerFrame>
        <Role name="fgDim">{`buscando "${props.query}" no registro oficial…`}</Role>
      </PickerFrame>
    );
  }
  if (props.erro !== undefined) {
    return (
      <PickerFrame>
        <Role name="danger">{`a busca falhou: ${props.erro}`}</Role>
      </PickerFrame>
    );
  }

  // TELA 2 — onde gravar. Só aparece depois de escolher o server, e diz o CAMINHO de cada
  // opção: "global" e "projeto" sozinhos não dizem onde o arquivo vai parar.
  if (props.escopoDe !== undefined) {
    const impedimento = motivoParaNaoInstalar(props.escopoDe);
    return (
      <PickerFrame>
        <Box>
          <Role name="fg">{`instalar "${props.escopoDe.title}" onde?`}</Role>
        </Box>
        {impedimento !== undefined ? (
          <Box>
            <Role name="danger">{impedimento}</Role>
          </Box>
        ) : (
          ESCOPOS.map((e, i) => (
            <Box key={e.id}>
              <Role name={i === (props.escopoSelecionado ?? 0) ? 'accent' : 'fgDim'}>
                {i === (props.escopoSelecionado ?? 0) ? '› ' : '  '}
              </Role>
              <Role name="fg">{e.rotulo}</Role>
              <Role name="fgDim">{`  ${e.onde}`}</Role>
            </Box>
          ))
        )}
        <Box>
          <Role name="fgDim">
            {impedimento !== undefined ? 'esc fecha' : '↑↓ escolhe · enter instala · esc volta'}
          </Role>
        </Box>
      </PickerFrame>
    );
  }

  // TELA 1 — qual server.
  if (props.itens.length === 0) {
    return (
      <PickerFrame>
        <Role name="fgDim">{`nada encontrado para "${props.query}" no registro oficial.`}</Role>
      </PickerFrame>
    );
  }
  // JANELA (F88/anti-flicker): a lista é ABERTA (o registro tem milhares), então ela precisa
  // de teto — sem isto a região viva estoura `rows` e o Ink repinta a tela a cada quadro.
  const teto = Math.max(3, props.maxRows ?? 8);
  const inicio = Math.max(0, Math.min(props.selected - Math.floor(teto / 2), props.itens.length - teto));
  const janela = props.itens.slice(Math.max(0, inicio), Math.max(0, inicio) + teto);
  const escondidosAcima = Math.max(0, inicio);
  const escondidosAbaixo = Math.max(0, props.itens.length - (Math.max(0, inicio) + teto));

  return (
    <PickerFrame>
      <Box>
        <Role name="fg">{`servers MCP para "${props.query}"`}</Role>
        <Role name="fgDim">{`  (${String(props.itens.length)})`}</Role>
      </Box>
      {escondidosAcima > 0 && (
        <Box>
          <Role name="fgDim">{`  ↑ ${String(escondidosAcima)} acima`}</Role>
        </Box>
      )}
      {janela.map((it, i) => {
        const idx = Math.max(0, inicio) + i;
        const sel = idx === props.selected;
        const impedido = motivoParaNaoInstalar(it) !== undefined;
        return (
          <Box key={it.name}>
            <Role name={sel ? 'accent' : 'fgDim'}>{sel ? '› ' : '  '}</Role>
            <Role name={impedido ? 'fgDim' : 'fg'}>{it.title}</Role>
            {it.version !== undefined && <Role name="fgDim">{`  v${it.version}`}</Role>}
            {it.envObrigatorias.length > 0 && (
              // O que o server VAI PEDIR, dito ANTES de instalar.
              <Role name="accentDim">{`  pede ${it.envObrigatorias.join(', ')}`}</Role>
            )}
            {impedido && <Role name="fgDim">{'  (remoto — não instalável aqui)'}</Role>}
          </Box>
        );
      })}
      {escondidosAbaixo > 0 && (
        <Box>
          <Role name="fgDim">{`  ↓ ${String(escondidosAbaixo)} abaixo`}</Role>
        </Box>
      )}
      <Box>
        <Role name="fgDim">{'↑↓ navega · enter escolhe onde instalar · esc fecha'}</Role>
      </Box>
    </PickerFrame>
  );
}
