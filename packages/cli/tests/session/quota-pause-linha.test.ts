// F9 — a linha estática de pausa por cota (substitui a linha de trabalho).
import { describe, expect, it } from 'vitest';
import type { QuotaPauseView } from '@hiperplano/aluy-cli-core';
import { quotaPauseLinha } from '../../src/session/quota-pause-session.js';

const NOW = new Date(2026, 10, 3, 4, 15, 0).getTime();
const base = (over: Partial<QuotaPauseView>): QuotaPauseView =>
  ({
    scope: 'janela',
    reason: 'x',
    manual: false,
    probing: false,
    agents: [],
    nextProbeAtMs: NOW + 60_000,
    deadlineAtMs: NOW + 3_600_000,
    ...over,
  }) as QuotaPauseView;

describe('quotaPauseLinha', () => {
  it('cota com horário informado: diz que tenta de novo, o limite informado e as teclas', () => {
    const l = quotaPauseLinha(base({ resetAtMs: NOW + 4 * 3600_000 + 24 * 60_000 }), NOW);
    expect(l).toBe(
      'pausado — cota esgotada · tentando de novo a cada ~5 min · limite informado: 08:39 · ↵ tentar agora · ctrl+g parar salvando',
    );
  });
  it('nunca promete "volta às" e nas larguras curtas perde o limite antes das teclas', () => {
    const v = base({ resetAtMs: NOW + 80 * 3600_000 });
    expect(quotaPauseLinha(v, NOW)).not.toContain('volta às');
    const curta = quotaPauseLinha(v, NOW, 75);
    expect(curta).toContain('↵ tentar agora');
    expect(curta).not.toContain('limite informado');
  });
  it('após uma sondagem recusada mostra o estado: ainda sem cota · última tentativa · próxima em ~N min', () => {
    const v = base({
      resetAtMs: NOW + 80 * 3600_000,
      lastProbeAtMs: NOW - 5_000,
      nextProbeAtMs: NOW + 295_000,
    });
    const l = quotaPauseLinha(v, NOW);
    expect(l).toContain('ainda sem cota · última tentativa ');
    expect(l).toContain('próxima em ~5 min');
    expect(l).toContain('↵ tentar agora');
    // a linha MUDA entre "esperando" e "recusada": é o que faz o ↵ parecer vivo
    expect(l).not.toBe(quotaPauseLinha(base({ resetAtMs: NOW + 80 * 3600_000 }), NOW));
    // terminal estreito: cabe, mantém o estado e a tecla
    const estreita = quotaPauseLinha(v, NOW, 78);
    expect(estreita.length).toBeLessThanOrEqual(78);
    expect(estreita).toContain('ainda sem cota');
    expect(estreita).toContain('↵ tentar agora');
  });
  it('saldo esgotado manda recarregar', () => {
    expect(quotaPauseLinha(base({ manual: true }), NOW)).toContain('recarregue');
  });
  it('sondando agora', () => {
    expect(quotaPauseLinha(base({ probing: true }), NOW)).toContain('verificando a cota…');
  });
  it('largura curta perde as teclas primeiro, depois o horário', () => {
    const v = base({ resetAtMs: NOW + 3600_000 });
    const l = quotaPauseLinha(v, NOW, 60);
    expect(l.length).toBeLessThanOrEqual(60);
    expect(l.startsWith('pausado')).toBe(true);
    expect(quotaPauseLinha(v, NOW, 10)).toBe('pausado — cota esgotada');
  });
});
