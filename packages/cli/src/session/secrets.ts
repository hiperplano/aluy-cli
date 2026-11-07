// ADR 0005 — `/secret`: parser da linha + serviço (cofre em memória + `--save` cifrado).
//
// PURO quanto a UI: nada aqui lê teclado nem desenha. O VALOR só entra por `submit`, vindo
// do campo mascarado da TUI; este módulo nunca o loga, nunca o devolve em mensagem, e o
// parser NUNCA ecoa os tokens que recebeu (um valor colado no lugar do nome seria devolvido
// à tela e ao transcript).

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  secretVault as defaultVault,
  validateSecretName,
  type SecretVault,
} from '@hiperplano/aluy-cli-core';
import {
  readFileVaultAccount,
  writeFileVaultAccount,
  type FileVaultOptions,
} from '../model/local/file-vault.js';

export type SecretCommand =
  | { readonly kind: 'usage' }
  | { readonly kind: 'list' }
  | { readonly kind: 'remove'; readonly name: string }
  | {
      readonly kind: 'prompt';
      readonly name: string;
      readonly save: boolean;
      readonly force: boolean;
    }
  /** Veio um VALOR na linha: não executa, não guarda — só avisa (o texto já foi digitado em aberto). */
  | { readonly kind: 'inline-value' }
  | { readonly kind: 'error'; readonly message: string };

const FLAGS = new Set(['--save', '--force']);

/** `true` se a linha do composer é um `/secret …` (p/ nunca entrar no histórico ↑↓). */
export function isSecretCommandLine(line: string): boolean {
  return /^\s*\/secret(?:\s|$)/i.test(line);
}

/** Interpreta os args de `/secret`. NUNCA inclui os tokens recebidos em mensagens. */
export function parseSecretArgs(args: string): SecretCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'usage' };
  const head = tokens[0]!;
  if (head === 'list') {
    return tokens.length === 1 ? { kind: 'list' } : { kind: 'inline-value' };
  }
  if (head === 'remove' || head === 'rm') {
    if (tokens.length === 1) return { kind: 'error', message: 'uso: /secret remove <NOME>' };
    if (tokens.length > 2) return { kind: 'inline-value' };
    const name = tokens[1]!;
    const v = validateSecretName(name);
    return v.ok ? { kind: 'remove', name } : { kind: 'error', message: v.message };
  }
  const flags = tokens.slice(1).filter((t) => FLAGS.has(t));
  const extra = tokens.slice(1).filter((t) => !FLAGS.has(t));
  // Qualquer token que não seja flag depois do NOME é, por definição, um VALOR digitado em aberto.
  if (extra.length > 0) return { kind: 'inline-value' };
  const v = validateSecretName(head);
  if (!v.ok) {
    // Um "nome" longo/estranho provavelmente é o valor colado no lugar do nome: trata igual.
    return head.length > 64 || /[^A-Za-z0-9_]/.test(head)
      ? { kind: 'inline-value' }
      : { kind: 'error', message: v.message };
  }
  return {
    kind: 'prompt',
    name: head,
    save: flags.includes('--save'),
    force: flags.includes('--force'),
  };
}

export type SecretSubmitResult =
  | { readonly ok: true; readonly weak: boolean; readonly saved: boolean; readonly note?: string }
  | { readonly ok: false; readonly message: string };

export interface SecretsServiceOptions {
  /** Raiz do projeto — escopo do `--save`. */
  readonly projectDir: string;
  readonly vault?: SecretVault;
  /** Cofre cifrado injetável (teste: aponta para um tmp; nunca o ~/.aluy real). */
  readonly fileVault?: FileVaultOptions;
}

/** Cofre da sessão + persistência opcional (`--save`) no arquivo CIFRADO, por projeto. */
export class SecretsService {
  private readonly vault: SecretVault;
  private readonly account: string;
  private readonly fileVault: FileVaultOptions;
  /** Nomes que estão (também) no cofre cifrado deste projeto. */
  private readonly saved = new Set<string>();

  constructor(opts: SecretsServiceOptions) {
    this.vault = opts.vault ?? defaultVault;
    this.fileVault = opts.fileVault ?? {};
    let dir = opts.projectDir;
    try {
      dir = realpathSync(dir);
    } catch {
      /* usa como veio */
    }
    // Namespace PRÓPRIO (`secrets:`), distinto do login/BYO/conector; um blob por projeto.
    this.account = `secrets:${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`;
  }

  /** Guarda o segredo (memória) e, com `save`, no cofre cifrado. O `value` nunca é devolvido. */
  submit(
    name: string,
    value: string,
    opts: { readonly save?: boolean; readonly force?: boolean } = {},
  ): SecretSubmitResult {
    const r = this.vault.set(name, value, opts.force === true ? { force: true } : {});
    if (!r.ok) return { ok: false, message: r.message };
    if (opts.save !== true) {
      // Troca de valor sem --save: o salvo antigo ficaria divergente — remove-o do cofre cifrado.
      if (this.saved.has(name)) this.persist(name, undefined);
      return { ok: true, weak: r.weak, saved: false };
    }
    const err = this.persist(name, value);
    if (err !== undefined) {
      return {
        ok: true,
        weak: r.weak,
        saved: false,
        note: `valor guardado SÓ nesta sessão — não consegui salvar no cofre cifrado: ${err}`,
      };
    }
    return { ok: true, weak: r.weak, saved: true };
  }

  remove(name: string): { readonly removed: boolean; readonly wasSaved: boolean } {
    const removed = this.vault.remove(name);
    const wasSaved = this.saved.has(name);
    if (wasSaved) this.persist(name, undefined);
    return { removed, wasSaved };
  }

  /** Só os NOMES (e se estão salvos). */
  list(): readonly { readonly name: string; readonly saved: boolean }[] {
    return this.vault.names().map((name) => ({ name, saved: this.saved.has(name) }));
  }

  /** Boot: carrega os segredos salvos DESTE projeto para a memória. Devolve quantos. */
  loadSaved(): number {
    const map = this.readMap();
    let n = 0;
    for (const [name, value] of Object.entries(map)) {
      if (typeof value !== 'string') continue;
      // `force`: o valor já foi aceito um dia (o aviso de "curto" foi dado na gravação).
      if (this.vault.set(name, value, { force: true }).ok) {
        this.saved.add(name);
        n += 1;
      }
    }
    return n;
  }

  private readMap(): Record<string, unknown> {
    try {
      const r = readFileVaultAccount(this.account, this.fileVault);
      if (r.valor === undefined) return {};
      const parsed: unknown = JSON.parse(r.valor);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** `undefined` ⇒ ok; senão a mensagem do erro (sem o valor). */
  private persist(name: string, value: string | undefined): string | undefined {
    try {
      const map = this.readMap();
      if (value === undefined) delete map[name];
      else map[name] = value;
      writeFileVaultAccount(this.account, JSON.stringify(map), this.fileVault);
      if (value === undefined) this.saved.delete(name);
      else this.saved.add(name);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
}
