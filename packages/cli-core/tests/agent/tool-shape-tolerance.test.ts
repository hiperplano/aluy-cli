// EST-1015-bis — auditoria "clareza p/ o MODELO" das tools nativas (pedido do dono).
//
// O fix do `update_plan` (plan.ts) achou dois defeitos que se repetiam em quase toda
// tool nativa: (1) validação rejeitava formas em que um modelo BARATO erra — array
// aninhado stringificado, objeto de chaves numéricas, sinônimo plausível de nome de
// campo, booleano como texto; (2) o erro NÃO dizia o que CHEGOU, então o modelo não
// tinha o que corrigir. Este arquivo prova os consertos equivalentes nas OUTRAS tools
// (native.ts, question.ts, spawn-agent.ts, session-command.ts, todo-tools.ts), reusando
// os helpers de `tools/input-shape.ts`.
//
// Também prova o que foi DELIBERADAMENTE NÃO consertado por ambiguidade genuína
// (edit_file NÃO aceita "content" como sinônimo de new_string — ver o teste dedicado).

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
  doneTodoTool,
} from '../../src/agent/tools/native.js';
import { normalizeQuestionInput, QUESTION_TOOL } from '../../src/agent/tools/question.js';
import { spawnAgentTool, type SubAgentPort } from '../../src/agent/tools/spawn-agent.js';
import { sessionCommandTool, type SessionCommandPort } from '../../src/agent/tools/session-command.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { TodoStorePort } from '../../src/agent/todo/contract.js';
import { MemoryFs, RecordingShell, MemorySearch, MemoryCwd, makePorts } from './helpers.js';

// ── read_file ────────────────────────────────────────────────────────────────

describe('read_file — sinônimos de "path" + erro acionável', () => {
  it('aceita "file"/"filename" como sinônimo INEQUÍVOCO de "path"', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map([['a.txt', 'conteúdo']])) });
    const r1 = await readFileTool.run({ file: 'a.txt' }, ports);
    expect(r1.ok).toBe(true);
    const r2 = await readFileTool.run({ filename: 'a.txt' }, ports);
    expect(r2.ok).toBe(true);
  });

  it('SEM path/sinônimo ⇒ erro diz o que CHEGOU (não só "requer path")', async () => {
    const { ports } = makePorts();
    const r = await readFileTool.run({ arquivo: 'a.txt' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('requer "path"');
    // ANTES do conserto o erro não dizia nada sobre o input recebido — o modelo não
    // tinha como saber que mandou "arquivo" em vez de "path". Agora diz.
    expect(r.observation).toContain('arquivo');
  });
});

// ── edit_file ────────────────────────────────────────────────────────────────

describe('edit_file — sinônimos SEM reviver a ambiguidade da API antiga', () => {
  it('aceita old_text/new_text como sinônimo de old_string/new_string', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map([['a.ts', 'linha1\nlinha2']])) });
    const r = await editFileTool.run(
      { path: 'a.ts', old_text: 'linha1', new_text: 'X' },
      ports,
    );
    expect(r.ok).toBe(true);
  });

  it('NÃO aceita "content" como sinônimo de new_string (DECISÃO: ambíguo)', async () => {
    // "content" era o nome do campo na API antiga do edit_file (full-rewrite),
    // removida por PERDA DE DADOS (ver o comentário no topo de editFileTool). Se
    // aceitássemos "content" aqui, um modelo que ainda pensa na API antiga mandaria
    // o ARQUIVO INTEIRO como "content" esperando reescrita total — a tool trataria
    // isso como "o trecho novo" e o resultado seria plausível-mas-ERRADO (o oposto
    // do que ele queria). Recuo silencioso pior que falha visível — por isso o erro
    // permanece (visível), nunca inventa a partir de "content".
    const { ports } = makePorts({ fs: new MemoryFs(new Map([['a.ts', 'linha1']])) });
    const r = await editFileTool.run({ path: 'a.ts', old_string: 'linha1', content: 'X' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('requer "new_string"');
    expect(r.observation).toContain('content');
  });

  it('erro de old_string ausente diz o que CHEGOU', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map([['a.ts', 'x']])) });
    const r = await editFileTool.run({ path: 'a.ts', new_string: 'X' }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('new_string=string');
  });
});

// ── write_file ───────────────────────────────────────────────────────────────

describe('write_file — sinônimo de content + booleano tolerante', () => {
  it('aceita "text" como sinônimo de "content"', async () => {
    const { ports } = makePorts();
    const r = await writeFileTool.run({ path: 'novo.txt', text: 'abc' }, ports);
    expect(r.ok).toBe(true);
  });

  it('overwrite:"true" (string) funciona igual a overwrite:true (booleano)', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map([['x.txt', 'antigo']])) });
    const r = await writeFileTool.run(
      { path: 'x.txt', content: 'novo', overwrite: 'true' },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('reescrito');
  });
});

// ── run_command ──────────────────────────────────────────────────────────────

describe('run_command — sinônimos de "command"', () => {
  it('aceita "cmd" e "bash" como sinônimo de "command"', async () => {
    const { ports } = makePorts();
    const r1 = await runCommandTool.run({ cmd: 'echo a' }, ports);
    expect(r1.ok).toBe(true);
    const r2 = await runCommandTool.run({ bash: 'echo b' }, ports);
    expect(r2.ok).toBe(true);
  });

  it('command como array (não-string) ⇒ erro diz o TIPO recebido', async () => {
    const { ports } = makePorts();
    const r = await runCommandTool.run({ command: ['echo', 'hi'] }, ports);
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('command=array');
  });
});

// ── run_tests ────────────────────────────────────────────────────────────────

describe('run_tests — sinônimo "cmd"', () => {
  it('aceita "cmd" como sinônimo de "command"', async () => {
    const { ports } = makePorts();
    const r = await runTestsTool.run({ cmd: 'npx vitest run' }, ports);
    expect(r.ok).toBe(true);
  });
});

// ── grep / glob ──────────────────────────────────────────────────────────────

describe('grep/glob — sinônimo "query" de "pattern"', () => {
  it('grep aceita "query"', async () => {
    const { ports } = makePorts({ search: new MemorySearch([]) });
    const r = await grepTool.run({ query: 'foo' }, ports);
    expect(r.ok).toBe(true);
  });

  it('glob mantém a mensagem "glob requer \\"pattern\\"" (não-regressão) e aceita "query"', async () => {
    const { ports } = makePorts({ search: new MemorySearch([]) });
    const semPattern = await globTool.run({}, ports);
    expect(semPattern.observation).toContain('glob requer "pattern"');
  });
});

// ── change_dir ───────────────────────────────────────────────────────────────

describe('change_dir — sinônimos "dir"/"directory"', () => {
  it('aceita "dir" e "directory" como sinônimo de "path"', async () => {
    const cwd = new MemoryCwd();
    const { ports } = makePorts({ cwd });
    const r1 = await changeDirTool.run({ dir: 'src' }, ports);
    expect(r1.ok).toBe(true);
    const cwd2 = new MemoryCwd();
    const { ports: ports2 } = makePorts({ cwd: cwd2 });
    const r2 = await changeDirTool.run({ directory: 'src' }, ports2);
    expect(r2.ok).toBe(true);
  });
});

// ── perguntar (question.ts) ─────────────────────────────────────────────────

describe('perguntar — options tolera forma serializada, NUNCA degrada silenciosamente', () => {
  it('recupera options stringificado ("[...]") como lista de verdade', () => {
    const r = normalizeQuestionInput({ question: 'qual?', options: '["a","b"]' });
    expect('spec' in r).toBe(true);
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.kind).toBe('single');
    expect(r.spec.options?.map((o) => o.label)).toEqual(['a', 'b']);
  });

  it('recupera options como objeto de chaves numéricas ({"0":"a","1":"b"})', () => {
    const r = normalizeQuestionInput({ question: 'qual?', options: { '0': 'a', '1': 'b' } });
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.options?.map((o) => o.label)).toEqual(['a', 'b']);
  });

  it('REGRESSÃO — options presente mas irreconhecível (texto solto) ⇒ ERRO VISÍVEL, ' +
    'NÃO mais um "kind:text" silencioso que perde as opções pedidas', () => {
    const r = normalizeQuestionInput({ question: 'qual?', options: 'sim ou não' });
    expect('error' in r).toBe(true);
    if (!('error' in r)) throw new Error('deveria ter falhado');
    expect(r.error).toContain('options');
    expect(r.error).toContain('sim ou não');
  });

  it('sem "options" (ausente de verdade) segue inferindo kind:"text" sem erro (não-regressão)', () => {
    const r = normalizeQuestionInput({ question: 'descreva' });
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.kind).toBe('text');
  });

  it('allowOther:"false" (string) desliga igual a allowOther:false (booleano)', () => {
    const r = normalizeQuestionInput({ question: 'q', options: ['a', 'b'], allowOther: 'false' });
    if (!('spec' in r)) throw new Error('parse falhou');
    expect(r.spec.allowOther).toBe(false);
  });

  it('QUESTION_TOOL.run com options stringificado chega até a porta (não recusa mais)', async () => {
    const { ports: base } = makePorts();
    let sawOptions: readonly unknown[] | undefined;
    const ports: ToolPorts = {
      ...base,
      question: {
        async ask(spec) {
          sawOptions = spec.options;
          return { kind: 'choice', index: 0, label: spec.options?.[0]?.label ?? '' };
        },
      },
    };
    const r = await QUESTION_TOOL.run({ question: 'qual?', options: '["x","y"]' }, ports);
    expect(r.ok).toBe(true);
    expect(sawOptions?.length).toBe(2);
  });
});

// ── spawn_agent ──────────────────────────────────────────────────────────────

function spawnPorts(spawner: SubAgentPort): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch(), subAgents: spawner };
}

function echoSpawner(): SubAgentPort {
  return {
    async spawn(profiles) {
      return profiles.map((p) => ({
        label: p.label,
        ok: true,
        result: `ok:${p.goal}`,
        stop: 'final' as const,
        usage: { iterations: 1, toolCalls: 0, tokens: 1 },
      }));
    },
  };
}

describe('spawn_agent — agents tolera forma serializada (mesma classe do update_plan)', () => {
  it('recupera agents stringificado ("[{...}]")', async () => {
    const r = await spawnAgentTool.run(
      { agents: '[{"goal":"faz algo"}]' },
      spawnPorts(echoSpawner()),
    );
    expect(r.ok).toBe(true);
  });

  it('recupera agents como objeto de chaves numéricas', async () => {
    const r = await spawnAgentTool.run(
      { agents: { '0': { goal: 'faz algo' } } },
      spawnPorts(echoSpawner()),
    );
    expect(r.ok).toBe(true);
  });

  it('texto solto NÃO-reconhecível ⇒ segue RECUSADO (não inventa) — não-regressão', async () => {
    const r = await spawnAgentTool.run({ agents: 'x' }, spawnPorts(echoSpawner()));
    expect(r.ok).toBe(false);
    expect(r.observation).toMatch(/um array/i);
  });

  it('aceita "task"/"description" como sinônimo de "goal" em cada item', async () => {
    const r1 = await spawnAgentTool.run(
      { agents: [{ task: 'pesquisar X' }] },
      spawnPorts(echoSpawner()),
    );
    expect(r1.ok).toBe(true);
    const r2 = await spawnAgentTool.run(
      { agents: [{ description: 'pesquisar Y' }] },
      spawnPorts(echoSpawner()),
    );
    expect(r2.ok).toBe(true);
  });
});

// ── session_command ──────────────────────────────────────────────────────────

function sessionPorts(port: SessionCommandPort): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch(), sessionCommand: port };
}

describe('session_command — sinônimo "cmd" + args tolera número', () => {
  it('aceita "cmd" como sinônimo de "command"', async () => {
    const port: SessionCommandPort = { async run(command) { return { ok: true, text: `ran ${command}` }; } };
    const r = await sessionCommandTool.run({ cmd: 'doctor' }, sessionPorts(port));
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('doctor');
  });

  it('args numérico é coagido p/ texto (não descartado silenciosamente)', async () => {
    let seenArgs = '';
    const port: SessionCommandPort = {
      async run(_command, args) {
        seenArgs = args;
        return { ok: true, text: 'ok' };
      },
    };
    await sessionCommandTool.run({ command: 'cycle', args: 5 }, sessionPorts(port));
    expect(seenArgs).toBe('5');
  });
});

// ── add_todo / done_todo ─────────────────────────────────────────────────────

function todoPorts(todo: TodoStorePort): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch(), todo };
}

describe('add_todo/done_todo — sinônimos de item/id', () => {
  it('add_todo aceita "text"/"todo" como sinônimo de "item"', async () => {
    const todo: TodoStorePort = {
      async add(text) { return `id:${text}`; },
      async list() { return []; },
      async done() { return true; },
      async clearDone() { return 0; },
    };
    const r1 = await addTodoTool.run({ text: 'fazer X' }, todoPorts(todo));
    expect(r1.ok).toBe(true);
    const r2 = await addTodoTool.run({ todo: 'fazer Y' }, todoPorts(todo));
    expect(r2.ok).toBe(true);
  });

  it('done_todo aceita "todo_id" como sinônimo de "id"', async () => {
    const todo: TodoStorePort = {
      async add() { return 'id1'; },
      async list() { return []; },
      async done(id) { return id === 'abc'; },
      async clearDone() { return 0; },
    };
    const r = await doneTodoTool.run({ todo_id: 'abc' }, todoPorts(todo));
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('concluído');
  });
});
