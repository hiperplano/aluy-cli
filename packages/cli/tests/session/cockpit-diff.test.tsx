// EST-0965 · ADR-0076 §5 — A PROVA DE BYTES do RENDERER DIFERENCIAL do cockpit, com o Ink
// REAL escrevendo no envelope REAL (`wrapStdoutWithSync` + `setCockpit`). É o sucessor do
// `cockpit-flicker.test.tsx` (#150, que provou `\x1b[2J`=0): aquele matou o BRANQUEAMENTO de
// tela, mas o transform full-paint ainda REESCREVIA O FRAME INTEIRO (`rows`×`cols`) a cada
// render — num xterm sem `?2026`, o repaint da tela TODA por tecla é varredura visível =
// flicker RESIDUAL. Este teste mede O QUANTO se repinta por re-render: o critério do DoD.
//
// CAUSA-RAIZ (provada por bytes): o cockpit enche `rows` ⇒ o Ink toma o caminho
// `outputHeight>=rows` do `onRender` e escreve `clearTerminal`+frame INTEIRO a CADA render.
// Mudar 1 char ⇒ frame cheio (`rows` linhas) reescrito. O renderer diferencial intercepta
// esse frame, compara linha-a-linha com o anterior, e emite SÓ as linhas que mudaram (CUP +
// linha + `\x1b[K`). Resultado: 1 char ⇒ 1-2 linhas reescritas, NÃO ~`rows`.
//
// MÉTRICA OBJETIVA: nº de reposicionamentos `\x1b[<n>;1H` (CUP) no re-render. ANTES (full
// paint): 0 CUP por-linha (era home + frame cheio) — provamos pelo CONTRASTE que o frame
// cheio teria ~`rows` linhas de conteúdo. DEPOIS (diff): 1 CUP (só a linha que mudou).
// pyte prova "pinta"; pra FLICKER, conta bytes/repaints no STREAM (o que este teste faz).

// PRIMEIRO import (side-effect): scrub `CI`/`CI_*` ANTES do `ink` ser avaliado — senão o
// Ink (via `is-in-ci`) DESLIGA o render no runner (`CI=true`) e o frame nunca sai, deixando
// a prova de bytes vazia/enganosa. Ver `_scrub-ci-env.ts` (classe do #149, in-process).
import './_scrub-ci-env.js';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, Box, Text } from 'ink';
import { wrapStdoutWithSync, createCockpitDiffer } from '../../src/session/synchronized-output.js';

const ESC = '\x1b[';
const ERASE_SCREEN = `${ESC}2J`; // o branqueamento de tela = a fonte do flicker do #150.
const ERASE_SCROLLBACK = `${ESC}3J`;
const CLEAR_TERMINAL = `${ESC}2J${ESC}3J${ESC}H`; // o `clearTerminal` do Ink (alt-screen).
const ERASE_TO_EOL = `${ESC}K`;
const ERASE_TO_EOS = `${ESC}J`;
const CURSOR_HOME = `${ESC}H`;

/** Conta ocorrências (sem sobreposição) de `needle` em `s`. */
function count(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

// `\x1b` literal num regex literal dispara `no-control-regex` (pegadinha conhecida) ⇒
// construímos o padrão de CUP via `RegExp` com o ESC fora da fonte.
const CUP_RE = new RegExp(`${ESC.replace('[', '\\[')}\\d+;1H`, 'g');
/** Conta os reposicionamentos `\x1b[<n>;1H` (CUP) — UMA por linha REESCRITA pelo diff. */
function countCursorTo(s: string): number {
  return (s.match(CUP_RE) ?? []).length;
}

/**
 * Stub de WriteStream que CAPTURA cada `write` e fixa `rows`/`columns` (o que faz o Ink
 * escolher o caminho de render). `rows` pequeno + árvore de `rows` linhas ⇒ `outputHeight>=
 * rows` ⇒ `clearTerminal`+frame (o caminho do cockpit).
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

/**
 * Cockpit FIEL ao real: a maioria das linhas é ESTÁTICA (conversa/log/régua) e SÓ a última
 * linha (o composer) carrega o texto digitado. Mudar `composer` re-renderiza o frame todo no
 * Ink, mas só UMA linha muda de conteúdo — o cenário "digitar 1 char" do DoD.
 */
function Cockpit({ rows, columns, composer }: { rows: number; columns: number; composer: string }) {
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {Array.from({ length: rows - 1 }, (_, i) => (
        <Text key={i}>{`linha estática ${i} — conteúdo do cockpit`}</Text>
      ))}
      <Text key="composer">{`› ${composer}`}</Text>
    </Box>
  );
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('EST-0965 · ADR-0076 §5 — renderer diferencial: 1 char ⇒ só a(s) linha(s) mudada(s), NÃO o frame cheio', () => {
  it('PROVA DE BYTES: digitar 1 char no composer ⇒ o diff reescreve ~1 linha (1 CUP), não ~rows', async () => {
    const rows = 40;
    const cols = 80;
    const { stream, writes } = makeStub(rows, cols);
    // o envelope REAL do cockpit: overwrite ON + sync ON + setCockpit(true) (como no wiring).
    const sync = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    sync.setCockpit(true);
    const inst = render(<Cockpit rows={rows} columns={cols} composer="ola" />, {
      stdout: sync.stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await tick();
    const before = writes.length;
    // DIGITA 1 char: "ola" → "olas". SÓ a linha do composer muda; as outras `rows-1` ficam.
    inst.rerender(<Cockpit rows={rows} columns={cols} composer="olas" />);
    await tick();
    inst.unmount();

    const rerender = writes.slice(before).join('');
    // SANIDADE: houve re-render (saíram bytes) — senão o teste seria vacuamente verde.
    expect(rerender.length, 'o re-render não produziu bytes').toBeGreaterThan(0);

    // NÃO regride o #150: zero branqueamento de tela.
    expect(count(rerender, ERASE_SCREEN), 'cintila: \\x1b[2J no re-render (#150)').toBe(0);
    expect(count(rerender, ERASE_SCROLLBACK)).toBe(0);

    // O CRITÉRIO-MESTRE do DoD: o diff reescreveu POUCAS linhas, NÃO o frame cheio. 1 char
    // que muda 1 linha ⇒ ~1 reposicionamento CUP. Folga p/ a contabilidade do Ink (≤ 3),
    // mas MUITO abaixo de `rows` (40) — o full-paint reescreveria as 40.
    const cups = countCursorTo(rerender);
    expect(
      cups,
      `diff reescreveu ${cups} linhas (esperado ~1, jamais ~${rows})`,
    ).toBeLessThanOrEqual(3);
    expect(
      cups,
      'diff não reescreveu nenhuma linha (composer mudou — deveria reescrever 1)',
    ).toBeGreaterThanOrEqual(1);

    // O conteúdo NOVO da linha do composer SAIU (a prova de que pintou o que mudou).
    expect(rerender.includes('› olas'), 'a linha nova do composer não foi reescrita').toBe(true);
    // E o conteúdo ESTÁTICO NÃO foi reescrito (linhas iguais não entram no diff).
    expect(
      rerender.includes('linha estática 0 — conteúdo do cockpit'),
      'o diff reescreveu uma linha que NÃO mudou (= frame cheio = flicker)',
    ).toBe(false);
  });

  it('CONTRASTE (antes/depois): o full-paint (#150) reescreveria o frame INTEIRO (~rows linhas) no mesmo cenário', () => {
    // Mesmo cenário, mas sem o diff: o caminho full-paint (`cockpitOverwriteInPlace`, #150)
    // emitia `home + frame INTEIRO + \x1b[J` — o frame inteiro contém TODAS as linhas
    // estáticas, inclusive as que NÃO mudaram. Provamos pelos bytes que o "depois" (diff)
    // omite o que o "antes" (full-paint) reescrevia.
    const rows = 40;
    // Monta dois frames de cockpit como o Ink os emitiria (clearTerminal + body).
    const bodyA =
      Array.from({ length: rows - 1 }, (_, i) => `linha estática ${i} — conteúdo do cockpit`).join(
        '\n',
      ) + '\n› ola';
    const bodyB =
      Array.from({ length: rows - 1 }, (_, i) => `linha estática ${i} — conteúdo do cockpit`).join(
        '\n',
      ) + '\n› olas';
    const frameA = `${CLEAR_TERMINAL}${bodyA}`;
    const frameB = `${CLEAR_TERMINAL}${bodyB}`;

    const differ = createCockpitDiffer();
    const paintedA = differ.transform(frameA); // 1º frame: full paint (pinta na entrada, #145).
    const diffB = differ.transform(frameB); // 2º frame: SÓ a linha mudada.

    // ANTES (#150 full-paint): o 1º frame ainda é full paint (correto — entrada). Mas o 2º
    // frame, no #150, seria OUTRO full-paint (home + body inteiro). DEPOIS (diff): o 2º é só
    // a linha mudada. Métrica: linhas de conteúdo reescritas no 2º frame.
    expect(paintedA.startsWith(CURSOR_HOME), '1º frame deve pintar tudo na entrada (#145)').toBe(
      true,
    );
    expect(paintedA.includes('linha estática 0 — conteúdo do cockpit')).toBe(true);

    // O DIFF do 2º frame: 1 CUP (só o composer), NÃO o frame cheio.
    expect(countCursorTo(diffB), 'diff do 2º frame deve reescrever só 1 linha').toBe(1);
    expect(diffB.includes('› olas')).toBe(true);
    expect(
      diffB.includes('linha estática 0 — conteúdo do cockpit'),
      'o diff NÃO deve reescrever linhas estáticas (o full-paint #150 reescreveria)',
    ).toBe(false);
    // o full-paint reescreveria as `rows` linhas; o diff reescreve 1.
    const fullPaintLines = (frameB.slice(CLEAR_TERMINAL.length).match(/\n/g) ?? []).length + 1;
    expect(fullPaintLines).toBe(rows); // o "antes" reescrevia este tanto.
    expect(countCursorTo(diffB)).toBeLessThan(fullPaintLines); // o "depois", muito menos.
  });
});

// ── Regressão (achado do dono): composer DUPLICADO / fantasma no cockpit ─────────────────
// CAUSA-RAIZ (provada por bytes ao vivo): o Ink escreve `clearTerminal + fullStaticOutput +
// output` no caminho `outputHeight>=rows` e NUNCA reseta o `fullStaticOutput`. Ao entrar no
// cockpit DEPOIS do inline, o scrollback inline (splash + notas de boot, ~13 linhas) fica
// PREPENDIDO a CADA frame do cockpit ⇒ o frame vira `rows+13` linhas num terminal de `rows`
// ⇒ o terminal ROLA ⇒ o diff por-linha ABSOLUTO do differ dessincroniza ⇒ a linha ANTIGA do
// composer sobra como FANTASMA (composer duplicado). O fix CLIPA o frame p/ as ÚLTIMAS `rows`
// linhas (o grid crava `height=rows`; o prefixo é o excedente do Static).
describe('createCockpitDiffer — clipa o prefixo obsoleto do fullStaticOutput (fantasma do composer)', () => {
  const CLEAR = `${ESC}2J${ESC}3J${ESC}H`;
  const TERM_ROWS = 40;
  // linhas-alvo dos CUP `\x1b[<n>;1H` no stream (via RegExp construído — o ESC fora da fonte
  // literal p/ não disparar `no-control-regex`, mesma pegadinha do `CUP_RE` acima).
  const CUP_ROW_RE = new RegExp(`${ESC.replace('[', '\\[')}(\\d+);1H`, 'g');
  const cupRows = (s: string): number[] => [...s.matchAll(CUP_ROW_RE)].map((m) => Number(m[1]));
  // 13 linhas de "scrollback inline" que o Ink prepende (splash + notas de boot).
  const staticPrefix = Array.from({ length: 13 }, (_, i) => `STATIC_LEAK_${i}`);
  // o grid do cockpit: `rows` linhas cravadas, a última é o composer.
  const cockpitBody = (composer: string): string[] => [
    ...Array.from({ length: TERM_ROWS - 1 }, (_, i) => `cockpit_${i}`),
    `› ${composer}`,
  ];
  const leakedFrame = (composer: string): string =>
    `${CLEAR}${[...staticPrefix, ...cockpitBody(composer)].join('\n')}`;

  it('o 1º frame pinta SÓ as últimas `rows` linhas (o cockpit) — o prefixo do Static NÃO vaza', () => {
    const differ = createCockpitDiffer(() => TERM_ROWS);
    const painted = differ.transform(leakedFrame('ola'));
    // o grid do cockpit saiu…
    expect(painted.includes('cockpit_0')).toBe(true);
    expect(painted.includes('› ola')).toBe(true);
    // …mas NENHUMA linha do prefixo inline vazado (senão o frame passaria de `rows` ⇒ rola).
    expect(painted.includes('STATIC_LEAK'), 'o prefixo do fullStaticOutput vazou p/ o frame').toBe(
      false,
    );
    // e o cursor NUNCA é posicionado além de `rows` (o que faria o terminal rolar).
    const maxRow = Math.max(0, ...cupRows(painted));
    expect(maxRow, 'CUP além de rows ⇒ rolagem ⇒ fantasma').toBeLessThanOrEqual(TERM_ROWS);
  });

  it('encolher o composer (2→1 linha) NÃO deixa fantasma: a linha do composer é reescrita, sem sobra', () => {
    const differ = createCockpitDiffer(() => TERM_ROWS);
    // frame A: composer com 2 "linhas" (simulado por um texto que muda) — ambos frames têm
    // EXATAMENTE `rows` linhas de grid + o mesmo prefixo de 13; o clip mantém os dois em `rows`.
    differ.transform(leakedFrame('texto grande no composer'));
    const diff = differ.transform(leakedFrame('')); // "encolheu" p/ vazio
    // a linha nova (composer vazio) foi reescrita na sua posição…
    expect(diff.includes('›')).toBe(true);
    // …e o diff NÃO reescreve as `cockpit_*` que não mudaram (seria full-paint = flicker)…
    expect(diff.includes('cockpit_0')).toBe(false);
    // …e, crucialmente, nenhum CUP além de `rows` (o prefixo clipado não desloca as linhas).
    expect(Math.max(0, ...cupRows(diff))).toBeLessThanOrEqual(TERM_ROWS);
    // o prefixo do Static segue fora do stream.
    expect(diff.includes('STATIC_LEAK')).toBe(false);
  });

  it('sem prefixo (frame já == `rows`) ⇒ comportamento INALTERADO (não clipa nada)', () => {
    const differ = createCockpitDiffer(() => TERM_ROWS);
    const painted = differ.transform(`${CLEAR}${cockpitBody('ola').join('\n')}`);
    expect(painted.includes('cockpit_0')).toBe(true);
    expect(painted.includes('› ola')).toBe(true);
  });

  // GUARD DURO (crash) — `rowsOf()` inválido (NaN/0/undefined/Infinity) NÃO pode explodir o
  // clip (`slice(-termRows)` com lixo) nem passar dimensão inválida adiante: degrada p/ "não
  // clipa" (seguro). Prova que o differ nunca lança nem devolve algo corrompido.
  for (const badRows of [NaN, 0, -5, Infinity, undefined]) {
    it(`rowsOf()=${String(badRows)} ⇒ NÃO lança, não clipa (degrada seguro)`, () => {
      const differ = createCockpitDiffer(() => badRows as unknown as number);
      const frame = `${CLEAR}${[...staticPrefix, ...cockpitBody('ola')].join('\n')}`;
      expect(() => {
        const out = differ.transform(frame);
        // sem clip válido ⇒ pinta o frame inteiro (inclui o prefixo) — mas NUNCA crasha.
        expect(typeof out).toBe('string');
      }).not.toThrow();
    });
  }
});

// ── Unidade do renderer diferencial (puro, sem Ink) — borda a borda ──────────────────────
describe('createCockpitDiffer — diff por-linha (unidade)', () => {
  const cockpitFrame = (body: string): string => `${CLEAR_TERMINAL}${body}`;

  /**
   * FIX #151 — onde o full-paint deixaria o cursor (o FIM do frame, onde mora o caret do
   * composer). É o reposicionamento que o diff EMITE no fim (≠ `CURSOR_HOME`): CUP p/ a
   * última linha do body (1-based) na coluna logo após o último caractere imprimível. Os
   * escapes CSI (`\x1b[…`, ex. `\x1b[?25h`) têm largura ZERO ⇒ não contam coluna.
   */
  const endCUP = (body: string): string => {
    let row = 1;
    let col = 1;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === '\x1b' && body[i + 1] === '[') {
        let j = i + 2;
        while (j < body.length && body[j] >= '0' && body[j] <= '?') j += 1;
        while (j < body.length && body[j] >= ' ' && body[j] <= '/') j += 1;
        i = j;
        continue;
      }
      if (ch === '\n') {
        row += 1;
        col = 1;
      } else if (ch === '\r') {
        col = 1;
      } else {
        col += 1;
      }
    }
    return `${ESC}${row};${col}H`;
  };

  it('1º frame (buffer vazio) ⇒ PINTA TUDO no lugar (home + frame + \\x1b[J) — pinta na entrada (#145)', () => {
    const d = createCockpitDiffer();
    const out = d.transform(cockpitFrame('a\nb\nc'));
    // FIX (EST-1015, resize-órfão) — full-paint agora apaga a cauda POR-LINHA (`\x1b[K` ENTRE
    // as linhas) p/ não deixar rabo de conteúdo velho quando uma linha encolhe sobre a tela
    // SUJA (resetDiffer no resize). Em tela fresca os `\x1b[K` são inócuos. ZERO `\x1b[2J`.
    expect(out).toBe(`${CURSOR_HOME}a${ERASE_TO_EOL}\nb${ERASE_TO_EOL}\nc${ERASE_TO_EOS}`);
    expect(count(out, ERASE_SCREEN)).toBe(0); // sem branqueamento.
  });

  it('2º frame com 1 linha mudada ⇒ SÓ aquela linha (CUP + linha + \\x1b[K), zero linhas iguais', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb\nc')); // assenta o frame anterior.
    const out = d.transform(cockpitFrame('a\nX\nc')); // mudou só a linha 2.
    // reposiciona na linha 2, escreve "X", limpa a cauda; nada das linhas 1 e 3. O cursor
    // ASSENTA no FIM do frame (após 'c' na linha 3 ⇒ `\x1b[3;2H`), NÃO no home (FIX #151).
    expect(out).toBe(`${ESC}2;1HX${ERASE_TO_EOL}${endCUP('a\nX\nc')}`);
    expect(countCursorTo(out)).toBe(1); // 1 linha reescrita (`;1H`); o CUP final é `;2H`.
    expect(out.includes('a')).toBe(false); // linha 1 não reescrita.
    expect(out.includes('c')).toBe(false); // linha 3 não reescrita.
  });

  it('frame IDÊNTICO ⇒ nenhuma linha reescrita (só o reposicionamento final) — zero repaint', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb\nc'));
    const out = d.transform(cockpitFrame('a\nb\nc'));
    // Nada de conteúdo reescrito ⇒ só o cursor vai pro FIM do frame (FIX #151), não home.
    expect(out).toBe(endCUP('a\nb\nc'));
    expect(countCursorTo(out)).toBe(0); // nenhuma linha reescrita (`;1H`).
  });

  it('frame que ENCOLHEU ⇒ reescreve as mudadas + \\x1b[J p/ varrer as linhas órfãs abaixo', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb\nc\nd')); // 4 linhas.
    const out = d.transform(cockpitFrame('a\nb')); // 2 linhas (encolheu).
    // 'a' e 'b' iguais ⇒ não reescreve; posiciona na linha 3 (1ª órfã) e varre PRA BAIXO. O
    // cursor ASSENTA no fim do frame (após 'b' na linha 2 ⇒ `\x1b[2;2H`), NÃO no home (#151).
    expect(out).toBe(`${ESC}3;1H${ERASE_TO_EOS}${endCUP('a\nb')}`);
    expect(count(out, ERASE_SCREEN)).toBe(0);
  });

  it('frame que CRESCEU ⇒ reescreve as linhas novas (que não existiam no anterior)', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb')); // 2 linhas.
    const out = d.transform(cockpitFrame('a\nb\nc')); // 3 linhas (cresceu).
    // 'a','b' iguais ⇒ pula; só a linha 3 ('c') é nova ⇒ reescreve. Cursor no FIM (#151).
    expect(out).toBe(`${ESC}3;1Hc${ERASE_TO_EOL}${endCUP('a\nb\nc')}`);
    expect(countCursorTo(out)).toBe(1);
  });

  it('reset() ⇒ o PRÓXIMO frame pinta TUDO de novo (entrada do alt-screen)', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb\nc'));
    d.reset(); // entrou no cockpit de novo ⇒ tela vazia.
    const out = d.transform(cockpitFrame('a\nb\nc')); // MESMO conteúdo, mas pós-reset ⇒ full paint.
    // full-paint per-line (`\x1b[K` entre linhas) — limpa a cauda velha no resize (EST-1015).
    expect(out).toBe(`${CURSOR_HOME}a${ERASE_TO_EOL}\nb${ERASE_TO_EOL}\nc${ERASE_TO_EOS}`);
  });

  it('ESCAPE ISOLADO (toggle de cursor `\\x1b[?25l`/`\\x1b[?25h`) ⇒ devolve CRU e NÃO toca o buffer', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb')); // assenta.
    // O Ink emite `\x1b[?25l`/`\x1b[?25h` como writes SEPARADOS (esconde/mostra cursor) — NÃO
    // são frames; passam CRUS e não mexem no buffer do diff.
    const hide = `${ESC}?25l`;
    const show = `${ESC}?25h`;
    expect(d.transform(hide)).toBe(hide);
    expect(d.transform(show)).toBe(show);
    // o buffer não foi tocado: um frame idêntico ao assentado ainda dá "nada mudou" (só o
    // reposicionamento final no FIM do frame — FIX #151 —, sem nenhuma linha reescrita).
    expect(d.transform(cockpitFrame('a\nb'))).toBe(endCUP('a\nb'));
  });

  it('FIX corrupção — CONTEÚDO CRU (frame do log-update SEM clearTerminal) É DIFFADO no lugar absoluto (não passa cru)', () => {
    // CAUSA-RAIZ da corrupção sob streaming: quando o frame do cockpit ENCOLHE < `rows`, o Ink
    // cai no `log-update` e emite o body SEM o `clearTerminal` (o 1º `throttledLog` com
    // `previousLineCount=0` escreve só o conteúdo). ANTES o differ passava isso CRU ⇒ era
    // escrito da posição em que o cursor parou (meio da tela) ⇒ sobrescrevia a linha ERRADA,
    // deixando CAUDA da velha e MESCLANDO conteúdo. AGORA o differ OWNS esse formato e faz o
    // MESMO diff por-linha ABSOLUTO (CUP + `\x1b[K`).
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('linha longa AAAAA\nb\nc')); // assenta (via clearTerminal).
    // o Ink agora emite o frame CRU (sem clearTerminal), com a 1ª linha ENCOLHIDA.
    const raw = 'curta\nb\nc';
    const out = d.transform(raw);
    // SÓ a linha 1 mudou ⇒ CUP absoluto p/ a linha 1 + "curta" + `\x1b[K` (LIMPA a cauda da
    // "linha longa AAAAA" ⇒ sem rabo). Posiciona ABSOLUTO, não relativo. Cursor no FIM (#151).
    expect(out).toBe(`${ESC}1;1Hcurta${ERASE_TO_EOL}${endCUP('curta\nb\nc')}`);
    expect(out.includes(ERASE_TO_EOL), 'o `\\x1b[K` limpa a cauda da linha velha mais longa').toBe(
      true,
    );
    expect(countCursorTo(out)).toBe(1); // 1 linha reescrita por CUP ABSOLUTO.
  });

  it('FIX corrupção — frame `eraseLines` (log-update com previousLineCount>0) também É DIFFADO absoluto', () => {
    // O OUTRO formato do log-update: `eraseLines(N)` + body. ANTES passava cru (cursor-up
    // RELATIVO da posição errada ⇒ corrupção). Agora o differ extrai o body e faz o diff
    // absoluto. (eraseLines(N) = (\x1b[2K\x1b[1A)×(N-1) + \x1b[2K + \x1b[G.)
    const ERASE_2K = `${ESC}2K`;
    const UP = `${ESC}1A`;
    const G = `${ESC}G`;
    const eraseLines = (n: number): string =>
      n <= 0 ? '' : `${ERASE_2K}${UP}`.repeat(n - 1) + `${ERASE_2K}${G}`;
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('AAAAAAAA muito longa\nb\nc')); // assenta.
    const out = d.transform(`${eraseLines(3)}curta\nb\nc`); // log-update encolheu.
    // ZERO `\x1b[2K` (branqueamento) no resultado — vira diff absoluto; só a linha 1 muda.
    expect(count(out, ERASE_2K), 'sem branqueamento de linha (\\x1b[2K)').toBe(0);
    expect(out).toBe(`${ESC}1;1Hcurta${ERASE_TO_EOL}${endCUP('curta\nb\nc')}`);
  });

  it('clearTerminal PURO (clear sem conteúdo) ⇒ home + \\x1b[J e ZERA o buffer (próximo pinta tudo)', () => {
    const d = createCockpitDiffer();
    d.transform(cockpitFrame('a\nb\nc'));
    const cleared = d.transform(CLEAR_TERMINAL); // clear puro.
    expect(cleared).toBe(`${CURSOR_HOME}${ERASE_TO_EOS}`);
    // pós-clear, o buffer zerou ⇒ o próximo frame pinta TUDO (não acha "nada mudou").
    const out = d.transform(cockpitFrame('a\nb\nc'));
    // full-paint per-line (`\x1b[K` entre linhas) — limpa a cauda velha no resize (EST-1015).
    expect(out).toBe(`${CURSOR_HOME}a${ERASE_TO_EOL}\nb${ERASE_TO_EOL}\nc${ERASE_TO_EOS}`);
  });
});
