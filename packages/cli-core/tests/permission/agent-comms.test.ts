// EST-ROOMS-2 · ADR-0081 §8.2 + §13.1 · CLI-SEC-3 (gate AG-0008, P1) — a CATRACA da
// COMUNICAÇÃO ENTRE AGENTES (`room_post`). Prova as invariantes do veredito P1:
//
//   - PLAN ⇒ DENY: `room_post` é EFEITO (não está na allow-list FECHADA de leitura) —
//     o modo plan (read-only) o NEGA por construção. INEGOCIÁVEL: room_post NÃO
//     executa em plan mode.
//   - NORMAL ⇒ ALLOW SEM `ask`-por-post (§13.1 — a MEMBERSHIP da sala é o consentimento;
//     `ask` a cada fala é inutilizável numa conversa multi-agente). A authz REAL é a
//     MESH (writer∈writers), provada à parte (room-tools.test.ts).
//   - UNSAFE (`--yolo`) ⇒ ALLOW (bypass total; a membership é o que vale).
//   - ALLOW-LIST POR SALA (§8.2): uma REGRA do usuário `room_post:<code>` deny/ask VENCE
//     o default-allow — escopo por CÓDIGO, granular (permito esta sala, nego aquela).
//   - LABEL HONESTA: a tool declara `effect: 'comms'` (NÃO `'read'` — a label `read`
//     mentia: room_post tem efeito).
// EST-1091: adaptado para a porta ASSÍNCRONA (MemoryRoomStore).

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type PermissionPolicy, type ToolCall } from '../../src/index.js';
import { buildRoomTools } from '../../src/agent/rooms/room-tools.js';
import { MemoryRoomStore } from '../../src/agent/rooms/room-store.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

const POST = (code = 'sala-1') =>
  call('room_post', { code, kind: 'inform', to: 'agente-B', body: 'build passou' });

describe('agent-comms · room_post na catraca (gate AG-0008, P1)', () => {
  it('PLAN ⇒ DENY: room_post é EFEITO, não executa em plan mode (INEGOCIÁVEL)', () => {
    const engine = new PolicyPermissionEngine({ mode: 'plan' });
    const v = engine.decide(POST());
    expect(v.decision).toBe('deny');
    // negado pelo eixo de MODO (plan), não pela branch agent-comms — read-only é o teto.
    expect(v.category).toBe('mode:plan-deny');
  });

  it('NORMAL ⇒ ALLOW SEM ask (§13.1: membership = consentimento, não ask-por-post)', () => {
    const engine = new PolicyPermissionEngine({ mode: 'normal' });
    const v = engine.decide(POST());
    expect(v.decision).toBe('allow'); // NÃO 'ask' — sem fricção redundante por mensagem
    expect(v.category).toBe('agent-comms');
  });

  it('default (sem mode explícito = normal) ⇒ ALLOW (não cai no piso ask de tool desconhecida)', () => {
    const engine = new PolicyPermissionEngine();
    const v = engine.decide(POST());
    expect(v.decision).toBe('allow');
    expect(v.category).toBe('agent-comms');
  });

  it('UNSAFE (--yolo) ⇒ ALLOW (bypass total; membership é o que vale)', () => {
    const engine = new PolicyPermissionEngine({ mode: 'unsafe' });
    expect(engine.decide(POST()).decision).toBe('allow');
  });

  it('ALLOW-LIST POR SALA (§8.2): regra deny `room_post:<code>` VENCE o default-allow', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'room_post', match: 'sala-secreta', decision: 'deny' }],
    };
    const engine = new PolicyPermissionEngine({ mode: 'normal', policy });
    // a sala negada ⇒ deny (escopo por código)
    const negada = engine.decide(POST('sala-secreta'));
    expect(negada.decision).toBe('deny');
    expect(negada.category).toBe('agent-comms');
    // OUTRA sala segue liberada (granularidade por código — nunca global)
    expect(engine.decide(POST('sala-aberta')).decision).toBe('allow');
  });

  it('ALLOW-LIST POR SALA: regra `ask` p/ uma sala específica é honrada (fricção opt-in)', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'room_post', match: 'sala-sensivel', decision: 'ask' }],
    };
    const engine = new PolicyPermissionEngine({ mode: 'normal', policy });
    expect(engine.decide(POST('sala-sensivel')).decision).toBe('ask');
    expect(engine.decide(POST('outra')).decision).toBe('allow');
  });

  it('o efeito auditável (CLI-SEC-10) nomeia a SALA + o destinatário, nunca o corpo cru', () => {
    const engine = new PolicyPermissionEngine({ mode: 'normal' });
    const v = engine.decide(POST('s-42'));
    expect(v.effect?.tool).toBe('room_post');
    expect(v.effect?.exact).toContain('s-42');
    expect(v.effect?.exact).toContain('agente-B');
    expect(v.effect?.exact).not.toContain('build passou'); // corpo não vaza no descritor
  });

  it('LABEL HONESTA: room_post declara effect:"comms" (não "read"); room_read segue "read"', () => {
    const store = new MemoryRoomStore();
    const [roomPost, roomRead] = buildRoomTools({
      store,
      writerId: 'agente-A',
      policyFor: () => ({ writers: ['agente-A'], maxHops: 10 }),
      now: () => 1,
      genMsgId: () => 'm-1',
    });
    expect(roomPost!.effect).toBe('comms');
    expect(roomRead!.effect).toBe('read');
  });
});
