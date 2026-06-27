// EST-1012 — ROBUSTEZ DE MEMÓRIA · HEAP-LIMIT EXPLÍCITO no launcher.
//
// O problema: sem um `--max-old-space-size` explícito, o V8 deixa o heap crescer até
// o teto default do Node (que, em máquina contendida, o kernel ULTRAPASSA matando o
// processo cego — "Killed", sem stack, sem aviso, sem chance de salvar a sessão).
// Setando um teto SANO de heap, o V8 lança um ERRO de heap LEGÍVEL/capturável
// ("JavaScript heap out of memory") ANTES do OOM do kernel — vira falha diagnosticável
// (e o monitor de pressão, #157-vizinho, age MUITO antes disso, encerrando limpo).
//
// COMO: re-exec do MESMO binário com `NODE_OPTIONS` contendo o `--max-old-space-size`,
// UMA vez (idempotente — uma flag sentinela no env evita loop de re-exec). Se o
// operador JÁ passou um `--max-old-space-size` (em NODE_OPTIONS), RESPEITAMOS — não
// sobrescrevemos a escolha dele; só anexamos quando falta.
//
// Esta é a parte PURA/testável (computa o NODE_OPTIONS alvo + decide se re-exec);
// o spawn concreto vive em `applyHeapLimit` (I/O), chamado no topo do entrypoint.

import { resolveHeapLimitMb } from '@hiperplano/aluy-cli-core';

/** Sentinela no env: marca que JÁ re-exec-amos (evita loop infinito de re-spawn). */
export const HEAP_LIMIT_APPLIED_ENV = 'ALUY_HEAP_LIMIT_APPLIED';
/** A flag do V8 que cravamos no NODE_OPTIONS (teto do heap "old space"). */
export const MAX_OLD_SPACE_FLAG = '--max-old-space-size';

/**
 * Extrai o `--max-old-space-size=<N>` (MB) JÁ presente numa string de NODE_OPTIONS,
 * se houver (a forma `--max-old-space-size N` separada por espaço NÃO é aceita pelo
 * Node em NODE_OPTIONS, então só a forma `=N` importa). Devolve `undefined` se ausente
 * ou inválido. PURO.
 */
export function existingMaxOldSpaceMb(nodeOptions: string | undefined): number | undefined {
  if (nodeOptions === undefined || nodeOptions.trim() === '') return undefined;
  const m = /--max-old-space-size=(\d+)/.exec(nodeOptions);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** O plano de aplicação do heap-limit, decidido SEM efeito (testável). */
export interface HeapLimitPlan {
  /**
   * `true` ⇒ é preciso re-exec o processo com o `nodeOptions` abaixo (faltava o teto).
   * `false` ⇒ nada a fazer (já aplicado por nós, ou o operador já cravou o teto, ou
   * estamos no processo RE-EXECUTADO).
   */
  readonly shouldReexec: boolean;
  /** O valor COMPLETO de NODE_OPTIONS a usar no re-exec (preserva o que já havia). */
  readonly nodeOptions: string;
  /** O teto de heap efetivo (MB) — p/ diagnóstico/log e p/ o monitor de pressão. */
  readonly heapLimitMb: number;
}

/**
 * Decide o plano do heap-limit a partir do ENV, PURO/determinístico:
 *  1) se a sentinela `ALUY_HEAP_LIMIT_APPLIED` está setada ⇒ estamos no processo
 *     RE-EXECUTADO (ou o operador a setou de propósito) ⇒ NÃO re-exec (`shouldReexec:false`);
 *  2) se NODE_OPTIONS JÁ tem `--max-old-space-size=N` ⇒ RESPEITA (não re-exec; usa o N dele);
 *  3) senão ⇒ resolve o teto (env `ALUY_MAX_HEAP_MB` > default) e PLANEJA o re-exec com
 *     o NODE_OPTIONS existente + `--max-old-space-size=<teto>` anexado.
 *
 * NÃO faz spawn nem lê argv — só monta o plano. `applyHeapLimit` o executa.
 */
export function planHeapLimit(
  env: Record<string, string | undefined>,
  totalMemMb?: number,
): HeapLimitPlan {
  const existingOpts = env.NODE_OPTIONS ?? '';
  const alreadyApplied = (env[HEAP_LIMIT_APPLIED_ENV] ?? '').trim() !== '';
  const operatorMb = existingMaxOldSpaceMb(existingOpts);

  // Caso (1)/(2): nada a fazer — usa o teto do operador (se houver) ou o resolvido,
  // mas sem re-exec (já estamos rodando com — ou sem, por escolha — o teto).
  if (alreadyApplied || operatorMb !== undefined) {
    return {
      shouldReexec: false,
      nodeOptions: existingOpts,
      heapLimitMb: resolveHeapLimitMb(env, operatorMb, totalMemMb),
    };
  }

  // Caso (3): falta o teto e ainda não re-exec-amos ⇒ planeja o re-exec. O teto escala
  // com a RAM da máquina (totalMemMb) — não capa em 4 GiB num host grande.
  const heapLimitMb = resolveHeapLimitMb(env, undefined, totalMemMb);
  const flag = `${MAX_OLD_SPACE_FLAG}=${heapLimitMb}`;
  const nodeOptions = existingOpts.trim() === '' ? flag : `${existingOpts} ${flag}`;
  return { shouldReexec: true, nodeOptions, heapLimitMb };
}

/** Portas injetáveis (testável sem spawnar de verdade). */
export interface HeapLimitPorts {
  readonly env: Record<string, string | undefined>;
  /** Caminho do executável Node (`process.execPath`). */
  readonly execPath: string;
  /** Argumentos do processo CORRENTE (`process.argv` inteiro, [node, script, ...args]). */
  readonly argv: readonly string[];
  /**
   * Opções de NODE passadas ANTES do script (`process.execArgv` — ex.: `--require x`,
   * `--enable-source-maps`). Preservadas no re-exec p/ não perder o ambiente do
   * operador/harness. Ausente ⇒ nenhuma. Precedem o script no comando re-executado.
   */
  readonly execArgv?: readonly string[];
  /**
   * Re-executa o processo com o env mutado. Em produção é um `spawn` ASSÍNCRONO herdando
   * stdio + repasse de sinais, que RESOLVE com o exit-code do filho (ou `undefined` se o
   * spawn falhou — o caller então SEGUE sem o teto, gracioso). `applyHeapLimit` o aguarda
   * e ENCERRA este processo com o código devolvido (o filho assumiu a sessão).
   */
  reexec(
    execPath: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
  ): Promise<number | undefined> | number | undefined;
  /**
   * ENCERRA este processo com o código do filho (em produção `(c) => process.exit(c)`).
   * Chamado por `applyHeapLimit` SÓ quando o re-exec rodou (o filho assumiu e já saiu) —
   * o pai não deve seguir p/ montar a sessão. Injetável p/ teste (captura o código, não sai).
   */
  exit?(code: number): void;
  /**
   * RAM TOTAL da máquina em MB (`os.totalmem()/1MiB`) — p/ o heap-limit ADAPTATIVO
   * (fração da RAM, não 4 GiB fixo). Injetável p/ teste. Ausente ⇒ o resolver cai no
   * default fixo (sem regressão em ambiente que não passa a RAM).
   */
  readonly totalMemMb?: number;
}

/**
 * Aplica o heap-limit no topo do entrypoint: se o plano pede re-exec, re-spawna o
 * MESMO comando com `NODE_OPTIONS` + a sentinela, AGUARDA o filho terminar e ENCERRA
 * este processo com o código dele (`ports.exit`), sinalizando `reexeced:true` (o caller
 * NÃO deve seguir p/ montar a sessão). Senão (já aplicado / teto do operador / spawn
 * falhou), devolve `false` e o `main()` segue NESTE processo. FAIL-OPEN: qualquer erro
 * de spawn NÃO derruba o boot — seguimos sem o teto explícito (degrada gracioso, o
 * monitor de pressão ainda age). Async (o re-exec aguarda o ciclo de vida do filho).
 */
export async function applyHeapLimit(ports: HeapLimitPorts): Promise<{
  reexeced: boolean;
  heapLimitMb: number;
}> {
  const plan = planHeapLimit(ports.env, ports.totalMemMb);
  if (!plan.shouldReexec) return { reexeced: false, heapLimitMb: plan.heapLimitMb };

  const childEnv: Record<string, string | undefined> = {
    ...ports.env,
    NODE_OPTIONS: plan.nodeOptions,
    [HEAP_LIMIT_APPLIED_ENV]: '1',
  };
  // argv = [execPath, script, ...userArgs] ⇒ re-exec com [...execArgv, script, ...userArgs].
  // Os `execArgv` (opções de NODE: --require/--enable-source-maps/…) PRECEDEM o script,
  // preservando o ambiente do operador/harness que se perderia num re-exec ingênuo.
  const args = [...(ports.execArgv ?? []), ...ports.argv.slice(1)];
  try {
    const code = await ports.reexec(ports.execPath, args, childEnv);
    if (code === undefined) {
      // Spawn falhou (ex.: ambiente sem fork): NÃO re-exec — segue sem teto explícito.
      return { reexeced: false, heapLimitMb: plan.heapLimitMb };
    }
    // O filho assumiu e já encerrou — propaga o código e SINALIZA p/ o pai parar aqui.
    ports.exit?.(code);
    return { reexeced: true, heapLimitMb: plan.heapLimitMb };
  } catch {
    // FAIL-OPEN: re-exec quebrou ⇒ segue neste processo, sem o teto (gracioso).
    return { reexeced: false, heapLimitMb: plan.heapLimitMb };
  }
}
