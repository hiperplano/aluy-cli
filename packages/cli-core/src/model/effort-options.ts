// EST-1117 · ADR-0053 §8 · ADR-0030 §3 — o PASSO de `reasoning_effort` do `/model`
// CONJUGADO: a lógica PURA das opções de esforço (a 3ª etapa do trio provider+model+
// effort), sem Ink/IO. O hook do `@hiperplano/aluy-cli` detém o ESTADO (índice/texto digitado) e a
// captura de teclas; este módulo só MODELA as opções, a navegação e a normalização do
// valor — exatamente como `models-list`/`catalog` são puros e a TUI só PINTA o DADO.
//
// O `reasoning_effort` é PASSTHROUGH (EST-0962): qualquer string ≤32 chars vai ao provider
// (broker OU backend local), SEM tier-gate. Aqui oferecemos os três níveis canônicos
// (low/medium/high), além de:
//   · KEEP ("manter") — não muda o effort atual (o trio aplica só o modelo);
//   · CUSTOM — texto-livre passthrough (o usuário digita um valor além dos canônicos).
//
// CLI-SEC-7/HG-2: o valor de effort é DADO público (string passthrough), NUNCA credencial.
// PORTÁVEL (ADR-0053 §8): zero `node:*`, zero rede, zero Ink — string/estrutura in/out.

/** Os níveis canônicos de `reasoning_effort` oferecidos no menu (ordem de exibição). */
export const CANONICAL_EFFORTS = ['low', 'medium', 'high'] as const;

/** Um nível canônico de effort. */
export type CanonicalEffort = (typeof CANONICAL_EFFORTS)[number];

/** Teto de caracteres do effort passthrough (espelha o `/effort` — EST-0962). */
export const MAX_EFFORT_LEN = 32;

/**
 * O TIPO de uma opção do passo de effort:
 *  - `keep`   — manter o effort atual (não envia mudança);
 *  - `level`  — um nível canônico (low/medium/high), com o `value`;
 *  - `custom` — abre o texto-livre passthrough (o `value` é digitado depois).
 */
export type EffortOptionKind = 'keep' | 'level' | 'custom';

/** Uma opção do passo de effort, já pronta p/ render (apresentação pura). */
export interface EffortOption {
  readonly kind: EffortOptionKind;
  /** O valor passthrough do nível (`low`/`medium`/`high`); ausente em `keep`/`custom`. */
  readonly value?: CanonicalEffort;
  /** Chave estável p/ a key do React e os testes (`keep`/`low`/`medium`/`high`/`custom`). */
  readonly id: string;
}

/**
 * Resultado da confirmação do passo de effort — o que aplicar ao trio:
 *  - `{ kind:'keep' }`           — não muda o effort (aplica só o modelo);
 *  - `{ kind:'set', value }`     — seta este `reasoning_effort` (canônico OU custom válido).
 * NUNCA carrega credencial — `value` é DADO passthrough público (CLI-SEC-7).
 */
export type EffortChoice =
  | { readonly kind: 'keep' }
  | { readonly kind: 'set'; readonly value: string };

/**
 * As opções do passo de effort, em ordem de exibição: `manter` (sempre o 1º — o caminho
 * de menor atrito p/ quem só troca o modelo), os três níveis canônicos, e `custom` (a
 * última — abre o texto-livre). PURO/determinístico. O `currentEffort` não muda a LISTA
 * (a UI marca o ativo à parte); fica no contrato p/ futura ênfase sem quebrar a ordem.
 */
export function effortOptions(): readonly EffortOption[] {
  return [
    { kind: 'keep', id: 'keep' },
    ...CANONICAL_EFFORTS.map((value): EffortOption => ({ kind: 'level', value, id: value })),
    { kind: 'custom', id: 'custom' },
  ];
}

/** Total de opções (p/ clamp da navegação). */
export function effortOptionCount(): number {
  return effortOptions().length;
}

/** Clampa um índice de seleção na faixa válida das opções de effort. PURO. */
export function clampEffortIndex(index: number): number {
  return Math.min(Math.max(0, index), effortOptionCount() - 1);
}

/**
 * `true` se `value` é um dos níveis canônicos do effort (low/medium/high). Case-insensitive
 * por robustez, mas os canônicos já são minúsculos. PURO.
 */
export function isCanonicalEffort(value: string): value is CanonicalEffort {
  return (CANONICAL_EFFORTS as readonly string[]).includes(value.toLowerCase());
}

/**
 * Normaliza um valor CUSTOM de effort (texto-livre): faz trim. Devolve a string limpa.
 * (A validação do tamanho é separada — `validateCustomEffort` — p/ a UI dar o aviso.) PURO.
 */
export function normalizeCustomEffort(raw: string): string {
  return raw.trim();
}

/** Resultado da validação do effort custom: ok (com o valor limpo) ou o motivo do erro. */
export type CustomEffortValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'empty' | 'too-long' };

/**
 * Valida o effort CUSTOM digitado (texto-livre passthrough). Regras (espelham o `/effort`,
 * EST-0962): trim; vazio ⇒ inválido (`empty`); > MAX_EFFORT_LEN ⇒ inválido (`too-long`).
 * Qualquer outra string não-vazia ≤32 é ACEITA (passthrough — o provider decide). PURO.
 */
export function validateCustomEffort(raw: string): CustomEffortValidation {
  const value = normalizeCustomEffort(raw);
  if (value === '') return { ok: false, reason: 'empty' };
  if (value.length > MAX_EFFORT_LEN) return { ok: false, reason: 'too-long' };
  return { ok: true, value };
}

/**
 * Resolve a EffortChoice da opção confirmada (modo LISTA — não-custom):
 *  - `keep`  ⇒ `{ kind:'keep' }` (não muda o effort);
 *  - `level` ⇒ `{ kind:'set', value }` (seta o nível canônico);
 *  - `custom`⇒ `null` (o chamador deve ABRIR o texto-livre, não confirmar aqui).
 * PURO. `index` fora da faixa ⇒ `null` (nada a aplicar — defensivo).
 */
export function effortChoiceAt(index: number): EffortChoice | null {
  const opt = effortOptions()[index];
  if (opt === undefined) return null;
  if (opt.kind === 'keep') return { kind: 'keep' };
  if (opt.kind === 'level' && opt.value !== undefined) return { kind: 'set', value: opt.value };
  return null; // custom: abre o texto-livre, não confirma aqui
}

/**
 * Resolve a EffortChoice a partir do texto CUSTOM digitado. Válido ⇒ `{kind:'set'}`;
 * inválido (vazio/>32) ⇒ `null` (o chamador mantém o texto-livre aberto e mostra o aviso).
 * PURO.
 */
export function effortChoiceFromCustom(raw: string): EffortChoice | null {
  const v = validateCustomEffort(raw);
  return v.ok ? { kind: 'set', value: v.value } : null;
}
