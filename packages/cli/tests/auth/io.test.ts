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

// ECO-MASCARADO — o eco esconde o segredo E dá retorno de que a colagem entrou.
//
// O silêncio total (mute do readline) matou o vazamento e criou outro defeito: colar
// não desenhava nada, e o dono concluiu "não consigo colar a api key" e abortou com
// Ctrl-C — a chave TINHA entrado. Um prompt honesto quanto ao segredo e mudo quanto ao
// progresso é indistinguível de um prompt travado.
//
// Só em TTY: `fakeTerminal()` acima não marca `isTTY`, então os testes de não-vazamento
// anteriores seguem exercitando o caminho mudo. Aqui marcamos para exercitar o ramo NOVO.
function fakeTty(): ReturnType<typeof fakeTerminal> {
  const term = fakeTerminal();
  Object.assign(term.input, { isTTY: true, setRawMode: () => {} });
  return term;
}

describe('realTerminalIO — eco MASCARADO (só em TTY)', () => {
  it('colando: desenha um • por caractere e NENHUM caractere do segredo', async () => {
    const term = fakeTty();
    const p = realTerminalIO(term).prompt('API key: ', { secret: true });
    await tick();
    term.input.write(SEGREDO);
    await tick();
    term.input.write('\n');
    expect(await p).toBe(SEGREDO);
    const saiu = term.written();
    expect(saiu).not.toContain(SEGREDO);
    expect(saiu).not.toContain(SEGREDO.slice(0, 8));
    // A propriedade que o dono precisava ver: houve retorno visual, na medida certa.
    expect((saiu.match(/•/g) ?? []).length).toBe(SEGREDO.length);
  });

  it('backspace apaga UM ponto (não come o texto do prompt)', async () => {
    const term = fakeTty();
    const p = realTerminalIO(term).prompt('API key: ', { secret: true });
    await tick();
    term.input.write('abcd');
    await tick();
    term.input.write('\x7f'); // backspace
    await tick();
    term.input.write('\n');
    await p;
    const saiu = term.written();
    expect((saiu.match(/•/g) ?? []).length).toBe(4); // 4 desenhados
    expect(saiu.split('\u0008 \u0008').length - 1).toBe(1); // 1 apagado
    expect(saiu).toContain('API key: '); // o prompt sobreviveu
  });

  it('backspace com o campo VAZIO não apaga nada (senão comeria o prompt)', async () => {
    const term = fakeTty();
    const p = realTerminalIO(term).prompt('API key: ', { secret: true });
    await tick();
    term.input.write('\x7f\x7f\x7f');
    await tick();
    term.input.write('x\n');
    await p;
    expect(term.written().split('\u0008 \u0008').length - 1).toBe(0);
  });

  it('caractere de CONTROLE não vira ponto (um Ctrl-V mentiria sobre o tamanho)', async () => {
    const term = fakeTty();
    const p = realTerminalIO(term).prompt('API key: ', { secret: true });
    await tick();
    term.input.write('\x16ab'); // Ctrl-V + dois visíveis
    await tick();
    term.input.write('\n');
    await p;
    expect((term.written().match(/•/g) ?? []).length).toBe(2);
  });

  // O ramo que NÃO deve desenhar — sem ele, um pipe/CI ganharia lixo no stdout.
  it('SEM TTY: nenhum ponto é desenhado (comportamento anterior intacto)', async () => {
    const term = fakeTerminal(); // sem isTTY
    const p = realTerminalIO(term).prompt('API key: ', { secret: true });
    await tick();
    term.input.write(SEGREDO);
    await tick();
    term.input.write('\n');
    expect(await p).toBe(SEGREDO);
    expect(term.written()).not.toContain('•');
  });
});

// STDOUT-MORTO — a regressão mais cara deste arquivo, e a que ninguém via.
//
// A supressão de eco era feita sobrescrevendo `rl.output.write` por um no-op. Mas
// `rl.output` É o stream passado como `output` — o `process.stdout` do processo. O
// `write` do stdout virava no-op e NUNCA voltava: da primeira chamada de
// `prompt(secret)` em diante, TUDO que o comando escrevesse sumia.
//
// O sintoma no campo não parecia isso. O dono rodava `aluy login --provider X`,
// digitava a chave, apertava enter — e a tela não dizia NADA. Concluiu "não consigo
// colar a api key" e tentou de novo, várias vezes. A chave estava sendo gravada em
// todas elas. Só os ERROS apareciam (stderr é outro stream), então o comando sabia
// reclamar e não sabia confirmar — o pior arranjo possível.
describe('realTerminalIO — o prompt secreto não pode MATAR o stdout', () => {
  it('depois de um prompt secreto, out() ainda escreve (a confirmação chega ao dono)', async () => {
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p = io.prompt('API key: ', { secret: true });
    await tick();
    term.input.write(SEGREDO);
    await tick();
    term.input.write('\n');
    expect(await p).toBe(SEGREDO);

    io.out('✓ API key guardada no keychain do SO.');
    await tick();
    expect(term.written()).toContain('✓ API key guardada no keychain do SO.');
    expect(term.written()).not.toContain(SEGREDO); // e o segredo segue fora da tela
  });

  it('DOIS prompts seguidos: o segundo ainda escreve o próprio texto', async () => {
    const term = fakeTerminal();
    const io = realTerminalIO(term);
    const p1 = io.prompt('primeira: ', { secret: true });
    await tick();
    term.input.write('um\n');
    await p1;
    const p2 = io.prompt('segunda: ', { secret: true });
    await tick();
    term.input.write('dois\n');
    await p2;
    expect(term.written()).toContain('segunda: ');
  });
});
