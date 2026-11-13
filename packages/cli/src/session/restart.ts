// `/restart` — recarrega o aluy SEM perder a conversa: salva a sessão, desmonta a TUI e
// sobe um processo NOVO que retoma a mesma sessão via `--resume <id>` (EST-0972). Serve
// p/ pegar uma versão recém-instalada (`npm i -g @hiperplano/aluy-cli@X`) sem sair.
//
// O Node não tem `execve`, então o processo atual vira só um "pai" que repassa o exit
// code e os sinais do filho (e NÃO lê o stdin — o filho é o dono do terminal).
//
// Este módulo é PURO/injetável: a reescrita do argv, o portão de confirmação, o plano de
// spawn e o repasse de sinais recebem suas portas (spawn, process, fs) — testável sem
// spawnar nada de verdade.

import { VALUE_TAKING_FLAGS } from '../cli.js';

/** Env que carrega a versão ANTERIOR p/ o filho avisar "reiniciado". Limpa no filho. */
export const RESTARTED_FROM_ENV = 'ALUY_RESTARTED_FROM';

/** Flags de valor que o parser aceita mas a lista de typo não cobre (repetíveis). */
const EXTRA_VALUE_FLAGS: readonly string[] = ['--image'];

/** Flags que ENTRAM em conflito com `--resume <id>` e somem do argv reiniciado. */
const DROP_BARE = new Set(['--continue', '--new']);
/** Flags de modo de UI: removidas e re-emitidas conforme o estado VIVO da sessão. */
const UI_CLASSIC = '--classic';
const UI_FULLSCREEN = new Set(['--fullscreen', '--cockpit']);
const UI_SPLIT = new Set(['--split', '--view']);
/** Headless/one-shot: não fazem sentido numa sessão interativa reiniciada. */
const PRINT_FLAGS = ['-p', '--print', '--exec'];

export interface RestartArgvInput {
  /** `process.argv.slice(2)` — os argumentos do usuário (sem node nem script). */
  readonly args: readonly string[];
  /** id da sessão a retomar; `undefined` ⇒ nada salvo ainda ⇒ recomeça limpo (`--new`). */
  readonly sessionId?: string;
  /** Estado VIVO da UI (pode ter mudado por /conversation, /fullscreen, /split). */
  readonly ui: { readonly classic: boolean; readonly fullscreen: boolean; readonly split: boolean };
}

/**
 * Reescreve o argv p/ o processo reiniciado: tira retomada/`--new`/`-p`/objetivo
 * posicional (já foi executado — não pode ser reenviado) e as flags de modo de UI, depois
 * acrescenta `--resume <id>` e o modo de UI VIVO. Mantém o resto (`--yolo`, `--lang`,
 * `--model`, `--max-tokens`, …) intacto, na ordem.
 */
export function rewriteRestartArgv(input: RestartArgvInput): string[] {
  const valueFlags = new Set<string>([...VALUE_TAKING_FLAGS, ...EXTRA_VALUE_FLAGS]);
  const out: string[] = [];
  const a = input.args;
  for (let i = 0; i < a.length; i++) {
    const tok = a[i] as string;
    if (tok === '--') break; // o resto é objetivo literal
    if (!tok.startsWith('-')) continue; // posicional (objetivo): já executado ⇒ descarta
    const eq = tok.indexOf('=');
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    // retomada (valor opcional: só é valor se o próximo não for flag)
    if (name === '--resume') {
      if (eq < 0 && a[i + 1] !== undefined && !(a[i + 1] as string).startsWith('-')) i++;
      continue;
    }
    if (DROP_BARE.has(name) || name === UI_CLASSIC) continue;
    if (UI_FULLSCREEN.has(name) || UI_SPLIT.has(name)) continue;
    if (PRINT_FLAGS.includes(name)) {
      if (eq < 0 && a[i + 1] !== undefined) i++; // o prompt
      continue;
    }
    out.push(tok);
    // flag de valor SEPARADO: o próximo token é o valor (pode até começar com `-`).
    if (eq < 0 && valueFlags.has(tok) && a[i + 1] !== undefined) {
      out.push(a[i + 1] as string);
      i++;
    }
  }
  if (input.ui.classic) out.push(UI_CLASSIC);
  if (input.ui.fullscreen) out.push('--fullscreen');
  if (input.ui.split) out.push('--split');
  if (input.sessionId !== undefined) out.push('--resume', input.sessionId);
  else out.push('--new');
  return out;
}

// ── portão de confirmação ────────────────────────────────────────────────────────────

export type RestartGate =
  | { readonly kind: 'refuse'; readonly lines: readonly string[] }
  | { readonly kind: 'confirm'; readonly lines: readonly string[] }
  | { readonly kind: 'proceed' };

export interface RestartGateInput {
  readonly anonymous: boolean;
  /** Quantas coisas rodando seriam interrompidas (tarefas do concierge, turno, tools). */
  readonly running: number;
  /** `true` quando esta é a 2ª invocação consecutiva de `/restart` (confirmação). */
  readonly confirmed: boolean;
}

/**
 * Decide se o `/restart` segue. Anônimo ⇒ RECUSA (não há sessão salva p/ retomar: reiniciar
 * perderia a conversa — o oposto do propósito do comando). Com trabalho em andamento ⇒ pede
 * confirmação (repetir `/restart`); sem ele, ou já confirmado ⇒ segue.
 */
export function decideRestart(input: RestartGateInput): RestartGate {
  if (input.anonymous) {
    return {
      kind: 'refuse',
      lines: [
        'sessão anônima não é gravada — não há o que retomar, então o /restart perderia a conversa.',
        'saia e abra o aluy de novo (/quit) para usar a versão nova.',
      ],
    };
  }
  if (input.running > 0 && !input.confirmed) {
    return {
      kind: 'confirm',
      lines: [
        `há ${input.running} ${input.running === 1 ? 'tarefa em andamento' : 'tarefas em andamento'} — reiniciar vai interrompê-${input.running === 1 ? 'la' : 'las'}.`,
        'repita /restart para confirmar, ou espere terminar.',
      ],
    };
  }
  return { kind: 'proceed' };
}

// ── plano e execução ─────────────────────────────────────────────────────────────────

export interface RestartPlan {
  readonly execPath: string;
  /** Opções do Node ANTES do script (`--require`, `--enable-source-maps`, …). */
  readonly nodeArgs: readonly string[];
  readonly script: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
}

export interface PlanInput {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  /** `process.argv[1]` — mantido como foi invocado (symlink do bin do npm), ver abaixo. */
  readonly script: string | undefined;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly currentVersion: string;
  /** O arquivo do script existe agora? (injetável; checado ANTES de desmontar a TUI) */
  readonly exists: (path: string) => boolean;
}

/**
 * Monta o plano de spawn. O script NÃO passa por `realpath`: `npm i -g` reescreve o pacote
 * no lugar e o `bin/aluy` é um symlink — o caminho original é re-resolvido pelo SO no
 * spawn e pega o código novo; fixar o realpath do boot prenderia a versão antiga em
 * instalações versionadas por diretório (pnpm/nvm). Falta o script ⇒ `undefined` (o
 * caller avisa SEM desmontar a TUI).
 */
export function planRestart(input: PlanInput): RestartPlan | undefined {
  if (input.script === undefined || input.script === '' || !input.exists(input.script)) {
    return undefined;
  }
  return {
    execPath: input.execPath,
    nodeArgs: input.execArgv,
    script: input.script,
    args: [],
    env: { ...input.env, [RESTARTED_FROM_ENV]: input.currentVersion },
    cwd: input.cwd,
  };
}

/** O mínimo do stdin que o pai precisa soltar antes de o filho assumir o console. */
export interface ReleasableStdin {
  removeAllListeners(event?: string): unknown;
  setRawMode?: (mode: boolean) => unknown;
  pause?: () => unknown;
  destroy?: () => unknown;
}

/**
 * Solta POR COMPLETO o console de entrada antes de spawnar o filho do `/restart`.
 *
 * No Windows o modo do console é COMPARTILHADO por todos os processos nele, e o handle TTY
 * do libuv do pai fica aberto (com leitura pendente) mesmo depois de `setRawMode(false)` +
 * `pause()` — o pai disputava as teclas com o filho / re-aplicava o modo "cozido" (eco) e o
 * teclado do filho morria (`sssss` ecoado). Ordem: tira os listeners (nada mais lê), raw
 * off, pausa (readStop) e `destroy()` (fecha o handle, cancelando a leitura pendente).
 * Cada passo é best-effort e independente. Só o caminho do `/restart` chama isto.
 */
export function releaseStdinForChild(stdin: ReleasableStdin): void {
  const step = (fn: () => unknown): void => {
    try {
      fn();
    } catch {
      /* best-effort: um passo que falha não impede os seguintes */
    }
  };
  step(() => {
    for (const ev of ['data', 'keypress', 'readable']) stdin.removeAllListeners(ev);
  });
  step(() => stdin.setRawMode?.(false));
  step(() => stdin.pause?.());
  step(() => stdin.destroy?.());
}

/** Portas de processo p/ o pai que espera o filho. */
export interface ChildLike {
  on(event: 'error', fn: (e: Error) => void): unknown;
  on(event: 'close', fn: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface RestartPorts {
  spawn(
    cmd: string,
    args: readonly string[],
    opts: { stdio: 'inherit'; env: Record<string, string | undefined>; cwd: string },
  ): ChildLike;
  onSignal(sig: string, fn: () => void): void;
  offSignal(sig: string, fn: () => void): void;
  /** stdin é TTY? Num TTY o Ctrl-C já chega ao filho pelo terminal (não reenviar). */
  readonly stdinIsTty: boolean;
  /** número do sinal (p/ 128+n). */
  signalNumber(sig: string): number | undefined;
  /** Roda IMEDIATAMENTE antes do spawn (ex.: `releaseStdinForChild`). Best-effort. */
  beforeSpawn?: () => void;
}

/**
 * Sobe o filho e espera. Resolve com o exit code a propagar (sinal ⇒ 128+n); `undefined`
 * se o spawn falhou (o caller avisa). O pai só repassa sinais — NÃO toca no stdin.
 * SIGTERM/SIGHUP sempre repassados; SIGINT só sem TTY (num TTY o terminal já entrega o
 * ^C ao grupo de processos, e repassar duplicaria o "duplo Ctrl-C" que sai na hora).
 */
export function runRestart(plan: RestartPlan, ports: RestartPorts): Promise<number | undefined> {
  return new Promise((resolve) => {
    let child: ChildLike;
    try {
      ports.beforeSpawn?.();
    } catch {
      /* soltar o stdin é best-effort: nunca impede o relançamento */
    }
    try {
      child = ports.spawn(plan.execPath, [...plan.nodeArgs, plan.script, ...plan.args], {
        stdio: 'inherit',
        env: plan.env,
        cwd: plan.cwd,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const handlers: Array<[string, () => void]> = [];
    const forward = (sig: string): void => {
      const fn = (): void => {
        try {
          child.kill(sig as NodeJS.Signals);
        } catch {
          /* o filho já saiu */
        }
      };
      ports.onSignal(sig, fn);
      handlers.push([sig, fn]);
    };
    forward('SIGTERM');
    forward('SIGHUP');
    if (ports.stdinIsTty) {
      // pai não pode morrer com ^C enquanto o filho vive: engole.
      const noop = (): void => {};
      ports.onSignal('SIGINT', noop);
      handlers.push(['SIGINT', noop]);
    } else forward('SIGINT');
    const cleanup = (): void => {
      for (const [s, f] of handlers) ports.offSignal(s, f);
    };
    child.on('error', () => {
      cleanup();
      resolve(undefined);
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (code !== null) resolve(code);
      else resolve(128 + (signal !== null ? (ports.signalNumber(signal) ?? 0) : 0));
    });
  });
}

// ── nota pós-restart ─────────────────────────────────────────────────────────────────

/**
 * Lê e LIMPA `ALUY_RESTARTED_FROM` (não propaga a netos nem a subprocessos). Devolve a
 * versão antiga, ou `undefined` se este processo não veio de um `/restart`.
 */
export function takeRestartedFrom(env: Record<string, string | undefined>): string | undefined {
  const v = env[RESTARTED_FROM_ENV];
  delete env[RESTARTED_FROM_ENV];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

export function restartedNote(from: string, to: string): string {
  return from === to ? `↻ reiniciado — aluy ${to}` : `↻ reiniciado — aluy ${from} → ${to}`;
}
