// ÂNCORA DO COMPOSER — com a tela cheia, o quadro vivo nunca encolhe.
//
// Relato do dono (16/09): "ainda fica movimentando… ele não fica o composer embaixo",
// "principalmente quando eu mando um texto". Medido no tmux (177×53, provider falso): o
// composer ia 47 → 48 → 42 → 45 → 46 → 47 quando o pedido de aprovação (≈9 linhas) sumia, e
// 47 → 44 quando o "↳ encaixando…" e o "processando" sumiam logo depois do Enter.
//
// O Ink escreve cada quadro como `eraseLines(n) + saída`. Se a saída nova é mais baixa, as
// linhas de baixo ficam vazias e o composer SOBE; o próximo crescimento o faz DESCER. A âncora
// mantém a altura: completa o quadro com linhas em branco no topo (acima de tudo o que é vivo)
// e as devolve assim que o conteúdo cresce. Quando o Ink escreve histórico (`<Static>`), a
// reserva desconta o que o histórico ocupou.
import { describe, expect, it } from 'vitest';
import { createFrameAnchor } from '../../src/session/synchronized-output.js';

const ESC = '\x1b[';
const erase = (n: number): string =>
  n <= 0 ? '' : `${ESC}2K${ESC}1A`.repeat(n - 1) + `${ESC}2K${ESC}G`;
/** Um quadro de `k` linhas visíveis, como o `log-update` o entrega (termina em `\n`). */
const frame = (k: number, tag = 'x'): string =>
  Array.from({ length: k }, (_, i) => `${tag}${i}`).join('\n') + '\n';
/** Quantas linhas em branco a âncora pôs no topo do corpo. */
const padOf = (out: string, eraseN: number): number => {
  const body = out.slice(erase(eraseN).length);
  let n = 0;
  while (body[n] === '\n') n += 1;
  return n;
};

/** Monta a âncora já com a tela "cheia" (histórico suficiente escrito antes). */
function anchored(rows = 40) {
  const a = createFrameAnchor(() => rows);
  a.transform(frame(1)); // 1º quadro (sem erase)
  a.transform(erase(2)); // clear antes do histórico
  a.transform(frame(rows)); // histórico de uma tela inteira
  a.transform(frame(10)); // quadro vivo de 10 linhas
  return a;
}

describe('createFrameAnchor', () => {
  it('quadro que ENCOLHE com a tela cheia é completado no topo — a altura fica', () => {
    const a = anchored();
    const out = a.transform(erase(11) + frame(4));
    // apaga as 11 que o log-update conhece, completa 6 em branco, escreve as 4.
    expect(out.startsWith(erase(11))).toBe(true);
    expect(padOf(out, 11)).toBe(6);
    expect(out.endsWith(frame(4))).toBe(true);
  });

  it('o próximo erase apaga também a reserva (o log-update não sabe dela)', () => {
    const a = anchored();
    a.transform(erase(11) + frame(4)); // na tela: 5 (reais) + 6 (reserva) = 11
    const out = a.transform(erase(5) + frame(4, 'y'));
    expect(out.startsWith(erase(11))).toBe(true);
    expect(padOf(out, 11)).toBe(6);
  });

  it('conteúdo que CRESCE consome a reserva na mesma escrita (sem salto para baixo)', () => {
    const a = anchored();
    a.transform(erase(11) + frame(4)); // reserva 6
    const out = a.transform(erase(5) + frame(8)); // cresce 4: sobra reserva 2
    expect(padOf(out, 11)).toBe(2);
    const out2 = a.transform(erase(9) + frame(13)); // cresce além da reserva
    expect(out2.startsWith(erase(11))).toBe(true);
    expect(padOf(out2, 11)).toBe(0);
  });

  it('histórico escrito desconta da reserva: o fim do quadro fica no mesmo lugar', () => {
    const a = anchored();
    a.transform(erase(11) + frame(4)); // na tela: 11 (4 reais + 6 reserva + cursor)
    const clear = a.transform(erase(5));
    expect(clear).toBe(erase(11)); // o clear apaga a reserva junto
    expect(a.transform(frame(3, 'h'))).toBe(frame(3, 'h')); // histórico: passa intacto
    // 10 linhas ocupadas antes; 3 viraram histórico ⇒ o quadro novo ocupa 7.
    const out = a.transform(frame(5, 'z'));
    expect(out).toBe('\n'.repeat(2) + frame(5, 'z'));
  });

  it('com a tela AINDA NÃO cheia nada muda (o composer acompanha o conteúdo)', () => {
    const a = createFrameAnchor(() => 40);
    a.transform(frame(10));
    const out = a.transform(erase(11) + frame(4));
    expect(out).toBe(erase(11) + frame(4));
  });

  it('a reserva nunca faz o quadro passar da altura do terminal', () => {
    const a = createFrameAnchor(() => 20);
    a.transform(frame(1));
    a.transform(erase(2));
    a.transform(frame(20));
    a.transform(frame(19)); // 19 visíveis (+ cursor = 20)
    const out = a.transform(erase(20) + frame(2));
    expect(padOf(out, 20)).toBeLessThanOrEqual(20 - 3);
  });

  it('clearTerminal (tela cheia repintada pelo Ink) zera a âncora', () => {
    const a = anchored();
    a.transform(erase(11) + frame(4));
    const clearTerminal = '\x1b[2J\x1b[3J\x1b[H';
    expect(a.transform(clearTerminal + frame(30))).toBe(clearTerminal + frame(30));
    // depois do repaint cheio o Ink volta ao erase com a contagem que ELE conhece
    const out = a.transform(erase(3) + frame(2));
    expect(out).toBe(erase(3) + frame(2));
  });

  it('writes que não são quadro (título da janela, sino) não mexem no estado', () => {
    const a = anchored();
    a.transform(erase(11) + frame(4));
    expect(a.transform('\x1b]0;aluy\x07')).toBe('\x1b]0;aluy\x07');
    expect(a.transform('\x07')).toBe('\x07');
    const out = a.transform(erase(5) + frame(4));
    expect(out.startsWith(erase(11))).toBe(true);
  });

  it('contagem do erase diferente da esperada ⇒ não arrisca: segue o Ink sem reserva', () => {
    const a = anchored();
    a.transform(erase(11) + frame(4));
    const out = a.transform(erase(7) + frame(4));
    expect(out).toBe(erase(7) + frame(4));
  });
});
