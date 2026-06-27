// EST-PASTE-COLLAPSE — testes DENSOS do módulo PURO `paste-collapse`: gating (threshold no
// limite), contagem de linhas (trailing newline), montagem do chip (plural PT-BR), apagar
// ATÔMICO (borda/meio), expansão FIEL multi-chip (no lugar certo), e DEGRADAÇÃO (bloco
// pequeno NÃO colapsa). Tudo sem React/TTY — determinístico.

import { describe, expect, it } from 'vitest';
import {
  countLines,
  shouldCollapse,
  chipLabel,
  createPasteRegistry,
  makePasteChip,
  findChipSpans,
  deleteChipAt,
  expandPastes,
  DEFAULT_COLLAPSE_MIN_LINES,
  DEFAULT_COLLAPSE_MIN_CHARS,
} from '../../src/session/paste-collapse.js';
import type { EditState } from '../../src/session/composer-edit.js';

/** Helper: gera um bloco de `n` linhas (`linha 1\nlinha 2\n…linha n`, SEM trailing newline). */
function block(n: number): string {
  return Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n');
}

describe('countLines', () => {
  it('string vazia = 0 linhas', () => {
    expect(countLines('')).toBe(0);
  });
  it('uma linha sem newline = 1', () => {
    expect(countLines('só uma linha')).toBe(1);
  });
  it('duas linhas = 2', () => {
    expect(countLines('a\nb')).toBe(2);
  });
  it('trailing newline NÃO conta linha vazia fantasma', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\n')).toBe(1);
  });
  it('linhas internas vazias contam', () => {
    expect(countLines('a\n\nb')).toBe(3);
  });
  it('só um newline = 1 linha (uma quebra terminal)', () => {
    expect(countLines('\n')).toBe(1);
  });
});

describe('shouldCollapse — threshold no LIMITE', () => {
  it(`exatamente ${DEFAULT_COLLAPSE_MIN_LINES} linhas COLAPSA (≥)`, () => {
    expect(shouldCollapse(block(DEFAULT_COLLAPSE_MIN_LINES))).toBe(true);
  });
  it(`${DEFAULT_COLLAPSE_MIN_LINES - 1} linhas NÃO colapsa`, () => {
    expect(shouldCollapse(block(DEFAULT_COLLAPSE_MIN_LINES - 1))).toBe(false);
  });
  it('bloco PEQUENO (1 linha curta) NÃO colapsa — segue inline', () => {
    expect(shouldCollapse('oi')).toBe(false);
  });
  it('linha ÚNICA enorme (> minChars) colapsa mesmo com 1 linha', () => {
    const huge = 'x'.repeat(DEFAULT_COLLAPSE_MIN_CHARS + 1);
    expect(countLines(huge)).toBe(1);
    expect(shouldCollapse(huge)).toBe(true);
  });
  it(`exatamente ${DEFAULT_COLLAPSE_MIN_CHARS} chars NÃO colapsa (> estrito)`, () => {
    expect(shouldCollapse('x'.repeat(DEFAULT_COLLAPSE_MIN_CHARS))).toBe(false);
  });
  it('vazio NÃO colapsa', () => {
    expect(shouldCollapse('')).toBe(false);
  });
  it('opções custom mudam o limiar', () => {
    expect(shouldCollapse(block(3), { minLines: 3 })).toBe(true);
    expect(shouldCollapse(block(3), { minLines: 4 })).toBe(false);
    expect(shouldCollapse('abcdef', { minChars: 5 })).toBe(true);
  });
});

describe('chipLabel — plural PT-BR', () => {
  it('1 linha = singular', () => {
    expect(chipLabel(1, 1)).toBe('[texto colado #1, +1 linha]');
  });
  it('N linhas = plural', () => {
    expect(chipLabel(2, 123)).toBe('[texto colado #2, +123 linhas]');
  });
});

describe('makePasteChip — insere o chip no cursor e registra o conteúdo', () => {
  it('insere o label no cursor e avança o cursor pro fim do chip', () => {
    const reg = createPasteRegistry();
    const content = block(10);
    const st: EditState = { text: 'antes depois', cursor: 6 }; // entre "antes " e "depois"
    const next = makePasteChip(st, content, reg);
    const label = chipLabel(1, 10);
    expect(next.text).toBe(`antes ${label}depois`);
    expect(next.cursor).toBe(6 + label.length);
    expect(reg.get(1)).toBe(content);
  });
  it('numeração incremental #1, #2 por sessão', () => {
    const reg = createPasteRegistry();
    let st: EditState = { text: '', cursor: 0 };
    st = makePasteChip(st, block(6), reg);
    st = makePasteChip(st, block(7), reg);
    expect(st.text).toBe(`${chipLabel(1, 6)}${chipLabel(2, 7)}`);
    expect(reg.get(1)).toBe(block(6));
    expect(reg.get(2)).toBe(block(7));
  });
  it('reset() reinicia a numeração em #1 e esquece tudo', () => {
    const reg = createPasteRegistry();
    makePasteChip({ text: '', cursor: 0 }, block(6), reg);
    reg.reset();
    expect(reg.get(1)).toBeUndefined();
    const st = makePasteChip({ text: '', cursor: 0 }, block(8), reg);
    expect(st.text).toBe(chipLabel(1, 8)); // numeração voltou a #1
  });
});

describe('findChipSpans — só chips REGISTRADOS (anti-colisão)', () => {
  it('ignora token que CASA o padrão mas com id não registrado (digitado à mão)', () => {
    const reg = createPasteRegistry();
    // usuário digitou literalmente um token parecido — id #9 nunca foi registrado
    const buffer = 'oi [texto colado #9, +5 linhas] tchau';
    expect(findChipSpans(buffer, reg)).toEqual([]);
  });
  it('acha o chip registrado e ignora o digitado no mesmo buffer', () => {
    const reg = createPasteRegistry();
    const real = makePasteChip({ text: '', cursor: 0 }, block(6), reg).text; // #1
    const buffer = `${real} e [texto colado #9, +5 linhas]`;
    const spans = findChipSpans(buffer, reg);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.id).toBe(1);
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(real.length);
  });
});

describe('deleteChipAt — APAGAR ATÔMICO', () => {
  it('backspace com cursor logo DEPOIS do chip remove o chip INTEIRO', () => {
    const reg = createPasteRegistry();
    const label = chipLabel(1, 6);
    reg.add(block(6), 6); // registra #1 (já consome o id; label bate)
    const st: EditState = { text: `pre ${label} pos`, cursor: 4 + label.length };
    const r = deleteChipAt(st, reg, 'backward');
    expect(r.handled).toBe(true);
    expect(r.state.text).toBe('pre  pos');
    expect(r.state.cursor).toBe(4); // colapsa pro início do chip
    expect(r.removedId).toBe(1);
  });
  it('delete-forward com cursor logo ANTES do chip remove o chip INTEIRO', () => {
    const reg = createPasteRegistry();
    reg.add(block(6), 6);
    const label = chipLabel(1, 6);
    const st: EditState = { text: `pre ${label} pos`, cursor: 4 };
    const r = deleteChipAt(st, reg, 'forward');
    expect(r.handled).toBe(true);
    expect(r.state.text).toBe('pre  pos');
    expect(r.state.cursor).toBe(4);
  });
  it('backspace NÃO na borda (cursor no meio do texto normal) => handled=false', () => {
    const reg = createPasteRegistry();
    reg.add(block(6), 6);
    const label = chipLabel(1, 6);
    const st: EditState = { text: `pre ${label} pos`, cursor: 2 }; // dentro de "pre"
    const r = deleteChipAt(st, reg, 'backward');
    expect(r.handled).toBe(false);
    expect(r.state).toBe(st);
  });
  it('cursor DENTRO do chip => remove o chip inteiro (defensivo)', () => {
    const reg = createPasteRegistry();
    reg.add(block(6), 6);
    const label = chipLabel(1, 6);
    const st: EditState = { text: label, cursor: 3 };
    const r = deleteChipAt(st, reg, 'backward');
    expect(r.handled).toBe(true);
    expect(r.state.text).toBe('');
  });
  it('apaga o chip do MEIO entre dois outros, deixando os vizinhos', () => {
    const reg = createPasteRegistry();
    const a = chipLabel(1, 6);
    const b = chipLabel(2, 7);
    const c = chipLabel(3, 8);
    reg.add(block(6), 6); // #1
    reg.add(block(7), 7); // #2
    reg.add(block(8), 8); // #3
    const text = `${a}${b}${c}`;
    const st: EditState = { text, cursor: a.length + b.length }; // logo depois de #2
    const r = deleteChipAt(st, reg, 'backward');
    expect(r.handled).toBe(true);
    expect(r.state.text).toBe(`${a}${c}`);
    expect(r.removedId).toBe(2);
  });
});

describe('expandPastes — EXPANSÃO fiel no submit', () => {
  it('submit com 0 chips devolve o buffer inalterado', () => {
    const reg = createPasteRegistry();
    expect(expandPastes('só texto normal', reg)).toBe('só texto normal');
  });
  it('submit com 1 chip expande FIEL byte-a-byte no lugar', () => {
    const reg = createPasteRegistry();
    const content = 'function f() {\n  return 42;\n}\n\n// fim';
    const st = makePasteChip({ text: 'rode isto: ', cursor: 11 }, content, reg);
    const out = expandPastes(st.text, reg);
    expect(out).toBe(`rode isto: ${content}`);
  });
  it('submit com N chips: cada um expande NO SEU lugar', () => {
    const reg = createPasteRegistry();
    const c1 = block(6);
    const c2 = 'x'.repeat(DEFAULT_COLLAPSE_MIN_CHARS + 10);
    let st: EditState = { text: '', cursor: 0 };
    st = makePasteChip(st, c1, reg); // #1
    st = { text: `${st.text} entre `, cursor: st.text.length + 7 };
    st = makePasteChip(st, c2, reg); // #2
    st = { text: `${st.text} fim`, cursor: st.text.length + 4 };
    const out = expandPastes(st.text, reg);
    expect(out).toBe(`${c1} entre ${c2} fim`);
  });
  it('token digitado à mão (id não registrado) NÃO expande', () => {
    const reg = createPasteRegistry();
    const buffer = 'veja [texto colado #9, +5 linhas]';
    expect(expandPastes(buffer, reg)).toBe(buffer);
  });
  it('expande o chip mesmo se o conteúdo CONTÉM outro padrão de chip (sem re-expandir)', () => {
    const reg = createPasteRegistry();
    // conteúdo colado que por acaso contém um texto-chip-like literal
    const content = 'isto tem [texto colado #1, +9 linhas] dentro';
    const st = makePasteChip({ text: '', cursor: 0 }, content, reg); // vira #1
    const out = expandPastes(st.text, reg);
    // o chip #1 do BUFFER vira o conteúdo; o texto-chip-like DENTRO do conteúdo fica literal
    expect(out).toBe(content);
  });
});

describe('integração de ciclo — colar 2× seguidos, apagar do meio, submeter', () => {
  it('cola, cola de novo, apaga o 1º (atômico), submete o 2º expandido', () => {
    const reg = createPasteRegistry();
    const c1 = block(6);
    const c2 = block(20);
    let st: EditState = { text: '', cursor: 0 };
    // cola #1 e #2 seguidos
    st = makePasteChip(st, c1, reg);
    st = makePasteChip(st, c2, reg);
    expect(st.text).toBe(`${chipLabel(1, 6)}${chipLabel(2, 20)}`);
    // cursor no FIM do #1 (= início do #2) e apaga backward => some o #1
    const d = deleteChipAt({ text: st.text, cursor: chipLabel(1, 6).length }, reg, 'backward');
    expect(d.handled).toBe(true);
    if (d.removedId !== undefined) reg.remove(d.removedId);
    expect(d.state.text).toBe(chipLabel(2, 20));
    // submete: só o #2 expande
    expect(expandPastes(d.state.text, reg)).toBe(c2);
    expect(reg.get(1)).toBeUndefined(); // #1 foi esquecido
  });
});
