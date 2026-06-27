// EST-1125 · ADR-0123 §4, §4.1, §4.3, §6.1 (CA-MA6), §7 (Q-MA9) —
// ESQUELETO DO GRAFO DE CAIXAS DE CONTEXTO DO MAESTRO.
//
// O grafo de caixas é o modelo de DADO interno do Maestro: caixas (ContextBox)
// com horizonte (longo/médio/curto) e arestas de containment (longo ⊃ médio ⊃
// curto) + dependência. Esqueleto na v1: estrutura + isolamento +
// abertura/fechamento dinâmico + teto anti-runaway + eviction heurística.
//
// FORA de escopo (v2): persistência, paginação POR caixa, eviction por
// salience-LLM (judge). A projeção update_plan é EST-1126.
//
// PORTÁVEL (ADR-0053 §8): estado puro + mecânica, sem I/O. O conteúdo de uma
// caixa é DADO (CLI-SEC-4), nunca instrução nem autorização. O grafo NÃO é
// caminho de permissão (CLI-SEC-H1 intocada).

// ── Tipos ───────────────────────────────────────────────────────────────────

/** Horizonte temporal da caixa, governando a RETENÇÃO (§4.1). */
export type BoxHorizon = 'longo' | 'médio' | 'curto';

/** Identidade única de uma caixa no grafo. */
export type BoxId = string;

/** Sentido de uma aresta de dependência entre caixas. */
export type DependencyDirection = 'depends_on' | 'depended_by';

/** Uma entrada de contexto numa caixa (imutável após criação). */
export interface ContextEntry {
  /** Timestamp de criação (ms epoch). */
  readonly ts: number;
  /** Conteúdo textual do contexto. */
  readonly text: string;
}

/** Snapshot público imutável de uma caixa. */
export interface BoxSnapshot {
  readonly id: BoxId;
  readonly horizon: BoxHorizon;
  readonly label: string;
  readonly parentId: BoxId | null;
  readonly children: readonly BoxId[];
  readonly dependencies: readonly BoxId[];
  readonly pinned: boolean;
  readonly closed: boolean;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  readonly contextSize: number;
}

/** Resultado da abertura de uma caixa. */
export interface OpenBoxResult {
  readonly box: BoxSnapshot;
  /** `true` se a caixa foi recém-criada; `false` se já existia (idempotente). */
  readonly created: boolean;
}

/** Critério de ordenação para busca/lista de caixas. */
export type BoxSortBy = 'createdAt' | 'lastAccessedAt' | 'accessCount';

// ── Nó interno ──────────────────────────────────────────────────────────────

class BoxNode {
  readonly id: BoxId;
  horizon: BoxHorizon;
  readonly label: string;
  parentId: BoxId | null;
  readonly children: Set<BoxId>;
  readonly dependencies: Set<BoxId>; // ids das caixas das quais ESTA caixa depende
  pinned: boolean;
  closed: boolean;
  readonly createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  readonly context: ContextEntry[];

  constructor(id: BoxId, horizon: BoxHorizon, label: string, parentId: BoxId | null, now: number) {
    this.id = id;
    this.horizon = horizon;
    this.label = label;
    this.parentId = parentId;
    this.children = new Set();
    this.dependencies = new Set();
    this.pinned = false;
    this.closed = false;
    this.createdAt = now;
    this.lastAccessedAt = now;
    this.accessCount = 0;
    this.context = [];
  }

  touch(now: number): void {
    this.lastAccessedAt = now;
    this.accessCount += 1;
  }

  snapshot(): BoxSnapshot {
    return {
      id: this.id,
      horizon: this.horizon,
      label: this.label,
      parentId: this.parentId,
      children: [...this.children],
      dependencies: [...this.dependencies],
      pinned: this.pinned,
      closed: this.closed,
      createdAt: this.createdAt,
      lastAccessedAt: this.lastAccessedAt,
      accessCount: this.accessCount,
      contextSize: this.context.length,
    };
  }
}

// ── Parâmetros ──────────────────────────────────────────────────────────────

export const DEFAULT_MAX_BOXES = 200;

// ── Grafo ───────────────────────────────────────────────────────────────────

/**
 * Grafo de caixas de contexto do Maestro.
 *
 * Invariantes:
 * - CA-MA6: o contexto de uma subatividade curta NÃO contamina a caixa do
 *   trabalho longo (isolamento por caixa).
 * - Q-MA9: granularidade HÍBRIDA (auto pelo Maestro + explícito pelo agente);
 *   teto anti-runaway ~200 nós + eviction por horizonte/recência/frequência/pin.
 * - Caixa-longa e caixas pinadas NUNCA são evictadas sob pressão.
 *
 * Thread-safe: todos os métodos públicos são síncronos e autônomos.
 * Sem I/O (portável — ADR-0053 §8).
 */
export class ContextGraph {
  private readonly nodes: Map<BoxId, BoxNode> = new Map();
  private readonly maxBoxes: number;
  private now: () => number;

  constructor(opts?: { maxBoxes?: number; clock?: () => number }) {
    this.maxBoxes = opts?.maxBoxes ?? DEFAULT_MAX_BOXES;
    this.now = opts?.clock ?? Date.now;
  }

  // ── Fábrica de IDs ─────────────────────────────────────────────────────

  /** Gera um ID único para uma nova caixa (determinístico: label + timestamp). */
  static boxId(label: string, now: number): BoxId {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    return `${slug}-${now.toString(36)}`;
  }

  // ── Abertura / fechamento (Q-MA9 híbrido) ─────────────────────────────

  /**
   * Abre uma caixa (idempotente: se já existe com o mesmo ID, retorna a
   * existente com `created: false`). Cria a aresta de containment se `parentId`
   * for fornecido e a caixa-pai existir.
   *
   * Q-MA9 — abertura automática (Maestro) ou explícita (agente).
   *
   * HUNT-GRAFO (F133) — RECUSA (`null`) quando o grafo está no TETO e NÃO há
   * vítima elegível p/ eviction (todas `longo`/pinadas — invariante §4.1: estas
   * NUNCA são evictadas sob pressão). Antes, o `evictOne()` devolvia null mas
   * `openBox` criava a caixa MESMO ASSIM ⇒ `size` ultrapassava `maxBoxes` e o teto
   * anti-runaway virava DERROTÁVEL: abrir N caixas `longo`/pinadas crescia o grafo
   * SEM LIMITE (EST-1011 "recurso sem teto" — a própria classe que este cap existe
   * p/ barrar). Recusar preserva o teto E o §4.1; o caller degrada loud (a caixa
   * não existe ⇒ `addContext`/`getBox` no-op, o grafo já tolera ids inexistentes).
   * Idempotência intocada: reabrir caixa EXISTENTE nunca recusa (não cresce).
   */
  openBox(
    id: BoxId,
    horizon: BoxHorizon,
    label: string,
    parentId?: BoxId | null,
  ): OpenBoxResult | null {
    const existing = this.nodes.get(id);
    if (existing) {
      existing.touch(this.now());
      return { box: existing.snapshot(), created: false };
    }

    // Teto anti-runaway: evict antes de criar nova caixa. Se NADA é elegível
    // (todas longo/pinadas) e seguimos no teto ⇒ RECUSA (não cresce sem limite).
    if (this.nodes.size >= this.maxBoxes) {
      this.evictOne();
      if (this.nodes.size >= this.maxBoxes) return null;
    }

    const ts = this.now();
    const node = new BoxNode(id, horizon, label, parentId ?? null, ts);

    // Containment: se tem pai, registra nos dois lados.
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) {
        parent.children.add(id);
      }
    }

    this.nodes.set(id, node);
    return { box: node.snapshot(), created: true };
  }

  /**
   * Fecha uma caixa (marca como `closed`). Caixas fechadas permanecem no
   * grafo (não são removidas) mas são candidatas prioritárias à eviction.
   * Q-MA9 — fecha na conclusão.
   */
  closeBox(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.closed = true;
    node.touch(this.now());
    return node.snapshot();
  }

  /** Retorna `true` se a caixa existe e está fechada. */
  isClosed(id: BoxId): boolean {
    const node = this.nodes.get(id);
    return node ? node.closed : false;
  }

  /**
   * Reabre uma caixa fechada (ex.: o passo do plano voltou de `completed` para
   * `pending`/`in_progress`). No-op se a caixa não existe.
   */
  reopenBox(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.closed = false;
    node.touch(this.now());
    return node.snapshot();
  }

  /**
   * Atualiza o HORIZONTE de uma caixa existente (EST-1126 — heurística do
   * plano: o foco atual vira `curto`, o futuro vira `longo`). `openBox` é
   * idempotente e NÃO mexe no horizonte de caixa já aberta; este é o ponto
   * único para reclassificar conforme o plano avança. No-op se não existe.
   */
  setHorizon(id: BoxId, horizon: BoxHorizon): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.horizon = horizon;
    node.touch(this.now());
    return node.snapshot();
  }

  /**
   * (Re)define o PAI de uma caixa, ajustando as arestas de containment dos dois
   * lados (remove do pai antigo, adiciona ao novo). Idempotente se já é o pai.
   * No-op se a caixa não existe. (EST-1126 — um passo que ganha sub-passos.)
   */
  setParent(id: BoxId, parentId: BoxId | null): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    if (node.parentId === parentId) return node.snapshot();
    // HUNT-GRAFO — containment é uma ÁRVORE: jamais deixe `setParent` fechar um
    // CICLO (parentId == id, ou parentId é DESCENDENTE de id). Um ciclo penduraria
    // os walks recursivos (`getContextChain`, e o `getDepth` da projeção do plano)
    // — bug de DoS/limbo. O `update_plan` hoje não cria ciclo (tops são raiz-null),
    // mas `setParent` é API PÚBLICA do grafo (porta `ports.graph`): blindamos por
    // CONSTRUÇÃO. Cycle ⇒ REFUSA (no-op, devolve null) — mantém o pai anterior.
    if (parentId !== null && this.wouldCreateCycle(id, parentId)) return null;
    if (node.parentId) {
      this.nodes.get(node.parentId)?.children.delete(id);
    }
    node.parentId = parentId;
    if (parentId) {
      this.nodes.get(parentId)?.children.add(id);
    }
    node.touch(this.now());
    return node.snapshot();
  }

  /**
   * `true` se tornar `parentId` o pai de `id` fecharia um ciclo — i.e., `parentId`
   * é o PRÓPRIO `id` ou um DESCENDENTE de `id` (alcançável subindo a cadeia de pais
   * a partir de `parentId` chega-se em `id`). O `seen` também protege contra um
   * ciclo PRÉ-existente (não pendura a própria checagem). PURO (só lê).
   */
  private wouldCreateCycle(id: BoxId, parentId: BoxId): boolean {
    const seen = new Set<BoxId>();
    let cur: BoxId | null = parentId;
    while (cur !== null) {
      if (cur === id) return true; // id é ancestral de parentId ⇒ ciclo
      if (seen.has(cur)) return true; // ciclo pré-existente — não fecha outro
      seen.add(cur);
      cur = this.nodes.get(cur)?.parentId ?? null;
    }
    return false;
  }

  // ── Acesso ─────────────────────────────────────────────────────────────

  /** Obtém snapshot de uma caixa pelo ID (null se não existe). */
  getBox(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.touch(this.now());
    return node.snapshot();
  }

  /** Lista snapshots de todas as caixas (ordenável). */
  listBoxes(sortBy: BoxSortBy = 'lastAccessedAt'): BoxSnapshot[] {
    const snapshots = [...this.nodes.values()].map((n) => n.snapshot());
    switch (sortBy) {
      case 'createdAt':
        return snapshots.sort((a, b) => a.createdAt - b.createdAt);
      case 'accessCount':
        return snapshots.sort((a, b) => b.accessCount - a.accessCount);
      case 'lastAccessedAt':
      default:
        return snapshots.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    }
  }

  /** Número de caixas vivas no grafo. */
  get size(): number {
    return this.nodes.size;
  }

  // ── Containment (CA-MA6 — isolamento por caixa) ───────────────────────

  /**
   * Adiciona contexto a UMA caixa (isolamento CA-MA6). O contexto NÃO vaza
   * para outras caixas — cada caixa carrega o SEU próprio contexto.
   */
  addContext(id: BoxId, text: string): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.context.push({ ts: this.now(), text });
    node.touch(this.now());
    return node.snapshot();
  }

  /**
   * Lê o contexto de UMA caixa (somente o dela — isolamento). Retorna
   * array vazio se a caixa não existir.
   */
  getContext(id: BoxId): readonly ContextEntry[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    node.touch(this.now());
    return [...node.context];
  }

  /**
   * Lê o contexto de uma caixa E de seus ancestrais recursivamente (cadeia
   * de containment: pai → avô → ...). O contexto de caixas-irmãs ou outras
   * NÃO é incluído. Útil para recuperar o contexto do "trabalho longo" ao
   * qual uma subatividade pertence.
   */
  getContextChain(id: BoxId): { boxId: BoxId; entries: readonly ContextEntry[] }[] {
    const result: { boxId: BoxId; entries: readonly ContextEntry[] }[] = [];
    // HUNT-GRAFO — `seen` é defesa-em-profundidade: `setParent` já mantém o grafo
    // acíclico, mas se um ciclo escapasse, este walk PENDURARIA (loop infinito).
    // Para no 1º nó repetido (nunca pendura).
    const seen = new Set<BoxId>();
    let current: BoxId | null = id;
    while (current) {
      if (seen.has(current)) break;
      seen.add(current);
      const node = this.nodes.get(current);
      if (!node) break;
      node.touch(this.now());
      result.push({ boxId: node.id, entries: [...node.context] });
      current = node.parentId;
    }
    return result;
  }

  // ── Dependências ─────────────────────────────────────────────────────

  /**
   * Declara que `dependent` depende de `dependency`. Aresta direcionada de
   * dependência entre caixas (uma subatividade depende de outra).
   */
  addDependency(dependent: BoxId, dependency: BoxId): boolean {
    const depNode = this.nodes.get(dependent);
    if (!depNode || !this.nodes.has(dependency)) return false;
    if (depNode.id === dependency) return false; // sem self-loop
    depNode.dependencies.add(dependency);
    depNode.touch(this.now());
    return true;
  }

  /** Lista os IDs das caixas das quais a caixa `id` depende. */
  getDependencies(id: BoxId): BoxId[] {
    const node = this.nodes.get(id);
    return node ? [...node.dependencies] : [];
  }

  // ── Pin ───────────────────────────────────────────────────────────────

  /** Pina uma caixa (nunca-evicta sob pressão). */
  pinBox(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.pinned = true;
    node.touch(this.now());
    return node.snapshot();
  }

  /** Despina uma caixa. */
  unpinBox(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    node.pinned = false;
    node.touch(this.now());
    return node.snapshot();
  }

  // ── Eviction heurística (Q-MA9, v1 sem judge-LLM) ────────────────────

  /**
   * Remove UMA caixa do grafo (eviction heurística). Ordem de precedência:
   * 1. NUNCA evicta caixas `longo` (invariante §4.1).
   * 2. NUNCA evicta caixas pinadas.
   * 3. Prefere caixas `curto` sobre `médio`.
   * 4. Prefere caixas fechadas sobre abertas.
   * 5. Dentro do mesmo horizonte/estado, evicta a menos recentemente acessada
   *    (recência) e com menor `accessCount` (frequência) como desempate.
   *
   * Heurística pura, SEM judge-LLM (v2).
   *
   * @returns O snapshot da caixa evictada, ou null se nenhuma for elegível.
   */
  evictOne(): BoxSnapshot | null {
    // Coleciona candidatas elegíveis (NÃO longo, NÃO pinadas).
    const candidates: BoxNode[] = [];
    for (const node of this.nodes.values()) {
      // Invariante DURA: nunca evictar caixa-longa ou pinada.
      if (node.horizon === 'longo' || node.pinned) continue;
      candidates.push(node);
    }
    if (candidates.length === 0) return null;

    // Ordena por prioridade de eviction (menor score → evicta primeiro).
    candidates.sort((a, b) => {
      // 1. Horizonte: curto (score 0) < médio (score 1).
      const hA = a.horizon === 'curto' ? 0 : 1;
      const hB = b.horizon === 'curto' ? 0 : 1;
      if (hA !== hB) return hA - hB;

      // 2. Fechadas primeiro (score 0) vs abertas (score 1).
      const cA = a.closed ? 0 : 1;
      const cB = b.closed ? 0 : 1;
      if (cA !== cB) return cA - cB;

      // 3. Menos recente (recência) — menor lastAccessedAt = evicta primeiro.
      if (a.lastAccessedAt !== b.lastAccessedAt) return a.lastAccessedAt - b.lastAccessedAt;

      // 4. Menor frequência (accessCount) como desempate.
      return a.accessCount - b.accessCount;
    });

    const victim = candidates[0]!;
    return this.removeNode(victim);
  }

  /** Força remoção de uma caixa específica (respeita invariantes de eviction). */
  forceEvict(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    // Invariante DURA: nunca evictar caixa-longa ou pinada.
    if (node.horizon === 'longo' || node.pinned) return null;
    return this.removeNode(node);
  }

  /**
   * F86 — REMOÇÃO EXPLÍCITA (incondicional). Diferente de `forceEvict` (eviction por
   * HORIZONTE/pressão, que protege `longo`/pinada), isto é p/ quando a caixa
   * DEFINITIVAMENTE não pertence mais ao estado projetado (ex.: um passo sumiu do
   * plano em `syncPlanToGraph`). Sem isto, a projeção do plano acumula caixas órfãs
   * por toda a sessão (classe "acumulador sem teto", EST-1011 → O(n²) no listBoxes).
   */
  removeBox(id: BoxId): BoxSnapshot | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    return this.removeNode(node);
  }

  /** Remove um nó e limpa referências cruzadas. */
  private removeNode(node: BoxNode): BoxSnapshot {
    // Remove do pai.
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) parent.children.delete(node.id);
    }
    // Remove a dependência de quem depende deste nó (não limpa, mas
    // referências ficam órfãs — o grafo tolera IDs inexistentes).
    this.nodes.delete(node.id);
    return node.snapshot();
  }
}
