// FOOTER-AGENTES — os sub-agentes vivos numa coluna abaixo do composer.
//
// Pedido do dono: "e possivel colocar tambem os agentes abaixo do composer, aonde fica o
// footer hoje... para conseguirmos nao perder a visao dos agentes que podem ser adicionados
// ao longo de uma conversa e ai embaixo deles fica essas informacoes e vc move todo o
// conteudo do header pra direita separando por uma barra vertical".
//
// A contagem no indicador de trabalho responde "há trabalho". Ela não responde QUEM nem
// FAZENDO O QUÊ — e numa conversa em que agentes entram ao longo do caminho, é a segunda
// pergunta que se perde.
//
// O que este arquivo protege, além do desenho: a ALTURA. O bloco tem altura FIXA (um bloco
// que cresce a cada filho mudaria a altura do frame o tempo todo) e o excedente que ele
// traz ENTRA no orçamento — as duas coisas que a caçada ao tremor da rc.148 ensinou.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { FooterAgents, linhasDoRodape, linhaAgente, formataDuracao } from '../../src/ui/components/FooterAgents.js';
import {
  LINHAS_RODAPE_AGENTES,
  rodapeAgentesOverhead,
  colunasDoPainel,
  larguraColunaAgentes,
  linhasDoPainel,
} from '../../src/session/footer-agents-layout.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import type { LiveSubagent } from '../../src/session/model.js';

const agente = (label: string, over: Partial<LiveSubagent> = {}): LiveSubagent => ({
  label,
  phase: 'running',
  durationMs: 42_000,
  ...over,
});

const painel = (
  <Box flexDirection="column">
    <Text>{'sessao'}</Text>
    <Text>{'uso'}</Text>
  </Box>
);

function linhas(node: React.ReactElement): string[] {
  const { lastFrame } = render(<ThemeProvider theme={resolveTheme('escuro')}>{node}</ThemeProvider>);
  // eslint-disable-next-line no-control-regex
  return ((lastFrame() ?? '').replace(/\u001b\[[0-9;]*m/g, '')).split('\n');
}

describe('FooterAgents — altura FIXA', () => {
  it('1, 3 ou 7 agentes ⇒ SEMPRE a mesma altura', () => {
    for (const n of [1, 3, 7, 20]) {
      const lista = Array.from({ length: n }, (_, i) => agente(`a${String(i)}`));
      expect(linhasDoRodape(lista, 30)).toHaveLength(LINHAS_RODAPE_AGENTES);
    }
  });

  it('excedente vira "+K outros" em vez de mais linhas', () => {
    const l = linhasDoRodape(Array.from({ length: 7 }, (_, i) => agente(`a${String(i)}`)), 30);
    expect(l[LINHAS_RODAPE_AGENTES - 1]).toBe('+4 outros');
  });

  it('sem agentes ⇒ NENHUMA linha (o bloco não existe)', () => {
    expect(linhasDoRodape([], 30)).toEqual([]);
  });
});

describe('FooterAgents — o que sobrevive ao corte', () => {
  // A coluna é estreita e o corte vem da direita. QUEM e HÁ QUANTO TEMPO são o que responde
  // "isto travou?" — a pergunta que faz o dono apertar F8. A atividade é detalhe.
  it('rótulo e tempo sobrevivem; a atividade é a primeira a sair', () => {
    const a = agente('analista-clima', { activity: { tool: 'read', target: 'clima.md' } });
    const curto = linhaAgente(a, 22);
    expect(curto).toContain('analista-clima');
    expect(curto).toContain('0:42');
    expect(curto).not.toContain('clima.md');
  });

  it('com espaço, a atividade entra', () => {
    const a = agente('revisor', { activity: { tool: 'grep', target: 'src/' } });
    expect(linhaAgente(a, 40)).toContain('grep src/');
  });

  // Reticência colada no relógio lê como "o tempo foi cortado" — e o que ficou de fora era
  // a atividade. Campo ausente é melhor que reticência apontando para o campo errado.
  it('não deixa reticência sugerindo que o TEMPO foi cortado', () => {
    const a = agente('historiador-fiction', {});
    const l = linhaAgente(a, 26);
    expect(l).toContain('0:42');
    expect(l.endsWith('…')).toBe(false);
  });

  it('formataDuracao é m:ss', () => {
    expect(formataDuracao(0)).toBe('0:00');
    expect(formataDuracao(5_000)).toBe('0:05');
    expect(formataDuracao(65_000)).toBe('1:05');
    expect(formataDuracao(-1)).toBe('0:00');
  });
});

describe('FooterAgents — o desenho', () => {
  it('sem agentes é PASSAGEM DIRETA: a tela de quem não dispara agente não muda', () => {
    const com = linhas(<FooterAgents agentes={[]} largura={30}>{painel}</FooterAgents>);
    const sem = linhas(<>{painel}</>);
    expect(com).toEqual(sem);
  });

  it('com agentes: barra vertical separando as duas colunas, em TODA linha', () => {
    const l = linhas(
      <FooterAgents agentes={[agente('a'), agente('b')]} largura={30}>{painel}</FooterAgents>,
    );
    expect(l).toHaveLength(LINHAS_RODAPE_AGENTES);
    for (const linha of l) expect(linha).toContain('│');
  });

  it('o painel fica à DIREITA da barra e os agentes à esquerda', () => {
    const l = linhas(<FooterAgents agentes={[agente('meu-agente')]} largura={30}>{painel}</FooterAgents>);
    const primeira = l[0]!;
    expect(primeira.indexOf('meu-agente')).toBeLessThan(primeira.indexOf('│'));
    expect(primeira.indexOf('sessao')).toBeGreaterThan(primeira.indexOf('│'));
  });
});

describe('FOOTER-AGENTES — a altura entra no orçamento', () => {
  it('sem agentes ⇒ desconto ZERO (não-regressão de quem nunca dispara agente)', () => {
    expect(rodapeAgentesOverhead(false, 120)).toBe(0);
    expect(rodapeAgentesOverhead(false, 60)).toBe(0);
  });

  it('terminal LARGO: o painel pareava em 2 linhas e passa a 4 ⇒ excedente 2', () => {
    // 120 colunas: hoje o painel cabe em duas colunas (2 linhas). Com a coluna de agentes
    // ele encolhe e empilha, e o bloco todo passa a ter a altura fixa da coluna.
    expect(linhasDoPainel(120 - 2)).toBe(2);
    expect(rodapeAgentesOverhead(true, 120)).toBe(LINHAS_RODAPE_AGENTES - 2);
  });

  it('terminal ESTREITO: o painel JÁ empilhava ⇒ excedente ZERO (cabe de graça)', () => {
    expect(linhasDoPainel(70 - 2)).toBe(4);
    expect(rodapeAgentesOverhead(true, 70)).toBe(0);
  });

  it('a largura tirada do painel é a mesma que a coluna ocupa (a conta fecha)', () => {
    for (const cols of [60, 80, 100, 120, 200]) {
      const gasto = cols - 2 - colunasDoPainel(cols, true);
      expect(gasto).toBe(larguraColunaAgentes(cols) + 2); // +2 = barra + respiro
    }
  });
});
