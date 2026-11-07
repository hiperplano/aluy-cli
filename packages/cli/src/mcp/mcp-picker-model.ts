// PICKER DE MCP — a LÓGICA pura por trás de "buscar e instalar sem sair da TUI".
//
// Pedido do dono, repetido: "ele lista tudo, mas acho que deveria dizer no search via picker
// e nao numa tabela gigante para eu instalar fora". Hoje o `/mcp search` despeja o resultado
// como texto e o usuário tem que sair, montar `aluy mcp add <nome> -- <comando>` na mão e
// voltar. As duas pontas já existiam (a busca no registro oficial e o escritor da config);
// faltava o meio.
//
// E o ESCOPO é PERGUNTADO, nunca adivinhado — decisão dele: "vc tem que perguntar se é para
// o projeto ou se é global, o usuario escolhe". Instalar no lugar errado é o tipo de erro
// que só aparece dias depois, quando o server some ao trocar de pasta (ou aparece onde não
// devia).
//
// PURO: sem React, sem I/O. Recebe os resultados já buscados e devolve o que a tela mostra e
// o que o instalador precisa. É isto que permite testar a deduplicação e a montagem do
// comando sem rede nem terminal.

import type { RegistrySearchResult } from '@hiperplano/aluy-cli-core';

/** Onde o server vai ser gravado. PERGUNTADO ao usuário, sem default silencioso. */
export type EscopoMcp = 'global' | 'projeto';

/** Uma linha do picker: um server, já sem as versões repetidas. */
export interface ItemMcp {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version?: string;
  readonly command?: string;
  readonly args: readonly string[];
  /** Variáveis que o server PEDE — o usuário precisa saber ANTES de instalar. */
  readonly envObrigatorias: readonly string[];
  /** Só remoto (HTTP/SSE): o `add` local não serve, e dizer isso é melhor que falhar depois. */
  readonly somenteRemoto: boolean;
}

/**
 * Agrupa por NOME e fica com a versão mais recente.
 *
 * O registro devolve uma entrada POR VERSÃO: numa amostra de cinco, quatro eram o mesmo
 * `ac.inference.sh/mcp`. Sem agrupar, o picker nasceria com o mesmo defeito da tabela que o
 * dono reclamou — uma parede de repetidos. A ordem de chegada é preservada entre nomes
 * distintos (o registro já ordena por relevância da busca).
 */
export function dedupPorNome(
  results: readonly RegistrySearchResult[],
): readonly RegistrySearchResult[] {
  const porNome = new Map<string, RegistrySearchResult>();
  for (const r of results) {
    const atual = porNome.get(r.name);
    if (atual === undefined) {
      porNome.set(r.name, r);
      continue;
    }
    // Sem semver aqui de propósito: o registro não garante o formato, e um parser errado
    // escolheria a versão errada em silêncio. Comparação de string cobre o caso comum
    // (`1.2.3` < `1.10.0` erra, e é um erro VISÍVEL — a versão aparece na linha).
    const nova = r.version ?? '';
    const velha = atual.version ?? '';
    if (nova > velha) porNome.set(r.name, r);
  }
  return [...porNome.values()];
}

/** Converte um resultado do registro na linha que o picker mostra. */
export function itemDoResultado(r: RegistrySearchResult): ItemMcp {
  const somenteRemoto = r.run.command === undefined && r.run.remoteUrls.length > 0;
  return {
    name: r.name,
    title: r.title ?? r.name,
    description: r.description,
    ...(r.version !== undefined ? { version: r.version } : {}),
    ...(r.run.command !== undefined ? { command: r.run.command } : {}),
    args: r.run.args,
    envObrigatorias: r.run.env.filter((e) => e.required).map((e) => e.name),
    somenteRemoto,
  };
}

/** A lista pronta para a tela, a partir do que a busca devolveu. */
export function itensDaBusca(results: readonly RegistrySearchResult[]): readonly ItemMcp[] {
  return dedupPorNome(results).map(itemDoResultado);
}

/**
 * O nome CURTO do server na config. O registro usa nomes com barra (`io.github.x/servidor`),
 * e a chave em `mcpServers` fica ilegível assim — além de o `/mcp remove <nome>` virar um
 * exercício de digitação. Ficamos com o último segmento, saneado.
 */
export function nomeParaConfig(name: string): string {
  const ultimo = name.split('/').filter((p) => p !== '').pop() ?? name;
  const limpo = ultimo.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return limpo === '' ? 'mcp-server' : limpo;
}

/** O que impede a instalação, se algo impedir. `undefined` = pode instalar. */
export function motivoParaNaoInstalar(item: ItemMcp): string | undefined {
  if (item.somenteRemoto) {
    return 'este server é REMOTO (HTTP/SSE) — o `add` local não o cobre; configure a URL à mão.';
  }
  if (item.command === undefined) {
    return 'o registro não informa como executar este server (sem comando) — nada a instalar.';
  }
  return undefined;
}
