// ADR-0158 §9/§10 — FORMATADOR `buildServiceManifestVisibleNote` (o "manifesto
// visível" exigido ANTES de qualquer confirmação de `install`). Bateria: campos
// declarados aparecem; daemons/skills-com-script/mcp.json são sinalizados; canal
// AUSENTE fica visivelmente marcado (ninguém instala achando que tem canal e não tem).

import { describe, expect, it } from 'vitest';
import { buildServiceManifestVisibleNote, type ServiceManifest } from '../../../src/index.js';

function manifest(over: Partial<ServiceManifest> & Pick<ServiceManifest, 'name'>): ServiceManifest {
  return { tunables: [], orchestrator: 'Rege, não opera.', ...over };
}

function text(lines: readonly string[]): string {
  return lines.join('\n');
}

describe('buildServiceManifestVisibleNote', () => {
  it('mostra canal, autonomia, schedule/until, budget e tunáveis', () => {
    const note = buildServiceManifestVisibleNote({
      manifest: manifest({
        name: 'trader',
        channel: 'telegram:12345',
        autonomy: 'ask',
        schedule: '0 9 * * 1-5',
        until: '17:30',
        budget: '200k/turno',
        tunables: [
          { key: 'perda-maxima-dia', value: 500 },
          { key: 'tamanho-posicao', value: 2, min: 1, max: 5 },
        ],
      }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    const t = text(note.lines);
    expect(note.title).toContain('trader');
    expect(t).toContain('canal: telegram:12345');
    expect(t).toContain('autonomia: ask');
    expect(t).toContain('schedule: 0 9 * * 1-5');
    expect(t).toContain('until: 17:30');
    expect(t).toContain('budget: 200k/turno');
    expect(t).toContain('perda-maxima-dia: 500 (fixo, sem faixa)');
    expect(t).toContain('tamanho-posicao: 2 [1..5]');
  });

  it('teto por atividade: default (30min) quando ausente, valor cru quando declarado', () => {
    const semDeclarar = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semDeclarar.lines)).toContain('teto por atividade: 30min (default)');

    const semTeto = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', activityTimeout: 'sem-teto' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semTeto.lines)).toContain('teto por atividade: sem-teto');
  });

  it('autonomy: yolo-scoped fica DESTACADA (⚠) — é o momento do consentimento p/ um serviço que não pergunta', () => {
    const autonomo = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', autonomy: 'yolo-scoped' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    const t = text(autonomo.lines);
    expect(t).toContain('⚠ autonomia: yolo-scoped');
    expect(t).toContain('NÃO PERGUNTA');

    // `ask` (e ausente) seguem SEM o destaque de alerta.
    const perguntando = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', autonomy: 'ask' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(perguntando.lines)).not.toContain('⚠ autonomia');

    const semDeclarar = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semDeclarar.lines)).not.toContain('⚠ autonomia');
  });

  it('canal AUSENTE fica visivelmente marcado (nunca escondido)', () => {
    const note = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'pesquisador' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(note.lines)).toContain('canal: (NENHUM');
  });

  it('daemons declarados aparecem com comando + porta', () => {
    const note = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [{ name: 'mt5-bridge', command: 'python bridge.py', port: '9001' }],
      skills: [],
      hasMcp: false,
    });
    const t = text(note.lines);
    expect(t).toContain('daemons PRÓPRIOS');
    expect(t).toContain('mt5-bridge: python bridge.py · porta 9001');
  });

  it('skills COM script próprio são sinalizadas; skills SEM script não aparecem na lista', () => {
    const note = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [
        { name: 'mt5-executar', hasScript: true },
        { name: 'so-instrucoes', hasScript: false },
      ],
      hasMcp: false,
    });
    const t = text(note.lines);
    expect(t).toContain('COM SCRIPT PRÓPRIO (1)');
    expect(t).toContain('mt5-executar');
    expect(t).not.toContain('so-instrucoes');
  });

  it('mcp.json presente/ausente é mostrado', () => {
    const withMcp = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: true,
    });
    expect(text(withMcp.lines)).toContain(
      'mcp.json (servers MCP escopados a este serviço): presente',
    );

    const withoutMcp = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(withoutMcp.lines)).toContain(
      'mcp.json (servers MCP escopados a este serviço): ausente',
    );
  });
});
