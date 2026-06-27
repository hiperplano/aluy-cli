// EST-0965 · ADR-0076 §5 — A PROVA DE FLICKER do cockpit, no NÍVEL DE BYTES, com o Ink
// REAL escrevendo no envelope REAL (`wrapStdoutWithSync` + `setCockpit`). É o mesmo
// critério do #95/#118 no inline (onde re-renderizar dá `\x1b[2K`=0), traduzido p/ o
// alt-screen — mas DETERMINÍSTICO (sem PTY/boot/teclado): provoca o re-render em processo
// e conta os `\x1b[2J` que SAEM no fio do stdout.
//
// POR QUE ASSIM (e não dirigindo o binário sob PTY): o flicker do cockpit nasce no RENDERER
// do Ink, não no boot nem na entrada de teclado. Quando a árvore ENCHE `rows` (o cockpit,
// invariante §3), o Ink TOMA o caminho `outputHeight>=rows` do `onRender` e escreve
// `ansiEscapes.clearTerminal` (`\x1b[2J\x1b[3J\x1b[H`) + frame a CADA render — inclusive nos
// RE-RENDERS. O `\x1b[2J` BRANQUEIA a tela inteira ANTES de pintar ⇒ flicker no terminal
// sem `?2026` (o xterm do Tiago). Este teste reproduz EXATAMENTE esse caminho: renderiza uma
// árvore que enche `rows` através do envelope com `setCockpit(true)`, re-renderiza, e prova
// que os bytes que chegam ao stdout NÃO contêm `\x1b[2J` (o transform `cockpitOverwriteInPlace`
// trocou o `clearTerminal` por `\x1b[H`+overwrite). Robusto em CI (não depende de PTY, de o
// boot assentar, nem de o composer aceitar teclado — as fragilidades que tornam um teste de
// boot-sob-PTY flaky no runner). A PINTA+RESTAURA no alt-screen REAL fica no
// `cockpit-paint-pty.test.ts` (#145, já verde em CI).

// PRIMEIRO import (side-effect): scrub `CI`/`CI_*` ANTES do `ink` ser avaliado — senão o
// Ink (via `is-in-ci`) DESLIGA o render no runner (`CI=true`) e o frame nunca sai, deixando
// a prova de bytes vazia/enganosa. Ver `_scrub-ci-env.ts` (classe do #149, in-process).
import './_scrub-ci-env.js';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, Box, Text } from 'ink';
import { wrapStdoutWithSync } from '../../src/session/synchronized-output.js';

const ESC = '\x1b[';
const ERASE_SCREEN = `${ESC}2J`; // o branqueamento de tela = a fonte do flicker.
const ERASE_SCROLLBACK = `${ESC}3J`;
const CURSOR_HOME = `${ESC}H`;
const BEGIN_SYNC = `${ESC}?2026h`;

/** Conta ocorrências (sem sobreposição) de `needle` em `s`. */
function count(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

/**
 * Um stub de WriteStream que CAPTURA cada `write` e fixa `rows`/`columns` — o que faz o Ink
 * decidir o caminho de render. `rows` PEQUENO + uma árvore de `rows` linhas ⇒ `outputHeight>=
 * rows` ⇒ o Ink escreve `clearTerminal`+frame (o caminho do cockpit). É o stub que o envelope
 * embrulha; medimos os bytes que o envelope MANDA pra cá.
 */
function makeStub(rows: number, columns: number): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    },
    isTTY: true,
    columns,
    rows,
    on() {
      return this;
    },
    off() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
    emit() {
      return false;
    },
    end() {},
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

/** Uma árvore que ENCHE exatamente `rows` linhas (força o ramo `outputHeight>=rows` do Ink). */
function Filler({ rows, columns, label }: { rows: number; columns: number; label: string }) {
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows }, (_, i) => (
        <Text key={i}>{`linha ${i} região ${label}`}</Text>
      ))}
    </Box>
  );
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('EST-0965 · ADR-0076 §5 — o cockpit NÃO cintila ao re-renderizar (Ink real + envelope, prova de bytes)', () => {
  it('SANIDADE: sem o transform, o Ink emite clearTerminal (\\x1b[2J) a cada render — a fonte do flicker', async () => {
    const rows = 6;
    const cols = 80;
    const { stream, writes } = makeStub(rows, cols);
    // envelope com setCockpit ainda OFF e overwrite global OFF ⇒ os bytes do Ink passam CRUS.
    const sync = wrapStdoutWithSync(stream, { sync: false, overwrite: false });
    const inst = render(<Filler rows={rows} columns={cols} label="A" />, {
      stdout: sync.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    const before = writes.length;
    inst.rerender(<Filler rows={rows} columns={cols} label="B" />); // RE-RENDER.
    await tick();
    inst.unmount();
    const rerender = writes.slice(before).join('');
    // a ENTRADA crua TEM o branqueamento de tela (era o flicker) — prova que o caminho é o do cockpit.
    expect(count(rerender, ERASE_SCREEN)).toBeGreaterThanOrEqual(1);
  });

  it('PROVA DE BYTES: cockpit ATIVO ⇒ re-render emite ZERO \\x1b[2J (flicker morto), só home+overwrite', async () => {
    const rows = 6;
    const cols = 80;
    const { stream, writes } = makeStub(rows, cols);
    // o envelope REAL do cockpit: overwrite ON + sync ON + setCockpit(true) (como no wiring).
    const sync = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    sync.setCockpit(true);
    const inst = render(<Filler rows={rows} columns={cols} label="A" />, {
      stdout: sync.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    const before = writes.length;
    inst.rerender(<Filler rows={rows} columns={cols} label="B" />); // RE-RENDER (provoca o frame novo).
    await tick();
    inst.unmount();

    const rerender = writes.slice(before).join('');
    // SANIDADE: houve re-render (saíram bytes) — senão o teste seria vacuamente verde.
    expect(rerender.length, 'o re-render não produziu bytes').toBeGreaterThan(0);

    // O CRITÉRIO-MESTRE (igual ao `\x1b[2K`=0 do inline pós-#95): ZERO branqueamento de tela.
    expect(
      count(rerender, ERASE_SCREEN),
      `cockpit cintila: \\x1b[2J (branqueamento de tela) no re-render — flicker do #144`,
    ).toBe(0);
    expect(count(rerender, ERASE_SCROLLBACK)).toBe(0);
    // o frame foi sobrescrito-no-lugar: posiciona por CUP (`\x1b[<n>;<m>H`) em vez do clear de
    // tela. (FIX #151: o re-render diferencial reescreve as linhas mudadas por CUP e reposiciona
    // o cursor no FIM do frame — não há mais o `\x1b[H` cru de home, que só abre o full-paint.)
    const cupRe = new RegExp(`${ESC.replace('[', '\\[')}\\d+;\\d+H`, 'g');
    expect(
      (rerender.match(cupRe) ?? []).length,
      'sem CUP ⇒ não sobrescreveu no lugar',
    ).toBeGreaterThan(0);
    // O re-render NÃO ABRE com o home cru (`\x1b[H`) — esse é a assinatura do full-paint (1º
    // frame), não do diff. (Mantém o contraste com o caminho de entrada/full-paint.)
    expect(rerender.startsWith(CURSOR_HOME) || rerender.startsWith(BEGIN_SYNC + CURSOR_HOME)).toBe(
      false,
    );
    // o `?2026` (sync atômico) PERMANECE — ajuda onde o terminal honra; o overwrite cobre onde não.
    expect(rerender.includes(BEGIN_SYNC)).toBe(true);
  });

  it('contraste: SEM setCockpit (inline) também MATA o \\x1b[2J — mas por outro MECANISMO (EST-1015)', async () => {
    // EST-1015 (fix flicker de saída GRANDE no inline): quando a árvore enche `rows`, o Ink
    // emite `clearTerminal` (\x1b[2J...) TAMBÉM no inline. Antes o transform do inline NÃO
    // casava esse padrão ⇒ o `\x1b[2J` passava cru ⇒ flicker em saída grande. Agora
    // `overwriteInPlace` trata o clearTerminal IGUAL ao cockpit (home + sobrescreve + \x1b[J).
    // O CONTRASTE com o cockpit deixa de ser "inline tem \x1b[2J" (ambos têm ZERO agora) e passa
    // a ser o MECANISMO: o inline ABRE com home cru (\x1b[H, full-overwrite); o cockpit usa o
    // DIFF por-linha (CUP \x1b[<r>;<c>H) e NÃO abre com home cru (ver o teste do diff acima).
    const rows = 6;
    const cols = 80;
    const { stream, writes } = makeStub(rows, cols);
    const sync = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    sync.setCockpit(false); // inline default.
    const inst = render(<Filler rows={rows} columns={cols} label="A" />, {
      stdout: sync.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    const before = writes.length;
    inst.rerender(<Filler rows={rows} columns={cols} label="B" />);
    await tick();
    inst.unmount();
    const rerender = writes.slice(before).join('');
    // FIX EST-1015: ZERO \x1b[2J também no inline (sem branqueamento ⇒ sem flicker em saída grande).
    expect(count(rerender, ERASE_SCREEN)).toBe(0);
    // MECANISMO do inline: abre com home cru (full-overwrite no lugar), distinto do diff por-linha
    // do cockpit (que reposiciona por CUP e NÃO abre com home cru).
    expect(rerender.includes(CURSOR_HOME)).toBe(true);
  });
});
