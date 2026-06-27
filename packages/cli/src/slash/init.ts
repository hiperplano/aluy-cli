// EST-0964 — `/init`: gera AGENT.md + scaffold `.aluy/` (análogo ao `/init` do Claude Code).
// EST-INIT-01 — estende o /init p/ criar a estrutura .aluy/{agents,workflows,commands}/
// com 1 exemplo VÁLIDO de cada, além do AGENT.md. Idempotente (não sobrescreve).
//
// O agente ANALISA o repo (estrutura, stack, convenções) e ESCREVE os arquivos.
// A escrita NÃO é um atalho privilegiado: passa pela CATRACA NORMAL (decide() +
// ask-resolver + tool `write_file`), exatamente como uma criação que o modelo
// proporia — o usuário vê o DIFF e aprova. Assim o `/init` herda todo o confinamento
// de workspace e a confirmação de efeito (CLI-SEC-9) sem exceção.
//
// Divisão p/ testabilidade:
//   - `buildAgentMdTemplate`  — PURO: facts → markdown (sem I/O).
//   - `buildExampleAgent`     — PURO: conteúdo do agente de exemplo.
//   - `buildExampleWorkflow`  — PURO: conteúdo do workflow de exemplo.
//   - `buildExampleCommand`   — PURO: conteúdo do comando de exemplo.
//   - `analyzeWorkspace`      — async: junta os facts via portas CONFINADAS.
//   - `runInit`               — orquestra: analisa → monta → escreve PELA CATRACA.

import {
  decide,
  writeFileTool,
  type AskResolver,
  type PermissionEngine,
  type ToolCall,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import type { SlashNote } from './handlers.js';
import { AGENT_MD_FILENAME } from '../io/agent-md.js';

// ── Scaffold paths (relativos à raiz do workspace) ──────────────────────────

/** Caminhos dos arquivos de scaffold que o /init cria. */
const ALUY_DIR = '.aluy';
const AGENT_EXAMPLE = `${ALUY_DIR}/agents/exemplo.md`;
const WORKFLOW_EXAMPLE = `${ALUY_DIR}/workflows/exemplo.md`;
const COMMAND_EXAMPLE = `${ALUY_DIR}/commands/exemplo.md`;

// ── Conteúdo dos exemplos (PURO — sem I/O) ──────────────────────────────────

/**
 * Conteúdo do agente de exemplo (`.aluy/agents/exemplo.md`).
 * VÁLIDO p/ `parseAgentProfile`: frontmatter com name/description/tools + corpo.
 */
export function buildExampleAgent(): string {
  return [
    '---',
    'name: exemplo',
    'description: Agente de exemplo — revisa arquivos e sugere melhorias.',
    'tools: read_file, grep',
    '---',
    'Você é um revisor de código amigável. Leia os arquivos indicados e aponte',
    'melhorias de legibilidade, performance e segurança. Seja conciso e objetivo.',
    'Não invente problemas — aponte só o que realmente pode melhorar.',
    '',
  ].join('\n');
}

/**
 * Conteúdo do workflow de exemplo (`.aluy/workflows/exemplo.md`).
 * VÁLIDO p/ `parseWorkflow`: frontmatter com name/description + atividades numeradas.
 */
export function buildExampleWorkflow(): string {
  return [
    '---',
    'name: exemplo',
    'description: Workflow de exemplo — analisa e melhora um arquivo.',
    '---',
    '1. analisar — Leia o arquivo alvo e identifique problemas de código, performance e segurança.',
    '2. melhorar — Corrija os problemas encontrados, um de cada vez.',
    '3. verificar — Rode os testes e confirme que nada quebrou.',
    '',
  ].join('\n');
}

/**
 * Conteúdo do comando de exemplo (`.aluy/commands/exemplo.md`).
 * VÁLIDO p/ `parseUserCommand`: frontmatter com summary + template de prompt.
 */
export function buildExampleCommand(): string {
  return [
    '---',
    'summary: Analisa um arquivo e sugere melhorias de código.',
    '---',
    'Analise o arquivo $ARGUMENTS e sugira melhorias de legibilidade, performance e segurança.',
    'Seja conciso — foque no que realmente importa.',
    '',
  ].join('\n');
}

// ── AGENT.md template (existente, preservado) ───────────────────────────────

/** Fatos detectados sobre o repo p/ preencher o template. Tudo opcional. */
export interface RepoFacts {
  /** Nome do projeto (de package.json `name` ou o basename da raiz). */
  readonly name?: string;
  /** Descrição (de package.json `description`). */
  readonly description?: string;
  /** Stack/linguagem detectada (ex.: "TypeScript/Node"). */
  readonly stack?: string;
  /** Scripts npm relevantes (build/test/lint…) — `nome → comando`. */
  readonly scripts?: Readonly<Record<string, string>>;
  /** Diretórios de topo (estrutura) — só nomes, p/ orientar o agente. */
  readonly topDirs?: readonly string[];
}

/**
 * Monta o conteúdo do AGENT.md a partir dos fatos detectados. PURO (sem I/O):
 * facts → markdown. Sempre produz um template VÁLIDO e ÚTIL, mesmo sem nenhum fato
 * (cai p/ placeholders que orientam o dono a preencher). É um TEMPLATE — instruções
 * confiáveis que o dono revisa/edita; não há segredo embutido (CLI-SEC-7).
 */
export function buildAgentMdTemplate(facts: RepoFacts = {}): string {
  const name = facts.name ?? 'este projeto';
  const lines: string[] = [];

  lines.push(`# ${name}`);
  lines.push('');
  lines.push(
    'Instruções de projeto para o agente Aluy (lidas no início de cada sessão).',
    'Edite à vontade — você é o dono deste contexto.',
  );
  lines.push('');

  lines.push('## O que é');
  lines.push('');
  lines.push(facts.description ?? '<!-- Descreva o objetivo do projeto em 1–2 linhas. -->');
  lines.push('');

  lines.push('## Stack');
  lines.push('');
  lines.push(facts.stack ?? '<!-- Linguagem/framework principais. -->');
  lines.push('');

  lines.push('## Comandos');
  lines.push('');
  const scripts = facts.scripts ?? {};
  const scriptKeys = Object.keys(scripts);
  if (scriptKeys.length > 0) {
    lines.push('```bash');
    for (const key of scriptKeys) {
      lines.push(`npm run ${key}    # ${scripts[key]}`);
    }
    lines.push('```');
  } else {
    lines.push('<!-- Como instalar, buildar, testar e rodar (build/test/lint/start). -->');
  }
  lines.push('');

  lines.push('## Estrutura');
  lines.push('');
  if (facts.topDirs && facts.topDirs.length > 0) {
    for (const dir of facts.topDirs) {
      lines.push(`- \`${dir}/\``);
    }
  } else {
    lines.push('<!-- Os diretórios principais e o que vive em cada um. -->');
  }
  lines.push('');

  lines.push('## Convenções');
  lines.push('');
  lines.push(
    '<!-- Padrões de código, idioma de docs/commits, regras de segurança, o que NÃO fazer. -->',
  );
  lines.push('');

  return lines.join('\n');
}

// ── EST-INIT-02 · system prompt de scaffold (PROMPT-DRIVEN) ─────────────────

/**
 * Monta o SYSTEM PROMPT que guia o agente a gerar os arquivos `.aluy/` SOB MEDIDA
 * ao projeto descrito. Embute as CONVENÇÕES do Aluy como parâmetros:
 *   - formato de AGENTE (`.md`: frontmatter name/description/tools + persona);
 *   - formato de WORKFLOW (`.md`: `---\nname\n---\n1. id [agente] — goal`);
 *   - formato de COMANDO (user-command);
 *   - o AGENT.md do projeto.
 *
 * PURO (sem I/O): a string retornada é o system prompt + a descrição do usuário
 * concatenados como um GOAL de um turno. O agente ESCREVE os arquivos pelas tools
 * normais (`write_file`), que passam pela CATRACA (CLI-SEC-H1).
 */
export function buildScaffoldSystemPrompt(descricao: string): string {
  const desc = descricao.trim();
  return [
    'Você é um especialista em scaffolding de projetos Aluy. Sua tarefa é gerar a',
    'configuração `.aluy/` SOB MEDIDA para o projeto descrito abaixo.',
    '',
    '## O que você deve criar',
    '',
    'Analise a descrição do projeto e crie os seguintes arquivos em `.aluy/`:',
    '',
    '1. **ALUY.md** (na raiz do projeto) — instruções de projeto para o agente Aluy.',
    '   Deve conter: nome do projeto, stack, comandos principais (build/test/lint),',
    '   estrutura de diretórios e convenções. Use o formato:',
    '   ```',
    '   # nome-do-projeto',
    '   Instruções de projeto para o agente Aluy…',
    '   ## O que é',
    '   …',
    '   ## Stack',
    '   …',
    '   ## Comandos',
    '   …',
    '   ## Estrutura',
    '   …',
    '   ## Convenções',
    '   …',
    '   ```',
    '',
    '2. **Agentes** em `.aluy/agents/` — perfis de sub-agentes NOMEADOS (`.md`).',
    '   Formato EXATO (frontmatter YAML + corpo = system prompt):',
    '   ```',
    '   ---',
    '   name: nome-do-agente    # obrigatório, minúsculas, [a-z0-9_-]',
    '   description: O que ele faz (1 frase)',
    '   tools: read_file, grep  # opcional — restringe o toolset (⊆ pai)',
    '   model: sonnet           # opcional — preferência de tier',
    '   ---',
    '   Você é um [persona]. [Instruções claras e objetivas.]',
    '   ```',
    '   - `tools:` AUSENTE = herda o toolset do pai.',
    '   - `tools:` PRESENTE = RESTRINGE à lista declarada.',
    '   - Crie agentes RELEVANTES ao stack descrito (ex.: revisor, tester, dev,',
    '     arquiteto…). SEMPRE crie pelo menos 1 agente.',
    '',
    '3. **Workflows** em `.aluy/workflows/` — fluxos de atividades (`.md`).',
    '   Formato EXATO:',
    '   ```',
    '   ---',
    '   name: nome-do-workflow   # obrigatório',
    '   description: O que o fluxo entrega (1 frase)',
    '   ---',
    '   1. passo-um [agente] — Objetivo claro do primeiro passo.',
    '   2. passo-dois — Objetivo claro do segundo passo (sem agente = usa o default).',
    '   ```',
    '   - `[agente]` é OPCIONAL — se presente, invoca o agente `.md` com esse nome.',
    '   - O separador entre id e objetivo é `—` (em-dash) ou `-`.',
    '   - Crie workflows do SDLC relevantes ao stack (ex.: implementar-estoria,',
    '     code-review, deploy, bug-fix…). Crie pelo menos 1 workflow.',
    '',
    '4. **Comandos** em `.aluy/commands/` — atalhos de prompt (`.md`).',
    '   Formato EXATO:',
    '   ```',
    '   ---',
    '   summary: O que o comando faz (1 frase)',
    '   ---',
    '   Template do prompt. Use $ARGUMENTS para os args do usuário.',
    '   Ex.: Revise o arquivo $ARGUMENTS e sugira melhorias.',
    '   ```',
    '   - O nome do comando vem do NOME DO ARQUIVO (sem `.md`).',
    '   - `$ARGUMENTS` é substituído pelo que o usuário digitar após `/<nome>`.',
    '   - Crie comandos ÚTEIS ao stack (ex.: revisar, testar, deploy, explicar…).',
    '   Crie pelo menos 1 comando.',
    '',
    '## IMPORTANTE',
    '',
    '- Escreva CADA arquivo com a ferramenta `write_file` (que passa pela catraca).',
    '- Use caminhos RELATIVOS a partir da raiz do workspace:',
    '  `ALUY.md`, `.aluy/agents/<nome>.md`, `.aluy/workflows/<nome>.md`,',
    '  `.aluy/commands/<nome>.md`.',
    '- NÃO crie diretórios explicitamente — o `write_file` já os cria.',
    '- Se um arquivo já existir, use `overwrite: false` (padrão) — NÃO sobrescreva',
    '  config do dono.',
    '- Seja CRIATIVO e RELEVANTE: os agentes/workflows/comandos devem refletir o',
    '  stack e o domínio do projeto descrito.',
    '- Após criar todos os arquivos, faça um RESUMO do que foi criado e por quê.',
    '',
    '## Descrição do projeto',
    '',
    desc,
    '',
  ].join('\n');
}

/**
 * Analisa o workspace via portas CONFINADAS (fs/search do core) p/ juntar os fatos
 * do template. Toda leitura passa pelo confinamento de workspace (as portas
 * concretas reconfinam). Fail-safe: qualquer leitura que falhe é só um fato a menos
 * — nunca lança (o template ainda sai com placeholders).
 */
export async function analyzeWorkspace(ports: ToolPorts, rootName?: string): Promise<RepoFacts> {
  const facts: RepoFacts = {};
  const out: {
    name?: string;
    description?: string;
    stack?: string;
    scripts?: Record<string, string>;
    topDirs?: string[];
  } = {};

  if (rootName) out.name = rootName;

  // package.json ⇒ name/description/scripts/stack (Node/TS). Leitura confinada.
  try {
    const raw = await ports.fs.readFile('package.json');
    const pkg = JSON.parse(raw) as {
      name?: unknown;
      description?: unknown;
      scripts?: unknown;
      devDependencies?: unknown;
      dependencies?: unknown;
    };
    if (typeof pkg.name === 'string' && pkg.name.trim() !== '') out.name = pkg.name;
    if (typeof pkg.description === 'string' && pkg.description.trim() !== '') {
      out.description = pkg.description;
    }
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      const picked: Record<string, string> = {};
      const interesting = ['build', 'test', 'lint', 'typecheck', 'start', 'dev', 'format'];
      for (const key of interesting) {
        const v = (pkg.scripts as Record<string, unknown>)[key];
        if (typeof v === 'string') picked[key] = v;
      }
      if (Object.keys(picked).length > 0) out.scripts = picked;
    }
    // Stack: Node + TS se houver typescript nas deps; senão Node.
    const deps = {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    };
    out.stack = deps && 'typescript' in deps ? 'TypeScript / Node' : 'Node';
  } catch {
    // sem package.json (ou ilegível/JSON inválido) — segue sem esses fatos.
  }

  // Diretórios de topo: usa o grep como sonda barata por marcadores conhecidos.
  const probes = ['src', 'packages', 'tests', 'test', 'docs', 'lib', 'app'];
  const present: string[] = [];
  for (const dir of probes) {
    try {
      const { matches } = await ports.search.search('', dir);
      if (matches.length > 0) present.push(dir);
    } catch {
      // dir ausente/ilegível — não está presente; segue.
    }
  }
  if (present.length > 0) out.topDirs = present;

  Object.assign(facts, out);
  return facts;
}

// ── Scaffold engine ─────────────────────────────────────────────────────────

/** Um arquivo de scaffold: caminho (relativo) + conteúdo. */
interface ScaffoldEntry {
  readonly path: string;
  readonly content: string;
}

/** O que o `/init` produziu (p/ o caller empurrar a nota + saber o que escreveu). */
export interface InitResult {
  /** `true` se pelo menos 1 arquivo foi efetivamente escrito. */
  readonly created: boolean;
  /** A nota a exibir (sempre presente). */
  readonly note: SlashNote;
  /** Arquivos criados nesta execução (paths relativos). */
  readonly createdPaths: readonly string[];
  /** Arquivos pulados (já existiam). */
  readonly skippedPaths: readonly string[];
}

export interface RunInitOptions {
  readonly ports: ToolPorts;
  /** Catraca: a MESMA engine da sessão (a escrita não é privilegiada). */
  readonly permission: PermissionEngine;
  /** Resolver de `ask`: o usuário vê o diff e aprova (CLI-SEC-9). */
  readonly askResolver: AskResolver;
  /** Nome da raiz (basename do cwd) p/ o título, se não houver package.json `name`. */
  readonly rootName?: string;
  /** Sobrescrever arquivos já existentes? Default `false` (não estraga o do dono). */
  readonly overwrite?: boolean;
  /** Cancelamento (Ctrl-C). */
  readonly signal?: AbortSignal;
}

/**
 * Monta a lista de arquivos que o scaffold vai tentar criar. Ordem determinística:
 * o ALUY.md (config do projeto) primeiro, depois os exemplos do .aluy/.
 */
function buildScaffoldEntries(facts: RepoFacts): ScaffoldEntry[] {
  return [
    { path: AGENT_MD_FILENAME, content: buildAgentMdTemplate(facts) },
    { path: AGENT_EXAMPLE, content: buildExampleAgent() },
    { path: WORKFLOW_EXAMPLE, content: buildExampleWorkflow() },
    { path: COMMAND_EXAMPLE, content: buildExampleCommand() },
  ];
}

/**
 * Escreve UM arquivo pela catraca. Devolve: 'created' | 'skipped' (já existe) |
 * 'denied' (catraca negou) | 'error'. `overwrite` força o flag `overwrite:true`
 * no input do write_file (necessário p/ reescrever arquivo existente).
 */
async function writeOneScaffoldFile(
  entry: ScaffoldEntry,
  exists: boolean,
  ports: ToolPorts,
  permission: PermissionEngine,
  askResolver: AskResolver,
  overwrite = false,
  signal?: AbortSignal,
): Promise<'created' | 'skipped' | 'denied' | 'error'> {
  // Idempotente: se já existe e NÃO é overwrite, pula.
  if (exists && !overwrite) return 'skipped';

  const call: ToolCall = {
    name: 'write_file',
    input: { path: entry.path, content: entry.content, ...(overwrite ? { overwrite: true } : {}) },
  };
  const verdict = decide(permission, call);

  if (verdict.decision === 'deny') return 'denied';

  if (verdict.decision === 'ask') {
    if (!verdict.effect) return 'error';
    const resolution = await askResolver.resolve(
      {
        call,
        effect: verdict.effect,
        category: verdict.category ?? 'default',
        reason: verdict.reason,
        alwaysAsk: (verdict.category ?? '').startsWith('always-ask:'),
      },
      signal,
    );
    if (resolution.kind === 'deny') return 'denied';
  }

  const result = await writeFileTool.run(call.input, ports);
  return result.ok ? 'created' : 'error';
}

/** Rótulo legível p/ o path na nota. */
function labelFor(path: string): string {
  if (path === AGENT_MD_FILENAME) return `${AGENT_MD_FILENAME} (config do projeto)`;
  if (path === AGENT_EXAMPLE) return '.aluy/agents/exemplo.md (agente de exemplo)';
  if (path === WORKFLOW_EXAMPLE) return '.aluy/workflows/exemplo.md (workflow de exemplo)';
  if (path === COMMAND_EXAMPLE) return '.aluy/commands/exemplo.md (comando de exemplo)';
  return path;
}

/**
 * Roda o `/init`: analisa o repo, monta os arquivos do scaffold e os escreve
 * PELA CATRACA NORMAL (decide → ask → write_file). Idempotente: arquivos que já
 * existem NÃO são sobrescritos (skip + avisa). Se a catraca NEGAR (ou o usuário
 * recusar o diff), nada é escrito e a nota explica. Fail-safe: nunca escreve sem
 * aprovação; qualquer erro vira uma nota honesta.
 */
export async function runInit(opts: RunInitOptions): Promise<InitResult> {
  const { ports, permission, askResolver } = opts;

  // Analisa o repo (confinado) e monta os conteúdos.
  const facts = await analyzeWorkspace(ports, opts.rootName);

  // Monta a lista de arquivos. Se overwrite, AGENT.md é o único que pode ser
  // sobrescrito (exemplos NUNCA são sobrescritos — são ponto de partida do dono).
  const entries = buildScaffoldEntries(facts);

  // Pré-checa existência de cada arquivo (1 chamada por arquivo, confinada).
  const preExists: boolean[] = [];
  for (const entry of entries) {
    try {
      preExists.push(await ports.fs.exists(entry.path));
    } catch {
      preExists.push(false);
    }
  }

  // AGENT.md: se já existe e NÃO é overwrite, pula só ELE (idempotente) —
  // mas CONTINUA p/ criar os exemplos do .aluy/ que faltarem.
  // Se TUDO já existe, a nota final avisa "nada a criar".
  const skipAgentMd = preExists[0] && opts.overwrite !== true;

  if (skipAgentMd && preExists.slice(1).every(Boolean)) {
    // TUDO já existe — early return limpo.
    return {
      created: false,
      note: {
        title: 'init',
        lines: [
          `já existe um ${AGENT_MD_FILENAME} e a estrutura .aluy/ está completa — nada a criar.`,
          `edite os arquivos à mão, ou remova-os e rode /init novamente.`,
          `para regenerar o ${AGENT_MD_FILENAME}, use \`/init --force\`.`,
        ],
      },
      createdPaths: [],
      skippedPaths: entries.map((e) => e.path),
    };
  }

  // Escreve cada arquivo pela catraca. Para exemplos, NUNCA sobrescreve
  // (são ponto de partida que o dono edita).
  const createdPaths: string[] = [];
  const skippedPaths: string[] = [];
  const deniedPaths: string[] = [];
  const errorPaths: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // AGENT.md (índice 0) pode ser sobrescrito com overwrite=true; exemplos NUNCA.
    const effectiveExists = i === 0 && opts.overwrite === true ? false : preExists[i]!;
    // Se vamos reescrever AGENT.md que já existe, passa overwrite:true no input
    // (o write_file tool exige isso p/ reescrever um arquivo existente).
    const needsOverwriteFlag = i === 0 && opts.overwrite === true && preExists[i]!;

    const result = await writeOneScaffoldFile(
      entry,
      effectiveExists,
      ports,
      permission,
      askResolver,
      needsOverwriteFlag,
      opts.signal,
    );

    switch (result) {
      case 'created':
        createdPaths.push(entry.path);
        break;
      case 'skipped':
        skippedPaths.push(entry.path);
        break;
      case 'denied':
        deniedPaths.push(entry.path);
        break;
      case 'error':
        errorPaths.push(entry.path);
        break;
    }
  }

  const anyCreated = createdPaths.length > 0;

  // Monta a nota final.
  const lines: string[] = [];

  if (anyCreated) {
    lines.push('scaffold criado com sucesso:');
    for (const p of createdPaths) {
      const status = preExists[entries.findIndex((e) => e.path === p)] ? 'regenerado' : 'criado';
      lines.push(`  ${status}: ${labelFor(p)}`);
    }
  }

  if (skippedPaths.length > 0) {
    if (anyCreated) lines.push('');
    lines.push('pulados (já existiam — idempotente, não sobrescrevo):');
    for (const p of skippedPaths) {
      lines.push(`  ↷ ${labelFor(p)}`);
    }
  }

  if (deniedPaths.length > 0) {
    if (anyCreated || skippedPaths.length > 0) lines.push('');
    lines.push('recusados pela catraca de segurança:');
    for (const p of deniedPaths) {
      lines.push(`  ✗ ${labelFor(p)}`);
    }
  }

  if (errorPaths.length > 0) {
    if (anyCreated || skippedPaths.length > 0 || deniedPaths.length > 0) lines.push('');
    lines.push('falharam ao escrever:');
    for (const p of errorPaths) {
      lines.push(`  ⚠ ${labelFor(p)}`);
    }
  }

  if (!anyCreated && skippedPaths.length === entries.length) {
    lines.push('tudo já existe — nada a criar (idempotente).');
  }

  if (anyCreated) {
    lines.push('');
    lines.push('revise e edite os arquivos — eles são seus.');
    lines.push('os exemplos em .aluy/ são carregados automaticamente no próximo boot.');
    if (facts.stack) lines.push(`stack detectada: ${facts.stack}`);
    if (facts.topDirs && facts.topDirs.length > 0) {
      lines.push(`estrutura: ${facts.topDirs.map((d) => `${d}/`).join(', ')}`);
    }
  }

  return {
    created: anyCreated,
    note: { title: 'init', lines },
    createdPaths,
    skippedPaths,
  };
}
