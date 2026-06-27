// EST-0945 · CLI-SEC-9 — descritor do EFEITO EXATO a confirmar.
//
// A confirmação destrutiva/externa NUNCA mostra um resumo vago ("vou ajustar uns
// arquivos"): mostra o COMANDO exato, o DIFF exato ou a URL/destino exato. Este
// descritor é o contrato dessa exibição — a engine de permissão (EST-0945) o
// produz a partir do `ToolCall`, e a TUI (EST-0948) o renderiza no diálogo.
//
// PORTÁVEL: só dado (sem I/O). O `display` que a tool nativa já computa na 0944
// (`ToolResult.display`: `$ <cmd>`, o diff unificado, `read_file <path>`) é a
// MESMA verdade — aqui estruturamos por TIPO p/ a TUI poder formatar (syntax-
// highlight do diff, destaque do destino de rede) sem reparsear texto.

/** Tipo de efeito exato exibido na confirmação (CLI-SEC-9). */
export type ToolEffectKind = 'command' | 'diff' | 'network' | 'path';

/**
 * O efeito EXATO de um tool-call, estruturado p/ a confirmação informada.
 * Sempre carrega `exact` (a verdade literal: o comando, o diff, a URL ou o
 * caminho). Os campos extras (`tool`, `path`, `target`) são contexto opcional.
 */
export interface ToolEffectDescriptor {
  readonly kind: ToolEffectKind;
  /** Nome da tool que produz o efeito (run_command, edit_file, …). */
  readonly tool: string;
  /**
   * A verdade LITERAL a aprovar — o comando exato, o diff unificado exato, a URL
   * exata ou o caminho exato. É isto que o usuário aprova (CLI-SEC-9). Nunca um
   * resumo.
   */
  readonly exact: string;
  /** Caminho de arquivo tocado, quando aplicável (edit/read). */
  readonly path?: string;
  /** Destino externo (host/URL) quando o efeito é de rede. */
  readonly target?: string;
}

/** Constrói o descritor de um comando de shell (`$ <cmd>`). */
export function commandEffect(tool: string, command: string): ToolEffectDescriptor {
  return { kind: 'command', tool, exact: `$ ${command}` };
}

/** Constrói o descritor de um diff (o diff unificado EXATO já computado). */
export function diffEffect(tool: string, path: string, diff: string): ToolEffectDescriptor {
  return { kind: 'diff', tool, path, exact: diff };
}

/** Constrói o descritor de um efeito de rede (a URL/destino EXATO). */
export function networkEffect(tool: string, command: string, target: string): ToolEffectDescriptor {
  return { kind: 'network', tool, exact: `$ ${command}`, target };
}

/** Constrói o descritor de um caminho tocado (read/edit sem diff disponível). */
export function pathEffect(tool: string, path: string): ToolEffectDescriptor {
  return { kind: 'path', tool, path, exact: path };
}

/**
 * P1 · ADR-0065 §8.2 / APR-0087 — classificação pura de rede para o sandbox.
 *
 * Extrai um host/URL de um comando de shell p/ determinar se ele precisa de rede.
 * Best-effort: pega o primeiro token que pareça URL, host:porta, user@host, ou
 * argumento de comando de rede (ssh/scp/sftp/telnet/nc). A MESMA função usada pela
 * catraca (`describeEffect` → `networkEffect`) e pelo shell-port (sandbox `network`
 * decision) — NUNCA duplicar política.
 *
 * Retorna `undefined` quando o comando NÃO tem sinal de rede ⇒ `network:false` no
 * sandbox (invariante: sem host ⇒ sem rede).
 *
 * PORTÁVEL: regex puro, sem I/O. A política de egress (ADR-0060) é camada separada.
 */
export function networkTargetOf(command: string): string | undefined {
  const url = command.match(/\bhttps?:\/\/[^\s"';|&]+/);
  if (url) return url[0];
  const scpLike = command.match(/\b[\w.-]+@[\w.-]+:[^\s"';|&]*/);
  if (scpLike) return scpLike[0];
  // user@host (ssh sem porta/caminho) — preserva o destino completo (CLI-SEC-9).
  const userHost = command.match(/\b[\w.-]+@[\w.-]+/);
  if (userHost) return userHost[0];
  const host = command.match(/\b(?:ssh|scp|sftp|telnet|nc|ncat)\s+(?:-\w+\s+)*([\w.-]+)/);
  if (host?.[1]) return host[1];
  return undefined;
}
