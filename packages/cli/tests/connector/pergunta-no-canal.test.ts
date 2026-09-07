// A metade PURA do conserto de 02/09: "quando ele quer tirar uma dúvida, se a pergunta é
// do telegram ele não pode enviar no console pois o usuário não vai ver".
//
// Dois contratos, e o segundo é o que a suíte não tinha como pegar antes: a resposta que
// volta pelo celular precisa CASAR com a pergunta pendente. Enquanto ela não casava, a
// mensagem do dono entrava como texto solto do turno e a promessa do `perguntar` seguia
// pendurada para sempre (o resolver não tem timeout, de propósito).

import { describe, expect, it } from 'vitest';
import type { QuestionSpec } from '@hiperplano/aluy-cli-core';
import {
  ehDesistencia,
  interpretarResposta,
  textoDaPergunta,
  textoDeAprovacaoPendente,
  textoDeNaoEntendi,
  MAX_EFEITO_NO_CANAL,
  PALAVRAS_DE_DESISTENCIA,
} from '../../src/connector/pergunta-no-canal.js';

const SINGLE: QuestionSpec = {
  kind: 'single',
  header: 'Escolha da stack',
  question: 'Qual banco usar?',
  options: [{ label: 'Postgres', description: 'relacional' }, { label: 'SQLite' }],
  allowOther: true,
};

const MULTI: QuestionSpec = {
  kind: 'multi',
  question: 'Quais rodar?',
  options: [{ label: 'lint' }, { label: 'build' }, { label: 'testes' }],
  allowOther: true,
};

const TEXTO: QuestionSpec = { kind: 'text', question: 'Qual o nome do projeto?' };

const FECHADA: QuestionSpec = {
  kind: 'single',
  question: 'Apago o diretório?',
  options: [{ label: 'Sim' }, { label: 'Não' }],
  allowOther: false,
};

describe('textoDaPergunta — a pergunta como ela chega no celular', () => {
  it('leva a pergunta, o cabeçalho e as opções NUMERADAS', () => {
    const t = textoDaPergunta(SINGLE);
    expect(t).toContain('Escolha da stack');
    expect(t).toContain('Qual banco usar?');
    expect(t).toContain('1. Postgres');
    expect(t).toContain('2. SQLite');
  });

  it('leva a DESCRIÇÃO da opção — no terminal ela é visível, aqui só o texto sobra', () => {
    expect(textoDaPergunta(SINGLE)).toContain('relacional');
  });

  it('ENSINA o formato: sem o desenho da caixa, sobra a instrução', () => {
    expect(textoDaPergunta(SINGLE)).toContain('NÚMERO');
    expect(textoDaPergunta(MULTI)).toContain('vírgula');
  });

  it('sempre oferece a saída de desistir — no terminal é o `esc`, aqui é a palavra', () => {
    for (const spec of [SINGLE, MULTI, TEXTO, FECHADA]) {
      expect(textoDaPergunta(spec)).toContain(PALAVRAS_DE_DESISTENCIA[0]!);
    }
  });

  it('só oferece resposta livre quando a pergunta admite ("Outro")', () => {
    expect(textoDaPergunta(SINGLE)).toContain('sua própria resposta');
    expect(textoDaPergunta(FECHADA)).not.toContain('sua própria resposta');
  });

  it('kind text não inventa lista de opções', () => {
    const t = textoDaPergunta(TEXTO);
    expect(t).toContain('Qual o nome do projeto?');
    expect(t).not.toContain('1.');
  });
});

describe('interpretarResposta — o número que volta é a escolha', () => {
  it('single por NÚMERO ⇒ a opção correspondente (índice 0-based, como a TUI)', () => {
    expect(interpretarResposta(SINGLE, '2')).toEqual({
      kind: 'choice',
      index: 1,
      label: 'SQLite',
    });
  });

  it('tolera espaço em volta (o teclado do celular acrescenta)', () => {
    expect(interpretarResposta(SINGLE, ' 1 ')).toEqual({
      kind: 'choice',
      index: 0,
      label: 'Postgres',
    });
  });

  it('single pelo RÓTULO, sem acento e sem caixa — ele escreve, não conta', () => {
    expect(interpretarResposta(SINGLE, 'postgres')).toEqual({
      kind: 'choice',
      index: 0,
      label: 'Postgres',
    });
  });

  it('multi aceita vários números, ordenados e sem repetição', () => {
    expect(interpretarResposta(MULTI, '3, 1, 1')).toEqual({
      kind: 'choices',
      indices: [0, 2],
      labels: ['lint', 'testes'],
    });
  });

  it('multi aceita separador por espaço e por ponto-e-vírgula', () => {
    expect(interpretarResposta(MULTI, '1 2')).toMatchObject({ indices: [0, 1] });
    expect(interpretarResposta(MULTI, '1;2')).toMatchObject({ indices: [0, 1] });
  });

  it('kind text devolve o texto inteiro, tal como escrito', () => {
    expect(interpretarResposta(TEXTO, 'Aluy CLI')).toEqual({ kind: 'text', text: 'Aluy CLI' });
  });

  it('resposta escrita à mão numa single vira `text` — o mesmo que o "Outro" da TUI', () => {
    expect(interpretarResposta(SINGLE, 'na verdade, prefiro MySQL')).toEqual({
      kind: 'text',
      text: 'na verdade, prefiro MySQL',
    });
  });

  it('desistir resolve `unavailable` — o equivalente ao `esc`, para o agente SEGUIR', () => {
    for (const palavra of PALAVRAS_DE_DESISTENCIA) {
      expect(interpretarResposta(SINGLE, palavra)).toMatchObject({ kind: 'unavailable' });
    }
    expect(interpretarResposta(FECHADA, 'CANCELAR')).toMatchObject({ kind: 'unavailable' });
  });

  it('número FORA DA FAIXA não vira texto — quem digita "5" quis a 5ª opção', () => {
    // Sem isto, `interpretarResposta(SINGLE, '5')` entregaria ao agente a resposta
    // literal "5" como se o dono tivesse escrito isso. Ele nunca escreveu.
    expect(interpretarResposta(SINGLE, '5')).toBeUndefined();
    expect(interpretarResposta(MULTI, '1,9')).toBeUndefined();
  });

  it('single com DOIS números é ambígua — pede de novo em vez de chutar o primeiro', () => {
    expect(interpretarResposta(SINGLE, '1,2')).toBeUndefined();
  });

  it('pergunta FECHADA (allowOther:false) recusa texto livre em vez de forjar escolha', () => {
    expect(interpretarResposta(FECHADA, 'talvez')).toBeUndefined();
    expect(interpretarResposta(FECHADA, '2')).toEqual({ kind: 'choice', index: 1, label: 'Não' });
  });

  it('mensagem vazia não resolve nada', () => {
    expect(interpretarResposta(SINGLE, '   ')).toBeUndefined();
  });
});

describe('textoDeNaoEntendi — a pergunta CONTINUA pendente', () => {
  it('diz a faixa válida e REAPRESENTA a pergunta (ele não tem a tela para reler)', () => {
    const t = textoDeNaoEntendi(SINGLE);
    expect(t).toContain('1 a 2');
    expect(t).toContain('Qual banco usar?');
    expect(t).toContain('1. Postgres');
  });
});

describe('textoDeAprovacaoPendente — a catraca parou o turno', () => {
  const pedido = {
    call: { name: 'run_command', input: {} },
    effect: { kind: 'command' as const, tool: 'run_command', exact: '$ rm -rf /tmp/alvo' },
    category: 'command' as const,
    reason: 'comando de shell',
    alwaysAsk: true,
  };

  it('leva o efeito EXATO — é isso que se aprova, nunca um resumo (CLI-SEC-9)', () => {
    expect(textoDeAprovacaoPendente(pedido)).toContain('$ rm -rf /tmp/alvo');
  });

  it('diz que aprovar é no terminal e oferece só a NEGATIVA por aqui', () => {
    const t = textoDeAprovacaoPendente(pedido);
    expect(t).toContain('terminal');
    expect(t).toContain(PALAVRAS_DE_DESISTENCIA[0]!);
  });

  it('CORTA um efeito gigante — o Telegram trunca em ~4096 e cortaria calado', () => {
    // Um diff grande chegaria mutilado SEM aviso, e o dono aprovaria de memória o que não
    // leu. Cortamos nós, dizendo que cortamos e para onde ir ver o resto.
    // 'Z' não aparece em nenhum literal do módulo — dá para CONTAR quanto do efeito passou.
    const gigante = { ...pedido, effect: { ...pedido.effect, exact: 'Z'.repeat(9_000) } };
    const t = textoDeAprovacaoPendente(gigante);
    expect(t.length, 'tem de caber numa mensagem do Telegram').toBeLessThan(4_096);
    expect(t).toContain('cortado');
    expect(t).toContain('terminal');
    expect(t.split('Z').length - 1).toBe(MAX_EFEITO_NO_CANAL);
  });
});

describe('ehDesistencia', () => {
  it('reconhece as palavras de desistência, sem caixa e sem acento', () => {
    expect(ehDesistencia('Cancelar')).toBe(true);
    expect(ehDesistencia('  CANCELA ')).toBe(true);
    expect(ehDesistencia('pode mandar')).toBe(false);
  });
});
