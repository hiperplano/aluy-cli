// O DESVIO no sink: quando o agente fez uma pergunta POR ESTE CANAL, a mensagem que volta é
// a RESPOSTA dela — não uma instrução nova.
//
// Sem o desvio (comportamento até 02/09) a mensagem caía no `injectInput` logo abaixo: o
// `perguntar` deixa o turno VIVO enquanto espera, então ela entrava como texto solto do
// turno e a promessa da pergunta seguia pendurada — e o resolver NÃO tem prazo por tempo,
// de propósito. O dono ficava esperando uma resposta que nunca viria, e o agente também.
//
// O sink é fino de propósito: quem sabe LER a resposta é o controller (`pergunta-no-canal`).
// Aqui só se trava a PRECEDÊNCIA — o desvio vem ANTES do `injectInput`/`submit`.

import { describe, expect, it, vi } from 'vitest';
import { criarSinkTelegram } from '../../src/connector/telegram-sink.js';

/** Dublê do controller. `consome` é o que `responderPeloCanal` devolve. */
function alvo(consome: boolean, turnoVivo = true) {
  return {
    turnoVivo,
    injectInput: vi.fn(() => true),
    ingestExternalData: vi.fn(),
    submit: vi.fn(async () => {}),
    responderPeloCanal: vi.fn(() => consome),
  };
}

describe('resposta de pergunta pendente NÃO vira instrução', () => {
  it('com pergunta pendente: a mensagem vai para a pergunta, e só para ela', () => {
    const a = alvo(true);
    criarSinkTelegram(() => a).injectInstruction('2');
    expect(a.responderPeloCanal).toHaveBeenCalledWith('2');
    expect(a.injectInput, 'não pode virar texto solto do turno').not.toHaveBeenCalled();
    expect(a.submit, 'nem abrir um turno novo por cima do loop parado').not.toHaveBeenCalled();
    expect(a.ingestExternalData).not.toHaveBeenCalled();
  });

  it('o desvio vem ANTES do encaixe — mesmo com turno VIVO, que é o caso real', () => {
    // A pergunta só existe DENTRO de um turno, então `turnoVivo` é sempre true aqui: se a
    // ordem fosse a inversa, o desvio nunca rodaria.
    const a = alvo(true, true);
    criarSinkTelegram(() => a).injectInstruction('1');
    expect(a.injectInput).not.toHaveBeenCalled();
  });

  it('sem pergunta pendente: caminho de sempre (encaixa no turno vivo)', () => {
    const a = alvo(false, true);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.responderPeloCanal).toHaveBeenCalledTimes(1);
    expect(a.injectInput).toHaveBeenCalledWith('root', 'ola');
  });

  it('sem pergunta pendente e sem turno: abre turno novo, como antes', () => {
    const a = alvo(false, false);
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.submit).toHaveBeenCalledTimes(1);
    expect(a.submit.mock.calls[0]?.[0]).toBe('ola');
  });

  it('alvo SEM a porta (versão antiga do controller) segue funcionando', () => {
    const a = {
      turnoVivo: false,
      injectInput: vi.fn(() => false),
      ingestExternalData: vi.fn(),
      submit: vi.fn(async () => {}),
    };
    criarSinkTelegram(() => a).injectInstruction('ola');
    expect(a.submit).toHaveBeenCalledTimes(1);
  });

  it('registra o desvio no diário — senão a mensagem "some" sem rastro de novo', () => {
    const linhas: string[] = [];
    criarSinkTelegram(
      () => alvo(true),
      (l) => linhas.push(l),
    ).injectInstruction('2');
    expect(linhas.join('\n')).toContain('PERGUNTA');
  });
});
