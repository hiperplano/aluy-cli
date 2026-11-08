// FRASES DE ESPERA — a linha de trabalho (`Λluy <frase>… (pensando · 12s)`) ganha uma frase
// brincalhona em PT-BR que GIRA a cada poucos segundos enquanto o aluy processa: pensando,
// esperando uma tool, tarefa do Concierge rodando em segundo plano, pausa por cota sondando.
//
// A lista mora no catálogo i18n (`working.quips`, separada por `|`); outro idioma só
// sobrescreve a chave. Tudo aqui é PURO e sem estado: a frase é função do relógio, então o
// render a recalcula a cada tick sem guardar nada, e os testes passam `agoraMs`.
//
// Sem rotação quando o movimento está desligado (`girar=false`: ALUY_NO_ANIM/reduced-motion):
// a frase fica fixa durante o passo. `ALUY_SPINNER_VERBS=plain` desliga as frases (rótulos planos).

import { displayWidth } from './visual-lines.js';
import { criarRng } from './verbos.js';

/** Quanto tempo cada frase fica na tela. */
export const PERIODO_FRASE_MS = 4000;

/** Quebra a string do catálogo (`a|b|c`). */
export function parseFrases(catalogo: string): readonly string[] {
  return catalogo
    .split('|')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Embaralhamento determinístico (Fisher-Yates + mulberry32): a ordem não repete até esgotar. */
export function ordemDasFrases(n: number, seed: number): readonly number[] {
  const rng = criarRng(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx;
}

/**
 * A frase de agora. `desde` = início do trabalho (turno / tarefa / pausa): cada espera começa
 * numa frase diferente (a posição inicial vem de `desde`) e avança uma a cada `periodoMs`.
 */
export function fraseDaEspera(args: {
  readonly frases: readonly string[];
  readonly agoraMs: number;
  readonly desde: number;
  readonly seed: number;
  readonly girar: boolean;
  readonly periodoMs?: number;
}): string | undefined {
  const n = args.frases.length;
  if (n === 0) return undefined;
  const ordem = ordemDasFrases(n, args.seed);
  const periodo = args.periodoMs ?? PERIODO_FRASE_MS;
  const decorrido = Math.max(0, args.agoraMs - args.desde);
  const passo = args.girar ? Math.floor(decorrido / periodo) : 0;
  const inicio = Math.abs(Math.trunc(args.desde / 1000)) % n;
  return args.frases[ordem[(inicio + passo) % n]!];
}

/**
 * Largura (colunas) reservada à frase: a MAIOR da lista, limitada a uma fração da tela. O
 * detalhe `(pensando · 12s)` é medido contra ESTA largura e não contra a frase da vez — senão
 * ele ganharia/perderia segmentos a cada troca de frase.
 */
export function larguraReservadaDaFrase(frases: readonly string[], columns: number): number {
  const maior = frases.reduce((m, f) => Math.max(m, displayWidth(f)), 0);
  return Math.min(maior, Math.max(14, Math.floor(columns * 0.45)));
}

/** Corta a frase para caber em `max` colunas (o `…` que a linha acrescenta marca o corte). */
export function cortarFrase(frase: string, max: number): string {
  if (displayWidth(frase) <= max) return frase;
  let out = '';
  for (const ch of frase) {
    if (displayWidth(out + ch) > Math.max(1, max - 1)) break;
    out += ch;
  }
  return out.trimEnd();
}

/** Colunas fixas à esquerda da linha: `Λluy` (ou o fallback ASCII de 5) + 1 espaço. */
export const PREFIXO_LINHA_TRABALHO = 5;

/**
 * Garante UMA linha: a soma `prefixo + rótulo… + detalhe + sufixo` nunca passa de `columns - 1`.
 * Corta primeiro a dica do sufixo, depois o sufixo, depois o detalhe e por último o rótulo.
 * Linha que quebra faz o composer pular uma linha; por isso o corte é aqui, não no terminal.
 */
export function ajustarLinhaTrabalho(a: {
  readonly columns: number;
  readonly label: string;
  readonly detalhe?: string | undefined;
  readonly suffix?: string | undefined;
}): { label: string; detalhe?: string; suffix?: string } {
  const orcamento = Math.max(8, a.columns - 1 - PREFIXO_LINHA_TRABALHO);
  let label = a.label;
  let detalhe = a.detalhe !== undefined && a.detalhe !== '' ? a.detalhe : undefined;
  let suffix = a.suffix !== undefined && a.suffix !== '' ? a.suffix : undefined;
  const largura = (): number =>
    displayWidth(label) +
    1 + // o `…`
    (detalhe !== undefined ? 1 + displayWidth(detalhe) : 0) +
    (suffix !== undefined ? 1 + displayWidth(suffix) : 0);
  if (largura() > orcamento && suffix !== undefined) {
    const semDica = suffix.replace(/\s*·\s*F8 para parar$/, '');
    suffix = semDica === '' ? undefined : semDica;
  }
  if (largura() > orcamento) suffix = undefined;
  if (largura() > orcamento) detalhe = undefined;
  if (largura() > orcamento) label = cortarFrase(label, Math.max(4, orcamento - 1));
  return {
    label,
    ...(detalhe !== undefined ? { detalhe } : {}),
    ...(suffix !== undefined ? { suffix } : {}),
  };
}
