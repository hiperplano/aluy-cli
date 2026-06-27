// Helpers de teste da auth: mock de `fetch` (sem rede) e store em memória.
import type { FetchLike } from '../../src/auth/identity-client.js';
import type { CredentialStore } from '../../src/auth/credential-store.js';
import type { StoredCredential } from '../../src/auth/types.js';

export interface MockResponse {
  status: number;
  body?: unknown;
  /**
   * HUNT-IO-NET: quando `true`, `res.json()` REJEITA (como o `fetch` REAL do Node faz
   * com um corpo não-JSON / vazio / truncado num 200). O mock antigo NUNCA rejeitava
   * (`json: async () => body`), mascarando o `res.json()` sem try/catch do cliente.
   */
  jsonThrows?: boolean;
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * `fetch` mockado: roteia por URL+sequência. `handlers` mapeia path → resposta
 * (ou fila de respostas, consumida em ordem — útil p/ polling pending→success).
 */
export function makeMockFetch(handlers: Record<string, MockResponse | MockResponse[]>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queues = new Map<string, MockResponse[]>();
  for (const [path, val] of Object.entries(handlers)) {
    queues.set(path, Array.isArray(val) ? [...val] : [val]);
  }

  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const queue = queues.get(path);
    if (!queue || queue.length === 0) {
      throw new Error(`mock fetch: sem resposta para ${path}`);
    }
    const resp = queue.length === 1 ? queue[0]! : queue.shift()!;
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      json: async () => {
        if (resp.jsonThrows) {
          // Espelha o `fetch` REAL: corpo não-JSON / vazio ⇒ SyntaxError.
          throw new SyntaxError('Unexpected end of JSON input');
        }
        return resp.body;
      },
      text: async () =>
        resp.jsonThrows ? '<html>502 Bad Gateway</html>' : JSON.stringify(resp.body),
    };
  };

  return { fetch, calls };
}

/** Store EM MEMÓRIA — os testes NUNCA tocam disco nem keychain real. */
export class InMemoryStore implements CredentialStore {
  private cred: StoredCredential | null = null;
  /** snapshot do que foi gravado — p/ asserts de "nada em claro vazou pra fora". */
  readonly writes: string[] = [];

  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(credential: StoredCredential): Promise<void> {
    this.cred = credential;
    this.writes.push(JSON.stringify(credential));
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}
