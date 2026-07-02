// task #18 (🔴 CRASH) — testes do GUARD de CSI-u (puro, sem TTY).
//
// O crash: `\x1b[57414u` (kitty functional key) faz o `parseKeypress` do Ink devolver
// `ctrl=true`+`name=undefined`, e o `use-input.js:73` crasha em `input.startsWith(undefined)`.
// O guard FILTRA essas sequências do chunk que o Ink lê via `stdin.read()` — elas NUNCA
// chegam ao parse. Aqui provamos o filtro (puro), o boundary entre chunks, e o interpositor
// de `read()` (que devolve `null` quando o chunk era SÓ CSI-u).

import { describe, expect, it, vi } from 'vitest';
import {
  createCsiUFilter,
  pendingCsiULen,
  installCsiUGuard,
  ESC_FLUSH_MS,
} from '../../src/session/csi-u-guard.js';

const ESC = '\x1b';
const CRASH = `${ESC}[57414u`; // a sequência EXATA que derruba o Ink (task #18).

describe('createCsiUFilter — strippa CSI-u do byte stream antes do Ink', () => {
  it('REMOVE a sequência de crash `\\x1b[57414u` (vira string vazia)', () => {
    expect(createCsiUFilter().feed(CRASH)).toBe('');
  });

  it('REMOVE CSI-u com modificadores e sufixo de evento (`\\x1b[97;5u`, `\\x1b[57414;1:2u`)', () => {
    const f = createCsiUFilter();
    expect(f.feed(`${ESC}[97;5u`)).toBe('');
    expect(f.feed(`${ESC}[57414;1:2u`)).toBe('');
  });

  it('REMOVE o shift+enter CSI-u (`\\x1b[13;2u`) — equivale ao suprimir de hoje (sem newline)', () => {
    expect(createCsiUFilter().feed(`${ESC}[13;2u`)).toBe('');
  });

  it('PRESERVA texto digitado em volta da sequência (`a` + crash + `b` ⇒ `ab`)', () => {
    expect(createCsiUFilter().feed(`a${CRASH}b`)).toBe('ab');
  });

  it('REMOVE várias CSI-u num só chunk, preservando o resto', () => {
    expect(createCsiUFilter().feed(`x${ESC}[57414uy${ESC}[13;2uz`)).toBe('xyz');
  });

  it('NÃO toca CSI comuns (setas `\\x1b[A`, F-keys `\\x1b[19~`, `\\x1b[1;5C`)', () => {
    const f = createCsiUFilter();
    expect(f.feed(`${ESC}[A`)).toBe(`${ESC}[A`);
    expect(f.feed(`${ESC}[19~`)).toBe(`${ESC}[19~`);
    expect(f.feed(`${ESC}[1;5C`)).toBe(`${ESC}[1;5C`);
  });

  it('NÃO toca a digitação normal de um `u` ou de `[`/colchetes', () => {
    const f = createCsiUFilter();
    expect(f.feed('u')).toBe('u');
    expect(f.feed('[hello]')).toBe('[hello]');
    expect(f.feed('a[b')).toBe('a[b');
  });

  it('SEGURA uma CSI-u CORTADA no boundary e a remove quando o `u` chega no próximo chunk', () => {
    const f = createCsiUFilter();
    // `\x1b[5741` num chunk (parcial, sem `u`) ⇒ retido; `4u` no outro ⇒ a seq inteira some.
    expect(f.feed(`${ESC}[5741`)).toBe('');
    expect(f.feed('4u')).toBe('');
  });

  it('boundary: texto + parcial num chunk ⇒ entrega o texto, segura a parcial', () => {
    const f = createCsiUFilter();
    expect(f.feed(`hi${ESC}[13`)).toBe('hi'); // `\x1b[13` retido (parcial)
    expect(f.feed(';2ubye')).toBe('bye'); // completa o `\x1b[13;2u` e o some; `bye` passa
  });

  it('um `\\x1b` solto no fim do chunk é retido (pode iniciar CSI-u); não vira texto', () => {
    const f = createCsiUFilter();
    expect(f.feed(`abc${ESC}`)).toBe('abc');
    // o próximo chunk decide: se for `[57414u` completa a seq (some); se não, reaflora.
    expect(f.feed('[57414u')).toBe('');
  });
});

describe('pendingCsiULen — só segura o que PODE ser uma CSI-u em construção', () => {
  it('segura `\\x1b`, `\\x1b[`, `\\x1b[13`, `\\x1b[13;2` (parciais)', () => {
    expect(pendingCsiULen(ESC)).toBe(1);
    expect(pendingCsiULen(`${ESC}[`)).toBe(2);
    expect(pendingCsiULen(`${ESC}[13`)).toBe(4);
    expect(pendingCsiULen(`${ESC}[13;2`)).toBe(6);
  });

  it('NÃO segura `\\x1bO…` (SS3) nem `\\x1b[A` (CSI com final ≠ params) — não é nossa família', () => {
    expect(pendingCsiULen(`${ESC}OP`)).toBe(0);
    expect(pendingCsiULen(`${ESC}[A`)).toBe(0);
    expect(pendingCsiULen(`${ESC}[1;5C`)).toBe(0);
  });

  it('NÃO segura quando não há `\\x1b` (texto puro)', () => {
    expect(pendingCsiULen('hello')).toBe(0);
    expect(pendingCsiULen('')).toBe(0);
  });

  it('só considera o ÚLTIMO `\\x1b` do buffer (o resto já foi tratado)', () => {
    // `\x1b[A` (completa, mas não-u) seguida de `\x1b[13` (parcial) ⇒ segura só os 4 finais.
    expect(pendingCsiULen(`${ESC}[A${ESC}[13`)).toBe(4);
  });
});

describe('installCsiUGuard — interpõe o filtro no stdin.read()', () => {
  function fakeStdin(chunks: (string | null)[]) {
    let i = 0;
    return {
      read: vi.fn(() => {
        if (i >= chunks.length) return null;
        const c = chunks[i];
        i += 1;
        return c;
      }),
    };
  }

  it('chunk que é SÓ a CSI-u de crash ⇒ read() devolve `` (NÃO null sintético)', () => {
    const stdin = fakeStdin([CRASH]);
    installCsiUGuard(stdin);
    // A seq sumiu ⇒ string VAZIA (o Ink a parseia como `input=''`, no-op). NUNCA `null`
    // sintético — isso seria EOF de stdin e a TUI sairia limpa ao receber a seq.
    expect(stdin.read()).toBe('');
  });

  it('chunk com texto + CSI-u ⇒ read() devolve só o texto (sem a seq)', () => {
    const stdin = fakeStdin([`a${CRASH}b`]);
    installCsiUGuard(stdin);
    expect(stdin.read()).toBe('ab');
  });

  it('chunk de texto normal passa intacto', () => {
    const stdin = fakeStdin(['hello']);
    installCsiUGuard(stdin);
    expect(stdin.read()).toBe('hello');
  });

  it('read() original devolvendo null é repassado (fim da leitura)', () => {
    const stdin = fakeStdin([null]);
    installCsiUGuard(stdin);
    expect(stdin.read()).toBe(null);
  });

  it('é IDEMPOTENTE: instalar 2× não dupla-envolve', () => {
    const stdin = fakeStdin([CRASH]);
    const r1 = installCsiUGuard(stdin);
    const wrapped = stdin.read;
    const r2 = installCsiUGuard(stdin);
    expect(stdin.read).toBe(wrapped); // 2ª instalação não troca o read.
    r2();
    r1();
  });

  it('restore() desfaz o wrap (read volta a entregar a seq crua)', () => {
    const stdin = fakeStdin([CRASH]);
    const original = stdin.read;
    const restore = installCsiUGuard(stdin);
    expect(stdin.read).not.toBe(original);
    restore();
    expect(stdin.read).toBe(original);
  });

  it('stdin sem read ⇒ no-op (não derruba; restore inócuo)', () => {
    const restore = installCsiUGuard({} as { read?: () => unknown });
    expect(() => restore()).not.toThrow();
  });

  it('CSI-u cortada entre dois read()s: 1º devolve ``, 2º entrega o resto', () => {
    // `\x1b[5741` (parcial) e depois `4uZ` ⇒ a seq some, sobra `Z` no 2º read.
    const stdin = fakeStdin([`${ESC}[5741`, '4uZ']);
    installCsiUGuard(stdin);
    expect(stdin.read()).toBe(''); // parcial retida ⇒ nada a entregar ainda (string vazia).
    expect(stdin.read()).toBe('Z'); // completa a seq (some) e entrega o `Z`.
  });

  it('read() original devolvendo null SEGUE sendo null (EOF real é repassado)', () => {
    const stdin = fakeStdin([CRASH, null]);
    installCsiUGuard(stdin);
    expect(stdin.read()).toBe(''); // a seq vira vazio.
    expect(stdin.read()).toBe(null); // EOF REAL do stream ⇒ null repassado (laço encerra).
  });
});

describe('F159 — flush do Esc retido (Esc humano NÃO pode virar tecla morta)', () => {
  function fakeStdin(chunks: (string | null)[]) {
    let i = 0;
    return {
      read: vi.fn(() => {
        if (i >= chunks.length) return null;
        const c = chunks[i];
        i += 1;
        return c;
      }),
      emit: vi.fn(),
    };
  }

  it('Esc SOLITÁRIO: retido no read(), LIBERADO CRU após ESC_FLUSH_MS (+ acorda o laço)', () => {
    vi.useFakeTimers();
    try {
      const stdin = fakeStdin([ESC]);
      installCsiUGuard(stdin);
      // O chunk do Esc chega: retido (era potencial início de CSI-u) ⇒ string vazia.
      expect(stdin.read()).toBe('');
      // A continuação NÃO veio no prazo ⇒ era Esc humano: flush + 'readable' p/ o Ink reler.
      vi.advanceTimersByTime(ESC_FLUSH_MS + 5);
      expect(stdin.emit).toHaveBeenCalledWith('readable');
      // A releitura entrega o `\x1b` CRU (sem re-filtrar) ⇒ o Ink vê `key.escape`.
      expect(stdin.read()).toBe(ESC);
      // E nada sobra depois.
      expect(stdin.read()).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CSI-u REAL cortada no boundary segue filtrada quando o resto chega ANTES do prazo', () => {
    vi.useFakeTimers();
    try {
      const stdin = fakeStdin([`${ESC}[5741`, '4uZ']);
      installCsiUGuard(stdin);
      expect(stdin.read()).toBe(''); // parcial retida.
      vi.advanceTimersByTime(ESC_FLUSH_MS - 20); // resto chega DENTRO do prazo…
      expect(stdin.read()).toBe('Z'); // …a seq completa some; só o texto passa.
      vi.advanceTimersByTime(ESC_FLUSH_MS * 3); // e o prazo antigo NÃO ressuscita nada.
      expect(stdin.read()).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc + tecla seguinte no MESMO prazo: o flush não dispara em dobro (re-arma por chunk)', () => {
    vi.useFakeTimers();
    try {
      const stdin = fakeStdin([ESC, `${ESC}`]);
      installCsiUGuard(stdin);
      expect(stdin.read()).toBe(''); // 1º Esc retido.
      // 2º Esc chega antes do prazo: o 1º é liberado pelo feed (não é CSI-u), o 2º fica retido.
      expect(stdin.read()).toBe(ESC);
      vi.advanceTimersByTime(ESC_FLUSH_MS + 5); // agora o flush libera o 2º.
      expect(stdin.read()).toBe(ESC);
      expect(stdin.read()).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restore() cancela o flush pendente (sem timer órfão pós-unmount)', () => {
    vi.useFakeTimers();
    try {
      const stdin = fakeStdin([ESC]);
      const restore = installCsiUGuard(stdin);
      expect(stdin.read()).toBe('');
      restore();
      vi.advanceTimersByTime(ESC_FLUSH_MS * 2);
      expect(stdin.emit).not.toHaveBeenCalled(); // nada acorda o laço após o restore.
    } finally {
      vi.useRealTimers();
    }
  });

  it('mock SEM emit não derruba o flush (best-effort)', () => {
    vi.useFakeTimers();
    try {
      let first = true;
      const stdin = {
        read: vi.fn(() => {
          if (first) {
            first = false;
            return ESC;
          }
          return null;
        }),
      };
      installCsiUGuard(stdin);
      expect(stdin.read()).toBe('');
      expect(() => vi.advanceTimersByTime(ESC_FLUSH_MS + 5)).not.toThrow();
      expect(stdin.read()).toBe(ESC); // liberado mesmo sem o wake (sai na próxima leitura).
    } finally {
      vi.useRealTimers();
    }
  });
});
