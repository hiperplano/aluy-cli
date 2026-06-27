// EST-1112 · ADR-0116 (proposto) — SKILLS definidas em `SKILL.md` (parser PURO).
// Uma SKILL é uma CAPACIDADE invocável EMPACOTADA: um DIRETÓRIO `<nome>/` com um
// `SKILL.md` (manifesto: frontmatter + instruções no corpo) e, opcionalmente,
// recursos auxiliares (scripts/templates) ao lado. O usuário a invoca por nome
// (estilo `/skill <nome>`); o corpo do `SKILL.md` é INJETADO como instrução/
// capacidade no contexto do agente SOB DEMANDA (carregamento "progressivo").
//
//   skills/
//     pdf-fill/
//       SKILL.md          ← manifesto (este parser)
//       template.json     ← recurso auxiliar (não lido aqui; referenciado no corpo)
//
//   ---
//   name: pdf-fill
//   description: Preenche formulários PDF a partir de um JSON de campos.
//   ---
//   Para preencher um PDF: 1) leia o template.json ao lado…  ← instruções (corpo)
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ FRONTEIRA DE SEGURANÇA (o que o gate FORTE do `seguranca` reconfere) — este ║
// ║ MÓDULO É PARSER PURO; ele NÃO concede nada e NÃO executa nada.             ║
// ║                                                                            ║
// ║ • Uma skill INJETA INSTRUÇÕES (texto). Ela NÃO é um caminho de execução     ║
// ║   paralelo: tudo o que o modelo fizer A PARTIR das instruções continua      ║
// ║   passando por `decide()` (CLI-SEC-H1). A skill não "concede" tool alguma.  ║
// ║                                                                            ║
// ║ • PROVENIÊNCIA por `origin` (carregada pelo LOADER confinado, NÃO pelo      ║
// ║   conteúdo): `global` (`~/.aluy/skills/`, config do dono = confiável) vs    ║
// ║   `project` (`.claude/skills/` / `.aluy/skills/` do workspace = DADO de     ║
// ║   terceiro). O parser NÃO confia no `name`/`description` p/ promover camada. ║
// ║   A description de uma skill de PROJETO é DADO não-confiável (nunca decide   ║
// ║   sozinha o que roda — só o usuário INVOCA a skill por nome).               ║
// ║                                                                            ║
// ║ • RES-MD-3 (FALHA FECHADA): `SKILL.md` sem `name` válido OU com corpo vazio  ║
// ║   ⇒ `SkillError` (não vira "skill silenciosa/sem instrução"). O loader o     ║
// ║   coleta em `errors` (carga visível) em vez de registrar a skill.           ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): parser de string PURO (sem `node:*`, sem I/O). A LEITURA
// confinada dos diretórios de skills é do locus concreto (@hiperplano/aluy-cli, io/).

/** Camada de descoberta de uma skill — define a CONFIANÇA da proveniência. */
export type SkillOrigin =
  /** `~/.aluy/skills/` — config do DONO, confiável. */
  | 'global'
  /** `.claude/skills/` / `.aluy/skills/` do workspace — DADO de terceiro. */
  | 'project';

/**
 * Uma skill já PARSEADA de um `SKILL.md`. O `name` é a identidade declarada (o que
 * `/skill <nome>` invoca). `instructions` é o corpo do `SKILL.md` = a capacidade
 * injetada no contexto sob demanda. A `origin` é carregada pelo LOADER (filesystem
 * confinado), não auto-declarada pelo conteúdo.
 */
export interface Skill {
  /** Identidade da skill (frontmatter `name`), normalizada. */
  readonly name: string;
  /** O que a skill faz (frontmatter `description`). Opcional, mas recomendado. */
  readonly description?: string;
  /**
   * O corpo do `SKILL.md` = as INSTRUÇÕES/capacidade injetadas no contexto quando a
   * skill é invocada. Nunca vazio (o parser rejeita corpo vazio — RES-MD-3).
   */
  readonly instructions: string;
  /** Camada de descoberta (carregada pelo loader confinado, não pelo conteúdo). */
  readonly origin: SkillOrigin;
}

/**
 * RES-MD-3 — FALHA FECHADA. Quando o `SKILL.md` é malformado, o parser devolve ISTO
 * em vez de uma `Skill`. A skill NÃO entra no registro (carga visível). `reason` é
 * legível p/ o erro de carga.
 */
export interface SkillError {
  readonly kind: 'error';
  /** Nome da skill (basename do diretório) que falhou — p/ a mensagem de carga. */
  readonly name: string;
  /** Motivo legível da rejeição. */
  readonly reason: string;
}

/** Resultado do parse: a skill OU o erro fail-closed (RES-MD-3). */
export type SkillParse = Skill | SkillError;

/** `true` se o parse falhou (fail-closed) — o loader descarta com erro visível. */
export function isSkillError(p: SkillParse): p is SkillError {
  return (p as SkillError).kind === 'error';
}

/** Teto defensivo do nome (anti-nome-gigante / anti-DoS de registro). */
const MAX_NAME_LEN = 64;

/**
 * Normaliza o NOME de uma skill: minúsculas + só `[a-z0-9_-]` (qualquer outro vira
 * `-`), bordas aparadas, teto de tamanho. Casa a gramática de identificador (o
 * `/skill <nome>` invoca por este nome). Vazio após normalizar ⇒ `''` (o parser
 * rejeita — fail-closed). PURO.
 */
export function normalizeSkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LEN);
}

/** Frontmatter de um `SKILL.md` já extraído (cru, antes de normalizar). */
interface RawSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

/**
 * Extrai o frontmatter YAML-MÍNIMO (bloco `---`…`---` no TOPO) + o corpo. Só pares
 * `chave: valor` de 1 linha (sem YAML aninhado — config simples, sem dependência de
 * parser YAML; espelha o `splitAgentFrontmatter`). Tolera BOM/CRLF. Sem frontmatter
 * ⇒ tudo é corpo (sem `name` ⇒ o parser herda o nome do diretório). PURO.
 */
function splitSkillFrontmatter(raw: string): { fm: RawSkillFrontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };

  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    // Tira aspas envolventes (`name: "x"` ⇒ `x`).
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
  }
  return { fm: out, body: text.slice(m[0].length).trim() };
}

/**
 * Parseia o conteúdo cru de um `SKILL.md` numa `Skill` OU num `SkillError` (RES-MD-3,
 * fail-closed). O `dirName` é o basename do DIRETÓRIO da skill — usado como fallback
 * do `name` (uma skill `pdf-fill/SKILL.md` sem `name:` no frontmatter herda `pdf-fill`
 * do diretório, padrão de descoberta por pasta). A `origin` é injetada pelo LOADER
 * (filesystem confinado), não inferida do conteúdo.
 *
 * Rejeita (erro de skill, NÃO entra no registro):
 *   - `name` ausente/vazio TANTO no frontmatter QUANTO no nome do diretório;
 *   - corpo (instruções) vazio.
 *
 * PURO.
 */
export function parseSkill(dirName: string, raw: string, origin: SkillOrigin): SkillParse {
  const { fm, body } = splitSkillFrontmatter(raw);

  // O `name` do frontmatter VENCE; sem ele, herda o nome do DIRETÓRIO (descoberta por
  // pasta — o padrão de skills). Ambos vazios ⇒ rejeita.
  const fromFm = normalizeSkillName(fm.name ?? '');
  const name = fromFm !== '' ? fromFm : normalizeSkillName(dirName);
  if (name === '') {
    return {
      kind: 'error',
      name: dirName,
      reason: `skill "${dirName}": sem "name" válido (frontmatter nem nome do diretório) — rejeitada (fail-closed)`,
    };
  }
  if (body === '') {
    return {
      kind: 'error',
      name,
      reason: `skill "${name}": SKILL.md com corpo vazio — sem instruções, rejeitada (fail-closed)`,
    };
  }

  const description =
    fm.description !== undefined && fm.description !== '' ? fm.description : undefined;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    instructions: body,
    origin,
  };
}
