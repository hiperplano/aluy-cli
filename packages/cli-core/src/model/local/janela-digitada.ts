// F-WIN (emenda) — a JANELA DIGITADA PELO DONO, quando o provider não a informa.
//
// O buraco (relato do dono, 01/09, com `z-ai/glm-5.3-flash` no tokenrouter): a descoberta
// por `GET /models` funciona e não acha nada — verificado na conta dele, 131 modelos, e o
// catálogo inteiro só traz `id`, `object`, `created`, `owned_by`, `supported_endpoint_
// types`, `tags`. Não existe campo de janela para achar. A tabela embutida
// (`known-context-windows.ts`) tem 52 entradas e nenhuma de GLM.
//
// Até aqui o aviso mandava o dono editar `~/.aluy/config.json` à mão. Ele pediu o óbvio:
// "dar a opção de digitar quando o modelo não achar" (o comando é `/window`). Este módulo é o PARSER dessa
// digitação — puro, sem I/O; a escrita já existe (`registerModelContextWindow`).
//
// Aceitamos o sufixo `k`/`m` porque é como o número é publicado e conversado ("128k de
// contexto"), e exigir `131072` convidaria a erro de zero. NÃO aceitamos `.` nem `,` como
// separador de milhar: "128.000" vale 128000 em pt-BR e 128 em en-US, e adivinhar errado
// aqui envenena a auto-compactação de TODA sessão futura (o número vai para o disco). Na
// ambiguidade, recusamos e explicamos — o `_` fica como separador legível.

/** Múltiplos aceitos no sufixo. `k` = 1024 (o contexto é potência de dois na prática). */
const MULTIPLICADOR: Readonly<Record<string, number>> = { k: 1024, m: 1024 * 1024 };

/** Por que a digitação foi recusada — texto para a UI, já acionável. */
export type MotivoRecusa = 'vazio' | 'separador-ambiguo' | 'nao-numero' | 'fora-de-faixa';

export interface JanelaDigitada {
  /** Tokens, quando a digitação é válida. */
  readonly tokens?: number;
  /** Preenchido quando `tokens` está ausente. */
  readonly recusa?: MotivoRecusa;
}

/**
 * Converte a digitação do dono em TOKENS.
 *
 * `131072` · `128k` · `128K` · `1m` · `131_072` ⇒ número.
 * `128.000` · `128,000` ⇒ RECUSA (ambíguo entre locales — ver o cabeçalho).
 *
 * A faixa de plausibilidade NÃO é checada aqui de propósito: quem a define é
 * `isPlausibleContextWindow` (fonte única), e o chamador a aplica. Este módulo só
 * responde "que número o dono quis dizer".
 */
export function parseJanelaDigitada(bruto: string): JanelaDigitada {
  const t = bruto.trim().toLowerCase().replace(/\s+/g, '');
  if (t === '') return { recusa: 'vazio' };
  // Separador ambíguo ANTES de qualquer outra coisa: `128.000` não pode virar `128`.
  if (t.includes('.') || t.includes(',')) return { recusa: 'separador-ambiguo' };
  const m = /^(\d[\d_]*)(k|m)?$/.exec(t);
  if (m === null) return { recusa: 'nao-numero' };
  const digitos = (m[1] ?? '').replace(/_/g, '');
  if (digitos === '') return { recusa: 'nao-numero' };
  const base = Number(digitos);
  if (!Number.isSafeInteger(base)) return { recusa: 'fora-de-faixa' };
  const mult = m[2] !== undefined ? (MULTIPLICADOR[m[2]] ?? 1) : 1;
  const tokens = base * mult;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return { recusa: 'fora-de-faixa' };
  return { tokens };
}

/** Frase curta e acionável para cada recusa. PT-BR (UI). */
export function explicaRecusa(motivo: MotivoRecusa): string {
  switch (motivo) {
    case 'vazio':
      return 'informe o número de tokens — ex.: `131072` ou `128k`.';
    case 'separador-ambiguo':
      return 'não use `.` nem `,` (em "128.000" não dá p/ saber se são 128 mil ou 128) — use `131072`, `128k` ou `131_072`.';
    case 'nao-numero':
      return 'não entendi o número — use só dígitos, com `k`/`m` opcional (ex.: `128k`).';
    case 'fora-de-faixa':
      return 'número grande demais p/ ser uma janela de contexto.';
  }
}
