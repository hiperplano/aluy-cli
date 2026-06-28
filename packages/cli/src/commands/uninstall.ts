// `aluy uninstall` — remove os COMPLEMENTOS (sidecars) do aluy. Simétrico ao `bootstrap`:
//   - DETERMINÍSTICO: apaga os dirs gerenciados em `~/.aluy/` (ollama local, mem-venv, hr-venv);
//   - `--agent`: usa o PRÓPRIO agente (⚠ --yolo) p/ remover o que está FORA do ~/.aluy — o
//     Ollama instalado no SISTEMA via curl/winget (serviço + binário, com sudo) — adaptativo
//     à distro, como o install. Sem `--agent`, o de sistema é só apontado (não tocamos sudo
//     sem o usuário pedir).
//
// NÃO remove o CLI em si (isso é `npm uninstall -g @hiperplano/aluy-cli`) nem a config do
// usuário (`~/.aluy/config.json`, credenciais no keychain) — só os complementos pesados.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  OLLAMA_INSTALL_DIR,
  MEM0_VENV_DIR,
  HEADROOM_VENV_DIR,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';

export interface UninstallOptions {
  /** `--agent`: o aluy remove TAMBÉM o ollama de sistema via o próprio agente (⚠ --yolo + sudo). */
  readonly agent?: boolean;
}

export interface UninstallDeps {
  readonly io?: TerminalIO;
  /** Raiz do `~/.aluy/` (teste: tmpdir). */
  readonly baseDir?: string;
  /** Remoção injetável (teste). Default: `rmSync` recursivo/forçado. */
  readonly remove?: (path: string) => void;
  /** Checagem de existência injetável (teste). Default: `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/** Os complementos GERENCIADOS pelo aluy em `~/.aluy/` (removíveis sem sudo). */
function managedDirs(base: string): readonly { readonly label: string; readonly path: string }[] {
  return [
    { label: 'ollama (instalação local em ~/.aluy)', path: join(base, OLLAMA_INSTALL_DIR) },
    { label: 'mem0 (venv)', path: join(base, MEM0_VENV_DIR) },
    { label: 'headroom (venv)', path: join(base, HEADROOM_VENV_DIR) },
  ];
}

/** Executa `aluy uninstall`. Idempotente (remover o que não existe não é erro). Retorna 0. */
export function runUninstall(opts: UninstallOptions = {}, deps: UninstallDeps = {}): number {
  const io = deps.io ?? realTerminalIO();
  const base = deps.baseDir ?? join(homedir(), '.aluy');
  const remove = deps.remove ?? ((p) => rmSync(p, { recursive: true, force: true }));
  const exists = deps.exists ?? existsSync;

  io.out('Removendo os complementos gerenciados pelo aluy (em ~/.aluy/)…');
  for (const d of managedDirs(base)) {
    if (!exists(d.path)) {
      io.out(`  · ${d.label}: não estava instalado`);
      continue;
    }
    try {
      remove(d.path);
      io.out(`  ✓ ${d.label}: removido`);
    } catch {
      io.err(`  ✗ ${d.label}: falha ao remover (${d.path})`);
    }
  }
  io.out('');

  if (opts.agent) {
    // O agente remove o que mora FORA do ~/.aluy — o Ollama de SISTEMA (serviço + binário),
    // adaptativo à distro, com sudo. Mesmo modelo de consentimento do install (--yolo).
    return uninstallSystemViaAgent(io);
  }

  io.out('Se o Ollama foi instalado no SISTEMA (via curl/winget), ele NÃO fica em ~/.aluy e');
  io.out('continua instalado. Para removê-lo também: `aluy uninstall --agent` (o aluy remove');
  io.out('via o próprio agente — ⚠ acesso total + sudo). O CLI em si sai com `npm uninstall -g');
  io.out('@hiperplano/aluy-cli`; sua config (~/.aluy/config.json) e credenciais NÃO são tocadas.');
  return 0;
}

/** Goal do agente p/ remover o ollama de sistema (fora do ~/.aluy). */
function systemUninstallGoal(): string {
  return (
    'DESINSTALE o Ollama instalado no SISTEMA (fora de ~/.aluy), detectando o SO. ' +
    'No Linux: pare/desabilite o serviço (`sudo systemctl stop ollama; sudo systemctl disable ollama` ' +
    'se existir), remova o binário (`sudo rm -f /usr/local/bin/ollama` ou onde estiver no PATH) e o ' +
    'usuário/serviço se o install oficial criou. No macOS: encerre o app/serviço e remova-o. No Windows: ' +
    '`winget uninstall --id Ollama.Ollama`. Pacotes de sistema exigem privilégio: tente `sudo -n true`; ' +
    'se pedir senha, PEÇA ao usuário. Opcional: remova os modelos baixados (`~/.ollama/models`). ' +
    'Confirme que `ollama` não responde mais em http://127.0.0.1:11434/api/tags. Seja conciso.'
  );
}

/** Roda o agente embutido p/ a desinstalação de sistema. Retorna 0 (best-effort). */
function uninstallSystemViaAgent(io: TerminalIO): number {
  const aluyScript = process.argv[1];
  if (!aluyScript) {
    io.err('não foi possível localizar o binário do aluy p/ delegar ao agente.');
    return 0;
  }
  io.out('  ── Removendo o Ollama de sistema com o próprio aluy ── (acompanhe abaixo)');
  io.out('');
  spawnSync(process.execPath, [aluyScript, '-p', systemUninstallGoal(), '--yolo', '--no-self-check'], {
    stdio: 'inherit',
    timeout: 600_000,
    env: { ...process.env, ALUY_NO_WEAK_YOLO_WARN: '1', ALUY_PRINT_VERBOSE: '1' },
  });
  return 0;
}
