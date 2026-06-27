// EST-0983 · ADR-0064 · CLI-SEC-15 — CONTRATO da memória de agente (tipos + porta
// de I/O ESTREITA). Módulo deliberadamente LEVE (só tipos/constantes, sem lógica
// nem `node:*`) p/ poder ser importado tanto pela mecânica de memória quanto pela
// engine de permissão (`REMEMBER_TOOL_NAME`) SEM ciclo de import.
//
// O ponto CENTRAL de segurança (GS-M1 — porta estreita): a porta de escrita NÃO é
// um `write(path, bytes)` apontado p/ `memory/`. Ela é `append(fact, scope)` — a
// MECÂNICA decide o arquivo. O modelo NUNCA fornece um path: a tool `remember` (que
// fala com esta porta) recebe só `{ fact, scope }`. Por construção, nenhuma chamada
// de memória pode mirar `~/.aluy/mcp.json`, `~/.aluy/commands/`, `~/.aluy/undo/` nem
// qualquer path fora de `memory/` — esses paths não existem na superfície da porta.

/**
 * Nome da tool dedicada de escrita de memória. Estável (a engine de permissão e o
 * loop referenciam ESTE nome p/ a categoria `memory-write`/teto). Vive aqui p/ a
 * engine importá-lo sem puxar a mecânica de memória inteira (evita ciclo).
 */
export const REMEMBER_TOOL_NAME = 'remember';

/**
 * EST-0983 (extensão · recall sob demanda) — nome da tool dedicada de LEITURA da
 * memória (`recall`). Estável (a engine de permissão e a allow-list de Plan referenciam
 * ESTE nome p/ tratá-la como LEITURA LOCAL pura). Vive aqui, junto do `remember`, p/ a
 * engine/Plan importá-lo sem puxar a mecânica de memória inteira (evita ciclo).
 *
 * É a CONTRAPARTE de leitura do `remember`: o `remember` ESCREVE um fato (porta estreita
 * confinada a `memory/`); o `recall` LÊ os fatos JÁ gravados (porta estreita de leitura,
 * sem path, só da própria memória). Não amplia escopo: não lê arquivo, não faz rede, não
 * executa — só consulta a memória da própria conta/máquina e a devolve como DADO.
 */
export const RECALL_TOOL_NAME = 'recall';

/** Escopo de um fato: GLOBAL (sobre o usuário) ou PROJETO (sobre o repo). */
export type MemoryScope = 'global' | 'projeto';

/**
 * PROVENIÊNCIA de um fato (GS-M5) — de ONDE ele veio. NUNCA promove a memória a
 * `system` (a invariante B é absoluta), mas distingue confiança p/ a UI/`/memory`
 * e p/ o gate `seguranca`:
 *   - `usuario`: o usuário disse, na própria mensagem (mais confiável);
 *   - `derivado`: o agente inferiu de conteúdo da sessão (possivelmente NÃO-confiável
 *      — web/README/saída de tool). É o vetor de LAUNDERING; entra como dado igual.
 */
export type MemoryProvenance = 'usuario' | 'derivado';

/** Um fato de memória já persistido. */
export interface MemoryFact {
  /** id estável (curto, determinístico por conteúdo+ts) p/ o `/memory` referenciar. */
  readonly id: string;
  /** O texto do fato (curto/factual). É DADO — nunca instrução (B). */
  readonly text: string;
  readonly scope: MemoryScope;
  readonly provenance: MemoryProvenance;
  /**
   * FIXADO (pin, GS-M6) — retenção/curadoria: não é podado pela limpeza/teto e tem
   * precedência de retenção. FIXAR NÃO promove a `system`: o fato fixado CONTINUA
   * entrando no recall como DADO (B é absoluta e independe de fixação).
   */
  readonly pinned: boolean;
  /** Epoch ms da gravação (p/ ordenação/poda determinística). */
  readonly ts: number;
}

/** Entrada de escrita: o que a tool/`/memory` fornece. NUNCA um path. */
export interface MemoryWriteInput {
  readonly text: string;
  readonly scope: MemoryScope;
  readonly provenance: MemoryProvenance;
}

/**
 * PORTA de I/O ESTREITA da memória (GS-M1) — o ÚNICO canal de escrita/leitura da
 * memória. O locus concreto (@aluy/cli) a liga a `~/.aluy/memory/` (global, atômico
 * 0600/0700) e `.aluy/memory/` (projeto, no workspace). A superfície NÃO tem
 * `write(path, …)`: só operações de memória por ESCOPO. Por isso `edit_file`/
 * `run_command` (que recebem path) seguem DENY em `~/.aluy/`, sem carve-out.
 */
export interface MemoryStorePort {
  /** Lê TODOS os fatos persistidos (global + projeto). Uso da mecânica interna. */
  readAll(): Promise<readonly MemoryFact[]>;
  /** Acrescenta um fato no ESCOPO indicado. A mecânica decide o arquivo (não o modelo). */
  append(fact: MemoryFact): Promise<void>;
  /** Remove um fato por id (poda manual / `/memory esquecer`). Idempotente. */
  remove(id: string): Promise<void>;
  /** Substitui o texto/pin de um fato existente (mesmo id/escopo). */
  update(fact: MemoryFact): Promise<void>;
  /**
   * EST-0983 (`/clear full` / `/clear memory`) — APAGA TODOS os fatos de um escopo
   * (ou de AMBOS quando `scope` é omitido). É AÇÃO DO USUÁRIO (via slash), IRREVERSÍVEL
   * — NUNCA exposta como tool ao agente (a path-deny de `~/.aluy/memory/` segue valendo;
   * a porta estreita GS-M1 não cresce p/ o modelo). Confinado a `memory/` como o resto
   * da porta (não recebe path: o escopo decide o arquivo). Idempotente: escopo já vazio
   * ⇒ no-op silencioso. ATÔMICO por escopo (reescreve o `.md` vazio, sem janela 0644).
   */
  clearAll(scope?: MemoryScope): Promise<void>;
}
