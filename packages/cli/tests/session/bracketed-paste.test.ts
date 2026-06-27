// EST-0948 — BRACKETED PASTE MODE: testes da MÁQUINA pura (sem TTY/React).
//
// O bug do dogfood: colar texto MULTI-LINHA no composer submetia na 1ª `\n` e descartava
// o resto. Com o `?2004` ligado, o terminal envelopa o colado em `\x1b[200~`…`\x1b[201~`;
// a máquina abaixo detecta os marcadores no canal CRU e devolve o conteúdo LITERAL (com
// `\n` preservado) p/ inserir no composer — NUNCA submete. Aqui cobrimos:
//  · paste multi-linha (1 chunk) ⇒ 1 evento `paste` com as linhas literais;
//  · paste PARTIDO em 2 chunks (marcador cruzando o boundary) ⇒ bufferiza e monta certo;
//  · normalização `\r\n`/`\r`→`\n` + remoção de control chars perigosos (preserva `\n`/`\t`);
//  · passthrough fora do paste (digitação normal segue intacta) — não-regressão EST-0948;
//  · o GATE do lado do `useInput` (suprime os bytes mangled do paste).

import { describe, expect, it } from 'vitest';
import {
  createBracketedPasteMachine,
  normalizePaste,
  gateInputPaste,
  enableBracketedPaste,
  PASTE_START,
  PASTE_END,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
  type PasteEvent,
  type InputPasteGate,
} from '../../src/session/bracketed-paste.js';

/** Roda a máquina sobre uma sequência de chunks e devolve {events, inPaste no fim}. */
function feedAll(chunks: readonly string[]): { events: PasteEvent[]; inPaste: boolean } {
  const m = createBracketedPasteMachine();
  const events: PasteEvent[] = [];
  for (const c of chunks) events.push(...m.feed(c));
  return { events, inPaste: m.isInPaste() };
}

/** Só os textos dos eventos `paste` (na ordem). */
function pastes(events: readonly PasteEvent[]): string[] {
  return events
    .filter((e): e is { kind: 'paste'; text: string } => e.kind === 'paste')
    .map((e) => e.text);
}

/** Só os dados dos eventos `passthrough` (na ordem). */
function passthroughs(events: readonly PasteEvent[]): string[] {
  return events
    .filter((e): e is { kind: 'passthrough'; data: string } => e.kind === 'passthrough')
    .map((e) => e.data);
}

describe('bracketed-paste — bytes de modo', () => {
  it('os marcadores e bytes de modo são os esperados (DECSET 2004)', () => {
    expect(ENABLE_BRACKETED_PASTE).toBe('\x1b[?2004h');
    expect(DISABLE_BRACKETED_PASTE).toBe('\x1b[?2004l');
    expect(PASTE_START).toBe('\x1b[200~');
    expect(PASTE_END).toBe('\x1b[201~');
  });
});

describe('bracketed-paste — LIGAR/DESLIGAR o modo (`?2004h`/`?2004l`)', () => {
  it('`enableBracketedPaste` emite `?2004h` na construção (START da TUI)', () => {
    const writes: string[] = [];
    const stream = { write: (c: string) => (writes.push(c), true) };
    enableBracketedPaste(stream);
    expect(writes).toEqual([ENABLE_BRACKETED_PASTE]);
  });

  it('`disable()` emite `?2004l` (EXIT) e é IDEMPOTENTE (sinal + exit)', () => {
    const writes: string[] = [];
    const stream = { write: (c: string) => (writes.push(c), true) };
    const ctrl = enableBracketedPaste(stream);
    ctrl.disable();
    ctrl.disable(); // 2ª chamada inócua (sinal + finally)
    expect(writes).toEqual([ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE]);
  });

  it('stream que LANÇA no write não derruba (best-effort no boot/exit)', () => {
    const stream = {
      write: () => {
        throw new Error('stream fechado');
      },
    };
    // nem o enable nem o disable propagam a exceção.
    expect(() => enableBracketedPaste(stream).disable()).not.toThrow();
  });
});

describe('bracketed-paste — normalização do conteúdo colado', () => {
  it('`\\r\\n` e `\\r` solto viram `\\n` (newline LITERAL, multi-linha)', () => {
    expect(normalizePaste('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('preserva `\\n` e `\\t`; remove control chars C0 perigosos e o DEL', () => {
    // \x07 (BEL) e \x1b (ESC) somem; \t e \n ficam; \x7f (DEL) some (não é backspace num paste).
    expect(normalizePaste('a\x07b\tc\nd\x7fe\x1bf')).toBe('ab\tc\ndef');
  });

  it('texto comum passa intacto', () => {
    expect(normalizePaste('cole isto aqui')).toBe('cole isto aqui');
  });
});

describe('bracketed-paste — MÁQUINA: paste multi-linha (1 chunk)', () => {
  it('`\\x1b[200~linha1\\nlinha2\\nlinha3\\x1b[201~` ⇒ 1 paste com as 3 linhas (não submete)', () => {
    const { events, inPaste } = feedAll([`${PASTE_START}linha1\nlinha2\nlinha3${PASTE_END}`]);
    expect(pastes(events)).toEqual(['linha1\nlinha2\nlinha3']);
    expect(inPaste).toBe(false);
    // NÃO há submit nem `\r` no conteúdo — é texto LITERAL multi-linha.
    expect(events.every((e) => e.kind === 'paste')).toBe(true);
  });

  it('paste com CRLF vira multi-linha com `\\n` (não 1ª-linha-submete)', () => {
    const { events } = feedAll([`${PASTE_START}a\r\nb\r\nc${PASTE_END}`]);
    expect(pastes(events)).toEqual(['a\nb\nc']);
  });
});

describe('bracketed-paste — MÁQUINA: paste PARTIDO em chunks (marcador cruzando)', () => {
  it('conteúdo partido no MEIO ⇒ bufferiza e monta a linha completa', () => {
    const { events, inPaste } = feedAll([`${PASTE_START}linha1\nlin`, `ha2\nlinha3${PASTE_END}`]);
    expect(pastes(events)).toEqual(['linha1\nlinha2\nlinha3']);
    expect(inPaste).toBe(false);
  });

  it('marcador de INÍCIO cortado no boundary (`\\x1b[20` | `0~…`) ⇒ monta certo', () => {
    const { events } = feedAll(['antes\x1b[20', `0~colado\nmais${PASTE_END}`]);
    expect(passthroughs(events)).toEqual(['antes']); // o que veio ANTES do marcador
    expect(pastes(events)).toEqual(['colado\nmais']);
  });

  it('marcador de FIM cortado no boundary (`…\\x1b[20` | `1~depois`) ⇒ fecha e segue', () => {
    const { events } = feedAll([`${PASTE_START}colado\x1b[20`, '1~depois\r']);
    expect(pastes(events)).toEqual(['colado']);
    // o que veio DEPOIS do `201~` é passthrough (digitação normal — inclui o `\r`).
    expect(passthroughs(events)).toEqual(['depois\r']);
  });

  it('paste fragmentado em VÁRIOS chunks ⇒ um único paste no fim', () => {
    const { events, inPaste } = feedAll([PASTE_START, 'um\n', 'dois\n', 'tres', PASTE_END]);
    expect(pastes(events)).toEqual(['um\ndois\ntres']);
    expect(inPaste).toBe(false);
  });
});

describe('bracketed-paste — MÁQUINA: passthrough (não-regressão EST-0948)', () => {
  it('Enter em lote SEM envelope (digitação real xrdp/SSH) passa como passthrough', () => {
    // sem `\x1b[200~` ⇒ a máquina NÃO toca; o `\r` segue p/ o detector de lote da App.
    const { events } = feedAll(['liste arquivos\r']);
    expect(pastes(events)).toEqual([]);
    expect(passthroughs(events)).toEqual(['liste arquivos\r']);
  });

  it('texto + paste + texto no mesmo fluxo ⇒ ordem preservada', () => {
    const { events } = feedAll([`oi ${PASTE_START}bloco\ncolado${PASTE_END} tchau\r`]);
    expect(passthroughs(events)).toEqual(['oi ', ' tchau\r']);
    expect(pastes(events)).toEqual(['bloco\ncolado']);
  });
});

describe('bracketed-paste — GATE do `useInput` (suprime bytes mangled do paste)', () => {
  it('paste de 1 chunk (mangled `[200~…\\x1b[201~`) ⇒ suprime e NÃO fica aberto', () => {
    const gate: InputPasteGate = { open: false };
    // o Ink corta o 1º `\x1b` ⇒ char começa com `[200~`; o `201~` interno preserva o ESC.
    expect(gateInputPaste(gate, '[200~linha1\nlinha2\x1b[201~')).toBe(true);
    expect(gate.open).toBe(false); // fechou no mesmo char.
  });

  it('paste partido: start abre (suprime), end fecha (suprime)', () => {
    const gate: InputPasteGate = { open: false };
    expect(gateInputPaste(gate, '[200~linha1\nlin')).toBe(true);
    expect(gate.open).toBe(true); // ABERTO até ver o fim.
    // chunk do meio (sem marcador) ⇒ ainda suprimido porque o gate está aberto.
    expect(gateInputPaste(gate, 'conteudo do meio')).toBe(true);
    expect(gate.open).toBe(true);
    // chunk do fim (com `\x1b[201~`) ⇒ suprime e FECHA.
    expect(gateInputPaste(gate, 'ha2\x1b[201~')).toBe(true);
    expect(gate.open).toBe(false);
  });

  it('digitação normal (sem marcador) NÃO é suprimida — não-regressão', () => {
    const gate: InputPasteGate = { open: false };
    expect(gateInputPaste(gate, 'liste arquivos\r')).toBe(false);
    expect(gateInputPaste(gate, 'a')).toBe(false);
    expect(gate.open).toBe(false);
  });

  it('gate ABERTO + chunk do fim MANGLED no INÍCIO (`[201~…`, Ink cortou o ESC) ⇒ fecha', () => {
    // Quando o chunk do FIM começa com o marcador, o Ink corta o 1º `\x1b` ⇒ o `useInput`
    // vê `[201~` (MANGLED_END no começo, sem ESC). O gate deve FECHAR mesmo assim.
    const gate: InputPasteGate = { open: true };
    expect(gateInputPaste(gate, '[201~')).toBe(true);
    expect(gate.open).toBe(false);
  });

  it('start E fim MANGLED no MESMO char (Ink corta SÓ o 1º ESC) ⇒ abre e já fecha', () => {
    // Paste de 1 chunk em que o `201~` também chega SEM ESC (mangled) no mesmo char:
    // abre no `[200~` e fecha no `[201~` mangled — suprime e NÃO fica aberto.
    const gate: InputPasteGate = { open: false };
    expect(gateInputPaste(gate, '[200~x[201~')).toBe(true);
    expect(gate.open).toBe(false);
  });
});

describe('bracketed-paste — bordas da MÁQUINA (chunk vazio, paste vazio, marcadores adjacentes)', () => {
  it('chunk vazio NÃO emite nada e NÃO altera o estado', () => {
    const m = createBracketedPasteMachine();
    expect(m.feed('')).toEqual([]);
    expect(m.isInPaste()).toBe(false);
  });

  it('paste VAZIO (`\\x1b[200~\\x1b[201~`) ⇒ 1 evento paste com texto vazio', () => {
    const { events, inPaste } = feedAll([`${PASTE_START}${PASTE_END}`]);
    expect(pastes(events)).toEqual(['']);
    expect(inPaste).toBe(false);
  });

  it('isInPaste é TRUE entre o `200~` e o `201~` (chunk parcial) e volta a FALSE ao fechar', () => {
    const m = createBracketedPasteMachine();
    m.feed(`${PASTE_START}meio do paste`);
    expect(m.isInPaste()).toBe(true); // abriu, fim ainda não chegou.
    m.feed(`resto${PASTE_END}`);
    expect(m.isInPaste()).toBe(false); // fechou.
  });

  it('DOIS pastes no MESMO chunk ⇒ dois eventos paste na ordem, sem mistura', () => {
    const { events } = feedAll([`${PASTE_START}um${PASTE_END}${PASTE_START}dois${PASTE_END}`]);
    expect(pastes(events)).toEqual(['um', 'dois']);
  });

  it('cauda do chunk é PREFIXO ambíguo do `200~` (`…\\x1b`) ⇒ segura e remonta no próximo', () => {
    // `\x1b` solto no fim do chunk é prefixo de `\x1b[200~`: a máquina o SEGURA (pending)
    // em vez de emitir como passthrough; o próximo chunk completa o marcador.
    const { events, inPaste } = feedAll(['texto\x1b', '[200~colado\x1b[201~']);
    expect(passthroughs(events)).toEqual(['texto']);
    expect(pastes(events)).toEqual(['colado']);
    expect(inPaste).toBe(false);
  });

  it('`\\x1b` solto que NÃO vira marcador volta como passthrough (não some)', () => {
    // se o prefixo segurado não completa um `200~`, o byte retido reaparece no fluxo —
    // nunca é engolido (degradação: terminal sem 2004 manda ESC cru).
    const { events } = feedAll(['a\x1b', 'X resto']);
    expect(passthroughs(events).join('')).toBe('a\x1bX resto');
  });
});
