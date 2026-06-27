// EST-0977 · ADR-0061 · CLI-SEC-11 (reaplicado) — AGENTES definidos em `.md`
// (parser PURO). Um arquivo `<nome>.md` (em `~/.aluy/agents/` global, ou
// `.claude/agents/` / `.aluy/agents/` de PROJETO) descreve um sub-agente NOMEADO:
//
//   ---
//   name: revisor
//   description: Revisa diffs e aponta bugs/regressões.
//   tools: read_file, grep        # opcional; RESTRINGE o toolset do filho (⊆ pai)
//   model: sonnet                 # opcional; preferência de TIER (resolvida no broker)
//   ---
//   Você é um revisor rigoroso. Leia o diff, aponte bugs e riscos…  ← system prompt
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ FRONTEIRA DE SEGURANÇA (o que o gate FORTE do `seguranca` reconfere) — este ║
// ║ MÓDULO É PARSER PURO; ele NÃO concede nada. O perfil é DADO de config:      ║
// ║                                                                            ║
// ║ • `tools` SÓ RESTRINGE (GS-MD1). O parser devolve a LISTA declarada; quem   ║
// ║   aplica `⊆ pai` é a catraca (`PolicyPermissionEngine` com `toolScope`) —    ║
// ║   uma tool fora do escopo do pai é NEGADA na `decide()`, nunca "concedida    ║
// ║   pelo arquivo". O parser NUNCA transforma "sem tools" em "tudo": ausência   ║
// ║   de `tools:` = HERDA o toolset do pai (interseção c/ a sessão), enquanto    ║
// ║   `tools:` PRESENTE-mas-ILEGÍVEL = FALHA FECHADA (RES-MD-3, erro de perfil). ║
// ║                                                                            ║
// ║ • `spawn_agent`/`task` declarado em `tools` ⇒ é só mais um nome na lista;    ║
// ║   a catraca do filho o NEGA por construção (E-A1/GS-MD2 — `denySpawnAgent`). ║
// ║   O parser NÃO o filtra silenciosamente: preserva o nome p/ o gate negar     ║
// ║   visivelmente (deny na `decide()`, não "ignorado").                        ║
// ║                                                                            ║
// ║ • `model` é PREFERÊNCIA DE TIER, nunca provider/chave (CLI-SEC-7/GS-MD4). O  ║
// ║   parser só guarda a string; o mapa nome→tier + a resolução é do broker.    ║
// ║                                                                            ║
// ║ • `name` vem do FRONTMATTER (identidade declarada do agente, padrão Claude   ║
// ║   Code) — MAS o loader carrega a ORIGEM (global/projeto) por fora, do        ║
// ║   filesystem confinado; RES-MD-1 (anti-spoofing cross-camada) é decidido no  ║
// ║   registro (`agent-registry.ts`), não aqui. O parser não confia no `name`    ║
// ║   p/ promover camada.                                                       ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): parser de string PURO (sem `node:*`, sem I/O). A LEITURA
// confinada dos diretórios de agentes é do locus concreto (@aluy/cli, io/).

import { SPAWN_AGENT_TOOL_NAME } from './tools/spawn-agent.js';

/** Camada de descoberta de um perfil — define CONFIANÇA na auto-seleção (RES-MD-1/2). */
export type AgentOrigin =
  /** `~/.aluy/agents/` — config do DONO, confiável; entra na auto-seleção (R-S3-3). */
  | 'global'
  /** `.claude/agents/` / `.aluy/agents/` do workspace — DADO de terceiro; NÃO auto-seleciona. */
  | 'project';

/**
 * Um perfil de agente já PARSEADO de um `.md`. O `name` é a identidade declarada
 * (o que `spawn_agent` invoca); o corpo é o `systemPrompt`. `tools` AUSENTE
 * (`undefined`) = herda o toolset do pai (⊆ sessão); `tools` PRESENTE = restringe
 * à lista (a catraca nega o que estiver fora do escopo do pai). A `origin` é
 * carregada pelo LOADER (filesystem confinado), não auto-declarada.
 */
export interface AgentProfile {
  /** Identidade do agente (frontmatter `name`), normalizada. */
  readonly name: string;
  /** Texto livre do que o agente faz (frontmatter `description`). Opcional. */
  readonly description?: string;
  /**
   * Toolset DECLARADO (frontmatter `tools`). `undefined` = herda o do pai
   * (⊆ sessão). Lista (possivelmente vazia) = RESTRINGE a esses nomes. Pode conter
   * `spawn_agent`/`task` — preservado de propósito p/ a catraca do filho NEGAR
   * visivelmente (E-A1/GS-MD2), nunca filtrado em silêncio aqui.
   */
  readonly tools?: readonly string[];
  /** Preferência de modelo (frontmatter `model`) → TIER resolvido no broker. Opcional. */
  readonly model?: string;
  /**
   * GS-MD8 (carve-out F49) — opt-out de sala (frontmatter `room`). `false` ⇒ este
   * agente NÃO participa de salas mesmo se spawnado com `room:`. `true`/ausente ⇒
   * participa (default, menor atrito).
   */
  readonly room?: boolean;
  /** O corpo do `.md` = system prompt (persona) do sub-agente. */
  readonly systemPrompt: string;
  /** Camada de descoberta (carregada pelo loader confinado, não pelo conteúdo). */
  readonly origin: AgentOrigin;
}

/**
 * RES-MD-3 — FALHA FECHADA. Quando o `.md` é malformado, o parser devolve ISTO em
 * vez de um `AgentProfile`. O perfil NÃO entra no registro (nunca vira "agente sem
 * restrição"). `reason` é legível p/ o erro de carga visível (ADR-0061 §1).
 */
export interface AgentProfileError {
  readonly kind: 'error';
  /** Basename do arquivo que falhou (p/ a mensagem de carga). */
  readonly file: string;
  /** Motivo legível da rejeição. */
  readonly reason: string;
}

/** Resultado do parse: o perfil OU o erro fail-closed (RES-MD-3). */
export type AgentProfileParse = AgentProfile | AgentProfileError;

/** `true` se o parse falhou (fail-closed) — o loader descarta com erro visível. */
export function isAgentProfileError(p: AgentProfileParse): p is AgentProfileError {
  return (p as AgentProfileError).kind === 'error';
}

/** Teto defensivo do nome (anti-nome-gigante / anti-DoS de registro). */
const MAX_NAME_LEN = 64;
/** Teto defensivo de quantas tools um `.md` pode declarar (anti-lista-gigante). */
const MAX_TOOLS = 64;

/**
 * Normaliza o NOME do agente (frontmatter `name`): minúsculas + só `[a-z0-9_-]`
 * (qualquer outro vira `-`), bordas aparadas. Casa a gramática de identificador de
 * agente (o `spawn_agent` invoca por este nome). Vazio após normalizar ⇒ `''`
 * (o parser rejeita — fail-closed). PURO.
 */
export function normalizeAgentName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LEN);
}

/**
 * Normaliza um NOME DE TOOL declarado em `tools`. Tools nativas usam `snake_case`
 * (`read_file`, `run_command`); aceitamos também o estilo Claude Code (`Read`,
 * `Bash`) mapeando p/ os nomes nativos — assim um `.claude/agents/*.md` drop-in
 * "simplesmente funciona". Desconhecido ⇒ devolve o nome cru normalizado (a catraca
 * o trata como tool desconhecida ⇒ fora do escopo do pai ⇒ DENY). PURO.
 */
export function normalizeToolName(raw: string): string {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '_');
  // Compat de nomes do Claude Code → nativos do Aluy (referência de design, sem
  // cópia de código). Conservador: só o que tem correspondente claro.
  switch (t) {
    case 'read':
      return 'read_file';
    case 'edit':
    case 'multiedit':
      return 'edit_file';
    case 'write':
      // EST-0944 — o `Write` (full content) do Claude Code é o sobrescreve-tudo ⇒
      // mapeia p/ `write_file`; o `Edit`/`MultiEdit` (cirúrgico) ⇒ `edit_file`.
      return 'write_file';
    case 'bash':
    case 'shell':
      return 'run_command';
    case 'glob':
    case 'grep':
      return 'grep';
    case 'webfetch':
    case 'web_fetch':
      return 'web_fetch';
    case 'websearch':
    case 'web_search':
      return 'web_search';
    case 'task':
      // `task` é o alias do `spawn_agent` no padrão Claude Code. NÃO filtramos —
      // mapeamos ao nome canônico p/ a catraca do filho NEGAR visivelmente (E-A1).
      return SPAWN_AGENT_TOOL_NAME;
    default:
      return t;
  }
}

/**
 * Frontmatter de um agente-`.md` já extraído (cru, antes de normalizar). Distingue
 * `tools` AUSENTE (`undefined`) de PRESENTE-mas-vazio/ilegível — a distinção é o
 * coração do RES-MD-3 (fail-closed): só ausência herda; presença-ilegível falha.
 */
interface RawFrontmatter {
  readonly name?: string;
  readonly description?: string;
  /** `undefined` = chave `tools:` ausente. String = valor cru da chave (a parsear). */
  readonly toolsRaw?: string;
  readonly model?: string;
  /** `true` se a chave `tools:` apareceu (mesmo vazia) — guia o fail-closed. */
  readonly hasToolsKey: boolean;
  /** GS-MD8: `room:` do frontmatter (opt-out de sala). `undefined` = ausente (default participa). */
  readonly roomRaw?: string;
}

/**
 * Extrai o frontmatter YAML-MÍNIMO (bloco `---`…`---` no TOPO) + o corpo. Só pares
 * `chave: valor` de 1 linha (sem YAML aninhado — config simples, sem dependência de
 * parser YAML). Tolera BOM/CRLF. Sem frontmatter ⇒ tudo é corpo (sem `name` ⇒ o
 * parser rejeita). PURO.
 */
function splitAgentFrontmatter(raw: string): { fm: RawFrontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: { hasToolsKey: false }, body: text.trim() };

  const out: {
    name?: string;
    description?: string;
    toolsRaw?: string;
    model?: string;
    roomRaw?: string;
  } = {};
  let hasToolsKey = false;
  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    // Tira aspas envolventes (`name: "x"` ⇒ `x`); o valor de `tools` mantém vírgulas.
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'model') out.model = value;
    else if (key === 'tools') {
      hasToolsKey = true;
      out.toolsRaw = value;
    } else if (key === 'room') {
      out.roomRaw = value;
    }
  }
  return { fm: { ...out, hasToolsKey }, body: text.slice(m[0].length).trim() };
}

/**
 * Parseia o valor cru de `tools:` numa LISTA de nomes de tool normalizados.
 * Aceita lista inline (`read_file, grep`) e lista YAML em bloco (`[read_file, grep]`).
 * Devolve `null` (FALHA) quando a chave existe mas o valor é ILEGÍVEL/vazio —
 * RES-MD-3: o chamador rejeita o perfil inteiro (nunca "sem tools = herda tudo").
 * Lista válida (≥1 nome) ⇒ os nomes. PURO.
 */
function parseToolsList(rawValue: string): readonly string[] | null {
  // Permite a forma YAML-flow `[a, b]` além da inline `a, b`.
  const inner = rawValue.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return null; // chave presente porém vazia ⇒ FALHA FECHADA.
  const names = inner
    .split(',')
    .map((s) => normalizeToolName(s))
    .filter((s) => s !== '');
  if (names.length === 0) return null; // só lixo/separadores ⇒ FALHA FECHADA.
  if (names.length > MAX_TOOLS) return null; // lista absurda ⇒ FALHA FECHADA.
  // Dedup preservando ordem (estável).
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    dedup.push(n);
  }
  return dedup;
}

/**
 * Parseia o conteúdo cru de um `<nome>.md` num `AgentProfile` OU num
 * `AgentProfileError` (RES-MD-3, fail-closed). A `origin` é injetada pelo LOADER
 * (filesystem confinado), não inferida do conteúdo.
 *
 * Rejeita (erro de perfil, NÃO entra no registro):
 *   - `name` ausente/vazio após normalizar;
 *   - corpo (system prompt) vazio;
 *   - `tools:` PRESENTE mas ILEGÍVEL/vazio (RES-MD-3 — nunca vira "herda tudo").
 *
 * `tools:` AUSENTE ⇒ `tools: undefined` (HERDA o toolset do pai, ⊆ sessão — não é
 * falha, é o default seguro: o teto continua sendo o do pai). PURO.
 */
export function parseAgentProfile(
  basename: string,
  raw: string,
  origin: AgentOrigin,
): AgentProfileParse {
  const file = basename;
  const { fm, body } = splitAgentFrontmatter(raw);

  const name = normalizeAgentName(fm.name ?? '');
  if (name === '') {
    return {
      kind: 'error',
      file,
      reason: `agente "${file}": frontmatter sem "name" válido — perfil rejeitado (fail-closed)`,
    };
  }
  if (body === '') {
    return {
      kind: 'error',
      file,
      reason: `agente "${name}" (${file}): corpo vazio — sem system prompt, perfil rejeitado`,
    };
  }

  // RES-MD-3 — FALHA FECHADA do `tools`: só interpretamos quando a CHAVE existe. Se
  // existe e é ilegível, REJEITAMOS o perfil — jamais o degradamos p/ "herda tudo".
  let tools: readonly string[] | undefined;
  if (fm.hasToolsKey) {
    const parsed = parseToolsList(fm.toolsRaw ?? '');
    if (parsed === null) {
      return {
        kind: 'error',
        file,
        reason:
          `agente "${name}" (${file}): "tools" presente mas ilegível/vazio — ` +
          `perfil não carregado (uma lista de tools vazia ou ilegível é tratada como inválida, ` +
          `nunca como "sem tools = herda tudo")`,
      };
    }
    tools = parsed;
  }

  const description =
    fm.description !== undefined && fm.description !== '' ? fm.description : undefined;
  const model = fm.model !== undefined && fm.model !== '' ? fm.model : undefined;

  // GS-MD8 (carve-out F49): frontmatter `room`. Ausente / `true` ⇒ participa
  // (default). `false` (case-insensitive) ⇒ opt-out. Outros valores = true.
  const room: boolean | undefined =
    fm.roomRaw !== undefined
      ? fm.roomRaw.trim().toLowerCase() === 'false'
        ? false
        : true
      : undefined;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(room !== undefined ? { room } : {}),
    systemPrompt: body,
    origin,
  };
}
