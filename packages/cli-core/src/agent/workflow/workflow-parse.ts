// EST-1105 · ADR-workflows — WORKFLOWS definidos em `.md` (parser PURO).
// Um arquivo `<nome>.md` (em `~/.aluy/workflows/` global, ou `.aluy/workflows/`
// de PROJETO) descreve um FLUXO DE ATIVIDADES:
//
//   ---
//   name: sdlc-estoria
//   description: Fluxo de implementação de uma estória
//   ---
//   1. entender — Leia a estória e o contexto; resuma o plano.
//   2. implementar [coder] — Implemente o código + os testes.
//   3. testar [tester] — Rode build/lint/testes; corrija o que quebrar.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ FRONTEIRA — este MÓDULO É PARSER PURO; ele NÃO concede nada. O workflow é  ║
// ║ DADO de config; o `run` (fatia 2) é que o interpreta.                     ║
// ║                                                                            ║
// ║ • `name` obrigatório (RES-MD-3: sem name ⇒ WorkflowError).                ║
// ║ • Mínimo 1 atividade (corpo sem atividade numerada ⇒ WorkflowError).       ║
// ║ • Cada atividade = `N. <id> [<agente>] — <objetivo>` (o `[<agente>]` é    ║
// ║   OPCIONAL entre o id e o separador `—`/`-`).                             ║
// ║ • FALHA FECHADA: malformado ⇒ WorkflowError com motivo CLARO.              ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): parser de string PURO (sem `node:*`, sem I/O). A LEITURA
// confinada dos diretórios de workflows é do locus concreto (@aluy/cli, io/).

/** Camada de descoberta de um workflow (global = dono, project = repo). */
export type WorkflowOrigin = 'global' | 'project';

/** Uma atividade do workflow: id (slug curto) + objetivo (texto livre) + agente opcional. */
export interface WorkflowActivity {
  readonly id: string;
  readonly goal: string;
  /** Agente nomeado (`.md` em ~/.aluy/agents/ ou .claude/agents/) que executa ESTA atividade. */
  readonly agent?: string;
}

/** Um workflow já PARSEADO de um `.md`. */
export interface WorkflowDef {
  /** Nome do workflow (frontmatter `name`). */
  readonly name: string;
  /** Descrição opcional (frontmatter `description`). */
  readonly description?: string;
  /** Lista ordenada de atividades (≥1). */
  readonly activities: readonly WorkflowActivity[];
  /** Camada de descoberta (carregada pelo loader confinado). */
  readonly origin: WorkflowOrigin;
}

/**
 * RES-MD-3 — FALHA FECHADA. Quando o `.md` é malformado, o parser devolve ISTO
 * em vez de um `WorkflowDef`. O workflow NÃO entra na lista (nunca vira "workflow
 * vazio"). `reason` é legível p/ o erro de carga visível.
 */
export interface WorkflowError {
  readonly error: true;
  /** Basename do arquivo que falhou. */
  readonly file: string;
  /** Motivo legível da rejeição. */
  readonly reason: string;
}

/** `true` se o parse falhou (fail-closed) — o loader descarta com erro visível. */
export function isWorkflowError(p: WorkflowDef | WorkflowError): p is WorkflowError {
  return (p as WorkflowError).error === true;
}

/** Teto defensivo do nome (anti-nome-gigante). */
const MAX_NAME_LEN = 64;
/** Teto defensivo de atividades (anti-arquivo-gigante). */
const MAX_ACTIVITIES = 64;

/**
 * Extrai o frontmatter YAML-MÍNIMO (bloco `---`…`---` no TOPO) + o corpo. Só pares
 * `chave: valor` de 1 linha (sem YAML aninhado — config simples). Tolera BOM/CRLF.
 * Sem frontmatter ⇒ tudo é corpo (sem `name` ⇒ o parser rejeita). PURO.
 */
function splitFrontmatter(raw: string): {
  fm: { name?: string; description?: string };
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };

  const fm: { name?: string; description?: string } = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
  }
  return { fm, body: text.slice(m[0].length).trim() };
}

/**
 * Parseia uma LINHA de atividade: `N. <id> [<agente>] — <objetivo>` (o `[<agente>]`
 * entre id e separador é OPCIONAL — back-compat sem `[]` ⇒ agent undefined). O
 * separador é `—` (em-dash) ou `-`. Devolve `null` se a linha não casa o padrão. PURO.
 */
function parseActivityLine(line: string): WorkflowActivity | null {
  // Regex: início opcional de whitespace, número, `.`, espaço, id (até `[` ou separador),
  // agente opcional entre `[` `]`, separador `—` ou `-`, espaço, objetivo (resto).
  const m = /^\s*\d+\.\s+([^[—-]+?)\s*(?:\[([^\]]*)\]\s*)?[—-]\s*(.+)$/.exec(line);
  if (!m) return null;
  const id = m[1]!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (id === '') return null;
  const goal = m[3]!.trim();
  if (goal === '') return null;
  const agentRaw = m[2]?.trim();
  const agent = agentRaw !== undefined && agentRaw !== '' ? agentRaw : undefined;
  return { id, goal, ...(agent !== undefined ? { agent } : {}) };
}

/**
 * Parseia o conteúdo cru de um `<nome>.md` num `WorkflowDef` OU num
 * `WorkflowError` (RES-MD-3, fail-closed). A `origin` é injetada pelo LOADER
 * (filesystem confinado), não inferida do conteúdo.
 *
 * Rejeita (erro de workflow, NÃO entra na lista):
 *   - `name` ausente/vazio;
 *   - zero atividades (corpo sem linha numerada válida).
 *
 * PURO.
 */
export function parseWorkflow(
  basename: string,
  raw: string,
  origin: WorkflowOrigin,
): WorkflowDef | WorkflowError {
  const file = basename;
  const { fm, body } = splitFrontmatter(raw);

  const name = fm.name?.trim() ?? '';
  if (name === '' || name.length > MAX_NAME_LEN) {
    return {
      error: true,
      file,
      reason: `workflow "${file}": frontmatter sem "name" válido — workflow rejeitado (fail-closed)`,
    };
  }

  const activities: WorkflowActivity[] = [];
  for (const line of body.split('\n')) {
    if (activities.length >= MAX_ACTIVITIES) break;
    const act = parseActivityLine(line);
    if (act) activities.push(act);
  }

  if (activities.length === 0) {
    return {
      error: true,
      file,
      reason:
        `workflow "${name}" (${file}): ` +
        `nenhuma atividade encontrada — o corpo precisa de linhas "N. <id> — <objetivo>"`,
    };
  }

  const description =
    fm.description !== undefined && fm.description.trim() !== ''
      ? fm.description.trim()
      : undefined;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    activities,
    origin,
  };
}
