// PICKER DE MCP — a lógica que o dono pediu várias vezes: buscar e instalar sem sair da TUI.
//
// "ele lista tudo, mas acho que deveria dizer no search via picker e nao numa tabela gigante
// para eu instalar fora" — e, sobre onde gravar: "vc tem que perguntar se é para o projeto
// ou se é global, o usuario escolhe".

import { describe, expect, it } from 'vitest';
import {
  dedupPorNome,
  itensDaBusca,
  itemDoResultado,
  nomeParaConfig,
  motivoParaNaoInstalar,
} from '../../src/mcp/mcp-picker-model.js';
import type { RegistrySearchResult } from '@hiperplano/aluy-cli-core';

const res = (over: Partial<RegistrySearchResult> & { name: string }): RegistrySearchResult => ({
  description: 'um server',
  run: { args: [], env: [], remoteUrls: [] },
  ...over,
});

describe('deduplicação — o registro devolve uma entrada POR VERSÃO', () => {
  // Medido ao vivo: numa amostra de cinco do registro oficial, QUATRO eram o mesmo
  // `ac.inference.sh/mcp` em versões diferentes. Sem agrupar, o picker nasceria com o mesmo
  // defeito da tabela que o dono reclamou.
  it('mesmo nome em várias versões ⇒ UMA linha', () => {
    const r = dedupPorNome([
      res({ name: 'ac.inference.sh/mcp', version: '1.0.0' }),
      res({ name: 'ac.inference.sh/mcp', version: '1.2.0' }),
      res({ name: 'ac.inference.sh/mcp', version: '1.1.0' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]?.version).toBe('1.2.0'); // fica a mais recente
  });

  it('nomes distintos preservam a ordem de chegada (o registro já ordena por relevância)', () => {
    const r = dedupPorNome([res({ name: 'b' }), res({ name: 'a' }), res({ name: 'c' })]);
    expect(r.map((x) => x.name)).toEqual(['b', 'a', 'c']);
  });

  it('sem versão declarada não quebra', () => {
    expect(dedupPorNome([res({ name: 'x' }), res({ name: 'x' })])).toHaveLength(1);
  });
});

describe('a linha que o picker mostra', () => {
  it('leva o que decide a escolha: título, descrição, versão e comando', () => {
    const i = itemDoResultado(
      res({
        name: 'io.github.acme/fs',
        title: 'Filesystem',
        description: 'acesso a arquivos',
        version: '2.1.0',
        run: { command: 'npx', args: ['-y', '@acme/fs'], env: [], remoteUrls: [] },
      }),
    );
    expect(i.title).toBe('Filesystem');
    expect(i.command).toBe('npx');
    expect(i.args).toEqual(['-y', '@acme/fs']);
  });

  // O usuário precisa saber ANTES de instalar que o server vai pedir uma chave — descobrir
  // isso depois, com o server falhando, é a classe de silêncio que este projeto persegue.
  it('mostra as variáveis OBRIGATÓRIAS que o server pede', () => {
    const i = itemDoResultado(
      res({
        name: 'x/y',
        run: {
          command: 'npx',
          args: [],
          env: [
            { name: 'API_KEY', required: true },
            { name: 'DEBUG', required: false },
          ],
          remoteUrls: [],
        },
      }),
    );
    expect(i.envObrigatorias).toEqual(['API_KEY']); // a opcional não polui a linha
  });

  it('a lista da busca já vem deduplicada', () => {
    const itens = itensDaBusca([res({ name: 'a', version: '1' }), res({ name: 'a', version: '2' })]);
    expect(itens).toHaveLength(1);
  });
});

describe('nome na config — legível, não o identificador do registro', () => {
  it('fica com o último segmento', () => {
    expect(nomeParaConfig('io.github.acme/filesystem')).toBe('filesystem');
  });

  it('sanea o que não pode virar chave', () => {
    expect(nomeParaConfig('x/meu server!')).toBe('meu-server');
  });

  it('nunca devolve vazio', () => {
    expect(nomeParaConfig('///')).toBe('mcp-server');
    expect(nomeParaConfig('!!!')).toBe('mcp-server');
  });
});

describe('o que NÃO dá para instalar — dito antes, não depois', () => {
  it('server só-remoto ⇒ recusa explicando', () => {
    const i = itemDoResultado(
      res({ name: 'x/y', run: { args: [], env: [], remoteUrls: ['https://x/y/sse'] } }),
    );
    expect(motivoParaNaoInstalar(i)).toContain('REMOTO');
  });

  it('sem comando no registro ⇒ recusa explicando', () => {
    const i = itemDoResultado(res({ name: 'x/y' }));
    expect(motivoParaNaoInstalar(i)).toContain('sem comando');
  });

  it('com comando local ⇒ pode instalar', () => {
    const i = itemDoResultado(
      res({ name: 'x/y', run: { command: 'npx', args: ['-y', 'p'], env: [], remoteUrls: [] } }),
    );
    expect(motivoParaNaoInstalar(i)).toBeUndefined();
  });
});
