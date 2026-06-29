// Auto-reparo dos sidecars do TURBO — o "consertar" por trás do `/doctor fix`.
//
// Decisão do dono: o reparo NÃO é um motor determinístico fixo — é o PRÓPRIO AGENTE se
// consertando. Há modos de falha demais (python ausente, wheel do core Rust, porta ocupada,
// quirk de distro, permissão, store incompatível…) p/ um roteiro rígido cobrir. Então o
// `/doctor fix` entrega ao agente um OBJETIVO FOCADO (com a cauda dos logs já anexada) e ele
// lê os logs, roda o bootstrap, instala o que falta e re-tenta — adaptativo, ao vivo, em --yolo.
//
// Este módulo é PURO: só lê logs e MONTA o texto do objetivo. Quem submete ao loop do agente é
// o handler do slash (`built.controller.submit(goal)`). Sem I/O de processo aqui.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Os sidecars do turbo. */
export type SidecarKind = 'headroom' | 'ollama' | 'mem0';
export const SIDECAR_KINDS: readonly SidecarKind[] = ['ollama', 'mem0', 'headroom'];

/** Lê as últimas `n` linhas de `~/.aluy/logs/<kind>.log` (best-effort; ausente ⇒ undefined). */
export function defaultReadLogTail(
  kind: SidecarKind,
  n = 15,
  baseDir = join(homedir(), '.aluy'),
): string | undefined {
  try {
    const raw = readFileSync(join(baseDir, 'logs', `${kind}.log`), 'utf8').trimEnd();
    if (raw === '') return undefined;
    return raw.split('\n').slice(-n).join('\n');
  } catch {
    return undefined;
  }
}

/** Junta a cauda do log dos sidecars indicados (ou de todos). */
export function gatherLogTails(
  kinds: readonly SidecarKind[] = SIDECAR_KINDS,
  read: (k: SidecarKind) => string | undefined = (k) => defaultReadLogTail(k),
): Partial<Record<SidecarKind, string>> {
  const out: Partial<Record<SidecarKind, string>> = {};
  for (const k of kinds) {
    const t = read(k);
    if (t !== undefined) out[k] = t;
  }
  return out;
}

/**
 * Monta o OBJETIVO de reparo entregue ao agente. Auto-contido: manda o agente diagnosticar,
 * (re)provisionar pelo caminho DIRETO (`--no-agent` — ele JÁ é o agente, não recursar), instalar
 * pré-requisitos que faltarem e repetir até o `aluy doctor` mostrar os 3 sidecars ✓. Inclui a
 * cauda dos logs que conseguimos ler, p/ o agente partir do sintoma real.
 */
export function buildRepairGoal(opts: {
  /** Sidecars que o doctor marcou como fora (se conhecido). Vazio/ausente ⇒ o agente descobre. */
  readonly down?: readonly SidecarKind[];
  /** Cauda dos logs por sidecar (de `gatherLogTails`). */
  readonly logTails?: Partial<Record<SidecarKind, string>>;
}): string {
  const down = opts.down ?? [];
  const tails = opts.logTails ?? {};
  const alvo =
    down.length > 0
      ? `Os complementos do modo turbo abaixo estão FORA: ${down.join(', ')}.`
      : `Um ou mais complementos do modo turbo (ollama, mem0, headroom) estão fora.`;

  const logBlocks = (Object.keys(tails) as SidecarKind[])
    .map((k) => `--- ~/.aluy/logs/${k}.log (cauda) ---\n${tails[k]}`)
    .join('\n\n');

  return [
    `${alvo} Conserte SOZINHO, agindo na máquina (você está em modo turbo, com consentimento, e em --yolo).`,
    ``,
    `Passos:`,
    `1. Rode \`aluy doctor\` e veja exatamente quais sidecars estão ✗.`,
    `2. Para cada um fora, leia \`~/.aluy/logs/<nome>.log\` (nomes: ollama, mem0, headroom) p/ a causa.`,
    `3. (Re)provisione pelo caminho DIRETO: \`aluy bootstrap --no-agent\`. NÃO use o modo agente`,
    `   (você JÁ é o agente — chamar \`aluy bootstrap\` sem \`--no-agent\` recursaria).`,
    `4. Se faltar pré-requisito (python3.10+/pip/venv, zstd/tar, etc.), instale com o gerenciador`,
    `   da distro (apt/dnf/pacman/zypper; brew no macOS), com sudo se preciso.`,
    `5. Casos comuns: mem0 ✗ "No such file" ⇒ falta o aluy-mem0-server.py no venv (o bootstrap`,
    `   o copia); mem0 crash de store ⇒ \`mv ~/.aluy/memory{,.bak}; mv ~/.mem0/history.db{,.bak}\`;`,
    `   ollama "command not found" mas serviço up ⇒ binário fora do PATH; headroom ⇒ deps do venv.`,
    `6. Repita até \`aluy doctor\` mostrar ollama ✓ · mem0 ✓ · headroom ✓ (ou explique, com a linha`,
    `   do log, por que um não sobe nesta máquina). Seja conciso no relato.`,
    ...(logBlocks !== '' ? [``, `Logs que já capturei:`, logBlocks] : []),
  ].join('\n');
}
