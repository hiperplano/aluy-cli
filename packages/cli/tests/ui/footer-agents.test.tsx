// FOOTER-AGENTES — a cópia FIXADA do bloco de sub-agentes, e QUANDO ela aparece.
//
// O caminho até aqui deixou três regras, e cada uma veio de olhar a tela:
//   · "eu nao esperava que ficasse isso aqui na area da conversa e sim que isso fosse para
//     o footer" ⇒ existe uma visão no rodapé;
//   · "ficou muito redundante em cima e em baixo porem com informacoes de status
//     diferentes" ⇒ a de baixo não pode ter desenho PRÓPRIO: é o mesmo componente;
//   · "os agentes no footer deveriam aparecer embaixo somente quando os de cima sumirem"
//     ⇒ e nunca as duas ao mesmo tempo.
//
// A primeira tentativa desenhou um segundo painel, com outros glifos e outros campos, e foi
// justamente isso que produziu a reclamação do meio.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { FooterAgents, recorteDoRodape, agentesQueCabem } from '../../src/ui/components/FooterAgents.js';
import { linhasDoRodapeAgentes } from '../../src/session/footer-agents-layout.js';
import { SubAgents, type SubAgentChildView } from '../../src/ui/components/SubAgents.js';
import { blocoSubagentesNaTela, ultimoBlocoSubagentes } from '../../src/session/subagentes-visiveis.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import type { SessionBlock } from '../../src/session/model.js';

const tema = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const painel = (
  <Box flexDirection="column">
    <Text>{'sessao'}</Text>
    <Text>{'uso'}</Text>
  </Box>
);
const filho = (label: string, status: SubAgentChildView['status'] = 'running'): SubAgentChildView => ({
  label,
  status,
  summary: '1.2k tokens',
  model: 'herdado (qwen)',
});

function linhas(node: React.ReactElement): string[] {
  const { lastFrame } = render(<ThemeProvider theme={tema}>{node}</ThemeProvider>);
  // eslint-disable-next-line no-control-regex
  return ((lastFrame() ?? '').replace(/\u001b\[[0-9;]*m/g, '')).split('\n');
}

describe('a cópia é IDÊNTICA ao original — não um segundo desenho', () => {
  it('mesmo componente, mesma saída', () => {
    const fs = [filho('a'), filho('b', 'done'), filho('c', 'fail')];
    const soBloco = linhas(<SubAgents childrenStatus={fs} />);
    const noRodape = linhas(<FooterAgents filhos={fs}>{painel}</FooterAgents>);
    // o rodapé é o bloco + o painel abaixo; o começo tem de bater linha a linha.
    expect(noRodape.slice(0, soBloco.length)).toEqual(soBloco);
  });

  it('sem filhos é PASSAGEM DIRETA (a tela de quem não dispara agente não muda)', () => {
    expect(linhas(<FooterAgents filhos={[]}>{painel}</FooterAgents>)).toEqual(linhas(<>{painel}</>));
  });
});

describe('recorte — o rodapé mora no chrome e não pode crescer sem limite', () => {
  it('até o teto, mostra todos', () => {
    const fs = Array.from({ length: agentesQueCabem(24) }, (_, i) => filho(`a${String(i)}`));
    const r = recorteDoRodape(fs, 24);
    expect(r.mostrados).toHaveLength(fs.length);
    expect(r.sobra).toBe(0);
  });

  it('acima do teto, corta e DIZ quantos ficaram de fora', () => {
    const fs = Array.from({ length: 40 }, (_, i) => filho(`a${String(i)}`));
    const r = recorteDoRodape(fs, 24);
    expect(r.mostrados.length).toBeLessThan(fs.length);
    expect(r.mostrados.length + r.sobra).toBe(fs.length);
    expect(linhas(<FooterAgents filhos={fs} rows={24}>{painel}</FooterAgents>).join('\n')).toContain(
      `+${String(r.sobra)} outros`,
    );
  });

  // Enquanto há trabalho, quem trabalha é a notícia — e é ele que o corte precisa preservar.
  it('quem AINDA CORRE tem prioridade no recorte', () => {
    const fs = [
      ...Array.from({ length: 10 }, (_, i) => filho(`pronto${String(i)}`, 'done')),
      filho('trabalhando'),
    ];
    expect(recorteDoRodape(fs, 24).mostrados.map((c) => c.label)).toContain('trabalhando');
  });
});

describe('QUANDO fixar — só depois que o de cima sai da tela', () => {
  const bloco = (): SessionBlock => ({ kind: 'subagents', children: [filho('a'), filho('b')] });
  const fala = (linhasN: number): SessionBlock => ({
    kind: 'aluy',
    text: Array.from({ length: linhasN }, (_, i) => `linha ${String(i)}`).join('\n'),
    streaming: false,
  });

  it('bloco recém-criado, tela alta ⇒ AINDA na tela (não fixa: seria duplicar)', () => {
    expect(
      blocoSubagentesNaTela({ blocks: [bloco()], rows: 40, columns: 100, linhasDoRodape: 8 }),
    ).toBe(true);
  });

  it('saída longa DEPOIS dele ⇒ rolou para fora (aí sim, fixa)', () => {
    expect(
      blocoSubagentesNaTela({
        blocks: [bloco(), fala(200)],
        rows: 40,
        columns: 100,
        linhasDoRodape: 8,
      }),
    ).toBe(false);
  });

  it('tela BAIXA empurra mais rápido — a mesma saída já o tira de vista', () => {
    const blocks = [bloco(), fala(12)];
    expect(blocoSubagentesNaTela({ blocks, rows: 40, columns: 100, linhasDoRodape: 8 })).toBe(true);
    expect(blocoSubagentesNaTela({ blocks, rows: 14, columns: 100, linhasDoRodape: 8 })).toBe(false);
  });

  // Conservador: na dúvida, "ainda visível" — errar assim custa não ver a cópia por um
  // instante; errar ao contrário põe as duas na tela, que é o que o dono pediu para acabar.
  it('sem bloco nenhum ⇒ trata como visível (não há o que fixar)', () => {
    expect(blocoSubagentesNaTela({ blocks: [fala(3)], rows: 40, columns: 100, linhasDoRodape: 8 })).toBe(true);
    expect(ultimoBlocoSubagentes([fala(3)])).toBe(-1);
  });

  it('altura degenerada (resize em curso) ⇒ visível, sem fixar nada', () => {
    expect(blocoSubagentesNaTela({ blocks: [bloco(), fala(200)], rows: 0, columns: 100, linhasDoRodape: 8 })).toBe(true);
  });

  it('pega o ÚLTIMO lote, não o primeiro', () => {
    const bs = [bloco(), fala(2), bloco()];
    expect(ultimoBlocoSubagentes(bs)).toBe(2);
  });
});

// O TETO ACOMPANHA A TELA — achado pelo dono num teste que eu não tinha feito: "spamei 4 e
// depois mais 4... quando ocultou 3 ele mostrou 3 no rodape, mas depois nao mostrou mais no
// pe alem dos 3".
//
// Dois disparos entram no MESMO bloco quando o primeiro ainda corre (é o comportamento do
// `lastSubAgentsIndex`), então eram 8 num bloco só. Com o teto CRAVADO em 6 linhas — número
// que eu escolhi sem olhar a tela — sobravam 3 filhos e um "+5 outros", num terminal com
// espaço de sobra. O teto virou fração da altura, com piso e teto.
describe('o teto do rodapé acompanha a altura do terminal', () => {
  it('o caso do dono: 8 agentes num bloco só CABEM em tela normal', () => {
    const oito = Array.from({ length: 8 }, (_, i) => filho(`a${String(i)}`));
    expect(recorteDoRodape(oito, 30).sobra).toBe(0);
    expect(recorteDoRodape(oito, 30).mostrados).toHaveLength(8);
  });

  it('com o teto ANTIGO (6 linhas) o mesmo lote mostrava 3 — o defeito era real', () => {
    const oito = Array.from({ length: 8 }, (_, i) => filho(`a${String(i)}`));
    // 6 linhas de rodapé = 4 filhos = mostra 3 + "+5".
    expect(agentesQueCabem(18)).toBe(4);
    expect(recorteDoRodape(oito, 18).mostrados).toHaveLength(3);
    expect(recorteDoRodape(oito, 18).sobra).toBe(5);
  });

  it('tela maior ⇒ mais agentes; e há PISO e TETO (o rodapé não vira a tela toda)', () => {
    expect(agentesQueCabem(20)).toBeLessThan(agentesQueCabem(40));
    expect(linhasDoRodapeAgentes(10)).toBe(4); // piso
    expect(linhasDoRodapeAgentes(300)).toBe(14); // teto
  });

  it('altura ausente/degenerada ⇒ um default sensato, sem quebrar', () => {
    expect(linhasDoRodapeAgentes(undefined)).toBe(8);
    expect(linhasDoRodapeAgentes(0)).toBe(8);
    expect(linhasDoRodapeAgentes(-5)).toBe(8);
  });
});

