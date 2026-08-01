// ADR-0158 §5 pt.4 (FASE 3, missão item 4) — "status/list mostram 'aguardando dono
// (pergunta enviada há X)'". Arquivo PRÓPRIO (não edita `service-list.test.ts` da
// fase 1) — só o NOVO campo `pendingSinceIso`/`nowMs` desta fase.
import { describe, expect, it } from 'vitest';
import { buildServicesNote, type ServiceManifest } from '../../../src/index.js';

function manifest(over: Partial<ServiceManifest> & Pick<ServiceManifest, 'name'>): ServiceManifest {
  return { tunables: [], orchestrator: 'Rege, não opera.', ...over };
}

function text(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('buildServicesNote — aguardando dono, com elapsed (ADR-0158 §5 pt.4, FASE 3)', () => {
  const NOW = Date.parse('2026-08-01T12:00:00.000Z');

  it('com pendingSinceIso ⇒ mostra "pergunta enviada há X"', () => {
    const note = buildServicesNote({
      services: [
        {
          name: 'trader',
          manifest: manifest({ name: 'trader' }),
          runtimeStatus: {
            running: true,
            turnState: 'awaiting-owner',
            pendingSinceIso: new Date(NOW - 90 * 60_000).toISOString(), // 90min atrás
          },
        },
      ],
      errors: [],
      nowMs: NOW,
    });
    const t = text(note.lines);
    expect(t).toContain('aguardando dono');
    expect(t).toContain('pergunta enviada há 1h');
  });

  it('sem pendingSinceIso ⇒ mostra "aguardando dono" sem o "há X" (não regride)', () => {
    const note = buildServicesNote({
      services: [
        {
          name: 'trader',
          manifest: manifest({ name: 'trader' }),
          runtimeStatus: { running: true, turnState: 'awaiting-owner' },
        },
      ],
      errors: [],
      nowMs: NOW,
    });
    const t = text(note.lines);
    expect(t).toContain('aguardando dono');
    expect(t).not.toContain('pergunta enviada há');
  });
});
