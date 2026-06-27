// EST-1129 · ADR-0123 §2.2 — TRIGGER DE BOOT NO STARTUP.
//
// Lê o perfil (LEVE/TURBO) e toggles de `~/.aluy/config.json` e, se TURBO,
// dispara o `NodeBootSupervisor.boot()` em BACKGROUND (fire-and-forget).
//
// Invariantes:
//   CA-G2-1 — Caminho absoluto dos binários, nunca PATH.
//   CA-G2-5 — Fail-open: um boot falho NUNCA trava o aluy.
//   CA-BOOT-LEVE — Perfil LEVE ⇒ zero sidecar spawnado.
//   Zero credencial no env do sidecar (CLI-SEC-7).

import { join } from 'node:path';
import { resolveSidecarToggles, type SidecarTarget } from '@hiperplano/aluy-cli-core';
import { NodeBootSupervisor } from './boot-supervisor.js';
import { UserConfigStore } from '../io/user-config.js';
import { warmupSidecars, type WarmTarget } from './sidecar-warmup.js';

export interface BootTriggerOptions {
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste. */
  readonly aluyDir?: string;
  /** HOME do usuário (default: `process.env.HOME`). Injetável p/ teste. */
  readonly homeDir?: string;
}

/**
 * Lê perfil/toggles da config e dispara o boot-supervisor em BACKGROUND.
 *
 * - LEVE ⇒ não faz nada, retorna `undefined`.
 * - TURBO ⇒ instancia o `NodeBootSupervisor`, chama `.boot()` e loga o
 *   resultado discretamente no stderr. A Promise roda em background —
 *   NUNCA bloqueia a UI/sessão.
 *
 * Retorna `undefined` se LEVE; retorna a Promise<BootResult> se TURBO
 * (o caller PODE aguardar para teste, mas em produção é fire-and-forget).
 */
export function triggerBoot(opts: BootTriggerOptions = {}): Promise<unknown> | undefined {
  const home = opts.homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? '/home/unknown';
  const aluyDir = opts.aluyDir ?? join(home, '.aluy');

  // Lê config (fail-safe: qualquer erro ⇒ defaults).
  const config = new UserConfigStore({ baseDir: aluyDir }).load();
  const profile = config.profile ?? 'turbo';

  // LEVE ⇒ zero sidecar.
  if (profile === 'leve') return undefined;

  // TURBO — resolve toggles (default: todos ON, reconciliação §2.2-bis).
  const togglesOpts: { ollama?: boolean; mem0?: boolean; headroom?: boolean } = {};
  if (config.sidecarToggles?.ollama !== undefined)
    togglesOpts.ollama = config.sidecarToggles.ollama;
  if (config.sidecarToggles?.mem0 !== undefined) togglesOpts.mem0 = config.sidecarToggles.mem0;
  if (config.sidecarToggles?.headroom !== undefined)
    togglesOpts.headroom = config.sidecarToggles.headroom;
  const toggles: ReadonlySet<SidecarTarget> = resolveSidecarToggles(togglesOpts);

  // Caminhos ABSOLUTOS (CA-G2-1). Overrides por env permitem apontar p/ uma
  // instalação NATIVA (ex.: no Windows o Ollama vive fora de ~/.aluy).
  // O headroom é um ENTRYPOINT de venv (`hr-venv`, ADR-0108): `bin/headroom`
  // no Unix, `Scripts/headroom.exe` no Windows — NÃO um binário solto.
  const isWin = process.platform === 'win32';
  const ollamaBaseDir = process.env.ALUY_OLLAMA_DIR ?? join(home, '.aluy', 'ollama');
  const mem0VenvDir = process.env.ALUY_MEM0_VENV ?? join(home, '.aluy', 'mem-venv');
  const hrVenv = join(home, '.aluy', 'hr-venv');
  const headroomBinaryPath =
    process.env.ALUY_HEADROOM_BIN ??
    (isWin ? join(hrVenv, 'Scripts', 'headroom.exe') : join(hrVenv, 'bin', 'headroom'));

  const supervisor = new NodeBootSupervisor();

  // Fire-and-forget em background: NÃO bloqueia a sessão (CA-G2-5).
  // Wrap em try/catch + .catch p/ cobrir tanto throws síncronos quanto
  // rejeições assíncronas.
  let bootPromise: Promise<unknown>;
  try {
    bootPromise = supervisor
      .boot(profile, toggles, headroomBinaryPath, ollamaBaseDir, mem0VenvDir)
      .then((result) => {
        const up = result.states.filter((s) => s.running).length;
        const total = result.states.length;
        if (total > 0) {
          // Log discreto: informa quantos sidecars subiram sem poluir a TUI.
          process.stderr.write(
            `aluy: boot-supervisor — ${up}/${total} sidecar(s) prontos` +
              (result.allFailed ? ' (todos falharam — seguindo sem sidecars)' : '') +
              '\n',
          );
        }
        // F90 — AQUECE os sidecars que subiram (mem0/ollama) p/ a 1ª chamada real NÃO ser
        // COLD (qwen-0.5b ~9.5s cold vs ~0.5-1s warm; o teto do loop é 2.5s ⇒ cold = fail-
        // open ⇒ judge/recall não entregam). Fire-and-forget, fail-safe — nunca bloqueia.
        const warm = new Set<WarmTarget>();
        for (const s of result.states) {
          if (s.running && (s.kind === 'mem0' || s.kind === 'ollama')) warm.add(s.kind);
        }
        if (warm.size > 0)
          void warmupSidecars({
            targets: warm,
            ...(config.services ? { services: config.services } : {}),
          });
        return result;
      })
      .catch((err: unknown) => {
        // CA-G2-5: um erro inesperado NUNCA trava o boot do aluy.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`aluy: boot-supervisor — erro inesperado: ${msg}\n`);
        return undefined;
      });
  } catch (err: unknown) {
    // CA-G2-5: throw síncrono também é engolido.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`aluy: boot-supervisor — erro inesperado: ${msg}\n`);
    return undefined;
  }

  return bootPromise;
}
