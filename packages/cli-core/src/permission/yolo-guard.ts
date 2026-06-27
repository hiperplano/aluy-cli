// EST-0991 · EST-1007 · ADR-0072 · AG-0008 — GUARDA DE ENTRADA do modo YOLO
// (`--yolo`, modo interno `'unsafe'`) — PERMISSÃO COMPLETA na máquina (catraca-off +
// cerca-off + anti-SSRF-off).
//
// O YOLO entrega o que o dono pediu (paridade com `--dangerously-skip-permissions`):
// nele a catraca libera TUDO, a cerca de FS cai (disco inteiro) e o anti-SSRF de
// faixa interna é suspenso. Em troca, o ADR-0072 §3 crava um MÍNIMO BLINDADO que o
// YOLO mantém — não são pisos de FUNÇÃO (esses caíram), são o opt-in ser BARULHENTO,
// espelhando o que o Claude Code mantém:
//
//   (a) Opt-in EXPLÍCITO — só via flag `--yolo`/`--unsafe`. NUNCA default, NUNCA
//       persistido como preferência (essa regra mora no parser/wiring: o modo é
//       estado de sessão, jamais gravado).
//   (b) Banner permanente + CONFIRMAÇÃO de entrada (one-shot) — a TUI mostra o
//       `UnsafeBanner` enquanto a sessão estiver em YOLO, e pede confirmação ao
//       ENTRAR. Esta guarda produz o texto da confirmação. Em HEADLESS (sem TTY)
//       não há quem confirme: a PRÓPRIA flag `--yolo` JÁ é o consentimento
//       deliberado (igual `claude -p --dangerously-skip-permissions`) ⇒ entra DIRETO,
//       só emite o banner de AVISO (não bloqueia).
//   (d) Guarda de ROOT — o ÚNICO bloqueio DURO que sobra (decisão do dono, AG-0008).
//       YOLO + root é o caso CATASTRÓFICO: uma injeção destrói a máquina TODA sem
//       barreira de privilégio. RECUSA SEMPRE como root (uid 0), TTY ou não. Espelha
//       o Claude Code, que também bloqueia esse caso.
//
// MUDANÇA EST-1007/AG-0008 (alinhamento ao Claude Code, decisão do Tiago — relaxamento
// de gate, sinalizado ao `seguranca`): CAIU o duplo opt-in `ALUY_YOLO_HEADLESS`. Antes,
// `--yolo` em headless EXIGIA `ALUY_YOLO_HEADLESS=1` JUNTO (e recusava sem). Agora a
// flag `--yolo` basta em headless — ela JÁ é o sinal deliberado. O ÚNICO guard duro
// que resta é o ROOT (igual ao Claude). O efeito colateral bom: o caminho que ANTES
// pendurava (`--yolo` recusado em headless → fallback normal → trava com MCP vivo)
// deixa de ser atingido pelo `--yolo` (que agora funciona direto).
//
// ESTA é a peça (d)+(b): uma função PURA/PORTÁVEL (ADR-0053 §8 — sem `node:*`, sem
// I/O) que recebe o CONTEXTO (TTY? root?) e devolve um veredito `allow | refuse`, mais
// o texto da confirmação/aviso e o EVENTO DE AUDITORIA (CLI-SEC-10, flag de modo). O
// @aluy/cli injeta o contexto real (process.stdin.isTTY, geteuid) e renderiza/loga.
// Testável de ponta a ponta com um contexto mock.

/** Contexto de runtime que decide se o YOLO pode entrar. PORTÁVEL — sem I/O. */
export interface YoloContext {
  /** A sessão é interativa? (`process.stdin.isTTY === true && stdout.isTTY === true`). */
  readonly tty: boolean;
  /** Rodando como ROOT? (`process.geteuid?.() === 0`; em Windows, sempre `false`). */
  readonly root: boolean;
}

/**
 * O motivo de uma recusa (p/ a UX e a auditoria). Após o AG-0008, o ÚNICO bloqueio
 * duro do YOLO é o ROOT — não há mais recusa de headless (a flag basta lá).
 */
export type YoloRefusalReason = 'root';

/**
 * Veredito da guarda de entrada do YOLO.
 *  - `allow`  ⇒ pode entrar; `requiresConfirmation` indica se a TUI ainda deve pedir
 *               a confirmação one-shot (sempre `true` em TTY — (b); `false` em headless,
 *               onde a flag JÁ é o consentimento e só emitimos o banner de AVISO). O texto
 *               carrega DOIS campos: `notice` (banner + "Continuar? [s/N]", p/ o bootPrompt
 *               do TTY) e `warning` (só o banner, SEM pergunta, p/ o stderr do headless).
 *  - `refuse` ⇒ ambiente CATASTRÓFICO (root); recusa SEMPRE, exit≠0.
 */
export type YoloEntryVerdict =
  | {
      readonly outcome: 'allow';
      /** A TUI deve pedir a confirmação de entrada (one-shot)? Sempre em TTY, nunca headless. */
      readonly requiresConfirmation: boolean;
      /** Banner + "Continuar? [s/N]" — p/ a confirmação one-shot da TUI (TTY). */
      readonly notice: string;
      /**
       * SÓ o banner de aviso, SEM a pergunta de confirmação — p/ o stderr do HEADLESS,
       * onde a flag `--yolo` já consentiu e não há prompt a responder (ADR-0072 §3b).
       */
      readonly warning: string;
    }
  | {
      readonly outcome: 'refuse';
      readonly reason: YoloRefusalReason;
      /** Aviso legível p/ o stderr. Em root é FATAL (não há fallback: exit≠0). */
      readonly message: string;
    };

/**
 * O AVISO de YOLO — honesto, sem eufemismo (ADR-0072 §3b). É o CORPO do banner, SEM a
 * pergunta de confirmação. Em HEADLESS (sem TTY) ESTE é o texto emitido no stderr: a flag
 * `--yolo` JÁ consentiu, NÃO há prompt a responder — incluir "Continuar? [s/N]" ali
 * confundiria (parece esperar uma resposta que nunca virá). A pergunta só entra no
 * `YOLO_ENTRY_NOTICE`, que a TUI (TTY) usa no `bootPrompt` de confirmação one-shot.
 */
export const YOLO_WARNING =
  '⚠ MODO YOLO — PERMISSÃO COMPLETA NA MÁQUINA. A catraca de aprovação está ' +
  'DESLIGADA, a cerca de workspace está DERRUBADA (disco inteiro acessível) e o ' +
  'anti-SSRF de rede interna está suspenso. O agente roda QUALQUER comando, lê/' +
  'escreve QUALQUER arquivo e abre rede para QUALQUER destino SEM PERGUNTAR. Uma ' +
  'única injeção de prompt (README/issue/página/saída de comando) pode comprometer ' +
  'esta máquina. Não persiste entre sessões.';

/**
 * O aviso de entrada COM a confirmação (banner + pergunta) — o que a TUI (TTY) mostra no
 * `bootPrompt` one-shot, onde o "Continuar? [s/N]" faz sentido (há quem responda). É o
 * `YOLO_WARNING` + a pergunta. NÃO usar em headless (lá só o `YOLO_WARNING`, sem pergunta).
 */
export const YOLO_ENTRY_NOTICE = `${YOLO_WARNING} Continuar? [s/N]`;

/**
 * Decide se o YOLO pode ENTRAR neste contexto, e o que a UX deve fazer (ADR-0072 §3).
 *
 * Regras (espelham o Claude Code, pós AG-0008):
 *  - ROOT (uid 0) ⇒ `refuse` SEMPRE (TTY ou não). É o ÚNICO bloqueio duro — YOLO + root
 *    = destruir a máquina com uma injeção, sem barreira de privilégio. Não há fallback
 *    nem env var que libere: roda como usuário normal.
 *  - NÃO-root em TTY ⇒ `allow` + `requiresConfirmation:true` (a confirmação one-shot é
 *    a fricção (b)).
 *  - NÃO-root em HEADLESS (sem TTY/CI/pipe/`-p`) ⇒ `allow` + `requiresConfirmation:false`:
 *    a PRÓPRIA flag `--yolo` é o consentimento deliberado (igual `claude -p
 *    --dangerously-skip-permissions`); não há TTY p/ confirmar, só o banner de AVISO.
 *
 * A função é PURA: não lê env/uid/tty — recebe-os no `ctx`. O caller (binário) os
 * coleta e injeta. Determinística e testável.
 */
export function decideYoloEntry(ctx: YoloContext): YoloEntryVerdict {
  // (d) ROOT — o ÚNICO bloqueio DURO (AG-0008). Recusa SEMPRE, sem env de escape.
  if (ctx.root) {
    return {
      outcome: 'refuse',
      reason: 'root',
      message:
        `aluy: --yolo RECUSADO como ROOT (uid 0): YOLO + root = risco de destruir a ` +
        `máquina com uma injeção de prompt (sem barreira de privilégio). Rode como ` +
        `usuário normal.`,
    };
  }
  // allow — confirmação one-shot SÓ faz sentido se houver TTY p/ responder. Em headless,
  // a flag `--yolo` JÁ é o consentimento: entra direto, só emite o banner de aviso (SEM a
  // pergunta — `warning`, não `notice`). O caller escolhe o campo pelo modo.
  return {
    outcome: 'allow',
    requiresConfirmation: ctx.tty,
    notice: YOLO_ENTRY_NOTICE,
    warning: YOLO_WARNING,
  };
}

/** Um evento de auditoria do YOLO (CLI-SEC-10, flag de modo). PORTÁVEL — sem I/O. */
export interface YoloAuditEvent {
  /** SEMPRE `cli` — ação do usuário pela borda (ADR-0063/CLI-SEC-10). */
  readonly actorType: 'cli';
  /** O que aconteceu com o YOLO. */
  readonly kind: 'yolo-entered' | 'yolo-refused';
  /** O MODO sob o qual o evento ocorreu — SEMPRE `yolo` aqui (forense, ADR-0072 §5). */
  readonly mode: 'yolo';
  /** Carimbo de tempo (ms epoch — relógio injetável). */
  readonly at: number;
  /** Em `yolo-refused`: por quê (root). Ausente em `yolo-entered`. */
  readonly reason?: YoloRefusalReason;
}

/** Constrói o evento de auditoria de entrada/recusa do YOLO (flag de modo `yolo`). */
export function yoloAuditEvent(verdict: YoloEntryVerdict, at: number): YoloAuditEvent {
  if (verdict.outcome === 'refuse') {
    return { actorType: 'cli', kind: 'yolo-refused', mode: 'yolo', at, reason: verdict.reason };
  }
  return { actorType: 'cli', kind: 'yolo-entered', mode: 'yolo', at };
}
