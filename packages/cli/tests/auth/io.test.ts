// Teste DIRETO de `realTerminalIO().prompt(..., { secret: true })` — antes
// disto o comentário do próprio código dizia "SEM teste direto" (M-4). A
// propriedade que importa: o segredo NUNCA aparece no que foi escrito no
// output, nem durante a digitação/colagem, nem no caminho de interrupção
// (Ctrl-C) — foi exatamente esse último que vazou uma API key real em
// produção (F166: "nada aparece colando, tudo aparece no Ctrl-C").
//
// `terminal: true` no `readline.createInterface` faz o parsing de keypress
// (inclusive Ctrl-C ⇒ evento 'SIGINT') funcionar mesmo com um `PassThrough`
// que NÃO é um tty real — dá pra reproduzir os dois bugs (redraw-na-colagem e
// hang-no-Ctrl-C) sem precisar de um pty de verdade.

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { realTerminalIO, PromptInterruptedError } from '../../src/auth/io.js';

const SEGREDO = 'sk-real-0123456789abcdefghijklmnopqrstuvwxyz';

/** Streams fake + captura de tudo que foi escrito no "terminal". */
function fakeTerminal(): {
  input: PassThrough;
  output: PassThrough;
  errOutput: PassThrough;
  written: () => string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const errOutput = new PassThrough();
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
  });
  errOutput.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
  });
  return { input, output, errOutput, written: () => buf };
}

/** Espera microtasks/timers pendentes assentarem (keypress é processado async). */
function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('realTerminalIO — prompt secreto nunca ecoa o segredo', () => {
  it('digitando caractere a caractere: nenhum caractere do segredo aparece no output', async () => {
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('API key: ', { secret: true });
    await tick();
    for (const ch of SEGREDO) {
      term.input.write(ch);
      await tick(1);
    }
    term.input.write('\n');
    const answer = await p;
    expect(answer).toBe(SEGREDO);
    expect(term.written()).not.toContain(SEGREDO);
    // nenhum PREFIXO relevante do segredo pode escapar (nem em pedaços).
    expect(term.written()).not.toContain(SEGREDO.slice(0, 8));
  });

  it('colando tudo de uma vez (redraw da linha inteira): não vaza — REGRESSÃO do bug original', async () => {
    // Este é o caso que o filtro antigo ("deixa passar se contém o prompt")
    // deixava vazar: colar entrega o valor inteiro num único write(), o
    // readline redesenha a LINHA INTEIRA (prompt+buffer) de uma vez, e como
    // essa string contém o texto do prompt, o filtro antigo deixava passar —
    // com a chave junto. Sem o mute atual, esta asserção falharia.
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('API key: ', { secret: true });
    await tick();
    term.input.write(SEGREDO); // colagem: um único write com tudo.
    await tick();
    term.input.write('\n');
    const answer = await p;
    expect(answer).toBe(SEGREDO);
    expect(term.written()).not.toContain(SEGREDO);
  });

  it('Ctrl-C durante a colagem: a promise REJEITA (não fica pendurada) e o segredo nunca aparece', async () => {
    // F166 — o vazamento real do dono. Sem o listener de 'SIGINT', o readline
    // se autofecha em silêncio (fallback padrão dele) e o `rl.question()`
    // pendente NUNCA chama seu callback: a promise do prompt ficaria
    // pendurada pra sempre, o processo não sairia, e o terminal voltaria ao
    // modo cooked (eco do KERNEL ligado) enquanto ninguém mais lê o stdin —
    // é aí que uma segunda colagem/qualquer tecla vaza em claro, sem que
    // nenhum código deste módulo veja ou escreva nada.
    //
    // Com o listener registrado, o Ctrl-C REJEITA a promise na hora — a
    // asserção abaixo falharia (timeout) se a promise ficasse pendurada.
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('API key: ', { secret: true });
    await tick();
    term.input.write(SEGREDO.slice(0, 10)); // colagem parcial (interrompida no meio).
    await tick();
    term.input.write('\x03'); // Ctrl-C — byte real que o tty entregaria em raw mode.
    await expect(p).rejects.toBeInstanceOf(PromptInterruptedError);
    expect(term.written()).not.toContain(SEGREDO);
    expect(term.written()).not.toContain(SEGREDO.slice(0, 10));
  });

  it('Ctrl-C seguido de mais colagem no MESMO stream: nada do segredo aparece (o prompt já desistiu de ouvir)', async () => {
    // Simula o usuário confuso que, achando que travou, cola de novo. No
    // aluy real isso vaza pelo ECO DO KERNEL (fora do alcance de qualquer
    // JS, incl. este módulo) quando o processo fica pendurado — o que este
    // teste garante é a PRIMEIRA linha de defesa: aqui dentro, a promise
    // rejeita rápido (não fica pendurada) e nada que já passou pelo `rl`
    // interrompido chega a ser escrito no output por ESTE código.
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('API key: ', { secret: true });
    await tick();
    term.input.write(SEGREDO.slice(0, 5));
    await tick();
    term.input.write('\x03');
    await expect(p).rejects.toBeInstanceOf(PromptInterruptedError);
    // depois da rejeição, mais dados no MESMO input não devem ressuscitar
    // nem escrever nada (o `rl` já foi fechado no `finally`).
    term.input.write(SEGREDO);
    await tick();
    expect(term.written()).not.toContain(SEGREDO);
  });
});

describe('realTerminalIO — prompt não-secreto: comportamento básico preservado', () => {
  it('resolve com a linha digitada e ecoa normalmente (não é secreto)', async () => {
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('nome: ');
    await tick();
    term.input.write('tiago\n');
    const answer = await p;
    expect(answer).toBe('tiago');
  });

  it('Ctrl-C também rejeita (não trava) mesmo fora do modo secreto', async () => {
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('nome: ');
    await tick();
    term.input.write('\x03');
    await expect(p).rejects.toBeInstanceOf(PromptInterruptedError);
  });
});
