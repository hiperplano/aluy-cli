// EST-0964 — LEITOR confinado do AGENT.md (instruções de projeto, análogo ao
// CLAUDE.md do Claude Code/OpenCode).
// EST-0979 — COMPAT: além do `AGENT.md` (nativo Aluy), lê também `AGENTS.md`
// (Codex/OpenAI) e `CLAUDE.md` (Claude Code) — MESMA injeção confiável no `system`.
//
// FRONTEIRA DE PROVENIÊNCIA (a distinção que o seguranca-light reconfere):
//
//   AGENT.md/AGENTS.md/CLAUDE.md
//             → CONFIGURAÇÃO DO PROJETO, escrita pelo DONO do repo, lida UMA VEZ
//               no startup do workspace confinado. É CONFIÁVEL: entra no canal
//               `system` (instrução), exatamente como o prompt do agente que NÓS
//               escrevemos. É o "primeiro" config do projeto (o dono define o
//               contexto: build/test, convenções, objetivo). Que o ARQUIVO use o
//               nome de outro ecossistema (Claude Code/Codex) NÃO muda a proveniência:
//               continua sendo config-do-dono-do-repo, lida no boot, confinada.
//
//   @arquivo  → DADO ingerido NO MEIO de um turno (o usuário aponta um arquivo
//               qualquer p/ o modelo analisar). É NÃO-CONFIÁVEL: entra como
//               `observation` ENVELOPADA (DADO_NAO_CONFIAVEL), nunca como
//               instrução. Esse caminho é o `AttachReader` — NÃO este.
//
// A diferença NÃO é o formato nem o NOME do arquivo (todos são arquivos do
// workspace) — é a PROVENIÊNCIA e o MOMENTO: config-do-dono-no-boot vs
// conteúdo-ingerido-no-turno. EST-0979 amplia as FONTES, NÃO relaxa a catraca:
// CLAUDE.md/AGENTS.md NÃO são instrução privilegiada por serem "de outro ecossistema".
//
// Mesmo CONFIÁVEL, cada arquivo é lido com as MESMAS travas de confinamento do canal
// de leitura (defesa-em-profundidade — config confiável não é cheque em branco):
//   1) CONFINAMENTO: lido SÓ de `<root>/<nome>` via WorkspacePort.resolveInside
//      (um symlink CLAUDE.md → /etc/shadow ou → fora da raiz ⇒ rejeitado, nada lido).
//   2) PATH-DENY: classifica o caminho (mesma malha do @); os nomes de instrução são
//      `allow`, mas a checagem fica explícita (gate seguranca-light, sem BYPASS).
//   3) TETO DE TAMANHO: `clampProjectInstructions` (cli-core) corta um arquivo gigante
//      ANTES de injetar — não estoura a janela de contexto. O TETO é aplicado por
//      arquivo E na composição final (anti-soma-gigante de 3 arquivos).
//
// Fail-safe: QUALQUER erro/ausência ⇒ o arquivo é PULADO (não derruba o startup).
// Nenhum arquivo presente ⇒ `undefined` (prompt baseline). Nunca lança.

import { clampProjectInstructions } from '@hiperplano/aluy-cli-core';
import type { FileSystemPort } from '@hiperplano/aluy-cli-core';
import { classifyAttachPath } from '../attach/path-deny.js';
import type { WorkspacePort } from './workspace.js';

/**
 * Nome canônico (nativo Aluy) do arquivo de instruções de projeto (raiz). É o que o
 * `init`/onboard CRIA. `AGENT.md` segue aceito como compat (ver
 * `PROJECT_INSTRUCTION_FILENAMES`), mas o nome próprio da plataforma é `ALUY.md`.
 */
export const AGENT_MD_FILENAME = 'ALUY.md';

/**
 * EST-0979 — FONTES de instrução de projeto, em ORDEM DE PRECEDÊNCIA (decrescente).
 * A ordem é CRAVADA e DOCUMENTADA: o nativo Aluy primeiro, depois os ecossistemas
 * de referência (Codex, Claude Code). Todos COMPÕEM (concatenam) quando presentes —
 * o dono pode ter contexto complementar em cada um; nenhum é privilegiado por ser
 * "do projeto" ou "de outro ecossistema". A ordem só decide a SEQUÊNCIA no `system`
 * (o nativo lidera) e o desempate quando precisa cortar pelo teto.
 *
 *   1. `ALUY.md`    — nativo Aluy (primário; o que o `init` cria).
 *   2. `AGENT.md`   — compat (nome anterior / convenção genérica de agente).
 *   3. `AGENTS.md`  — Codex/OpenAI.
 *   4. `CLAUDE.md`  — Claude Code/Anthropic.
 */
export const PROJECT_INSTRUCTION_FILENAMES = [
  'ALUY.md',
  'AGENT.md',
  'AGENTS.md',
  'CLAUDE.md',
] as const;

export interface LoadAgentMdOptions {
  readonly workspace: WorkspacePort;
  readonly fs: FileSystemPort;
}

/** Resultado da composição: o texto p/ o `system` + QUAIS arquivos contribuíram. */
export interface ProjectInstructionsLoad {
  /**
   * Instruções de projeto CLAMPADAS e COMPOSTAS (prontas p/ o canal `system`), ou
   * `undefined` se nenhum arquivo de instrução existe/é válido.
   */
  readonly instructions?: string;
  /** Nomes dos arquivos que de fato contribuíram (ordem de precedência). Vazio ⇒ nada. */
  readonly sources: readonly string[];
}

/**
 * Lê UM arquivo de instrução de projeto da raiz confinada, se existir e for válido.
 * Devolve `undefined` se o arquivo não existe, está vazio, escapa a raiz, ou é
 * classificado como sensível/proibido pelo path-deny. NUNCA lança (config opcional
 * não derruba o startup). Aplica as 3 travas: confinamento, path-deny, teto.
 */
async function loadOneInstructionFile(
  filename: string,
  opts: LoadAgentMdOptions,
): Promise<string | undefined> {
  const { workspace, fs } = opts;

  // 1) CONFINAMENTO: resolve `<filename>` contra a raiz; rejeita se escapa (symlink
  //    p/ fora, etc.). Erro de confinamento ⇒ não há arquivo confiável a ler.
  try {
    workspace.resolveInside(filename);
  } catch {
    return undefined;
  }

  // 2) PATH-DENY: os nomes de instrução são `allow`, mas a checagem é explícita (não
  //    é um BYPASS do regime de path-deny — gate seguranca-light).
  if (classifyAttachPath(filename).kind !== 'allow') {
    return undefined;
  }

  // Ausência ⇒ nada (este arquivo não contribui). `exists` também confina.
  if (!(await fs.exists(filename))) {
    return undefined;
  }

  // 3) LEITURA confinada (a FileSystemPort reconfina internamente — defesa dupla).
  let raw: string;
  try {
    raw = await fs.readFile(filename);
  } catch {
    return undefined;
  }

  // 4) TETO DE TAMANHO por arquivo: clampa ANTES de compor. Vazio ⇒ `undefined`.
  return clampProjectInstructions(raw);
}

/**
 * EST-0979 — Lê TODAS as fontes de instrução de projeto da raiz confinada, na ordem
 * de precedência (`PROJECT_INSTRUCTION_FILENAMES`), e COMPÕE as presentes num único
 * texto p/ o canal `system`. Cada arquivo é confinado/path-deny/clampado; a
 * composição é re-clampada (anti-soma-gigante). Devolve também QUAIS arquivos
 * contribuíram (p/ o indicador da TUI). Nenhum presente ⇒ `{ sources: [] }`.
 *
 * O resultado é CONFIÁVEL (config do dono) — diferente de um `@arquivo` (dado). É o
 * único ponto que promove conteúdo de arquivo a instrução, e SÓ p/ estes nomes
 * específicos, lidos no boot, dentro da raiz confinada. EST-0979 amplia as fontes
 * (Codex/Claude Code) SEM relaxar a catraca: continuam DADO confiável-do-dono.
 */
export async function loadProjectInstructions(
  opts: LoadAgentMdOptions,
): Promise<ProjectInstructionsLoad> {
  const parts: { filename: string; text: string }[] = [];
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    const text = await loadOneInstructionFile(filename, opts);
    if (text !== undefined) parts.push({ filename, text });
  }

  if (parts.length === 0) return { sources: [] };

  // UM arquivo só ⇒ injeta sem cabeçalho (preserva o comportamento da EST-0964).
  if (parts.length === 1) {
    return { instructions: parts[0]!.text, sources: [parts[0]!.filename] };
  }

  // VÁRIOS ⇒ compõe na ordem de precedência, com um cabeçalho discreto por fonte
  // (o leitor humano/modelo sabe de qual arquivo veio cada bloco). Re-clampa o todo.
  const composed = parts.map((p) => `<!-- fonte: ${p.filename} -->\n${p.text}`).join('\n\n');
  const clamped = clampProjectInstructions(composed);
  return {
    ...(clamped !== undefined ? { instructions: clamped } : {}),
    sources: parts.map((p) => p.filename),
  };
}

/**
 * EST-0964 (compat) — Lê o `AGENT.md` da raiz do workspace, se existir, e devolve as
 * instruções de projeto CLAMPADAS. Mantido para compatibilidade: hoje delega ao
 * leitor de UM arquivo, restrito ao `AGENT.md`. Devolve `undefined` se
 * ausente/vazio/escapa/sensível. NUNCA lança.
 */
export async function loadAgentMd(opts: LoadAgentMdOptions): Promise<string | undefined> {
  return loadOneInstructionFile(AGENT_MD_FILENAME, opts);
}
