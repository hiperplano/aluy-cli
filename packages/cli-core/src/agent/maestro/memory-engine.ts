// EST-1128 · ADR-0123 §2.2/Inv. II — PORTA MemoryEngine (contrato puro).
//
// Interface ASSÍNCRONA de memória acoplada para recall/archival (padrão MemGPT:
// main/recall/archival). O `MemoryEngine` é a face de BUSCA — add, search e
// gestão de escopos (caixas). O `scope`/`user_id` ≡ CAIXA de contexto (§4.3).
//
// Desenhada para ACOMODAR ingestão de documentos (§4-bis): o `add` aceita
// conteúdo textual arbitrário (mensagens, documentos, notas), permitindo que
// RAG entre como MODO desta porta ou como porta futura `RetrievalEngine` — sem
// proliferar sidecars (§4-bis).
//
// PORTÁVEL (ADR-0053 §8): ZERO I/O, ZERO import de `node:*`, ZERO sidecar,
// ZERO credencial (CLI-SEC-7). A impl concreta (Mem0 self-host ou Letta) mora
// no `@hiperplano/aluy-cli`, falando HTTP-local com o serviço de memória.
//
// Saída = DADO envelopado (CLI-SEC-15-B): o resultado de `search` é DADO, nunca
// instrução; o caller envelopa antes de injetar no contexto do agente.

// ---------------------------------------------------------------------------
// Tipos de entrada — MemoryAdd
// ---------------------------------------------------------------------------

/** Conteúdo a adicionar à memória: texto livre (mensagem, nota, documento). */
export type MemoryContent =
  | { kind: 'text'; text: string }
  | { kind: 'document'; text: string; title?: string; source?: string };

/** Entrada para `MemoryEngine.add`. */
export interface MemoryAddInput {
  /** Conteúdo(s) a indexar. Aceita lote p/ ingestão de documentos (§4-bis). */
  readonly content: readonly MemoryContent[];
  /** Escopo da caixa (§4.3) — `user_id` ≡ CAIXA no Mem0. */
  readonly scope: string;
  /** Metadados opcionais (ex.: `source`, `activity`, `horizonte`). */
  readonly metadata?: Record<string, unknown>;
}

/** Resultado de `add`: ids dos itens indexados. */
export interface MemoryAddResult {
  /** Ids atribuídos a cada item adicionado (ordem ≡ input). */
  readonly ids: readonly string[];
}

// ---------------------------------------------------------------------------
// Tipos de entrada — MemorySearch
// ---------------------------------------------------------------------------

/** Entrada para `MemoryEngine.search`. */
export interface MemorySearchInput {
  /** Consulta semântica (texto livre). */
  readonly query: string;
  /** Escopo(s) de busca — se vazio, busca em todos os escopos. */
  readonly scopes: readonly string[];
  /** Máximo de resultados (default depende da impl). */
  readonly limit?: number;
  /** Threshold mínimo de relevância (0..1, depende da impl). */
  readonly threshold?: number;
}

/** Um item recuperado do índice. */
export interface MemorySearchHit {
  /** Id do item. */
  readonly id: string;
  /** Conteúdo recuperado (texto). */
  readonly text: string;
  /** Score de relevância (0..1). */
  readonly score: number;
  /** Metadados gravados no `add`. */
  readonly metadata?: Record<string, unknown>;
}

/** Resultado de `search`: DADO envelopado (CLI-SEC-15-B). */
export interface MemorySearchResult {
  /** Hits ordenados por relevância decrescente. */
  readonly hits: readonly MemorySearchHit[];
}

// ---------------------------------------------------------------------------
// Tipos de entrada — MemoryScope
// ---------------------------------------------------------------------------

/** Operação de gestão de escopo (caixa). */
export type MemoryScopeOp =
  | { kind: 'list' }
  | { kind: 'info'; scope: string }
  | { kind: 'delete'; scope: string };

/** Entrada para `MemoryEngine.scope`. */
export interface MemoryScopeInput {
  readonly operation: MemoryScopeOp;
}

/** Informação de um escopo (caixa). */
export interface MemoryScopeInfo {
  readonly scope: string;
  readonly itemCount: number;
  readonly createdAt?: number;
}

/** Resultado de `scope`. */
export interface MemoryScopeResult {
  readonly scopes?: readonly MemoryScopeInfo[];
  readonly deleted?: boolean;
}

// ---------------------------------------------------------------------------
// Porta MemoryEngine
// ---------------------------------------------------------------------------

/**
 * Porta ASSÍNCRONA de memória acoplada (recall/archival).
 *
 * Contrato puro em `@hiperplano/aluy-cli-core` — ZERO implementação concreta, ZERO I/O,
 * ZERO sidecar, ZERO credencial. A impl (Mem0 self-host default ou Letta
 * alternativa) mora no `@hiperplano/aluy-cli` e fala HTTP-local com o serviço de memória,
 * atrás desta MESMA porta (ADR-0123 §2.2/Inv. II).
 *
 * O `scope` ≡ CAIXA de contexto (§4.3): cada caixa do grafo é um escopo do
 * `MemoryEngine`. O índice vivo de caixas (§4.3) É o `search` semântico
 * escopado por caixa.
 *
 * Desenhada para ACOMODAR ingestão de documentos (§4-bis): `add` aceita
 * conteúdo textual arbitrário — mensagens, notas, documentos — permitindo
 * que RAG entre como MODO futuro desta porta, sem 4º sidecar.
 */
export interface MemoryEngine {
  /**
   * Adiciona conteúdo(s) à memória no escopo da caixa.
   *
   * Acomoda ingestão de documentos (§4-bis): aceita lotes de `MemoryContent`
   * (texto ou documento com título/origem) para indexação semântica.
   */
  add(input: MemoryAddInput): Promise<MemoryAddResult>;

  /**
   * Busca semântica no índice, escopada por caixa(s).
   *
   * O índice vivo de caixas (§4.3) É este `search`: recupera trechos
   * relevantes dentro do escopo da caixa, ordenados por relevância+salience.
   * Resultado = DADO envelopado (CLI-SEC-15-B) — nunca instrução.
   */
  search(input: MemorySearchInput): Promise<MemorySearchResult>;

  /**
   * Operações de gestão de escopos (caixas): listar, info, deletar.
   */
  scope(input: MemoryScopeInput): Promise<MemoryScopeResult>;
}
