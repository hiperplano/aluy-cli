// ADR-0145 (frente b/d) — `NativeTool.when`/`group`: FONTE ÚNICA do "quando usar",
// que alimenta (a) a `description` da tool (frente b, workhorses fracas na
// auditoria) e (b) o menu do `capabilities` (frente d). Prova:
//  • as 5 tools workhorse (read_file/run_command/grep/glob/change_dir) declaram
//    `when`, e a `description` EMBUTE o MESMO texto (sem duplicar verdade);
//  • `group` está presente e correto nas famílias principais (arquivo/busca/
//    execução/delegação/memória/assíncrono/web/plano);
//  • tools MCP (dado de terceiro) NÃO declaram `when`/`group` — o grupo `'mcp'` é
//    SEMPRE inferido pelo prefixo do nome, nunca por um campo auto-declarado.

import { describe, expect, it } from 'vitest';
import {
  readFileTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  runTestsTool,
  grepTool,
  globTool,
  changeDirTool,
  addTodoTool,
  listTodosTool,
  doneTodoTool,
} from '../../src/agent/tools/native.js';
import { capabilitiesTool, listToolsTool } from '../../src/agent/tools/capabilities.js';
import { spawnAgentTool } from '../../src/agent/tools/spawn-agent.js';
import { rememberTool } from '../../src/agent/memory/remember-tool.js';
import { recallTool } from '../../src/agent/memory/recall-tool.js';
import { PLAN_TOOL } from '../../src/agent/tools/plan.js';
import { QUESTION_TOOL } from '../../src/agent/tools/question.js';
import { WEB_TOOLS } from '../../src/agent/web/web-tools.js';
import { buildMonitorTools } from '../../src/agent/monitor/monitor-tools.js';
import { EventQueue } from '../../src/agent/monitor/event-queue.js';
import { MonitorStore } from '../../src/agent/monitor/monitor-store.js';
import { adaptMcpTool } from '../../src/mcp/tool-adapter.js';
import type { DiscoveredMcpTool } from '../../src/mcp/client.js';

const WEAK_WORKHORSE_TOOLS = [readFileTool, runCommandTool, grepTool, globTool, changeDirTool];

describe('ADR-0145 (frente b) — `when` é a fonte única (description embute o MESMO texto)', () => {
  it.each(WEAK_WORKHORSE_TOOLS.map((t) => [t.name, t] as const))(
    '%s declara `when` e a description contém EXATAMENTE esse texto',
    (_name, tool) => {
      expect(tool.when).toBeDefined();
      expect(tool.when!.length).toBeGreaterThan(0);
      expect(tool.description).toContain(tool.when!);
      expect(tool.description).toContain('Use QUANDO');
    },
  );
});

describe('ADR-0145 (frente d) — `group` agrupa as tools nativas por intenção', () => {
  it('arquivo: read_file/edit_file/write_file/change_dir', () => {
    expect(readFileTool.group).toBe('arquivo');
    expect(editFileTool.group).toBe('arquivo');
    expect(writeFileTool.group).toBe('arquivo');
    expect(changeDirTool.group).toBe('arquivo');
  });

  it('busca: grep/glob', () => {
    expect(grepTool.group).toBe('busca');
    expect(globTool.group).toBe('busca');
  });

  it('execução: run_command/run_tests', () => {
    expect(runCommandTool.group).toBe('execucao');
    expect(runTestsTool.group).toBe('execucao');
  });

  it('delegação: spawn_agent', () => {
    expect(spawnAgentTool.group).toBe('delegacao');
  });

  it('memória: remember/recall', () => {
    expect(rememberTool.group).toBe('memoria');
    expect(recallTool.group).toBe('memoria');
  });

  it('assíncrono: monitor/monitors/monitor_cancel/watch_command', () => {
    const store = new MonitorStore();
    const queue = new EventQueue(() => {});
    const tools = buildMonitorTools(store, queue, () => new Date().toISOString());
    for (const t of tools) expect(t.group).toBe('assincrono');
  });

  it('web: web_fetch/web_search', () => {
    for (const t of WEB_TOOLS) expect(t.group).toBe('web');
  });

  it('plano: update_plan/perguntar/add_todo/list_todos/done_todo', () => {
    expect(PLAN_TOOL.group).toBe('plano');
    expect(QUESTION_TOOL.group).toBe('plano');
    expect(addTodoTool.group).toBe('plano');
    expect(listTodosTool.group).toBe('plano');
    expect(doneTodoTool.group).toBe('plano');
  });

  it('capabilities/list_tools: `outro` (auto-descoberta, sem família própria)', () => {
    expect(capabilitiesTool.group).toBe('outro');
    expect(listToolsTool.group).toBe('outro');
  });
});

describe('ADR-0145 (frente d) — tool MCP NUNCA declara `when`/`group` (dado de terceiro)', () => {
  it('adaptMcpTool não seta when/group — o grupo `mcp` é sempre INFERIDO do prefixo do nome', () => {
    const discovered: DiscoveredMcpTool = {
      server: 'playwright',
      descriptor: { name: 'browser_click', description: 'clica um elemento', inputSchema: {} },
      transport: {
        async callTool() {
          return { ok: true, content: 'x' };
        },
      } as unknown as DiscoveredMcpTool['transport'],
    };
    const tool = adaptMcpTool(discovered);
    expect(tool.name).toBe('mcp__playwright__browser_click');
    expect(tool.when).toBeUndefined();
    expect(tool.group).toBeUndefined();
  });
});
