// `aluy telegram <sub>` (ADR-0134 / ADR-0135 §72) — UX de gestão do conector Telegram:
// login (token → keychain), logout, allow/deny (allowlist de chat-ids → config), status.
// É o molde `aluy connector login/allow <id>` com açúcar `aluy telegram`.
//
// Disciplina de segurança (herdada): o TOKEN só no keychain (CLI-SEC-2/TC-3); a ALLOWLIST
// (DADO) no config (default fechado, TC-2); nada de token em arquivo/log (redação).
//
// Esta fatia é a GESTÃO (sem rede): não há long-poll nem `telegram_send` ainda — a bridge
// permanece INERTE até o wiring `--telegram` + a revisão `seguranca`. `status` deixa isso claro.

import {
  isPlausibleTelegramToken,
  redactTelegramToken,
  type ConnectorSecretStore,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import { KeychainConnectorSecretStore } from '../auth/connector-secret-store.js';
import { NoKeychainError } from '../auth/keychain-store.js';
import {
  UserConfigStore,
  telegramAllowlist,
  addTelegramAllow,
  removeTelegramAllow,
} from '../io/user-config.js';

export type TelegramSub = 'login' | 'logout' | 'allow' | 'deny' | 'status';

export interface TelegramOptions {
  readonly sub: TelegramSub;
  /** Token explícito (`--token`); senão lê de `ALUY_TELEGRAM_TOKEN` ou pede no prompt. */
  readonly token?: string;
  /** chat-id alvo (allow/deny). */
  readonly chatId?: number;
}

export interface TelegramDeps {
  readonly io?: TerminalIO;
  readonly secretStore?: ConnectorSecretStore;
  readonly configStore?: UserConfigStore;
  readonly env?: NodeJS.ProcessEnv;
}

/** Executa `aluy telegram <sub>`. Retorna 0 em sucesso, 1 em erro/uso. Não lança. */
export async function runTelegram(opts: TelegramOptions, deps: TelegramDeps = {}): Promise<number> {
  const io = deps.io ?? realTerminalIO();
  const secretStore = deps.secretStore ?? new KeychainConnectorSecretStore('telegram');
  const configStore = deps.configStore ?? new UserConfigStore();
  const env = deps.env ?? process.env;

  switch (opts.sub) {
    case 'login':
      return loginCmd(opts, io, secretStore, env);
    case 'logout':
      return logoutCmd(io, secretStore);
    case 'allow':
      return allowCmd(opts, io, configStore, true);
    case 'deny':
      return allowCmd(opts, io, configStore, false);
    case 'status':
      return statusCmd(io, secretStore, configStore);
  }
}

async function loginCmd(
  opts: TelegramOptions,
  io: TerminalIO,
  store: ConnectorSecretStore,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let token = opts.token ?? env.ALUY_TELEGRAM_TOKEN;
  if (token === undefined || token.trim() === '') {
    // Sem token na linha/env ⇒ pede no prompt SEM eco (o token é segredo).
    token = await io.prompt('cole o token do bot (@BotFather): ', { secret: true });
  }
  token = (token ?? '').trim();
  if (!isPlausibleTelegramToken(token)) {
    // Rejeita ANTES de gravar: não confunde o usuário guardando algo que nunca autentica.
    io.err('token com forma inválida (esperado `<bot_id>:<auth>`) — NÃO foi salvo.');
    return 1;
  }
  try {
    await store.set(token);
  } catch (err) {
    if (err instanceof NoKeychainError) {
      io.err(err.message);
      return 1;
    }
    io.err('falha ao guardar o token no keychain — NÃO foi salvo.');
    return 1;
  }
  io.out(`✓ token do bot guardado no keychain do SO (${redactTelegramToken(token)}).`);
  io.out('  próximo: autorize seu chat com `aluy telegram allow <chat-id>` (default fechado).');
  return 0;
}

async function logoutCmd(io: TerminalIO, store: ConnectorSecretStore): Promise<number> {
  await store.clear();
  io.out('✓ token do bot removido do keychain (a bridge não autentica mais).');
  return 0;
}

async function allowCmd(
  opts: TelegramOptions,
  io: TerminalIO,
  configStore: UserConfigStore,
  add: boolean,
): Promise<number> {
  if (opts.chatId === undefined) {
    io.err(`uso: aluy telegram ${add ? 'allow' : 'deny'} <chat-id>  (um inteiro)`);
    return 1;
  }
  const config = configStore.load();
  const next = add
    ? addTelegramAllow(config, opts.chatId)
    : removeTelegramAllow(config, opts.chatId);
  configStore.save({ connectors: { telegram: { allowlist: next } } });
  if (add) {
    io.out(`✓ chat-id ${opts.chatId} autorizado. Allowlist: [${next.join(', ')}].`);
  } else {
    io.out(`✓ chat-id ${opts.chatId} removido. Allowlist: [${next.join(', ')}].`);
  }
  return 0;
}

async function statusCmd(
  io: TerminalIO,
  store: ConnectorSecretStore,
  configStore: UserConfigStore,
): Promise<number> {
  const token = await store.get();
  const allow = telegramAllowlist(configStore.load());
  io.out('Telegram (conector):');
  io.out(`  token:     ${token ? `presente (${redactTelegramToken(token)})` : 'ausente — rode `aluy telegram login`'}`);
  io.out(
    `  allowlist: ${allow.length > 0 ? `[${allow.join(', ')}]` : 'VAZIA (bridge fechada — autorize com `aluy telegram allow <chat-id>`)'}`,
  );
  io.out('  estado:    a bridge ainda NÃO está ativa (o `--telegram` chega numa próxima versão).');
  return 0;
}
