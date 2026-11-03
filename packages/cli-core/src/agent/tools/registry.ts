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

  /**
   * PROMPT-ENXUTO — ORDEM ESTÁVEL do catálogo (prefix-cache do provider casa byte a byte).
   * Até o boot MCP assentar, as tools MCP saem ORDENADAS (server, nome) — não na ordem em
   * que os handshakes terminaram. Depois de `freezeMcpOrder()`, uma tool MCP NOVA (server que
   * conectou tarde, `/mcp reload`) vai para o FIM, na ordem de chegada, sem reordenar o que
   * o modelo já viu.
   */
  private mcpOrderFrozen = false;
  private readonly lateMcpNames: string[] = [];
  private mcpSettleWaiters: Array<() => void> = [];

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
    if (this.pendingMcpServers.size === 0) this.releaseSettleWaiters();
  }

  private releaseSettleWaiters(): void {
    const ws = this.mcpSettleWaiters;
    this.mcpSettleWaiters = [];
    for (const w of ws) w();
  }

  /**
   * PROMPT-ENXUTO — espera (no máximo `timeoutMs`) os servers MCP ainda conectando
   * assentarem, p/ a 1ª chamada ao modelo já sair com o catálogo COMPLETO. Nunca rejeita e
   * nunca passa de `timeoutMs`: um server lento/quebrado não trava a sessão. Ao terminar
   * (assentou OU estourou) CONGELA a ordem (`freezeMcpOrder`): o que conectar depois vai
   * para o fim. Devolve os servers que ficaram de fora (vazio ⇒ assentou).
   */
  /** Servers MCP ainda conectando agora (síncrono; p/ a UI rotular a espera como honesta). */
  pendingMcp(): readonly string[] {
    return [...this.pendingMcpServers];
  }

  async awaitMcpSettled(timeoutMs: number): Promise<readonly string[]> {
    if (this.pendingMcpServers.size > 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        this.mcpSettleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.freezeMcpOrder();
    return [...this.pendingMcpServers];
  }

  /** Congela a ordem das tools MCP já presentes; novas entram no fim. Idempotente. */
  freezeMcpOrder(): void {
    this.mcpOrderFrozen = true;
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
    this.dropLate(name);
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
    // Nomes que JÁ estavam no catálogo (e portanto mantêm a posição) vs. os realmente novos.
    const before = new Set<string>();
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix)) {
        before.add(name);
        this.tools.delete(name);
      }
    }
    for (const t of newTools) {
      if (this.tools.has(t.name)) {
        this.tools.delete(t.name); // substitui sem lançar duplicata
      }
      this.tools.set(t.name, t);
      if (this.mcpOrderFrozen && t.name.startsWith('mcp__')) {
        if (!before.has(t.name) && !this.lateMcpNames.includes(t.name)) {
          this.lateMcpNames.push(t.name);
        }
      }
    }
    // Reconexão: o que sumiu do server não deve ficar na lista de "tardias".
    for (const n of [...this.lateMcpNames]) if (!this.tools.has(n)) this.dropLate(n);
  }

  private dropLate(name: string): void {
    const i = this.lateMcpNames.indexOf(name);
    if (i >= 0) this.lateMcpNames.splice(i, 1);
  }

  /**
   * Lista (p/ montar a descrição das tools no prompt do agente E o campo `tools` nativo).
   * ORDEM DETERMINÍSTICA: nativas na ordem de registro (fixa no código), depois as MCP
   * ordenadas por (server, nome) e, por último, as MCP que chegaram TARDE (após o congelamento),
   * na ordem de chegada. Independe de qual handshake MCP terminou primeiro.
   */
  list(): readonly NativeTool<Ports>[] {
    const native: NativeTool<Ports>[] = [];
    const mcp: NativeTool<Ports>[] = [];
    const late = new Set(this.lateMcpNames);
    for (const t of this.tools.values()) {
      if (!t.name.startsWith('mcp__')) native.push(t);
      else if (!late.has(t.name)) mcp.push(t);
    }
    mcp.sort(compareMcpTools);
    const tail: NativeTool<Ports>[] = [];
    for (const n of this.lateMcpNames) {
      const t = this.tools.get(n);
      if (t) tail.push(t);
    }
    return [...native, ...mcp, ...tail];
  }
}

/** `mcp__<server>__<tool>` → [server, tool]; compara por code unit (independe de locale). */
function compareMcpTools(a: { name: string }, b: { name: string }): number {
  const [sa, ta] = splitMcpName(a.name);
  const [sb, tb] = splitMcpName(b.name);
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return 0;
}

function splitMcpName(name: string): [string, string] {
  const rest = name.slice('mcp__'.length);
  const i = rest.indexOf('__');
  return i < 0 ? [rest, ''] : [rest.slice(0, i), rest.slice(i + 2)];
}
