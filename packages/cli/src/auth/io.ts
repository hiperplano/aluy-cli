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
      const rl = createInterface({ input: entrada, output: saida, terminal: true });
      try {
        if (opts?.secret) {
          // ECO-NA-COLAGEM — o filtro antigo deixava passar tudo que CONTIVESSE o
          // texto do prompt. Digitando, o readline escreve caractere a caractere e
          // o filtro engolia. COLANDO, ele redesenha a linha INTEIRA — que é
          // `"<prompt><segredo>"` e portanto contém o prompt — e a linha ia para a
          // tela com a chave junto, uma vez por pedaço da colagem. Uma API key
          // aparecia em texto claro no terminal, repetida, no unico jeito que
          // alguem realmente informa uma chave.
          //
          // Agora o prompt sai UMA vez por nossa conta e o output do readline e
          // mudo por completo: nada que venha dele chega ao terminal, com colagem,
          // redraw, autocomplete ou o que for. Nao ha condicao a errar.
          saida.write(question);
          const rlAny = rl as unknown as { output?: { write: (s: string) => void } };
          if (rlAny.output) {
            rlAny.output.write = () => {};
          }
        }
        const answer = await new Promise<string>((resolve, reject) => {
          // CTRL-C-NO-PROMPT — o vazamento real que o dono viu ("nada aparece
          // colando, tudo aparece no Ctrl-C") NÃO era o redraw acima: era isto
          // aqui. Sem registrar um listener de 'SIGINT' no `rl`, o readline tem
          // um fallback PRÓPRIO pra Ctrl-C (zero listeners ⇒ `this.close()`
          // interno, SILENCIOSO) que:
          //   1. devolve o tty ao modo cooked (eco do KERNEL ligado de novo) —
          //      correto em si, o terminal PRECISA voltar ao normal em algum
          //      momento; MAS
          //   2. nunca dispara o callback do `rl.question()` pendente — então
          //      este `await` fica pendurado PRA SEMPRE, o `finally` abaixo não
          //      roda (embora seja inofensivo aqui, já que o readline já se
          //      fechou sozinho), e o processo NÃO SAI: fica vivo, mudo, com o
          //      terminal já em eco normal.
          // Dali em diante, QUALQUER coisa digitada/colada é ecoada pelo
          // KERNEL — não pelo readline, não por este módulo — porque o eco em
          // modo cooked é propriedade do driver de tty, não do processo que lê
          // (ou não lê) o fd. O mute de `rl.output.write` acima não alcança
          // isso: nem chega a rodar, pois o readline nem repassa mais nada pra
          // nós. Foi exatamente esse buraco que expôs a chave: sem entender
          // que o prompt tinha travado, o dono colou de novo — e a segunda
          // colagem (e a própria tecla Ctrl-C, ecoada como `^C`) foram
          // despejadas em claro, uma vez pra cada tentativa.
          //
          // Registrar o listener MUDA o comportamento padrão do readline: com
          // listener presente, ele emite 'SIGINT' pra NÓS decidirmos, em vez
          // de sumir sozinho. Rejeitamos NA HORA — o `finally` roda de
          // imediato, fecha o `rl` UMA vez, de forma controlada, e devolve o
          // controle ao caller o mais rápido possível. Isso não elimina o
          // eco cooked em si (inevitável — o terminal tem que voltar ao
          // normal quando o prompt aborta), mas fecha a JANELA DE CONFUSÃO em
          // que o processo fica pendurado e o usuário é tentado a colar de
          // novo num prompt que já desistiu de ouvir.
          rl.once('SIGINT', () => {
            reject(new PromptInterruptedError());
          });
          // prompt vazio no modo secreto: ja o escrevemos antes de silenciar.
          rl.question(opts?.secret ? '' : question, (a) => resolve(a));
        });
        if (opts?.secret) saida.write('\n');
        return answer.trim();
      } finally {
        rl.close();
      }
    },
  };
}
