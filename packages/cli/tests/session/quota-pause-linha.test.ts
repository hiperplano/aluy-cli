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
  it('cota com horário: volta às HH:MM (em …) + teclas', () => {
    const l = quotaPauseLinha(base({ resetAtMs: NOW + 4 * 3600_000 + 24 * 60_000 }), NOW);
    expect(l).toBe(
      'pausado — cota esgotada · volta às 08:39 (em 4h 24min) · ↵ tentar agora · ctrl+g parar salvando',
    );
  });
  it('saldo esgotado manda recarregar', () => {
    expect(quotaPauseLinha(base({ manual: true }), NOW)).toContain('recarregue');
  });
  it('sondando agora', () => {
    expect(quotaPauseLinha(base({ probing: true }), NOW)).toContain('tentando retomar agora');
  });
  it('largura curta perde as teclas primeiro, depois o horário', () => {
    const v = base({ resetAtMs: NOW + 3600_000 });
    const l = quotaPauseLinha(v, NOW, 60);
    expect(l.length).toBeLessThanOrEqual(60);
    expect(l.startsWith('pausado')).toBe(true);
    expect(quotaPauseLinha(v, NOW, 10)).toBe('pausado — cota esgotada');
  });
});
