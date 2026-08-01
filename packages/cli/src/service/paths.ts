// ADR-0158 §5 — RUNNER: caminhos do ESTADO do processo de um serviço, dentro do
// PRÓPRIO diretório do serviço (`~/.aluy/services/<nome>/.state/`) — nunca em
// `/tmp` nem espalhado noutro lugar, para `stop`/`logs`/`status` de UM serviço
// nunca precisarem adivinhar onde o `start` daquele MESMO serviço escreveu.
//
// `.state/` guarda:
//   runner.pid    — pid do processo do runner (o "processo que É o serviço", §5).
//   runner.log    — log human-readable do runner (schedule/turno/daemons/sinais).
//   status.json   — retrato do estado VIVO (dormindo até X / turno em andamento /
//                   aguardando dono) — best-effort, cruzado com o pidfile em
//                   `status.ts` (pidfile+kill-0 é a fonte de verdade de "rodando").
//   attach.sock   — ADR-0158 §11 (FASE 4) — o socket UNIX local do `attach`, servido
//                   pelo PROCESSO DO RUNNER (`attach-server.ts`). Permissão 0600,
//                   removido no teardown — NUNCA TCP (a autenticação é a posse da
//                   máquina/arquivo, não credencial de rede).
//   sessions/     — SessionStore ESCOPADO ao serviço (`ALUY_SERVICE_HOME`, `run.tsx`)
//                   — a transcrição de cada turno headless; é o que `attach-blocks.ts`
//                   faz tail p/ publicar blocos no attach.
//   <daemon>.pid / <daemon>.log — por daemon PRÓPRIO declarado (§6).
//
// I/O concreto (fs) — não é puro; mora no `cli` (ADR-0053 §8).

import { join } from 'node:path';

export const SERVICE_STATE_DIRNAME = '.state';

export function serviceStateDir(serviceDir: string): string {
  return join(serviceDir, SERVICE_STATE_DIRNAME);
}

export function runnerPidPath(serviceDir: string): string {
  return join(serviceStateDir(serviceDir), 'runner.pid');
}

export function runnerLogPath(serviceDir: string): string {
  return join(serviceStateDir(serviceDir), 'runner.log');
}

export function runnerStatusPath(serviceDir: string): string {
  return join(serviceStateDir(serviceDir), 'status.json');
}

/** ADR-0158 §11 (FASE 4) — o socket UNIX local do `attach`, dentro do `.state/` do
 * PRÓPRIO serviço (mesma disciplina de `runnerPidPath`/`runnerStatusPath` — nunca
 * `/tmp`, nunca espalhado). */
export function attachSocketPath(serviceDir: string): string {
  return join(serviceStateDir(serviceDir), 'attach.sock');
}

/** Nome do daemon já vem SANEADO (dirname sob `daemons/`, sem path traversal). */
export function daemonPidPath(serviceDir: string, daemonName: string): string {
  return join(serviceStateDir(serviceDir), `${daemonName}.pid`);
}

export function daemonLogPath(serviceDir: string, daemonName: string): string {
  return join(serviceStateDir(serviceDir), `${daemonName}.log`);
}
