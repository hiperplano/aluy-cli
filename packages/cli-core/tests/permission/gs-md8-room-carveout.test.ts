// EST-???? · ADR-0061 (emenda) · GS-MD8 (carve-out F49) — testes do carve-out de
// segurança que isenta `room_post`/`room_read` da checagem GS-MD1 (`toolScope`)
// quando o sub-agente é spawnado com `room:`.
//
// CA-1: `room: false` no frontmatter ⇒ perfil parseado tem `room: false`.
// CA-2: `room: true` / ausente ⇒ perfil parseado com `room: true` / `undefined`.
// CA-3: `bindNamedAgent` com `room: false` ⇒ `SubAgentProfile.roomOptOut: true`.
// CA-4: `bindNamedAgent` sem `room:` ⇒ `SubAgentProfile` NÃO tem `roomOptOut`.
// CA-7: `roomExemptTools` isenta `room_post`/`room_read` da checagem `toolScope`.
// CA-8: `roomExemptTools` NÃO isenta tools que não são de sala.

import { describe, expect, it } from 'vitest';
import { parseAgentProfile, isAgentProfileError } from '../../src/index.js';
import type { AgentProfile } from '../../src/agent/agent-profile.js';
import { bindNamedAgent, AgentRegistry } from '../../src/agent/agent-registry.js';
import type { SubAgentProfile } from '../../src/agent/subagent.js';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import type { ToolCall } from '../../src/permission/gate.js';

/** Atalho: parseia e exige sucesso. */
function ok(basename: string, raw: string, origin: 'global' | 'project' = 'global'): AgentProfile {
  const p = parseAgentProfile(basename, raw, origin);
  if (isAgentProfileError(p)) throw new Error(`esperava perfil, veio erro: ${p.reason}`);
  return p;
}

// ══════════════════════════════════════════════════════════════════════════════
// CA-1 / CA-2 — parsing do frontmatter `room`
// ══════════════════════════════════════════════════════════════════════════════

describe('GS-MD8 — parser (CA-1 / CA-2)', () => {
  it('CA-1: room: false ⇒ room: false no perfil', () => {
    const raw = [
      '---',
      'name: revisor',
      'description: Revisa diffs.',
      'tools: read_file, grep',
      'room: false',
      '---',
      'Você é um revisor.',
    ].join('\n');

    const profile = ok('revisor.md', raw);
    expect(profile.room).toBe(false);
  });

  it('CA-2a: room: true ⇒ room: true no perfil', () => {
    const raw = [
      '---',
      'name: pesquisador',
      'description: Pesquisa.',
      'tools: read_file, grep',
      'room: true',
      '---',
      'Você é um pesquisador.',
    ].join('\n');

    const profile = ok('pesquisador.md', raw);
    expect(profile.room).toBe(true);
  });

  it('CA-2b: sem room ⇒ room: undefined (default participa)', () => {
    const raw = [
      '---',
      'name: sem-room',
      'description: Sem room.',
      'tools: read_file',
      '---',
      'Sem room.',
    ].join('\n');

    const profile = ok('sem-room.md', raw);
    expect(profile.room).toBeUndefined();
  });

  it('CA-2c: room: "" (vazio) ⇒ room: true (participa)', () => {
    const raw = [
      '---',
      'name: vazio',
      'description: Room vazio.',
      'tools: read_file',
      'room: ',
      '---',
      'Room vazio.',
    ].join('\n');

    const profile = ok('vazio.md', raw);
    expect(profile.room).toBe(true);
  });

  it('CA-2d: room: FALSE (case-insensitive) ⇒ room: false', () => {
    const raw = [
      '---',
      'name: case-test',
      'description: Test case.',
      'tools: read_file',
      'room: FALSE',
      '---',
      'Case test.',
    ].join('\n');

    const profile = ok('case-test.md', raw);
    expect(profile.room).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CA-3 / CA-4 — bindNamedAgent propaga room → roomOptOut
// ══════════════════════════════════════════════════════════════════════════════

describe('GS-MD8 — bindNamedAgent (CA-3 / CA-4)', () => {
  const baseSubAgentProfile: SubAgentProfile = {
    label: 'teste',
    goal: 'Testar.',
    agent: 'revisor',
  };

  it('CA-3: room: false no .md ⇒ roomOptOut: true no SubAgentProfile', () => {
    const raw = [
      '---',
      'name: revisor',
      'description: Revisa.',
      'tools: read_file',
      'room: false',
      '---',
      'Revisor.',
    ].join('\n');

    const profile = ok('revisor.md', raw);
    const registry = new AgentRegistry([profile], []);
    const binding = bindNamedAgent(registry, baseSubAgentProfile);

    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error('esperava ok');
    expect(binding.profile.roomOptOut).toBe(true);
    // system prompt do .md foi aplicado
    expect(binding.profile.systemPrompt).toBe('Revisor.');
    // toolScope do .md foi aplicado
    expect(binding.profile.toolScope).toEqual(new Set(['read_file']));
  });

  it('CA-4a: sem room no .md ⇒ NÃO tem roomOptOut', () => {
    const raw = [
      '---',
      'name: sem-room',
      'description: Sem room.',
      'tools: read_file',
      '---',
      'Sem room.',
    ].join('\n');

    const profile = ok('sem-room.md', raw);
    const registry = new AgentRegistry([profile], []);
    const subAgent: SubAgentProfile = {
      label: 'teste',
      goal: 'Testar.',
      agent: 'sem-room',
    };
    const binding = bindNamedAgent(registry, subAgent);

    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error('esperava ok');
    expect(binding.profile.roomOptOut).toBeUndefined();
    expect(binding.profile.systemPrompt).toBe('Sem room.');
  });

  it('CA-4b: room: true no .md ⇒ NÃO tem roomOptOut', () => {
    const raw = [
      '---',
      'name: com-room',
      'description: Com room true.',
      'tools: read_file',
      'room: true',
      '---',
      'Com room true.',
    ].join('\n');

    const profile = ok('com-room.md', raw);
    const registry = new AgentRegistry([profile], []);
    const subAgent: SubAgentProfile = {
      label: 'teste',
      goal: 'Testar.',
      agent: 'com-room',
    };
    const binding = bindNamedAgent(registry, subAgent);

    expect(binding.ok).toBe(true);
    if (!binding.ok) throw new Error('esperava ok');
    expect(binding.profile.roomOptOut).toBeUndefined();
    expect(binding.profile.roomOptOut).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CA-7 / CA-8 — roomExemptTools no decide() do PolicyPermissionEngine
// ══════════════════════════════════════════════════════════════════════════════

const ROOM_POST = 'room_post';
const ROOM_READ = 'room_read';
const READ_FILE = 'read_file';
const GREP = 'grep';

function toolCall(name: string): ToolCall {
  return { name, input: {} };
}

describe('GS-MD8 — engine.decide() com roomExemptTools (CA-7 / CA-8)', () => {
  it('CA-7a: room_post isenta da checagem toolScope quando no roomExemptTools', () => {
    const roomTools = new Set([ROOM_POST, ROOM_READ]);
    const engine = new PolicyPermissionEngine({
      toolScope: new Set([READ_FILE, GREP]), // NÃO inclui room_post
      roomExemptTools: roomTools,
    });

    const result = engine.decide(toolCall(ROOM_POST));
    // room_post está no roomExemptTools ⇒ pula GS-MD1
    // Cai no piso normal (read tools allow ⇒ mas room_post não é read tool)
    // room_post é tool de efeito ('comms') ⇒ cai em ask (piso padrão)
    expect(result.decision).not.toBe('deny');
    // NÃO deve ser deny por toolScope (GS-MD1)
    if (result.decision === 'deny') {
      expect(result.reason).not.toContain('GS-MD1');
      expect(result.reason).not.toContain('toolScope');
    }
  });

  it('CA-7b: room_read isenta da checagem toolScope quando no roomExemptTools', () => {
    const roomTools = new Set([ROOM_POST, ROOM_READ]);
    const engine = new PolicyPermissionEngine({
      toolScope: new Set([READ_FILE, GREP]), // NÃO inclui room_read
      roomExemptTools: roomTools,
    });

    const result = engine.decide(toolCall(ROOM_READ));
    // room_read está no roomExemptTools ⇒ pula GS-MD1
    // room_read é 'read' ⇒ allow pelo piso de leitura
    expect(result.decision).not.toBe('deny');
  });

  it('CA-7c: sem roomExemptTools, room_post É barrada pelo toolScope', () => {
    const engine = new PolicyPermissionEngine({
      toolScope: new Set([READ_FILE, GREP]), // NÃO inclui room_post
      // SEM roomExemptTools
    });

    const result = engine.decide(toolCall(ROOM_POST));
    // room_post NÃO está no toolScope e NÃO há roomExemptTools
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('GS-MD1');
  });

  it('CA-8a: roomExemptTools NÃO isenta tool que não está na lista de isenção', () => {
    const roomTools = new Set([ROOM_POST, ROOM_READ]);
    const engine = new PolicyPermissionEngine({
      toolScope: new Set([READ_FILE]), // read_file está, run_command NÃO
      roomExemptTools: roomTools,
    });

    // run_command NÃO está no roomExemptTools nem no toolScope
    const result = engine.decide(toolCall('run_command'));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('GS-MD1');
  });

  it('CA-8b: roomExemptTools NÃO afeta engine SEM toolScope (não-regressão)', () => {
    // Sem toolScope ⇒ GS-MD1 nem é checada; roomExemptTools é irrelevante
    const roomTools = new Set([ROOM_POST, ROOM_READ]);
    const engine = new PolicyPermissionEngine({
      // SEM toolScope ⇒ herda toolset do pai inteiro
      roomExemptTools: roomTools,
    });

    const result = engine.decide(toolCall('run_command'));
    // Sem toolScope, a ferramenta NÃO é negada por GS-MD1
    if (result.decision === 'deny') {
      expect(result.reason).not.toContain('GS-MD1');
    }
  });

  it('CA-8c: roomExemptTools vazio é equivalente a undefined (não-regressão)', () => {
    const engine = new PolicyPermissionEngine({
      toolScope: new Set([READ_FILE]),
      roomExemptTools: new Set(), // vazio
    });

    // room_post NÃO está no toolScope e roomExemptTools é vazio
    const result = engine.decide(toolCall(ROOM_POST));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('GS-MD1');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CA integração — forSubAgent propaga roomExemptTools
// ══════════════════════════════════════════════════════════════════════════════

describe('GS-MD8 — forSubAgent propaga roomExemptTools', () => {
  it('forSubAgent com roomExemptTools ⇒ engine filha isenta as tools de sala', () => {
    const parent = new PolicyPermissionEngine({
      toolScope: new Set([READ_FILE, GREP]),
    });

    const roomTools = new Set([ROOM_POST, ROOM_READ]);
    const child = parent.forSubAgent(new Set([READ_FILE]), roomTools);

    // Filho só pode read_file pelo toolScope, mas room_post/room_read são isentas
    const postResult = child.decide(toolCall(ROOM_POST));
    expect(postResult.decision).not.toBe('deny');

    const readResult = child.decide(toolCall(ROOM_READ));
    expect(readResult.decision).not.toBe('deny');

    // grep NÃO está no toolScope do filho nem no roomExemptTools
    const grepResult = child.decide(toolCall(GREP));
    expect(grepResult.decision).toBe('deny');
    expect(grepResult.reason).toContain('GS-MD1');
  });

  it('forSubAgent sem roomExemptTools ⇒ não-regressão (não isenta nada)', () => {
    const parent = new PolicyPermissionEngine();
    const child = parent.forSubAgent(new Set([READ_FILE]));
    // SEM roomExemptTools

    const result = child.decide(toolCall(ROOM_POST));
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('GS-MD1');
  });
});
