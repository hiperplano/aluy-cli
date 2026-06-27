// EST-1009 · ADR-0065 · CLI-SEC-H1 — o LANÇADOR (mãe-lançador) do sandbox de SO.
//
// O processo-MÃE (não-confinado, TCB) cria, para cada sub-processo de efeito, um
// sandbox de SO via `bwrap` (bubblewrap) rootless/userns + seccomp-bpf + Landlock
// (aditivo). Esta é a PRIMITIVA: EST-1010 (bash) e EST-1011 (MCP) a consomem pela
// API `SandboxLauncher` do core. Esta EST NÃO conecta bash/MCP — só expõe a
// primitiva e prova os invariantes (a-f).
//
// INVARIANTES (gate `seguranca`, dolorosamente exatos):
//  (a) FS: o filho só vê o workspace + mounts explícitos; NUNCA `~/.aluy/`, `~/.ssh`,
//      `~/.aws`, `.env*`, nem nada fora do workspace. Não montamos `$HOME` no namespace.
//  (b) sem vazamento de handle: nenhum fd de `~/.aluy/` herda — o único fd que passa
//      é o do filtro seccomp (read-only, fechado pela mãe após spawn); stdio é o do
//      locus; tudo o mais é O_CLOEXEC por default no Node (spawn não herda fds extras).
//  (c) seccomp NEGA o conjunto perigoso (unshare/setns/mount/pivot_root/ptrace/
//      process_vm_readv/keyctl) via `bwrap --seccomp <fd>` (filtro gerado no core).
//  (d) net-deny por default (`--unshare-net`, sem `--share-net`) — socket falha.
//  (e) fail-mode (D-SB-4): sem `bwrap`/userns ⇒ degrade/refuse/unsafe conforme o
//      core; NUNCA finge confinamento.
//  (f) Landlock ADITIVO quando disponível — passado como reforço; degrada se não.
//  (g) §13.2 CONFINAMENTO DE RECURSO (cgroup v2): quando `cgroupLimits`, o bwrap é
//      ENVOLVIDO num `systemd-run --user --scope -p TasksMax/-p MemoryMax/-p CPUQuota`
//      que capa procs/RAM/CPU. CAMADA DISTINTA da fuga: bwrap confina FUGA (FS/rede/
//      syscall), o cgroup confina RECURSO (fork-bomb/`cat /dev/zero`/busy-loop). O
//      cgroup é o PISO DE DoS que o bwrap NÃO cobre. ADITIVO: sem systemd-run ⇒ roda
//      o bwrap cru + AVISA (degrade-com-aviso); NUNCA bloqueia o comando por falta de
//      cgroup nem finge teto de recurso.
//
// I/O de SO (`node:child_process`/`node:fs`/`node:os`) ⇒ @aluy/cli, não o core.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

/** Aspas POSIX seguras p/ um argumento dentro de um `sh -c` (single-quote + escape). */
function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
import type {
  SandboxCapability,
  SandboxConfinement,
  SandboxDecision,
  SandboxEnv,
  SandboxLauncher,
  SandboxResourceLimits,
  SandboxSpawnResult,
} from '@aluy/cli-core';
import { DEFAULT_RESOURCE_LIMITS, resolveFailMode, seccompFilterBytes } from '@aluy/cli-core';
import { aluyHomeDir } from './aluy-home.js';

/**
 * Conjunto MÍNIMO de paths de sistema montados READ-ONLY no namespace, p/ executar
 * binários (sh, coreutils, libs, intérpretes). Montar só o que EXISTE (cada um é
 * `--ro-bind-try`, que ignora ausente — distros variam). NUNCA inclui `$HOME` nem
 * `~/.aluy/`. É o "mínimo do sistema" da fronteira §2 do ADR.
 */
const SYSTEM_RO_PATHS: readonly string[] = Object.freeze([
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/etc/alternatives',
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/resolv.conf',
  '/etc/nsswitch.conf',
]);

export interface SpawnConfinedOptions {
  /** Abort do loop/root-flow (EST-0982). Repassado ao `ChildProcess` pelo locus. */
  readonly signal?: AbortSignal;
  /** stdio do filho (default herda do locus: ['ignore','pipe','pipe']). */
  readonly stdio?: SpawnOptions['stdio'];
  /** Ambiente do filho. NUNCA inclua credencial-CLI (CLI-SEC-7/E-B1). */
  readonly env?: NodeJS.ProcessEnv;
  /** Diretório de trabalho REAL do processo `bwrap` na mãe (não o cwd do filho). */
  readonly launcherCwd?: string;
}

/**
 * EST-1011 — invocação CONFINADA de um processo longevo de stdio (server MCP), pronta
 * p/ o caller passar ao spawn do SDK MCP. Em `confine`, `command`/`args` são o invólucro
 * `bwrap` (`/bin/sh -c 'exec bwrap ... <fd>< filtro'`); em `degrade`/`unsafe`, são o
 * server CRU + `decision.warning`; em `refuse`, `command` é `undefined` (não conecta).
 */
export interface ConfinedInvocation {
  /** A decisão de fail-mode (D-SB-4) aplicada — p/ o caller auditar/avisar. */
  readonly decision: SandboxDecision;
  /** Programa a spawnar. `undefined` SÓ em `refuse` (prod sem piso ⇒ não conecta). */
  readonly command?: string;
  /** Argumentos do programa (vazio quando `command` ausente). */
  readonly args?: readonly string[];
  /**
   * §13.2 — aviso ADITIVO de "confinou FUGA mas SEM teto de RECURSO" (cgroup ausente).
   * ORTOGONAL ao `decision.warning` (piso de FUGA). O caller emite ambos não-suprimíveis.
   */
  readonly warning?: string;
  /** Remove o filtro seccomp temporário. Chamar no `close()` do transport (server morto). */
  cleanup(): void;
}

export interface BwrapSandboxLauncherOptions {
  readonly capability: SandboxCapability;
  readonly env: SandboxEnv;
  /** `--unsafe-no-sandbox` resolvido (por sessão). Default false. */
  readonly unsafeNoSandbox?: boolean;
  /** Arch do Node (default `process.arch`) — p/ o filtro seccomp. */
  readonly arch?: string;
  /** spawn injetável (testes). Default `node:child_process` spawn. */
  readonly spawnFn?: typeof spawn;
  /** Caminho do `~/.aluy/` (default resolvido) — p/ rejeitar binds que o alcancem. */
  readonly aluyHome?: string;
  /** Caminho do binário bwrap (default 'bwrap' no PATH). */
  readonly bwrapPath?: string;
  /** §13.2 — caminho do binário systemd-run (default 'systemd-run' no PATH). */
  readonly systemdRunPath?: string;
}

/** Path normalizado (resolvido + sem trailing slash) p/ comparação de prefixo. */
function norm(p: string): string {
  const r = resolvePath(p);
  return r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
}

/**
 * Path CANONICALIZADO (realpath — resolve symlinks) p/ a comparação de FRONTEIRA.
 * `norm()` é só LÉXICO (`path.resolve`): um bind que é um SYMLINK p/ `~/.aluy/`
 * passaria pelo check léxico e o `bwrap` montaria o realpath (≈ vazaria `~/.aluy/`).
 * Aqui resolvemos o symlink ANTES de comparar — a defesa em profundidade de
 * `assertNoAluyHome` (ADR-0065 §2) tem que valer contra symlink, não só contra o
 * path textual. Se o path NÃO existe (ex.: bind futuro / `--ro-bind-try`), o
 * `realpathSync` lança ⇒ caímos no `norm()` léxico (o `bwrap` falharia no mount de
 * um path inexistente de qualquer forma; o check não deve quebrar por isso).
 */
function canon(p: string): string {
  try {
    return norm(realpathSync(p));
  } catch {
    return norm(p);
  }
}

/** `child` está DENTRO de `parent` (igual ou sob a árvore)? Comparação de prefixo. */
function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}

/**
 * LANÇADOR concreto via `bwrap`. Implementa `SandboxLauncher` do core (a primitiva
 * que 1010/1011 consomem). O tipo de processo é `ChildProcess` do Node.
 */
export class BwrapSandboxLauncher implements SandboxLauncher<ChildProcess, SpawnConfinedOptions> {
  readonly capability: SandboxCapability;
  readonly env: SandboxEnv;
  private readonly unsafeNoSandbox: boolean;
  private readonly arch: string;
  private readonly spawnFn: typeof spawn;
  private readonly aluyHome: string;
  private readonly bwrapPath: string;
  private readonly systemdRunPath: string;

  constructor(opts: BwrapSandboxLauncherOptions) {
    this.capability = opts.capability;
    this.env = opts.env;
    this.unsafeNoSandbox = opts.unsafeNoSandbox ?? false;
    this.arch = opts.arch ?? process.arch;
    this.spawnFn = opts.spawnFn ?? spawn;
    // CANONICALIZA (realpath) — se o próprio `~/.aluy/` (ou um ancestral, ex.: `~`)
    // for symlink, a comparação tem que bater pelo path REAL, não pelo textual.
    this.aluyHome = canon(opts.aluyHome ?? aluyHomeDir());
    this.bwrapPath = opts.bwrapPath ?? 'bwrap';
    this.systemdRunPath = opts.systemdRunPath ?? 'systemd-run';
  }

  /** RESOLVE a decisão de fail-mode (D-SB-4) SEM lançar — PURA sobre capability+env+flag. */
  decide(): SandboxDecision {
    return resolveFailMode(this.capability, this.env, this.unsafeNoSandbox);
  }

  /**
   * INVARIANTE de fronteira (defesa em profundidade no LANÇADOR, §2): rejeita
   * QUALQUER bind/cwd que alcance `~/.aluy/` — mesmo que a chamada peça. O piso não
   * monta `~/.aluy/` por construção; aqui falhamos ALTO se alguém tentar (fail-safe).
   */
  private assertNoAluyHome(confinement: SandboxConfinement): void {
    const candidates = [
      ...confinement.workspaceRoots,
      confinement.cwd,
      ...(confinement.roBinds ?? []),
      ...(confinement.rwBinds ?? []),
    ];
    for (const p of candidates) {
      // CANONICALIZA o candidato (resolve symlink) ANTES de comparar — um bind que é
      // symlink p/ `~/.aluy/` não pode furar a fronteira pelo path textual. `aluyHome`
      // já vem canonicalizado do construtor.
      const c = canon(p);
      if (isInside(c, this.aluyHome) || isInside(this.aluyHome, c)) {
        throw new SandboxConfinementError(
          `recusado: bind/cwd "${p}" alcança ~/.aluy/ (${this.aluyHome}) — o sandbox NUNCA ` +
            'monta o diretório do agente (journal/memória/config) no namespace (ADR-0065 §2).',
        );
      }
    }
  }

  /**
   * MONTA o argv do `bwrap` p/ o confinamento dado (sem o `--seccomp` fd, que o
   * caller injeta com o fd já aberto). Exposto p/ TESTE (provar a forma do argv:
   * net-deny, ro-binds, workspace, sem `$HOME`/`~/.aluy/`). PURO sobre os inputs.
   */
  buildBwrapArgs(confinement: SandboxConfinement, seccompFd?: number): string[] {
    const args: string[] = [
      // userns rootless + isola TODOS os namespaces (mount/pid/ipc/uts/cgroup/net).
      // `--unshare-all` inclui `--unshare-net` ⇒ NET-DENY por default (d).
      '--unshare-all',
      // morre se a mãe morrer (sem órfãos confinados).
      '--die-with-parent',
      // sem novos privilégios (defesa: setuid dentro do sandbox não eleva).
      '--new-session',
    ];

    // (d) REDE: só liga rede se o confinamento DECLAROU `network:true` (a catraca já
    // mostrou o destino — CLI-SEC-9). Default = sem rede (--unshare-all já cortou).
    if (confinement.network === true) {
      args.push('--share-net');
    }

    // (a) mínimo de sistema READ-ONLY (binários/libs). `--ro-bind-try` ignora o que
    // não existe (distros variam) — sem fingir nem quebrar.
    for (const p of SYSTEM_RO_PATHS) {
      args.push('--ro-bind-try', p, p);
    }

    // tmp efêmero DENTRO do sandbox (escrita transitória sem vazar p/ o host /tmp).
    // ANTES dos binds do workspace: se o workspace estiver SOB `/tmp` (comum em
    // teste/CI), o `--tmpfs /tmp` precisa vir PRIMEIRO p/ não shadowar o bind do
    // workspace montado em cima. A ordem de mounts do bwrap é a ordem do argv.
    args.push('--tmpfs', '/tmp');

    // (a) WORKSPACE: cada raiz autorizada montada RW no MESMO path (o filho vê o
    // workspace no caminho real, p/ paths relativos/absolutos do projeto baterem).
    // POR ÚLTIMO entre os mounts de FS — fica "em cima" de qualquer tmpfs/ro-bind.
    for (const root of confinement.workspaceRoots) {
      args.push('--bind', root, root);
    }

    // mounts explícitos liberados (allow-list do usuário — DADO; nunca ~/.aluy/).
    for (const p of confinement.roBinds ?? []) {
      args.push('--ro-bind', p, p);
    }
    for (const p of confinement.rwBinds ?? []) {
      args.push('--bind', p, p);
    }

    // /proc e /dev são montados DEPOIS de todos os binds (inclusive `--bind / /`
    // em yolo), p/ não serem sombreados por um bind de workspace que cubra /dev.
    args.push('--proc', '/proc', '--dev', '/dev');

    // (c) seccomp: nega o conjunto perigoso. O fd é aberto pelo caller e passado aqui.
    if (seccompFd !== undefined) {
      args.push('--seccomp', String(seccompFd));
    }

    // cwd do filho DENTRO do sandbox (⊆ workspace).
    args.push('--chdir', confinement.cwd);

    return args;
  }

  /**
   * §13.2 — CONFINAMENTO DE RECURSO (cgroup v2). Monta o PREFIXO `systemd-run --user
   * --scope ...` que ENVOLVE o `bwrap` num scope transitório do systemd com teto de
   * RECURSO (TasksMax/MemoryMax/CPUQuota). É a CAMADA DISTINTA do bwrap:
   *
   *   bwrap  → confina FUGA  (FS/rede/syscall): o filho não VÊ ~/.aluy/, não fura o ns.
   *   cgroup → confina RECURSO (procs/RAM/CPU): o filho não DERRUBA a máquina —
   *            fork-bomb (`:(){ :|:& };:`) bate em TasksMax, `cat /dev/zero` em
   *            MemoryMax, busy-loop é throttlado por CPUQuota. É o PISO DE DoS que o
   *            bwrap NÃO cobre (EST-1011 "recurso sem teto").
   *
   * O comando efetivo vira:
   *   systemd-run --user --scope --quiet --collect \
   *     -p TasksMax=<N> -p MemoryMax=<M> -p CPUQuota=<C> -- bwrap <args...> -- <cmd>
   *
   * `--scope` roda SÍNCRONO no nosso processo (não vira serviço destacado) ⇒ o
   * stdio/sinal/`--die-with-parent` do bwrap seguem valendo. `--collect` libera o
   * scope ao terminar (sem unidades falhas acumulando). `--quiet` cala o ruído do
   * systemd no stderr do comando.
   *
   * Devolve `[]` quando `cgroupLimits` NÃO está disponível na capability — o caller
   * então roda o bwrap CRU e AVISA (degrade-com-aviso): NUNCA finge teto de recurso,
   * e NUNCA bloqueia o comando por falta de cgroup (hardening ADITIVO, não gate duro).
   * Exposto p/ TESTE (provar a forma do prefixo), PURO sobre os inputs.
   */
  buildSystemdRunPrefix(confinement: SandboxConfinement): string[] {
    if (this.capability.cgroupLimits !== true) return [];

    const limits: Required<SandboxResourceLimits> = {
      tasksMax: confinement.resourceLimits?.tasksMax ?? DEFAULT_RESOURCE_LIMITS.tasksMax,
      memoryMax: confinement.resourceLimits?.memoryMax ?? DEFAULT_RESOURCE_LIMITS.memoryMax,
      cpuQuota: confinement.resourceLimits?.cpuQuota ?? DEFAULT_RESOURCE_LIMITS.cpuQuota,
    };

    return [
      '--user',
      '--scope',
      '--quiet',
      // libera o scope transitório ao terminar (não deixa unidade falha pendurada).
      '--collect',
      '-p',
      `TasksMax=${limits.tasksMax}`,
      '-p',
      `MemoryMax=${limits.memoryMax}`,
      '-p',
      `CPUQuota=${limits.cpuQuota}`,
      // separador: tudo após `--` é o COMANDO que o scope executa (o bwrap + args).
      '--',
    ];
  }

  /**
   * §13.2 — aviso ADITIVO não-suprimível quando confinamos a FUGA (bwrap) mas NÃO o
   * RECURSO (cgroup indisponível). Espelha o tom do `buildWarning` do core (fail-mode):
   * INEQUÍVOCO, com motivo, sem fingir. O efeito RODA (cgroup é hardening aditivo, não
   * gate duro) — só corre SEM teto de fork-bomb/RAM/CPU, e o usuário SEMPRE vê isso.
   */
  private cgroupUnavailableWarning(): string {
    const reason = this.capability.unavailableReason ?? 'systemd-run --user indisponível';
    return (
      '⚠ SEM CONFINAMENTO DE RECURSO NESTA MÁQUINA — o sandbox confina FUGA ' +
      '(FS/rede/syscall via bwrap) MAS não o RECURSO (cgroup v2 via systemd-run ' +
      'ausente): um fork-bomb/`cat /dev/zero` confinado ainda pode esgotar ' +
      'CPU/RAM/PIDs da máquina (ADR-0065 §13.2). O comando RODA MESMO ASSIM — ' +
      `confinamento de recurso é hardening aditivo, não gate duro. Motivo: ${reason}.`
    );
  }

  /**
   * EST-1011 · ADR-0065 §11.2 (E-B3 / FU-VAU-11-bis) — confinamento de um PROCESSO
   * LONGEVO de STDIO (server MCP) que a MÃE **não spawna ela mesma**: quem dá o
   * `spawn` é o `StdioClientTransport` do SDK MCP (ele hardcoda `stdio:[pipe,pipe,
   * stderr]` e fala JSON-RPC por 0/1). Como NÃO controlamos o array de stdio do SDK,
   * NÃO podemos injetar o fd do filtro seccomp como o `spawnInBwrap` faz (fd posicional).
   *
   * SOLUÇÃO (mesma primitiva, sem fd posicional): devolvemos um `command`+`args`
   * REESCRITOS p/ o SDK spawnar — `/bin/sh -c 'exec bwrap --seccomp 3 <args> -- <server>
   * 3< <filtro>'`. O **shell** abre o fd 3 a partir do ARQUIVO do filtro (0600), o
   * `bwrap` o herda, e o `exec` substitui o shell pelo `bwrap` (→ pelo server) SEM
   * processo intermediário pendurado. Os fds 0/1/2 do SDK passam INTOCADOS p/ o bwrap
   * e daí p/ o server: o handshake `initialize` e os `callTool` fluem ATRAVÉS do
   * sandbox sem o protocolo quebrar.
   *
   * Reusa `buildBwrapArgs` (net-deny default, workspace, sem `$HOME`/`~/.aluy/`),
   * `seccompFilterBytes` (filtro provado byte-a-byte no core) e `buildSystemdRunPrefix`
   * (cgroup §13.2) — NÃO reimplementa nada do confinamento provado pelo bash.
   *
   * O fail-mode (D-SB-4) é o MESMO `decide()`:
   *  - `confine` ⇒ devolve o invólucro `bwrap` + `cleanup()` (remove o filtro temporário
   *    APÓS o server encerrar — o fd vive enquanto o shell roda, então NÃO removemos
   *    antes do spawn como no one-shot do bash).
   *  - `degrade`/`unsafe` ⇒ devolve o `command`/`args` CRUS (sem bwrap) + `decision.warning`
   *    (o caller emite o aviso não-suprimível); NUNCA finge confinamento.
   *  - `refuse` ⇒ devolve `command:undefined` — o caller NÃO conecta o server (prod sem piso).
   *
   * É PURO de efeito de processo (não spawna): só escreve o filtro temporário e monta
   * o argv. O caller (`StdioMcpTransport`) passa `command`/`args`/`cwd`/`env` ao SDK.
   */
  buildConfinedInvocation(
    command: readonly string[],
    confinement: SandboxConfinement,
  ): ConfinedInvocation {
    if (command.length === 0) {
      throw new SandboxConfinementError(
        'buildConfinedInvocation: command vazio (sem programa a confinar).',
      );
    }
    // Invariante de fronteira ANTES de qualquer decisão: ~/.aluy/ nunca entra.
    this.assertNoAluyHome(confinement);

    const decision = this.decide();

    // (e) REFUSE: prod sem piso e sem flag ⇒ NÃO conecta nada. `command` ausente.
    if (decision.action === 'refuse') {
      return { decision, cleanup: () => {} };
    }

    // DEGRADE / UNSAFE: roda o server CRU (sem bwrap) — o caller emite `decision.warning`
    // (não-suprimível). NUNCA fingimos confinamento (nenhum bwrap, nenhum filtro).
    if (decision.action !== 'confine') {
      return {
        decision,
        command: command[0]!,
        args: command.slice(1),
        cleanup: () => {},
      };
    }

    // CONFINE: monta o invólucro bwrap com o filtro seccomp aberto por fd-de-shell.
    const filter = seccompFilterBytes(this.arch);
    if (!filter) {
      // Sem filtro p/ esta arch ⇒ piso de SO incompleto. NUNCA confinamos sem seccomp
      // (critério c). Não deveria acontecer (a capability checou a arch) — fail-safe.
      throw new SandboxConfinementError(
        `sem filtro seccomp p/ arch ${this.arch} — recusando confinar server MCP sem o piso de syscalls (c).`,
      );
    }

    // Arquivo temporário 0600 com o filtro (dir 0700). VIVE enquanto o server roda —
    // o shell abre o fd 3 a partir dele no spawn; `cleanup()` o remove no `close()`.
    const dir = mkdtempSync(join(tmpdir(), 'aluy-mcp-sb-'));
    const filterPath = join(dir, 'seccomp.bpf');
    writeFileSync(filterPath, filter, { mode: 0o600 });

    // O fd que o shell abre p/ o bwrap. 3 = primeiro fd livre (0/1/2 = stdio do SDK).
    const seccompFd = 3;
    const bwrapArgs = this.buildBwrapArgs(confinement, seccompFd);
    const bwrapInvocation = [this.bwrapPath, ...bwrapArgs, '--', ...command];

    // §13.2 — CONFINAMENTO DE RECURSO (camada DISTINTA): envolve o bwrap num scope do
    // systemd com teto de procs/RAM/CPU. Vazio ⇒ bwrap cru + aviso aditivo (degrade-com-
    // aviso; nunca finge teto de recurso, nunca bloqueia por falta de cgroup).
    const cgroupPrefix = this.buildSystemdRunPrefix(confinement);
    const useCgroup = cgroupPrefix.length > 0;
    const fullInvocation = useCgroup
      ? [this.systemdRunPath, ...cgroupPrefix, ...bwrapInvocation]
      : bwrapInvocation;

    // `/bin/sh -c 'exec <invocation...> 3< <filtro>'` — o shell abre o fd 3 do ARQUIVO
    // e `exec` substitui o shell pelo invólucro (sem processo-fantasma). Os fds 0/1/2
    // do SDK passam intocados ⇒ JSON-RPC flui ATRAVÉS do sandbox.
    const script = `exec ${fullInvocation.map(shQuote).join(' ')} ${seccompFd}< ${shQuote(filterPath)}`;

    const warning = useCgroup ? undefined : this.cgroupUnavailableWarning();
    return {
      decision,
      command: '/bin/sh',
      args: ['-c', script],
      ...(warning ? { warning } : {}),
      cleanup: () => {
        // Remove o filtro+dir DEPOIS de o server encerrar (o fd já não é mais aberto).
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      },
    };
  }

  /**
   * LANÇA `command` (programa + args) DENTRO do confinamento, ou degrada/recusa/
   * unsafe conforme `decide()` (D-SB-4). Devolve a decisão + o processo (ou nenhum,
   * em `refuse`). O caller (EST-1010/1011) liga stdio/sinal/timeout como no
   * `NodeShellPort` atual.
   */
  spawnConfined(
    command: readonly string[],
    confinement: SandboxConfinement,
    opts: SpawnConfinedOptions = {},
  ): SandboxSpawnResult<ChildProcess> {
    if (command.length === 0) {
      throw new SandboxConfinementError('spawnConfined: command vazio (sem programa a executar).');
    }
    // Invariante de fronteira ANTES de qualquer decisão de modo: ~/.aluy/ nunca entra.
    this.assertNoAluyHome(confinement);

    const decision = this.decide();

    // (e) REFUSE: prod sem piso e sem flag ⇒ NÃO lança nada.
    if (decision.action === 'refuse') {
      return { decision };
    }

    const spawnEnv = opts.env ?? process.env;
    const stdio = opts.stdio ?? (['ignore', 'pipe', 'pipe'] as SpawnOptions['stdio']);
    const baseSpawnOpts: SpawnOptions = {
      env: spawnEnv,
      stdio,
      // GRUPO de processo próprio (o caller mata o GRUPO no abort/timeout — sem
      // órfãos). Espelha o NodeShellPort (EST-0982).
      detached: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.launcherCwd ? { cwd: opts.launcherCwd } : {}),
    };

    // CONFINE: monta o bwrap + seccomp fd e lança o programa DENTRO dele.
    if (decision.action === 'confine') {
      return this.spawnInBwrap(command, confinement, baseSpawnOpts, decision);
    }

    // DEGRADE / UNSAFE: roda SEM sandbox (com aviso já no `decision.warning`). O
    // caller DEVE emitir o aviso (não-suprimível). Aqui só lançamos o programa cru
    // — NÃO fingimos confinamento (nenhum bwrap, nenhum filtro). O cwd do filho é o
    // cwd do confinamento (mesma semântica do shell-port atual).
    const child = this.spawnFn(command[0]!, command.slice(1), {
      ...baseSpawnOpts,
      cwd: confinement.cwd,
    });
    return { decision, process: child };
  }

  /**
   * Caminho CONFINE: cria o fd do filtro seccomp, monta o argv do bwrap e lança.
   * O fd é aberto READ-ONLY sobre um arquivo temporário 0600 (escrito e removido na
   * hora) e FECHADO pela mãe logo após o spawn — não vaza (b). bwrap herda só esse
   * fd (passado por número); o Node não herda fds extras (O_CLOEXEC default).
   */
  private spawnInBwrap(
    command: readonly string[],
    confinement: SandboxConfinement,
    baseSpawnOpts: SpawnOptions,
    decision: SandboxDecision,
  ): SandboxSpawnResult<ChildProcess> {
    const filter = seccompFilterBytes(this.arch);
    // Sem filtro p/ esta arch ⇒ o piso de SO está incompleto. NUNCA confinamos sem
    // seccomp (critério c). Isso não deveria acontecer (a capability já checou a
    // arch), mas é fail-safe: cai pro caminho de degradação explícita.
    if (!filter) {
      throw new SandboxConfinementError(
        `sem filtro seccomp p/ arch ${this.arch} — recusando confinar sem o piso de syscalls (c).`,
      );
    }

    // Arquivo temporário 0600 com o filtro, aberto RO; bwrap lê do fd. Dir 0700.
    const dir = mkdtempSync(join(tmpdir(), 'aluy-sb-'));
    const filterPath = join(dir, 'seccomp.bpf');
    let seccompFd = -1;
    try {
      writeFileSync(filterPath, filter, { mode: 0o600 });
      seccompFd = openSync(filterPath, 'r');

      const bwrapArgs = this.buildBwrapArgs(confinement, seccompFd);
      // `bwrap <args...> -- <cmd>` é o confinamento de FUGA (sempre).
      const bwrapInvocation = [this.bwrapPath, ...bwrapArgs, '--', ...command];

      // §13.2 — CONFINAMENTO DE RECURSO (camada DISTINTA): envolve o bwrap num scope
      // do systemd com teto de procs/RAM/CPU (PISO DE DoS). Se a capability não tem
      // `cgroupLimits`, o prefixo é vazio ⇒ roda o bwrap CRU e AVISA (degrade-com-
      // aviso; nunca finge teto de recurso, nunca bloqueia por falta de cgroup).
      const cgroupPrefix = this.buildSystemdRunPrefix(confinement);
      const useCgroup = cgroupPrefix.length > 0;
      // Programa a spawnar + seus argv (índice 0 de `bwrapInvocation` é o binário,
      // que vira ARGUMENTO do systemd-run quando há cgroup).
      const program = useCgroup ? this.systemdRunPath : this.bwrapPath;
      const programArgs = useCgroup
        ? [...cgroupPrefix, ...bwrapInvocation] // systemd-run <prefixo> -- bwrap <args> -- cmd
        : bwrapInvocation.slice(1); // bwrap <args> -- cmd

      const child = this.spawnFn(program, programArgs, {
        ...baseSpawnOpts,
        // o fd do filtro PRECISA ser herdado pelo bwrap (passado por número). O
        // Node, por default, NÃO herda fds extras (>2); por isso o repassamos no
        // `stdio` como fd posicional. Mantemos 0/1/2 do caller e adicionamos o fd.
        // Com systemd-run --scope o fd herda do scope p/ o bwrap (mesmo fork/exec).
        stdio: withInheritedFd(baseSpawnOpts.stdio, seccompFd),
      });
      // Confinou a FUGA (bwrap), mas SEM teto de RECURSO ⇒ aviso aditivo não-silencioso.
      const warning = useCgroup ? undefined : this.cgroupUnavailableWarning();
      return { decision, process: child, ...(warning ? { warning } : {}) };
    } finally {
      // (b) FECHA o fd na mãe imediatamente (o bwrap já o herdou no fork/exec). E
      // remove o arquivo+dir temporário (o filtro não persiste). Best-effort.
      if (seccompFd >= 0) {
        try {
          closeSync(seccompFd);
        } catch {
          /* já fechado */
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Monta o `stdio` do spawn herdando o fd extra (do filtro seccomp) no MESMO número
 * que o bwrap espera. O array de stdio do Node usa o índice como fd no filho; p/
 * herdar o fd `n` no número `n`, preenchemos as posições 3..n com 'ignore' e
 * colocamos o objeto `{ fd: n }` na posição `n`. Mantém 0/1/2 do caller.
 */
function withInheritedFd(stdio: SpawnOptions['stdio'], fd: number): SpawnOptions['stdio'] {
  const base: Array<unknown> = Array.isArray(stdio)
    ? [...stdio]
    : [stdio ?? 'pipe', 'pipe', 'pipe'];
  while (base.length < fd) base.push('ignore');
  base[fd] = fd; // herda o fd `fd` no MESMO número no filho
  return base as SpawnOptions['stdio'];
}

/** Erro de violação de fronteira do sandbox (fail-safe ALTO — nunca silencioso). */
export class SandboxConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxConfinementError';
  }
}
