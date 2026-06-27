// EST-0970 — RENDER do relatório do `/doctor`: do `DoctorReport` (puro) p/ LINHAS de
// texto, compartilhado pelos DOIS pontos de saída:
//   • `/doctor` na sessão ⇒ uma nota (bloco) na TUI, com os glifos do tema.
//   • `aluy doctor` no shell ⇒ o MESMO texto no stdout (glifos ASCII-friendly), +
//     exit≠0 se houver ✗ (útil em script/CI).
//
// Puro/sem I/O: recebe o report + o conjunto de glifos (injetado) e devolve linhas.
// O glifo é PARÂMETRO (não importamos o tema aqui) p/ a render servir tanto a TUI
// (glifos Unicode do tema) quanto o shell (ASCII), sem acoplar a uma só superfície.

import { summarize, type DoctorReport, type DoctorStatus } from './checks.js';

/** Glifos de status (✓/⚠/✗) — injetados pelo chamador (tema na TUI, ASCII no shell). */
export interface DoctorGlyphs {
  readonly ok: string;
  readonly warn: string;
  readonly fail: string;
}

/** Glifos ASCII-friendly p/ o `aluy doctor` (saída piped/CI sem fonte garantida). */
export const ASCII_DOCTOR_GLYPHS: DoctorGlyphs = { ok: '[ok]', warn: '[!]', fail: '[x]' };

/** Glifos Unicode p/ a nota na TUI (default de cobertura ampla, EST-0984). */
export const UNICODE_DOCTOR_GLYPHS: DoctorGlyphs = { ok: '✓', warn: '⚠', fail: '✗' };

function glyphFor(status: DoctorStatus, g: DoctorGlyphs): string {
  return status === 'ok' ? g.ok : status === 'warn' ? g.warn : g.fail;
}

/**
 * Renderiza o relatório em LINHAS. Cada check vira 1 linha `<glifo> <label>: <detalhe>`
 * e, quando status≠ok, uma 2ª linha indentada `→ <dica>`. Fecha com um resumo
 * `N ok · N aviso · N falha`. Determinístico (ordem do report); sem I/O.
 */
export function renderDoctor(report: DoctorReport, glyphs: DoctorGlyphs): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${glyphFor(c.status, glyphs)} ${c.label}: ${c.detail}`);
    if (c.status !== 'ok' && c.fix !== undefined) {
      lines.push(`    → ${c.fix}`);
    }
  }
  lines.push('');
  lines.push(`resumo: ${summarize(report.checks)}`);
  return lines;
}
