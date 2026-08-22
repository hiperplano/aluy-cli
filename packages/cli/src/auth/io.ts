// Fronteira de I/O de terminal dos comandos de auth. Concentrar aqui torna os
// comandos TESTÁVEIS (injetamos um IO fake) e mantém o I/O fora do core.

import { stderr, stdin, stdout } from 'node:process';

export interface TerminalIO {
  /** Escreve uma linha no stdout. */
  out(line: string): void;
  /** Escreve uma linha no stderr (avisos/erros). */
  err(line: string): void;
  /** Lê uma linha (ex.: PAT colado), sem ecoar quando `secret`. */
  prompt(question: string, opts?: { secret?: boolean }): Promise<string>;
}

/**
 * CTRL-C-NO-PROMPT — lançado quando o usuário interrompe um `prompt()` com
 * Ctrl-C. NUNCA carrega segredo (só sinaliza a interrupção). O caller decide o
 * que fazer (tipicamente: avisar e sair) — ver comentário em `prompt()` sobre
 * por que capturar isto é o que evita o vazamento em claro no Ctrl-C.
 */
export class PromptInterruptedError extends Error {
  constructor() {
    super('prompt interrompido (Ctrl-C)');
    this.name = 'PromptInterruptedError';
  }
}

/** Streams do terminal. Injetáveis SÓ para teste — em produção caem no process. */
export interface TerminalStreams {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly errOutput?: NodeJS.WritableStream;
}

/** IO real ligado ao terminal. Carregado só no caminho que precisa de prompt.
 *
 * Recebe os streams por parâmetro porque a propriedade que importa aqui — o segredo
 * NUNCA chega ao terminal — não é verificável sem poder observar o que foi escrito.
 * Enquanto isso dependia de `process.stdout` direto, a supressão de eco ficou sem
 * teste e quebrou calada: colar uma API key a imprimia em texto claro.
 */
export function realTerminalIO(streams: TerminalStreams = {}): TerminalIO {
  const saida = streams.output ?? stdout;
  const saidaErro = streams.errOutput ?? stderr;
  const entrada = streams.input ?? stdin;
  return {
    out: (line) => {
      saida.write(line + '\n');
    },
    err: (line) => {
      saidaErro.write(line + '\n');
    },
    prompt: async (question, opts) => {
      // readline só aqui (I/O de terminal mora em @hiperplano/aluy-cli — ADR-0053 §8).
      const { createInterface } = await import('node:readline');
      const { Writable } = await import('node:stream');

      // ECO-NA-COLAGEM — o filtro antigo deixava passar tudo que CONTIVESSE o texto do
      // prompt. Digitando, o readline escreve caractere a caractere e o filtro engolia.
      // COLANDO, ele redesenha a linha INTEIRA — `"<prompt><segredo>"`, que contém o
      // prompt — e a chave ia para a tela em claro, uma vez por pedaço da colagem.
      //
      // A cura anterior era sobrescrever `rl.output.write` por um no-op. Isso matava o
      // vazamento e criava um defeito PIOR, porque `rl.output` É o `saida` recebido — ou
      // seja, o `process.stdout` do processo. O `write` do stdout virava no-op e NUNCA
      // era restaurado: da primeira chamada de `prompt(secret)` em diante, TODA saída do
      // comando sumia. O `✓ API key guardada` nunca chegava ao dono, que digitava, colava,
      // não via nada e concluía "não funciona" — enquanto a chave era gravada certinho.
      // Os ERROS continuavam visíveis (stderr é outro stream), então o comando só sabia
      // reclamar, nunca confirmar.
      //
      // Agora o readline escreve num SUMIDOURO dedicado. Ele pode redesenhar o que quiser:
      // nada daquilo alcança o terminal, e o `saida` do processo fica intacto para o
      // prompt, o eco mascarado e a confirmação.
      const sumidouro = opts?.secret
        ? new Writable({
            write(_pedaco, _enc, cb) {
              cb();
            },
          })
        : undefined;
      const rl = createInterface({
        input: entrada,
        output: sumidouro ?? saida,
        terminal: true,
      });
      // Removido no `finally` — um listener sobrevivente ecoaria `•` no PRÓXIMO prompt.
      let ecoMascarado: ((pedaco: Buffer | string) => void) | undefined;
      try {
        if (opts?.secret) {
          saida.write(question);
          // ECO-MASCARADO — silenciar o readline resolve o vazamento e leva junto TODO
          // retorno visual: colar não desenhava nada. O dono relatou "não consigo colar a
          // api key" e abortou com Ctrl-C; a colagem tinha entrado. Um prompt honesto
          // quanto ao segredo e mudo quanto ao progresso é indistinguível de um travado.
          //
          // A TUI já fazia certo (`maskValue` desenha `•` por caractere no
          // <ProviderPicker>). Aqui era diferente para a MESMA chave, e a pior das duas
          // versões era a que sobrava para quem usa a linha de comando.
          //
          // Nunca ecoa o que foi digitado: só `•` (um por caractere visível) e `\b \b` no
          // backspace. Caractere de CONTROLE não vira ponto — um Ctrl-V viraria `•` e
          // mentiria sobre o tamanho do que entrou.
          //
          // Só em TTY REAL: sem tela não há retorno a dar, e num pipe os pontos virariam
          // lixo no stdout de quem consome a saída.
          if ((entrada as { isTTY?: boolean }).isTTY === true) {
            let mostrados = 0;
            ecoMascarado = (pedaco: Buffer | string): void => {
              const texto = typeof pedaco === 'string' ? pedaco : pedaco.toString('utf8');
              let desenho = '';
              for (const ch of texto) {
                if (ch === '\r' || ch === '\n') break; // enter encerra — nada a desenhar
                const code = ch.codePointAt(0) ?? 0;
                if (code === 0x7f || code === 0x08) {
                  if (mostrados > 0) {
                    desenho += '\b \b';
                    mostrados -= 1;
                  }
                  continue;
                }
                if (code < 0x20) continue; // controle — nunca vira ponto
                desenho += '•';
                mostrados += 1;
              }
              if (desenho !== '') saida.write(desenho);
            };
            entrada.on('data', ecoMascarado);
          }
        }
        const answer = await new Promise<string>((resolve, reject) => {
          // CTRL-C-NO-PROMPT — sem um listener de 'SIGINT' no `rl`, o readline tem um
          // fallback PRÓPRIO (fecha sozinho, silencioso) que devolve o tty ao modo cooked
          // mas NUNCA dispara o callback do `question()` pendente: este `await` ficava
          // pendurado para sempre e o processo seguia vivo e mudo, com o eco do KERNEL
          // ligado de novo. Dali em diante qualquer coisa colada era ecoada em claro pelo
          // driver de tty — não por este módulo, que já não recebia nada. Foi esse buraco
          // que expôs uma chave real: sem entender que o prompt tinha desistido, o dono
          // colava outra vez, e a segunda colagem ia para a tela.
          //
          // Com listener, o readline emite 'SIGINT' para NÓS decidirmos. Rejeitamos na
          // hora: o `finally` roda, fecha o `rl` uma vez, de forma controlada, e fecha a
          // janela de confusão em que o usuário é tentado a colar num prompt morto.
          rl.once('SIGINT', () => {
            reject(new PromptInterruptedError());
          });
          // prompt vazio no modo secreto: já o escrevemos antes, no `saida` de verdade.
          rl.question(opts?.secret ? '' : question, (a) => resolve(a));
        });
        if (opts?.secret) saida.write('\n');
        return answer.trim();
      } finally {
        if (ecoMascarado) entrada.off('data', ecoMascarado);
        rl.close();
      }
    },
  };
}
