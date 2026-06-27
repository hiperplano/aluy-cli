// EST-1108 — CONTRATO do backlog/TODO persistente (tipos + porta de I/O ESTREITA).
// Espelha o contrato da memória (EST-0983 · ADR-0064 · CLI-SEC-15) mas com estrutura
// mais simples: um item de TODO é um texto + flag `done`, sem escopo/proveniência/pin.
//
// A porta é ESTREITA (espelha GS-M1): a tool `add_todo` recebe `{ item }` — NUNCA um
// path. A MECÂNICA decide o arquivo. Por construção, nenhuma chamada de TODO pode mirar
// `~/.aluy/mcp.json`, `commands/`, `undo/` nem qualquer path fora de `todos.json`.

/** Nome da tool dedicada de adição de TODO. Estável. */
export const ADD_TODO_TOOL_NAME = 'add_todo';

/** Nome da tool dedicada de listagem de TODOs. Estável. */
export const LIST_TODOS_TOOL_NAME = 'list_todos';

/** Nome da tool dedicada de conclusão de TODO. Estável. */
export const DONE_TODO_TOOL_NAME = 'done_todo';

/** Um item de TODO já persistido. */
export interface TodoItem {
  /** id estável (curto, determinístico) p/ o /todo referenciar. */
  readonly id: string;
  /** O texto do item (curto/factual). */
  readonly text: string;
  /** Epoch ms da criação. */
  readonly createdAt: number;
  /** Concluído? */
  readonly done: boolean;
}

/**
 * PORTA de I/O ESTREITA do backlog/TODO — o ÚNICO canal de escrita/leitura.
 * O locus concreto (@aluy/cli) a liga a `~/.aluy/todos.json` (0600, fail-safe).
 * A superfície NÃO tem `write(path, …)`: só operações de TODO.
 */
export interface TodoStorePort {
  /** Acrescenta um item pendente. Devolve o id do novo item. */
  add(text: string): Promise<string>;
  /** Lista TODOS os itens (pendentes + feitos, ordenados por createdAt). */
  list(): Promise<readonly TodoItem[]>;
  /** Marca um item como feito por id. `false` se não encontrado. */
  done(id: string): Promise<boolean>;
  /** Limpa os itens já concluídos (opcional, p/ o /todo clear). */
  clearDone(): Promise<number>;
}
