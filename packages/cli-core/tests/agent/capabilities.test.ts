// ADR-0145 (frente d) — a tool `capabilities` (+ sinônimo `list_tools`): MENU VIVO de
// auto-descoberta, effect:'read' PURO. Prova:
//  • effect:'read' travado (nunca passa a exigir confirmação de efeito);
//  • formata o snapshot agrupado por intenção (grupo/when das tools, agentes,
//    memória, monitores, MCP, skills, comandos);
//  • `filter` restringe a resposta;
//  • sem a porta ⇒ erro claro (fail-safe), nunca lança;
//  • ANTI-VAZAMENTO (AG-0008): a resposta NUNCA contém credencial/provider/base_url/
//    api_key/model/tier — só nomes/efeitos/contadores (mesmo com um snapshot
//    "realista" cheio de dado plausível em cada campo);
//  • skills: `invocable` só aparece implícito p/ origem `global` (project ⇒ "(descoberta)").

import { describe, expect, it } from 'vitest';
import {
  capabilitiesTool,
  listToolsTool,
  renderCapabilities,
  CAPABILITIES_TOOL_NAME,
  CAPABILITIES_TOOL_ALIAS,
} from '../../src/agent/tools/capabilities.js';
import type { CapabilitiesPort, CapabilitiesSnapshot, ToolPorts } from '../../src/agent/tools/types.js';
import { makePorts } from './helpers.js';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import { PLAN_READ_ALLOWLIST, isPlanReadAllowed } from '../../src/permission/plan.js';
import type { ToolCall } from '../../src/permission/gate.js';

function call(name: string, input: Readonly<Record<string, unknown>> = {}): ToolCall {
  return { name, input };
}

/** Snapshot "realista" cobrindo TODOS os campos do menu, p/ o teste anti-vazamento. */
function fullSnapshot(): CapabilitiesSnapshot {
  return {
    tools: [
      { name: 'read_file', effect: 'read', group: 'arquivo', when: 'antes de editar' },
      { name: 'edit_file', effect: 'write', group: 'arquivo' },
      { name: 'grep', effect: 'read', group: 'busca' },
      { name: 'run_command', effect: 'exec', group: 'execucao' },
      { name: 'spawn_agent', effect: 'exec', group: 'delegacao' },
      { name: 'recall', effect: 'read', group: 'memoria' },
      { name: 'monitor', effect: 'read', group: 'assincrono' },
      { name: 'web_fetch', effect: 'network', group: 'web' },
      { name: 'capabilities', effect: 'read', group: 'outro' },
    ],
    agents: [
      { name: 'arquiteto', summary: 'Guarda a arquitetura e escreve ADRs.', origin: 'global' },
      { name: 'revisor-proj', summary: 'Revisa PRs do projeto.', origin: 'project' },
    ],
    skills: [
      { name: 'deep-research', summary: 'Pesquisa profunda multi-fonte.', origin: 'global', invocable: true },
      { name: 'skill-do-repo', summary: 'Skill de projeto (descoberta-apenas).', origin: 'project', invocable: false },
    ],
    mcpServers: [{ server: 'playwright', toolCount: 12, prefix: 'mcp__playwright__' }],
    memory: { factCount: 7 },
    monitors: [{ id: 'mon-1', label: 'build', type: 'process-wait' }],
    sessionCommands: [{ name: 'cycle', about: 'Roda um loop autônomo por N iterações.' }],
  };
}

describe('ADR-0145 (frente d) — tool `capabilities`', () => {
  it('effect é "read" PURO — nunca exige confirmação de efeito', () => {
    expect(capabilitiesTool.effect).toBe('read');
    expect(listToolsTool.effect).toBe('read');
  });

  it('nomes: canônico "capabilities" + sinônimo "list_tools"', () => {
    expect(capabilitiesTool.name).toBe(CAPABILITIES_TOOL_NAME);
    expect(listToolsTool.name).toBe(CAPABILITIES_TOOL_ALIAS);
    expect(capabilitiesTool.name).not.toBe(listToolsTool.name);
  });

  it('sem a porta `capabilities` ⇒ erro claro, NUNCA lança', async () => {
    const { ports } = makePorts();
    const res = await capabilitiesTool.run({}, ports);
    expect(res.ok).toBe(false);
    expect(res.observation).toContain('indisponível');
  });

  it('com a porta, devolve o menu agrupado por intenção', async () => {
    const port: CapabilitiesPort = { snapshot: () => fullSnapshot() };
    const ports: ToolPorts = { ...makePorts().ports, capabilities: port };
    const res = await capabilitiesTool.run({}, ports);
    expect(res.ok).toBe(true);
    expect(res.observation).toContain('CAPACIDADES DISPONÍVEIS AGORA');
    expect(res.observation).toContain('read_file');
    expect(res.observation).toContain('spawn_agent');
    expect(res.observation).toContain('arquiteto');
    expect(res.observation).toContain('deep-research');
    expect(res.observation).toContain('playwright');
    expect(res.observation).toContain('7 fato(s)');
    expect(res.observation).toContain('monitores ativos: 1');
  });

  it('o sinônimo `list_tools` roda a MESMA formatação', async () => {
    const port: CapabilitiesPort = { snapshot: () => fullSnapshot() };
    const ports: ToolPorts = { ...makePorts().ports, capabilities: port };
    const res = await listToolsTool.run({}, ports);
    expect(res.ok).toBe(true);
    expect(res.observation).toContain('CAPACIDADES DISPONÍVEIS AGORA');
  });

  it('`filter` restringe a resposta ao grupo/termo casado', async () => {
    const port: CapabilitiesPort = { snapshot: () => fullSnapshot() };
    const ports: ToolPorts = { ...makePorts().ports, capabilities: port };
    const res = await capabilitiesTool.run({ filter: 'mcp' }, ports);
    expect(res.ok).toBe(true);
    expect(res.observation).toContain('playwright');
    expect(res.observation).not.toContain('spawn_agent');
    expect(res.observation).not.toContain('arquiteto');
  });

  it('filtro sem casamento ⇒ observação clara (não confunde com "vazio ausente")', () => {
    const text = renderCapabilities(fullSnapshot(), 'termo-que-nao-existe-em-nada');
    expect(text).toContain('nenhuma capacidade casou o filtro');
  });

  it('skills de origem "project" aparecem como DESCOBERTA (não invocável)', () => {
    const text = renderCapabilities(fullSnapshot(), 'skills');
    expect(text).toContain('deep-research');
    expect(text).toContain('skill-do-repo (descoberta)');
    // a global NÃO leva o rótulo "(descoberta)".
    expect(text).not.toContain('deep-research (descoberta)');
  });

  it('ANTI-VAZAMENTO (AG-0008): o menu NUNCA carrega credencial/provider/tier/model', () => {
    const text = renderCapabilities(fullSnapshot(), undefined);
    // Regex EXATA exigida pela onda: falha se qualquer um destes tokens aparecer.
    const FORBIDDEN = /provider|base_?url|api[_-]?key|token|secret|authorization|model|tier/i;
    expect(text).not.toMatch(FORBIDDEN);
  });

  it('ANTI-VAZAMENTO — mesmo com filtros/variações, nenhuma saída vaza os termos proibidos', () => {
    const FORBIDDEN = /provider|base_?url|api[_-]?key|token|secret|authorization|model|tier/i;
    const snap = fullSnapshot();
    for (const filter of [undefined, 'mcp', 'skills', 'delegacao', 'memoria', 'assincrono', 'busca']) {
      expect(renderCapabilities(snap, filter)).not.toMatch(FORBIDDEN);
    }
  });

  it('snapshot vazio ⇒ observação clara, não uma string vazia/silenciosa', () => {
    const empty: CapabilitiesSnapshot = {
      tools: [],
      agents: [],
      skills: [],
      mcpServers: [],
      sessionCommands: [],
    };
    const text = renderCapabilities(empty, undefined);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('nenhuma capacidade disponível');
  });

  it('propaga falha do snapshot como observação de erro (nunca lança)', async () => {
    const port: CapabilitiesPort = {
      snapshot: () => {
        throw new Error('boom');
      },
    };
    const ports: ToolPorts = { ...makePorts().ports, capabilities: port };
    const res = await capabilitiesTool.run({}, ports);
    expect(res.ok).toBe(false);
    expect(res.observation).toContain('boom');
  });
});

describe('ADR-0145 (frente d) · AG-0008 — classificação da catraca (allow silencioso + Plan)', () => {
  it('normal: allow SILENCIOSO (READ_TOOLS) — nunca pede confirmação de efeito', () => {
    const engine = new PolicyPermissionEngine();
    expect(engine.decide(call(CAPABILITIES_TOOL_NAME)).decision).toBe('allow');
    expect(engine.decide(call(CAPABILITIES_TOOL_ALIAS)).decision).toBe('allow');
  });

  it('Plan: está na allow-list FECHADA (permitida mesmo no teto read-only)', () => {
    expect(PLAN_READ_ALLOWLIST.has(CAPABILITIES_TOOL_NAME)).toBe(true);
    expect(PLAN_READ_ALLOWLIST.has(CAPABILITIES_TOOL_ALIAS)).toBe(true);
    expect(isPlanReadAllowed(call(CAPABILITIES_TOOL_NAME))).toBe(true);
    expect(isPlanReadAllowed(call(CAPABILITIES_TOOL_ALIAS, { filter: 'mcp' }))).toBe(true);
    const engine = new PolicyPermissionEngine({ mode: 'plan' });
    expect(engine.decide(call(CAPABILITIES_TOOL_NAME)).decision).toBe('allow');
  });

  it('unsafe (--yolo): permissão completa de sessão (mesma via de qualquer read)', () => {
    const engine = new PolicyPermissionEngine({ mode: 'unsafe' });
    expect(engine.decide(call(CAPABILITIES_TOOL_NAME)).decision).toBe('allow');
  });
});
