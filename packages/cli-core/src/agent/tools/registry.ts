// EST-0944 — registro de tools nativas (nome → tool). O loop resolve o tool-call
// pelo nome aqui. Registro é DADO (lista injetável), não hardcode espalhado: o
// locus concreto pode estender (MCP entra atrás de EST-0945/0946, fora daqui).

import type { NativeTool, ToolPorts } from './types.js';

export class ToolRegistry<Ports = ToolPorts> {
  private readonly tools = new Map<string, NativeTool<Ports>>();
  /**
   * EST-BOOT-DECOUPLE — servers MCP AINDA CONECTANDO (nome puro, sem prefixo). O
   * boot desacoplado monta a sessão ANTES do handshake MCP terminar; enquanto um
   * server está aqui, uma chamada a `mcp__<server>__*` cai em "tool desconhecida"
   * (ele ainda não tem tools registradas) — `markMcpServerPending`/
   * `clearMcpServerPending` deixam o LOOP (core) distinguir esse caso do de uma
   * tool que nunca vai existir, p/ devolver uma observação HONESTA ("ainda
   * conectando") em vez do "tool desconhecida" genérico. Vazio ⇒ comportamento
   * intacto (nenhum server nesta lista, mensagem genérica de sempre).
   */
  private readonly pendingMcpServers = new Set<string>();

  constructor(tools: readonly NativeTool<Ports>[] = []) {
    for (const t of tools) this.register(t);
  }

  /** Marca um server MCP como AINDA CONECTANDO (boot desacoplado). Idempotente. */
  markMcpServerPending(server: string): void {
    this.pendingMcpServers.add(server);
  }

  /** Tira um server MCP da lista de pendentes (conectou ou desistiu). Idempotente. */
  clearMcpServerPending(server: string): void {
    this.pendingMcpServers.delete(server);
  }

  /** `true` enquanto o server MCP ainda não terminou de conectar (boot desacoplado). */
  isMcpServerPending(server: string): boolean {
    return this.pendingMcpServers.has(server);
  }

  register(tool: NativeTool<Ports>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool duplicada no registro: "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): NativeTool<Ports> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Remove uma tool pelo nome. Retorna `true` se ela existia. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * EST-0970 — substitui as tools MCP no registro AO VIVO (p/ `/mcp reload` e
   * `/mcp reconnect` sem reiniciar a sessão). Remove TODAS as tools cujo nome
   * começa com `mcp__` (se `serverScope` dado, só as que começam com
   * `mcp__${serverScope}__`); depois registra cada uma de `newTools`.
   */
  replaceMcpTools(newTools: readonly NativeTool<Ports>[], serverScope?: string): void {
    const prefix = serverScope !== undefined ? `mcp__${serverScope}__` : 'mcp__';
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
      }
    }
    for (const t of newTools) {
      if (this.tools.has(t.name)) {
        this.tools.delete(t.name); // substitui sem lançar duplicata
      }
      this.tools.set(t.name, t);
    }
  }

  /** Lista (p/ montar a descrição das tools no prompt do agente). */
  list(): readonly NativeTool<Ports>[] {
    return [...this.tools.values()];
  }
}
