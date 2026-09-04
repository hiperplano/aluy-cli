// SEMENTE DE MEMÓRIA — o recall do boot, com a FALHA visível.
//
// Antes, os três pontos que semeiam memória (`run.tsx`: headless, linear e TUI) faziam
// todos a mesma coisa:
//
//     try   { memorySeed = [...(await built.memory.recall())]; }
//     catch { memorySeed = []; }
//
// O `catch` seco conflava dois estados MUITO diferentes: "não há memória" e "não consegui
// LER a memória". Em 31/08 isso custou caro: o sidecar do mem0 devolvia HTTP 500 em toda
// leitura (o pin instala `mem0ai==0.1.76` e o script chamava a API 2.0.7), e o efeito
// visível para o dono foi só uma sessão amnésica — "entrei e parece que ele nem sabe do
// que se trata". O único sinal era um `✗` de UM caractere no rodapé. Durou 12 dias.
//
// O `add` usava a API antiga e funcionava, então a memória GRAVAVA e nunca LIA — a pior
// forma do defeito, porque tudo parecia bem até a hora em que a memória importava.
//
// Este módulo não muda o comportamento de degradação (a sessão SEGUE sem memória, como
// sempre: CA-MA8). Ele só para de ESCONDER: devolve o motivo junto, para o chamador poder
// dizer ao usuário que a memória não carregou, em vez de fingir que não havia nenhuma.
//
// PURO em relação a I/O: recebe a função de recall, não a chama de lugar nenhum sozinho.

import type { HistoryItem } from '@hiperplano/aluy-cli-core';

/** O que a semente produziu — e, se falhou, POR QUÊ. */
export interface SementeDeMemoria {
  /** Os itens recuperados. Vazio tanto em "não há" quanto em "falhou". */
  readonly itens: readonly HistoryItem[];
  /**
   * Motivo legível da FALHA de leitura, ou `undefined` quando a leitura funcionou
   * (inclusive quando funcionou e não havia nada). É a distinção que o `catch` seco
   * apagava.
   */
  readonly falha?: string;
}

/** Extrai uma linha curta e legível de um erro qualquer. */
function motivoDe(e: unknown): string {
  if (e instanceof Error && e.message.trim() !== '') return e.message.trim();
  const s = String(e).trim();
  return s === '' ? 'erro desconhecido' : s;
}

/**
 * Roda o recall e NUNCA lança — mas, ao contrário do `catch` seco que substitui, reporta
 * a falha em vez de engoli-la. Ver o cabeçalho do módulo.
 */
export async function semearMemoria(
  recall: () => Promise<readonly HistoryItem[]>,
): Promise<SementeDeMemoria> {
  try {
    return { itens: [...(await recall())] };
  } catch (e) {
    return { itens: [], falha: motivoDe(e) };
  }
}

/**
 * As linhas da nota mostrada quando a memória não carregou.
 *
 * Diz as três coisas que o `✗` sozinho não dizia: que FALHOU (não que estava vazia), o
 * motivo cru, e que a sessão segue — para a nota informar sem assustar.
 */
export function notaFalhaDeMemoria(motivo: string): string[] {
  return [
    `não consegui LER a memória de sessões anteriores: ${motivo}`,
    'a sessão segue normalmente, mas sem os fatos lembrados — se eu parecer sem contexto, é isto.',
    'diagnóstico: `aluy doctor` (seção do sidecar mem0).',
  ];
}
