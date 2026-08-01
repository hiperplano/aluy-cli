// ADR-0158 §5 — RUNNER: log human-readable de UM serviço (`runner.log`) e dos seus
// daemons próprios (`<daemon>.log`). Append simples com timestamp — não é um logger
// estruturado (o `aluy` não tem um ainda); linha única por evento, grep-ável.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureParentDir(path: string): void {
  try {
    mkdirSync(dirname(path), { mode: DIR_MODE, recursive: true });
  } catch {
    /* best-effort */
  }
}

/** Apenda UMA linha (com timestamp ISO) ao log. Best-effort — nunca lança (um log
 * que falha não pode derrubar o runner). */
export function appendLog(path: string, line: string): void {
  try {
    ensureParentDir(path);
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    appendFileSync(path, stamped, { mode: FILE_MODE });
  } catch {
    /* best-effort — log nunca é caminho crítico */
  }
}

/**
 * Últimas `n` linhas do log (`tail`-like, sem dependência externa). Lê o arquivo
 * inteiro (logs de serviço são modestos — um turno por vez, não um firehose) e
 * corta as últimas `n`. Ausente ⇒ `[]` (nunca lança).
 */
export function tailLog(path: string, n: number): readonly string[] {
  try {
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l !== '');
    return lines.slice(Math.max(0, lines.length - n));
  } catch {
    return [];
  }
}
