// F-RAC — o CAMINHO do raciocínio, da borda do stream até o disco.
//
// O caminho tem quatro degraus e o defeito de origem estava no TERCEIRO: o evento
// nascia no adapter, atravessava o client (medido: 15 eventos), e MORRIA no wiring,
// que encaminhava uma lista de callbacks escrita à mão. Nenhum erro, nenhum log — o
// pensamento simplesmente não existia do controller para cima.
//
// Cada teste aqui trava UM degrau. Vale a redundância: foi a AUSÊNCIA de um deles que
// deixou o defeito invisível por todo o caminho.
import { describe, expect, it } from 'vitest';
import { delegatingSink, type StreamSink } from '../../src/session/streaming-caller.js';
import { sanitizeBlocks } from '../../src/io/session-record.js';

describe('degrau 3 — o sink do wiring DELEGA todo canal, inclusive os novos', () => {
  function alvoEspiao(): { sink: StreamSink; visto: string[] } {
    const visto: string[] = [];
    return {
      visto,
      sink: {
        onStart: () => visto.push('start'),
        onDelta: (c) => visto.push('delta:' + c),
        onReasoning: (c) => visto.push('reasoning:' + c),
        onUsage: () => visto.push('usage'),
        onQuota: () => visto.push('quota'),
        onDone: () => visto.push('done'),
      },
    };
  }

  it('encaminha o RACIOCÍNIO (o canal que a lista à mão esquecia)', () => {
    const { sink, visto } = alvoEspiao();
    delegatingSink(() => sink).onReasoning?.('penso');
    expect(visto).toEqual(['reasoning:penso']);
  });

  it('encaminha os canais antigos igual a antes (não-regressão)', () => {
    const { sink, visto } = alvoEspiao();
    const d = delegatingSink(() => sink);
    d.onStart?.();
    d.onDelta('oi');
    d.onDone?.();
    expect(visto).toEqual(['start', 'delta:oi', 'done']);
  });

  it('alvo AUSENTE é no-op, nunca exceção (o controller nasce depois do caller)', () => {
    const d = delegatingSink(() => undefined);
    expect(() => {
      d.onStart?.();
      d.onDelta('x');
      d.onReasoning?.('y');
      d.onDone?.();
    }).not.toThrow();
  });

  it('resolve o alvo A CADA evento — trocar o alvo no meio passa a valer', () => {
    const a = alvoEspiao();
    const b = alvoEspiao();
    let atual: StreamSink | undefined = a.sink;
    const d = delegatingSink(() => atual);
    d.onReasoning?.('1');
    atual = b.sink;
    d.onReasoning?.('2');
    expect(a.visto).toEqual(['reasoning:1']);
    expect(b.visto).toEqual(['reasoning:2']);
  });
});

describe('degrau 4 — o raciocínio sobrevive ao save/restore da sessão', () => {
  it('o campo atravessa o sanitize (antes era descartado: só kind/text/streaming)', () => {
    const [b] = sanitizeBlocks([
      { kind: 'aluy', text: 'ok', streaming: false, reasoning: 'pensei nisto' },
    ]);
    expect(b).toEqual({ kind: 'aluy', text: 'ok', streaming: false, reasoning: 'pensei nisto' });
  });

  it('bloco SEM raciocínio não ganha o campo (não-regressão do formato antigo)', () => {
    const [b] = sanitizeBlocks([{ kind: 'aluy', text: 'ok', streaming: false }]);
    expect(b).toEqual({ kind: 'aluy', text: 'ok', streaming: false });
    expect('reasoning' in (b as object)).toBe(false);
  });

  it('raciocínio vazio ou de tipo errado é descartado, não propagado', () => {
    const blocos = sanitizeBlocks([
      { kind: 'aluy', text: 'a', streaming: false, reasoning: '' },
      { kind: 'aluy', text: 'b', streaming: false, reasoning: 42 },
    ]);
    for (const b of blocos) expect('reasoning' in (b as object)).toBe(false);
  });
});
