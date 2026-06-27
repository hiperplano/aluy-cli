// Seleção do BACKEND de modelo (PURO, portável).
//
// `local` (default, BYO — fala direto com o provider do usuário) | `broker`
// (backend central opcional). Precedência:
//   flag `--backend` > env `ALUY_BACKEND` > config (`~/.aluy/config.json` campo
//   `backend`) > default `local`.
// Sem nada ⇒ `local` ⇒ o aluy usa o provider/credencial do próprio usuário (BYO).
// Para usar o backend central, configure `backend: "broker"` (flag/env/config).
//
// PORTÁVEL: só lógica de string/precedência, sem I/O. O locus (@aluy/cli) lê a
// flag/env/config e chama isto.

/** Os backends de modelo selecionáveis. */
export type ModelBackend = 'broker' | 'local';

/** Default: BYO local (fala direto com o provider do usuário, sem intermediário). */
export const DEFAULT_BACKEND: ModelBackend = 'local';

/**
 * Normaliza um valor cru de backend (flag/env/config) p/ `ModelBackend` ou
 * `undefined` (valor ausente/inválido ⇒ ignorado, cai na próxima fonte). Aceita
 * `local`/`broker` (case-insensitive, trim). Lixo NÃO vira `local` por engano.
 */
export function parseBackend(raw: string | undefined | null): ModelBackend | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'local') return 'local';
  if (v === 'broker') return 'broker';
  return undefined;
}

/**
 * Resolve o backend efetivo por precedência. Cada fonte é o valor CRU (string ou
 * undefined); a 1ª que normalizar p/ um backend válido vence; nenhuma ⇒ default.
 */
export function resolveBackend(sources: {
  readonly flag?: string | undefined;
  readonly env?: string | undefined;
  readonly config?: string | undefined;
}): ModelBackend {
  return (
    parseBackend(sources.flag) ??
    parseBackend(sources.env) ??
    parseBackend(sources.config) ??
    DEFAULT_BACKEND
  );
}
