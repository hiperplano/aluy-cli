// SUB-AGENTES EM SEGUNDO PLANO NÃO PRENDEM A CONVERSA NA REGIÃO VIVA.
//
// Visto no tmux (16/09, 177×53, 8 agentes, duas rodadas): depois que os agentes passavam
// para segundo plano (ESC ou mensagem encaixada) e o dono seguia conversando, a tela repintava
// INTEIRA dezenas de vezes (82 repinturas contadas nos bytes, o tráfego foi de 0,58 MB para
// 4,4 MB) e o composer pulava entre as linhas 36 e 40. O dono: "ainda fica movimentando".
//
// A causa: a região viva é o sufixo a partir do PRIMEIRO bloco vivo, e um bloco `subagents`
// com filho rodando é vivo. Em segundo plano ele fica no meio da conversa, e tudo o que vem
// depois — os turnos novos inteiros — não desce mais para o histórico. A região cresce até
// passar da altura do terminal e o Ink cai no repaint total a cada quadro.
//
// Regra nova: um lote que já ficou PARA TRÁS (há uma fala do dono depois dele) desce para o
// histórico; o estado vivo dos filhos já mora no painel do rodapé.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { liveStartIndex, splitBlocks } from '../../src/session/render-split.js';
import { SubAgents } from '../../src/ui/components/SubAgents.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import type { SessionBlock } from '../../src/session/model.js';

const running: SessionBlock = {
  kind: 'subagents',
  children: [
    { label: 'a', status: 'running' },
    { label: 'b', status: 'done' },
  ],
} as SessionBlock;

describe('divisão histórico × vivo com agentes em segundo plano', () => {
  it('lote rodando SEGUIDO de uma nova fala do dono vai para o histórico', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'lança' },
      running,
      { kind: 'you', text: 'e agora?' },
      { kind: 'aluy', text: 'resposta', streaming: true },
    ];
    const { done, live } = splitBlocks(blocks);
    expect(done.map((b) => b.kind)).toEqual(['you', 'subagents', 'you']);
    expect(live.map((b) => b.kind)).toEqual(['aluy']);
    expect(liveStartIndex(blocks)).toBe(3);
  });

  it('sem nada vivo depois, a conversa inteira desce (a região viva fica vazia)', () => {
    const blocks: SessionBlock[] = [
      running,
      { kind: 'you', text: 'e agora?' },
      { kind: 'aluy', text: 'pronto', streaming: false },
    ];
    expect(splitBlocks(blocks).live).toEqual([]);
  });

  it('lote rodando seguido da resposta JÁ CONCLUÍDA do pai (sem fala do dono) também desce', () => {
    // Visto pelo dono em 16/09 (208×57): 1 filho em segundo plano, o pai terminou uma resposta
    // longa depois do lote — e a tela repintava inteira ~8×/s ("tinha parado", disse ele: o
    // primeiro conserto só olhava para uma fala NOVA do dono).
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'lança 8' },
      running,
      { kind: 'tool', verb: 'spawn_agent', status: 'ok' } as SessionBlock,
      { kind: 'aluy', text: 'resposta longa do pai', streaming: false },
    ];
    expect(splitBlocks(blocks).live).toEqual([]);
  });

  it('enquanto o pai ainda fala logo depois do lote, o lote segue vivo junto', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'lança 8' },
      running,
      { kind: 'aluy', text: 'escrevendo…', streaming: true },
    ];
    expect(splitBlocks(blocks).live.map((b) => b.kind)).toEqual(['subagents', 'aluy']);
  });

  it('o lote do turno CORRENTE (sem fala depois) continua vivo', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'lança' },
      running,
      { kind: 'aluy', text: 'vou lançar', streaming: true },
    ];
    expect(splitBlocks(blocks).live.map((b) => b.kind)).toEqual(['subagents', 'aluy']);
  });
});

describe('<SubAgents> já no histórico com filhos ainda rodando', () => {
  const pinta = (settled: boolean): string =>
    (
      render(
        <ThemeProvider theme={resolveTheme({ env: { TERM: 'xterm-256color' } })}>
          <SubAgents
            childrenStatus={running.kind === 'subagents' ? running.children : []}
            {...(settled ? { settled: true } : {})}
          />
        </ThemeProvider>,
      ).lastFrame() ?? ''
    ).replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');

  it('diz "em segundo plano" — nunca um "rodando" congelado no scrollback', () => {
    const out = pinta(true);
    expect(out).toContain('em segundo plano');
    expect(out).not.toContain('rodando');
    expect(out).toContain('pronto');
  });

  it('vivo, segue "rodando" como sempre', () => {
    expect(pinta(false)).toContain('rodando');
  });
});
