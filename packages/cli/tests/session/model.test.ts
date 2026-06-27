// EST-0948 — utilitários PUROS do modelo de visão da sessão.
// Cobre o gerúndio do in-flight (§2.6), a abreviação de contagem (status bar) e a
// abreviação de cwd (~/…). Pequenos, mas carregam a microcopy/formatação visível.

import { describe, expect, it } from 'vitest';
import {
  abbreviateCount,
  abbreviateCwd,
  gerundOf,
  formatElapsed,
} from '../../src/session/model.js';

describe('gerundOf — verbo no gerúndio p/ o in-flight (§2.6/§8)', () => {
  it('mapeia as tools nativas p/ o gerúndio PT-BR', () => {
    expect(gerundOf('read_file')).toBe('lendo');
    expect(gerundOf('edit_file')).toBe('editando');
    expect(gerundOf('run_command')).toBe('rodando');
    expect(gerundOf('grep')).toBe('buscando');
  });
  it('tool desconhecida cai num gerúndio genérico', () => {
    expect(gerundOf('some_mcp_tool')).toBe('processando');
  });
});

describe('abbreviateCount — ◷ tokens da status bar', () => {
  it('< 1000 mostra o número cru', () => {
    expect(abbreviateCount(0)).toBe('0');
    expect(abbreviateCount(999)).toBe('999');
  });
  it('milhares ⇒ k (sem .0 supérfluo)', () => {
    expect(abbreviateCount(12400)).toBe('12.4k');
    expect(abbreviateCount(2000)).toBe('2k');
  });
  it('milhões ⇒ M', () => {
    expect(abbreviateCount(1_200_000)).toBe('1.2M');
  });
});

describe('abbreviateCwd — ~/… na status bar', () => {
  it('troca a HOME por ~', () => {
    expect(abbreviateCwd('/home/u/proj/aluy-app', '/home/u')).toBe('~/proj/aluy-app');
  });
  it('fora da HOME fica intacto', () => {
    expect(abbreviateCwd('/etc/x', '/home/u')).toBe('/etc/x');
  });
  it('sem HOME definida não quebra', () => {
    expect(abbreviateCwd('/x/y', '')).toBe('/x/y');
  });
  it('cwd === HOME vira ~ (sem barra órfã)', () => {
    expect(abbreviateCwd('/home/u', '/home/u')).toBe('~');
  });
  it('IRMÃO prefixo-string NÃO abrevia (borda de separador, fix #332-irmã)', () => {
    // /home/user-backup NÃO está sob /home/user — não pode virar ~-backup
    expect(abbreviateCwd('/home/user-backup/p', '/home/user')).toBe('/home/user-backup/p');
    expect(abbreviateCwd('/home/userx', '/home/user')).toBe('/home/userx');
  });
});

describe('formatElapsed — relógio M:SS do indicador de atividade (EST-0965)', () => {
  it('formata segundos em M:SS com padding (o exemplo da spec: 0:12)', () => {
    expect(formatElapsed(12_000)).toBe('0:12');
    expect(formatElapsed(5_000)).toBe('0:05');
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('passa de minuto: 1:05, 12:30', () => {
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(750_000)).toBe('12:30');
  });

  it('TRUNCA os segundos (o relógio nunca pula 1s à frente do real)', () => {
    expect(formatElapsed(12_900)).toBe('0:12'); // 12.9s mostra 0:12, não 0:13
    expect(formatElapsed(59_999)).toBe('0:59');
    expect(formatElapsed(60_000)).toBe('1:00');
  });

  it('horas viram minutos acumulados (sem campo de hora)', () => {
    expect(formatElapsed(3_600_000)).toBe('60:00');
    expect(formatElapsed(4_500_000)).toBe('75:00');
  });

  it('fail-safe: negativo/NaN/Infinity ⇒ 0:00 (nunca lança)', () => {
    expect(formatElapsed(-1)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});
