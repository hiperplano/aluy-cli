// A MENSAGEM DIGITADA DURANTE O TRABALHO NÃO PODE SUMIR.
//
// Relato do dono (04/09): "quando estou digitando e paralelamente está sendo escrito algo
// na saída, quando envio a msg ela não fica esperando, ela simplesmente some".
//
// A causa é a MESMA do ingresso do Telegram, e é a assimetria de um retorno booleano:
// `injectInput` devolve `true` tanto para "encaixei na fila VIVA" (mid-turn) quanto para
// "guardei em `pendingInjected`" (próximo turno) — e só o `submit` drena a segunda. O
// chamador (`injectIfPlainText`) trata `true` como "linha consumida" e NÃO enfileira; a UI
// de staging só mostra os ENFILEIRADOS. Resultado: a mensagem some da tela e do fluxo, sem
// nada para drená-la.
//
// A janela é estreita — a fase transiciona entre a tecla e a chamada — e é justamente por
// isso que engana: acontece quando o streaming está terminando, não sempre.
//
// Este arquivo trava a REGRA de decisão, que é pura: fora do turno vivo, `injectIfPlainText`
// tem de devolver `false` para o caller ENFILEIRAR (visível, drenado no repouso).

import { describe, expect, it, vi } from 'vitest';

/** A regra extraída do `App.tsx` — a mesma ordem de perguntas. */
function decideEncaixe(
  alvo: { turnoVivo: boolean; injectInput: (n: string, t: string) => boolean },
  texto: string,
): boolean {
  if (!alvo.turnoVivo) return false;
  return alvo.injectInput('root', texto);
}

describe('texto digitado durante o trabalho', () => {
  it('turno VIVO ⇒ encaixa (o comportamento que já funcionava)', () => {
    const injectInput = vi.fn(() => true);
    expect(decideEncaixe({ turnoVivo: true, injectInput }, 'oi')).toBe(true);
    expect(injectInput).toHaveBeenCalledWith('root', 'oi');
  });

  it('turno NÃO vivo ⇒ devolve false p/ ENFILEIRAR — nunca some', () => {
    // `injectInput` devolveria `true` (guardando em `pendingInjected`), e é exatamente
    // esse `true` que fazia a mensagem sumir: o caller não enfileirava.
    const injectInput = vi.fn(() => true);
    expect(decideEncaixe({ turnoVivo: false, injectInput }, 'oi')).toBe(false);
    expect(injectInput, 'nem tentamos guardar numa fila que ninguém drena').not.toHaveBeenCalled();
  });

  it('a decisão NÃO depende do retorno do injectInput quando não há turno', () => {
    for (const r of [true, false]) {
      const injectInput = vi.fn(() => r);
      expect(decideEncaixe({ turnoVivo: false, injectInput }, 'oi')).toBe(false);
    }
  });

  it('turno vivo mas SEM onde encaixar ⇒ false (o caller enfileira igual)', () => {
    const injectInput = vi.fn(() => false);
    expect(decideEncaixe({ turnoVivo: true, injectInput }, 'oi')).toBe(false);
  });
});

describe('GUARDA — o App consulta `turnoVivo` antes de encaixar', () => {
  // Lê o FONTE porque o caminho é de teclado dentro do `App.tsx`, excluído da cobertura:
  // nenhum teste de unidade o exercita, e foi exatamente aí que o defeito viveu.
  it('`injectIfPlainText` pergunta por `turnoVivo`', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fonte = readFileSync(join(__dirname, '..', '..', 'src', 'session', 'App.tsx'), 'utf8');
    const i = fonte.indexOf('const injectIfPlainText');
    expect(i, 'a âncora sumiu — atualize esta guarda').toBeGreaterThan(0);
    const bloco = fonte.slice(i, i + 2600);
    // Exige o CONDICIONAL, não a menção. A primeira versão desta guarda pedia só que
    // `controller.turnoVivo` aparecesse no bloco — e a mutação `void controller.turnoVivo;`
    // passava verde, porque a menção continua lá. Guarda que casa a forma MUTADA não
    // guarda nada; foi a mutação que expôs isso, não a leitura.
    expect(
      /if\s*\(\s*!\s*controller\.turnoVivo\s*\)\s*return false;/.test(bloco),
      'sem o `if (!controller.turnoVivo) return false` a mensagem volta a sumir em `pendingInjected`',
    ).toBe(true);
  });
});
