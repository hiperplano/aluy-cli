// FALHA-FANTASMA — o inverso do ATTACH-CEGO, e pior: em vez de esconder um erro, o
// aluy INVENTAVA um. No serviço do dono, `runner.log` mostrava
//
//   [tool] spawn_agent  → err
//
// para um `spawn_agent` que estava trabalhando NORMALMENTE — 3 processos filhos vivos
// naquele instante, e a atividade concluindo "ok" minutos depois. Sem `output` nenhum,
// porque não havia erro para ter motivo.
//
// A cadeia: `sanitizeBlock` demovia `running`→`err`. A premissa ("a sessão restaurada é
// inerte, não há tool em voo") era VERDADEIRA quando o save só acontecia no FIM do turno.
// A FASE 4 (attach) passou a gravar DURANTE o turno — justamente para o dono ver ao vivo —
// e a mesma linha começou a carimbar "falhou" em cima de "está trabalhando".
//
// A demoção honesta de ÓRFÃO continua existindo, onde é verdade: `sanitizeOrphans` (na
// fronteira de entrada do controller) e `blocksToHistory` (reconstrução a partir de
// blocos). O que morreu foi a demoção no SAVE.
//
// Estes testes travam três coisas: (1) `running` round-trippa fiel; (2) o attach mostra
// in-flight como in-flight, nunca como erro; (3) o desfecho REAL é reemitido quando o
// bloco resolve IN PLACE — sem isso o dono ficaria com "…" para sempre, que é a mesma
// cegueira por outro caminho.

import { describe, expect, it } from 'vitest';
import { sanitizeBlock, blocksToHistory } from '../../src/io/session-record.js';
import {
  summarizeSessionBlockForAttach,
  newAttachBlockTailState,
} from '../../src/service/attach-blocks.js';
import type { SessionBlock } from '../../src/session/model.js';

describe('sanitizeBlock — `running` NÃO é `err` (o save não pode inventar falha)', () => {
  it('tool em voo round-trippa como `running` (o bug: virava `err` sem motivo)', () => {
    const b = sanitizeBlock({
      kind: 'tool',
      verb: 'spawn_agent',
      target: '',
      result: '',
      status: 'running',
      verbGerund: 'processando',
    });
    expect(b).not.toBeNull();
    expect(b).toMatchObject({ kind: 'tool', status: 'running', verbGerund: 'processando' });
  });

  it('bang em voo round-trippa como `running`', () => {
    const b = sanitizeBlock({ kind: 'bang', command: 'npm test', status: 'running' });
    expect(b).toMatchObject({ kind: 'bang', status: 'running' });
  });

  it('resposta AINDA CHEGANDO preserva `streaming` (senão o parcial vira "final")', () => {
    const b = sanitizeBlock({ kind: 'aluy', text: 'estou analis', streaming: true });
    expect(b).toMatchObject({ kind: 'aluy', streaming: true });
  });

  it('resposta concluída continua NÃO-streaming', () => {
    expect(sanitizeBlock({ kind: 'aluy', text: 'pronto' })).toMatchObject({ streaming: false });
    expect(sanitizeBlock({ kind: 'aluy', text: 'pronto', streaming: false })).toMatchObject({
      streaming: false,
    });
  });

  it('status DESCONHECIDO/lixo continua virando `err` — fail-closed preservado', () => {
    // A tolerância é só para `running`, que é estado LEGÍTIMO do tipo. Qualquer outra
    // coisa vinda do disco (corrupção, versão futura) segue degradando p/ `err`.
    expect(sanitizeBlock({ kind: 'tool', verb: 'x', target: '', result: '', status: 'voando' }))
      .toMatchObject({ status: 'err' });
    expect(sanitizeBlock({ kind: 'bang', command: 'x', status: 42 })).toMatchObject({
      status: 'err',
    });
  });
});

describe('blocksToHistory — o ÓRFÃO restaurado é honesto com o MODELO', () => {
  it('tool `running` restaurada vira "interrompido" — nem falha inventada, nem espera eterna', () => {
    // `→ err` mentiria (não falhou); `→ running` faria o modelo esperar um resultado que
    // nunca vem, porque a reconstrução a partir de blocos é, por definição, post-mortem.
    const [h] = blocksToHistory([
      { kind: 'tool', verb: 'spawn_agent', target: '', result: '', status: 'running' },
    ]);
    expect(h?.text).toContain('interrompido');
    expect(h?.text).not.toMatch(/→ err/); // (substring cru "err" não serve: "int-err-ompido")
    expect(h?.text).not.toContain('running');
  });

  it('bang `running` restaurado idem', () => {
    const [h] = blocksToHistory([{ kind: 'bang', command: 'npm test', status: 'running' }]);
    expect(h?.text).toContain('interrompido');
  });

  it('tool concluída não muda de texto — nenhuma regressão no caminho normal', () => {
    const [h] = blocksToHistory([
      { kind: 'tool', verb: 'read', target: 'a.ts', result: '48 linhas', status: 'ok' },
    ]);
    expect(h?.text).toBe('read a.ts → 48 linhas');
  });
});

describe('attach — in-flight aparece pelo que É', () => {
  it('tool em voo NÃO vira "err" (a linha exata que o dono viu no runner.log)', () => {
    const s = summarizeSessionBlockForAttach({
      kind: 'tool',
      verb: 'spawn_agent',
      target: '',
      result: '',
      status: 'running',
      verbGerund: 'processando',
    });
    expect(s?.text).toContain('spawn_agent');
    expect(s?.text).toContain('processando');
    expect(s?.text).not.toContain('err');
  });

  it('a linha viva NÃO casa com o filtro de erro do runner (` → err`)', () => {
    // `runner.ts` decide o que vai p/ o `runner.log` procurando ` → err` no texto. Se a
    // linha viva usasse ` → `, cada tool em voo viraria uma falha no log do dono — que é
    // exatamente o sintoma que estamos matando.
    const s = summarizeSessionBlockForAttach({
      kind: 'tool',
      verb: 'glob',
      target: '**/*.yaml',
      result: '',
      status: 'running',
      verbGerund: 'buscando',
    });
    expect(s?.text).not.toMatch(/ → err/);
  });

  it('sem gerúndio degrada p/ "rodando" — nunca "undefined"', () => {
    const s = summarizeSessionBlockForAttach({
      kind: 'tool',
      verb: 'read',
      target: 'a.ts',
      result: '',
      status: 'running',
    });
    expect(s?.text).toContain('rodando');
    expect(s?.text).not.toContain('undefined');
  });
});

describe('tail — o DESFECHO real chega (o bloco resolve IN PLACE)', () => {
  // O tail avança por `slice(emittedCount)`: um bloco que resolve NO LUGAR (o
  // `resolveToolLine` SUBSTITUI a linha viva, não empurra outra) nunca mais seria
  // emitido. O dono ficaria com "…processando" para sempre — a cegueira de novo.
  // Estes testes exercitam a mecânica do estado direto (sem tocar disco): o `pollNew…`
  // real é I/O e está coberto pelos testes de attach existentes.

  it('estado inicial expõe a lista de pendentes', () => {
    const st = newAttachBlockTailState();
    expect(st.emittedCount).toBe(0);
    expect(st.pendentes.size).toBe(0);
  });

  it('um bloco em voo emitido fica PENDENTE e reemite ao resolver, com o motivo', () => {
    const emVoo: SessionBlock = {
      kind: 'tool',
      verb: 'spawn_agent',
      target: '',
      result: '',
      status: 'running',
      verbGerund: 'processando',
    };
    const resolvido: SessionBlock = {
      kind: 'tool',
      verb: 'spawn_agent',
      target: '',
      result: 'erro',
      status: 'err',
      output: 'agente "data-engineer" desconhecido — delegação RECUSADA',
    };
    const vivo = summarizeSessionBlockForAttach(emVoo);
    const fim = summarizeSessionBlockForAttach(resolvido);
    // A linha viva e a final são DIFERENTES — é isso que dispara a reemissão (o tail
    // compara com o texto já emitido para não repetir à toa).
    expect(vivo?.text).not.toBe(fim?.text);
    // E o desfecho carrega o MOTIVO (a garantia do ATTACH-CEGO, preservada).
    expect(fim?.text).toContain('data-engineer');
    expect(fim?.text).toContain('RECUSADA');
  });

  it('sucesso também é reemitido — o dono precisa saber que TERMINOU BEM', () => {
    const fim = summarizeSessionBlockForAttach({
      kind: 'tool',
      verb: 'spawn_agent',
      target: '',
      result: 'ok',
      status: 'ok',
    });
    expect(fim?.text).toContain('ok');
    expect(fim?.text).not.toContain('processando');
  });
});
