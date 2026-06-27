// GUARDA ANTI-PHANTOM-TOOL (dimensão "portas") — prova, contra o wiring REAL
// (`buildSession`), que TODA porta que sustenta uma tool do toolset default está
// de fato INJETADA. O anti-padrão que isto pega: alguém adiciona uma tool ao
// toolset mas esquece de ligar a `ToolPorts` correspondente — a tool entra no
// menu do modelo mas é INERTE ("indisponível/erro claro"). Fail-SAFE (nenhum
// efeito errado), mas é uma tool-FANTASMA: o modelo acha que pode, e não pode.
//
// `built.ports` são "as MESMAS portas que o loop usa" (BuiltSession.ports) — não
// um caminho de teste paralelo. Se um refactor futuro derrubar uma injeção, esta
// guarda fica VERMELHA apontando a porta exata. (Disciplina: provar o conjunto
// montado, não só o módulo isolado.)

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../../src/session/wiring.js';

describe('portas — completude do wiring (guarda anti-phantom-tool)', () => {
  let base: string;
  let workspaceRoot: string;
  let homeAluy: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-ports-'));
    workspaceRoot = join(base, 'project');
    homeAluy = join(base, 'home', '.aluy');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function build() {
    return buildSession({
      workspaceRoot,
      journalBaseDir: homeAluy,
      memoryBaseDir: join(homeAluy, 'memory'),
      todoBaseDir: homeAluy,
      sessionId: 'sess-ports',
      env: {},
    });
  }

  it('as 3 portas OBRIGATÓRIAS (fs/shell/search) estão presentes', () => {
    const { ports } = build();
    expect(ports.fs, 'fs (read_file/write_file/edit_file)').toBeDefined();
    expect(ports.shell, 'shell (run_command)').toBeDefined();
    expect(ports.search, 'search (search_files)').toBeDefined();
  });

  it('toda porta OPCIONAL que sustenta uma tool default está injetada (sem fantasma)', () => {
    const { ports } = build();
    // Cada par porta↔tool: ausente ⇒ a tool vira fantasma (inerte).
    expect(ports.web, 'web → web_fetch/web_search ficariam INERTES').toBeDefined();
    expect(ports.cwd, 'cwd → change_dir ficaria inerte').toBeDefined();
    expect(ports.memory, 'memory → remember/recall ficariam inertes').toBeDefined();
    expect(ports.todo, 'todo → add_todo/list_todos/done_todo ficariam inertes').toBeDefined();
    expect(ports.question, 'question → perguntar ficaria inerte').toBeDefined();
    expect(ports.graph, 'graph → projeção do update_plan (horizonte/aninhamento)').toBeDefined();
    expect(ports.journal, 'journal → snapshot-do-antes da edit_file').toBeDefined();
  });

  it('as portas têm a FORMA esperada (anti-método-fantasma), não só presença', () => {
    const { ports } = build();
    // memory: dupla face ESTREITA (escrita `remember` + leitura `searchFacts`).
    expect(typeof ports.memory?.remember, 'memory.remember').toBe('function');
    expect(typeof ports.memory?.searchFacts, 'memory.searchFacts (recall)').toBe('function');
    // graph: é um ContextGraph real (a projeção do plano chama listBoxes/openBox).
    expect(typeof ports.graph?.listBoxes, 'graph.listBoxes').toBe('function');
    expect(typeof ports.graph?.openBox, 'graph.openBox').toBe('function');
    // todo: contrato estreito add/list/done.
    expect(typeof ports.todo?.add, 'todo.add').toBe('function');
    expect(typeof ports.todo?.list, 'todo.list').toBe('function');
  });

  it('`plan` NÃO é injetado de propósito — o GRAFO é a projeção (documenta a omissão)', () => {
    // PlanPort.set é um sink de PAINEL VIVO opcional; o plano já é renderizado pela
    // OBSERVAÇÃO da tool (renderPlanChecklistFromGraph). Se um dia alguém ligar
    // `plan`, reavalie se duplica a projeção do grafo — não é "bug a corrigir".
    // (subAgents é wired no nível do CONTROLLER, não no objeto `ports` — coberto
    // pelos subagent-*-wiring tests.)
    const { ports } = build();
    expect(ports.plan).toBeUndefined();
  });
});
