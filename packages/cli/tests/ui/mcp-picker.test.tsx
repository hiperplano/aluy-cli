// <McpPicker> — o desenho das DUAS decisões: qual server, e ONDE gravar.
//
// O que estes casos protegem, além do desenho:
//   · a lista JANELA (a do registro é aberta — milhares de servers). Sem teto, a região viva
//     estoura `rows` e o Ink repinta a tela a cada quadro: é o tremor da rc.148 de volta.
//   · o escopo é PERGUNTADO e mostra o CAMINHO de cada opção. "global" e "projeto" sozinhos
//     não dizem onde o arquivo vai parar, e instalar no lugar errado só aparece dias depois.
//   · o que o server VAI PEDIR aparece ANTES de instalar. Descobrir a chave obrigatória
//     depois, com o server falhando, é o silêncio que este projeto persegue.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { McpPicker } from '../../src/ui/components/McpPicker.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import type { ItemMcp } from '../../src/mcp/mcp-picker-model.js';

const tema = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const item = (over: Partial<ItemMcp> & { name: string }): ItemMcp => ({
  title: over.name,
  description: 'um server',
  args: [],
  envObrigatorias: [],
  somenteRemoto: false,
  command: 'npx',
  ...over,
});

function texto(node: React.ReactElement): string {
  const { lastFrame } = render(<ThemeProvider theme={tema}>{node}</ThemeProvider>);
  // eslint-disable-next-line no-control-regex
  return (lastFrame() ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

describe('tela 1 — qual server', () => {
  it('mostra o TERMO buscado (sem isto o usuário esquece o que pediu)', () => {
    const t = texto(<McpPicker query="filesystem" itens={[item({ name: 'fs' })]} selected={0} />);
    expect(t).toContain('filesystem');
  });

  it('marca o selecionado', () => {
    const t = texto(
      <McpPicker query="q" itens={[item({ name: 'a' }), item({ name: 'b' })]} selected={1} />,
    );
    const linhas = t.split('\n');
    expect(linhas.find((l) => l.includes('b'))).toContain('›');
    expect(linhas.find((l) => l.includes(' a'))).not.toContain('›');
  });

  it('avisa o que o server PEDE, antes de instalar', () => {
    const t = texto(
      <McpPicker query="q" itens={[item({ name: 'x', envObrigatorias: ['API_KEY'] })]} selected={0} />,
    );
    expect(t).toContain('pede API_KEY');
  });

  it('server remoto aparece MARCADO como não-instalável (em vez de falhar depois)', () => {
    const t = texto(
      <McpPicker
        query="q"
        itens={[item({ name: 'r', somenteRemoto: true, command: undefined })]}
        selected={0}
      />,
    );
    expect(t).toContain('remoto');
  });

  it('JANELA: lista grande não despeja tudo, e diz quantos ficaram fora', () => {
    const muitos = Array.from({ length: 40 }, (_, i) => item({ name: `s${String(i)}` }));
    const t = texto(<McpPicker query="q" itens={muitos} selected={20} maxRows={6} />);
    const linhasDeItem = t.split('\n').filter((l) => /\bs\d+/.test(l));
    expect(linhasDeItem.length).toBeLessThanOrEqual(6);
    expect(t).toMatch(/acima/);
    expect(t).toMatch(/abaixo/);
  });

  it('nada encontrado ⇒ diz isso, não uma lista vazia muda', () => {
    expect(texto(<McpPicker query="xyz" itens={[]} selected={0} />)).toContain('nada encontrado');
  });

  it('buscando e falha têm tela própria (o erro não vai para um stderr apagado)', () => {
    expect(texto(<McpPicker query="q" itens={[]} selected={0} carregando />)).toContain('buscando');
    expect(texto(<McpPicker query="q" itens={[]} selected={0} erro="sem rede" />)).toContain('sem rede');
  });
});

describe('tela 2 — ONDE gravar (perguntado, nunca adivinhado)', () => {
  it('oferece global e projeto, dizendo o CAMINHO de cada um', () => {
    const t = texto(
      <McpPicker query="q" itens={[item({ name: 'x' })]} selected={0} escopoDe={item({ name: 'x' })} escopoSelecionado={0} />,
    );
    expect(t).toContain('global');
    expect(t).toContain('~/.aluy/mcp.json');
    expect(t).toContain('projeto');
    expect(t).toContain('.mcp.json');
  });

  it('marca o escopo selecionado', () => {
    const t = texto(
      <McpPicker query="q" itens={[]} selected={0} escopoDe={item({ name: 'x' })} escopoSelecionado={1} />,
    );
    // Ancorado no CAMINHO, não na palavra: a linha do `global` diz "vale em todos os
    // projetos", então procurar por "projeto" casava com ela primeiro e o teste reprovava
    // o comportamento certo. Substring que aparece nas duas opções não serve de âncora.
    const linha = t.split('\n').find((l) => l.includes('.mcp.json') && !l.includes('.aluy'));
    expect(linha, 'não achei a linha do escopo de PROJETO').toBeDefined();
    expect(linha).toContain('›');
  });

  // Se o server não dá para instalar, a tela do escopo não pode oferecer escolha nenhuma —
  // seria pedir uma decisão que não leva a lugar nenhum.
  it('server não-instalável ⇒ explica em vez de oferecer escopo', () => {
    const t = texto(
      <McpPicker
        query="q"
        itens={[]}
        selected={0}
        escopoDe={item({ name: 'r', somenteRemoto: true, command: undefined })}
      />,
    );
    expect(t).toContain('REMOTO');
    expect(t).not.toContain('~/.aluy/mcp.json');
  });
});
