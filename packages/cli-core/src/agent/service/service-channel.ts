// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3) — resolve o `channel:` do `service.md` p/ o
// alvo CONCRETO do único conector suportado nesta fase, o Telegram (ADR-0154; o
// "escopo v1" do ADR-0158 §Consequências já cortava "canal Telegram apenas"). O
// FORMATO `<conector>:<alvo>` já foi validado ESTRUTURALMENTE pelo parser do
// manifesto (`service-parse.ts`, regex `^[a-z][a-z0-9_-]*:.+$`); este módulo faz a
// leitura SEMÂNTICA — "é telegram? o alvo é um chat-id numérico válido?" — sem
// tocar rede/keychain (isso é do runner concreto, `@hiperplano/aluy-cli`).
//
// TRAVA TC-5 (ADR-0154, herdada aqui): o alvo do egresso do serviço é SEMPRE este
// chat-id do MANIFESTO — nunca um argumento de modelo, nunca outro chat que apareça
// durante a ASK-ESPERA. `parseServiceTelegramChatId` é a ÚNICA fonte do alvo.
//
// PORTÁVEL (ADR-0053 §8): parser de string puro (sem `node:*`, sem I/O).

/**
 * Extrai o chat-id numérico de um `channel: telegram:<chat-id>` já validado
 * estruturalmente. `undefined` quando: canal ausente, conector ≠ `telegram`
 * (nenhum outro conector é suportado nesta fase — ADR-0158 §Consequências,
 * "canal Telegram apenas"), ou o alvo não é um inteiro válido. PURO.
 */
export function parseServiceTelegramChatId(channelRaw: string | undefined): number | undefined {
  if (channelRaw === undefined) return undefined;
  const m = /^telegram:(-?\d+)$/.exec(channelRaw.trim());
  if (!m) return undefined;
  const chatId = Number(m[1]);
  return Number.isInteger(chatId) ? chatId : undefined;
}
