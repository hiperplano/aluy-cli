// EST-1108 — barrel do BACKLOG/TODO persistente (PORTÁVEL).
//
// Tools add_todo/list_todos/done_todo (porta de I/O PRÓPRIA, confinada a `todos.json`),
// contrato TodoStorePort + tipos TodoItem. O I/O concreto (`~/.aluy/todos.json` 0600,
// fail-safe) é do @hiperplano/aluy-cli.

export {
  ADD_TODO_TOOL_NAME,
  DONE_TODO_TOOL_NAME,
  LIST_TODOS_TOOL_NAME,
  type TodoItem,
  type TodoStorePort,
} from './contract.js';
export { addTodoTool, doneTodoTool, listTodosTool } from './todo-tools.js';
