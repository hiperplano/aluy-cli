// EST-0982 · /add-dir — o PROMPT do agente conhece as raízes AUTORIZADAS e ORIENTA
// o usuário a ampliar via `/add-dir` (em vez de "não consigo"). E a prova NEGATIVA
// central (CLI-SEC, gate FORTE do `seguranca`): o AGENTE NÃO tem tool de add-dir —
// o toolset nativo não expõe NENHUM caminho p/ ampliar o conjunto de raízes (a
// ampliação é ato do USUÁRIO no slash, fora do alcance do modelo, mesmo em --unsafe).

import { describe, expect, it } from 'vitest';
import { buildMessages, buildSystemPrompt } from '../../src/agent/context.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { CwdPort, ToolPorts } from '../../src/agent/tools/types.js';
import { MemoryCwd, ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

describe('EST-0982 · /add-dir — raízes autorizadas no prompt (system)', () => {
  it('com workspaceRoots, o system LISTA as raízes e orienta o /add-dir', () => {
    const prompt = buildSystemPrompt(NATIVE_TOOLS, undefined, ['/proj', '/home/u/projects/aluy']);
    expect(prompt).toContain('Raízes AUTORIZADAS do workspace');
    expect(prompt).toContain('/proj');
    expect(prompt).toContain('/home/u/projects/aluy');
    // A orientação: o agente NÃO diz "não consigo" — manda o USUÁRIO rodar /add-dir.
    expect(prompt).toContain('/add-dir');
    expect(prompt).toMatch(/só o usuário autoriza/i);
  });

  it('SEM workspaceRoots o prompt é o baseline (não-regressão)', () => {
    const prompt = buildSystemPrompt(NATIVE_TOOLS);
    expect(prompt).not.toContain('Raízes AUTORIZADAS');
  });

  it('buildMessages injeta as raízes SÓ no system (1 system, canal intacto)', () => {
    const messages = buildMessages(NATIVE_TOOLS, [{ role: 'goal', text: 'oi' }], undefined, [
      '/proj',
      '/extra',
    ]);
    const systems = messages.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(1);
    expect(systems[0]!.content).toContain('/extra');
    // nenhuma outra mensagem carrega a seção (não vaza p/ user/assistant).
    expect(
      messages.filter((m) => m.role !== 'system').some((m) => m.content.includes('/extra')),
    ).toBe(false);
  });

  it('o LOOP lê as raízes VIVAS da porta de cwd a cada chamada (lista atualizada entra no turno seguinte)', async () => {
    // CwdPort fake com `roots` MUTÁVEL — simula o usuário rodando /add-dir entre
    // as iterações (a fonte de verdade é a porta; o loop não cacheia).
    const liveRoots: string[] = ['/ws'];
    const base = new MemoryCwd();
    const cwd: CwdPort = {
      get cwd() {
        return base.cwd;
      },
      root: '/ws',
      get roots(): readonly string[] {
        return [...liveRoots];
      },
      setCwd: (p) => base.setCwd(p),
    };
    const { ports } = makePorts({ cwd });
    const model = new ScriptedModelCaller([
      // 1ª iteração: tool-call qualquer (mantém o loop vivo p/ uma 2ª chamada).
      {
        text: '<<<ALUY_TOOL_CALL\n{ "name": "grep", "input": { "pattern": "x" } }\nALUY_TOOL_CALL>>>',
      },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
    });
    // "usuário roda /add-dir" depois da 1ª chamada: muta a lista viva ANTES da 2ª.
    const origCall = model.call.bind(model);
    let first = true;
    model.call = async (args) => {
      const r = await origCall(args);
      if (first) {
        first = false;
        liveRoots.push('/extra-autorizada');
      }
      return r;
    };
    await loop.run('faça algo');
    expect(model.calls).toHaveLength(2);
    // 1ª chamada: só a raiz original. 2ª: a extra JÁ aparece (lista viva).
    expect(model.calls[0]!.systemContent).toContain('/ws');
    expect(model.calls[0]!.systemContent).not.toContain('/extra-autorizada');
    expect(model.calls[1]!.systemContent).toContain('/extra-autorizada');
  });
});

describe('EST-0982 · /add-dir — o agente NÃO se auto-amplia (CLI-SEC)', () => {
  it('o toolset nativo NÃO expõe nenhuma tool de add-dir/add-root', () => {
    const names = NATIVE_TOOLS.map((t) => t.name);
    // snapshot honesto do toolset: qualquer tool nova de ampliação de raiz quebra aqui
    // e exige revisão do `seguranca` (o /add-dir é slash do USUÁRIO, nunca tool).
    expect(names).toEqual([
      'read_file',
      'edit_file',
      'write_file',
      'run_command',
      'run_tests',
      'grep',
      'glob',
      'change_dir',
      // EST-1015 — `update_plan` (checklist, sem efeito externo) entrou no toolset nativo.
      'update_plan',
      // EST-1110 — `perguntar` (pergunta ao usuário, sem efeito externo) entrou no toolset.
      'perguntar',
      // EST-1108 — `add_todo` / `list_todos` / `done_todo` (backlog/TODO persistente).
      'add_todo',
      'list_todos',
      'done_todo',
    ]);
    expect(names.some((n) => /add[-_]?(dir|root)/i.test(n))).toBe(false);
  });

  it('a CwdPort que as tools enxergam só NAVEGA (setCwd) — não há método de ampliar raiz', () => {
    // Prova de superfície: o contrato CwdPort (o que `change_dir` recebe) expõe
    // cwd/root/roots/setCwd — `roots` é SÓ leitura (display/prompt). Não existe
    // addRoot na porta do core; a ampliação vive no locus concreto (slash do usuário).
    const cwd = new MemoryCwd();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(cwd)).filter(
      (n) => n !== 'constructor',
    );
    expect(surface.some((n) => /add/i.test(n))).toBe(false);
  });
});
