// O manifesto de plugin — e a fronteira de confiança que ele cria.
//
// Pedido do dono (10/09/2026): "quero que você tenha a opção de plugins do aluy como no
// claude". O que estes casos travam não é o formato do JSON — é o que acontece quando o
// conteúdo vem de TERCEIRO.
//
// Os loaders de hoje separam config do DONO (confiável, entra na auto-seleção) de dado de
// PROJETO (não-confiável). Plugin não é nenhum dos dois, e o conteúdo é executável em
// efeito: agente `.md` declara `tools:`, hook roda comando, `mcp.json` aponta servidor. Por
// isso o nome vira prefixo obrigatório e o parser falha FECHADO.

import { describe, expect, it } from 'vitest';
import {
  parseManifesto,
  rotuloDeItem,
  descricaoDeOrigem,
  TIPOS_DE_EXTENSAO,
} from '../../src/plugin/manifest.js';

const ok = (o: Record<string, unknown>) => parseManifesto(JSON.stringify(o));

describe('parseManifesto — falha FECHADA em toda borda', () => {
  it('o mínimo é o nome', () => {
    expect(ok({ name: 'meu-plugin' })).toEqual({ manifest: { name: 'meu-plugin' } });
  });

  it('carrega versão e descrição quando vêm', () => {
    expect(ok({ name: 'pl', version: '1.2.0', description: 'faz x' })).toEqual({
      manifest: { name: 'pl', version: '1.2.0', description: 'faz x' },
    });
  });

  it('JSON inválido é ERRO, não plugin vazio', () => {
    expect(parseManifesto('{ não é json')).toHaveProperty('error');
  });

  it('array ou primitivo no lugar de objeto é erro', () => {
    for (const b of ['[]', '"x"', '42', 'null']) {
      expect(parseManifesto(b), b).toHaveProperty('error');
    }
  });

  it('sem nome não há plugin — o nome é o que rotula a proveniência', () => {
    expect(ok({ version: '1.0' })).toHaveProperty('error');
    expect(ok({ name: '   ' })).toHaveProperty('error');
  });
});

describe('o charset do nome fecha travessia e ambiguidade', () => {
  it('recusa barra e ponto-ponto — o nome vira PASTA no disco', () => {
    for (const n of ['../etc', 'a/b', '..', './x', 'a\\b']) {
      expect(ok({ name: n }), n).toHaveProperty('error');
    }
  });

  it('recusa espaço e maiúscula — dois plugins que PARECEM o mesmo', () => {
    // `meu plugin:x` não se lê; `Revisor` e `revisor` seriam indistinguíveis na tela.
    for (const n of ['meu plugin', 'Revisor', 'REV', 'com acentuação']) {
      expect(ok({ name: n }), n).toHaveProperty('error');
    }
  });

  it('recusa nome que começa ou termina em hífen, e o vazio-ish', () => {
    for (const n of ['-x', 'x-', '-', 'a']) {
      expect(ok({ name: n }), n).toHaveProperty('error');
    }
  });

  it('aceita o que é legível e seguro', () => {
    for (const n of ['ab', 'meu-plugin', 'rev2', 'a-b-c-1']) {
      expect(ok({ name: n }), n).toHaveProperty('manifest');
    }
  });

  it('CONTROLE: a validação não recusa tudo — senão os casos acima seriam vazios', () => {
    expect(ok({ name: 'plugin-de-teste' })).toHaveProperty('manifest');
  });
});

describe('tetos — texto de terceiro não estica a UI', () => {
  it('corta descrição e versão gigantes', () => {
    const r = ok({ name: 'pl', description: 'd'.repeat(9_000), version: 'v'.repeat(9_000) });
    expect(r).toHaveProperty('manifest');
    if ('manifest' in r) {
      expect(r.manifest.description!.length).toBeLessThanOrEqual(200);
      expect(r.manifest.version!.length).toBeLessThanOrEqual(40);
    }
  });

  it('campo com TIPO errado é ignorado, não chutado', () => {
    const r = ok({ name: 'pl', version: 42, description: ['x'] });
    expect(r).toEqual({ manifest: { name: 'pl' } });
  });
});

describe('rótulo e proveniência — o prefixo NÃO é decoração', () => {
  it('prefixa o item com o plugin de origem', () => {
    // Sem isto, um `revisor` de plugin fica indistinguível de um `~/.aluy/agents/revisor.md`
    // escrito pelo dono — e é essa confusão que faria código de terceiro herdar a confiança
    // da config dele.
    expect(rotuloDeItem('meu-plugin', 'revisor')).toBe('meu-plugin:revisor');
  });

  it('a origem é uma TERCEIRA, ao lado de global e projeto', () => {
    expect(descricaoDeOrigem('meu-plugin')).toBe('plugin · meu-plugin');
  });
});

describe('os tipos de extensão espelham os diretórios que já existem', () => {
  it('cobre agents, commands, skills, workflows e hooks', () => {
    expect([...TIPOS_DE_EXTENSAO].sort()).toEqual([
      'agents',
      'commands',
      'hooks',
      'skills',
      'workflows',
    ]);
  });
});
