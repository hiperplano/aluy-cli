// ADR-0158 §5/§11 — FORMATADOR `buildServicesNote` (fase 1: SEM runner, estado
// sempre "parado"). Bateria: válidos com nome/estado/schedule/descrição,
// rejeitados com motivo, e o estado VAZIO.

import { describe, expect, it } from 'vitest';
import { buildServicesNote, type ServiceManifest } from '../../../src/index.js';

function manifest(over: Partial<ServiceManifest> & Pick<ServiceManifest, 'name'>): ServiceManifest {
  return { tunables: [], orchestrator: 'Rege, não opera.', ...over };
}

function text(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('buildServicesNote — válidos', () => {
  it('mostra nome, estado FIXO "parado" (fase 1), próximo schedule e descrição', () => {
    const note = buildServicesNote({
      services: [
        {
          name: 'trader',
          manifest: manifest({
            name: 'trader',
            description: 'Opera contas MT5 no intradiário',
            schedule: '0 9 * * 1-5',
          }),
        },
      ],
      errors: [],
    });
    expect(note.title).toBe('service');
    const t = text(note.lines);
    expect(t).toContain('✓ trader');
    expect(t).toContain('parado');
    expect(t).toContain('0 9 * * 1-5');
    expect(t).toContain('Opera contas MT5 no intradiário');
  });

  it('sem schedule ⇒ "sem schedule"', () => {
    const note = buildServicesNote({
      services: [{ name: 'pesquisador', manifest: manifest({ name: 'pesquisador' }) }],
      errors: [],
    });
    expect(text(note.lines)).toContain('sem schedule');
  });

  it('ordena por nome', () => {
    const note = buildServicesNote({
      services: [
        { name: 'zebra', manifest: manifest({ name: 'zebra' }) },
        { name: 'alfa', manifest: manifest({ name: 'alfa' }) },
      ],
      errors: [],
    });
    const iAlfa = note.lines.findIndex((l) => l.includes('✓ alfa'));
    const iZebra = note.lines.findIndex((l) => l.includes('✓ zebra'));
    expect(iAlfa).toBeLessThan(iZebra);
  });
});

describe('buildServicesNote — rejeitados', () => {
  it('mostra o dirName e o motivo', () => {
    const note = buildServicesNote({
      services: [],
      errors: [{ dirName: 'quebrado', reason: 'service.md sem "name" válido' }],
    });
    const t = text(note.lines);
    expect(t).toContain('rejeitados (1)');
    expect(t).toContain('⚠ quebrado');
    expect(t).toContain('sem "name" válido');
  });
});

describe('buildServicesNote — estado vazio', () => {
  it('sem válidos nem rejeitados ⇒ dica de instalação', () => {
    const note = buildServicesNote({ services: [], errors: [] });
    const t = text(note.lines);
    expect(t).toContain('nenhum serviço instalado');
    expect(t).toContain('aluy service install');
  });
});
