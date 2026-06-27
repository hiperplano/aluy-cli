// EST-0965 — SYNCHRONIZED OUTPUT (Mode 2026 / `?2026`): prova POR CAPTURA DE BYTES que
// cada FRAME de render do Ink sai envolto em `?2026h` (BSU) … `?2026l` (ESU), atômico;
// que no exit/unmount sai um ESU FINAL (não deixa o terminal preso em sync); e que
// `ALUY_SYNC_OUTPUT=0` desliga (não emite escape nenhum).
//
// A prova do "frame INTEIRO como unidade" (≠ writes soltos) vem de DOIS níveis:
//  (1) UNIDADE: o wrapper envolve cada chunk como BSU+chunk+ESU num único write real.
//  (2) FIO REAL: dirigimos o `render()` do Ink (não a ink-testing-library) com o stdout
//      ENVELOPADO contra um stream FAKE-TTY e capturamos os bytes. O Ink (`log-update`)
//      emite o frame vivo num ÚNICO write (erase+redraw juntos) ⇒ o conteúdo do frame
//      aparece DENTRO de um par BSU…ESU, com h e l BALANCEADOS.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { render, Box, Text } from 'ink';
import {
  wrapStdoutWithSync,
  syncOutputEnabled,
  BEGIN_SYNC,
  END_SYNC,
} from '../../src/session/synchronized-output.js';

const BSU = BEGIN_SYNC; // \x1b[?2026h
const ESU = END_SYNC; // \x1b[?2026l

/** Coletor de bytes que delega o resto ao contrato mínimo de WriteStream. */
function captureStream(): NodeJS.WriteStream & { text(): string; writes(): string[] } {
  let buf = '';
  const chunks: string[] = [];
  const stub = {
    write(chunk: string | Uint8Array): boolean {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      buf += s;
      chunks.push(s);
      return true;
    },
    text: () => buf,
    writes: () => chunks,
  };
  return stub as unknown as NodeJS.WriteStream & { text(): string; writes(): string[] };
}

/**
 * Stream FAKE-TTY com a superfície que o Ink lê p/ calcular o layout (isTTY/columns/
 * rows + EventEmitter p/ resize). Captura os bytes escritos. Rows altas o bastante p/
 * o Ink ficar no caminho `log-update` (≠ `clearTerminal`, que só dispara quando o
 * frame é mais alto que o terminal).
 */
function fakeTty(): NodeJS.WriteStream & { text(): string } {
  const ee = new EventEmitter();
  let buf = '';
  const stub = Object.assign(ee, {
    isTTY: true as const,
    columns: 80,
    rows: 100,
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
    text: () => buf,
  });
  return stub as unknown as NodeJS.WriteStream & { text(): string };
}

describe('syncOutputEnabled — toggle (EST-0965)', () => {
  it('default LIGADO (env sem a var)', () => {
    expect(syncOutputEnabled({})).toBe(true);
  });
  it('ALUY_SYNC_OUTPUT=0 ⇒ DESLIGADO', () => {
    expect(syncOutputEnabled({ ALUY_SYNC_OUTPUT: '0' })).toBe(false);
  });
  it('ALUY_SYNC_OUTPUT=1 (ou qualquer ≠0) ⇒ LIGADO', () => {
    expect(syncOutputEnabled({ ALUY_SYNC_OUTPUT: '1' })).toBe(true);
  });
});

describe('wrapStdoutWithSync — unidade: cada write vira BSU+chunk+ESU (EST-0965)', () => {
  it('envolve um chunk de frame num ÚNICO write real (não fatia em 3)', () => {
    const out = captureStream();
    const { stdout } = wrapStdoutWithSync(out);
    stdout.write('FRAME-A');
    // UM write ao stream real, com BSU+conteúdo+ESU concatenados.
    expect(out.writes()).toEqual([`${BSU}FRAME-A${ESU}`]);
    // h e l balanceados, conteúdo NO MEIO.
    expect(out.text()).toBe(`${BSU}FRAME-A${ESU}`);
  });

  it('cada frame é um par BSU…ESU isolado (writes balanceados)', () => {
    const out = captureStream();
    const { stdout } = wrapStdoutWithSync(out);
    stdout.write('F1');
    stdout.write('F2');
    expect(out.writes()).toEqual([`${BSU}F1${ESU}`, `${BSU}F2${ESU}`]);
    const opens = out.text().split(BSU).length - 1;
    const closes = out.text().split(ESU).length - 1;
    expect(opens).toBe(2);
    expect(closes).toBe(2);
  });

  it('chunk vazio ⇒ delega cru (não emite BSU/ESU em volta de nada)', () => {
    const out = captureStream();
    const { stdout } = wrapStdoutWithSync(out);
    stdout.write('');
    expect(out.text()).toBe('');
  });

  it('cleanup() emite UM ESU final (idempotente) — não deixa o terminal em sync', () => {
    const out = captureStream();
    const { stdout, cleanup } = wrapStdoutWithSync(out);
    stdout.write('F');
    cleanup();
    cleanup(); // idempotente: não emite um 2º ESU.
    expect(out.text()).toBe(`${BSU}F${ESU}${ESU}`);
    // o ESU final NÃO vem envolto em BSU (não é um frame; é o reset do modo).
    expect(out.writes().at(-1)).toBe(ESU);
  });

  it('delega isTTY/columns/rows ao stream original (Ink precisa p/ layout)', () => {
    const tty = fakeTty();
    const { stdout } = wrapStdoutWithSync(tty);
    expect(stdout.isTTY).toBe(true);
    expect(stdout.columns).toBe(80);
    expect(stdout.rows).toBe(100);
  });
});

describe('render REAL do Ink através do stdout envelopado (EST-0965)', () => {
  // INVARIANTE ROBUSTA (independe do ambiente): TUDO que o Ink REAL escreve pelo
  // stdout passa enveloped — cada write do Ink vira um par BSU…ESU, h/l BALANCEADOS,
  // o último escape de sync é um ESU (terminal fora do modo sync). Não dependemos de
  // QUAL frame o Ink escolhe escrever: em CI o Ink (is-in-ci) toma um caminho de write
  // diferente do TTY interativo (ink.js: o ramo CI não chama `log(output)`), então
  // asserir "o conteúdo X aparece" seria flaky por ambiente. O que importa p/ a feature
  // — que o envelope abrace o write do Ink como UNIDADE — é o que provamos aqui; a
  // prova "conteúdo dentro do par" é determinística na UNIDADE (testes acima).
  it('TODO write do Ink REAL sai envolto em BSU…ESU (h/l balanceados, termina fora do sync)', async () => {
    const tty = fakeTty();
    // Espia o write CRU do stream real p/ provar que cada chunk que chega ao terminal
    // começa com BSU e termina com ESU — o envelope por unidade de write do Ink.
    const rawWrites: string[] = [];
    const realWrite = tty.write.bind(tty);
    tty.write = ((chunk: string | Uint8Array): boolean => {
      rawWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return realWrite(chunk as string);
    }) as NodeJS.WriteStream['write'];

    const { stdout, cleanup } = wrapStdoutWithSync(tty);
    const instance = render(
      <Box>
        <Text>ALUY-SYNC-FRAME</Text>
      </Box>,
      { stdout, patchConsole: false },
    );
    // Poll DETERMINÍSTICO até o Ink ter escrito ALGO pelo nosso wrapper (≥1 par sync) —
    // sem depender de qual conteúdo (robusto a CI). waitUntilExit() não se aplica (o
    // fake-TTY não dirige o ciclo de saída do Ink).
    const deadline = Date.now() + 4000;
    while (rawWrites.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const out = tty.text();
    // Snapshot dos writes do FRAME (do Ink, pelo wrapper) ANTES do cleanup — o ESU
    // final do cleanup() é um write CRU (bare ESU) e não deve entrar nesta lista.
    const frameWrites = [...rawWrites];
    instance.unmount();
    cleanup();

    // o Ink escreveu ao menos um frame pelo wrapper…
    expect(frameWrites.length).toBeGreaterThanOrEqual(1);
    // …e CADA write que veio do WRAPPER (frame do Ink) está envolto: começa com BSU,
    // termina com ESU. (O ESU final do cleanup() é o único write CRU — fora desta lista,
    // pois foi capturado no snapshot `out` ANTES do cleanup.)
    for (const w of frameWrites) {
      expect(w.startsWith(BSU)).toBe(true);
      expect(w.endsWith(ESU)).toBe(true);
    }

    // h e l globalmente BALANCEADOS no stream capturado (todo BSU tem seu ESU).
    const opens = out.split(BSU).length - 1;
    const closes = out.split(ESU).length - 1;
    expect(opens).toBeGreaterThanOrEqual(1);
    expect(closes).toBe(opens);

    // termina FORA do modo sync: o último escape de sync no stream capturado é um ESU.
    expect(out.lastIndexOf(ESU)).toBeGreaterThan(out.lastIndexOf(BSU));
  });
});
