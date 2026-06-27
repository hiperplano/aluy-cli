// EST-0965 — testes do ACABAMENTO DE RENDER: overwrite-in-place (mata o flicker em
// QUALQUER terminal) + synchronized-output (`?2026`). A prova-mestra está nos BYTES:
// depois do transform, o frame redesenhado NÃO contém NENHUM `\x1b[2K` (limpa-linha-
// inteira = branqueamento = flicker), mas SOBE o cursor (`\x1b[1A`), limpa só a CAUDA
// (`\x1b[K`) por linha e as ÓRFÃS (`\x1b[J`) no fim — sem branco intermediário.
import { describe, it, expect, vi } from 'vitest';
import { eraseLines } from 'ansi-escapes'; // a MESMA fonte do erase que o Ink emite.
import {
  overwriteInPlace,
  cockpitOverwriteInPlace,
  wrapStdoutWithSync,
  syncOutputEnabled,
  overwriteRenderEnabled,
  BEGIN_SYNC,
  END_SYNC,
} from './synchronized-output.js';

const ESC = '\x1b[';
const ERASE_LINE = `${ESC}2K`;
const CURSOR_UP_1 = `${ESC}1A`;
const CURSOR_COL1 = `${ESC}G`;
const ERASE_TO_EOL = `${ESC}K`;
const ERASE_TO_EOS = `${ESC}J`;
// EST-0965 (cockpit) — o `clearTerminal` que o Ink emite no alt-screen (cockpit): apaga tela +
// scrollback + home. É a fonte do flicker do cockpit (o `\x1b[2J` branqueia a tela toda).
const ERASE_SCREEN = `${ESC}2J`;
const ERASE_SCROLLBACK = `${ESC}3J`;
const CURSOR_HOME = `${ESC}H`;
const CLEAR_TERMINAL = `${ERASE_SCREEN}${ERASE_SCROLLBACK}${CURSOR_HOME}`;

/** Conta quantas vezes `needle` aparece em `s` (sem sobreposição). */
function count(s: string, needle: string): number {
  return s.split(needle).length - 1;
}

/** Reconstrói o write do log-update do Ink: `eraseLines(prevLines) + frame`. */
function inkFrame(prevLines: number, frame: string): string {
  return eraseLines(prevLines) + frame;
}

/**
 * EST-0965 (cockpit) — reconstrói o write do Ink no ALT-SCREEN (cockpit): `clearTerminal + frame`.
 * É o caminho `outputHeight>=rows` do Ink (`ansiEscapes.clearTerminal + fullStaticOutput +
 * output`), que ele toma porque o cockpit ENCHE `rows`. `clearTerminal` = `\x1b[2J\x1b[3J\x1b[H`.
 */
function cockpitFrame(frame: string): string {
  return CLEAR_TERMINAL + frame;
}

describe('overwriteInPlace — o transform sobrescreve-no-lugar', () => {
  it('PROVA DE BYTES: erase do Ink + conteúdo ⇒ ZERO \\x1b[2K, com \\x1b[1A×(N-1) + \\x1b[K por linha + \\x1b[J final', () => {
    const frame = 'linha um\nlinha dois\nlinha tres\n';
    const input = inkFrame(3, frame); // (2K1A)(2K1A)(2K)(G) + conteúdo
    // sanidade: a ENTRADA realmente tem os 3 `\x1b[2K` (era o flicker).
    expect(count(input, ERASE_LINE)).toBe(3);

    const out = overwriteInPlace(input);

    // CRITÉRIO OBJETIVO do DoD: zero limpa-linha-inteira.
    expect(count(out, ERASE_LINE)).toBe(0);
    // sobe (N-1)=2 linhas (a Nª é a linha atual) e vai pra col 1.
    expect(count(out, CURSOR_UP_1)).toBe(2);
    expect(out.startsWith(`${CURSOR_UP_1}${CURSOR_UP_1}${CURSOR_COL1}`)).toBe(true);
    // `\x1b[K` ao fim de cada uma das 3 linhas.
    expect(count(out, ERASE_TO_EOL)).toBe(3);
    // `\x1b[J` UMA vez, no fim (tira órfãs do frame que encolheu).
    expect(count(out, ERASE_TO_EOS)).toBe(1);
    expect(out.endsWith(ERASE_TO_EOS)).toBe(true);
  });

  it('PRESERVA o conteúdo byte-a-byte (só insere movimento/limpeza, nunca altera texto)', () => {
    const frame = 'olá mundo\nファイル 漢字\n  indentado  \n';
    const out = overwriteInPlace(inkFrame(3, frame));
    // removendo os escapes que INSERIMOS, sobra o conteúdo original intacto.
    const stripped = out
      .replaceAll(CURSOR_UP_1, '')
      .replaceAll(CURSOR_COL1, '')
      .replaceAll(ERASE_TO_EOL, '')
      .replaceAll(ERASE_TO_EOS, '');
    expect(stripped).toBe(frame);
  });

  it('N=1 (frame de 1 linha): só \\x1b[2K\\x1b[G ⇒ sem nenhum \\x1b[1A; \\x1b[G + \\x1b[K + \\x1b[J', () => {
    const input = inkFrame(1, 'única\n');
    expect(count(input, CURSOR_UP_1)).toBe(0); // o próprio eraseLines(1) não sobe.
    const out = overwriteInPlace(input);
    expect(count(out, ERASE_LINE)).toBe(0);
    expect(count(out, CURSOR_UP_1)).toBe(0);
    expect(out.startsWith(CURSOR_COL1)).toBe(true);
    expect(count(out, ERASE_TO_EOL)).toBe(1);
    expect(out.endsWith(ERASE_TO_EOS)).toBe(true);
  });

  it('BORDA — 1º frame (sem erase anterior, eraseLines(0)) ⇒ passa CRU, inalterado', () => {
    const frame = 'primeiro render sem erase\n';
    const input = inkFrame(0, frame); // eraseLines(0) === '' ⇒ input === frame
    expect(input).toBe(frame);
    expect(overwriteInPlace(input)).toBe(frame); // intocado.
  });

  it('FRAME QUE ENCOLHE (novo tem MENOS linhas): tem o \\x1b[J final p/ remover as órfãs', () => {
    // anterior tinha 5 linhas; agora o frame tem 2 ⇒ erase de 5, conteúdo de 2.
    const out = overwriteInPlace(inkFrame(5, 'a\nb\n'));
    expect(count(out, ERASE_LINE)).toBe(0);
    expect(count(out, CURSOR_UP_1)).toBe(4); // sobe 4 (=5-1).
    expect(out.endsWith(ERASE_TO_EOS)).toBe(true); // o J tira as 3 linhas órfãs.
  });

  it('SAÍDA GRANDE no inline (EST-1015): clearTerminal + frame ⇒ ZERO \\x1b[2J, vira home + conteúdo + \\x1b[J', () => {
    // Quando a região viva EXCEDE a altura do terminal (bash enorme, muito streaming), o Ink
    // ABANDONA o eraseLines e usa o caminho `outputHeight>=rows`: `clearTerminal`(\x1b[2J\x1b[3J\x1b[H)
    // + frame. Antes, o transform inline NÃO casava esse padrão e deixava o \x1b[2J passar CRU
    // ⇒ flicker em saída grande. Agora trata igual ao cockpit (home, sobrescreve, varre abaixo).
    const frame = 'saída enorme L1\nL2\nL3\n';
    const input = cockpitFrame(frame); // \x1b[2J\x1b[3J\x1b[H + conteúdo (o caminho outputHeight>=rows)
    expect(count(input, ERASE_SCREEN)).toBe(1); // sanidade: a ENTRADA tem o \x1b[2J (o flicker).

    const out = overwriteInPlace(input);

    // CRITÉRIO OBJETIVO: zero branqueamento de tela (\x1b[2J) e de scrollback (\x1b[3J).
    expect(count(out, ERASE_SCREEN)).toBe(0);
    expect(count(out, ERASE_SCROLLBACK)).toBe(0);
    // vira: home + conteúdo COM \x1b[K POR LINHA (apaga a cauda de cada linha que possa estar
    // sobre conteúdo velho mais longo — resíduo do #304, ver inline-clearterminal-orphan) + \x1b[J
    // (varre a sobra abaixo). Conteúdo preservado byte-a-byte; ZERO \x1b[2J.
    expect(out).toBe(
      `${CURSOR_HOME}saída enorme L1${ERASE_TO_EOL}\nL2${ERASE_TO_EOL}\nL3${ERASE_TO_EOL}\n${ERASE_TO_EOS}`,
    );
  });

  it('SAÍDA GRANDE — clearTerminal PURO (sem conteúdo) ⇒ home + \\x1b[J (sem \\x1b[2J)', () => {
    const out = overwriteInPlace(CLEAR_TERMINAL);
    expect(count(out, ERASE_SCREEN)).toBe(0);
    expect(out).toBe(`${CURSOR_HOME}${ERASE_TO_EOS}`);
  });

  it('ERASE PURO (logUpdate.clear — /clear, boot-clear, unmount): sobe ao topo + \\x1b[J, sem branquear', () => {
    const input = eraseLines(4); // SÓ o erase, sem conteúdo depois.
    expect(count(input, ERASE_LINE)).toBe(4);
    const out = overwriteInPlace(input);
    // a região DEVE sumir, mas sem o branqueamento linha-a-linha (sem `\x1b[2K`).
    expect(count(out, ERASE_LINE)).toBe(0);
    expect(out).toBe(`${CURSOR_UP_1.repeat(3)}${CURSOR_COL1}${ERASE_TO_EOS}`);
  });

  it('DEGRADAÇÃO — chunk que NÃO começa com o padrão de erase ⇒ devolve CRU (nunca quebra)', () => {
    const notErase = 'texto qualquer sem prefixo de erase\n';
    expect(overwriteInPlace(notErase)).toBe(notErase);
    // append do <Static> (conteúdo puro, sem erase) também passa cru.
    const staticAppend = '▌ você\n  pergunta anterior\n\n';
    expect(overwriteInPlace(staticAppend)).toBe(staticAppend);
    // padrão PARCIAL (só sobe, sem o 2K) ⇒ não casa ⇒ cru.
    expect(overwriteInPlace(`${CURSOR_UP_1}abc`)).toBe(`${CURSOR_UP_1}abc`);
  });

  it('preserva \\r\\n (CRLF): insere o \\x1b[K ANTES do \\r, mantendo o par de quebra', () => {
    const out = overwriteInPlace(inkFrame(2, 'um\r\ndois\r\n'));
    expect(count(out, ERASE_LINE)).toBe(0);
    expect(out).toContain(`um${ERASE_TO_EOL}\r\n`);
    expect(out).toContain(`dois${ERASE_TO_EOL}\r\n`);
  });

  it('última linha SEM quebra final ⇒ ainda limpa a cauda dela (\\x1b[K)', () => {
    const out = overwriteInPlace(inkFrame(2, 'cabeça\nrabo-sem-nl'));
    expect(out).toContain(`rabo-sem-nl${ERASE_TO_EOL}${ERASE_TO_EOS}`);
  });
});

// EST-0965 · ADR-0076 §5 — o transform do COCKPIT (alt-screen). O flicker do cockpit é
// por OUTRO byte: no alt-screen o Ink emite `clearTerminal` (`\x1b[2J\x1b[3J\x1b[H`) a cada
// frame (caminho `outputHeight>=rows`), NÃO o `eraseLines` do inline. O `\x1b[2J` branqueia
// a TELA TODA antes de pintar ⇒ flicker no xterm-sem-`?2026`. A prova-mestra nos BYTES: o
// transform troca o `clearTerminal` por `\x1b[H` (home, sem branquear) + frame + `\x1b[J` ⇒
// ZERO `\x1b[2J`, com ou sem `?2026`.
describe('cockpitOverwriteInPlace — o transform do alt-screen (mata o flicker do cockpit)', () => {
  it('PROVA DE BYTES: clearTerminal + frame ⇒ ZERO \\x1b[2J/\\x1b[3J, só \\x1b[H + conteúdo + \\x1b[J', () => {
    const frame = 'região 1\nrégua ────\nregião 2\ncomposer ›\n';
    const input = cockpitFrame(frame); // `\x1b[2J\x1b[3J\x1b[H` + conteúdo
    // sanidade: a ENTRADA tem o branqueamento de tela (era o flicker).
    expect(count(input, ERASE_SCREEN)).toBe(1);
    expect(count(input, ERASE_SCROLLBACK)).toBe(1);

    const out = cockpitOverwriteInPlace(input);

    // CRITÉRIO OBJETIVO do DoD: zero branqueamento de tela inteira (a fonte do flicker).
    expect(count(out, ERASE_SCREEN)).toBe(0);
    expect(count(out, ERASE_SCROLLBACK)).toBe(0);
    // começa com home (sobrescreve no lugar — não branqueia).
    expect(out.startsWith(CURSOR_HOME)).toBe(true);
    // o conteúdo segue intacto e o `\x1b[J` final varre qualquer sobra ABAIXO.
    expect(out).toBe(`${CURSOR_HOME}${frame}${ERASE_TO_EOS}`);
    expect(out.endsWith(ERASE_TO_EOS)).toBe(true);
  });

  it('PRESERVA o conteúdo do frame byte-a-byte (só troca o prefixo de clear + acrescenta \\x1b[J)', () => {
    const frame = 'olá ファイル 漢字\n  Λluy  \nbordas │─┼\n';
    const out = cockpitOverwriteInPlace(cockpitFrame(frame));
    // tirando o home do começo e o `\x1b[J` do fim, sobra o frame original intacto.
    expect(out.slice(CURSOR_HOME.length, out.length - ERASE_TO_EOS.length)).toBe(frame);
  });

  it('clearTerminal PURO (sem conteúdo) ⇒ home + \\x1b[J (limpa a tela PRA BAIXO sem \\x1b[2J)', () => {
    const out = cockpitOverwriteInPlace(CLEAR_TERMINAL);
    expect(out).toBe(`${CURSOR_HOME}${ERASE_TO_EOS}`);
    expect(count(out, ERASE_SCREEN)).toBe(0);
  });

  it('chunk que NÃO começa com clearTerminal ⇒ devolve CRU (1º frame / write parcial / Static)', () => {
    // um frame de eraseLines (inline) NÃO é tocado pelo transform do cockpit.
    const inline = inkFrame(3, 'a\nb\nc\n');
    expect(cockpitOverwriteInPlace(inline)).toBe(inline);
    // texto puro (sem clear) idem.
    expect(cockpitOverwriteInPlace('texto solto')).toBe('texto solto');
    // clearTerminal parcial (só `\x1b[2J`, sem o resto) ⇒ cru (não casa o prefixo exato).
    expect(cockpitOverwriteInPlace(`${ERASE_SCREEN}conteúdo`)).toBe(`${ERASE_SCREEN}conteúdo`);
  });
});

describe('toggles de ambiente', () => {
  it('syncOutputEnabled: default ON; só `ALUY_SYNC_OUTPUT=0` desliga', () => {
    expect(syncOutputEnabled({})).toBe(true);
    expect(syncOutputEnabled({ ALUY_SYNC_OUTPUT: '1' })).toBe(true);
    expect(syncOutputEnabled({ ALUY_SYNC_OUTPUT: '0' })).toBe(false);
  });

  it('overwriteRenderEnabled: default ON; só `ALUY_OVERWRITE_RENDER=0` desliga', () => {
    expect(overwriteRenderEnabled({})).toBe(true);
    expect(overwriteRenderEnabled({ ALUY_OVERWRITE_RENDER: '1' })).toBe(true);
    expect(overwriteRenderEnabled({ ALUY_OVERWRITE_RENDER: '0' })).toBe(false);
  });
});

/** Stub mínimo de WriteStream que GRAVA tudo que recebe, p/ inspecionar os bytes. */
function makeStub(): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    write(chunk: string, _enc?: unknown, cb?: () => void): boolean {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      if (typeof _enc === 'function') (_enc as () => void)();
      else if (cb) cb();
      return true;
    },
    isTTY: true,
    columns: 80,
    rows: 24,
    on() {
      return this;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe('wrapStdoutWithSync — composição das camadas no fio do stdout', () => {
  it('default (sync+overwrite): o frame sai BSU + overwrite-in-place + ESU, ZERO \\x1b[2K', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream);
    stdout.write(inkFrame(3, 'a\nb\nc\n'));
    expect(writes).toHaveLength(1);
    const out = writes[0];
    expect(out.startsWith(BEGIN_SYNC)).toBe(true);
    expect(out.endsWith(END_SYNC)).toBe(true);
    expect(count(out, ERASE_LINE)).toBe(0); // o overwrite rodou DENTRO do envelope.
    expect(count(out, CURSOR_UP_1)).toBe(2);
  });

  it('overwrite OFF: NÃO transforma (mantém o \\x1b[2K do Ink), mas ainda envelopa em ?2026', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream, { sync: true, overwrite: false });
    stdout.write(inkFrame(3, 'a\nb\nc\n'));
    expect(count(writes[0], ERASE_LINE)).toBe(3); // erase do Ink preservado.
    expect(writes[0].startsWith(BEGIN_SYNC)).toBe(true);
  });

  it('sync OFF, overwrite ON: SEM ?2026, mas o overwrite ainda mata o flicker (zero \\x1b[2K)', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    stdout.write(inkFrame(3, 'a\nb\nc\n'));
    expect(writes[0].includes(BEGIN_SYNC)).toBe(false);
    expect(writes[0].includes(END_SYNC)).toBe(false);
    expect(count(writes[0], ERASE_LINE)).toBe(0); // o flicker morre SEM depender do sync.
  });

  it('UM único write ao stream real por frame (não fatia em 3)', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream);
    stdout.write(inkFrame(2, 'x\ny\n'));
    expect(writes).toHaveLength(1);
  });

  it('chunk vazio ⇒ delega cru (sem envelope, sem transform)', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream);
    stdout.write('');
    expect(writes[0]).toBe('');
  });

  it('preserva o contrato do callback do write', () => {
    const { stream } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream);
    const cb = vi.fn();
    stdout.write(inkFrame(1, 'z\n'), cb);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('delega isTTY/columns/rows intactos (o Ink precisa p/ layout)', () => {
    const { stream } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream);
    expect(stdout.isTTY).toBe(true);
    expect(stdout.columns).toBe(80);
    expect(stdout.rows).toBe(24);
  });

  it('cleanup com sync ON: emite o ESU final CRU uma vez (idempotente)', () => {
    const { stream, writes } = makeStub();
    const { cleanup } = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    cleanup();
    cleanup(); // idempotente.
    expect(writes.filter((w) => w === END_SYNC)).toHaveLength(1);
  });

  it('cleanup com sync OFF: NÃO emite ESU (não há modo sync p/ desfazer)', () => {
    const { stream, writes } = makeStub();
    const { cleanup } = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    cleanup();
    expect(writes).toHaveLength(0);
  });

  it('Static append (conteúdo puro, sem erase) ⇒ NÃO é transformado (passa cru dentro do envelope)', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    const staticLine = '▌ aluy\n  resposta consolidada\n';
    stdout.write(staticLine);
    // sem prefixo de erase ⇒ overwriteInPlace devolve cru ⇒ conteúdo intacto.
    expect(writes[0]).toBe(staticLine);
  });
});

// EST-0965 · ADR-0076 §5 — setCockpit: no MODO COCKPIT o envelope usa o transform do
// ALT-SCREEN (`cockpitOverwriteInPlace`, p/ o `clearTerminal`), em vez do do inline
// (`overwriteInPlace`, p/ o `eraseLines`). AMBOS sobrescrevem-no-lugar (ZERO branqueamento),
// só casam padrões DIFERENTES — porque o Ink emite bytes diferentes em cada superfície. É o
// que MATA o flicker do cockpit no xterm-sem-`?2026` (o #144 desligava o transform — exagero;
// a tela preta era a ORDEM do `?1049h`, já corrigida pelo #145). O `?2026` PERMANECE nas duas.
describe('setCockpit — transform do alt-screen no cockpit (mata o flicker do #144/EST-0965 (cockpit))', () => {
  it('cockpit ATIVO: o clearTerminal do Ink vira home+overwrite ⇒ ZERO \\x1b[2J (flicker morto)', () => {
    const { stream, writes } = makeStub();
    const { stdout, setCockpit } = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    setCockpit(true);
    stdout.write(cockpitFrame('a\nb\nc\n'));
    const out = writes[0];
    // CRITÉRIO OBJETIVO do DoD: zero branqueamento de tela inteira (a fonte do flicker).
    expect(count(out, ERASE_SCREEN)).toBe(0);
    expect(count(out, ERASE_SCROLLBACK)).toBe(0);
    // o frame foi sobrescrito-no-lugar: home + conteúdo + `\x1b[J`.
    expect(out.includes(CURSOR_HOME)).toBe(true);
    expect(out.includes(ERASE_TO_EOS)).toBe(true);
    // o envelope `?2026` segue valendo (atômico onde há suporte).
    expect(out.startsWith(BEGIN_SYNC)).toBe(true);
    expect(out.endsWith(END_SYNC)).toBe(true);
  });

  it('cockpit INATIVO (default/inline): overwrite do inline LIGADO (zero \\x1b[2K) — não regride #95', () => {
    const { stream, writes } = makeStub();
    const { stdout } = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    // sem setCockpit ⇒ inline default.
    stdout.write(inkFrame(3, 'a\nb\nc\n'));
    expect(count(writes[0], ERASE_LINE)).toBe(0); // overwrite do inline matou o flicker.
  });

  it('round-trip do toggle: cockpit usa o transform do alt-screen; voltar ao inline usa o do inline', () => {
    const { stream, writes } = makeStub();
    const { stdout, setCockpit } = wrapStdoutWithSync(stream, { sync: true, overwrite: true });
    setCockpit(true);
    stdout.write(cockpitFrame('x\ny\n')); // write[0]: cockpit ⇒ clearTerminal vira home.
    setCockpit(false);
    stdout.write(inkFrame(2, 'x\ny\n')); // write[1]: inline ⇒ eraseLines vira cursor-up.
    expect(count(writes[0], ERASE_SCREEN)).toBe(0); // cockpit: sem \x1b[2J (flicker morto).
    expect(count(writes[1], ERASE_LINE)).toBe(0); // inline: sem \x1b[2K (flicker morto).
  });

  it('FIX corrupção — cockpit ATIVO num frame de eraseLines (frame que encolheu < rows): É DIFFADO, NÃO cru', () => {
    // CAUSA-RAIZ da corrupção sob streaming: o cockpit ENCHE `rows` na maioria dos frames
    // (clearTerminal), MAS quando uma linha da conversa ENCOLHE o frame fica < `rows` e o Ink
    // cai no `log-update`, emitindo `eraseLines`(`\x1b[2K…`) + body. ANTES o cockpit passava
    // esse write CRU ⇒ o `eraseLines` movia o cursor RELATIVO da posição errada (fim do frame
    // anterior, no meio da tela) ⇒ sobrescrevia as linhas ERRADAS, deixando CAUDA da velha e
    // mesclando conteúdo ("ajudar!ar você hoje?"). AGORA o differ OWNS o `eraseLines` no
    // cockpit e faz o MESMO diff por-linha ABSOLUTO (CUP+`\x1b[K`) ⇒ ZERO `\x1b[2K`.
    const { stream, writes } = makeStub();
    const { stdout, setCockpit } = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    setCockpit(true);
    stdout.write(cockpitFrame('AAAA longa\nb\nc')); // assenta (clearTerminal), 3 linhas.
    stdout.write(inkFrame(3, 'curta\nb\nc')); // ENCOLHEU ⇒ log-update eraseLines; deve ser DIFFADO.
    // ZERO branqueamento de linha: o diff absoluto substitui o `\x1b[2K` relativo.
    expect(count(writes[1], ERASE_LINE)).toBe(0); // eraseLines NÃO passa mais cru — vira diff.
    // o diff reescreveu SÓ a linha 1 (a que encolheu), por CUP ABSOLUTO + `\x1b[K` (limpa a
    // cauda da "AAAA longa" ⇒ sem rabo). As linhas 'b'/'c' (iguais) NÃO foram reescritas.
    expect(writes[1].includes(`${ESC}1;1Hcurta${ERASE_TO_EOL}`)).toBe(true);
    expect(writes[1].includes('AAAA')).toBe(false); // a linha velha não vaza.
  });

  it('setCockpit é idempotente (setar o mesmo valor não muda o comportamento)', () => {
    const { stream, writes } = makeStub();
    const { stdout, setCockpit } = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    setCockpit(true);
    setCockpit(true); // 2× true — inócuo.
    stdout.write(cockpitFrame('a\nb\nc\n'));
    expect(count(writes[0], ERASE_SCREEN)).toBe(0); // segue transformado (sem \x1b[2J).
  });

  it('com overwrite GLOBALMENTE OFF, setCockpit não introduz transform (clearTerminal cru)', () => {
    const { stream, writes } = makeStub();
    const { stdout, setCockpit } = wrapStdoutWithSync(stream, { sync: false, overwrite: false });
    setCockpit(true); // cockpit, mas overwrite global off
    stdout.write(cockpitFrame('a\nb\nc\n'));
    expect(count(writes[0], ERASE_SCREEN)).toBe(1); // cru (overwrite global off ⇒ \x1b[2J intacto).
  });
});

// FIX (HUNT-RENDER) — o cursor FINAL do differ (onde o caret do composer assenta) é
// `frameEndCursor`, que avançava `col += 1` por UNIDADE UTF-16. Numa última linha com
// CJK/fullwidth (`你`, 1 unidade UTF-16 mas 2 COLUNAS) o caret assentava À ESQUERDA do real;
// com combinante (largura 0) à direita. (Emoji astral acertava por acaso: 2 unidades × 1 ≈
// 2 col.) O fix conta pela LARGURA DE EXIBIÇÃO do code point. A última linha SEM `\n` final
// é onde mora o composer (caret). O byte final do frame transformado é o reposicionamento
// `\x1b[<row>;<col>H`.
describe('cockpit — cursor final (caret) respeita a LARGURA de exibição (CJK/emoji/combinante)', () => {
  /** Extrai o ÚLTIMO `\x1b[<row>;<col>H` do write (o reposicionamento de fim de frame). */
  function finalCup(s: string): { row: number; col: number } | undefined {
    const all = [...s.matchAll(new RegExp(`${ESC.replace('[', '\\[')}(\\d+);(\\d+)H`, 'g'))];
    const m = all[all.length - 1];
    return m ? { row: Number(m[1]), col: Number(m[2]) } : undefined;
  }

  function lastLineCaret(lastLine: string): { row: number; col: number } | undefined {
    const { stream, writes } = makeStub();
    const { stdout, setCockpit } = wrapStdoutWithSync(stream, { sync: false, overwrite: true });
    setCockpit(true);
    stdout.write(cockpitFrame('header\nx')); // frame 1: pinta tudo (assenta o buffer).
    stdout.write(cockpitFrame('header\n' + lastLine)); // frame 2: diff + CUP final.
    return finalCup(writes[1]!);
  }

  it('ASCII baseline: `› hi` ⇒ caret na col 5 (4 colunas + 1)', () => {
    expect(lastLineCaret('› hi')).toEqual({ row: 2, col: 5 });
  });

  it('CJK na última linha: `› 你好` ⇒ col 7 (›=1, esp=1, 你好=4 colunas ⇒ +1)', () => {
    // ANTES do fix: col 5 (contava 你好 como 2 unidades = 2 col em vez de 4).
    expect(lastLineCaret('› 你好')).toEqual({ row: 2, col: 7 });
  });

  it('emoji astral: `abc🎉` ⇒ col 6 (abc=3, 🎉=2 colunas ⇒ +1)', () => {
    expect(lastLineCaret('abc🎉')).toEqual({ row: 2, col: 6 });
  });

  it('combinante (largura 0): `e + U+0301` (é decomposto) conta 1 coluna, não 2 ⇒ col 2', () => {
    // 'e' (1 col) + U+0301 (combining acute, 0 col) = 1 coluna ⇒ caret na col 2.
    expect(lastLineCaret('e\u0301')).toEqual({ row: 2, col: 2 });
  });
});
