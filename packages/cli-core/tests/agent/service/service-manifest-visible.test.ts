// ADR-0158 §9/§10 — FORMATADOR `buildServiceManifestVisibleNote` (o "manifesto
// visível" exigido ANTES de qualquer confirmação de `install`). Bateria: campos
// declarados aparecem; daemons/skills-com-script/mcp.json são sinalizados; canal
// AUSENTE fica visivelmente marcado (ninguém instala achando que tem canal e não tem).

import { describe, expect, it } from 'vitest';
import { buildServiceManifestVisibleNote, type ServiceManifest } from '../../../src/index.js';

function manifest(over: Partial<ServiceManifest> & Pick<ServiceManifest, 'name'>): ServiceManifest {
  return { tunables: [], ignoredFrontmatterKeys: [], orchestrator: 'Rege, não opera.', ...over };
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

  // Descoberta entre serviços (`group:`) + modelo fixo por serviço (`model:`) — o
  // dono precisa ver AMBOS antes de instalar (fronteira: a que mesa está aderindo,
  // e com que modelo/custo o serviço vai rodar).
  it('mostra "grupo:" quando declarado; some quando ausente', () => {
    const comGrupo = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', group: 'mesa-trading' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(comGrupo.lines)).toContain('grupo: mesa-trading');

    const semGrupo = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semGrupo.lines)).not.toContain('grupo:');
  });

  it('mostra "modelo:" declarado, ou o aviso de default global quando ausente', () => {
    const comModelo = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', model: 'xiaomi/mimo-v2.5-pro' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(comModelo.lines)).toContain('modelo: xiaomi/mimo-v2.5-pro');

    const semModelo = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semModelo.lines)).toContain('modelo: (não declarado — usa o default global da config)');
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

  // ADR-0158 — `workspace:` ABRE UMA PORTA: o dono precisa VER as raízes extra
  // ANTES de instalar, com o MESMO destaque (⚠) do aviso de autonomia autônoma.
  it('workspace: declarado fica DESTACADO (⚠) com cada raiz listada; ausente mostra "nenhuma"', () => {
    const comWorkspace = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', workspaceRoots: ['~/projects/fluider', '/opt/dados'] }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    const t = text(comWorkspace.lines);
    expect(t).toContain('⚠ workspace: 2 raiz(es)');
    expect(t).toContain('~/projects/fluider');
    expect(t).toContain('/opt/dados');

    const semWorkspace = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    const t2 = text(semWorkspace.lines);
    expect(t2).not.toContain('⚠ workspace');
    expect(t2).toContain('workspace: (nenhuma raiz extra — só a própria pasta do serviço)');
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

  // `immediate: true` fura "fora do horário, o serviço nem acorda" — o dono
  // precisa ver ANTES de instalar que este serviço dispara ao ligar (e a cada
  // reinício). Ausente/`false` não recebem linha (comportamento de hoje).
  it('immediate: true fica DESTACADO (⚠) — dispara turno já no start/reinício', () => {
    const comImediato = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', immediate: true }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    const t = text(comImediato.lines);
    expect(t).toContain('⚠ immediate: true');
    expect(t).toContain('TODO reinício');

    const semImediato = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semImediato.lines)).not.toContain('immediate');

    const imediatoFalse = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader', immediate: false }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(imediatoFalse.lines)).not.toContain('immediate');
  });

  // O silêncio que motivou a visibilidade: `immediate:` escrito antes de existir,
  // ou um typo (`activty-timeout:`) — o dono via de instalar precisa ver que a
  // chave não fez nada.
  it('campos ignorados aparecem no manifesto visível; some quando não há nenhum', () => {
    const comIgnorados = buildServiceManifestVisibleNote({
      manifest: manifest({
        name: 'trader',
        ignoredFrontmatterKeys: ['immediate', 'activty-timeout'],
      }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(comIgnorados.lines)).toContain(
      '⚠ campos ignorados (não reconhecidos): immediate, activty-timeout',
    );

    const semIgnorados = buildServiceManifestVisibleNote({
      manifest: manifest({ name: 'trader' }),
      daemons: [],
      skills: [],
      hasMcp: false,
    });
    expect(text(semIgnorados.lines)).not.toContain('campos ignorados');
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
