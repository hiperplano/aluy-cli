// useMcpPicker — o FLUXO: busca → escolhe o server → escolhe ONDE → instala.
//
// As portas de busca e escrita são INJETADAS, então estes casos cobrem o caminho inteiro sem
// tocar no registro oficial nem no `~/.aluy/mcp.json` de quem roda os testes. Isso não é
// detalhe: nesta mesma sessão, um teste meu escreveu no cofre de credenciais REAL do dono
// por não ter injetado a porta.
//
// O hook é exercitado dentro de um componente Ink (padrão da casa — não há
// `@testing-library/react` aqui): o harness captura a instância e o teste dirige as ações.

import React from 'react';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { useMcpPicker } from '../../src/ui/hooks/useMcpPicker.js';
import type { RegistrySearchResult } from '@hiperplano/aluy-cli-core';

const achado = (name: string, over: Partial<RegistrySearchResult> = {}): RegistrySearchResult => ({
  name,
  description: 'server de teste',
  run: { command: 'npx', args: ['-y', name], env: [], remoteUrls: [] },
  ...over,
});

type Api = ReturnType<typeof useMcpPicker>;

function montar(over: Parameters<typeof useMcpPicker>[0] = {}) {
  const notas: { titulo: string; linhas: readonly string[] }[] = [];
  const install = vi.fn(async () => ({ ok: true, detail: 'instalado.' }));
  const search = vi.fn(async () => ({
    ok: true as const,
    results: [achado('a/um'), achado('b/dois')],
  }));
  let api: Api | undefined;
  function Harness(): React.ReactElement {
    api = useMcpPicker({
      search,
      install,
      onNota: (titulo, linhas) => notas.push({ titulo, linhas }),
      ...over,
    });
    return <Text>{api.open ? 'aberto' : 'fechado'}</Text>;
  }
  const r = render(<Harness />);
  const esperar = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (cond()) return;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error('condição não chegou a tempo');
  };
  return { get api(): Api { return api!; }, notas, install, search, esperar, unmount: r.unmount };
}

describe('o fluxo do picker de MCP', () => {
  it('abrir busca e mostra os resultados (já deduplicados)', async () => {
    const h = montar();
    h.api.abrir('filesystem');
    expect(h.search).toHaveBeenCalledWith('filesystem');
    await h.esperar(() => h.api.itens.length === 2);
    expect(h.api.open).toBe(true);
    expect(h.api.carregando).toBe(false);
    h.unmount();
  });

  // O ponto do pedido do dono: escolher o server NÃO é instalar. Falta dizer ONDE.
  it('enter na lista NÃO instala — leva para a escolha do escopo', async () => {
    const h = montar();
    h.api.abrir('q');
    await h.esperar(() => h.api.itens.length === 2);
    h.api.confirm();
    await h.esperar(() => h.api.escopoDe !== undefined);
    expect(h.api.escopoDe?.name).toBe('a/um');
    expect(h.install, 'instalou sem perguntar onde').not.toHaveBeenCalled();
    h.unmount();
  });

  it('só o SEGUNDO enter instala, com o escopo ESCOLHIDO', async () => {
    const h = montar();
    h.api.abrir('q');
    await h.esperar(() => h.api.itens.length === 2);
    h.api.confirm();
    await h.esperar(() => h.api.escopoDe !== undefined);
    h.api.move(1); // global → projeto
    await h.esperar(() => h.api.escopoSelecionado === 1);
    h.api.confirm();
    await h.esperar(() => h.install.mock.calls.length === 1);
    expect(h.install.mock.calls[0]?.[1]).toBe('projeto');
    h.unmount();
  });

  it('esc do escopo VOLTA para a lista (não fecha tudo)', async () => {
    const h = montar();
    h.api.abrir('q');
    await h.esperar(() => h.api.itens.length === 2);
    h.api.confirm();
    await h.esperar(() => h.api.escopoDe !== undefined);
    h.api.cancel();
    await h.esperar(() => h.api.escopoDe === undefined);
    expect(h.api.open, 'o esc do escopo fechou o picker inteiro').toBe(true);
    h.unmount();
  });

  // A falha da busca é DITA na tela do picker — não vai para um stderr apagado nem para uma
  // nota que rola para fora. É a lição que esta sessão inteira repetiu.
  it('busca que falha ⇒ o picker mostra o motivo', async () => {
    const h = montar({ search: async () => ({ ok: false as const, reason: 'sem rede' }) });
    h.api.abrir('q');
    await h.esperar(() => h.api.erro === 'sem rede');
    expect(h.api.carregando).toBe(false);
    h.unmount();
  });

  it('server não-instalável ⇒ explica e NÃO chama o instalador', async () => {
    const h = montar({
      search: async () => ({
        ok: true as const,
        results: [achado('r/remoto', { run: { args: [], env: [], remoteUrls: ['https://x/sse'] } })],
      }),
    });
    h.api.abrir('q');
    await h.esperar(() => h.api.itens.length === 1);
    h.api.confirm();
    await h.esperar(() => h.api.escopoDe !== undefined);
    h.api.confirm();
    await h.esperar(() => h.notas.length === 1);
    expect(h.install).not.toHaveBeenCalled();
    expect(h.notas[0]?.linhas.join(' ')).toContain('REMOTO');
    h.unmount();
  });

  it('o desfecho REPETE o que o server pede (a lista já rolou para fora)', async () => {
    const h = montar({
      search: async () => ({
        ok: true as const,
        results: [
          achado('x/y', {
            run: {
              command: 'npx',
              args: [],
              env: [{ name: 'API_KEY', required: true }],
              remoteUrls: [],
            },
          }),
        ],
      }),
    });
    h.api.abrir('q');
    await h.esperar(() => h.api.itens.length === 1);
    h.api.confirm();
    await h.esperar(() => h.api.escopoDe !== undefined);
    h.api.confirm();
    await h.esperar(() => h.notas.length === 1);
    expect(h.notas[0]?.linhas.join(' ')).toContain('API_KEY');
    h.unmount();
  });
});
