import type { CredentialStore, FetchLike, StoredCredential } from '@aluy/cli-core';
import type { TerminalIO } from '../../src/auth/io.js';

/** Resposta mockada por path (ou fila de respostas em ordem). */
export interface MockResponse {
  status: number;
  body?: unknown;
}

/** `fetch` mockado por path — espelha o helper do cli-core. */
export function makeMockFetch(handlers: Record<string, MockResponse | MockResponse[]>): FetchLike {
  const queues = new Map<string, MockResponse[]>();
  for (const [path, val] of Object.entries(handlers)) {
    queues.set(path, Array.isArray(val) ? [...val] : [val]);
  }
  return async (url) => {
    const path = new URL(url).pathname;
    const queue = queues.get(path);
    if (!queue || queue.length === 0) {
      throw new Error(`mock fetch: sem resposta para ${path}`);
    }
    const resp = queue.length === 1 ? queue[0]! : queue.shift()!;
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  };
}

/** IO fake que captura o que foi escrito — p/ asserts (e p/ varrer segredos). */
export class FakeIO implements TerminalIO {
  readonly outLines: string[] = [];
  readonly errLines: string[] = [];
  private readonly answers: string[];

  constructor(answers: string[] = []) {
    this.answers = [...answers];
  }
  out(line: string): void {
    this.outLines.push(line);
  }
  err(line: string): void {
    this.errLines.push(line);
  }
  async prompt(): Promise<string> {
    return this.answers.shift() ?? '';
  }
  /** Tudo que saiu (stdout+stderr) — usado p/ varredura de "nada em claro". */
  allText(): string {
    return [...this.outLines, ...this.errLines].join('\n');
  }
}

/** Store em memória (NUNCA toca keychain/disco). */
export class InMemoryStore implements CredentialStore {
  cred: StoredCredential | null = null;
  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(credential: StoredCredential): Promise<void> {
    this.cred = credential;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}
