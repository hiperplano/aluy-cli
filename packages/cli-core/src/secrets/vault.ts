// ADR 0005 — COFRE DE SEGREDOS DA SESSÃO (`/secret`).
//
// O dono entrega um segredo ao agente SEM ele passar pelo texto do chat, pelo contexto
// do modelo, pelos arquivos de sessão, pelo histórico ou por logs. O modelo só aprende o
// NOME (`$API_KEY`); o VALOR existe aqui, em memória, e sai por exatamente dois caminhos:
//
//   1. como variável de ambiente `$NAME` no shell que roda o comando (`run_command`,
//      `watch_command`, `!`) — e, para comandos do MODELO, só quando o texto do comando
//      CITA o nome (e aí a catraca pergunta: `always-ask:secret-use`);
//   2. como alvo da REDAÇÃO EXATA: toda saída que passa por `redactCommandSecrets` /
//      `redactOutputSecrets` (o ponto único de CLI-SEC-6) tem o valor trocado por
//      `‹redigido›`, além das regras por padrão.
//
// PORTÁVEL (ADR-0053 §8): puro, sem `node:*` além de `Buffer` (global), sem I/O. A
// persistência `--save` (cofre cifrado) mora no pacote `cli`.
//
// LIMITES HONESTOS (ver docs/decisions/0005):
//   - um comando do MODELO pode TRANSFORMAR o valor (base64, rev, fatiar) e escapar da
//     redação por valor exato;
//   - o valor chega a qualquer processo que o comando lance;
//   - JS não garante apagar memória: o `Buffer` é zerado ao remover, mas cópias
//     transitórias em `string` (necessárias para comparar/exportar) ficam até o GC.

/** O marcador que substitui um valor redigido (mesmo de `journal/redact.ts`). */
export const SECRET_REDACTED = '‹redigido›';

/** Tamanho mínimo do valor aceito sem `force` (valores curtos redigem lixo: "123"). */
export const MIN_SECRET_LENGTH = 8;

/** Teto do valor (anti-abuso de memória; chaves/PEM cabem folgado). */
export const MAX_SECRET_LENGTH = 16_384;

/** Nomes de ambiente que NUNCA podem ser sobrescritos por um segredo (sequestro de shell). */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'IFS',
  'TERM',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'PS1',
]);

/** NAME = estilo env, maiúsculo: `API_KEY`, `DB_PASSWORD`. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export type SecretSetResult =
  | { readonly ok: true; readonly weak: boolean }
  | {
      readonly ok: false;
      readonly code: 'bad-name' | 'reserved-name' | 'empty' | 'too-short' | 'too-long';
      readonly message: string;
    };

/** Valida só o nome (sem tocar o cofre). */
export function validateSecretName(
  name: string,
): { ok: true } | { ok: false; code: 'bad-name' | 'reserved-name'; message: string } {
  if (!SECRET_NAME_RE.test(name)) {
    return {
      ok: false,
      code: 'bad-name',
      // NÃO ecoa o que foi digitado: quem erra o comando pode ter colado o VALOR no lugar do nome.
      message: 'nome inválido: use MAIÚSCULAS, dígitos e _ (ex.: API_KEY), começando por letra',
    };
  }
  if (RESERVED_NAMES.has(name)) {
    return {
      ok: false,
      code: 'reserved-name',
      message: `"${name}" é uma variável de ambiente reservada do sistema — escolha outro nome`,
    };
  }
  return { ok: true };
}

/** As formas em que o valor pode aparecer num texto (cru e escapado p/ JSON). */
function variantsOf(value: string): string[] {
  const out = [value];
  const json = JSON.stringify(value).slice(1, -1);
  if (json !== value) out.push(json);
  return out;
}

export class SecretVault {
  private readonly entries = new Map<string, Buffer>();

  /** Guarda (ou troca) o valor. O chamador nunca deve logar `value`. */
  set(name: string, value: string, opts: { readonly force?: boolean } = {}): SecretSetResult {
    const v = validateSecretName(name);
    if (!v.ok) return v;
    if (value === '') {
      return { ok: false, code: 'empty', message: 'valor vazio — nada foi guardado' };
    }
    if (value.length > MAX_SECRET_LENGTH) {
      return {
        ok: false,
        code: 'too-long',
        message: `valor longo demais (máx. ${MAX_SECRET_LENGTH} caracteres)`,
      };
    }
    const weak = value.length < MIN_SECRET_LENGTH;
    if (weak && opts.force !== true) {
      return {
        ok: false,
        code: 'too-short',
        message:
          `valor com menos de ${MIN_SECRET_LENGTH} caracteres: a redação por valor exato ` +
          `trocaria trechos comuns da saída por ${SECRET_REDACTED} e não protege de verdade. ` +
          `Para guardar mesmo assim, use /secret ${name} --force.`,
      };
    }
    this.wipe(name);
    this.entries.set(name, Buffer.from(value, 'utf8'));
    return { ok: true, weak };
  }

  /** Remove e ZERA o buffer. `true` se existia. */
  remove(name: string): boolean {
    return this.wipe(name);
  }

  /** Remove e zera TUDO (saída da sessão, `/clear full`). */
  clear(): void {
    for (const n of [...this.entries.keys()]) this.wipe(n);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Só os NOMES (ordenados) — é tudo que a UI e o prompt podem ver. */
  names(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  /** O valor, para exportar como env var. Uso restrito à porta de shell. */
  valueOf(name: string): string | undefined {
    return this.entries.get(name)?.toString('utf8');
  }

  /** Nomes CITADOS no texto (fronteira de identificador: `API_KEY` ≠ `MY_API_KEY_2`). */
  referencedBy(text: string): readonly string[] {
    if (this.entries.size === 0 || text === '') return [];
    const out: string[] = [];
    for (const name of this.entries.keys()) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
      if (re.test(text)) out.push(name);
    }
    return out.sort();
  }

  /** Env a exportar para UM comando: só os segredos que o texto cita. */
  envFor(command: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.referencedBy(command)) {
      const v = this.valueOf(name);
      if (v !== undefined) env[name] = v;
    }
    return env;
  }

  /** Env de TODOS os segredos — só para o `!` do dono (ação explícita, ADR 0003/0005). */
  envAll(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.entries.keys()) {
      const v = this.valueOf(name);
      if (v !== undefined) env[name] = v;
    }
    return env;
  }

  /**
   * REDAÇÃO EXATA: troca toda ocorrência de cada valor (cru e escapado p/ JSON) por
   * `‹redigido›`. Mais longos primeiro (um valor que contém outro não vaza o resto).
   * Sem segredos ⇒ devolve o texto intacto (custo zero no caminho comum).
   */
  redact(text: string): string {
    if (this.entries.size === 0 || text === '') return text;
    let out = text;
    for (const v of this.sortedVariants()) {
      if (out.includes(v)) out = out.split(v).join(SECRET_REDACTED);
    }
    return out;
  }

  /**
   * Para redação em STREAM: o maior sufixo de `text` que é PREFIXO PRÓPRIO de algum
   * valor (cru/escapado) — pode ser o começo de um segredo cujo resto vem no próximo
   * chunk. Devolve o tamanho desse sufixo (0 se nenhum).
   */
  pendingSuffixLength(text: string): number {
    if (this.entries.size === 0 || text === '') return 0;
    let best = 0;
    for (const v of this.sortedVariants()) {
      const max = Math.min(v.length - 1, text.length);
      for (let n = max; n > best; n--) {
        if (text.endsWith(v.slice(0, n))) {
          best = n;
          break;
        }
      }
    }
    return best;
  }

  private sortedVariants(): string[] {
    const all: string[] = [];
    for (const buf of this.entries.values()) all.push(...variantsOf(buf.toString('utf8')));
    return all.sort((a, b) => b.length - a.length);
  }

  private wipe(name: string): boolean {
    const buf = this.entries.get(name);
    if (!buf) return false;
    buf.fill(0);
    this.entries.delete(name);
    return true;
  }
}

/**
 * O cofre da sessão (singleton do processo). Singleton de propósito: a redação precisa
 * valer em TODOS os caminhos que já chamam `redactOutputSecrets` sem threading de
 * parâmetro — é o que faz dela um ponto único em vez de N pontos a lembrar.
 */
export const secretVault = new SecretVault();

/** Redação EXATA pelo cofre da sessão (atalho p/ sinks que só querem o valor exato). */
export function redactSecretValues(text: string): string {
  return secretVault.redact(text);
}

/**
 * Redator de STREAM por valor exato. Um segredo partido entre dois chunks
 * (`…sk-abc` | `def…`) não casa em nenhum dos dois isoladamente: este redator RETÉM o
 * sufixo que pode ser começo de segredo até o próximo chunk decidir. `push` devolve o
 * que já é seguro emitir; `flush` devolve o retido (chamar no fim do fluxo).
 */
export class StreamRedactor {
  private held = '';

  constructor(private readonly vault: SecretVault = secretVault) {}

  push(chunk: string): string {
    const buf = this.vault.redact(this.held + chunk);
    const keep = this.vault.pendingSuffixLength(buf);
    this.held = keep > 0 ? buf.slice(buf.length - keep) : '';
    return keep > 0 ? buf.slice(0, buf.length - keep) : buf;
  }

  flush(): string {
    const rest = this.held;
    this.held = '';
    return this.vault.redact(rest);
  }
}
