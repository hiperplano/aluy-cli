// EST-0948 · I/O concreto da ShellPort (cravada do `seguranca`).
// EST-0982 — ABORTÁVEL + STREAMING (esta estória).
//
// Implementa `ShellPort.exec` do core (EST-0944) com `child_process` real, sob
// travas não-negociáveis do seguranca:
//   - TIMEOUT obrigatório (anti-hang): nenhum comando pode pendurar o agente. Ao
//     estourar, o processo é MORTO (SIGTERM→SIGKILL no GRUPO) e a observação reporta
//     o timeout (vira dado p/ o modelo, CLI-SEC-4 — não trava o loop).
//   - cwd PRESO ao workspace: o comando roda no DIRETÓRIO DE TRABALHO DE SESSÃO
//     (NodeWorkspace.cwd), que é SEMPRE ⊆ raiz canonicalizada (EST-0982 — o setCwd
//     clampa na raiz; default = raiz). Nunca num cwd arbitrário herdado/fora da raiz.
//
// EST-0982 adiciona, SEM relaxar nenhuma trava (o comando só roda APÓS a catraca
// aprovar — a `decide()` é intocada, fora desta porta):
//   - ABORT: `options.signal` (o MESMO sinal do loop/root-flow — esc/Ctrl-C/interrupt)
//     MATA o processo na hora: SIGTERM no GRUPO e, após um grace curto (2s), SIGKILL.
//     Sinal JÁ abortado ⇒ NÃO roda nada (curto-circuito). O kill é do GRUPO de processo
//     (detached + `-pid`), então um server/neto (`setsid`/spawn) não escapa órfão.
//   - STREAMING: `options.onChunk` recebe stdout/stderr AO VIVO (por linha) enquanto o
//     comando roda — o chamador renderiza no bloco da tool viva. O chunk é BRUTO aqui;
//     a REDAÇÃO (CLI-SEC-6) é aplicada pela tool no core (ponto único portável) ANTES
//     de virar render/observação.
//
// O confinamento de PATHs tocados pelo comando é heurístico (a catraca já força
// ask p/ rede/destrutivo/escrita-fora via categorias da 0945 + egress aqui); o
// confinamento DURO de FS é no fs-port (resolveInside). O shell, por natureza,
// pode tocar qualquer path — por isso TODO run_command passa por `ask` (0945) e
// o usuário vê o comando EXATO antes (CLI-SEC-9).

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  ShellChunk,
  ShellExecOptions,
  ShellPort,
  ShellResult,
} from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';
import type { BwrapSandboxLauncher } from '../sandbox/index.js';

/**
 * Default de timeout do exec (ms) — anti-hang. EST-0969: é um timeout de
 * INATIVIDADE de OUTPUT (re-armado a cada chunk de stdout/stderr), não um teto de
 * runtime total — um comando longo MAS verboso não é morto; só o silencioso por
 * `timeoutMs` (provável hung) é. Override por config/env.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * EST-0982 — grace entre SIGTERM e SIGKILL ao matar (abort OU timeout): damos ao
 * processo um instante p/ encerrar limpo; se teimar, SIGKILL no grupo. Curto p/ o
 * `esc` matar bem abaixo de ~2s (DoD) e p/ o timeout não pendurar além do teto.
 */
export const KILL_GRACE_MS = 2_000;

/**
 * BUG-0027 — grace entre `exit` (processo terminou) e o finalize FORÇADO quando o
 * `close` (EOF de stdio) NÃO vem. Um NETO DESTACADO que herdou o stdout (ex.:
 * `start <GUI>` no Windows, ou um `cmd & ` que backgrounda um daemon) segura o
 * write-end do pipe ⇒ o `close` jamais dispara e o exec penduraria pra sempre,
 * deixando o ABORT (ESC/Ctrl-C) e o TIMEOUT inócuos. Após o `exit`, damos este
 * instante curto p/ o `close` normal flushar; se não vier, destruímos os pipes e
 * finalizamos com o que já temos. No caminho normal o `close` chega primeiro e
 * cancela o timer ⇒ ZERO mudança de comportamento.
 */
export const EXIT_DRAIN_MS = 250;

export interface NodeShellPortOptions {
  /** Workspace — fornece o cwd PRESO (root canonicalizado). */
  readonly workspace: WorkspacePort;
  /** Timeout do exec em ms (default 120s). OBRIGATÓRIO ter um — anti-hang. */
  readonly timeoutMs?: number;
  /** Shell a usar (default: `/bin/sh -c` / `cmd /c` no Windows). */
  readonly shell?: string;
  /** Ambiente do processo filho (default: o do processo). */
  readonly env?: NodeJS.ProcessEnv;
  /** spawn injetável (testes). Default: `node:child_process` spawn. */
  readonly spawnFn?: typeof spawn;
  /**
   * EST-0982 — grace SIGTERM→SIGKILL (ms). Injetável p/ teste (encurtar o grace e
   * provar o SIGKILL sem esperar 2s). Default `KILL_GRACE_MS`.
   */
  readonly killGraceMs?: number;
  /**
   * Plataforma (default `process.platform`). Injetável p/ teste do caminho Windows.
   * No `win32` o kill de timeout/abort usa `taskkill /T /F` (mata a ÁRVORE de processo)
   * em vez de `process.kill(-pid)` (grupo POSIX, que NÃO existe no Windows ⇒ netos
   * órfãos). Cross-platform: anti-hang/abort funciona igual nos dois SOs.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * EST-1010 · ADR-0065 — lançador de sandbox de SO. Quando presente, o comando
   * roda CONFINADO (bwrap: só as `workspace.roots` visíveis; `~/.aluy/`/`~/.ssh`/
   * `~/.aws`/`$HOME` barrados por NAMESPACE de mount — não por reconhecer string;
   * rede negada por default). Ausente ⇒ spawn cru (FAIL-OPEN: o piso de SO é
   * defesa-em-profundidade; a catraca/`ask` (0945) e o egress continuam valendo
   * sem ele). O piso NÃO é relaxável por `--yolo`/`--unsafe` (é invariante de SO,
   * não política da catraca) — quem decide confine/degrade/refuse é o `decide()`
   * do lançador (D-SB-4), não esta porta.
   */
  readonly sandboxLauncher?: BwrapSandboxLauncher;
  /**
   * EST-1020 · ADR-0065 §8.2 (P1, APR-0087) · ADR-0060 (CLI-SEC-5) — DECISÃO DE
   * EGRESS, injetada como FUNÇÃO PURA. Recebe o comando exato e devolve `true` SE A
   * POLÍTICA DE EGRESS (a MESMA da catraca — `EgressAllowlist`) permite o destino
   * daquele comando. É o ÚNICO sinal que ABRE rede no sandbox: a `exec` deriva
   * `network` SÓ daqui — NUNCA de um literal `true`.
   *
   * Contrato (invariante de segurança — a rede só abre via a política REAL):
   *  - comando SEM host detectável ⇒ `false` (network:false; invariante (d) do ADR
   *    — sem destino, sem rede; o `--unshare-net` permanece). NÃO é allow-por-omissão.
   *  - comando COM host PERMITIDO pela política ⇒ `true` (abre `--share-net`).
   *  - comando COM host NEGADO pela política ⇒ `false` (roda confinado SEM rede; o
   *    connect FALHA dentro do sandbox — default-deny, invariante (d)).
   *
   * AUSENTE (default) ⇒ tratada como SEMPRE `false`: comportamento IDÊNTICO ao
   * pré-P1 (`network:false` fixo). Assim o opt-in `ALUY_SANDBOX_BASH` sem o wiring de
   * egress JAMAIS abre rede por acidente — DEFAULT DENY por construção. É injetada
   * pelo wiring a partir do `EgressAllowlist` REAL (consulta, não reimplementa).
   */
  readonly egressAllows?: (command: string) => boolean;
}

/** Tamanho máximo de buffer de saída coletado (anti-OOM por comando verboso). */
const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Hunt "recurso sem teto" (streaming) — teto do buffer de LINHA PARCIAL do emitter.
 *
 * O streaming é por LINHA: o `feed` acumula o parcial em `pending` até achar `\n` e
 * só então emite. Os buffers AGREGADOS (`stdout`/`stderr`) já são capados em
 * `MAX_OUTPUT_BYTES`, MAS o `pending` do emitter NÃO era — uma ÚNICA "linha" gigante
 * SEM newline (`cat /dev/urandom | base64 -w0`, `yes | tr -d '\n'`, um JSON minificado
 * de centenas de MiB) faz `pending` crescer SEM TETO em memória (a busca por `\n`
 * nunca casa), estourando a RAM mesmo com o agregado capado. Quando o parcial cruza
 * este teto sem newline, FLUSHAMOS o pedaço como um chunk (saída honesta, nada some) e
 * zeramos `pending` — o consumidor ao vivo (que tem o seu próprio `clipLiveTail`)
 * recebe a saída em pedaços limitados. 64 KiB ≈ um read de pipe do kernel.
 */
const MAX_LINE_BYTES = 64_000;

export class NodeShellPort implements ShellPort {
  private readonly workspace: WorkspacePort;
  private readonly timeoutMs: number;
  private readonly shell: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: typeof spawn;
  private readonly killGraceMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly sandboxLauncher: BwrapSandboxLauncher | undefined;
  // EST-1020 — decisão de egress (pura) p/ derivar `network` do sandbox. Ausente ⇒
  // SEMPRE nega (default-deny: igual ao `network:false` fixo do pré-P1).
  private readonly egressAllows: (command: string) => boolean;
  /**
   * EST-1010 — o aviso de "sem piso de SO" (degrade/unsafe) é emitido UMA vez por
   * sessão (não por comando): numa máquina sem bwrap, repetir o aviso a cada
   * `run_command` poluiria a saída. Once-per-instância = once-per-sessão.
   */
  private sandboxWarned = false;

  constructor(opts: NodeShellPortOptions) {
    this.workspace = opts.workspace;
    // Trava do seguranca: timeout SEMPRE presente; 0/negativo cai no default.
    this.timeoutMs =
      opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;
    this.shell = opts.shell;
    this.env = opts.env ?? process.env;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.killGraceMs =
      opts.killGraceMs !== undefined && opts.killGraceMs >= 0 ? opts.killGraceMs : KILL_GRACE_MS;
    this.platform = opts.platform ?? process.platform;
    this.sandboxLauncher = opts.sandboxLauncher;
    // DEFAULT-DENY: sem a função injetada, a rede do sandbox NUNCA abre (igual ao
    // `network:false` fixo do pré-P1). A rede só abre via a política de egress real.
    this.egressAllows = opts.egressAllows ?? ((): boolean => false);
  }

  async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
    const signal = options?.signal;
    const onChunk = options?.onChunk;

    // EST-0982 — sinal JÁ abortado ⇒ NÃO roda nada (curto-circuito): o usuário já
    // pediu parada antes de o efeito começar. Honra a parada sem spawnar processo.
    if (signal?.aborted) {
      return { stdout: '', stderr: '', exitCode: 130, aborted: true };
    }

    return await new Promise<ShellResult>((resolvePromise) => {
      // EST-1010 · ADR-0065 — CONFINAMENTO de SO. Quando há `sandboxLauncher`, o
      // comando roda DENTRO do bwrap (só `workspace.roots` visível; `~/.aluy/`/
      // `~/.ssh`/`~/.aws`/`$HOME` barrados por NAMESPACE; rede negada por default).
      // O `decide()` do lançador (D-SB-4) escolhe confine/degrade/unsafe/refuse — NÃO
      // esta porta, e NÃO `--yolo` (o piso é invariante de SO). Sem lançador ⇒ spawn
      // cru (fail-open; a catraca/ask continua valendo). Em AMBOS os caminhos o filho
      // é `detached` (líder de GRUPO) p/ o kill de timeout/abort matar a árvore.
      let child: ChildProcess;
      let sandboxWarning: string | undefined;
      if (this.sandboxLauncher) {
        // EST-1010 · ADR-0065 — CONFINAMENTO de SO. Quando há `sandboxLauncher`, o
        // comando roda DENTRO do bwrap (só `workspace.roots` visível; `~/.aluy/`/
        // `~/.ssh`/`~/.aws`/`$HOME` barrados por NAMESPACE).
        //
        // EST-1020 · P1 · ADR-0065 §8.2 / APR-0087 — a REDE do sandbox sob a
        // DECISÃO DE EGRESS da catraca (ADR-0060). Em vez do `network:false` FIXO,
        // a rede só abre quando a POLÍTICA DE EGRESS REAL permite o destino daquele
        // comando — via a função pura `egressAllows` (consulta o MESMO
        // `EgressAllowlist` da catraca, NÃO reimplementa política):
        //   · comando sem host ⇒ `egressAllows` retorna false ⇒ network:false
        //     (invariante (d): sem destino, sem rede; `--unshare-net` permanece).
        //   · host PERMITIDO pela política ⇒ true ⇒ network:true (`--share-net`).
        //   · host NEGADO pela política ⇒ false ⇒ network:false (roda confinado SEM
        //     rede; o connect FALHA dentro do sandbox — default-deny, invariante (d)).
        // NUNCA abrimos rede fora da política de egress: a decisão é SEMPRE
        // `egressAllows(command)`, jamais um literal.
        const networkAllowed = this.egressAllows(command);
        const {
          decision,
          process: confined,
          warning: resourceWarning,
        } = this.sandboxLauncher.spawnConfined(
          ['/bin/sh', '-c', command],
          {
            workspaceRoots: this.workspace.roots,
            cwd: this.workspace.cwd,
            network: networkAllowed,
          },
          { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        // (e) REFUSE — prod sem piso de SO e sem flag: NÃO roda nada. Reporta o motivo
        // como DADO (CLI-SEC-4), não trava o loop. Nunca finge confinamento.
        if (decision.action === 'refuse' || !confined) {
          resolvePromise({
            stdout: '',
            stderr:
              decision.warning ??
              '[sandbox: execução recusada — sem piso de SO de confinamento nesta máquina (prod)]',
            exitCode: 126,
          });
          return;
        }
        child = confined;
        // DEGRADE/UNSAFE ⇒ aviso INEQUÍVOCO não-suprimível (D-SB-4): rodou SEM piso.
        // §13.2 ⇒ aviso ADITIVO de "sem teto de RECURSO" quando confinou a fuga (bwrap)
        // mas o cgroup estava ausente. ORTOGONAIS: o de fuga (decision.warning) só
        // existe em degrade/unsafe; o de recurso só em confine-sem-cgroup. No caminho
        // confine normal ambos são vazios.
        sandboxWarning = decision.warning ?? resourceWarning;
      } else {
        // FAIL-OPEN — sem lançador, spawn cru. cwd = DIRETÓRIO DE SESSÃO
        // (`workspace.cwd` ⊆ raiz canonicalizada; `setCwd` clampa). `detached` = GRUPO
        // próprio (timeout/abort matam a árvore — sem órfão). stdio capturado.
        const isWin = this.platform === 'win32';
        child = this.spawnFn(command, {
          cwd: this.workspace.cwd,
          env: this.env,
          shell: this.shell ?? true,
          // `detached` é p/ o GRUPO POSIX (kill -pid). No Windows não há grupo POSIX
          // (o kill usa `taskkill /T`) e `detached` ABRE UM NOVO CONSOLE (janela cmd
          // piscando a cada comando). Por isso: detached só no Unix.
          detached: !isWin,
          // No Windows, NÃO abre janela de console p/ o processo filho (Cmder etc.).
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

      let stdout = '';
      let stderr = '';
      // EST-1010 — DEGRADE/UNSAFE: emite o aviso de "sem piso de SO" ANTES da saída do
      // comando, não-suprimível (vira dado p/ o modelo E render p/ o usuário). UMA vez
      // por sessão (`sandboxWarned`) — não spamma a cada comando numa máquina sem piso.
      if (sandboxWarning && !this.sandboxWarned) {
        this.sandboxWarned = true;
        const w = `${sandboxWarning}\n`;
        stderr += w;
        onChunk?.({ stream: 'stderr', text: w });
      }
      let killedByTimeout = false;
      let killedByAbort = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      // BUG-0027 — o processo já SAIU (`exit`) mas o `close` (EOF de stdio) pode não
      // vir se um neto destacado herdou o stdout. Guardamos o resultado do `exit` e
      // armamos um drain curto que FORÇA o finalize se o `close` não chegar.
      let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
      let exited: { code: number | null; sig: NodeJS.Signals | null } | undefined;

      const finish = (result: ShellResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (exitDrainTimer) clearTimeout(exitDrainTimer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };

      // Mata a ÁRVORE/GRUPO de processo do filho (sh + netos), cross-platform. Fail-safe
      // se o pid sumiu (ESRCH) ou o mecanismo falhou: cai p/ matar o filho direto.
      const killGroup = (sig: NodeJS.Signals): void => {
        const pid = child.pid;
        if (pid === undefined) {
          try {
            child.kill(sig);
          } catch {
            /* já morto */
          }
          return;
        }
        if (this.platform === 'win32') {
          // Windows NÃO tem grupo de processo POSIX (`process.kill(-pid)` é inválido).
          // `taskkill /T` mata a ÁRVORE (filho + netos) — sem o /T, um neto (server/
          // build) escaparia órfão no timeout/Ctrl-C. /F = força. Fail-safe → filho.
          try {
            this.spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            try {
              child.kill(sig);
            } catch {
              /* já morto */
            }
          }
          return;
        }
        // POSIX — mata o GRUPO (pid negativo = grupo, com `detached`).
        try {
          process.kill(-pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* já morto */
          }
        }
      };

      // SIGTERM no grupo + SIGKILL após o grace se teimar. Reusado por timeout E
      // abort — o kill é idêntico; só o motivo (e o exitCode/flag) difere.
      const killWithGrace = (): void => {
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), this.killGraceMs);
        killTimer.unref?.();
      };

      // ANTI-HANG (EST-0969 — heartbeat de OUTPUT, não teto TOTAL): o timer mata o
      // processo (grupo) se ele ficar `timeoutMs` SEM produzir saída (stdout/stderr)
      // = provável hung. Cada chunk de output RE-ARMA o timer (`bumpExecIdle`) ⇒ um
      // build/teste longo MAS verboso (cuspindo progresso) NUNCA é morto. Um comando
      // silencioso-legítimo-longo ⇒ background (feature separada): aqui ele conta como
      // hung após `timeoutMs` de silêncio — mesma trava anti-hang do seguranca, só que
      // medida por INATIVIDADE de saída, não por relógio total.
      let timer: ReturnType<typeof setTimeout>;
      const bumpExecIdle = (): void => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (settled) return;
          killedByTimeout = true;
          killWithGrace();
        }, this.timeoutMs);
        timer.unref?.();
      };
      bumpExecIdle(); // arma o 1º intervalo (silêncio inicial conta como inatividade)

      // EST-0982 — ABORT: o MESMO sinal do loop/root-flow MATA o processo na hora
      // (esc/Ctrl-C/interrupt). Não espera o timeout: o turno cessa limpo em < grace.
      const onAbort = signal
        ? (): void => {
            if (settled || killedByAbort) return;
            killedByAbort = true;
            killWithGrace();
          }
        : undefined;
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });

      // EST-0982 — STREAMING por LINHA: bufferiza o parcial e emite linhas completas
      // ao vivo (chunk BRUTO; a redação CLI-SEC-6 é da tool). Emitir por linha (e não
      // por byte) reduz o risco de um segredo ser partido entre chunks (a redação por
      // chunk é intra-linha). O resto não-terminado em `\n` é flushado no `close`.
      const makeLineEmitter = (
        stream: ShellChunk['stream'],
      ): { feed: (text: string) => void; flush: () => void } => {
        let pending = '';
        return {
          feed: (text: string): void => {
            if (!onChunk) return;
            pending += text;
            let nl = pending.indexOf('\n');
            while (nl !== -1) {
              const line = pending.slice(0, nl + 1);
              pending = pending.slice(nl + 1);
              onChunk({ stream, text: line });
              nl = pending.indexOf('\n');
            }
            // ANTI-OOM (hunt "recurso sem teto"): uma "linha" sem `\n` faz `pending`
            // crescer sem limite (o while acima nunca dispara). Quando o parcial cruza
            // o teto, flusha o pedaço como chunk e zera — honesto (nada some) e bounded.
            while (pending.length >= MAX_LINE_BYTES) {
              onChunk({ stream, text: pending.slice(0, MAX_LINE_BYTES) });
              pending = pending.slice(MAX_LINE_BYTES);
            }
          },
          flush: (): void => {
            if (onChunk && pending.length > 0) {
              onChunk({ stream, text: pending });
              pending = '';
            }
          },
        };
      };
      const outEmitter = makeLineEmitter('stdout');
      const errEmitter = makeLineEmitter('stderr');

      // EST-0944 — decode UTF-8 STATEFUL por stream: um caractere multibyte (acento,
      // emoji, box-drawing) pode ser PARTIDO entre dois reads do pipe (o read do
      // kernel corta em ~64KiB, sem respeitar fronteira de caractere). `Buffer.toString`
      // por chunk decodifica cada pedaço ISOLADO ⇒ o byte-tail incompleto vira `�`
      // (U+FFFD) e o caractere é CORROMPIDO na saída E no streaming. O `StringDecoder`
      // SEGURA o tail incompleto entre `write()`s e só o emite quando completa — o
      // `end()` no close/error flusha qualquer resto. Cobre `cat` de fonte UTF-8, JSON
      // com acentos, logs com glifos — qualquer saída > 64KiB com multibyte.
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');

      child.stdout?.on('data', (chunk: Buffer) => {
        bumpExecIdle(); // EST-0969 — saída = SINAL DE VIDA: zera o heartbeat de inatividade.
        const text = outDecoder.write(chunk);
        if (text.length === 0) return;
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        outEmitter.feed(text);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        bumpExecIdle(); // EST-0969 — saída = SINAL DE VIDA: zera o heartbeat de inatividade.
        const text = errDecoder.write(chunk);
        if (text.length === 0) return;
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += text;
        errEmitter.feed(text);
      });

      // EST-0944 — flush do tail retido no decoder (caractere incompleto no fim do
      // stream): vira `�` SÓ se for de fato truncado (saída binária cortada), nunca
      // por fronteira de chunk. Alimenta o buffer e o emitter de linha antes do flush.
      const flushDecoders = (): void => {
        const outTail = outDecoder.end();
        if (outTail.length > 0) {
          if (stdout.length < MAX_OUTPUT_BYTES) stdout += outTail;
          outEmitter.feed(outTail);
        }
        const errTail = errDecoder.end();
        if (errTail.length > 0) {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += errTail;
          errEmitter.feed(errTail);
        }
      };

      child.on('error', (err: Error) => {
        flushDecoders();
        outEmitter.flush();
        errEmitter.flush();
        finish({
          stdout: clipBytes(stdout),
          stderr: `${stderr}\n[erro ao executar: ${err.message}]`.trim(),
          exitCode: 127,
        });
      });

      // Finaliza o exec com a saída coletada. Chamado pelo `close` (caminho normal,
      // EOF de stdio) E pelo drain do `exit` (BUG-0027 — quando o `close` não vem
      // porque um neto destacado segura o stdout). Idempotente via `finish` (settled).
      const finalize = (code: number | null, sig: NodeJS.Signals | null): void => {
        // EST-0944 — flush do tail multibyte retido ANTES do flush de linha (a última
        // linha sem `\n` precisa do caractere completo).
        flushDecoders();
        // Flush do parcial não-terminado em `\n` (última linha sem quebra).
        outEmitter.flush();
        errEmitter.flush();
        // EST-0982 — ABORT vence o timeout na atribuição do motivo (o usuário pediu
        // a parada explicitamente): reporta encerramento limpo, exitCode 130 (SIGINT),
        // e `aborted` p/ a tool dizer ao modelo "parado pelo usuário" (não erro).
        if (killedByAbort) {
          finish({
            stdout: clipBytes(stdout),
            stderr: clipBytes(stderr),
            exitCode: 130, // convenção de interrupção por SIGINT (Ctrl-C)
            aborted: true,
          });
          return;
        }
        if (killedByTimeout) {
          finish({
            stdout: clipBytes(stdout),
            stderr:
              `${stderr}\n[comando interrompido: sem saída por ${this.timeoutMs}ms (provável hung — anti-hang, CLI-SEC)]`.trim(),
            exitCode: 124, // convenção de timeout (igual ao coreutils `timeout`)
          });
          return;
        }
        finish({
          stdout: clipBytes(stdout),
          stderr: clipBytes(stderr),
          // Comando morto por sinal (não-timeout) reporta exitCode não-zero.
          exitCode: code ?? (sig ? 128 : 1),
        });
      };

      // Caminho NORMAL: o processo saiu E o stdio deu EOF — flush limpo e finaliza.
      child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
        finalize(code, sig);
      });

      // BUG-0027 — o PROCESSO terminou (independe do stdio). Se um neto DESTACADO
      // herdou o stdout (ex.: `start <GUI>` / daemon em background), o pipe nunca dá
      // EOF e o `close` NUNCA dispara ⇒ o exec penduraria pra sempre e o abort/timeout
      // ficariam inócuos. Aqui damos um drain curto p/ o `close` normal chegar; se não
      // vier, DESTRUÍMOS os pipes (paramos de ler o write-end preso pelo neto) e
      // finalizamos com o que já temos. No caminho normal o `close` vence e cancela
      // este timer (via `finish`) ⇒ zero mudança de comportamento.
      child.on('exit', (code: number | null, sig: NodeJS.Signals | null) => {
        if (settled || exitDrainTimer) return;
        exited = { code, sig };
        exitDrainTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finalize(exited?.code ?? code, exited?.sig ?? sig);
        }, EXIT_DRAIN_MS);
        exitDrainTimer.unref?.();
      });
    });
  }
}

function clipBytes(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}\n[saída truncada: limite de ${MAX_OUTPUT_BYTES} bytes]`;
}
