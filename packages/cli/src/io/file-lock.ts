// EST-1011 / HUNT-ROOM (F71) — LOCK de arquivo CROSS-PROCESS (advisory) reusável.
//
// Stores que fazem READ-MODIFY-WRITE de um arquivo COMPARTILHADO entre CLIs (memória
// global `~/.aluy/memory/`, `~/.aluy/todos.json`) sofrem LOST-UPDATE sem serializar a
// sequência read→write entre PROCESSOS: A lê, B lê, A escreve, B escreve ⇒ o update de
// A some. O write atômico (tmp+rename) evita arquivo TORTO mas NÃO o lost-update.
//
// Este lock serializa: a aquisição é via `wx` (O_CREAT|O_EXCL) — ATÔMICA no OS, só UM
// processo cria o lockfile (os demais ⇒ EEXIST e re-tentam). A liberação remove o
// lockfile. Lock STALE (dono morto) é quebrado de forma ATÔMICA via `rename` (steal):
// só um processo renomeia um dado arquivo; o vencedor remove o RENOMEADO (nome próprio),
// NUNCA um lockfile vivo de um terceiro (o TOCTOU que a F70/#471 fechou no FileRoomStore).
//
// Mesma disciplina do `FileRoomStore` (post-#471), extraída p/ reuso. NÃO bloqueia o
// event-loop: a espera é `await setTimeout` (assíncrona), o miolo do caller pode ser sync.
// CLI-SEC-7: só transporte/sincronização — nenhum provider/credencial.

import * as fsPromises from 'node:fs/promises';

/** Idade (ms) a partir da qual um lock é considerado STALE (processo morto). */
const LOCK_STALE_MS = 30_000;
/** Intervalo de poll ao re-tentar adquirir, em ms. */
const LOCK_RETRY_MS = 50;
/** Teto de espera p/ adquirir, em ms (anti-deadlock). */
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

/** Token de posse do lock (pid + instante de criação). Identifica QUEM detém o lock. */
export type LockState = { pid: number; createdAt: number };

function isStale(state: LockState, now: number): boolean {
  // createdAt no FUTURO (relógio torto) também é tratado como stale (não pendura eterno).
  return now - state.createdAt > LOCK_STALE_MS || state.createdAt > now + LOCK_STALE_MS;
}

/**
 * Quebra um lock STALE/corrompido ATOMICAMENTE: renomeia p/ um nome ÚNICO antes de
 * remover. `rename` é atômico — só UM processo move um dado arquivo (os demais ⇒
 * ENOENT). O vencedor remove SÓ o renomeado (nome próprio), NUNCA o lockfile vivo de
 * outro. O `wx` segue a única catraca de aquisição; o steal só evita apagar lock alheio.
 */
async function stealStaleLock(lockPath: string, now: number): Promise<void> {
  const stolen = `${lockPath}.steal.${process.pid}.${now}`;
  try {
    await fsPromises.rename(lockPath, stolen);
  } catch {
    return; // outro já roubou/removeu — nada a fazer.
  }
  try {
    await fsPromises.unlink(stolen);
  } catch {
    /* já foi (best-effort) */
  }
}

/**
 * Adquire o lock (espera até o teto). Lança se estourar o timeout (anti-deadlock).
 * Devolve o TOKEN escrito (`{pid, createdAt}`) — o `release` exige esse token p/ só
 * apagar o lock SE ele ainda for NOSSO (F95: evita que um dono que estourou o lease
 * apague o lock de quem o roubou stale).
 */
export async function acquireFileLock(lockPath: string): Promise<LockState> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      throw new Error(`Timeout ao adquirir lock "${lockPath}" (${LOCK_ACQUIRE_TIMEOUT_MS}ms).`);
    }
    try {
      const token: LockState = { pid: process.pid, createdAt: now };
      await fsPromises.writeFile(lockPath, JSON.stringify(token), {
        flag: 'wx',
        mode: 0o600,
      });
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Lock existe — quebra se STALE (ou corrompido/ilegível), de forma atômica.
      try {
        const raw = await fsPromises.readFile(lockPath, 'utf-8');
        if (isStale(JSON.parse(raw) as LockState, now)) await stealStaleLock(lockPath, now);
      } catch {
        await stealStaleLock(lockPath, now); // corrompido — rouba do mesmo jeito.
      }
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

/**
 * Libera o lock (best-effort — já-removido é ok). F95: só apaga o lockfile SE ele
 * ainda for o NOSSO (`token` bate pid+createdAt). Sem o token (legado) apaga
 * incondicional. POR QUÊ: se a seção crítica estourou `LOCK_STALE_MS`, outro processo
 * pode ter ROUBADO o lock stale e adquirido o seu — um `unlink` cego apagaria o lock
 * VIVO desse novo dono ⇒ dois escritores. Lendo-e-checando antes, o dono que estourou
 * vê que o lock não é mais dele e NÃO o toca. (Resta uma janela read→unlink de µs — vs
 * a precondição de overrun de 30s+; fechar 100% exigiria flock do OS, fora de escopo.)
 */
export async function releaseFileLock(lockPath: string, token?: LockState): Promise<void> {
  if (token !== undefined) {
    try {
      const raw = await fsPromises.readFile(lockPath, 'utf-8');
      const cur = JSON.parse(raw) as LockState;
      if (cur.pid !== token.pid || cur.createdAt !== token.createdAt) {
        return; // não é mais o nosso lock (roubado stale) — não toca.
      }
    } catch {
      return; // sumiu / corrompido / ilegível — nada a liberar.
    }
  }
  try {
    await fsPromises.unlink(lockPath);
  } catch {
    /* já foi */
  }
}

/**
 * Executa `fn` SEGURANDO o lock de `lockPath` — serializa o read-modify-write entre
 * processos. `fn` roda APÓS adquirir (leia o arquivo DENTRO dela, nunca antes) e o
 * lock é liberado mesmo se `fn` lançar.
 */
export async function withFileLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  const token = await acquireFileLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseFileLock(lockPath, token); // F95: só libera se ainda for nosso.
  }
}
