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

/** IO real ligado ao terminal. Carregado só no caminho que precisa de prompt. */
export function realTerminalIO(): TerminalIO {
  return {
    out: (line) => {
      stdout.write(line + '\n');
    },
    err: (line) => {
      stderr.write(line + '\n');
    },
    prompt: async (question, opts) => {
      // readline só aqui (I/O de terminal mora em @hiperplano/aluy-cli — ADR-0053 §8).
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: stdin, output: stdout, terminal: true });
      try {
        if (opts?.secret) {
          // Suprime o eco: muteia o output stream durante a digitação.
          // FOLLOW-UP M-4 (registrar no aluy-specs): supressão de eco via
          // monkey-patch de `output.write` é frágil e SEM teste direto. Risco
          // contido: o caminho HEADLESS/CI usa `--token`/env (não este prompt),
          // e o segredo nunca é ecoado mesmo que o patch falhe parcialmente.
          // Considerar um mute-stream testável ou readline com `muted`.
          const rlAny = rl as unknown as { output?: { write: (s: string) => void } };
          const original = rlAny.output?.write?.bind(rlAny.output);
          if (rlAny.output && original) {
            rlAny.output.write = (s: string) => {
              // Deixa passar só o prompt/Enter; engole os caracteres digitados.
              if (s.includes(question) || s === '\n' || s === '\r\n') original(s);
            };
          }
        }
        const answer = await new Promise<string>((resolve) => {
          rl.question(question, (a) => resolve(a));
        });
        if (opts?.secret) stdout.write('\n');
        return answer.trim();
      } finally {
        rl.close();
      }
    },
  };
}
