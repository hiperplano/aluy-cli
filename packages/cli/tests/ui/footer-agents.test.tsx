// FOOTER-AGENTES — o LOTE de sub-agentes no rodapé, com o desenho que o dono escolheu:
// conectores de árvore, spinner por agente vivo, e o consumo AO VIVO.
//
// O caminho até aqui, porque cada volta deixou uma regra:
//   · "não perder a visao dos agentes que podem ser adicionados ao longo de uma conversa"
//     ⇒ o bloco existe;
//   · "eu nao vi ainda os agentes no footer apesar de ter instalado" ⇒ a lista vinha vazia
//     por causa de um `phase === 'running'` que NÃO EXISTE neste vocabulário;
//   · "poderia ser um desenho um pouco mais rico" ⇒ árvore + spinner + consumo;
//   · "tira a barra do consumo" ⇒ sobrou o número;
//   · e a medição mostrou que só cabia com o cabeçalho em linha PRÓPRIA (o rótulo alinhado
//     custava 9 colunas em toda linha).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import {
  FooterAgents,
  linhaAgente,
  ordenaParaRodape,
  agenteVivo,
  agentesQueCabem,
  formataDuracao,
  formataTokens,
} from '../../src/ui/components/FooterAgents.js';
import { LINHAS_RODAPE_AGENTES } from '../../src/session/footer-agents-layout.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import type { LiveSubagent } from '../../src/session/model.js';

const vivo = (label: string, over: Partial<LiveSubagent> = {}): LiveSubagent => ({
  label,
  phase: 'thinking',
  durationMs: 30_000,
  tokens: 1000,
  ...over,
});
const falhou = (label: string): LiveSubagent => vivo(label, { phase: 'failed', tokens: 0 });
const pronto = (label: string): LiveSubagent => vivo(label, { phase: 'done', tokens: 5000 });

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

describe('ordem — quem trabalha é a notícia', () => {
  // A primeira versão punha as FALHAS na frente. Parecia certo no papel; o desenho mostrou
  // o erro na hora: num lote com 5 falhas e 2 rodando, as falhas tomavam todos os lugares e
  // quem TRABALHAVA ia para o "+K" — o spinner nunca aparecia.
  it('vivos primeiro, depois falhas, prontos por último', () => {
    const ordem = ordenaParaRodape([
      pronto('p1'),
      falhou('f1'),
      vivo('v1'),
      falhou('f2'),
      vivo('v2'),
    ]).map((a) => a.label);
    expect(ordem).toEqual(['v1', 'v2', 'f1', 'f2', 'p1']);
  });

  it('quando TODOS terminam, as falhas sobem sozinhas (sem precisar de modo)', () => {
    const ordem = ordenaParaRodape([pronto('p1'), falhou('f1'), pronto('p2')]).map((a) => a.label);
    expect(ordem).toEqual(['f1', 'p1', 'p2']);
  });

  it('estável dentro do grupo — preserva a ordem de disparo', () => {
    const ordem = ordenaParaRodape([vivo('a'), vivo('b'), vivo('c')]).map((x) => x.label);
    expect(ordem).toEqual(['a', 'b', 'c']);
  });

  it('o vocabulário de vivo é o da ÁRVORE, não um `running` inventado', () => {
    for (const p of ['thinking', 'tool', 'asking']) expect(agenteVivo(vivo('x', { phase: p }))).toBe(true);
    for (const p of ['done', 'failed', 'cancelled']) expect(agenteVivo(vivo('x', { phase: p }))).toBe(false);
  });
});

describe('altura — constante, dê no que der', () => {
  it('1, 3 ou 30 agentes ⇒ SEMPRE a mesma altura', () => {
    const alturas = new Set<number>();
    for (const n of [1, 3, 5, 30]) {
      const lote = Array.from({ length: n }, (_, i) => vivo(`a${String(i)}`));
      alturas.add(linhas(<FooterAgents agentes={lote} largura={48}>{painel}</FooterAgents>).length);
    }
    expect(alturas.size).toBe(1);
    expect([...alturas][0]).toBe(LINHAS_RODAPE_AGENTES);
  });

  it('o excedente vira "+K outros", não mais linhas', () => {
    const lote = Array.from({ length: 9 }, (_, i) => vivo(`a${String(i)}`));
    const l = linhas(<FooterAgents agentes={lote} largura={48}>{painel}</FooterAgents>);
    expect(l.join('\n')).toContain(`+${String(9 - agentesQueCabem() + 1)} outros`);
  });

  it('sem agentes é PASSAGEM DIRETA (a tela de quem não dispara agente não muda)', () => {
    const com = linhas(<FooterAgents agentes={[]} largura={48}>{painel}</FooterAgents>);
    expect(com).toEqual(linhas(<>{painel}</>));
  });
});

describe('o desenho', () => {
  it('o cabeçalho tem linha PRÓPRIA e os agentes começam na margem', () => {
    const l = linhas(<FooterAgents agentes={[vivo('meu-agente')]} largura={48}>{painel}</FooterAgents>);
    expect(l[0]).toContain('agentes');
    expect(l[0]).not.toContain('meu-agente'); // não divide a linha com o rótulo
    expect(l[1]).toContain('meu-agente');
    // margem pequena: era o recuo de 9 colunas que impedia tudo de caber.
    expect(l[1]!.search(/\S/)).toBeLessThan(4);
  });

  it('conectores amarram o lote como galhos de um disparo só', () => {
    const l = linhas(
      <FooterAgents agentes={[vivo('a'), vivo('b'), vivo('c')]} largura={48}>{painel}</FooterAgents>,
    );
    expect(l[1]).toContain('┌');
    expect(l[2]).toContain('├');
    expect(l[3]).toContain('└');
  });

  it('o spinner ANDA em quem está vivo e fica PARADO em quem terminou', () => {
    const lote = [vivo('correndo'), falhou('parado')];
    const f0 = linhas(<FooterAgents agentes={lote} largura={48} frame={0}>{painel}</FooterAgents>);
    const f1 = linhas(<FooterAgents agentes={lote} largura={48} frame={1}>{painel}</FooterAgents>);
    expect(f0[1]).not.toBe(f1[1]); // o vivo mudou de glifo
    expect(f0[2]).toBe(f1[2]); // o que falhou, não
    expect(f0[2]).toContain('falhou');
  });

  it('a LARGURA não muda entre quadros (o spinner não empurra o texto)', () => {
    const lote = [vivo('a'), vivo('b')];
    const larguras = new Set(
      [0, 1, 2, 3].map(
        (f) => linhas(<FooterAgents agentes={lote} largura={48} frame={f}>{painel}</FooterAgents>)[1]!.length,
      ),
    );
    expect(larguras.size).toBe(1);
  });
});

describe('a linha de um agente', () => {
  it('nome, o que faz, consumo e tempo — nessa ordem', () => {
    const l = linhaAgente(vivo('analista', { activity: { tool: 'read', target: 'a.md' }, tokens: 14_100 }));
    expect(l).toContain('analista');
    expect(l).toContain('read a.md');
    expect(l).toContain('14.1k');
    expect(l).toContain('0:30');
  });

  it('terminado mostra o DESFECHO, não uma atividade que não existe mais', () => {
    expect(linhaAgente(falhou('x'))).toContain('falhou');
    expect(linhaAgente(pronto('x'))).toContain('concluído');
    // e não o texto de reserva de quem está vivo
    expect(linhaAgente(falhou('x'))).not.toContain('pensando');
  });

  it('nome longo é cortado SEM colar no campo seguinte', () => {
    const l = linhaAgente(falhou('um-nome-absurdamente-longo-de-agente'));
    expect(l).toContain('…');
    expect(l).toMatch(/…\s/); // sobra separação antes do próximo campo
  });

  it('formatações', () => {
    expect(formataTokens(0)).toBe('0');
    expect(formataTokens(999)).toBe('999');
    expect(formataTokens(14_100)).toBe('14.1k');
    expect(formataTokens(2_500_000)).toBe('2.5M');
    expect(formataDuracao(0)).toBe('0:00');
    expect(formataDuracao(65_000)).toBe('1:05');
  });
});
