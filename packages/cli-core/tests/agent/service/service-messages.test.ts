import { describe, it, expect } from 'vitest';
import {
  formatServiceTurnReport,
  formatServiceFailureAlert,
  formatServiceAskMessage,
  formatServiceResumeInstruction,
  formatServiceAskTimeoutAlert,
  formatElapsedSince,
  hasAskTimedOut,
  DEFAULT_ASK_TIMEOUT_MS,
} from '@hiperplano/aluy-cli-core';

describe('formatServiceTurnReport (ADR-0158 §8.2)', () => {
  it('turno OK — menciona conclusão + resumo', () => {
    const text = formatServiceTurnReport({
      serviceName: 'trader',
      ok: true,
      critical: false,
      summary: '3/3 atividades concluídas.',
    });
    expect(text).toContain('trader');
    expect(text).toContain('concluído');
    expect(text).toContain('3/3 atividades concluídas.');
  });

  it('turno parado por motivo neutro — "encerrado", não "concluído"', () => {
    const text = formatServiceTurnReport({
      serviceName: 'trader',
      ok: false,
      critical: false,
      summary: 'parou em 2/3 atividades (limit).',
    });
    expect(text).toContain('encerrado');
  });
});

describe('formatServiceFailureAlert (ADR-0158 §8.1)', () => {
  it('inclui o nome do serviço e o motivo, com marcador de alerta', () => {
    const text = formatServiceFailureAlert('trader', 'manifesto inválido pós-edição — X');
    expect(text).toContain('trader');
    expect(text).toContain('ALERTA');
    expect(text).toContain('manifesto inválido pós-edição — X');
  });
});

describe('ASK-ESPERA (ADR-0158 §5 pt.4)', () => {
  it('formatServiceAskMessage inclui a pergunta e instrui a responder', () => {
    const text = formatServiceAskMessage('trader', 'Aumento a posição em EURUSD?');
    expect(text).toContain('trader');
    expect(text).toContain('Aumento a posição em EURUSD?');
  });

  it('formatServiceResumeInstruction junta pergunta+resposta', () => {
    const text = formatServiceResumeInstruction('Aumento a posição?', 'Sim, até 3.');
    expect(text).toContain('Aumento a posição?');
    expect(text).toContain('Sim, até 3.');
  });

  it('formatServiceAskTimeoutAlert relata quantas horas esperou', () => {
    const text = formatServiceAskTimeoutAlert('trader', 'Aumento a posição?', 24 * 60 * 60_000);
    expect(text).toContain('trader');
    expect(text).toContain('24h');
    expect(text).toContain('Aumento a posição?');
  });

  it('DEFAULT_ASK_TIMEOUT_MS é 24h', () => {
    expect(DEFAULT_ASK_TIMEOUT_MS).toBe(24 * 60 * 60_000);
  });

  it('hasAskTimedOut: false antes do prazo, true no/após o prazo', () => {
    const start = 1_000_000;
    expect(hasAskTimedOut(start, start + DEFAULT_ASK_TIMEOUT_MS - 1)).toBe(false);
    expect(hasAskTimedOut(start, start + DEFAULT_ASK_TIMEOUT_MS)).toBe(true);
    expect(hasAskTimedOut(start, start + DEFAULT_ASK_TIMEOUT_MS + 1)).toBe(true);
  });

  it('hasAskTimedOut aceita timeout customizado (injetável, sem novo campo de frontmatter)', () => {
    expect(hasAskTimedOut(0, 5_000, 10_000)).toBe(false);
    expect(hasAskTimedOut(0, 10_000, 10_000)).toBe(true);
  });
});

describe('formatElapsedSince', () => {
  it('minutos', () => {
    expect(formatElapsedSince(5 * 60_000)).toBe('5min');
  });
  it('horas', () => {
    expect(formatElapsedSince(3 * 3_600_000)).toBe('3h');
  });
  it('dias', () => {
    expect(formatElapsedSince(2 * 86_400_000)).toBe('2d');
  });
  it('negativo (relógio) ⇒ trata como 0', () => {
    expect(formatElapsedSince(-10)).toBe('0min');
  });
});
