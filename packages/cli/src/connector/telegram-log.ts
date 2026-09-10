// DIÁRIO DA PONTE — o log do conector precisa ir para um ARQUIVO, não para o stderr.
//
// Por que isto existe (01/09): a ponte já registrava tudo o que importa — mensagem
// descartada pela malha e o motivo, queda do long-poll, erro de roteamento. Só que o
// destino padrão era `process.stderr.write`, e numa TUI Ink o stderr é engolido pela tela.
// O dono passou o dia mandando mensagem e vendo NADA acontecer, enquanto o motivo exato
// era escrito num lugar que ninguém pode ler.
//
// Medido no mesmo dia: a sessão dele ESTAVA polizando (duas conexões abertas com
// `api.telegram.org`) e a fila do Telegram estava ZERADA — ou seja, as mensagens chegavam
// e eram consumidas. O que faltava era saber o que acontecia DEPOIS, e essa resposta ia
// para o vazio.
//
// Decisões deliberadas:
//  • ANEXA (não trunca): o defeito é intermitente; perder o histórico ao reabrir a sessão
//    destruiria justamente a evidência que se quer.
//  • TETO de tamanho: um log que cresce sem limite vira outro problema. Ao estourar,
//    rotaciona UMA vez (`.1`) — sem inventar um esquema de retenção.
//  • NUNCA lança: diagnóstico não pode derrubar a ponte que ele observa.
//  • O texto já vem REDIGIDO de quem chama (`safe()` da bridge, C1) — este módulo não
//    inspeciona nem tenta redigir de novo; só carimba a hora e grava.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Teto do arquivo antes de rotacionar. 2 MB cobre dias de uso normal. */
const TETO_BYTES = 2 * 1024 * 1024;

/** Caminho padrão do diário. */
export function caminhoLogTelegram(base?: string): string {
  return join(base ?? join(homedir(), '.aluy'), 'telegram.log');
}

/**
 * Devolve a função de log da ponte. Anexa uma linha com carimbo de hora.
 *
 * `agora` é injetável p/ teste (o carimbo entra na asserção). Falha de I/O é ENGOLIDA de
 * propósito — ver o cabeçalho: o diagnóstico nunca pode derrubar o que ele observa.
 */
export function criarLogTelegram(
  opts: {
    readonly arquivo?: string;
    readonly agora?: () => Date;
  } = {},
): (linha: string) => void {
  const arquivo = opts.arquivo ?? caminhoLogTelegram();
  const agora = opts.agora ?? ((): Date => new Date());
  return (linha: string): void => {
    try {
      mkdirSync(dirname(arquivo), { recursive: true, mode: 0o700 });
      try {
        if (statSync(arquivo).size > TETO_BYTES) renameSync(arquivo, `${arquivo}.1`);
      } catch {
        // arquivo ainda não existe (ou rename negado) ⇒ segue e anexa
      }
      appendFileSync(arquivo, `${agora().toISOString()} ${linha}\n`, { mode: 0o600 });
    } catch {
      // disco cheio / permissão / caminho inválido ⇒ o diagnóstico se cala, a ponte segue.
    }
  };
}
