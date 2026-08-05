// ADR-0158 §5 — HARNESS compartilhado pelos testes de integração `runner-workflow-*`/
// `runner-ask-espera-*`/`runner-activity-deadline-*`/`runner-revalidate-*` (NÃO é um
// arquivo `.test.ts` — não roda como suíte, só é IMPORTADO por elas): monta um
// `service.md`/`workflows/<nome>.md` reais em tmpdir e resolve o problema de
// `schedule:` cron ter granularidade de MINUTO (esperar um minuto de verdade por
// teste seria lento e arriscaria o `testTimeout` de 45s da suíte).
//
// A SAÍDA: ancora o relógio (via `vi.useFakeTimers({ shouldAdvanceTime: true })`) bem
// perto da virada do minuto (segundo 59,5) ANTES de chamar `runServiceRunner` — o
// cron mais próximo (`nextCronFire`) então dispara em ~0,5s de tempo REAL decorrido
// (o `shouldAdvanceTime` mantém o relógio fake avançando em paralelo ao relógio real,
// então o `setTimeout` do `sleepUntil` ainda dispara sozinho, sem precisar de
// `vi.advanceTimersByTimeAsync` manual). Processos-FILHO reais (o `fake-turn.mjs`)
// não são afetados — I/O de processo usa o loop de eventos real do libuv, não os
// timers do JS que o vitest substitui. Validado num spike antes de generalizar aqui.
//
// ARMADILHA achada depurando `runner-activity-deadline-cancel.test.ts` (documentada
// aqui p/ nunca reintroduzir): `disarmFakeClock` (⇒ `vi.useRealTimers()`) NÃO pode
// ser chamado NO MEIO do teste, mesmo "depois de ver o log 'acordou'" — o runner
// arma o `setTimeout` do `activity-timeout` (deadline) NA MESMA rajada síncrona que
// emite esse log (spawn do filho logo em seguida), ou seja, ainda em cima do
// timer FAKE. Trocar p/ timers REAIS um instante depois ÓRFÃ esse timer (a
// implementação fake é DESLIGADA; o timer nunca dispara) — o filho então nunca é
// morto e o teste trava esperando um log que nunca chega. Como `shouldAdvanceTime`
// já faz o relógio fake se comportar como tempo real para QUALQUER timer (incluindo
// o do `activity-timeout`), a disciplina correta é: NUNCA desarmar no meio do
// teste — deixar os timers fake (com `shouldAdvanceTime`) ativos do início ao fim,
// e chamar `disarmFakeClock()` só como LIMPEZA final (`afterEach`), depois que o
// `runServiceRunner` já retornou.
import { vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES_DIRNAME } from '../../../src/io/services-store.js';

/** Caminho do fixture `fake-turn.mjs` (o "aluy -p" FALSO) — ver o comentário lá. */
export const FAKE_TURN_ENTRYPOINT = fileURLToPath(new URL('./fake-turn.mjs', import.meta.url));

export interface HarnessManifest {
  readonly name?: string;
  readonly schedule?: string;
  readonly workflow?: string;
  readonly channel?: string;
  readonly budget?: string;
  /** `model:` — descoberta entre serviços (fixa o modelo do turno; ver runner.ts). */
  readonly model?: string;
  readonly activityTimeout?: string;
  /** `until: "HH:MM"` (fim de expediente, ADR-0158 §3) — cru, sem aspas no valor. */
  readonly until?: string;
  readonly orchestratorBody?: string;
}

/** Monta `<base>/services/<name>/service.md` (frontmatter + corpo do orquestrador). */
export function writeServiceManifest(base: string, m: HarnessManifest = {}): string {
  const name = m.name ?? 'trader';
  const dir = join(base, SERVICES_DIRNAME, name);
  mkdirSync(dir, { recursive: true });
  const fm = ['---', `name: ${name}`, `schedule: "${m.schedule ?? '* * * * *'}"`];
  if (m.workflow !== undefined) fm.push(`workflow: ${m.workflow}`);
  if (m.channel !== undefined) fm.push(`channel: "${m.channel}"`);
  if (m.budget !== undefined) fm.push(`budget: ${m.budget}`);
  if (m.model !== undefined) fm.push(`model: ${m.model}`);
  if (m.activityTimeout !== undefined) fm.push(`activity-timeout: ${m.activityTimeout}`);
  if (m.until !== undefined) fm.push(`until: "${m.until}"`);
  fm.push('---', m.orchestratorBody ?? 'Rege, não opera.');
  writeFileSync(join(dir, 'service.md'), fm.join('\n'));
  return dir;
}

/** Monta `<serviceDir>/workflows/<nome>.md` a partir de linhas de atividade JÁ no
 * formato do parser (`N. <id> [<agente>] — <objetivo>`, numeração automática). */
export function writeWorkflow(
  serviceDir: string,
  workflowName: string,
  activities: readonly { readonly id: string; readonly goal: string; readonly agent?: string }[],
): void {
  const dir = join(serviceDir, 'workflows');
  mkdirSync(dir, { recursive: true });
  const lines = activities.map((a, i) => {
    const agentPart = a.agent !== undefined ? `[${a.agent}] ` : '';
    return `${i + 1}. ${a.id} ${agentPart}— ${a.goal}`;
  });
  writeFileSync(join(dir, `${workflowName}.md`), ['---', `name: ${workflowName}`, '---', ...lines].join('\n'));
}

/** tmpdir novo, sob o prefixo padrão dos testes deste módulo — o CALLER remove
 * (`rmSync(base, {recursive:true, force:true})`) no `afterEach`. */
export function newBase(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeBase(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

/** Ancora o relógio FAKE bem perto da virada do minuto (ver comentário do topo) —
 * chamar ANTES de `runServiceRunner`. NÃO desarmar no meio do teste (ver a
 * ARMADILHA documentada acima) — `disarmFakeClock` é só LIMPEZA final, chamar
 * num `afterEach` depois que `runServiceRunner` já retornou. */
export function armCronNearMinuteBoundary(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const now = new Date();
  now.setSeconds(59, 500);
  vi.setSystemTime(now);
}

/** LIMPEZA final (`afterEach`) — devolve o processo a timers REAIS. Seguro chamar
 * mesmo se os timers já eram reais (idempotente). NUNCA chamar no MEIO de um
 * teste ainda em andamento (ver a ARMADILHA documentada no topo do arquivo). */
export function disarmFakeClock(): void {
  vi.useRealTimers();
}

/** Poll de log/condição — funciona tanto com timers FAKE (`shouldAdvanceTime`,
 * que já se comporta como tempo real) quanto REAIS. */
export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor: timeout (${timeoutMs}ms) esperando a condição.`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
