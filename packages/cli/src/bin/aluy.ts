#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { totalmem } from 'node:os';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { aluyHomeDir } from '../sandbox/aluy-home.js';
import { triggerBoot } from '../maestro/boot-trigger.js';
import { parseArgs } from '../cli.js';
import {
  decideYoloEntry,
  yoloAuditEvent,
  type SessionMode,
  type YoloEntryVerdict,
} from '@aluy/cli-core';
import { applyHeapLimit } from './heap-limit.js';

// EST-1012 — HEAP-LIMIT EXPLÍCITO (backstop de OOM). Re-executa ESTE binário UMA vez
// com `--max-old-space-size` no NODE_OPTIONS (se faltava), p/ o V8 lançar erro de heap
// LEGÍVEL antes do "Killed" cego do kernel. Usa `spawn` ASSÍNCRONO (NÃO spawnSync) p/
// poder REPASSAR sinais ao filho: a TUI interativa precisa receber o Ctrl-C/SIGINT p/
// RESTAURAR o terminal (alt-screen `?1049l`, cursor) e sair limpo — com spawnSync o pai
// ficaria bloqueado e o sinal mandado ao PID do pai nunca chegaria ao filho. Herda o
// stdio (mesmo terminal) e propaga o exit-code. Devolve `true` se re-exec-ou (o caller
// encerra; o filho assumiu) — `false` se nada a fazer / spawn falhou (segue sem teto,
// gracioso). I/O fino: a decisão pura/idempotente vive em `applyHeapLimit`.
async function ensureHeapLimit(): Promise<boolean> {
  const { reexeced } = await applyHeapLimit({
    env: process.env,
    execPath: process.execPath,
    argv: process.argv,
    // `execArgv` = as opções de NODE (ex.: `--require x`, `--enable-source-maps`)
    // passadas ANTES do script. Preservamos no re-exec p/ não perder o ambiente do
    // operador/harness (ex.: um preload de teste). PRECEDEM o script no spawn.
    execArgv: process.execArgv,
    // RAM total da máquina ⇒ heap-limit ADAPTATIVO (fração da RAM, não 4 GiB fixo —
    // que matava sessões pesadas num host de 32 GiB com 28 GiB livres).
    totalMemMb: totalmem() / (1024 * 1024),
    reexec: (execPath, args, env) =>
      new Promise<number | undefined>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(execPath, [...args], { stdio: 'inherit', env });
        } catch {
          resolve(undefined); // spawn falhou ⇒ caller segue sem teto (fail-open).
          return;
        }
        // REPASSA os sinais de término ao filho (que tem a TUI/terminal): assim o
        // Ctrl-C/SIGINT/SIGTERM mandado ao PAI restaura+encerra o FILHO limpo. Soltos
        // ao final (sem listener vazado entre processos).
        const forward = (sig: NodeJS.Signals) => (): void => {
          try {
            child.kill(sig);
          } catch {
            /* o filho já saiu */
          }
        };
        const onInt = forward('SIGINT');
        const onTerm = forward('SIGTERM');
        process.on('SIGINT', onInt);
        process.on('SIGTERM', onTerm);
        const cleanup = (): void => {
          process.off('SIGINT', onInt);
          process.off('SIGTERM', onTerm);
        };
        child.on('error', () => {
          cleanup();
          resolve(undefined); // erro pós-spawn ⇒ fail-open (segue sem teto).
        });
        child.on('close', (code, signal) => {
          cleanup();
          // Propaga o código do filho (ou o sinal → 128+n, convenção shell).
          resolve(code ?? (signal !== null ? 128 : 0));
        });
      }),
    // ENCERRA o pai com o código do filho (que já assumiu a sessão + restaurou o
    // terminal). `process.exit` garante que o pai não siga p/ montar nada.
    exit: (code) => process.exit(code),
  });
  return reexeced;
}

// EST-0991 · EST-1007 · ADR-0072 · AG-0008 — GUARDA DE ENTRADA do YOLO no binário
// (locus de I/O). Coleta o CONTEXTO real (TTY, root/uid) e aplica `decideYoloEntry`
// (puro, no core). Pós AG-0008 (alinhamento ao Claude Code, decisão do Tiago — relax
// de gate, sinalizado ao `seguranca`):
//   · ROOT ⇒ RECUSA DURA (exit≠0, SEM fallback): YOLO + root destrói a máquina com uma
//     injeção. É o ÚNICO bloqueio que sobra (igual `claude` que bloqueia root).
//   · HEADLESS não-root ⇒ ENTRA DIRETO em YOLO (a flag `--yolo` JÁ é o consentimento
//     deliberado, como `claude -p --dangerously-skip-permissions`). Não exige mais o
//     env `ALUY_YOLO_HEADLESS` (derrubado). Emite só o BANNER de aviso (não bloqueia).
//   · TTY não-root ⇒ entra, mas a TUI pede a confirmação one-shot (banner + prompt).
// O evento (entrada/recusa, flag de modo `yolo`) é auditado p/ forense (CLI-SEC-10).
// `fatal:true` no retorno ⇒ o caller ABORTA (não monta sessão; exit≠0) — só no root.
// PURO (sem I/O): computa o veredito de entrada do YOLO. Os EFEITOS (auditoria + banner)
// ficam FORA — emitidos UMA vez no processo FINAL pelo `main` (ver `auditYoloEntry` + o
// bloco pós-`ensureHeapLimit`). Antes os efeitos moravam AQUI, mas `resolveYoloEntry` roda
// ANTES do `ensureHeapLimit` (que RE-EXECUTA o processo p/ o heap-limit) ⇒ o FILHO re-exec
// rodava `resolveYoloEntry` de novo ⇒ banner 2× E auditoria 2× (só no interativo non-print).
function resolveYoloEntry(mode: SessionMode): {
  mode: SessionMode;
  verdict?: YoloEntryVerdict;
  fatal?: boolean;
} {
  if (mode !== 'unsafe') return { mode };
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // geteuid não existe em Windows ⇒ root=false lá (sem conceito de uid 0).
  const root = typeof process.geteuid === 'function' && process.geteuid() === 0;
  const verdict = decideYoloEntry({ tty, root });
  return { mode, verdict, fatal: verdict.outcome === 'refuse' };
}

/**
 * Auditoria (CLI-SEC-10) — apenda o evento de YOLO num log forense LOCAL (`~/.aluy/
 * audit.jsonl`, 0600), NÃO no stderr (JSON cru poluiria o boot). Best-effort: nunca derruba
 * o boot. Chamada UMA vez no processo FINAL (pós-re-exec) p/ não duplicar a trilha.
 */
function auditYoloEntry(verdict: YoloEntryVerdict): void {
  try {
    const dir = aluyHomeDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'audit.jsonl'),
      `${JSON.stringify(yoloAuditEvent(verdict, Date.now()))}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* auditoria nunca derruba a sessão */
  }
}

// EST-1007 — lê o STDIN inteiro (até EOF) como o prompt do modo headless (`echo x |
// aluy -p`). Só chamado quando `-p`/`--print`/`--exec` veio SEM valor inline nem
// objetivo posicional (a 3ª forma do Claude Code). Se o stdin é um TTY (sem pipe), NÃO
// bloqueia esperando digitação — devolve vazio (o caller emite o erro de uso). I/O puro,
// fora do parser (que é puro/testável).
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return ''; // sem pipe ⇒ nada a ler (não pendura).
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve) => {
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    process.stdin.on('error', () => resolve(''));
  });
}

// Auto-detecção e activação de capacidades do terminal no arranque.
// Corre antes de qualquer I/O: normaliza COLORTERM/TERM para que o Ink e o
// chalk recebam as pistas certas independentemente do terminal usado.
// Só afecta `process.env` do processo actual (e filhos via spawn inherit) —
// não escreve nada permanente. Seguro correr em qualquer plataforma.
function activateTerminalCapabilities(): void {
  const env = process.env;
  const stdout = process.stdout;

  // Já configurado pelo utilizador — não sobrepor.
  if (env.NO_COLOR !== undefined) return;

  // TERM: garante um valor decente quando não está definido ou é muito básico.
  if (!env.TERM || env.TERM === 'dumb' || env.TERM === 'cygwin') {
    env.TERM = 'xterm-256color';
  }

  // COLORTERM: anuncia truecolor quando o Node.js detecta que o terminal suporta.
  // getColorDepth() devolve 24 para 16M cores (truecolor), 8 para 256, 4 para 16.
  if (!env.COLORTERM) {
    let depth = 1;
    try {
      depth = typeof stdout.getColorDepth === 'function' ? stdout.getColorDepth() : 1;
    } catch {
      /* terminal sem suporte à query — mantém 1 */
    }
    if (depth >= 24) {
      env.COLORTERM = 'truecolor';
    } else if (depth >= 8) {
      env.COLORTERM = '256color';
    }
  }

  // Cmder/ConEmu: anuncia truecolor explicitamente — o ConEmu suporta 24-bit mas
  // raramente anuncia COLORTERM, então o chalk/Ink cai para 16 cores por engano.
  if (!env.COLORTERM && (env.CONEMUDIR !== undefined || env.ConEmuANSI === 'ON')) {
    env.COLORTERM = 'truecolor';
    if (!env.TERM || env.TERM === 'cygwin') env.TERM = 'xterm-256color';
  }
}

// Binário `aluy` (EST-0941 esqueleto → EST-0948 TUI rica). Faz APENAS o I/O:
// delega a decisão ao parser puro. --version/--help curto-circuitam ANTES de
// qualquer render Ink (rápido/determinístico, sem TTY). A invocação interativa
// default (ou com objetivo, `aluy "obj"`) monta a sessão e renderiza a TUI
// (session/run.tsx) — carregada dinamicamente para não puxar Ink no caminho de
// --version/--help (CI/smoke headless).
async function main(): Promise<void> {
  activateTerminalCapabilities();

  // BUG-WIN · ÚLTIMO RECURSO: restaura o terminal quando o processo PAI sai após o
  // filho (re-exec via ensureHeapLimit) ter crashado sem cleanup. O filho partilha
  // stdin/stdout com o pai via `stdio:inherit`; se crashar sem emitir ?1049l (sair do
  // alt-screen) ou sem chamar SetConsoleMode para sair do raw-mode, o terminal do
  // utilizador fica inutilizável. Este handler cobre o pai: roda no process.exit do
  // pai (após child.on('close')), garantindo o restore ANTES de devolver o controlo
  // à shell. É também a rede extra no próprio filho (ex.: process.exit() direto).
  //
  // Só TTY (não queremos emitir sequências de escape num pipe/headless).
  if (process.stdout.isTTY === true) {
    const terminalFinalRestore = (): void => {
      // 1) Sai do alt-screen, mostra o cursor, desliga bracketed-paste.
      //    Emitir estas sequências quando o terminal já está em estado normal é inócuo
      //    (os terminais ignoram ?1049l quando não estão em alt-screen, etc.).
      try {
        process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[?2004l');
      } catch {
        /* best-effort */
      }
      // 2) Reset do raw-mode do stdin.
      //    O libuv tem um guard interno: setRawMode(false) é no-op se UV_HANDLE_TTY_RAW
      //    não está marcado. O PAI nunca chama setRawMode(true), logo o flag nunca está
      //    marcado — setRawMode(false) sozinho não faz nada. A sequência true→false força
      //    o libuv a marcar o flag e depois restaurar o saved_console_mode (NORMAL).
      if (process.platform === 'win32' && process.stdin.isTTY === true) {
        try {
          const stdin = process.stdin as NodeJS.ReadStream;
          if (typeof stdin.setRawMode === 'function') {
            const onErr = (): void => {
              /* ignora erros de setRawMode no exit */
            };
            stdin.on('error', onErr);
            try {
              stdin.setRawMode(true); // força UV_HANDLE_TTY_RAW
              stdin.setRawMode(false); // SetConsoleMode(saved_normal_mode)
            } finally {
              stdin.off('error', onErr);
            }
          }
          stdin.pause();
        } catch {
          /* best-effort */
        }
      }
    };
    process.on('exit', terminalFinalRestore);
  }

  const action = parseArgs(process.argv.slice(2));

  switch (action.kind) {
    case 'version':
    case 'help':
      process.stdout.write(action.text + '\n');
      return;
    case 'usage-error':
      // EST-0962 — combinação inválida de flags (ex.: `--provider` sem `--model`):
      // mensagem no stderr + exit≠0, SEM montar a sessão (não puxa broker/MCP). "$?" confiável.
      process.stderr.write(action.message + '\n');
      process.exitCode = action.exitCode;
      return;
    case 'login': {
      // ADR-0120 — `--provider <p>` ⇒ login do BACKEND LOCAL (BYO: API key OU OAuth);
      // sem ele ⇒ login do BROKER (device-flow/PAT, comportamento de hoje).
      if (action.provider !== undefined) {
        const { runLocalLogin } = await import('../commands/local-login.js');
        process.exitCode = await runLocalLogin({
          provider: action.provider,
          ...(action.oauth ? { oauth: true } : {}),
          ...(action.token !== undefined ? { token: action.token } : {}),
        });
        return;
      }
      const { runLogin } = await import('../commands/login.js');
      process.exitCode = await runLogin({
        forceDeviceFlow: action.forceDeviceFlow,
        ...(action.token !== undefined ? { token: action.token } : {}),
        ...(action.org !== undefined ? { org: action.org } : {}),
      });
      return;
    }
    case 'logout': {
      const { runLogout } = await import('../commands/logout.js');
      process.exitCode = await runLogout();
      return;
    }
    case 'whoami': {
      const { runWhoami } = await import('../commands/whoami.js');
      process.exitCode = await runWhoami();
      return;
    }
    case 'doctor': {
      // EST-0970 — health-check read-only com validação ATIVA + ticks progressivos. Exit≠0
      // se houver ✗ (sinal honesto p/ CI/script). `--deep` testa o tier ao vivo (gasta modelo).
      // `--json` imprime o JSON dos checks no stdout (sem ticks).
      const { runDoctor } = await import('../commands/doctor.js');
      process.exitCode = await runDoctor({ deep: action.deep, json: action.json });
      return;
    }
    case 'agents': {
      // EST-0977 — lista os perfis de sub-agente .md mapeados (global + projeto/cwd),
      // válidos + rejeitados (RES-MD-3) com o motivo. Read-only, sem modelo, sem rede;
      // reusa os MESMOS loaders do boot. Exit 0 (é listagem, não gate).
      const { runAgents } = await import('../commands/agents.js');
      process.exitCode = runAgents();
      return;
    }
    case 'skills': {
      // EST-1112 · ADR-0116 — lista as SKILLS (SKILL.md) mapeadas (global + projeto/cwd),
      // válidas + rejeitadas (RES-MD-3) com o motivo. Read-only, sem modelo, sem rede;
      // reusa os MESMOS loaders confinados + o formatador puro do core. Exit 0 (listagem).
      const { runSkills } = await import('../commands/skills.js');
      process.exitCode = runSkills();
      return;
    }
    case 'workflows': {
      // EST-1105 — lista os fluxos de atividade .md mapeados (global + projeto/cwd),
      // válidos + rejeitados (RES-MD-3) com o motivo. Read-only, sem modelo, sem rede.
      // Espelha o `agents`. Exit 0 (listagem, não gate).
      const { runWorkflows } = await import('../commands/workflows.js');
      process.exitCode = runWorkflows();
      return;
    }
    case 'bootstrap': {
      // EST-1133 / ADR-0130 — provisionamento EXPLÍCITO de sidecars user-space.
      // Só sob perfil TURBO (default); LEVE sai sem provisionar.
      // Passo EXPLÍCITO (nunca download no boot — CA-G2-11).
      const { runInit } = await import('../commands/bootstrap.js');
      process.exitCode = await runInit({
        out: (l) => process.stdout.write(l + '\n'),
        err: (l) => process.stderr.write(l + '\n'),
        agent: action.agent,
      });
      // FORÇA a saída: o provisionamento pode deixar handles vivos (ex.: `ollama serve`
      // detached, watchers do agente) que impediriam o Node de encerrar — aí o instalador
      // travaria ANTES de abrir a sessão (`aluy onboard → aluy bootstrap → aluy`). Como o
      // bootstrap JÁ terminou aqui, sair é seguro e garante que o script siga pro `aluy`.
      process.exit(process.exitCode ?? 0);
    }
    case 'onboard': {
      // `aluy onboard` — onboarding interativo (Ink). Import dinâmico p/ não puxar Ink
      // no caminho headless (--version/--help). É a TUI do instalador (idioma/backend/
      // provider/chave/modelo/sidecars); o bootstrap mínimo o invoca reanexado ao TTY.
      const { runOnboard } = await import('../session/onboard.js');
      process.exitCode = await runOnboard();
      return;
    }
    case 'models': {
      // EST-1116 — lista providers/modelos disponíveis: seção LOCAL (BYO) + seção BROKER
      // (catálogo VIVO, FAIL-SOFT — broker fora ⇒ avisos, nunca quebra). `--json` p/ script;
      // `--backend local|broker` foca uma seção. Read-only, sem modelo. Exit 0 (listagem).
      const { runModels } = await import('../commands/models.js');
      process.exitCode = await runModels({
        scope: action.scope,
        json: action.json,
        view: action.which,
      });
      return;
    }
    case 'mcp-search': {
      // EST-0970 (search) — busca no REGISTRO OFICIAL ABERTO do MCP (egress FIXO, sem key).
      const { createRegistryFetch, runMcpSearch } = await import('../mcp/registry-search.js');
      const { text, exitCode } = await runMcpSearch(action.query, createRegistryFetch());
      process.stdout.write(text + '\n');
      process.exitCode = exitCode;
      return;
    }
    case 'mcp': {
      // EST-0970 — `aluy mcp add/list/remove`: gerencia servers MCP (escreve a config).
      const { runMcp } = await import('../commands/mcp.js');
      process.exitCode = await runMcp(action.argv);
      return;
    }
    case 'cron': {
      // EST-1150 · ADR-0128 — `aluy cron`: agendamento PERSISTENTE LOCAL.
      const { runCron } = await import('../commands/cron.js');
      process.exitCode = await runCron(action.argv);
      return;
    }
    case 'launch': {
      // TUI rica (EST-0948): monta a sessão (login+broker+loop+catraca+I/O
      // concreto confinado) e renderiza. Import dinâmico p/ não puxar Ink no
      // caminho de --version/--help (CI/smoke headless).
      const { runSession } = await import('../session/run.js');
      // F109 — flags `--xxx` NÃO reconhecidas (typo) eram SILENCIOSAMENTE ignoradas — um
      // `--plna` (quis `--plan`) rodava em modo NORMAL (escreve) em vez de read-only. Avisa
      // ALTO no stderr ANTES de montar a sessão (com "você quis dizer …?"), sem bloquear
      // (não quebra script com flag futura/experimental; o usuário vê e corrige o typo).
      if (action.unknownFlags && action.unknownFlags.length > 0) {
        const { suggestFlag } = await import('../cli.js');
        for (const f of action.unknownFlags) {
          const guess = suggestFlag(f.replace(/^--/, ''));
          process.stderr.write(
            `aluy: aviso: flag desconhecida ${f} — IGNORADA` +
              (guess ? ` (você quis dizer \`--${guess}\`?)` : ' (veja `aluy --help`)') +
              '\n',
          );
        }
      }
      // EST-0959 — a flag foi RENOMEADA `--unsafe` → `--yolo` (decisão de produto).
      // O alias antigo segue idêntico; só avisa curto no stderr (não quebra script).
      if (action.unsafeAliasUsed) {
        process.stderr.write(
          'aluy: aviso: `--unsafe` agora é `--yolo` (alias deprecado; comportamento idêntico)\n',
        );
      }
      // EST-0991 · EST-1007 · ADR-0072 · AG-0008 — guarda de entrada do YOLO ANTES de
      // montar a TUI/sessão: ROOT ⇒ aborta (exit≠0, sem sessão); headless não-root ⇒
      // entra direto (a flag é o consentimento) com banner; TTY ⇒ entra + confirma na TUI.
      const yolo = resolveYoloEntry(action.mode);
      if (yolo.fatal && yolo.verdict?.outcome === 'refuse') {
        // RECUSA DURA (root) NESTE processo, SEM re-exec (a guarda roda antes do heap-limit
        // de propósito). Audita o refuse + emite a mensagem fatal + aborta exit≠0. NÃO monta
        // broker/MCP/sessão. Como root sai aqui, NÃO há filho re-exec ⇒ audita UMA vez.
        auditYoloEntry(yolo.verdict);
        process.stderr.write(`${yolo.verdict.message}\n`);
        process.exitCode = 1;
        return;
      }

      // EST-1012 — ROBUSTEZ DE MEMÓRIA · HEAP-LIMIT EXPLÍCITO. APÓS a guarda de YOLO (p/
      // a recusa de root rodar NESTE processo, sem re-exec) e SÓ na sessão INTERATIVA
      // (TTY, não no `-p` headless one-shot, que sai rápido e nem liga o monitor). Re-exec
      // UMA vez com `--max-old-space-size` no NODE_OPTIONS p/ o V8 lançar erro de heap
      // LEGÍVEL (em vez do "Killed" cego do OOM do kernel). Idempotente (sentinela no env),
      // respeita um teto JÁ posto pelo operador, e FAIL-OPEN (spawn falho ⇒ segue sem teto).
      if (!action.print && (await ensureHeapLimit())) return; // re-exec: pai encerra; o filho assume.

      // EST-1129 — BOOT-SUPERVISOR: dispara sidecars em background.
      // Só sob perfil TURBO (default); LEVE ⇒ no-op. Assíncrono e fail-open:
      // um boot falho NUNCA trava a sessão (degrada ao piso heurístico).
      // Caminhos ABSOLUTOS dos binários (CA-G2-1).
      //
      // NÃO no headless `-p`: um one-shot (e o agente interno do `bootstrap --agent`)
      // termina e SAI — subir daemons que ele não vai usar só (a) gera ruído ("3/3
      // prontos") na saída do install e (b) deixa processos-filho que PENDURAM o `node`
      // ("trava no final"). A sessão INTERATIVA é que sobe os sidecars, ao abrir.
      if (!action.print) triggerBoot();

      // PROCESSO FINAL (pós-re-exec OU sem re-exec): emite o banner de aviso + audita o ALLOW
      // do YOLO UMA vez. Fica DEPOIS do `ensureHeapLimit` de propósito: se o pai vai re-exec,
      // ele já retornou acima e NÃO emite — só o filho (ou o processo sem re-exec) chega aqui,
      // matando o banner/auditoria DUPLICADOS (pai+filho). Em TTY o banner+pergunta vivem na
      // TUI (yoloEntryNotice abaixo, requiresConfirmation); aqui só o stderr do headless.
      if (yolo.verdict?.outcome === 'allow') {
        auditYoloEntry(yolo.verdict);
        if (!yolo.verdict.requiresConfirmation) {
          process.stderr.write(`${yolo.verdict.warning}\n`);
        }
      }

      // EST-1007 · EST-0962 · HG-2/CLI-SEC-7 — `--model <slug>`: resolve p/ tier:custom +
      // o SLUG (espelha o `/model` custom da TUI). `--model` VENCE `--tier`. O slug é DADO
      // (nome curado no catálogo do broker), NUNCA credencial — seguro logar/persistir. O
      // broker resolve slug→(provider,credencial). Sem `--model`, vale o `--tier` cru.
      const customModel = action.model;
      const effectiveTier =
        customModel !== undefined && customModel.trim() !== '' ? 'custom' : action.tier;

      // EST-1007 — MODO HEADLESS one-shot (`-p`/`--print`/`--exec`): resolve o prompt nas
      // 3 formas (igual Claude Code), precedência: valor inline (`-p "x"`) > objetivo
      // POSICIONAL > STDIN (`echo x | aluy -p`). O stdin (I/O) mora aqui, fora do parser.
      let headlessGoal: string | undefined = action.goal;
      if (action.print) {
        const fromFlag = action.printArg?.trim();
        const fromPositional = action.goal?.trim();
        headlessGoal =
          fromFlag !== undefined && fromFlag !== ''
            ? fromFlag
            : fromPositional !== undefined && fromPositional !== ''
              ? fromPositional
              : (await readStdin()) || undefined;
        // EST-1007 — prompt VAZIO (arg/posicional/stdin todos vazios): erro de uso e exit≠0
        // SEM montar a sessão (não puxa broker/MCP — que penduraria o processo com os
        // child-servers MCP). É o "$? confiável" do script sem efeito colateral.
        if (headlessGoal === undefined || headlessGoal.trim() === '') {
          process.stderr.write('aluy: -p sem prompt — passe via arg, posicional ou stdin.\n');
          process.exitCode = 2;
          return;
        }
      }

      await runSession({
        // EST-0959 · ADR-0055 — o eixo de MODO (`--plan`/`--yolo`); `mode` vence
        // o legado `unsafe`. Sem flag ⇒ `normal`. EST-0991: pode cair de `unsafe` p/
        // `normal` se a guarda de YOLO recusar o ambiente (headless/root).
        mode: yolo.mode,
        // EST-0991 — aviso de entrada do YOLO (banner/confirmação one-shot) p/ a TUI
        // exibir no boot quando entrou de fato em YOLO num TTY (ADR-0072 §3b).
        ...(yolo.verdict?.outcome === 'allow' && yolo.verdict.requiresConfirmation
          ? { yoloEntryNotice: yolo.verdict.notice }
          : {}),
        dense: action.dense,
        // EST-0984 — `--ascii` ⇒ perfil SEGURO de glifos (cobertura ampla).
        safeGlyphs: action.safeGlyphs,
        // EST-0990 — `--split` (alias `--view`) ⇒ MODO VIEW AVANÇADO ligado na largada
        // (precedência flag > ui.splitView > OFF). Só repassa quando a flag veio.
        ...(action.split !== undefined ? { split: action.split } : {}),
        // EST-1000 · ADR-0076 §1 — `--fullscreen` (alias `--cockpit`) ⇒ MODO COCKPIT na
        // largada (precedência flag > ui.fullscreen > INLINE). Só repassa quando a flag veio.
        ...(action.fullscreen !== undefined ? { fullscreen: action.fullscreen } : {}),
        // EST-1112 · ADR-0119 — `--budget` LIGA o orçamento local, `--no-budget`
        // DESLIGA. Só repassa quando a flag veio (ausente ⇒ cai p/ env > config > default).
        ...(action.budget !== undefined ? { budget: action.budget } : {}),
        // EST-0969 · ADR-0057 — sub-agentes locais paralelos (default ligado; opt-out
        // por `--no-subagents`). Repassado a buildSession via run.tsx (forma objeto).
        subAgents: { enabled: action.subAgents },
        // EST-1007 — no headless o objetivo é o prompt resolvido (arg/posicional/stdin);
        // fora do headless é o objetivo posicional cru (`aluy "obj"`).
        ...(headlessGoal !== undefined ? { goal: headlessGoal } : {}),
        // EST-0962 — tier inicial (`--tier`); EST-1007: `--model` força `custom` (vence).
        ...(effectiveTier !== undefined ? { tier: effectiveTier } : {}),
        // ADR-0120 / EST-1113 — `--backend <broker|local>`: backend de modelo (BYO).
        // Cru; o run.tsx resolve flag>env>config>default broker e, sob `local`, monta o
        // LocalModelClient (provider direto + credencial BYO). Sem a flag ⇒ não sai (cai
        // em env/config/default). NÃO é credencial — é roteamento (CLI-SEC-7).
        ...(action.backend !== undefined ? { backend: action.backend } : {}),
        // ADR-0120 / EST-1113 — config do provider do backend local (só sob backend:local).
        ...(action.localProvider !== undefined ? { localProvider: action.localProvider } : {}),
        ...(action.localModel !== undefined ? { localModel: action.localModel } : {}),
        ...(action.localAuth !== undefined ? { localAuth: action.localAuth } : {}),
        ...(action.localBaseUrl !== undefined ? { localBaseUrl: action.localBaseUrl } : {}),
        // EST-1007 · HG-2 — slug Custom do `--model` (só sob tier:custom; só o SLUG sai
        // do cliente — nunca credencial). undefined ⇒ sem slug (tier canônico).
        ...(customModel !== undefined && customModel.trim() !== ''
          ? { model: customModel.trim() }
          : {}),
        // EST-0962 (`--provider`) — NOME do provider em PAR com `--model` (o parser já
        // garantiu que `--provider` não vem sozinho). Só sob Custom + com `model` (o
        // run.tsx/caller re-travam). Só o NOME (DADO, não credencial — HG-2/CLI-SEC-7);
        // o broker resolve (provider,model)→credencial server-side. Sem a flag ⇒ não sai.
        ...(action.provider !== undefined &&
        action.provider.trim() !== '' &&
        customModel !== undefined &&
        customModel.trim() !== ''
          ? { provider: action.provider.trim() }
          : {}),
        // EST-1007 — MODO HEADLESS (`-p`): força o caminho não-TTY + impressão LIMPA do
        // resultado final, e liga o exit code do binário (0=ok, ≠0=erro) p/ script.
        ...(action.print
          ? {
              headless: {
                print: true as const,
                ...(action.outputFormat !== undefined ? { outputFormat: action.outputFormat } : {}),
                ...(action.quiet !== undefined ? { quiet: action.quiet } : {}),
                ...(action.cycle !== undefined ? { cycle: action.cycle } : {}),
                // EST-1019 (APR-0086 §A1.1) — teto do CICLO via flags de boot dedicadas
                // (`--cycles`/`--cycle-for`); o run.tsx resolve/valida e a flag VENCE o
                // teto embutido no goal. Distintas de `--max-iterations` (teto do LOOP).
                ...(action.cycles !== undefined ? { cycles: action.cycles } : {}),
                ...(action.cycleFor !== undefined ? { cycleFor: action.cycleFor } : {}),
              },
              onExitCode: (code: number) => {
                process.exitCode = code;
              },
            }
          : {}),
        // EST-0989 (i18n) — idioma da TUI (`--lang pt-BR|en`); o wiring resolve
        // flag>config>auto-detect>pt-BR. Sem a flag, cai na pref salva / auto-detect.
        ...(action.lang !== undefined ? { lang: action.lang } : {}),
        // EST-0972 — retomada de sessão (`--continue`/`--resume [<id>]`).
        ...(action.resume !== undefined ? { resume: action.resume } : {}),
        // EST-0972 (BUG 2) — `--new`: ignora a auto-oferta de retomar a sessão do cwd.
        fresh: action.fresh,
        // EST-0948 — teto de tokens da sessão (`--max-tokens N`); o wiring resolve
        // flag>env>default e clampa. Sem a flag, cai no env/default.
        ...(action.maxTokens !== undefined ? { maxTokens: action.maxTokens } : {}),
        // EST-0948 — teto de iterações do loop (`--max-iterations N`); o wiring resolve
        // flag>env>default e clampa. Sem a flag, cai no env/default.
        ...(action.maxIterations !== undefined ? { maxIterations: action.maxIterations } : {}),
        // EST-0948 — max_tokens de OUTPUT por chamada (`--max-output-tokens N`); o wiring
        // resolve flag>env>UNSET e clampa. Sem a flag, cai no env/UNSET (broker decide).
        // DISTINTO do budget local `--max-tokens`.
        ...(action.maxOutputTokens !== undefined
          ? { maxOutputTokens: action.maxOutputTokens }
          : {}),
        // EST-0944 — SELF-CHECK de atenção (`--self-check`/`--no-self-check`); o wiring
        // resolve flag>env>tier-fraco. Sem a flag, cai no env/tier (a flag vence o tier).
        ...(action.selfCheck !== undefined ? { selfCheck: action.selfCheck } : {}),
        // EST-0973 — AUTO-COMPACTAÇÃO da janela (`--autocompact-at`); o controller
        // resolve flag>env(ALUY_AUTOCOMPACT_AT)>default 0.85. Sem a flag, cai no env/default.
        ...(action.autoCompactAt !== undefined ? { autoCompactAt: action.autoCompactAt } : {}),
        // EST-0948 — avisos de config (ex.: max-output-tokens inválido/clampado) vão p/ o
        // stderr, sem quebrar a sessão.
        onConfigWarn: (msg: string) => process.stderr.write(`${msg}\n`),
      });
      // HEADLESS one-shot (`-p`): FORÇA a saída. Servidores MCP, daemons de sidecar ou
      // processos que o AGENTE spawnou podem deixar handles vivos e PENDURAR o `node` —
      // num one-shot de script (e no agente interno do `bootstrap --agent`) isso vira
      // "trava no final". O turno já terminou aqui ⇒ sair é seguro. A sessão INTERATIVA
      // (TTY) NÃO força: precisa do teardown limpo do Ink/alt-screen.
      if (action.print) process.exit(process.exitCode ?? 0);
      return;
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`aluy: erro fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
