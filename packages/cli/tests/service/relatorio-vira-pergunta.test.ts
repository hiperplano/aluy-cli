// RELATÓRIO-VIRA-PERGUNTA (dogfooding real) — o serviço do dono ficou `AGUARDANDO DONO`
// sobre um turno que tinha CONCLUÍDO. O `aluy service status` mostrava como "pergunta
// pendente" a saída INTEIRA da atividade: ~4 mil caracteres de análise quantitativa
// (setups de USDBRL/IBOV/BTC com entrada, stop, alvo e R:R), abertos literalmente por
// `"status": "completed", "exitCode": 0`. Ninguém perguntou nada — e o expediente parou.
//
// A causa é reúso de heurística ENTRE CONTEXTOS COM CUSTOS DIFERENTES. `awaitsUserDecision`
// nasceu p/ o gate do SELF-CHECK, e o comentário dela diz, com todas as letras, que "a
// heurística pode ser generosa" porque "um falso POSITIVO só faz o loop aceitar a resposta
// como final". Inofensivo lá. Aqui, o mesmo falso positivo PARA UM SERVIÇO 24/7 por tempo
// indeterminado — e, sem `channel:` declarado, para em silêncio.
//
// O serviço passa a ter o SEU critério (mais estrito), sem tocar no do self-check.

import { describe, expect, it } from 'vitest';
import { servicoAguardaDono } from '../../src/service/runner.js';
import { awaitsUserDecision } from '@hiperplano/aluy-cli-core';

/** O formato que travou o serviço: relatório longo, com cauda de recomendações. */
const RELATORIO_DO_DONO = `"status": "completed", "exitCode": 0, "output": "# Análise Quantitativa — Setups Técnicos

## USDBRL=X
Preço atual ~5,57, RSI ~42, MACD levemente negativo. Suporte 5,45; resistência 5,72.
${'Linha de detalhe técnico com números e contexto de mercado.\n'.repeat(60)}
## Notas finais
Setup fica CONDICIONADO ao IPCA-15: se vier acima do consenso, ABANDONAR a tese.
Recomendação: tamanho reduzido. Me avise se o cenário mudar.`;

describe('servicoAguardaDono — relatório NÃO é pergunta', () => {
  it('o relatório que travou o serviço do dono NÃO segura mais o expediente', () => {
    expect(RELATORIO_DO_DONO.length).toBeGreaterThan(1500);
    expect(servicoAguardaDono(RELATORIO_DO_DONO)).toBe(false);
  });

  it('e o heurístico do SELF-CHECK segue generoso — não mexemos nele', () => {
    // Prova que os dois critérios divergem DE PROPÓSITO: o mesmo texto que o serviço
    // agora ignora continua sendo "espera o usuário" para o self-check, onde isso é
    // inofensivo. Se um dia alguém unificar os dois, este teste cai.
    expect(awaitsUserDecision(RELATORIO_DO_DONO)).toBe(true);
  });

  it('pergunta CURTA de verdade continua segurando o turno', () => {
    expect(servicoAguardaDono('Achei duas contas de corretora. Qual delas devo usar?')).toBe(true);
  });

  it('pedido de autorização sem "?" também conta', () => {
    expect(servicoAguardaDono('O próximo passo apaga os resultados antigos. Confirma?')).toBe(true);
    expect(servicoAguardaDono('Posso aplicar a migração no banco de produção?')).toBe(true);
  });

  it('a pergunta tem que estar na ÚLTIMA linha — não perdida no meio', () => {
    // Num relatório, a pergunta retórica do meio não é um pedido de decisão.
    const comPerguntaNoMeio = [
      'Rodei o backtest dos 3 setups.',
      'Por que o USDBRL falhou? Porque o stop ficou dentro do ruído de 1 ATR.',
      'Resultado: 2 aprovados, 1 rejeitado.',
    ].join('\n');
    expect(servicoAguardaDono(comPerguntaNoMeio)).toBe(false);
  });

  it('texto vazio/branco nunca trava o serviço', () => {
    expect(servicoAguardaDono('')).toBe(false);
    expect(servicoAguardaDono('   \n  \n ')).toBe(false);
  });

  it('relatório CURTO terminando em conclusão segue em frente', () => {
    expect(servicoAguardaDono('Turno concluído: 3 setups registrados, 1 rejeitado.')).toBe(false);
  });

  it('pergunta longa demais NÃO trava — na dúvida, o serviço SEGUE', () => {
    // Direção do erro invertida de propósito: preferimos seguir o workflow a travá-lo.
    // Quem precisa mesmo de decisão tem a tool `perguntar` — sinal explícito, não prosa.
    const longa = `${'contexto e mais contexto do mercado de hoje. '.repeat(80)}\nPosso seguir?`;
    expect(longa.length).toBeGreaterThan(1500);
    expect(servicoAguardaDono(longa)).toBe(false);
  });
});
