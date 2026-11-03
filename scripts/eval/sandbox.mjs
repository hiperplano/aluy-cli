// Eval comportamental — confinamento com bubblewrap (bwrap).
//
// O `--yolo` do aluy derruba a cerca de workspace (packages/cli-core/src/permission/
// panel.ts), então o harness só o usa DENTRO deste sandbox: o disco inteiro é montado
// somente-leitura e apenas o diretório temporário do cenário é gravável. O `~/.aluy`
// real nunca é gravável: ele é coberto por um tmpfs descartável e só os arquivos de
// LEITURA necessários (config/credenciais/mcp) são montados por cima, read-only.
// Rede fica liberada (o provider precisa dela). Credenciais nunca são lidas/impressas.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BWRAP = '/usr/bin/bwrap';
/** Arquivos de ~/.aluy que o aluy só precisa LER (auth/provider). */
export const ALUY_READ_ONLY = ['config.json', 'credentials.enc', 'mcp.json'];

export function bwrapDisponivel() {
  return process.platform === 'linux' && existsSync(BWRAP);
}

/**
 * Prefixo do comando: `bwrap <flags> --chdir <workDir> --`. `workDir` é o ÚNICO
 * caminho gravável (além do tmpfs /tmp e do tmpfs ~/.aluy, ambos descartáveis).
 */
export function bwrapArgs(workDir, { home = homedir(), existe = existsSync } = {}) {
  const aluyHome = join(home, '.aluy');
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  // ~/.aluy descartável + só leitura do que a autenticação precisa.
  a.push('--tmpfs', aluyHome);
  for (const f of ALUY_READ_ONLY) {
    const p = join(aluyHome, f);
    if (existe(p)) a.push('--ro-bind', p, p);
  }
  // Único ponto gravável de verdade (montado DEPOIS do tmpfs /tmp, pode morar sob ele).
  a.push('--bind', workDir, workDir);
  a.push('--die-with-parent', '--new-session', '--chdir', workDir, '--');
  return a;
}

/** Comando completo [bin, ...args] para rodar `cmd` (array) confinado em `workDir`. */
export function confinar(workDir, cmd, opts) {
  return [BWRAP, ...bwrapArgs(workDir, opts), ...cmd];
}
