// ADR-0158 §11 (FASE 4 — "ENTRAR num serviço rodando") — o PROTOCOLO do socket local
// de attach: NDJSON linha-a-linha, dois sentidos.
//
//   SERVIDOR (o processo do runner, `cli/src/service/attach-server.ts`) → CLIENTE
//   (`aluy service attach`, shell): eventos de saída — `log` (a mesma linha que já
//   vai pro `runner.log`), `state` (transição sleeping/running-turn/awaiting-owner —
//   `status.json`) e, melhor esforço, `block` (um resumo textual de um bloco NOVO da
//   conversa do turno em andamento — ver o gap documentado em
//   `cli/src/service/attach-blocks.ts`).
//
//   CLIENTE → SERVIDOR: só `say` (a fala do dono digitada no attach — §11 "o dono
//   pode DIGITAR"). O runner decide o que fazer com ela conforme a FASE em que está
//   (mid-turno/dormindo/ask-espera) — isso é lógica do runner, NÃO deste módulo.
//
// PURO — só formatação/parsing de texto (ADR-0053 §8: protocolo puro no cli-core,
// socket/fs no cli). Nunca lança: entrada malformada ⇒ `undefined` (o socket/fs que
// lida com ela decide o que fazer — aqui é só "isto é uma linha válida do protocolo
// ou não").

/** Os três estados que o runner já expõe em `status.ts` (`ServiceTurnState`) — este
 * módulo não importa aquele tipo (viraria uma dependência cli→cli-core→cli) e
 * redeclara a MESMA união literal (contrato estreito, sem acoplar aos tipos do `cli`). */
export type ServiceAttachTurnState = 'sleeping' | 'running-turn' | 'awaiting-owner';

export interface ServiceAttachLogEvent {
  readonly t: 'log';
  readonly line: string;
  readonly atIso: string;
}

export interface ServiceAttachStateEvent {
  readonly t: 'state';
  readonly turnState: ServiceAttachTurnState;
  /** Detalhe curto (a pergunta pendente, o resumo do último reporte…) — opcional. */
  readonly detail?: string;
  readonly atIso: string;
}

/**
 * §11 — "os blocos da conversa do turno em andamento", MELHOR ESFORÇO. `role` é um
 * resumo do `kind` do `SessionBlock` (`you`/`aluy`/`tool`/`bang`/`note`/…) — o tipo
 * completo vive em `cli/src/session/model.ts` e NÃO é importável aqui (fronteira
 * §8); o servidor já reduz o bloco a `{role, text}` ANTES de publicar (ver
 * `attach-blocks.ts`). `text` é o resumo textual, não a estrutura rica que a TUI
 * (`BlockView`, App.tsx) renderiza — attach é um espelho textual, não a TUI remota.
 */
export interface ServiceAttachBlockEvent {
  readonly t: 'block';
  readonly role: string;
  readonly text: string;
  readonly atIso: string;
}

export type ServiceAttachServerEvent =
  | ServiceAttachLogEvent
  | ServiceAttachStateEvent
  | ServiceAttachBlockEvent;

/** §11 — "o dono pode DIGITAR": a ÚNICA mensagem que o cliente manda ao servidor. */
export interface ServiceAttachSayEvent {
  readonly t: 'say';
  readonly text: string;
}

export type ServiceAttachClientEvent = ServiceAttachSayEvent;

/** Codifica UM evento como uma linha NDJSON (já com o `\n` final). PURO. */
export function encodeServiceAttachServerEvent(event: ServiceAttachServerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeServiceAttachClientEvent(event: ServiceAttachClientEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isTurnState(v: unknown): v is ServiceAttachTurnState {
  return v === 'sleeping' || v === 'running-turn' || v === 'awaiting-owner';
}

/**
 * Faz o parse de UMA linha (o caller já separou por `\n`) do lado do SERVIDOR
 * (eventos de saída). `undefined` p/ qualquer linha que não bata o contrato — nunca
 * lança (uma linha hostil/corrompida no socket não pode derrubar o cliente `attach`).
 * PURO.
 */
export function parseServiceAttachServerLine(line: string): ServiceAttachServerEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const atIso = isNonEmptyString(o.atIso) ? o.atIso : new Date(0).toISOString();
  if (o.t === 'log' && isNonEmptyString(o.line)) {
    return { t: 'log', line: o.line, atIso };
  }
  if (o.t === 'state' && isTurnState(o.turnState)) {
    return {
      t: 'state',
      turnState: o.turnState,
      atIso,
      ...(isNonEmptyString(o.detail) ? { detail: o.detail } : {}),
    };
  }
  if (o.t === 'block' && isNonEmptyString(o.role) && typeof o.text === 'string') {
    return { t: 'block', role: o.role, text: o.text, atIso };
  }
  return undefined;
}

/**
 * Faz o parse de UMA linha do lado do CLIENTE (só `say`, hoje). `undefined` p/
 * qualquer coisa fora do contrato — o servidor descarta silenciosamente (o socket é
 * local/0600, mas ainda assim nunca confia cegamente numa linha malformada). PURO.
 */
export function parseServiceAttachClientLine(line: string): ServiceAttachClientEvent | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.t === 'say' && typeof o.text === 'string') return { t: 'say', text: o.text };
  return undefined;
}

function describeAttachTurnState(state: ServiceAttachTurnState): string {
  switch (state) {
    case 'sleeping':
      return 'dormindo';
    case 'running-turn':
      return 'turno em andamento';
    case 'awaiting-owner':
      return 'aguardando o dono';
  }
}

/**
 * Formata UM evento do servidor pra uma linha de terminal legível — usado pelo
 * cliente `aluy service attach` (shell). PURO (o cliente só escreve a string em
 * `stdout`; nenhuma decisão de exibição fica escondida no `commands/service.ts`).
 */
export function formatServiceAttachEventForTerminal(event: ServiceAttachServerEvent): string {
  switch (event.t) {
    case 'log':
      return `· ${event.line}`;
    case 'state':
      return `── estado: ${describeAttachTurnState(event.turnState)}${
        event.detail !== undefined ? ` — ${event.detail}` : ''
      } ──`;
    case 'block':
      return `[${event.role}] ${event.text}`;
  }
}
