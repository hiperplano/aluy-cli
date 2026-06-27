// EST-0981 · EST-1155 · ADR-0062 · ADR-0132 · CLI-SEC-14 — parsing PURO da linha de `/cycle`.
//
// Contrato (ADR-0062 §0 + ADR-0132 §3): `/cycle <intervalo|duração> "tarefa"` —
// intervalo OU duração + TAREFA entre aspas. A forma exata das flags é UX; o
// invariante é:
//  • intervalo posicional: `5m`/`30s`/`1h` (ritmo FIXO "a cada N");
//  • SINÔNIMOS NATURAIS (EST-1155): `a cada 30s`/`a cada 5m` ⇒ intervalo;
//    `5x`/`5 vezes` ⇒ `--max-iter 5`;
//  • duração total: `--por <dur>` (`--for`/`--during` aceitos como alias);
//  • iterações: `--max-iter <n>`; budget agregado: `--budget <tokens>`;
//  • auto-pacing: `--auto` (o agente decide o ritmo) — MESMOS tetos (GS-L8);
//  • tarefa é o restante — aspas OPCIONAIS quando sem ambiguidade
//    (na dúvida, peça aspas — ADR-0132 §4);
//  • CAP EXPLÍCITO intacto (CLI-SEC-14): sem teto NÃO inicia.
//
// SÓ parsing — a resolução/validação dos tetos (sem-teto⇒não-inicia) é do
// `resolveCycleCeilings` (cycle-limits.ts). PORTÁVEL: sem I/O.

import type { CycleRequest, CycleRhythm } from './cycle-limits.js';

/** Resultado do parse: o pedido bruto + a tarefa. */
export interface ParsedCycleInput {
  readonly request: CycleRequest;
  readonly task: string;
}

export class CycleParseError extends Error {
  readonly code = 'CYCLE_PARSE';
  constructor(message: string) {
    super(message);
    this.name = 'CycleParseError';
  }
}

/**
 * Constrói uma sugestão DIDÁTICA que, copiada literalmente, parseia e inicia
 * (EST-1155 CA-5 / ADR-0062 Addendum 2 A1.3 — anti-F10).
 */
function didacticSuggestion(hint: {
  task?: string;
  intervalToken?: string | undefined;
  example?: string;
}): string {
  if (hint.example) {
    return `  tente: /cycle ${hint.example}`;
  }
  const quotedTask = hint.task
    ? hint.task.includes('"')
      ? `'${hint.task}'`
      : `"${hint.task}"`
    : '"minha tarefa"';
  const interval = hint.intervalToken ? `a cada ${hint.intervalToken} ` : '5m ';
  return `  tente: /cycle ${interval}${quotedTask} 5x`;
}

/**
 * Converte `5m`/`30s`/`1h`/`90` em ms. `90` (sem sufixo) = segundos. Retorna
 * `undefined` se não é uma duração reconhecível. Aceita `ms`/`s`/`m`/`h`.
 *
 * HUNT-SLASH: uma duração de ZERO (`0`/`0s`/`--por 0`) NÃO é uma duração válida —
 * é rejeitada (`<= 0`), não aceita como `0`.
 */
export function parseDuration(token: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(token.trim());
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  switch ((m[2] ?? 's').toLowerCase()) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      return undefined;
  }
}

/**
 * Parseia a linha do comando `/cycle` (já SEM o `/cycle`). Tokeniza respeitando
 * aspas (a tarefa entre `"…"`/`'…'`). Determinístico, sem I/O.
 *
 * EST-1155 — formas naturais + aspas opcionais + erro didático:
 * • `a cada 30s "tarefa" 5x` → intervalo 30s, tarefa "tarefa", max-iter 5.
 * • `5x a cada 30s busque geladeira` → max-iter 5, intervalo 30s, tarefa sem aspas.
 * • `a cada 5m busque 5x geladeira` → AMBÍGUO: "5x" no meio da tarefa ⇒ erro.
 * • CAP EXPLÍCITO intacto: o parser só extrai; a validação "sem teto ⇒ não inicia"
 *   segue em `resolveCycleCeilings`.
 */
export function parseCycleInput(raw: string): ParsedCycleInput {
  const tokens = tokenize(raw);

  let intervalMs: number | undefined;
  let maxDurationMs: number | undefined;
  let maxIterations: number | undefined;
  let maxTokens: number | undefined;
  let rhythm: CycleRhythm = 'fixed';
  const taskTokens: string[] = [];

  // Guarda o token do intervalo natural p/ mensagem didática.
  let naturalIntervalToken: string | undefined;

  // Máquina de estados: BEFORE_TASK → aceita tokens estruturais. O primeiro
  // token NÃO-estrutural transita p/ IN_TASK. Em IN_TASK, só aceitamos
  // `Nx`/`N vezes` se forem os ÚLTIMOS tokens; outro estrutural ⇒ ambiguidade.
  let state: 'before_task' | 'in_task' = 'before_task';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    // Tokens entre aspas são SEMPRE parte da tarefa (vão p/ taskTokens).
    // Mas NÃO alteram o estado ainda: flags podem aparecer DEPOIS de aspas
    // (ex.: `5m "tarefa" --max-iter 10`). O estado só transita quando um
    // token NÃO-citado e NÃO-estrutural aparece.
    if (t.quoted) {
      taskTokens.push(t.value);
      continue;
    }

    const lower = t.value.toLowerCase();

    // ── Flags (aceitas em QUALQUER estado) ──────────────────────────────
    if (lower === '--auto' || lower === '--auto-pace') {
      rhythm = 'auto-pace';
      continue;
    }

    if (lower === '--por' || lower === '--for' || lower === '--during') {
      const next = tokens[++i];
      if (!next || next.quoted) {
        throw new CycleParseError(
          `falta duração após \`${t.value}\`.\n` +
            didacticSuggestion({ example: `--por 30m "minha tarefa"` }),
        );
      }
      const dur = parseDuration(next.value);
      if (dur === undefined || dur <= 0) {
        throw new CycleParseError(
          `duração inválida após \`${t.value}\`: "${next.value}".\n` +
            didacticSuggestion({ example: `--por 30m "minha tarefa"` }),
        );
      }
      maxDurationMs = dur;
      continue;
    }

    if (lower === '--max-iter' || lower === '--iter') {
      const next = tokens[++i];
      if (!next || next.quoted) {
        throw new CycleParseError(
          `falta número após \`${t.value}\`.\n` +
            didacticSuggestion({ example: `5m "tarefa" --max-iter 10` }),
        );
      }
      const n = Number(next.value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        throw new CycleParseError(
          `\`${t.value}\` exige um nº inteiro ≥ 1 (recebeu "${next.value}").\n` +
            didacticSuggestion({ example: `5m "tarefa" --max-iter 10` }),
        );
      }
      maxIterations = n;
      continue;
    }

    if (lower === '--budget') {
      const next = tokens[++i];
      if (!next || next.quoted) {
        throw new CycleParseError(
          `falta número após \`--budget\`.\n` +
            didacticSuggestion({ example: `5m "tarefa" --budget 50000` }),
        );
      }
      const n = Number(next.value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
        throw new CycleParseError(
          `\`--budget\` exige um nº de tokens ≥ 1 (recebeu "${next.value}").\n` +
            didacticSuggestion({ example: `5m "tarefa" --budget 50000` }),
        );
      }
      maxTokens = n;
      continue;
    }

    if (state === 'before_task') {
      // ── Forma natural: `a cada <dur>` → intervalo ─────────────────────
      if (
        lower === 'a' &&
        i + 2 < tokens.length &&
        !tokens[i + 1]!.quoted &&
        !tokens[i + 2]!.quoted &&
        tokens[i + 1]!.value.toLowerCase() === 'cada'
      ) {
        const durToken = tokens[i + 2]!.value;
        const dur = parseDuration(durToken);
        if (dur !== undefined && dur > 0) {
          if (intervalMs === undefined) {
            intervalMs = dur;
            naturalIntervalToken = durToken;
          }
          i += 2; // consome `cada` e `<dur>`
          continue;
        }
        // `a cada <lixo>`: fall through p/ tarefa.
      }

      // ── Forma natural: `<N>x` → max-iter ──────────────────────────────
      const nxMatch = /^(\d+)x$/i.exec(t.value);
      if (nxMatch) {
        const n = Number(nxMatch[1]);
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
          if (maxIterations === undefined) maxIterations = n;
          continue;
        }
      }

      // ── Forma natural: `<N> vezes` → max-iter ─────────────────────────
      if (
        i + 1 < tokens.length &&
        !tokens[i + 1]!.quoted &&
        tokens[i + 1]!.value.toLowerCase() === 'vezes'
      ) {
        const n = Number(t.value);
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
          if (maxIterations === undefined) maxIterations = n;
          i++; // consome `vezes`
          continue;
        }
      }

      // ── Duração posicional (1º token não-citado parseável como dur) ──
      if (intervalMs === undefined && taskTokens.length === 0) {
        const dur = parseDuration(t.value);
        if (dur !== undefined && dur > 0) {
          intervalMs = dur;
          continue;
        }
      }

      // ── Token NÃO-estrutural → transita p/ IN_TASK ────────────────────
      taskTokens.push(t.value);
      state = 'in_task';
      continue;
    }

    // ══════════════════════════════════════════════════════════════════════
    // ESTADO: IN_TASK
    // ══════════════════════════════════════════════════════════════════════

    // Em IN_TASK, só aceitamos `Nx`/`N vezes` se forem os ÚLTIMOS tokens.
    // Qualquer outro token estrutural ⇒ ambiguidade.

    // `<N>x` no FINAL → aceita como max-iter.
    if (i === tokens.length - 1) {
      const nxEnd = /^(\d+)x$/i.exec(t.value);
      if (nxEnd) {
        const n = Number(nxEnd[1]);
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
          if (maxIterations === undefined) maxIterations = n;
          continue;
        }
      }
    }

    // `<N> vezes` no FINAL → aceita como max-iter.
    if (
      i === tokens.length - 2 &&
      !tokens[i + 1]!.quoted &&
      tokens[i + 1]!.value.toLowerCase() === 'vezes'
    ) {
      const n = Number(t.value);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
        if (maxIterations === undefined) maxIterations = n;
        i++; // consome `vezes`
        continue;
      }
    }

    // ── Detecção de ambiguidade ─────────────────────────────────────────
    if (isStructuralToken(t.value)) {
      const escaped = t.value.length > 30 ? t.value.slice(0, 30) + '…' : t.value;
      throw new CycleParseError(
        `sintaxe ambígua: "${escaped}" pode ser parâmetro do /cycle ou parte da tarefa.\n` +
          `Use aspas na tarefa para desambiguar:\n` +
          didacticSuggestion({
            task: [...taskTokens, t.value].join(' '),
            intervalToken: naturalIntervalToken,
          }),
      );
    }

    taskTokens.push(t.value);
  }

  const task = taskTokens.join(' ').trim();

  if (task === '') {
    throw new CycleParseError(
      `falta a TAREFA do /cycle.\n` +
        didacticSuggestion({
          intervalToken: naturalIntervalToken ?? '30s',
        }),
    );
  }

  const request: CycleRequest = {
    rhythm,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
  return { request, task };
}

/**
 * Verifica se um token PARECE estrutural (forma natural ou flag) — usado na
 * detecção de ambiguidade em IN_TASK. Não valida o valor, só o formato.
 */
function isStructuralToken(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    lower === '--auto' ||
    lower === '--auto-pace' ||
    lower === '--por' ||
    lower === '--for' ||
    lower === '--during' ||
    lower === '--max-iter' ||
    lower === '--iter' ||
    lower === '--budget'
  ) {
    return true;
  }
  if (/^\d+x$/i.test(value)) return true;
  if (lower === 'vezes') return true;
  if (lower === 'a' || lower === 'cada') return true;
  if (/^\d+(?:\.\d+)?\s*(ms|s|m|h)?$/i.test(value)) {
    const dur = parseDuration(value);
    if (dur !== undefined && dur > 0) return true;
  }
  return false;
}

/** Token com flag de "veio entre aspas" (a tarefa não é confundida com flag). */
interface Token {
  readonly value: string;
  readonly quoted: boolean;
}

/** Tokeniza respeitando aspas simples/duplas (a tarefa entre aspas é UM token). */
function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) out.push({ value: m[1], quoted: true });
    else if (m[2] !== undefined) out.push({ value: m[2], quoted: true });
    else out.push({ value: m[3]!, quoted: false });
  }
  return out;
}
