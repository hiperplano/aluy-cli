// EST-1132 · ADR-0123 §2.2/Inv. II · G2 (CA-G2-6/7/8) — cliente concreto
// MemoryEngine → Mem0 OSS local via HTTP loopback.
//
// Implementa a porta `MemoryEngine` do `@aluy/cli-core` (contrato puro, ZERO I/O)
// com um cliente HTTP que fala com o Mem0 self-hosted rodando na máquina local.
// scope ↔ `user_id` do Mem0 (CAIXA de contexto §4.3).
//
// TRAVAS DURAS (gate G2 · AG-0008):
//   CA-G2-6 (egress): loopback-only via malha anti-SSRF CLI-SEC-13.
//     `classifyHeadroomTarget` resolve o host → exige que TODOS os IPs sejam
//     loopback (`isLoopbackIp`) → conecta ao IP pinado (`NodePinnedFetcher`,
//     sem re-resolver). Formas canônicas (`2130706433`, `[::1]`,
//     `[::ffff:127.0.0.1]`) conectam; DNS-rebind (IP misto) barrado; URL
//     externa, metadata-cloud ⇒ barrado.
//   CA-G2-7 (recall=DADO, sem credencial): o Mem0 NÃO recebe credencial, NÃO
//     resolve tier/quota/markup/ledger (CLI-SEC-7). Conteúdo enviado é redigido
//     (CLI-SEC-6). Saída (recall) é DADO envelopado (CLI-SEC-4/CLI-SEC-15-B),
//     nunca `system`.
//   CA-G2-8 (store em repouso): path-deny CLI-SEC-6/15-C, store `~/.aluy/memory`
//     com perms `0700`/`0600`. read_file/grep/cat do store NEGADOS.
//
// Degradação fail-open (CA-MA8): Mem0 ausente/timeout ⇒ opera sem recall
// (retorna hits vazios, scope vazio).
//
// FORA de escopo: spawn/auto-up do server Mem0 → EST-1129 (boot-supervisor).
// Esta ficha consome um Mem0 já-up.

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import type {
  MemoryEngine,
  MemoryAddInput,
  MemoryAddResult,
  MemorySearchInput,
  MemorySearchResult,
  MemorySearchHit,
  MemoryScopeInput,
  MemoryScopeResult,
  MemoryScopeInfo,
} from '@aluy/cli-core';

import {
  classifyHeadroomTarget,
  MEM0_PORT,
  type HeadroomTargetResult,
  type HostResolver,
  type PinnedFetcher,
} from '@aluy/cli-core';

import { NodeHostResolver, NodePinnedFetcher } from './web-port.js';

// ── Constantes ────────────────────────────────────────────────────────────

/** Diretório do store vetorial do Mem0. */
const MEMORY_DIRNAME = 'memory';

/** Permissão de diretório: 0700 (dono-only). */
const DIR_MODE = 0o700;

/** URL default do Mem0 (loopback) — derivada do `MEM0_PORT` (sem magic number cru). */
const DEFAULT_MEM0_URL = `http://127.0.0.1:${MEM0_PORT}`;

/** Timeout HTTP (ms) — fail-open rápido. */
const HTTP_TIMEOUT_MS = 5_000;

/** Teto de bytes da resposta (Mem0 JSON é pequeno; 1 MiB folgado). */
const MAX_BYTES = 1_048_576;

/** User-agent HTTP. */
const UA = 'aluy-vau/0.1 (Mem0MemoryEngine; EST-1132)';

// ── Tipos internos ────────────────────────────────────────────────────────

/** Resposta do Mem0 para add memory. */
interface Mem0AddResponse {
  id?: string;
  message?: string;
}

/** Item de memória na resposta de search do Mem0. */
interface Mem0MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  score?: number;
}

/** Resposta do Mem0 para search. */
interface Mem0SearchResponse {
  results?: Mem0MemoryItem[];
}

/** Resposta do Mem0 para list users (scopes). */
interface Mem0UserItem {
  user_id: string;
  memory_count?: number;
  created_at?: string;
}

// ── Construtor ────────────────────────────────────────────────────────────

export interface Mem0MemoryEngineOptions {
  /**
   * URL base do Mem0 (default: `http://127.0.0.1:11435`).
   * Loopback-only validado via anti-SSRF (CLI-SEC-13) na 1ª chamada.
   */
  readonly mem0Url?: string;

  /**
   * Raiz do `~/.aluy/` (default `<home>/.aluy`).
   * Injetável p/ teste (tmpdir) — suíte nunca toca store real do dev.
   */
  readonly baseDir?: string;

  /**
   * Resolvedor de DNS (porta). Default: `NodeHostResolver`.
   * Injetável p/ teste.
   */
  readonly resolver?: HostResolver;

  /**
   * Fetcher pinado anti-SSRF (porta). Default: `NodePinnedFetcher`.
   * Injetável p/ teste.
   */
  readonly fetcher?: PinnedFetcher;
  /**
   * Fetch para o DELETE (o `PinnedFetcher` só faz GET|POST). Default: `fetch`
   * global. Injetável p/ teste — sem isto o DELETE não é mockável e o teste de
   * degradação CA-MA8 depende de "nada na porta".
   */
  readonly deleteFetch?: typeof fetch;
}

// ── Implementação ─────────────────────────────────────────────────────────

export class Mem0MemoryEngine implements MemoryEngine {
  private readonly mem0Url: string;
  private readonly base: string;
  private readonly memoryDir: string;
  private readonly resolver: HostResolver;
  private readonly fetcher: PinnedFetcher;
  private readonly deleteFetch: typeof fetch;

  /**
   * Cache da classificação anti-SSRF (lazy — 1ª chamada de rede dispara DNS;
   * resultado cacheado para sempre).
   */
  private targetCache?: Promise<HeadroomTargetResult>;

  constructor(opts: Mem0MemoryEngineOptions = {}) {
    const url = opts.mem0Url ?? DEFAULT_MEM0_URL;

    // Valida sintaxe de URL (sync, barato). A validação real de loopback
    // é ASSÍNCRONA (DNS) e roda na 1ª chamada de rede (CLI-SEC-13).
    try {
      new URL(url);
    } catch {
      throw new Error(`Mem0MemoryEngine: URL inválida — ${url}`);
    }

    this.mem0Url = url.replace(/\/$/, '');
    this.resolver = opts.resolver ?? new NodeHostResolver();
    this.fetcher = opts.fetcher ?? new NodePinnedFetcher();
    this.deleteFetch = opts.deleteFetch ?? ((input, init) => fetch(input, init));
    this.base = opts.baseDir ?? join(homedir(), '.aluy');
    this.memoryDir = join(this.base, MEMORY_DIRNAME);

    // CA-G2-8: garante dir 0700 (idempotente, fail-safe).
    this.ensureMemoryDir();
  }

  // ── Porta MemoryEngine ──────────────────────────────────────────────────

  /** @inheritdoc */
  async add(input: MemoryAddInput): Promise<MemoryAddResult> {
    const { content, scope, metadata } = input;

    // Converte MemoryContent[] → messages (formato Mem0).
    const messages = content.map((c) => ({
      role: 'user' as const,
      content: c.text,
    }));

    const body: Record<string, unknown> = {
      user_id: scope,
      messages,
    };
    if (metadata) {
      body.metadata = metadata;
    }

    try {
      const resp = await this.pinnedJson<Mem0AddResponse>(`/v1/memories/`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      // MemoryAddResult.ids: ids de cada item adicionado (ordem ≡ input).
      const ids = content.map((_, i) =>
        resp.id ? `${resp.id}-${i}` : `${scope}-${Date.now()}-${i}`,
      );
      return { ids };
    } catch {
      // CA-MA8: degrada — add falhou, mas não quebra o loop.
      return { ids: [] };
    }
  }

  /** @inheritdoc */
  async search(input: MemorySearchInput): Promise<MemorySearchResult> {
    const { scopes, query, limit = 10 } = input;

    // Mem0 suporta um `user_id` por vez. Se múltiplos scopes, faz N chamadas e
    // mergeia. F83 — as N chamadas rodam em PARALELO (não sequencial): o recall é
    // dual-scope desde o F80 (novo + legado) e tem teto DURO de 2.5s no loop (F78);
    // sequencial, 2 chamadas somavam a latência e estouravam o teto ⇒ recall vazio
    // mesmo com o mem0 no ar. Paralelo, a latência é ~max(chamadas), não a soma.
    // Cada scope degrada SOZINHO (CA-MA8): a falha de um não derruba os outros.
    const scopeList = scopes.length > 0 ? scopes : ['default'];
    const perScope = await Promise.all(
      scopeList.map(async (scope): Promise<Mem0MemoryItem[]> => {
        try {
          // F99 — pede `limit` INTEIRO de CADA scope (não `limit/N`). O Mem0 ordena por
          // relevância POR scope; o corte final (`sort+slice(limit)`) escolhe o top-N
          // GLOBAL. Com `limit/N`, um scope concentrando as memórias era CAPADO em metade
          // (caso normal pós-F80: projeto cheio + legado vazio) ⇒ devolvia menos que o
          // pedido E trocava as mais-relevantes de um scope pelas menos-relevantes do
          // outro. O Mem0 é loopback/barato — sobre-buscar p/ cortar global é o certo.
          const params = new URLSearchParams({
            user_id: scope,
            query,
            limit: String(Math.max(1, limit)),
          });
          const resp = await this.pinnedJson<Mem0SearchResponse>(
            `/v1/memories/?${params.toString()}`,
            { method: 'GET' },
          );
          return resp.results ?? [];
        } catch {
          return []; // CA-MA8: degrada por scope — os outros seguem.
        }
      }),
    );
    const allResults: Mem0MemoryItem[] = perScope.flat();

    // Converte Mem0MemoryItem[] → MemorySearchHit[].
    // Recall = DADO envelopado (CLI-SEC-15-B) — nunca instrução.
    const hits = allResults.map(
      (item) =>
        ({
          id: item.id,
          text: item.memory,
          score: item.score ?? 0,
          ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
        }) as MemorySearchHit,
    );

    return {
      hits: hits.sort((a, b) => b.score - a.score).slice(0, limit),
    };
  }

  /** @inheritdoc */
  async scope(input: MemoryScopeInput): Promise<MemoryScopeResult> {
    const { operation } = input;

    switch (operation.kind) {
      case 'list': {
        try {
          const resp = await this.pinnedJson<{ users?: Mem0UserItem[] }>(`/v1/users/`, {
            method: 'GET',
          });

          const scopes = (resp.users ?? []).map(
            (u) =>
              ({
                scope: u.user_id,
                itemCount: u.memory_count ?? 0,
                ...(u.created_at ? { createdAt: new Date(u.created_at).getTime() } : {}),
              }) as MemoryScopeInfo,
          );

          return { scopes };
        } catch {
          // CA-MA8: degrada — retorna vazio.
          return { scopes: [] };
        }
      }

      case 'info': {
        try {
          const resp = await this.pinnedJson<Mem0SearchResponse>(
            `/v1/memories/?user_id=${encodeURIComponent(operation.scope)}&query=&limit=1000`,
            { method: 'GET' },
          );

          const results = resp.results ?? [];
          return {
            scopes: [
              {
                scope: operation.scope,
                itemCount: results.length,
              },
            ],
          };
        } catch {
          return {
            scopes: [{ scope: operation.scope, itemCount: 0 }],
          };
        }
      }

      case 'delete': {
        try {
          await this.pinnedDelete(`/v1/memories/?user_id=${encodeURIComponent(operation.scope)}`);
          return { deleted: true };
        } catch {
          // CA-MA8: degrada — reporta não deletado.
          return { deleted: false };
        }
      }

      default:
        return { scopes: [] };
    }
  }

  // ── Anti-SSRF: classificação + fetch pinado (CLI-SEC-13) ────────────────

  /**
   * CA-G2-6: classifica o destino via `classifyHeadroomTarget` —
   * resolve o host → exige que TODOS os IPs sejam loopback
   * (`isLoopbackIp`) → devolve o IP pinado.
   *
   * Lazy: a 1ª chamada de rede dispara DNS; resultado cacheado.
   * Lança se NÃO-loopback (barra DNS-rebind, metadata, externo).
   * Aceita formas canônicas: `2130706433`, `[::1]`, `[::ffff:127.0.0.1]`.
   */
  private async ensureTarget(): Promise<HeadroomTargetResult & { ok: true }> {
    if (!this.targetCache) {
      this.targetCache = classifyHeadroomTarget(this.mem0Url, this.resolver);
    }
    const result = await this.targetCache;
    if (!result.ok) {
      throw new Error(
        `Mem0MemoryEngine: egress só loopback (CA-G2-6). ` + `${result.reason}. Use 127.0.0.1.`,
      );
    }
    return result;
  }

  /**
   * Monta a URL base com IP PINADO (sem hostname — anti-DNS-rebinding).
   */
  private buildPinnedUrl(target: HeadroomTargetResult & { ok: true }): string {
    const port = new URL(this.mem0Url).port;
    const ipLiteral = target.pinnedIp.includes(':') ? `[${target.pinnedIp}]` : target.pinnedIp;
    return `${target.scheme}://${ipLiteral}${port ? `:${port}` : ''}`;
  }

  /**
   * GET/POST via `NodePinnedFetcher.fetchPinned()` — conecta ao IP
   * pinado SEM re-resolver (fecha DNS-rebinding, CLI-SEC-13).
   * CA-G2-7: SEM credencial no request.
   */
  private async pinnedJson<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
  ): Promise<T> {
    const target = await this.ensureTarget();
    const base = this.buildPinnedUrl(target);

    const result = await this.fetcher.fetchPinned({
      url: `${base}${path}`,
      host: target.host,
      pinnedIp: target.pinnedIp,
      maxBytes: MAX_BYTES,
      timeoutMs: HTTP_TIMEOUT_MS,
      method: init.method,
      ...(init.body !== undefined ? { body: init.body, contentType: 'application/json' } : {}),
    });

    if (result.status !== 200 && result.status !== 201) {
      throw new Error(`Mem0 HTTP ${result.status}`);
    }

    const text = result.body;
    if (!text || !text.trim()) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  /**
   * DELETE via `fetch()` direto com IP pinado.
   *
   * `PinnedFetcher.fetchPinned()` só aceita GET|POST (interface do core).
   * Como o target JÁ FOI validado como loopback pelo `classifyHeadroomTarget`,
   * é seguro usar `fetch()` com o IP pinado na URL — o destino é comprovadamente
   * loopback e não há DNS-rebinding (a URL usa o IP, não o hostname).
   */
  private async pinnedDelete(path: string): Promise<void> {
    const target = await this.ensureTarget();
    const base = this.buildPinnedUrl(target);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const resp = await this.deleteFetch(`${base}${path}`, {
        method: 'DELETE',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
      });

      if (!resp.ok) {
        throw new Error(`Mem0 HTTP ${resp.status}`);
      }

      // Drena o corpo (pode ser vazio).
      await resp.text();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Store em repouso ────────────────────────────────────────────────────

  /**
   * CA-G2-8: garante que o diretório de store (`~/.aluy/memory`) existe
   * com permissão `0700`. Idempotente, fail-safe.
   */
  private ensureMemoryDir(): void {
    // Cria a hierarquia ~/.aluy/ → ~/.aluy/memory/ com 0700.
    const aluyDir = this.base;
    try {
      mkdirSync(aluyDir, { mode: DIR_MODE, recursive: true });
    } catch {
      // Já existe ou não tem permissão — não quebra.
    }
    try {
      mkdirSync(this.memoryDir, { mode: DIR_MODE });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Não conseguiu criar e não existe — pode ser permissão.
        // Não quebra: a store é do Mem0 (serviço externo), o dir é só
        // um path-deny anchor. Degradação continua.
      }
    }
  }
}
