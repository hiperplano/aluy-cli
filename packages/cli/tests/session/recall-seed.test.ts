// A SEMENTE DE MEMÓRIA não pode voltar a engolir a falha em silêncio.
//
// O defeito real (31/08): o sidecar do mem0 devolvia HTTP 500 em TODA leitura — o pin
// instala `mem0ai==0.1.76` e o script chamava a API 2.0.7 (`top_k=`, que não existe na
// 0.1.x). Durou 12 dias. O `add` usa a assinatura antiga e funcionava, então a memória
// GRAVAVA e nunca LIA.
//
// O cliente DETECTAVA certo (`Mem0 HTTP 500`). Quem apagou o sinal foi o chamador: os
// três `catch { memorySeed = [] }` do `run.tsx` conflavam "não há memória" com "não
// consegui ler a memória". Para o dono, 12 dias de defeito determinista apareceram como
// uma sessão amnésica e um `✗` de UM caractere no rodapé — "entrei e parece que ele nem
// sabe do que se trata".
//
// A degradação em si está CERTA e continua (CA-MA8: a sessão segue sem memória). O que
// estes testes travam é que ela seja DITA.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { semearMemoria, notaFalhaDeMemoria } from '../../src/session/recall-seed.js';

describe('semearMemoria — separa "não há" de "não consegui ler"', () => {
  it('sucesso com fatos: entrega os itens e NENHUMA falha', async () => {
    const itens = [{ role: 'observation', toolName: 'memória', text: 'um fato' }] as never;
    const r = await semearMemoria(async () => itens);
    expect(r.itens).toHaveLength(1);
    expect(r.falha).toBeUndefined();
  });

  it('sucesso VAZIO não é falha — a distinção que o `catch` seco apagava', async () => {
    const r = await semearMemoria(async () => []);
    expect(r.itens).toEqual([]);
    expect(r.falha, 'memória vazia NÃO pode ser reportada como falha').toBeUndefined();
  });

  it('falha: itens vazios E o motivo preservado', async () => {
    const r = await semearMemoria(async () => {
      throw new Error('Mem0 HTTP 500');
    });
    expect(r.itens).toEqual([]);
    expect(r.falha).toBe('Mem0 HTTP 500');
  });

  it('NUNCA lança — a sessão segue mesmo com o sidecar fora (CA-MA8)', async () => {
    await expect(
      semearMemoria(async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).resolves.toBeDefined();
  });

  it('erro sem mensagem ainda produz motivo legível (nada de "undefined" na tela)', async () => {
    const r = await semearMemoria(async () => {
      throw new Error('');
    });
    expect(r.falha).toBeDefined();
    expect(r.falha).not.toBe('');
    expect(r.falha).not.toContain('undefined');
  });

  it('lançamento não-Error também vira motivo', async () => {
    const r = await semearMemoria(async () => {
      throw 'quebrou feio';
    });
    expect(r.falha).toBe('quebrou feio');
  });
});

describe('notaFalhaDeMemoria — o texto diz as três coisas', () => {
  const linhas = notaFalhaDeMemoria('Mem0 HTTP 500');

  it('diz que FALHOU a leitura, não que estava vazia', () => {
    expect(linhas.join(' ')).toContain('não consegui LER');
  });

  it('carrega o motivo cru (é ele que leva ao conserto)', () => {
    expect(linhas.join(' ')).toContain('Mem0 HTTP 500');
  });

  it('avisa que a sessão SEGUE — informar sem assustar', () => {
    expect(linhas.join(' ')).toContain('segue normalmente');
  });

  it('aponta o diagnóstico', () => {
    expect(linhas.join(' ')).toContain('doctor');
  });
});

describe('GUARDA — nenhum sítio de recall volta ao `catch` seco', () => {
  // Mesma família do teste de fronteira e da guarda do `createPinnedStreamFetch`: o
  // conserto valeu para TRÊS pontos de chamada, e o irmão esquecido é o que desfaz o
  // conserto na primeira execução. Esta guarda lê o fonte e nomeia quem esqueceu.
  const RUN = join(__dirname, '..', '..', 'src', 'session', 'run.tsx');
  const fonte = readFileSync(RUN, 'utf8');

  it('toda chamada a `memory.recall()` passa por `semearMemoria`', () => {
    const soltas: string[] = [];
    const linhas = fonte.split('\n');
    for (const [i, l] of linhas.entries()) {
      if (!/await built\.memory\.recall\(\)/.test(l)) continue;
      if (/semearMemoria/.test(l)) continue;
      soltas.push(`run.tsx:${i + 1}: ${l.trim()}`);
    }
    expect(soltas).toEqual([]);
  });

  it('a varredura ACHA alguém quando o defeito volta (não passa por vacuidade)', () => {
    const mutado = fonte.replace(
      /const semente = await semearMemoria\(\(\) => built\.memory\.recall\(\)\);/,
      'let memorySeed = [...(await built.memory.recall())];',
    );
    expect(mutado, 'a âncora mudou — atualize esta guarda').not.toBe(fonte);
    const achou = mutado
      .split('\n')
      .some((l) => /await built\.memory\.recall\(\)/.test(l) && !/semearMemoria/.test(l));
    expect(achou).toBe(true);
  });
});
