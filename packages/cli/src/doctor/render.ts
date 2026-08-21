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

/** Glifos de status (✔/⚠/✘) — injetados pelo chamador (tema na TUI, ASCII no shell). */
export interface DoctorGlyphs {
  readonly ok: string;
  readonly warn: string;
  readonly fail: string;
}

/** Glifos ASCII-friendly p/ o `aluy doctor` (saída piped/CI sem fonte garantida). */
export const ASCII_DOCTOR_GLYPHS: DoctorGlyphs = { ok: '[ok]', warn: '[!]', fail: '[x]' };

/**
 * Glifos Unicode p/ a nota na TUI (default de cobertura ampla, EST-0984).
 * F-GLYPH-PESO-2 — SINCRONIZADO com `UNICODE_GLYPHS.ok`/`.err` do tema (✓✗→✔✘,
 * mais peso/preenchimento); `warn` (⚠) fica intacto — fora do escopo pedido.
 */
export const UNICODE_DOCTOR_GLYPHS: DoctorGlyphs = { ok: '✔', warn: '⚠', fail: '✘' };

/**
 * Quebra `texto` em linhas de no máximo `columns`, recuando as continuações em `recuo`.
 * PURO. Sem `columns` (ou largura minúscula) devolve o texto inteiro — degradação
 * graciosa: melhor uma linha longa que um corte no lugar errado.
 */
function quebrarComRecuo(
  texto: string,
  columns: number | undefined,
  recuo: number,
): readonly string[] {
  const largura = columns ?? 0;
  if (largura < 24 || texto.length <= largura) return [texto];
  const pad = ' '.repeat(recuo);
  const out: string[] = [];
  let atual = '';
  for (const palavra of texto.split(' ')) {
    const teto = out.length === 0 ? largura : largura - recuo;
    if (atual === '') {
      atual = palavra;
      continue;
    }
    if (atual.length + 1 + palavra.length <= teto) {
      atual += ` ${palavra}`;
      continue;
    }
    out.push(out.length === 0 ? atual : pad + atual);
    atual = palavra;
  }
  if (atual !== '') out.push(out.length === 0 ? atual : pad + atual);
  return out;
}

function glyphFor(status: DoctorStatus, g: DoctorGlyphs): string {
  return status === 'ok' ? g.ok : status === 'warn' ? g.warn : g.fail;
}

/**
 * Renderiza o relatório em LINHAS. Cada check vira 1 linha `<glifo> <label>: <detalhe>`
 * e, quando status≠ok, uma 2ª linha indentada `→ <dica>`. Fecha com um resumo
 * `N ok · N aviso · N falha`. Determinístico (ordem do report); sem I/O.
 */
export function renderDoctor(
  report: DoctorReport,
  glyphs: DoctorGlyphs,
  columns?: number,
): string[] {
  const lines: string[] = [];
  for (const c of report.checks) {
    // F-DOCTOR-QUEBRA — detalhe longo quebrado AQUI, com recuo, em vez de deixar o terminal
    // quebrar onde calhar. O check dos sidecars é longo o bastante para estourar qualquer
    // largura, e o resultado era uma linha partida em três pedaços desalinhados, com o
    // rótulo cortado ao meio (`sidecars/Maestr`) e um `:` órfão na terceira.
    for (const ln of quebrarComRecuo(
      `${glyphFor(c.status, glyphs)} ${c.label}: ${c.detail}`,
      columns,
      4,
    )) {
      lines.push(ln);
    }
    if (c.status !== 'ok' && c.fix !== undefined) {
      for (const ln of quebrarComRecuo(`    → ${c.fix}`, columns, 6)) lines.push(ln);
    }
  }
  lines.push('');
  lines.push(`resumo: ${summarize(report.checks)}`);
  return lines;
}
