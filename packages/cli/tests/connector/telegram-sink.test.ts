// ADR-0154 — o SINK do ingresso do Telegram.
//
// O defeito que estes testes travam (dono, 01/09): ponte ATIVA, 1 chat autorizado, `0
// sessão` de tokens — sessão recém-aberta em que ele nunca digitou nada. Mandou "ola" e
// não aconteceu NADA.
//
// A mensagem chegava e a malha classificava CERTO — medido na cadeia real (getUpdates cru
// → parseGetUpdates → telegramUpdateToIncoming → classifyConnectorIngress devolveu
// `{kind:'instruction', text:'ola'}`). Ela morria no sink: `injectInput` começa com
// `if (!this.flowTree) return false`, a `flowTree` só nasce em `beginTurn()`, e o retorno
// era DESCARTADO — o sumiço era mudo.
//
// A assimetria que denunciou: `injectData` usa a `monitorQueue`, que acorda a sessão
// parada. Mensagem de TERCEIRO entrava; a do DONO, não. É por isso que o caso "sem turno
// aberto ⇒ submit" é o coração deste arquivo.

import { describe, expect, it, vi } from 'vitest';
import { criarSinkTelegram } from '../../src/connector/telegram-sink.js';

/** Dublê do controller. `encaixa` decide o que `injectInput` devolve. */
function alvo(encaixa: boolean, turnoVivo = encaixa) {
  return {
    turnoVivo,
    injectInput: vi.fn(() => encaixa),
    ingestExternalData: vi.fn(),
    submit: vi.fn(async () => {}),
  };
}

describe('injectInstruction — a instrução do DONO nunca pode sumir', () => {
  it('SEM turno aberto ⇒ ABRE um com submit (o defeito literal do relato)', () => {
    const a = alvo(false); // sem turno vivo e sem onde encaixar
    criarSinkTelegram(() => a).injectInstruction('ola');
    // Não tentamos mais ENCAIXAR fora do turno vivo: `injectInput` devolveria `true`
    // apenas GUARDANDO (`pendingInjected`), e só o `submit` drena essa fila. Tentar e
    // ignorar o resultado foi o que fez a mensagem do dono sumir em 01/09.
    expect(a.injectInput).not.toHaveBeenCalled();
    expect(a.submit).toHaveBeenCalledTimes(1);
    expect(a.submit.mock.calls[0]?.[0], 'a mensagem tem de virar um turno').toBe('ola');
  });

  it('marca a ORIGEM no turno — a transcrição distingue Telegram de digitado', () => {
    const a = alvo(false);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.submit.mock.calls[0]?.[2]).toEqual({ origem: 'telegram' });
  });

  it('AVISA o agente POR ONDE responder — sem isso ele responde só no terminal', () => {
    // Pergunta do dono (01/09): "ele recebeu, mas não respondeu no canal, como ele sabe
    // quando tem que responder a msg via telegram?". Não sabia: a tool existia e nada
    // dizia que o turno veio de lá.
    const a = alvo(false);
    criarSinkTelegram(() => a).injectInstruction('ola');
    const anexos = a.submit.mock.calls[0]?.[1] as { role: string; text: string }[] | undefined;
    expect(anexos, 'o submit tem de levar a dica de canal').toHaveLength(1);
    expect(anexos?.[0]?.role, 'a dica é DADO, não instrução').toBe('observation');
    expect(anexos?.[0]?.text).toContain('telegram_send');
    expect(anexos?.[0]?.text).toContain('TELEGRAM');
  });

  it('COM turno vivo a dica entra pelo canal de dado (não pelo submit)', () => {
    const a = alvo(true);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.submit).not.toHaveBeenCalled();
    expect(a.ingestExternalData).toHaveBeenCalledTimes(1);
    expect(a.ingestExternalData.mock.calls[0]?.[1]).toContain('telegram_send');
  });

  it('COM turno aberto ⇒ ENCAIXA e NÃO abre turno novo (sem gasto dobrado)', () => {
    const a = alvo(true);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.injectInput).toHaveBeenCalledWith('root', 'ola');
    expect(a.submit).not.toHaveBeenCalled();
  });

  it('o TEXTO do dono nunca vai pelo canal de DADO (a proveniência não se mistura)', () => {
    // A dica de canal PODE ir por lá (é texto NOSSO); a mensagem dele, não — ela é
    // instrução do dono e tem de entrar pelo canal `user`.
    const a = alvo(false);
    criarSinkTelegram(() => a).injectInstruction('ola');
    for (const c of a.ingestExternalData.mock.calls) expect(c[1]).not.toBe('ola');
  });

  it('sem controller ainda (ref deferida) ⇒ no-op, sem lançar', () => {
    const sink = criarSinkTelegram(() => undefined);
    expect(() => sink.injectInstruction('ola')).not.toThrow();
  });

  it('a ref é lida A CADA mensagem — o controller chega DEPOIS da ponte', () => {
    // Portador mutável em vez de `let`: espelha a ref DEFERIDA real do `run.tsx` (o
    // controller só existe depois do build, e a ponte é construída antes).
    const ref: { atual?: ReturnType<typeof alvo> } = {};
    const sink = criarSinkTelegram(() => ref.atual);
    sink.injectInstruction('cedo demais'); // ainda sem controller ⇒ no-op
    ref.atual = alvo(false);
    sink.injectInstruction('agora vai');
    expect(ref.atual.submit).toHaveBeenCalledTimes(1);
    // Só o OBJETIVO é comparado: o submit também leva a dica de canal e a origem.
    expect(ref.atual.submit.mock.calls[0]?.[0]).toBe('agora vai');
  });
});

describe('injectData — o caminho que já funcionava não regride', () => {
  it('DADO vai pelo canal de observação, nunca por submit nem injectInput', () => {
    const a = alvo(false);
    criarSinkTelegram(() => a).injectData('telegram', 'texto de terceiro');
    expect(a.ingestExternalData).toHaveBeenCalledWith('telegram', 'texto de terceiro');
    expect(a.submit, 'dado de terceiro NÃO abre turno').not.toHaveBeenCalled();
    expect(a.injectInput).not.toHaveBeenCalled();
  });

  it('sem controller ⇒ no-op, sem lançar', () => {
    expect(() => criarSinkTelegram(() => undefined).injectData('t', 'x')).not.toThrow();
  });
});

describe('mensagem GUARDADA para o próximo turno não pode se perder', () => {
  // O defeito real (dono, 01/09, com a rc.160 já instalada): ele mandava mensagem atrás de
  // mensagem e o agente acordava dizendo "canal externo notificou que há uma sessão ativa,
  // mas não há uma mensagem do usuário com conteúdo específico... favor reenviar".
  //
  // Causa: `injectInput` devolve `true` em DOIS casos — "encaixei no turno vivo" e
  // "guardei para o PRÓXIMO turno" (`pendingInjected`, drenado só pelo `submit`). O sink
  // tratava os dois como iguais: no segundo, a mensagem ficava guardada enquanto a DICA de
  // canal acordava a sessão pelo monitor, e o turno nascia com a dica e sem a mensagem.

  it('SEM turno vivo (mas com flowTree) ⇒ submit, NÃO injectInput', async () => {
    // `encaixa=true` simula o `injectInput` que devolveria true (guardaria); `turnoVivo`
    // FALSO é o que agora decide. Antes, isto entrava no ramo do encaixe e sumia.
    const a = alvo(true, false);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.injectInput, 'não pode GUARDAR: o submit é quem entrega').not.toHaveBeenCalled();
    expect(a.submit.mock.calls[0]?.[0]).toBe('ola');
  });

  it('SEM turno vivo, a dica NÃO acorda a sessão sozinha (ela viaja no submit)', async () => {
    const a = alvo(true, false);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(
      a.ingestExternalData,
      'acordar o monitor sem a mensagem foi o defeito',
    ).not.toHaveBeenCalled();
    const anexos = a.submit.mock.calls[0]?.[1] as { text: string }[] | undefined;
    expect(anexos?.[0]?.text).toContain('telegram_send');
  });

  it('COM turno vivo segue encaixando (o caminho que funcionava não regride)', async () => {
    const a = alvo(true, true);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.injectInput).toHaveBeenCalledWith('root', 'ola');
    expect(a.submit).not.toHaveBeenCalled();
    expect(a.ingestExternalData).toHaveBeenCalledTimes(1);
  });
});
