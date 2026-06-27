// EST-0977 · ADR-0061 · CLI-SEC-11 (gate FORTE do `seguranca`) — `tools` ⊆ pai na
// CATRACA. A prova-de-deny do GS-MD1/GS-MD2: um agente-`.md` com `tools:` restrito
// (ou declarando `spawn_agent`) é NEGADO na `decide()` p/ tools fora do escopo —
// NÃO basta "não instanciar a tool", tem que dar DENY no veredito (R-S3-2).

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type ToolCall } from '../../src/index.js';

function call(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { name, input };
}

describe('GS-MD1 — `tools` do `.md` ⊆ pai, NUNCA amplia (deny na catraca)', () => {
  it('tool FORA do toolScope declarado ⇒ DENY na decide() (não "concedida pelo arquivo")', () => {
    // Agente `.md` com `tools: read_file, grep`. O pai é normal (deriva o filho).
    const parent = new PolicyPermissionEngine();
    const child = parent.forSubAgent(new Set(['read_file', 'grep']));
    // run_command está FORA do toolScope ⇒ negada como fora de escopo (GS-MD1).
    const v = child.decide(call('run_command', { command: 'rm -rf /' }));
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/fora do toolset|GS-MD1|⊆ pai/);
  });

  it('tool DENTRO do toolScope segue a avaliação normal (read_file ⇒ allow)', () => {
    const child = new PolicyPermissionEngine().forSubAgent(new Set(['read_file', 'grep']));
    expect(child.decide(call('read_file', { path: 'a.ts' })).decision).toBe('allow');
  });

  it('o `.md` NÃO AMPLIA: mesmo declarando uma tool, fora do escopo do pai ⇒ não vira allow', () => {
    // O toolScope pode listar `run_command`, mas a engine do filho ainda aplica o piso
    // do pai (run_command = ask por padrão) — o arquivo não "concede" allow. Aqui o
    // toolScope inclui run_command ⇒ passa do gate de escopo, MAS o piso do pai o leva
    // a `ask` (não allow). O arquivo restringe QUAIS tools; não rebaixa o COMO.
    const child = new PolicyPermissionEngine().forSubAgent(new Set(['read_file', 'run_command']));
    const v = child.decide(call('run_command', { command: 'echo hi' }));
    expect(v.decision).toBe('ask'); // jamais `allow` por causa do arquivo.
  });

  it('SEM toolScope (tools ausente no `.md`) ⇒ herda o toolset do pai inteiro', () => {
    const child = new PolicyPermissionEngine().forSubAgent(); // sem scope
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
    expect(child.decide(call('run_command', { command: 'x' })).decision).toBe('ask');
  });

  // HUNT-SUBAGENT-ESCALATION (privilege-escalation) — vetor #1: um `.md` que declara
  // `tools: *` (ou `all`) NÃO ganha "todas as tools". O `*` chega ao toolScope como
  // NOME LITERAL (o parser não expande coringa); a catraca o trata como membership
  // EXATO — toda tool real (read_file/grep/run_command) fica FORA do scope `{'*'}` ⇒
  // DENY. Coringa é fail-closed (nega tudo), JAMAIS escalada p/ "todas".
  it('toolScope coringa `{*}` NÃO libera nada — toda tool real cai fora do escopo (deny)', () => {
    const child = new PolicyPermissionEngine().forSubAgent(new Set(['*']));
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('deny');
    expect(child.decide(call('grep', { pattern: 'x' })).decision).toBe('deny');
    expect(child.decide(call('run_command', { command: 'x' })).decision).toBe('deny');
    // só o nome LITERAL `*` (que nenhuma tool real tem) "passaria" do gate de escopo.
    expect(child.decide(call('*', {})).decision).not.toBe('deny');
  });
});

describe('GS-MD2 — `spawn_agent`/`task` declarado ⇒ NEGADO na catraca (E-A1)', () => {
  it('spawn_agent é deny no filho MESMO estando no toolScope (precedência -2 > -1.9)', () => {
    // Um `.md` malicioso declara `tools: spawn_agent` — o toolScope o "permitiria",
    // mas o teto de profundidade (denySpawnAgent) o NEGA ANTES do gate de escopo.
    const child = new PolicyPermissionEngine().forSubAgent(new Set(['spawn_agent', 'read_file']));
    const v = child.decide(call('spawn_agent', { agents: [{ goal: 'x' }] }));
    expect(v.decision).toBe('deny');
    expect(v.reason).toMatch(/profundidade|E-A1|netos/);
  });
});

describe('GS-MD3 — herança de modo: Plan nega TODO efeito do agente nomeado', () => {
  it('filho em Plan ⇒ efeito (run_command) negado pelo modo, mesmo no toolScope', () => {
    const parent = new PolicyPermissionEngine({ mode: 'plan' });
    const child = parent.forSubAgent(new Set(['read_file', 'run_command']));
    // run_command está no toolScope, mas Plan (herdado) nega todo efeito.
    expect(child.decide(call('run_command', { command: 'echo x' })).decision).toBe('deny');
    // leitura local segue permitida em Plan.
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
  });

  it('`--unsafe` do pai NÃO fura o teto de toolScope (escopo é QUAIS tools, não o COMO)', () => {
    // O bypass de modo libera o COMO das tools que o filho TEM — não inventa uma tool
    // fora do toolScope. Uma tool fora do escopo segue NEGADA mesmo sob unsafe.
    const parent = new PolicyPermissionEngine({ mode: 'unsafe' });
    const child = parent.forSubAgent(new Set(['read_file']));
    expect(child.decide(call('run_command', { command: 'x' })).decision).toBe('deny');
    // dentro do escopo, o unsafe herdado libera (mesmo COMO do pai).
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
  });
});

// HUNT-SUBAGENT-ESCALATION (privilege-escalation) — vetor #2: o `forSubAgent` INTERSECTA o
// escopo pedido com o escopo do PAI. Antes, ele setava o pedido CRU ⇒ "tools ⊆ pai" valia só
// por COINCIDÊNCIA do wiring (root sem toolScope + cap de profundidade só-root-spawna). Se o
// pai TIVESSE um toolScope (root lançado como `.md`, ou se o cap de profundidade mudasse), um
// filho pedindo tools MAIS amplas — ou nenhuma (= toolset cheio) — escalaria ALÉM do pai.
// Estes casos provam ⊆ pai POR CONSTRUÇÃO (`intersectToolScope`), independente do wiring.
describe('CLI-SEC-11 — forSubAgent INTERSECTA o escopo pai∩filho (⊆ pai por construção)', () => {
  it('pai RESTRITO {read_file,grep} + filho pede {read_file,run_command} ⇒ só read_file (interseção)', () => {
    const parent = new PolicyPermissionEngine({ toolScope: new Set(['read_file', 'grep']) });
    const child = parent.forSubAgent(new Set(['read_file', 'run_command']));
    // read_file ∈ ambos ⇒ passa o gate de escopo (allow).
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
    // run_command ∈ filho mas ∉ pai ⇒ ESCALADA bloqueada: fora do escopo ⇒ DENY.
    expect(child.decide(call('run_command', { command: 'rm -rf /' })).decision).toBe('deny');
    // grep ∈ pai mas ∉ pedido do filho ⇒ fora da interseção ⇒ DENY (o filho só RESTRINGE).
    expect(child.decide(call('grep', { pattern: 'x' })).decision).toBe('deny');
  });

  it('pai RESTRITO {read_file} + filho SEM `tools:` (undefined) ⇒ HERDA a restrição do pai (NÃO toolset cheio)', () => {
    const parent = new PolicyPermissionEngine({ toolScope: new Set(['read_file']) });
    const child = parent.forSubAgent(); // filho sem escopo declarado
    // Sem a interseção, o filho ganharia toolScope=undefined = toolset CHEIO ⇒ run_command
    // passaria o gate (escalada). Agora herda {read_file}: run_command fica FORA ⇒ DENY.
    expect(child.decide(call('run_command', { command: 'x' })).decision).toBe('deny');
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
  });

  it('NÃO-REGRESSÃO: pai IRRESTRITO (root, toolScope undefined) + filho {read_file,run_command} ⇒ pedido do filho como antes', () => {
    // intersectToolScope(undefined, pedido) = pedido ⇒ comportamento idêntico ao de produção.
    const child = new PolicyPermissionEngine().forSubAgent(new Set(['read_file', 'run_command']));
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
    // run_command ∈ escopo (pai não tinha teto) ⇒ passa o gate, cai no piso do pai (ask).
    expect(child.decide(call('run_command', { command: 'echo hi' })).decision).toBe('ask');
  });

  // COMPOSIÇÃO F118 × GS-MD8 — o carve-out de sala (roomExemptTools) atravessa a INTERSEÇÃO
  // do forSubAgent (caminho de PRODUÇÃO). Os testes gs-md8 constroem a engine DIRETO (pulam
  // forSubAgent); aqui provamos a composição real: um pai RESTRITO deriva um filho de SALA
  // ⇒ a interseção (F118) restringe as tools normais E o carve-out (GS-MD8) ainda libera
  // room_post/room_read do gate de escopo. As duas travas convivem, nenhuma anula a outra.
  it('pai RESTRITO {read_file} + filho de SALA (roomExempt) ⇒ interseção restringe E carve-out libera room_post', () => {
    const parent = new PolicyPermissionEngine({ toolScope: new Set(['read_file']) });
    // Caminho de produção: forSubAgent(escopo do filho, ROOM_COORD_TOOLS).
    const child = parent.forSubAgent(new Set(['read_file']), new Set(['room_post', 'room_read']));
    // read_file ∈ interseção ⇒ allow.
    expect(child.decide(call('read_file', { path: 'a' })).decision).toBe('allow');
    // room_post ∉ escopo, MAS no carve-out ⇒ NÃO é deny-por-escopo; cai no piso comms (ask).
    const rp = child.decide(call('room_post', { code: 'x', kind: 'inform', to: 'b', body: 'oi' }));
    expect(rp.decision).not.toBe('deny');
    expect(rp.reason ?? '').not.toMatch(/GS-MD1|fora do toolset/);
    // run_command ∉ interseção E ∉ carve-out ⇒ a escalada segue BLOQUEADA (deny por escopo).
    expect(child.decide(call('run_command', { command: 'x' })).decision).toBe('deny');
  });
});
