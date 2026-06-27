// EST-1009 — caminho do `~/.aluy/` (diretório do agente: journal/memória/config).
//
// O lançador do sandbox PRECISA conhecer este path p/ um único fim: REJEITAR
// (fail-safe alto) qualquer bind/cwd que o alcance — o sandbox NUNCA monta
// `~/.aluy/` no namespace (ADR-0065 §2). É o MESMO `join(homedir(), '.aluy')` que
// journal-store/memory-store usam inline; aqui centralizado p/ o sandbox.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste (tmpdir). */
export function aluyHomeDir(home: string = homedir()): string {
  return join(home, '.aluy');
}
