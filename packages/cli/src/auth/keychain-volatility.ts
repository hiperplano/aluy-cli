// F165 — detecção do cofre VOLÁTIL do Linux (keyring do KERNEL via keyutils).
//
// Numa máquina Linux SEM Secret Service (gnome-keyring/kwallet — caso típico:
// servidor/VPS headless), o `@napi-rs/keyring` cai no backend `linux-keyutils`:
// a credencial é gravada no KEYRING DO KERNEL — memória, não disco. Consequência
// que o dono viveu na pele (F165): a chave "some sozinha" — em TODO reboot (e o
// persistent-keyring do kernel ainda expira com ~3 dias sem uso) — e o usuário
// precisa refazer o onboard sem entender o porquê.
//
// A gravação nesse cofre volátil acontecia EM SILÊNCIO. Isto aqui não muda o
// armazenamento (CLI-SEC-2 intacto: NUNCA arquivo em claro por fallback) — só
// torna a volatilidade VISÍVEL no momento certo (pós-gravação no login/onboard),
// com o caminho de correção: instalar o Secret Service OU exportar a env var.
//
// DETECÇÃO: quando o backend keyutils é usado, a entrada aparece em `/proc/keys`
// como `keyring:<conta>@<serviço>` (tipo `user`). Se, logo após um write, o
// serviço aparece lá, o cofre é o do kernel ⇒ volátil. Com Secret Service ativo,
// o write vai ao daemon (D-Bus) e NADA aparece em `/proc/keys`. Leitura
// best-effort: qualquer erro ⇒ `false` (não assusta o usuário sem evidência).

import { readFileSync } from 'node:fs';

export interface VolatileKeychainProbeOptions {
  /** Serviço do keychain a procurar (ex.: `aluy-cli-local`). */
  readonly service: string;
  /** Plataforma (injetável em teste). Default: `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Leitor de `/proc/keys` (injetável em teste). Default: fs real. */
  readonly readProcKeys?: () => string;
}

/**
 * `true` quando as credenciais do `service` estão no KEYRING DO KERNEL (volátil).
 * Chamar LOGO APÓS um write bem-sucedido (a entrada recém-gravada é a evidência).
 * Fora do Linux ⇒ sempre `false` (macOS/Windows têm cofre persistente do SO).
 */
export function keychainIsVolatile(opts: VolatileKeychainProbeOptions): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') return false;
  try {
    const read = opts.readProcKeys ?? ((): string => readFileSync('/proc/keys', 'utf8'));
    return read().includes(`@${opts.service}`);
  } catch {
    return false; // sem evidência ⇒ não alarma (best-effort).
  }
}

/**
 * Linhas do AVISO honesto pós-gravação (login/onboard). O chamador imprime no
 * canal de UI dele (io.err/nota). NUNCA cita a credencial.
 */
export function volatileKeychainWarning(envVarName: string): readonly string[] {
  return [
    '⚠ ATENÇÃO: esta máquina não tem um cofre persistente (Secret Service) — a chave',
    '  foi guardada no keyring do KERNEL, que é MEMÓRIA: ela NÃO sobrevive a um reboot',
    '  (e expira após alguns dias sem uso). Quando isso acontecer, o login "some".',
    '  Para persistir de verdade, escolha um dos caminhos:',
    '    · instale/ative o Secret Service (ex.: `apt install gnome-keyring`) e rode o login de novo; ou',
    `    · exporte \`${envVarName}=…\` no ambiente (ex.: no ~/.bashrc) — o aluy usa a env como fallback.`,
  ];
}
