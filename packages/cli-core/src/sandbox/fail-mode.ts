// EST-1009 · ADR-0065 §D-SB-4 — FAIL-MODE do sandbox (lógica PURA, testável sem SO).
//
// "NUNCA finge confinamento, nunca silencioso." Quando o piso de SO NÃO está
// disponível numa máquina, o comportamento é CRAVADO por ambiente:
//
//   dev/staging : DEGRADA p/ catraca + matcher textual SÓ, com AVISO INEQUÍVOCO
//                 ("sem piso de SO nesta máquina") + máquina NÃO-PROMOVÍVEL a prod.
//   prod        : RECUSA por default; `--unsafe-no-sandbox` por sessão aceita rodar
//                 SEM piso (risco assumido) MAS não relaxa sempre-ask nem o
//                 write-deny de `~/.aluy/` (esses valem na CATRACA, acima do flag —
//                 ADR-0064/EST-0974; aqui o flag só decide a postura de SANDBOX).
//
// Esta função é o ÚNICO ponto que decide a postura — o lançador concreto OBEDECE.

import type { SandboxCapability, SandboxDecision, SandboxEnv } from './types.js';
import { floorAvailable } from './types.js';

/**
 * Aviso INEQUÍVOCO e não-suprimível por config (D-SB-4). É a postura cravada do
 * `seguranca`: quem roda sem piso SEMPRE vê. Texto i18n-neutro com o motivo da
 * capability embutido (o locus pode prefixar/traduzir, mas não suprimir).
 */
function buildWarning(cap: SandboxCapability, kind: 'degrade' | 'unsafe'): string {
  const reason = cap.unavailableReason ?? 'bwrap/userns/seccomp indisponíveis';
  const head =
    kind === 'degrade'
      ? '⚠ SEM PISO DE SO NESTA MÁQUINA — o sandbox de SO ' +
        'não está disponível; comandos e MCP rodam SEM confinamento DURO de SO ' +
        '(só a catraca textual protege). Esta máquina NÃO é promovível a `prod`.'
      : '⚠ RODANDO SEM PISO DE SO (--unsafe-no-sandbox) — você assumiu o risco da ' +
        'ausência do sandbox de SO. A catraca (sempre-ask) e o write-deny de ' +
        '`~/.aluy/` CONTINUAM valendo; só o confinamento DURO de SO está ausente.';
  return `${head} Motivo: ${reason}.`;
}

/**
 * RESOLVE a postura de fail-mode (D-SB-4) — PURA. Entrada: capability detectada,
 * ambiente, e se o usuário passou `--unsafe-no-sandbox` na sessão.
 *
 * - PISO DISPONÍVEL ⇒ `confine` (caminho normal, promovível, sem aviso). O flag
 *   `--unsafe-no-sandbox` é INERTE quando há piso (não há por que dispensá-lo;
 *   não existe "desligar o sandbox quando ele funciona" — o piso é o piso).
 * - PISO AUSENTE + dev/staging ⇒ `degrade` (roda sem sandbox, AVISA, não-promovível).
 * - PISO AUSENTE + prod + sem flag ⇒ `refuse` (NÃO roda; recusa por default).
 * - PISO AUSENTE + prod + COM flag ⇒ `unsafe` (roda sem sandbox, AVISA risco).
 */
export function resolveFailMode(
  cap: SandboxCapability,
  env: SandboxEnv,
  unsafeNoSandbox: boolean,
): SandboxDecision {
  if (floorAvailable(cap)) {
    // O piso existe: confina SEMPRE. O flag não desliga o piso (ele é o chão de
    // segurança; "desligar quando funciona" seria exatamente o furo que o ADR fecha).
    return { action: 'confine', confined: true, allowed: true, promotable: true };
  }

  // A partir daqui, NÃO há piso de SO nesta máquina.
  if (env === 'prod') {
    if (!unsafeNoSandbox) {
      // RECUSA por default no canal público (nunca silencioso): não roda o efeito.
      return {
        action: 'refuse',
        confined: false,
        allowed: false,
        promotable: false,
        warning:
          '⛔ `prod` SEM PISO DE SO — efeito de `run_command`/MCP RECUSADO por default. ' +
          'Sem o sandbox de SO, `~/.aluy/`, `~/.ssh`, `~/.aws`, `.env*` ' +
          'ficam expostos a bash/MCP ofuscado. Para rodar MESMO ASSIM, assumindo o risco, ' +
          'use `--unsafe-no-sandbox` por sessão (não relaxa sempre-ask nem o write-deny de ' +
          `\`~/.aluy/\`). Motivo: ${cap.unavailableReason ?? 'bwrap/userns/seccomp indisponíveis'}.`,
      };
    }
    // Risco assumido conscientemente: roda sem sandbox, AVISA, não-promovível.
    return {
      action: 'unsafe',
      confined: false,
      allowed: true,
      promotable: false,
      warning: buildWarning(cap, 'unsafe'),
    };
  }

  // dev/staging: DEGRADA com aviso inequívoco + não-promovível.
  return {
    action: 'degrade',
    confined: false,
    allowed: true,
    promotable: false,
    warning: buildWarning(cap, 'degrade'),
  };
}

/**
 * RESOLVE o ambiente (D-SB-4) a partir de `ALUY_ENV` — DADO, não decisão de
 * código. Default SEGURO-E-HONESTO: `dev` quando não setado.
 *
 * Por quê `dev` por default e não `prod`? O binário público é publicado, mas a
 * MÁQUINA onde ele roda (CI, dev local, máquina do usuário) varia. Defaultar
 * `prod` faria o CI/dev RECUSAR efeitos onde o piso não existe (quebra o fluxo de
 * dev sem ganho de segurança — dev não é o canal exposto). O default `dev`
 * DEGRADA-COM-AVISO (nunca silencioso, sempre avisa, marca não-promovível) — a
 * postura honesta. O canal de `prod` é setado EXPLICITAMENTE (`ALUY_ENV=prod`) no
 * build/embalagem do canal público. ⚠ DECISÃO p/ o gate `seguranca` ratificar.
 */
export function resolveSandboxEnv(env: NodeJS.ProcessEnv = process.env): SandboxEnv {
  const raw = (env.ALUY_ENV ?? '').trim().toLowerCase();
  if (raw === 'prod' || raw === 'production') return 'prod';
  if (raw === 'staging') return 'staging';
  return 'dev';
}

/**
 * RESOLVE o flag `--unsafe-no-sandbox` (por sessão, NUNCA persistido). Precedência
 * flag-CLI > env (`ALUY_UNSAFE_NO_SANDBOX=1`). Distinto de `--yolo`/`--unsafe`
 * (que relaxam CONFIRMAÇÃO na catraca): este só aceita rodar SEM o piso de SO e
 * NÃO relaxa nenhuma garantia da catraca (sempre-ask, write-deny de `~/.aluy/`).
 */
export function resolveUnsafeNoSandbox(
  flag: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (flag) return true;
  const raw = (env.ALUY_UNSAFE_NO_SANDBOX ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}
