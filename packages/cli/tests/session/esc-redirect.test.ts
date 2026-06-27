// ADR-0126(C) — decisão do ESC durante o turno: REDIRECIONAR (encaixa minha msg) vs PARAR.

import { describe, it, expect } from 'vitest';
import { decideEscAction } from '../../src/session/esc-redirect.js';

describe('decideEscAction', () => {
  it('composer VAZIO ⇒ stop (parada pura)', () => {
    expect(decideEscAction('')).toEqual({ kind: 'stop' });
    expect(decideEscAction('   ')).toEqual({ kind: 'stop' });
  });

  it('TEXTO normal ⇒ redirect injetando o texto', () => {
    expect(decideEscAction('muda o rumo: foca no bug X')).toEqual({
      kind: 'redirect',
      inject: 'muda o rumo: foca no bug X',
    });
  });

  it('trim do texto injetado', () => {
    expect(decideEscAction('  oi  ')).toEqual({ kind: 'redirect', inject: 'oi' });
  });

  it('`/ask <q>` ⇒ redirect injetando SÓ a pergunta (vira msg real, priorizada)', () => {
    expect(decideEscAction('/ask qual o status do deploy?')).toEqual({
      kind: 'redirect',
      inject: 'qual o status do deploy?',
    });
    // case-insensitive no prefixo
    expect(decideEscAction('/ASK e o teste?')).toEqual({ kind: 'redirect', inject: 'e o teste?' });
  });

  it('`/ask` SOZINHO (sem pergunta) ⇒ stop (nada a injetar)', () => {
    expect(decideEscAction('/ask')).toEqual({ kind: 'stop' });
    expect(decideEscAction('/ask    ')).toEqual({ kind: 'stop' });
  });

  it('outros slash NÃO são tratados como /ask (texto cru injetado — o agente vê)', () => {
    // `/foo` não casa o prefixo /ask ⇒ injeta como está (o agente recebe o texto literal).
    expect(decideEscAction('/foo bar')).toEqual({ kind: 'redirect', inject: '/foo bar' });
  });
});
