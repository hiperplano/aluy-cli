// EST-0970 — render do relatório p/ linhas (sessão Unicode / shell ASCII).

import { describe, expect, it } from 'vitest';
import { buildDoctorReport, type DoctorFacts } from '../../src/doctor/checks.js';
import {
  renderDoctor,
  ASCII_DOCTOR_GLYPHS,
  UNICODE_DOCTOR_GLYPHS,
} from '../../src/doctor/render.js';

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    auth: { present: true, keychainAvailable: true, user: 'u', org: 'o', kind: 'device' },
    broker: { url: 'https://b.test', probe: { reached: true, status: 200 } },
    catalog: {
      tiers: { reached: true, status: 200 },
      custom: { reached: true, status: 200 },
      customCount: 0,
    },
    mcp: { servers: [], configErrors: [] },
    agents: { validCount: 0, rejected: [] },
    config: { exists: false, corrupted: false, maxTokens: 1000, maxIterations: 300, flags: [] },
    version: { aluy: '0.0.0', node: 'v24' },
    memory: { accessible: true, count: 0 },
    sidecars: {
      headroom: { reached: true, status: 200 },
      ollama: { reached: true, status: 200 },
      mem0: { reached: true, status: 200 },
      profile: 'turbo',
      toggles: ['ollama', 'mem0'],
    },
    maestro: { enabled: true },
    ...over,
  };
}

describe('doctor/render', () => {
  it('linha por check + resumo final', () => {
    const lines = renderDoctor(buildDoctorReport(facts()), ASCII_DOCTOR_GLYPHS);
    // 10 checks ok ⇒ 10 linhas de check + linha vazia + resumo.
    const resumo = lines.find((l) => l.startsWith('resumo:'));
    expect(resumo).toContain('10 ok');
    expect(resumo).toContain('0 falha');
  });

  it('check não-ok emite a linha de dica indentada `→`', () => {
    const report = buildDoctorReport(facts({ auth: { present: false, keychainAvailable: true } }));
    const lines = renderDoctor(report, ASCII_DOCTOR_GLYPHS);
    expect(lines.some((l) => l.trim().startsWith('→'))).toBe(true);
    expect(lines.some((l) => l.includes('[x]'))).toBe(true); // glifo de falha ASCII
  });

  it('glifos Unicode na superfície da TUI', () => {
    const lines = renderDoctor(buildDoctorReport(facts()), UNICODE_DOCTOR_GLYPHS);
    expect(lines.some((l) => l.startsWith('✓'))).toBe(true);
  });
});
