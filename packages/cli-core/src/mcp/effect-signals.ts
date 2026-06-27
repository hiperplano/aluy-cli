// EST-0970 · ADR-0058 (E-B2) · CLI-SEC-12 — classificação de EFEITO de uma tool
// MCP a partir de SINAIS NÃO-CONFIÁVEIS-DO-SERVER, NUNCA do rótulo auto-declarado.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ E-B2 (gate FORTE do `seguranca`) — A MARCA `readonly`/`effect` DA TOOL MCP  ║
// ║ É AUTO-DECLARADA PELO SERVER ⇒ NÃO-CONFIÁVEL. Um server malicioso declara   ║
// ║ "readonly" e mesmo assim escreve no FS / faz POST. Por isso a classificação ║
// ║ de efeito NÃO lê NENHUM rótulo do descritor da tool — ela infere o efeito   ║
// ║ de SINAIS observáveis do INPUT (presença de path/URL/host/rede). Na DÚVIDA  ║
// ║ (sem sinal claro), a tool MCP é EFEITO ⇒ `decide()` força `ask` (default-   ║
// ║ deny do desconhecido). Re-handshake RE-CLASSIFICA (sem cache "já aprovei").  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Princípio (espelha `categories.ts`): conservador, fail-safe, alto recall. Um
// falso-positivo custa uma confirmação a mais; um falso-negativo deixa uma tool de
// efeito passar silenciosa — inaceitável (CLI-T1/T6/T8). Quando em dúvida, sinaliza.
//
// PORTÁVEL: regex/string puro, sem I/O nem `node:*`.

/** Prefixo canônico de TODA tool MCP no toolset do agente: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__';

/** `true` se o NOME de uma tool é de uma tool MCP (prefixo canônico). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Sinal de rede observado no input de uma tool MCP (URL/host/esquema remoto). */
const NETWORK_VALUE_PATTERNS: readonly RegExp[] = [
  /\bhttps?:\/\//i,
  // qualquer esquema de URL remoto (ftp://, ssh://, ws(s)://, gs://, s3://, …),
  // EXCETO file:// (local).
  /\b(?!file:)[a-z][a-z0-9+.-]*:\/\//i,
  // user@host FQDN (scp/ssh-like).
  /\b[\w.-]+@[\w.-]+\.[\w.-]+/,
  // host:porta remoto.
  /\b[\w.-]+\.[\w.-]+:\d+\b/,
];

/**
 * `true` se ALGUM valor-string do input parece um destino de REDE. Varre TODOS os
 * valores (não só uma chave fixa): o nome do campo é escolha do server (não-
 * confiável), então olhamos o CONTEÚDO. Conservador (E-B2).
 */
export function inputHasNetworkSignal(input: Readonly<Record<string, unknown>>): boolean {
  for (const v of collectStrings(input)) {
    for (const re of NETWORK_VALUE_PATTERNS) {
      if (re.test(v)) return true;
    }
  }
  return false;
}

/**
 * Coleta os valores-string de um input (1 nível + arrays + objetos rasos). Um
 * server pode aninhar o destino; varremos raso p/ não perder o sinal, sem recursão
 * ilimitada (fail-safe, sem ReDoS de profundidade). Puro.
 */
export function collectStrings(input: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === 'string') {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) visit(item, depth + 1);
    }
  };
  visit(input, 0);
  return out;
}

/**
 * Chaves de input cujo VALOR é tratado como um caminho de arquivo p/ inspeção de
 * path (sensível/fora-do-workspace/`~/.aluy`). O server escolhe os nomes das
 * chaves (não-confiável), então cobrimos os nomes COMUNS de campo de caminho. A
 * inspeção real (sensível/journal/outside) é feita por `categories.ts` reusando os
 * matchers existentes — aqui só EXTRAÍMOS os candidatos a path do input.
 */
const PATH_LIKE_KEYS: readonly string[] = [
  'path',
  'file',
  'filepath',
  'file_path',
  'filename',
  'dir',
  'directory',
  'folder',
  'target',
  'dest',
  'destination',
  'source',
  'src',
  'output',
  'input',
  'cwd',
  'root',
];

/**
 * Extrai do input os VALORES que parecem caminho de arquivo, p/ a catraca os
 * inspecionar contra os matchers de path existentes (sensível/journal/outside-
 * workspace). Pega: (a) valores de chaves com nome de path conhecido; (b) qualquer
 * valor-string que PAREÇA um caminho (tem `/`, começa por `~`/`.`/abs). Conservador
 * (E-B2): mais candidatos ⇒ mais chance de a inspeção casar um path perigoso.
 */
export function extractPathCandidates(input: Readonly<Record<string, unknown>>): string[] {
  const out = new Set<string>();
  // (a) chaves com nome de path conhecido (case-insensitive).
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && PATH_LIKE_KEYS.includes(k.toLowerCase())) {
      out.add(v);
    }
  }
  // (b) qualquer string aninhada que PAREÇA um path (heurística textual).
  for (const v of collectStrings(input)) {
    if (looksLikePath(v)) out.add(v);
  }
  return [...out];
}

/** `true` se a string parece um caminho de arquivo (tem `/`, ou `~`/`.`/abs no início). */
function looksLikePath(v: string): boolean {
  if (v.length === 0 || v.length > 4096) return false;
  // contém separador de caminho, OU começa por `~`/`./`/`../`/`/`/`C:\`.
  if (v.includes('/')) return true;
  if (/^~(?:$|\/)/.test(v)) return true;
  if (/^\.{1,2}\//.test(v)) return true;
  if (/^[A-Za-z]:[\\/]/.test(v)) return true;
  return false;
}
