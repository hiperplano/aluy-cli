// Conectores (ADR-0135 TC-3 / ADR-0134 §3) — CONTRATO do segredo do conector (o TOKEN do
// bot) e validadores PUROS. PORTÁVEL: aqui só a interface + o naming + a validação de
// forma. O store concreto é o KEYCHAIN do SO (CLI-SEC-2), que vive no @hiperplano/aluy-cli.
//
// CLI-SEC-2 (crítico): o token do bot é credencial de longa-vida (controla o bot inteiro:
// ler todas as mensagens, enviar como o bot). NUNCA em `config.json`/`mcp.json`/arquivo/
// log/binário — só no keychain. O config guarda só a allowlist (DADO).

/** Backend de segredo de um conector (1 string por conta de keychain). */
export interface ConnectorSecretStore {
  /** Lê o segredo, ou `null` se não há. */
  get(): Promise<string | null>;
  /** Persiste/atualiza o segredo (no keychain do SO). */
  set(secret: string): Promise<void>;
  /** Apaga o segredo (logout do conector). Idempotente. */
  clear(): Promise<void>;
}

/** Conta de keychain de um conector (`connector-<id>-token`). Serviço = `aluy-cli`. */
export function connectorKeychainAccount(connectorId: string): string {
  return `connector-${connectorId}-token`;
}

/**
 * Valida a FORMA de um token de bot do Telegram (`<bot_id>:<auth>`), sem tocar a rede.
 * Serve p/ o `aluy telegram login` REJEITAR lixo ANTES de gravar no keychain (não
 * confunde o usuário gravando algo que nunca vai autenticar). NÃO prova que o token é
 * válido no servidor — só que tem a forma certa. PURO.
 */
export function isPlausibleTelegramToken(raw: string): boolean {
  const t = raw.trim();
  // bot_id (≥5 dígitos) ':' auth (≥30 chars do alfabeto de token do Telegram).
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t);
}

/** Redação do token p/ log/erro (CLI-SEC-6): mostra só o bot_id + comprimento, nunca o auth. */
export function redactTelegramToken(raw: string): string {
  const t = raw.trim();
  const colon = t.indexOf(':');
  if (colon <= 0) return `…(${t.length} chars)`;
  return `${t.slice(0, colon)}:…(${t.length - colon - 1} chars)`;
}

/**
 * Redação POR CONSTRUÇÃO (CLI-SEC-6, R6 do gate seguranca): substitui TODAS as ocorrências
 * de `secret` em `text` pela forma redigida. É o que o wiring DEVE aplicar antes de logar
 * qualquer string que possa conter o token (ex.: a URL `…/bot<token>/getUpdates`, a mensagem
 * de um erro de rede que ecoa a URL). Segredo vazio/curto ⇒ devolve `text` intacto. PURO.
 */
export function redactSecretIn(text: string, secret: string): string {
  const s = secret.trim();
  if (s.length < 8) return text; // nada plausível a redigir (evita falsos positivos).
  return text.split(s).join('«REDACTED»');
}
