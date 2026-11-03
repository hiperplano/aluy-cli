// Roda o checker determinístico de UMA tarefa (dentro do bwrap, ver run.mjs).
// uso: node check.mjs <taskId> <taskdir>   -> imprime JSON { ok, detail }
import { TASKS } from './tasks.mjs';

const [id, dir] = process.argv.slice(2);
const task = TASKS.find((t) => t.id === id);
if (!task) {
  console.log(JSON.stringify({ ok: false, detail: 'tarefa desconhecida' }));
  process.exit(2);
}
try {
  console.log(JSON.stringify(task.check(dir)));
} catch (e) {
  console.log(
    JSON.stringify({ ok: false, detail: 'checker lançou: ' + String(e.message).slice(0, 150) }),
  );
}
