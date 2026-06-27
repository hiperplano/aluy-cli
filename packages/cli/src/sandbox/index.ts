// EST-1009 · ADR-0065 · CLI-SEC-H1 — barrel do LANÇADOR concreto do sandbox de SO.
//
// A PRIMITIVA que EST-1010 (bash) e EST-1011 (MCP) consomem: detecta a capability
// no boot, resolve o fail-mode (D-SB-4) e confina cada sub-processo de efeito via
// `bwrap`/userns + seccomp + Landlock-aditivo. O contrato (`SandboxLauncher`) e a
// lógica pura (fail-mode, seccomp-bytes) vêm do core PORTÁVEL; aqui mora o I/O de SO.

import type { SandboxEnv } from '@hiperplano/aluy-cli-core';
import { resolveSandboxEnv, resolveUnsafeNoSandbox } from '@hiperplano/aluy-cli-core';
import { detectSandboxCapability } from './capability.js';
import { BwrapSandboxLauncher } from './launcher.js';

export { detectSandboxCapability } from './capability.js';
export type { DetectCapabilityOptions } from './capability.js';
export { BwrapSandboxLauncher, SandboxConfinementError } from './launcher.js';
export type {
  BwrapSandboxLauncherOptions,
  ConfinedInvocation,
  SpawnConfinedOptions,
} from './launcher.js';
export { aluyHomeDir } from './aluy-home.js';

export interface CreateSandboxOptions {
  /** Ambiente (default resolvido de `ALUY_ENV`). */
  readonly env?: SandboxEnv;
  /** `--unsafe-no-sandbox` da CLI (default false; ou via `ALUY_UNSAFE_NO_SANDBOX`). */
  readonly unsafeNoSandbox?: boolean;
  /** ProcessEnv p/ resolver env/flag (default `process.env`). Injetável p/ teste. */
  readonly processEnv?: NodeJS.ProcessEnv;
}

/**
 * CRIA o lançador do sandbox pronto p/ uso: detecta a capability, resolve o
 * ambiente (`ALUY_ENV`) e o flag (`--unsafe-no-sandbox`/env), e devolve o
 * `BwrapSandboxLauncher`. É o ponto que o wiring do @hiperplano/aluy-cli chama no boot p/
 * obter a primitiva que 1010/1011 injetam no `ShellPort`/transporte MCP.
 */
export function createSandbox(opts: CreateSandboxOptions = {}): BwrapSandboxLauncher {
  const processEnv = opts.processEnv ?? process.env;
  const capability = detectSandboxCapability();
  const env = opts.env ?? resolveSandboxEnv(processEnv);
  const unsafeNoSandbox = resolveUnsafeNoSandbox(opts.unsafeNoSandbox ?? false, processEnv);
  return new BwrapSandboxLauncher({ capability, env, unsafeNoSandbox });
}
