// EST-0964 · EST-INIT-01 — `/init`: gera ALUY.md + scaffold `.aluy/` pela CATRACA.
//
// Prova:
//   - o template é montado a partir dos fatos detectados (nome/stack/scripts/dirs);
//   - o scaffold cria 4 arquivos: ALUY.md + .aluy/{agents,workflows,commands}/exemplo.md;
//   - a escrita PASSA PELA CATRACA: deny ⇒ não escreve; ask-deny ⇒ não escreve;
//     ask-approve / allow ⇒ escreve via write_file (confinado);
//   - IDEMPOTENTE: arquivo que já existe NÃO é sobrescrito (skip + avisa);
//   - os exemplos são CARREGÁVEIS pelos loaders (parseAgentProfile/parseWorkflow/parseUserCommand).

import { describe, expect, it } from 'vitest';
import type {
  AskRequest,
  AskResolution,
  AskResolver,
  FileSystemPort,
  PermissionEngine,
  PermissionVerdict,
  SearchPort,
  SearchOutcome,
  ShellPort,
  ShellResult,
  ToolCall,
  ToolPorts,
} from '@aluy/cli-core';
import {
  parseAgentProfile,
  isAgentProfileError,
  parseWorkflow,
  isWorkflowError,
  parseUserCommand,
} from '@aluy/cli-core';
import {
  buildAgentMdTemplate,
  buildExampleAgent,
  buildExampleWorkflow,
  buildExampleCommand,
  buildScaffoldSystemPrompt,
  analyzeWorkspace,
  runInit,
} from '../../src/slash/init.js';

// ── fakes locais (in-memory; sem fs/rede) ─────────────────────────────────────
class MemFs implements FileSystemPort {
  constructor(readonly files = new Map<string, string>()) {}
  async readFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeFile(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
}
class NoShell implements ShellPort {
  async exec(): Promise<ShellResult> {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}
/** Search fake: devolve ≥1 acerto p/ os dirs declarados "presentes". */
class DirSearch implements SearchPort {
  constructor(private readonly present: ReadonlySet<string>) {}
  async search(_pattern: string, path: string): Promise<SearchOutcome> {
    const matches = this.present.has(path) ? [{ path: `${path}/x.ts`, line: 1, text: '' }] : [];
    return { matches, truncated: {} };
  }
}
function ports(fs: MemFs, present: string[] = []): ToolPorts {
  return { fs, shell: new NoShell(), search: new DirSearch(new Set(present)) };
}

const allowAll: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict => ({ decision: 'allow', reason: `allow ${c.name}` }),
};
const denyAll: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict => ({ decision: 'deny', reason: `deny ${c.name}` }),
};
/** Engine que pede ASK (com efeito de diff) p/ qualquer write. */
const askWrite: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict => ({
    decision: 'ask',
    reason: 'confirme a escrita',
    category: 'default',
    effect: { kind: 'diff', tool: c.name, exact: `+++ ${String(c.input['path'])}` },
  }),
};
/** Resolver fixo (approve-once / deny) p/ o ask. */
function resolver(answer: AskResolution): AskResolver & { seen: AskRequest[] } {
  const seen: AskRequest[] = [];
  return {
    seen,
    async resolve(req: AskRequest): Promise<AskResolution> {
      seen.push(req);
      return answer;
    },
  };
}
const noopResolver: AskResolver = {
  async resolve() {
    return { kind: 'deny' };
  },
};

// ── Scaffold paths ─────────────────────────────────────────────────────────
const AGENT_EXAMPLE = '.aluy/agents/exemplo.md';
const WORKFLOW_EXAMPLE = '.aluy/workflows/exemplo.md';
const COMMAND_EXAMPLE = '.aluy/commands/exemplo.md';
const ALL_4 = ['ALUY.md', AGENT_EXAMPLE, WORKFLOW_EXAMPLE, COMMAND_EXAMPLE];

describe('EST-0964 · buildAgentMdTemplate (puro)', () => {
  it('sem fatos ⇒ template válido com placeholders (orienta o dono)', () => {
    const md = buildAgentMdTemplate();
    expect(md).toContain('# este projeto');
    expect(md).toContain('## Comandos');
    expect(md).toContain('## Estrutura');
    expect(md).toContain('<!--'); // placeholders p/ preencher
  });

  it('com fatos ⇒ preenche título, stack, comandos e estrutura', () => {
    const md = buildAgentMdTemplate({
      name: 'meu-projeto',
      description: 'agente de terminal',
      stack: 'TypeScript / Node',
      scripts: { build: 'tsc -b', test: 'vitest run' },
      topDirs: ['packages', 'docs'],
    });
    expect(md).toContain('# meu-projeto');
    expect(md).toContain('agente de terminal');
    expect(md).toContain('TypeScript / Node');
    expect(md).toContain('npm run build');
    expect(md).toContain('npm run test');
    expect(md).toContain('`packages/`');
    expect(md).toContain('`docs/`');
  });
});

describe('EST-0964 · analyzeWorkspace (confinado, best-effort)', () => {
  it('lê package.json ⇒ name/description/scripts/stack', async () => {
    const fs = new MemFs(
      new Map([
        [
          'package.json',
          JSON.stringify({
            name: 'pkg',
            description: 'desc',
            scripts: { build: 'b', test: 't', irrelevante: 'x' },
            devDependencies: { typescript: '^5' },
          }),
        ],
      ]),
    );
    const facts = await analyzeWorkspace(ports(fs, ['src']), 'fallback-name');
    expect(facts.name).toBe('pkg'); // package.json vence o fallback
    expect(facts.description).toBe('desc');
    expect(facts.stack).toBe('TypeScript / Node');
    expect(facts.scripts).toEqual({ build: 'b', test: 't' }); // só os interessantes
    expect(facts.topDirs).toContain('src');
  });

  it('sem package.json ⇒ usa o nome da raiz e segue sem quebrar', async () => {
    const facts = await analyzeWorkspace(ports(new MemFs(), []), 'raiz');
    expect(facts.name).toBe('raiz');
    expect(facts.scripts).toBeUndefined();
  });
});

describe('EST-INIT-01 · exemplos são VÁLIDOS (carregáveis pelos loaders)', () => {
  it('agente de exemplo ⇒ parseAgentProfile aceita (name/description/tools/corpo)', () => {
    const raw = buildExampleAgent();
    const p = parseAgentProfile('exemplo.md', raw, 'project');
    expect(isAgentProfileError(p)).toBe(false);
    if (!isAgentProfileError(p)) {
      expect(p.name).toBe('exemplo');
      expect(p.description).toBe('Agente de exemplo — revisa arquivos e sugere melhorias.');
      expect(p.tools).toEqual(['read_file', 'grep']);
      expect(p.systemPrompt).toContain('revisor de código');
      expect(p.origin).toBe('project');
    }
  });

  it('workflow de exemplo ⇒ parseWorkflow aceita (name/description/atividades)', () => {
    const raw = buildExampleWorkflow();
    const wf = parseWorkflow('exemplo.md', raw, 'project');
    expect(isWorkflowError(wf)).toBe(false);
    if (!isWorkflowError(wf)) {
      expect(wf.name).toBe('exemplo');
      expect(wf.description).toBe('Workflow de exemplo — analisa e melhora um arquivo.');
      expect(wf.activities).toHaveLength(3);
      expect(wf.activities[0]!.id).toBe('analisar');
      expect(wf.activities[1]!.id).toBe('melhorar');
      expect(wf.activities[2]!.id).toBe('verificar');
      expect(wf.origin).toBe('project');
    }
  });

  it('comando de exemplo ⇒ parseUserCommand aceita (name/summary/template)', () => {
    const raw = buildExampleCommand();
    const cmd = parseUserCommand('exemplo.md', raw);
    expect(cmd).not.toBeNull();
    if (cmd) {
      expect(cmd.name).toBe('exemplo');
      expect(cmd.summary).toContain('Analisa um arquivo');
      expect(cmd.template).toContain('$ARGUMENTS');
    }
  });
});

describe('EST-INIT-01 · scaffold — cria os 4 arquivos pela CATRACA', () => {
  it('catraca ALLOW ⇒ cria ALUY.md + 3 exemplos .aluy/', async () => {
    const fs = new MemFs();
    const res = await runInit({
      ports: ports(fs),
      permission: allowAll,
      askResolver: noopResolver,
    });
    expect(res.created).toBe(true);
    // Os 4 arquivos foram criados
    expect(fs.files.has('ALUY.md')).toBe(true);
    expect(fs.files.has(AGENT_EXAMPLE)).toBe(true);
    expect(fs.files.has(WORKFLOW_EXAMPLE)).toBe(true);
    expect(fs.files.has(COMMAND_EXAMPLE)).toBe(true);
    expect(res.createdPaths).toEqual(ALL_4);
    expect(res.skippedPaths).toEqual([]);
  });

  it('catraca DENY ⇒ NÃO escreve NENHUM arquivo', async () => {
    const fs = new MemFs();
    const res = await runInit({
      ports: ports(fs),
      permission: denyAll,
      askResolver: noopResolver,
    });
    expect(res.created).toBe(false);
    expect(fs.files.has('ALUY.md')).toBe(false);
    expect(fs.files.has(AGENT_EXAMPLE)).toBe(false);
    expect(res.note.lines.join(' ')).toContain('recusados');
  });

  it('catraca ASK + usuário RECUSA ⇒ NÃO escreve nenhum arquivo', async () => {
    const fs = new MemFs();
    const r = resolver({ kind: 'deny' });
    const res = await runInit({ ports: ports(fs), permission: askWrite, askResolver: r });
    expect(res.created).toBe(false);
    expect(fs.files.has('ALUY.md')).toBe(false);
    // Cada arquivo foi perguntado (4 asks, 1 por arquivo)
    expect(r.seen).toHaveLength(4);
  });

  it('catraca ASK + usuário APROVA ⇒ escreve todos os 4 arquivos', async () => {
    const fs = new MemFs();
    const r = resolver({ kind: 'approve-once' });
    const res = await runInit({
      ports: ports(fs, ['packages']),
      permission: askWrite,
      askResolver: r,
      rootName: 'meu-projeto',
    });
    expect(res.created).toBe(true);
    expect(fs.files.get('ALUY.md')).toContain('# meu-projeto');
    expect(fs.files.get(AGENT_EXAMPLE)).toContain('name: exemplo');
    expect(fs.files.get(WORKFLOW_EXAMPLE)).toContain('name: exemplo');
    expect(fs.files.get(COMMAND_EXAMPLE)).toContain('$ARGUMENTS');
    expect(r.seen).toHaveLength(4); // 4 asks, 1 por arquivo
  });
});

describe('EST-INIT-01 · idempotência — não sobrescreve', () => {
  it('ALUY.md existente ⇒ skip ALUY.md, mas cria .aluy/ que faltam', async () => {
    const fs = new MemFs(new Map([['ALUY.md', '# do dono — não mexer']]));
    const res = await runInit({
      ports: ports(fs),
      permission: allowAll,
      askResolver: noopResolver,
    });
    // ALUY.md intacto
    expect(fs.files.get('ALUY.md')).toBe('# do dono — não mexer');
    // Mas os 3 exemplos .aluy/ foram criados
    expect(fs.files.has(AGENT_EXAMPLE)).toBe(true);
    expect(fs.files.has(WORKFLOW_EXAMPLE)).toBe(true);
    expect(fs.files.has(COMMAND_EXAMPLE)).toBe(true);
    expect(res.created).toBe(true);
    expect(res.skippedPaths).toContain('ALUY.md');
    expect(res.createdPaths).toContain(AGENT_EXAMPLE);
  });

  it('ALUY.md + 3 exemplos existentes ⇒ NADA criado (tudo skip)', async () => {
    const existing = new Map([
      ['ALUY.md', '# do dono'],
      [AGENT_EXAMPLE, '# agente do dono'],
      [WORKFLOW_EXAMPLE, '# workflow do dono'],
      [COMMAND_EXAMPLE, '# comando do dono'],
    ]);
    const fs = new MemFs(existing);
    const res = await runInit({
      ports: ports(fs),
      permission: allowAll,
      askResolver: noopResolver,
    });
    expect(res.created).toBe(false);
    // Todos os arquivos preservados
    expect(fs.files.get('ALUY.md')).toBe('# do dono');
    expect(fs.files.get(AGENT_EXAMPLE)).toBe('# agente do dono');
    expect(fs.files.get(WORKFLOW_EXAMPLE)).toBe('# workflow do dono');
    expect(fs.files.get(COMMAND_EXAMPLE)).toBe('# comando do dono');
    expect(res.skippedPaths).toEqual(ALL_4);
    expect(res.createdPaths).toEqual([]);
    expect(res.note.lines.join(' ')).toContain('completa');
  });

  it('2ª chamada ⇒ idempotente (nada muda)', async () => {
    const fs = new MemFs();
    // 1ª chamada: cria tudo
    const r1 = await runInit({ ports: ports(fs), permission: allowAll, askResolver: noopResolver });
    expect(r1.created).toBe(true);
    expect(r1.createdPaths).toEqual(ALL_4);

    const after1 = new Map(fs.files);

    // 2ª chamada: nada cria (tudo já existe)
    const r2 = await runInit({ ports: ports(fs), permission: allowAll, askResolver: noopResolver });
    expect(r2.created).toBe(false);
    expect(r2.createdPaths).toEqual([]);
    expect(r2.skippedPaths).toEqual(ALL_4);

    // Conteúdo inalterado
    for (const [k, v] of after1) {
      expect(fs.files.get(k)).toBe(v);
    }
  });

  it('ALUY.md existente + overwrite ⇒ regenera ALUY.md + cria .aluy/', async () => {
    const fs = new MemFs(new Map([['ALUY.md', 'velho']]));
    const res = await runInit({
      ports: ports(fs),
      permission: allowAll,
      askResolver: noopResolver,
      overwrite: true,
    });
    expect(res.created).toBe(true);
    expect(fs.files.get('ALUY.md')).not.toBe('velho');
    expect(fs.files.get('ALUY.md')).toContain('# este projeto');
    expect(fs.files.has(AGENT_EXAMPLE)).toBe(true);
    expect(res.note.lines.join(' ')).toContain('regenerado');
  });

  it('overwrite NÃO sobrescreve exemplos (só ALUY.md)', async () => {
    const existing = new Map([
      ['ALUY.md', 'velho'],
      [AGENT_EXAMPLE, '# agente do dono — curado'],
    ]);
    const fs = new MemFs(existing);
    const res = await runInit({
      ports: ports(fs),
      permission: allowAll,
      askResolver: noopResolver,
      overwrite: true,
    });
    expect(res.created).toBe(true);
    // ALUY.md regenerado
    expect(fs.files.get('ALUY.md')).not.toBe('velho');
    // Exemplo do dono PRESERVADO (overwrite só vale p/ ALUY.md)
    expect(fs.files.get(AGENT_EXAMPLE)).toBe('# agente do dono — curado');
  });
});

describe('EST-INIT-01 · exemplos escritos são CARREGÁVEIS', () => {
  it('exemplos criados pelo scaffold passam nos parsers', async () => {
    const fs = new MemFs();
    await runInit({ ports: ports(fs), permission: allowAll, askResolver: noopResolver });

    // Agente
    const agentRaw = fs.files.get(AGENT_EXAMPLE)!;
    const agent = parseAgentProfile('exemplo.md', agentRaw, 'project');
    expect(isAgentProfileError(agent)).toBe(false);

    // Workflow
    const wfRaw = fs.files.get(WORKFLOW_EXAMPLE)!;
    const wf = parseWorkflow('exemplo.md', wfRaw, 'project');
    expect(isWorkflowError(wf)).toBe(false);

    // Comando
    const cmdRaw = fs.files.get(COMMAND_EXAMPLE)!;
    const cmd = parseUserCommand('exemplo.md', cmdRaw);
    expect(cmd).not.toBeNull();
  });
});

describe('EST-0964 · runInit — regressão (comportamento original preservado)', () => {
  it('só ALUY.md existente ⇒ avisa que .aluy/ foi criado', async () => {
    const fs = new MemFs(new Map([['ALUY.md', '# do dono — não mexer']]));
    const res = await runInit({
      ports: ports(fs),
      permission: allowAll,
      askResolver: noopResolver,
    });
    expect(res.created).toBe(true); // criou os exemplos .aluy/
    expect(fs.files.get('ALUY.md')).toBe('# do dono — não mexer');
    expect(res.note.lines.join(' ')).toContain('exemplos');
  });
});

// ── EST-INIT-02 · prompt-driven buildScaffoldSystemPrompt ──────────────────

describe('EST-INIT-02 · buildScaffoldSystemPrompt (puro)', () => {
  it('contém a descrição do usuário', () => {
    const goal = buildScaffoldSystemPrompt('app Next.js de e-commerce com backend Python');
    expect(goal).toContain('app Next.js de e-commerce com backend Python');
  });

  it('contém os 3 formatos: AGENTE (name/description/tools + persona)', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    // Formato de agente
    expect(goal).toContain('name: nome-do-agente');
    expect(goal).toContain('description:');
    expect(goal).toContain('tools:');
    expect(goal).toContain('Você é um [persona]');
    // Deve mencionar que tools AUSENTE = herda, PRESENTE = restringe
    expect(goal).toContain('herda o toolset do pai');
    expect(goal).toContain('RESTRINGE');
  });

  it('contém os 3 formatos: WORKFLOW (name + atividades numeradas com agente opcional)', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    // Formato de workflow
    expect(goal).toContain('name: nome-do-workflow');
    expect(goal).toContain('description:');
    expect(goal).toContain('1. passo-um');
    expect(goal).toContain('[agente]');
    expect(goal).toContain('2. passo-dois');
    expect(goal).toContain('—'); // em-dash separador
  });

  it('contém os 3 formatos: COMANDO (summary + template com $ARGUMENTS)', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    // Formato de comando
    expect(goal).toContain('summary:');
    expect(goal).toContain('$ARGUMENTS');
    expect(goal).toContain('Template do prompt');
  });

  it('contém o formato do ALUY.md (com seções)', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    expect(goal).toContain('## O que é');
    expect(goal).toContain('## Stack');
    expect(goal).toContain('## Comandos');
    expect(goal).toContain('## Estrutura');
    expect(goal).toContain('## Convenções');
  });

  it('orienta a criar em .aluy/ com caminhos relativos', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    expect(goal).toContain('.aluy/agents/');
    expect(goal).toContain('.aluy/workflows/');
    expect(goal).toContain('.aluy/commands/');
    expect(goal).toContain('ALUY.md');
  });

  it('orienta a usar write_file e NÃO sobrescrever', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    expect(goal).toContain('write_file');
    expect(goal).toContain('NÃO sobrescreva');
  });

  it('descrição com whitespace extra é normalizada com trim()', () => {
    const goal = buildScaffoldSystemPrompt('  app React com API Node  ');
    expect(goal).toContain('app React com API Node');
    // O trim() já foi aplicado — o último caractere não deve ter espaços extras
    expect(goal.endsWith('\n')).toBe(true);
  });

  it('pede pelo menos 1 agente, 1 workflow e 1 comando', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    expect(goal).toContain('pelo menos 1 agente');
    expect(goal).toContain('pelo menos 1 workflow');
    expect(goal).toContain('pelo menos 1 comando');
  });

  it('pede um resumo do que foi criado', () => {
    const goal = buildScaffoldSystemPrompt('teste');
    expect(goal).toContain('RESUMO');
  });
});

// ── EST-INIT-02 · routing: /init <desc> → prompt-driven vs /init → estático ──

describe('EST-INIT-02 · routing da descrição (extração de args)', () => {
  /**
   * Simula a lógica de extração de `desc` dos args do slash-command,
   * exatamente como o handler em run.tsx faz.
   * Puro: sem I/O, sem modelo.
   */
  function extractDesc(args: string): { desc: string; force: boolean } {
    const force = /(?:^|\s)--force\b/.test(args) || args.trim() === '--force';
    const desc = args.replace(/--force\b/, '').trim();
    return { desc, force };
  }

  it('/init "app Next.js" ⇒ desc="app Next.js", force=false', () => {
    const { desc, force } = extractDesc('app Next.js');
    expect(desc).toBe('app Next.js');
    expect(force).toBe(false);
  });

  it('/init (sem args) ⇒ desc="", force=false (cai no scaffold estático)', () => {
    const { desc, force } = extractDesc('');
    expect(desc).toBe('');
    expect(force).toBe(false);
  });

  it('/init --force ⇒ desc="", force=true (scaffold estático com overwrite)', () => {
    const { desc, force } = extractDesc('--force');
    expect(desc).toBe('');
    expect(force).toBe(true);
  });

  it('/init "app Next.js" --force ⇒ desc="app Next.js", force=true (estático com overwrite)', () => {
    const { desc, force } = extractDesc('app Next.js --force');
    expect(desc).toBe('app Next.js');
    expect(force).toBe(true);
  });

  it('desc não-vazia sem --force ⇒ prompt-driven (goal contém os formatos)', () => {
    const { desc, force } = extractDesc('app de machine learning em Python');
    expect(desc).toBe('app de machine learning em Python');
    expect(force).toBe(false);
    // Quando desc não-vazio e !force ⇒ prompt-driven
    const isPromptDriven = desc !== '' && !force;
    expect(isPromptDriven).toBe(true);
    // O goal conteria a descrição
    const goal = buildScaffoldSystemPrompt(desc);
    expect(goal).toContain('app de machine learning em Python');
    expect(goal).toContain('name: nome-do-agente'); // formatos embutidos
  });
});
