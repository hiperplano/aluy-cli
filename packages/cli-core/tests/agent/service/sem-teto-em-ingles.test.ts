// SEM-TETO-EM-INGLÊS (dogfooding real — custou meio pregão) — a CHAVE do campo é inglês
// (`activity-timeout`) e o único valor aceito era PORTUGUÊS (`sem-teto`). O dono escreveu
//
//     activity-timeout: unlimited
//
// que é exatamente o que a chave induz a escrever. O valor caiu no `parseDuration`,
// virou `undefined`, e o caller usou o default de 30 minutos EM SILÊNCIO — sem aviso no
// log, sem aparecer em "campos ignorados", sem sair no `service status`.
//
// O efeito não foi cosmético. A vigília do serviço de execução bloqueia até um horário do
// relógio (~40min por janela); estourou o teto de 1800s que não deveria existir; o turno
// encerrou em `limit`; e o runner derrubou os 10 daemons junto. A mesa fechou às 14:21
// num pregão que ia até 17:40, e ninguém percebeu por 25 minutos.
//
// Duas travas aqui: as duas grafias valem, e valor não entendido FALA.

import { describe, expect, it } from 'vitest';
import {
  parseServiceActivityTimeout,
  avisoActivityTimeout,
} from '../../../src/agent/service/service-activity-timeout.js';

describe('activity-timeout — as duas línguas valem', () => {
  it('`unlimited` funciona: é o que a chave em inglês induz a escrever', () => {
    expect(parseServiceActivityTimeout('unlimited')).toBe('unlimited');
  });

  it('`sem-teto` continua valendo — nada quebrou para quem já usava', () => {
    expect(parseServiceActivityTimeout('sem-teto')).toBe('unlimited');
  });

  it('`none` e `off` também — são as outras formas naturais de escrever "sem teto"', () => {
    expect(parseServiceActivityTimeout('none')).toBe('unlimited');
    expect(parseServiceActivityTimeout('off')).toBe('unlimited');
  });

  it('case e espaço não atrapalham', () => {
    expect(parseServiceActivityTimeout('  UNLIMITED  ')).toBe('unlimited');
    expect(parseServiceActivityTimeout('Sem-Teto')).toBe('unlimited');
  });

  it('duração continua sendo duração', () => {
    expect(parseServiceActivityTimeout('45m')).toBe(45 * 60_000);
    expect(parseServiceActivityTimeout('2h')).toBe(2 * 3_600_000);
    expect(parseServiceActivityTimeout('90')).toBe(90_000);
  });
});

describe('activity-timeout — valor não entendido FALA', () => {
  it('o caso real: um valor inválido gera aviso citando o que foi escrito', () => {
    const aviso = avisoActivityTimeout('ilimitado');
    expect(aviso).toBeDefined();
    expect(aviso).toContain('ilimitado'); // ecoa o que o dono escreveu
    expect(aviso).toContain('30min'); // diz o que vai acontecer no lugar
  });

  it('o aviso ENSINA a grafia certa — senão o dono tenta de novo no escuro', () => {
    const aviso = avisoActivityTimeout('para sempre')!;
    expect(aviso).toContain('45m');
    expect(aviso).toContain('unlimited');
    expect(aviso).toContain('sem-teto');
  });

  it('valor VÁLIDO não gera aviso — nada de ruído no caminho feliz', () => {
    for (const bom of ['45m', '2h', '90', 'sem-teto', 'unlimited', 'none', 'off']) {
      expect(avisoActivityTimeout(bom)).toBeUndefined();
    }
  });

  it('campo ausente ou vazio não gera aviso — quem não declarou não errou', () => {
    expect(avisoActivityTimeout(undefined)).toBeUndefined();
    expect(avisoActivityTimeout('')).toBeUndefined();
    expect(avisoActivityTimeout('   ')).toBeUndefined();
  });

  it('parser e aviso concordam: só avisa quando o parser não entendeu', () => {
    // Trava a invariante que liga os dois — se um mudar sem o outro, isto cai.
    for (const v of ['45m', 'unlimited', 'lixo', '', 'sem-teto', '3x']) {
      const entendeu = parseServiceActivityTimeout(v) !== undefined;
      const avisou = avisoActivityTimeout(v) !== undefined;
      expect(avisou).toBe(!entendeu && v.trim() !== '');
    }
  });
});
