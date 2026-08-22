// F-ONB-PASTE (relato do dono: "no Windows/cmd.exe não consigo colar") — o que a COLAGEM
// deposita num campo de UMA linha do onboarding.
//
// MEDIDO no TTY, no build de antes (passo da API key, colagem simulada com
// `tmux send-keys -l`, que entrega a rajada como o terminal entrega um paste):
//   · 63 e 300 caracteres num chunk só ⇒ entravam INTEIROS (colar texto simples já
//     funcionava: o `useInput` do Ink entrega o chunk completo, não char-a-char);
//   · `AAA\rBBB` num chunk só ⇒ SETE bullets: o `\r` virava caractere LITERAL da chave;
//   · marcadores de bracketed paste (`\x1b[200~…\x1b[201~`, que o Ink entrega MANGLED)
//     ⇒ 11 bytes de lixo entravam como se fossem parte da chave.
// Em campo MASCARADO nada disso aparece — a chave sai corrompida e a falha só se
// manifesta depois, na autenticação, sem pista na tela.
import { describe, expect, it } from 'vitest';
import {
  contarApagamentos,
  digitarNoCampo,
  sanitizarColagemDeCampo,
} from '../../src/session/onboard.js';

describe('colagem em campo de uma linha do onboarding', () => {
  it('CHUNK longo (chave de 300 chars num paste só) entra INTEIRO', () => {
    const chave = `sk-ant-api03-${'X'.repeat(287)}`;
    expect(chave).toHaveLength(300);
    expect(sanitizarColagemDeCampo(chave)).toBe(chave);
  });

  it('A ORIGEM — `\\r` no meio do chunk NÃO vira caractere do valor', () => {
    // ANTES: 'AAA\rBBB' (7 chars) ia inteiro pro campo, com o CR dentro.
    expect(sanitizarColagemDeCampo('AAA\rBBB')).toBe('AAA');
  });

  it('a quebra ENCERRA o valor: o resto do clipboard multi-linha é descartado', () => {
    expect(sanitizarColagemDeCampo('sk-linha-1\nlinha-2\nlinha-3')).toBe('sk-linha-1');
    expect(sanitizarColagemDeCampo('sk-crlf\r\nsobra')).toBe('sk-crlf');
  });

  it('quebra ANTES do conteúdo não zera o campo (pega a 1ª linha não-vazia)', () => {
    expect(sanitizarColagemDeCampo('\r\n\r\nsk-depois-da-quebra')).toBe('sk-depois-da-quebra');
  });

  it('marcadores de bracketed paste (crus e MANGLED pelo Ink) não entram no campo', () => {
    expect(sanitizarColagemDeCampo('\x1b[200~sk-envelopada\x1b[201~')).toBe('sk-envelopada');
    expect(sanitizarColagemDeCampo('[200~sk-envelopada\x1b[201~')).toBe('sk-envelopada');
  });

  it('rajada de DEL (backspaces que o terminal juntou) não INSERE nada', () => {
    expect(sanitizarColagemDeCampo('\x7f\x7f\x7f')).toBe('');
    expect(sanitizarColagemDeCampo('\t')).toBe('');
  });

  it('…e APAGA o tanto que a rajada pede (chunk homogêneo de DEL/BS)', () => {
    expect(contarApagamentos('\x7f\x7f\x7f')).toBe(3);
    expect(contarApagamentos('\b\b')).toBe(2);
    expect(contarApagamentos('\x7f')).toBe(0); // 1 byte é o `key.backspace` do Ink
    expect(contarApagamentos('sk-abc')).toBe(0); // texto colado NUNCA vira apagamento
    expect(contarApagamentos('ab\x7f')).toBe(0); // chunk misto é colagem, não edição
  });

  it('digitação normal passa INTACTA — o caminho comum não muda', () => {
    for (const t of ['a', 'Z', '9', '-', '/', '.', ' ', 'ç']) {
      expect(sanitizarColagemDeCampo(t)).toBe(t);
    }
  });

  it('o elo com o campo: colar sobre a SUGESTÃO substitui, e o valor sai limpo', () => {
    const colado = sanitizarColagemDeCampo('openai/gpt-4o-mini\n');
    const r = digitarNoCampo({ buf: 'anthropic/claude-3.5-sonnet', ehSugestao: true }, colado);
    expect(r).toEqual({ buf: 'openai/gpt-4o-mini', ehSugestao: false });
  });

  it('colagem FATIADA em vários chunks (terminal que corta a rajada) concatena inteira', () => {
    let e = { buf: '', ehSugestao: false };
    for (const pedaco of ['sk-ant-', 'api03-', 'PARTE-FINAL\r']) {
      const limpo = sanitizarColagemDeCampo(pedaco);
      if (limpo !== '') e = digitarNoCampo(e, limpo);
    }
    expect(e.buf).toBe('sk-ant-api03-PARTE-FINAL');
  });
});
