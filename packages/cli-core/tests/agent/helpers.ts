// Fakes p/ os testes do engine de agente (EST-0944) — SEM rede, SEM filesystem.
//
// Tudo injetável: o `ModelCaller` é roteirizado (sequência de respostas), as
// portas de I/O são in-memory, e os engines de permissão são triviais. Assim os
// testes exercitam a LÓGICA do loop/gate/tetos/idempotency de forma determinística.

import type { ChatMessage, ModelCallResult, NativeToolCall } from '../../src/model/types.js';
import type { ModelCaller } from '../../src/agent/loop.js';
import type {
  CwdPort,
  FileSystemPort,
  GlobOutcome,
  GlobTruncation,
  SearchMatch,
  SearchPort,
  SearchOutcome,
  SearchTruncation,
  ShellChunk,
  ShellExecOptions,
  ShellPort,
  ShellResult,
  ToolPorts,
} from '../../src/agent/tools/types.js';
import type { PermissionEngine, PermissionVerdict, ToolCall } from '../../src/permission/gate.js';

/** Registro de uma chamada ao modelo (p/ asserções de idempotency-key/retry). */
export interface ModelCallRecord {
  readonly idempotencyKey: string;
  readonly messageCount: number;
  readonly lastUserContent: string | undefined;
  readonly systemContent: string | undefined;
  // EST-0996 — as mensagens INTEIRAS desta chamada, p/ asserções de native tools:
  // o canal `tool` (`role:"tool"` + `tool_call_id`) e o eco `assistant` com `tool_calls`.
  readonly messages: readonly ChatMessage[];
}

/**
 * `ModelCaller` roteirizado: devolve, na ordem, as respostas dadas. Cada item é
 * o texto do modelo (e tokens opcionais). Registra cada chamada (incl. a key).
 * Opcionalmente, um item pode LANÇAR (p/ testar retry de transporte).
 */
export type ScriptItem =
  | { readonly text: string; readonly tokensIn?: number; readonly tokensOut?: number }
  // EST-0996 — item que devolve tool_calls NATIVAS (estruturadas), opcionalmente com
  // texto/prosa junto. Simula um broker/modelo com suporte a function-calling nativo.
  | {
      readonly toolCalls: readonly NativeToolCall[];
      readonly text?: string;
      readonly tokensIn?: number;
      readonly tokensOut?: number;
    }
  | { readonly throws: unknown };

export class ScriptedModelCaller implements ModelCaller {
  readonly calls: ModelCallRecord[] = [];
  private idx = 0;

  constructor(private readonly script: readonly ScriptItem[]) {}

  async call(args: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ModelCallResult> {
    const system = args.messages.find((m) => m.role === 'system');
    const lastUser = [...args.messages].reverse().find((m) => m.role === 'user');
    this.calls.push({
      idempotencyKey: args.idempotencyKey,
      messageCount: args.messages.length,
      lastUserContent: lastUser?.content,
      systemContent: system?.content,
      messages: args.messages,
    });
    const item = this.script[this.idx];
    this.idx += 1;
    if (item === undefined) {
      // roteiro esgotado ⇒ responde "final" vazio (evita loop infinito no teste).
      return result('', 0, 0);
    }
    if ('throws' in item) throw item.throws;
    if ('toolCalls' in item) {
      return result(item.text ?? '', item.tokensIn ?? 0, item.tokensOut ?? 0, item.toolCalls);
    }
    return result(item.text, item.tokensIn ?? 0, item.tokensOut ?? 0);
  }
}

function result(
  content: string,
  tokensIn: number,
  tokensOut: number,
  toolCalls?: readonly NativeToolCall[],
): ModelCallResult {
  return {
    request_id: 'req-test',
    content,
    finish_reason: 'stop',
    usage: {
      request_id: 'req-test',
      tier: 'aluy-flux',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    },
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
  };
}

/** Filesystem in-memory. */
export class MemoryFs implements FileSystemPort {
  constructor(private readonly files = new Map<string, string>()) {}
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  /** Acesso de teste ao estado. */
  snapshot(): Map<string, string> {
    return new Map(this.files);
  }
}

/** Shell fake — registra os comandos executados (p/ provar não-execução). */
export class RecordingShell implements ShellPort {
  readonly executed: string[] = [];
  // EST-0982 — registra também o que a tool passou em `options` (signal/onChunk),
  // p/ provar a PROPAGAÇÃO do abort e do streaming pela tool ao chegar na porta.
  readonly lastSignal: (AbortSignal | undefined)[] = [];
  readonly lastHadOnChunk: boolean[] = [];
  constructor(private readonly responder: (cmd: string) => ShellResult = () => ok()) {}
  async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
    this.executed.push(command);
    this.lastSignal.push(options?.signal);
    this.lastHadOnChunk.push(typeof options?.onChunk === 'function');
    return this.responder(command);
  }
}

/**
 * EST-0982 — shell fake que EMITE chunks (streaming) p/ o `onChunk` que a tool
 * passa, e devolve um `ShellResult`. Prova que a saída streamada/coletada passa
 * pela REDAÇÃO (CLI-SEC-6) da tool — os `rawChunks` aqui carregam segredos em claro
 * e o teste confere que o que a tool repassa adiante já está redigido.
 */
export class StreamingShell implements ShellPort {
  constructor(
    private readonly rawChunks: readonly ShellChunk[],
    private readonly final: ShellResult,
  ) {}
  async exec(_command: string, options?: ShellExecOptions): Promise<ShellResult> {
    for (const c of this.rawChunks) options?.onChunk?.(c);
    return this.final;
  }
}
function ok(stdout = ''): ShellResult {
  return { stdout, stderr: '', exitCode: 0 };
}

/**
 * EST-0982 — CwdPort fake in-memory: modela o `sessionCwd` + o CLAMP na raiz por
 * prefixo de string (sem fs). `setCwd('..'` no topo fica na raiz; um alvo que sai da
 * raiz é clampado; um nome inexistente lança (a tool reporta o erro). Suficiente p/
 * provar a SEMÂNTICA da tool `change_dir` (o confinamento REAL com fs/realpath é
 * provado no `workspace-session-cwd.test.ts` do @aluy/cli).
 */
export class MemoryCwd implements CwdPort {
  private session: string;
  constructor(
    readonly root = '/ws',
    private readonly dirs: ReadonlySet<string> = new Set([
      '/ws',
      '/ws/ecommerce-app',
      '/ws/ecommerce-app/data',
      '/ws/src',
    ]),
  ) {
    this.session = root;
  }
  get cwd(): string {
    return this.session;
  }
  setCwd(requested: string): string {
    // resolve relativo ao cwd corrente (ou absoluto), normaliza `.`/`..` lexicamente.
    const base = requested.startsWith('/') ? requested : `${this.session}/${requested}`;
    const parts: string[] = [];
    for (const seg of base.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    let resolved = '/' + parts.join('/');
    if (resolved === '/') resolved = '';
    // CLAMP na raiz: se sai da raiz, volta p/ a raiz (nunca escapa).
    if (resolved !== this.root && !resolved.startsWith(this.root + '/')) {
      resolved = this.root;
    }
    if (!this.dirs.has(resolved)) {
      throw new Error(`não é um diretório existente: ${requested}`);
    }
    this.session = resolved;
    return resolved;
  }
}

/** Search fake. EST-1016 — devolve `{ matches, truncated }`; `truncated` injetável p/ testes. */
export class MemorySearch implements SearchPort {
  constructor(
    private readonly matches: readonly SearchMatch[] = [],
    private readonly truncated: SearchTruncation = {},
  ) {}
  async search(): Promise<SearchOutcome> {
    return { matches: this.matches, truncated: this.truncated };
  }
}

/**
 * EST-0944 — Search fake COM `glob` (a maioria dos fakes só implementa `search`; este
 * cobre o caminho da tool `glob`). `paths`/`truncated` injetáveis p/ testar 0-acertos,
 * truncamento e o caminho feliz sem filesystem.
 */
export class MemorySearchWithGlob extends MemorySearch {
  constructor(
    private readonly globPaths: readonly string[] = [],
    private readonly globTruncated: GlobTruncation = {},
  ) {
    super();
  }
  async glob(): Promise<GlobOutcome> {
    return { paths: this.globPaths, truncated: this.globTruncated };
  }
}

export function makePorts(over?: Partial<ToolPorts>): {
  ports: ToolPorts;
  fs: MemoryFs;
  shell: RecordingShell;
} {
  const fs = (over?.fs as MemoryFs) ?? new MemoryFs();
  const shell = (over?.shell as RecordingShell) ?? new RecordingShell();
  const search = over?.search ?? new MemorySearch();
  return {
    ports: {
      fs,
      shell,
      search,
      // EST-0982 — `cwd` só entra no ports se o teste injetar (a tool `change_dir`
      // é inerte sem ela — não-regressão dos testes que não usam navegação).
      ...(over?.cwd ? { cwd: over.cwd } : {}),
    },
    fs,
    shell,
  };
}

/** Engine que permite tudo (p/ exercitar o caminho feliz do loop). */
export const allowAllEngine: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict => ({ decision: 'allow', reason: `allow:${c.name}` }),
};

/** Engine que nega tudo (prova CLI-SEC-H1: efeito não acontece). */
export const denyAllTestEngine: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict => ({ decision: 'deny', reason: `deny:${c.name}` }),
};

/** Engine que só permite tools de leitura (read_file/grep) — nega efeito. */
export const allowReadOnlyEngine: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict =>
    c.name === 'read_file' || c.name === 'grep'
      ? { decision: 'allow', reason: 'read-only ok' }
      : { decision: 'deny', reason: 'efeito bloqueado (read-only)' },
};

/** Monta o bloco de tool-call no formato NATIVO do protocolo. */
export function toolCallBlock(name: string, input: Record<string, unknown>): string {
  return `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name, input })}\nALUY_TOOL_CALL>>>`;
}

/**
 * EST-0944 — monta o bloco no formato `<tool_call>{json}</tool_call>` (o que
 * modelos como o mimo-v2.5-pro emitem por derrapar p/ o formato do treino).
 * Mesmo contrato `{ name, input }`. `spaced` adiciona espaços/newlines em volta
 * do JSON (variação comum que o parser deve tolerar).
 */
export function altToolCallBlock(
  name: string,
  input: Record<string, unknown>,
  spaced = false,
): string {
  const json = JSON.stringify({ name, input });
  return spaced ? `<tool_call> ${json} </tool_call>` : `<tool_call>${json}</tool_call>`;
}
