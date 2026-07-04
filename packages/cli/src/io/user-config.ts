// EST-0969 — CONFIG PERSISTENTE de PREFERÊNCIAS de UI do usuário (QoL): persiste a
// escolha de TEMA (`/theme`) e de TIER de modelo (`/model`) entre sessões, em
// `~/.aluy/config.json`. Hoje a troca vale só na sessão; reabrir o `aluy` voltava
// ao default. Aqui o estado mora FORA do workspace, no `~/.aluy/` confinado.
//
// É preferência de UI/tier — NUNCA credencial nem economia (CLI-SEC-7: binário
// público limpo). A credencial fica no keychain do SO (EST-0942 / CLI-SEC-2); o
// `tier` é a ÚNICA pista de modelo (HG-2: o broker resolve provider/credencial).
// Por isso este arquivo é seguro: só `theme`/`tier`, ambos strings de UI.
//
// Honra as MESMAS cravas do journal-store (EST-0960a / AG-0008):
//   - `0600`/`0700`: o dir `~/.aluy/` nasce com `mkdir(0700)`; o arquivo é escrito
//     ATÔMICO (temp `0600` + rename) — sem janela `0644`+chmod. `umask`
//     neutralizado no momento da criação (mode efetivo = mode pedido).
//   - FAIL-SAFE: config ausente/corrompido/ilegível ⇒ DEFAULTS, NUNCA lança. Uma
//     QoL jamais derruba o startup; pior caso = sessão no default (como hoje).
//   - `~/.aluy/` NUNCA é canal do agente (a path-deny do core já nega read/grep/
//     edit/run sobre `~/.aluy`). Este módulo é o leitor/escritor de kernel-de-
//     cliente, não um caminho que o agente alcance.
//   - sem segredo, sem log de conteúdo sensível: só preferências de UI.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  constants as fsConstants,
} from 'node:fs';
import { themeByName, type ThemeName } from '../ui/theme/themes.js';
import { langByCode, type Lang } from '../i18n/lang.js';
import { embedderSpec, DEFAULT_EMBEDDER_MODEL } from '@hiperplano/aluy-cli-core';

/** Permissões restritas: dir `0700`, arquivo `0600` (espelha o journal-store). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Nome do arquivo de config (dentro de `~/.aluy/`). */
export const CONFIG_FILENAME = 'config.json';

/**
 * As PREFERÊNCIAS persistidas. Ambos OPCIONAIS: a ausência de um campo ⇒ aquela
 * preferência cai no default na resolução. SÓ UI/tier — jamais credencial/segredo.
 */
export interface UserConfig {
  /** Tema nomeado salvo (`/theme`). Validado contra o catálogo na leitura. */
  readonly theme?: ThemeName;
  /**
   * Tier de modelo salvo (`/model`). Guardado OPACO: o broker é a fonte de verdade
   * dos tiers (catálogo dinâmico), então não validamos contra o fallback — só
   * exigimos uma string não-vazia e razoável (sem caractere de controle).
   */
  readonly tier?: string;
  /**
   * EST-0962 (BUG Custom) — slug do modelo Custom salvo, **só relevante quando
   * `tier === 'custom'`**. É a CHAVE de catálogo (string opaca, MESMA natureza do
   * `tier`), **NÃO credencial** (HG-2 / CLI-SEC-7): o broker é quem resolve
   * provider/credencial a partir do slug; guardá-lo aqui é tão seguro quanto o
   * `tier` já é. Validação leve, IDÊNTICA ao `tier` (não-vazio, curto, sem
   * controle). Fora de `tier:'custom'` NÃO sobrevive: o `sanitize` o DESCARTA se
   * aparecer sem `tier:'custom'` (sem slug fantasma), e o `saveTier` o LIMPA ao
   * cair num tier canônico.
   */
  readonly model?: string;
  /**
   * EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG). Persiste a preferência do toggle
   * `Ctrl+L`/`/split`/`--split`. Ausente/`false` ⇒ OFF (TUI de hoje, default). É só
   * preferência de UI (booleano) — jamais credencial/segredo (CLI-SEC-7).
   */
  readonly splitView?: boolean;
  /**
   * EST-0989 (i18n) — idioma da TUI salvo (`/lang` / `--lang`). MESMA natureza de
   * `theme`/`tier` (preferência de UI, NÃO credencial — CLI-SEC-7): só o código de
   * idioma (`pt-BR`/`en`). Validado contra o catálogo de idiomas na leitura
   * (`langByCode`); valor desconhecido ⇒ descartado ⇒ cai na auto-detecção/default.
   */
  readonly lang?: Lang;
  /**
   * EST-1000 · ADR-0076 §1 — MODO COCKPIT (`/fullscreen`/`--fullscreen`). Persiste a
   * preferência do toggle. Ausente/`false` ⇒ INLINE (o DEFAULT do ADR — scrollback +
   * copy-paste nativos). Só preferência de UI (booleano) — jamais credencial/segredo
   * (CLI-SEC-7: o cockpit reorganiza pixels, não toca invariante). Precedência:
   * `--fullscreen` (flag de boot) > `ui.fullscreen` (esta pref) > default(inline).
   */
  readonly fullscreen?: boolean;
  /**
   * F197 — SUGESTÃO DE PRÓXIMO PROMPT (ghost + Tab, estilo "suggested next steps"). Ao
   * fim de um turno, com o composer vazio, a TUI mostra uma sugestão dim do que pedir a
   * seguir; Tab a aceita. É uma OPÇÃO togglável (`/suggest on|off`), default LIGADO
   * (ausente ⇒ ON). MESMA disciplina de UI dos flat-booleans `splitView`/`fullscreen`:
   * só sobrevive como boolean genuíno; lixo/ausente ⇒ default ON. Precedência:
   * `ALUY_SUGGESTIONS` (env, 0/1) > este campo > default(ON). Só pref de UI — jamais
   * segredo (CLI-SEC-7). A heurística é LOCAL (sem modelo/tokens) — não gasta o BYO.
   */
  readonly suggestions?: boolean;
  /**
   * ADR-0120 / EST-1113 — BACKEND de modelo salvo: `broker` (default) | `local`
   * (BYO). Preferência de roteamento (NÃO credencial — CLI-SEC-7): diz por QUAL
   * caminho o modelo é chamado, não COM qual segredo. Precedência: `--backend`
   * (flag) > `ALUY_BACKEND` (env) > este campo > default `broker`. Lixo ⇒ descartado.
   */
  readonly backend?: 'broker' | 'local';
  /**
   * ADR-0120 / EST-1113 / ADR-0118 — provider do backend LOCAL. É só o SLUG do vendor
   * (DADO, não credencial — a chave vem do keychain/env por provider). ABERTO/config-
   * driven: qualquer id do catálogo (built-ins + `~/.aluy/providers.json`), incl. custom
   * OpenAI-compatíveis (ex.: `tokenrouter`). A validação real é no catálogo, no uso.
   * Default: `anthropic`.
   */
  readonly localProvider?: string;
  /**
   * ADR-0120 / EST-1113 — modelo NATIVO do provider no backend local (ex.:
   * `claude-opus-4-8`, `anthropic/claude-3.5-sonnet`). String OPACA (chave de
   * catálogo do provider), NÃO credencial. MESMA validação de forma do `tier`.
   */
  readonly localModel?: string;
  /**
   * ADR-0120 / EST-1113/1114 — via de auth do backend local: `apikey` (default,
   * paga-por-uso) | `oauth` (assinatura — ⚠ zona cinzenta de ToS, EST-1114). NÃO
   * credencial (só diz QUAL via usar). Default `apikey`.
   */
  readonly localAuth?: 'apikey' | 'oauth' | 'none';
  /**
   * ADR-0120 / EST-1113 · PROV-SEC-1 — override de `base_url` do provider local
   * (ex.: gateway OpenAI-compat próprio). VALIDADO por anti-SSRF antes do uso. NÃO
   * credencial. Ausente ⇒ o default público do provider.
   */
  readonly localBaseUrl?: string;

  /**
   * EST-1112 · ADR-0119 — budget de sessão no backend LOCAL. `true` RE-LIGA o gate
   * (maxTokens + anti-runaway) quando o backend é `local` (BYO). Default: `undefined`
   * (= OFF no local). NÃO tem efeito no remoto/broker (lá o budget é SEMPRE ON).
   * É só um BOOLEANO de preferência (NÃO credencial — CLI-SEC-7).
   */
  readonly localBudget?: boolean;
  /**
   * EST-1119 · ADR-0121 §5 — backend de salas de conversa entre agentes.
   * `memory` (default) | `file` | `loopback` | `broker`. Precedência:
   * `ALUY_ROOM_BACKEND` (env) > este campo > default `memory`.
   * Valor inválido ⇒ fail-closed `memory` + aviso (responsabilidade do core).
   * É DADO de roteamento, NÃO credencial (CLI-SEC-7).
   */
  readonly rooms?: {
    readonly backend?: string;
  };
  /**
   * EST-1133 — PERFIL de provisionamento de sidecars: `turbo` (default de
   * fábrica — provisiona runtimes user-space) | `leve` (não provisiona nada,
   * usa só o que já existe). É DADO de preferência do dono, não segredo
   * (CLI-SEC-7). Default: `turbo` (ADR-0123 §2.2-bis, reconciliação default-ON).
   */
  readonly profile?: 'turbo' | 'leve';
  /**
   * EST-1133 — TOGGLES de sidecar. Cada chave liga/desliga o provisionamento
   * daquele runtime. Só têm efeito sob perfil TURBO. Default: todos ON
   * (reconciliação default-ON, ADR-0123 §2.2-bis).
   */
  readonly sidecarToggles?: {
    readonly ollama?: boolean;
    readonly mem0?: boolean;
    readonly headroom?: boolean;
  };
  /**
   * Modelo de EMBEDDING do mem0 (turbo), escolhido na instalação. Slug do catálogo
   * (`bge-m3` | `mxbai-embed-large` | `nomic-embed-text`). Ausente ⇒ default
   * `DEFAULT_EMBEDDER_MODEL` (bge-m3). Trocar reseta o store (dimensão do vetor muda).
   */
  readonly embedder?: string;
  /**
   * PISO de relevância do recall do mem0 (0..1): só injeta memórias com `score >=` isto.
   * Antes só env `ALUY_MEM_MIN_SCORE`; agora config-driven (precedência env > config > default
   * 0.6). 0 desliga o piso. Calibra conforme o embedder (forte discrimina ⇒ piso maior).
   */
  readonly recallMinScore?: number;
  /**
   * ADR-0150 (config único) — catálogo de providers LOCAIS do usuário, ABSORVIDO do
   * antigo `~/.aluy/providers.json` (que passa a `.migrated`). É DADO PÚBLICO
   * (id/label/base_url/slug — CLI-SEC-7), NUNCA credencial (essa fica no keychain/env
   * por provider). Cada entrada espelha `LocalProviderEntry` cru; a validação profunda
   * é no `buildLocalCatalog` do core, no uso. Ausente ⇒ só o catálogo embutido.
   */
  readonly providers?: readonly UserProviderEntry[];
  /**
   * ADR-0150 EMENDA-1 (§8) — porta/host dos sidecars locais (Ollama/Mem0/headroom).
   * PREFERÊNCIA REAL (balde a): quem já roda Ollama em `:11500` salva aqui em vez de
   * reexportar env toda sessão. Precedência: `*_URL` (env) > `*_HOST`/`*_PORT` (env) >
   * este campo > default. `port` fora de 1..65535 ⇒ descartado (default); `host` só
   * loopback literal (não relaxar anti-SSRF do egress de sidecar). DADO, não credencial.
   */
  readonly services?: UserServicesConfig;
  /**
   * ADR-0134/0135 (conectores) — config dos bridges externos. DADO de config: só a
   * allowlist de ids-do-canal e preferências (CLI-SEC-7). O TOKEN do bot NUNCA mora aqui
   * — vai no keychain do SO (CLI-SEC-2 / TC-3). Allowlist VAZIA/ausente ⇒ bridge fechada
   * (default fechado, TC-2): nada entra até o dono autorizar um id.
   */
  readonly connectors?: UserConnectorsConfig;
  /**
   * ADR-0150 balde (a) — limites/orçamento PROMOVIDOS das env (`ALUY_MAX_TOKENS`,
   * `ALUY_MAX_OUTPUT_TOKENS`, `ALUY_MAX_ITERATIONS`). Preferência durável de custo/guarda-
   * corpo. Precedência: flag > env > este campo > default. Os resolvers do core RE-VALIDAM
   * e CLAMPAM (anti-runaway CLI-SEC-8 não-relaxável) — aqui só guardamos inteiros positivos.
   */
  readonly limits?: UserLimitsConfig;
  /**
   * ADR-0150 balde (a) — janela/auto-compactação PROMOVIDAS das env (`ALUY_CONTEXT_WINDOW`,
   * `ALUY_AUTOCOMPACT_AT`, `ALUY_AUTOCOMPACT_MAX`). Precedência flag > env > este campo >
   * default. `window` só vale p/ tier `custom` (no tier conhecido, a janela vem do catálogo).
   * Os resolvers do core RE-VALIDAM/CLAMPAM (anti-overflow/anti-loop).
   */
  readonly context?: UserContextConfig;
  /**
   * ADR-0146 (D4) — dial GLOBAL de modelo/tier dos SUB-AGENTES (posição 3 da cadeia de
   * precedência: parâmetro do `spawn_agent` > `model:` do `.md` > ESTE dial > herança
   * do pai). MESMO vocabulário do `model:`/`spawn_agent.model`: um nome amigável
   * (`sonnet`/…), uma chave `aluy-*`, `same-as-parent` (default — "sub-agentes seguem
   * o pai", o comportamento de hoje) ou `custom`/`custom:<slug>` (BYO). Validação de
   * FORMA idêntica ao `tier`/slug Custom (`isReasonableOpaque`) — este arquivo segue
   * "só UI/tier", NUNCA credencial (CLI-SEC-7); o `resolveModelTier`/probe do core
   * valida o VOCABULÁRIO de fato, no uso. Ausente ⇒ `same-as-parent` (zero regressão).
   */
  readonly subAgent?: UserSubAgentConfig;

  // ───────────────────────────────────────────────────────────────────────────
  // ADR-0150 (balde b) — TUNABLES DE OPERAÇÃO NOVOS (Tier 1): limites/timeouts/
  // tetos que hoje eram hardcoded, promovidos a `~/.aluy/config.json`. MESMA
  // disciplina de `limits`/`context` acima: sanitize SHAPE-ONLY aqui (inteiro
  // positivo); o resolver PURO do core (ou do `cli`, p/ os tunables que não moram
  // no core) RE-VALIDA e CLAMPA a um teto-teto hardcoded, NÃO configurável.
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * ADR-0150 — sub-agentes locais paralelos (CLI-SEC-11): teto de filhos por
   * chamada, concorrência e timeout de inatividade. Precedência env > este campo >
   * default (sem flag hoje); o core clampa a `MAX_SUBAGENTS_PER_CALL_CEILING` (32),
   * `MAX_SUBAGENT_CONCURRENCY_CEILING` (16) e
   * `[MIN_SUBAGENT_IDLE_TIMEOUT_MS, MAX_SUBAGENT_IDLE_TIMEOUT_MS]` (5s..30min).
   */
  readonly subagents?: UserSubagentsConfig;
  /**
   * ADR-0150 — DEFAULTS do `/cycle` (CLI-SEC-14) quando o usuário OMITE
   * `--por`/`--max-iter`/intervalo. Os teto-teto duros (`MAX_CYCLE_DURATION_MS`=2h,
   * `MAX_CYCLE_ITERATIONS`=200) permanecem hardcoded e INTOCADOS — este campo só
   * troca o DEFAULT dentro deles (clampado pelo core, `resolveCycleCeilings`).
   */
  readonly cycle?: UserCycleConfig;
  /**
   * ADR-0150 — timeouts de handshake/chamada dos servers MCP locais (CLI-SEC-12).
   * Já tinham override por env (`ALUY_MCP_CONNECT_TIMEOUT_MS`/`ALUY_MCP_TIMEOUT_MS`)
   * com teto-teto hardcoded (`[1s,2min]`/`[1s,10min]`); este campo só "termina o
   * padrão" — precedência env > este campo > default, MESMO teto-teto (intocado).
   */
  readonly mcp?: UserMcpConfig;
  /**
   * ADR-0150 — retenção/GC das sessões (`~/.aluy/sessions/`) e janela da AUTO-OFERTA
   * de retomada no boot. Sem env hoje; precedência config > default, com sanidade
   * MÍNIMA aplicada pelo `cli` (idade ≥1 dia, contagem ≥1, janela de auto-resume
   * ≤7 dias) — não é anti-runaway (não toca custo/segurança de efeito), mas ainda
   * ganha um piso/teto sensato p/ não virar um config absurdo (0 dias, janela ∞).
   */
  readonly session?: UserSessionConfig;
  /**
   * ADR-0150 (Tier 2) — tunables que JÁ tinham override por env + clamp
   * (mem-pressure/self-check/web-fetch); este campo só "termina o padrão" (config
   * como nível ENTRE env e default). Escopo v1.1-dentro-do-v1 por decisão do dono
   * (Tier 1 + Tier 2 juntos). Ver ADR-0150 §Tier 2.
   */
  readonly advanced?: UserAdvancedConfig;
}

/** ADR-0146 (D4) — dial de sub-agentes (só DADO/tier, nunca credencial — CLI-SEC-7). */
export interface UserSubAgentConfig {
  readonly model?: string;
}

/** Limites de orçamento de sessão (ADR-0150 §5). Inteiros positivos; o core clampa no uso. */
export interface UserLimitsConfig {
  readonly maxTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxIterations?: number;
  /**
   * ADR-0150 (balde b) — teto de gravações AUTÔNOMAS de memória (`remember`) por
   * sessão (CLI-SEC-15/GS-M2). Inteiro positivo; o core clampa em
   * `[1, MAX_MEMORY_WRITES_PER_SESSION_CEILING=100]` (`resolveMaxMemoryWritesPerSession`).
   */
  readonly maxMemoryWritesPerSession?: number;
}

/**
 * ADR-0150 (balde b) — seção `subagents` do config único: sub-agentes locais
 * PARALELOS (CLI-SEC-11). Inteiros positivos; o core clampa no uso (ver
 * `resolveMaxSubagentsPerCall`/`resolveMaxConcurrency`/`resolveIdleTimeoutMs`).
 */
export interface UserSubagentsConfig {
  /** Teto de filhos por chamada de `spawn_agent`. Clamp core `[1,32]`. */
  readonly maxPerCall?: number;
  /** Máx. de filhos vivos ao mesmo tempo (fan-out). Clamp core `[1,16]`. */
  readonly maxConcurrency?: number;
  /** Timeout de INATIVIDADE por filho (ms, não relógio total). Clamp core `[5000,1800000]`. */
  readonly idleTimeoutMs?: number;
}

/**
 * ADR-0150 (balde b) — seção `cycle` do config único: DEFAULTS de `/cycle`
 * (CLI-SEC-14) quando o usuário omite a dimensão. Os teto-teto duros do `/cycle`
 * NÃO estão aqui — são hardcoded no core e intocados por este ADR.
 */
export interface UserCycleConfig {
  /** Default de duração total (ms) quando `--por` é omitido. Clamp core ao teto de 2h. */
  readonly defaultDurationMs?: number;
  /** Default de nº de ciclos quando `--max-iter` é omitido. Clamp core ao teto de 200. */
  readonly defaultIterations?: number;
  /** Default do intervalo entre ciclos (ms) no ritmo fixo, sem intervalo explícito. */
  readonly defaultIntervalMs?: number;
}

/**
 * ADR-0150 (balde b) — seção `mcp` do config único: timeouts dos servers MCP
 * locais (CLI-SEC-12). O core clampa aos MESMOS teto-teto já existentes
 * (`resolveMcpConnectTimeoutMs`/`resolveMcpCallTimeoutMs`).
 */
export interface UserMcpConfig {
  /** Teto do HANDSHAKE (connect+listTools) na descoberta. Clamp `[1000,120000]`. */
  readonly connectTimeoutMs?: number;
  /** Teto de UMA chamada `callTool`. Clamp `[1000,600000]`. */
  readonly callTimeoutMs?: number;
}

/**
 * ADR-0150 (balde b) — seção `session` do config único: retenção das sessões
 * salvas + janela da auto-oferta de retomada no boot. Sanidade aplicada pelo
 * `cli` (não é anti-runaway; ver `resolveSessionGcOptions`/`resolveAutoResumeWindowMs`).
 */
export interface UserSessionConfig {
  /** Idade máxima (ms) de uma sessão salva antes do GC. Sanidade: mín. 1 dia. */
  readonly gcMaxAgeMs?: number;
  /** Teto de sessões mantidas (as mais recentes). Sanidade: mín. 1. */
  readonly gcMaxCount?: number;
  /** Janela (ms) de "recente" p/ a auto-oferta de retomada no boot. Sanidade: máx. 7 dias. */
  readonly autoResumeWindowMs?: number;
}

/**
 * ADR-0150 (Tier 2) — tunables config-driven que JÁ tinham override por env+clamp.
 * Precedência flag/env > este campo > default; o core RE-VALIDA/CLAMPA no uso, MESMOS
 * teto-teto já existentes (nenhum novo teto-teto nasce aqui).
 */
export interface UserAdvancedConfig {
  /** `agent/self-check.ts` — re-âncora de objetivo + auto-verificação pré-"pronto". */
  readonly selfCheck?: {
    /** `everyKEnv` (ALUY_SELF_CHECK_EVERY) vence. Clamp core `[1,1000]`. */
    readonly everyK?: number;
    /** `maxVerificationsEnv` (ALUY_SELF_CHECK_MAX) vence. Clamp core `[1,10]`. */
    readonly maxVerifications?: number;
  };
  /** `agent/mem-pressure.ts` — limiar BASE do backstop de OOM (heap). */
  readonly memPressure?: {
    /** `ALUY_MEM_PRESSURE_AT` vence. Razão `0..1` ou `%`. Clamp core `[0.5,0.99]`. */
    readonly compactAt?: number | string;
  };
  /** `agent/web/fetcher.ts` — teto de caracteres da observação do `web_fetch`. */
  readonly webFetch?: {
    /** `ALUY_WEB_FETCH_MAX_CHARS` vence. Clamp core `[256,500000]`. */
    readonly maxObservationChars?: number;
  };
}

/** Janela/auto-compactação (ADR-0150 §5). O core re-valida/clampa no uso. */
export interface UserContextConfig {
  /** Janela assumida (tokens) — só p/ tier custom. Inteiro positivo. */
  readonly window?: number;
  /** Limiar de auto-compactação: razão `0..1`, % `>1`, ou `0`/`'off'` (desliga). */
  readonly autocompactAt?: number | string;
  /** Teto do anti-loop de auto-compactação. Inteiro positivo. */
  readonly autocompactMax?: number;
}

/** Config dos conectores (ADR-0135). Só DADO (allowlist/prefs); token só no keychain. */
export interface UserConnectorsConfig {
  readonly telegram?: UserTelegramConfig;
}

/** Config do conector Telegram (ADR-0134). Allowlist de chat-ids do dono. */
export interface UserTelegramConfig {
  /** chat-ids autorizados (a allowlist do dono). Vazia ⇒ nada entra (default fechado). */
  readonly allowlist?: readonly number[];
}

/** Porta/host de um sidecar (ADR-0150 §8). Ambos opcionais; ausente ⇒ default. */
export interface UserServiceEndpoint {
  readonly host?: string;
  readonly port?: number;
}

/** Seção `services` do config único — endpoints dos sidecars locais. */
export interface UserServicesConfig {
  readonly ollama?: UserServiceEndpoint;
  readonly mem0?: UserServiceEndpoint;
  readonly headroom?: UserServiceEndpoint;
}

/** Uma entrada de provider local no config único (DADO público — sem credencial). */
export interface UserProviderEntry {
  readonly id: string;
  readonly label?: string;
  readonly wireFormat: 'openai-compat' | 'anthropic' | 'gemini';
  readonly baseUrl: string;
  readonly auth?: readonly string[];
  readonly defaultModel: string;
  readonly models?: readonly string[];
}

/** Formatos de fio aceitos (espelha `WireFormat` do core; gatekeeper de `sanitize`). */
const WIRE_FORMATS = new Set(['openai-compat', 'anthropic', 'gemini']);

/** Normaliza `string | string[]` p/ array de strings não-vazias; vazio ⇒ undefined. */
function normStrList(raw: unknown): readonly string[] | undefined {
  const arr = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const out = arr.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return out.length > 0 ? out : undefined;
}

/** Host loopback literal aceito em `services.*.host` (não relaxar anti-SSRF do egress). */
function isLoopbackHost(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const h = v.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Porta válida 1..65535 (inteiro). Fora disso ⇒ undefined (cai no default). */
function okPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

/** Sanitiza um endpoint `{host?, port?}` (ADR-0150 §8). Campos inválidos descartados. */
function sanitizeEndpoint(raw: unknown): UserServiceEndpoint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const ep: { host?: string; port?: number } = {};
  if (isLoopbackHost(o.host)) ep.host = o.host.trim();
  if (okPort(o.port)) ep.port = o.port;
  return ep.host !== undefined || ep.port !== undefined ? ep : undefined;
}

/** Sanitiza `limits` (ADR-0150 §5). Só inteiros positivos; o core re-valida/clampa no uso. */
function sanitizeLimits(raw: unknown): UserLimitsConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const out: {
    maxTokens?: number;
    maxOutputTokens?: number;
    maxIterations?: number;
    maxMemoryWritesPerSession?: number;
  } = {};
  const mt = posInt(o.maxTokens);
  const mo = posInt(o.maxOutputTokens);
  const mi = posInt(o.maxIterations);
  // ADR-0150 (balde b) — teto de gravações de memória por sessão; shape-only aqui
  // (o core clampa em `[1, MAX_MEMORY_WRITES_PER_SESSION_CEILING=100]` no uso).
  const mw = posInt(o.maxMemoryWritesPerSession);
  if (mt !== undefined) out.maxTokens = mt;
  if (mo !== undefined) out.maxOutputTokens = mo;
  if (mi !== undefined) out.maxIterations = mi;
  if (mw !== undefined) out.maxMemoryWritesPerSession = mw;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR-0150 (balde b) — sanitiza `subagents`. Só inteiros positivos; o core re-valida/
 * clampa no uso (`resolveMaxSubagentsPerCall`/`resolveMaxConcurrency`/`resolveIdleTimeoutMs`).
 */
function sanitizeSubagents(raw: unknown): UserSubagentsConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const out: { maxPerCall?: number; maxConcurrency?: number; idleTimeoutMs?: number } = {};
  const mpc = posInt(o.maxPerCall);
  const mc = posInt(o.maxConcurrency);
  const it = posInt(o.idleTimeoutMs);
  if (mpc !== undefined) out.maxPerCall = mpc;
  if (mc !== undefined) out.maxConcurrency = mc;
  if (it !== undefined) out.idleTimeoutMs = it;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR-0150 (balde b) — sanitiza `cycle`. Só inteiros; `defaultIntervalMs` aceita `0`
 * (valor válido — "sem espera fixa"), os demais exigem positivo. O core re-valida/
 * clampa aos teto-teto duros do `/cycle` (`resolveCycleCeilings`).
 */
function sanitizeCycle(raw: unknown): UserCycleConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const nonNegInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
  const out: {
    defaultDurationMs?: number;
    defaultIterations?: number;
    defaultIntervalMs?: number;
  } = {};
  const dd = posInt(o.defaultDurationMs);
  const di = posInt(o.defaultIterations);
  const dim = nonNegInt(o.defaultIntervalMs);
  if (dd !== undefined) out.defaultDurationMs = dd;
  if (di !== undefined) out.defaultIterations = di;
  if (dim !== undefined) out.defaultIntervalMs = dim;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR-0150 (balde b) — sanitiza `mcp`. Só inteiros positivos; o core re-valida/clampa
 * aos MESMOS teto-teto já existentes (`resolveMcpConnectTimeoutMs`/`resolveMcpCallTimeoutMs`).
 */
function sanitizeMcp(raw: unknown): UserMcpConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const out: { connectTimeoutMs?: number; callTimeoutMs?: number } = {};
  const ct = posInt(o.connectTimeoutMs);
  const cl = posInt(o.callTimeoutMs);
  if (ct !== undefined) out.connectTimeoutMs = ct;
  if (cl !== undefined) out.callTimeoutMs = cl;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR-0150 (balde b) — sanitiza `session`. Só inteiros positivos; o `cli` aplica a
 * sanidade MÍNIMA (não anti-runaway) no uso (`resolveSessionGcOptions`/
 * `resolveAutoResumeWindowMs`).
 */
function sanitizeSession(raw: unknown): UserSessionConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const out: { gcMaxAgeMs?: number; gcMaxCount?: number; autoResumeWindowMs?: number } = {};
  const ga = posInt(o.gcMaxAgeMs);
  const gc = posInt(o.gcMaxCount);
  const aw = posInt(o.autoResumeWindowMs);
  if (ga !== undefined) out.gcMaxAgeMs = ga;
  if (gc !== undefined) out.gcMaxCount = gc;
  if (aw !== undefined) out.autoResumeWindowMs = aw;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * ADR-0150 (Tier 2) — sanitiza `advanced`. Shape-only (o core re-valida/clampa no
 * uso, MESMOS teto-teto já existentes de cada tunable — nenhum novo aqui).
 */
function sanitizeAdvanced(raw: unknown): UserAdvancedConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const posInt = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const out: {
    selfCheck?: { everyK?: number; maxVerifications?: number };
    memPressure?: { compactAt?: number | string };
    webFetch?: { maxObservationChars?: number };
  } = {};

  if (typeof o.selfCheck === 'object' && o.selfCheck !== null) {
    const sc = o.selfCheck as Record<string, unknown>;
    const clean: { everyK?: number; maxVerifications?: number } = {};
    const ek = posInt(sc.everyK);
    const mv = posInt(sc.maxVerifications);
    if (ek !== undefined) clean.everyK = ek;
    if (mv !== undefined) clean.maxVerifications = mv;
    if (Object.keys(clean).length > 0) out.selfCheck = clean;
  }

  if (typeof o.memPressure === 'object' && o.memPressure !== null) {
    const mp = o.memPressure as Record<string, unknown>;
    // razão 0..1 (número) OU string (o core parseia/clampa — mesma forma do env).
    if (typeof mp.compactAt === 'number' && Number.isFinite(mp.compactAt) && mp.compactAt > 0) {
      out.memPressure = { compactAt: mp.compactAt };
    } else if (typeof mp.compactAt === 'string' && mp.compactAt.trim() !== '') {
      out.memPressure = { compactAt: mp.compactAt.trim() };
    }
  }

  if (typeof o.webFetch === 'object' && o.webFetch !== null) {
    const wf = o.webFetch as Record<string, unknown>;
    const moc = posInt(wf.maxObservationChars);
    if (moc !== undefined) out.webFetch = { maxObservationChars: moc };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sanitiza `context` (ADR-0150 §5). O core re-valida/clampa no uso; aqui só a forma. */
function sanitizeContext(raw: unknown): UserContextConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: { window?: number; autocompactAt?: number | string; autocompactMax?: number } = {};
  if (typeof o.window === 'number' && Number.isInteger(o.window) && o.window > 0) {
    out.window = o.window;
  }
  // autocompactAt: número (razão/%) OU string ('off'/'0'/'0.85') — o core parseia/clampa.
  if (typeof o.autocompactAt === 'number' && Number.isFinite(o.autocompactAt)) {
    out.autocompactAt = o.autocompactAt;
  } else if (typeof o.autocompactAt === 'string' && o.autocompactAt.trim() !== '') {
    out.autocompactAt = o.autocompactAt.trim();
  }
  if (
    typeof o.autocompactMax === 'number' &&
    Number.isInteger(o.autocompactMax) &&
    o.autocompactMax > 0
  ) {
    out.autocompactMax = o.autocompactMax;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Sanitiza a config de conectores (ADR-0134/0135). Só a allowlist (DADO); token no keychain. */
function sanitizeConnectors(raw: unknown): UserConnectorsConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: { telegram?: UserTelegramConfig } = {};
  if (typeof o.telegram === 'object' && o.telegram !== null) {
    const tg = o.telegram as Record<string, unknown>;
    if (Array.isArray(tg.allowlist)) {
      // chat-ids: inteiros finitos, dedup. Lixo descartado (entrada inválida não autoriza ninguém).
      const ids: number[] = [];
      for (const v of tg.allowlist) {
        if (
          typeof v === 'number' &&
          Number.isFinite(v) &&
          Number.isInteger(v) &&
          !ids.includes(v)
        ) {
          ids.push(v);
        }
      }
      // grava a seção mesmo se vazia (allowlist explicitamente vazia = "fechei a bridge").
      out.telegram = { allowlist: ids };
    } else {
      out.telegram = {};
    }
  }
  return out.telegram !== undefined ? out : undefined;
}

/**
 * ADR-0146 (D4) — sanitiza o dial `subAgent` (só `model`, string OPACA razoável —
 * MESMA validação de forma do `tier`/slug Custom). Lixo/objeto inválido ⇒ `undefined`
 * (a resolução cai no default `same-as-parent`, nunca trava/lança).
 */
function sanitizeSubAgent(raw: unknown): UserSubAgentConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (isReasonableOpaque(o.model)) return { model: o.model.trim() };
  return undefined;
}

/** Sanitiza a seção `services` (ADR-0150 §8). Só sub-endpoints válidos sobrevivem. */
function sanitizeServices(raw: unknown): UserServicesConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: {
    ollama?: UserServiceEndpoint;
    mem0?: UserServiceEndpoint;
    headroom?: UserServiceEndpoint;
  } = {};
  const ollama = sanitizeEndpoint(o.ollama);
  const mem0 = sanitizeEndpoint(o.mem0);
  const headroom = sanitizeEndpoint(o.headroom);
  if (ollama) out.ollama = ollama;
  if (mem0) out.mem0 = mem0;
  if (headroom) out.headroom = headroom;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Sanitiza o array de providers do config (ADR-0150). Mantém só entradas BEM-FORMADAS
 * (id/baseUrl/defaultModel string não-vazia + wireFormat conhecido); descarta o resto.
 * Copia só campos reconhecidos (nunca credencial). Array vazio/sem válidas ⇒ undefined.
 */
function sanitizeProviderEntries(raw: unknown): readonly UserProviderEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UserProviderEntry[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : '';
    const defaultModel = typeof o.defaultModel === 'string' ? o.defaultModel.trim() : '';
    const wf = typeof o.wireFormat === 'string' ? o.wireFormat : '';
    if (id === '' || baseUrl === '' || defaultModel === '' || !WIRE_FORMATS.has(wf)) continue;
    // auth/models: aceita string única OU array (espelha o legado providers.json e o
    // parseAuth do core). Normaliza p/ array de strings; vazio ⇒ campo omitido.
    const auth = normStrList(o.auth);
    const models = normStrList(o.models);
    const entry: UserProviderEntry = {
      id,
      wireFormat: wf as UserProviderEntry['wireFormat'],
      baseUrl,
      defaultModel,
      ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim() } : {}),
      ...(auth ? { auth } : {}),
      ...(models ? { models } : {}),
    };
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

export interface UserConfigStoreOptions {
  /**
   * Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir),
   * sem nunca tocar o `~/.aluy/` real do dev na suíte.
   */
  readonly baseDir?: string;
}

/**
 * Limite defensivo p/ as strings opacas lidas (tier/slug Custom) — evita lixo
 * gigante num arquivo adulterado. O slug Custom é da MESMA natureza do tier
 * (chave de catálogo), então compartilha o mesmo teto e a mesma validação.
 */
const MAX_OPAQUE_LEN = 128;

/** `true` se a string opaca (tier ou slug) é razoável: não-vazia, curta, sem controle. */
function isReasonableOpaque(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t === '' || t.length > MAX_OPAQUE_LEN) return false;
  // sem caractere de controle (inclui \n, \t, NUL — sinal de arquivo adulterado).
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001F\u007F]/.test(t);
}

/**
 * Saneia um objeto desconhecido (vindo do JSON do disco) p/ um `UserConfig` de
 * confiança: descarta campos inválidos/desconhecidos, valida `theme` contra o
 * catálogo e `tier` por forma. NUNCA lança — campo ruim some, não derruba.
 */
function sanitize(raw: unknown): UserConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const out: {
    theme?: ThemeName;
    tier?: string;
    model?: string;
    splitView?: boolean;
    lang?: Lang;
    fullscreen?: boolean;
    suggestions?: boolean;
    backend?: 'broker' | 'local';
    localProvider?: string;
    localModel?: string;
    localAuth?: 'apikey' | 'oauth' | 'none';
    localBaseUrl?: string;
    localBudget?: boolean;
    rooms?: { backend?: string };
    profile?: 'turbo' | 'leve';
    sidecarToggles?: { ollama?: boolean; mem0?: boolean; headroom?: boolean };
    embedder?: string;
    recallMinScore?: number;
    providers?: readonly UserProviderEntry[];
    services?: UserServicesConfig;
    connectors?: UserConnectorsConfig;
    limits?: UserLimitsConfig;
    context?: UserContextConfig;
    subAgent?: UserSubAgentConfig;
    // ADR-0150 (balde b) — tunables novos (bloco separado, ver §sanitize abaixo).
    subagents?: UserSubagentsConfig;
    cycle?: UserCycleConfig;
    mcp?: UserMcpConfig;
    session?: UserSessionConfig;
    advanced?: UserAdvancedConfig;
  } = {};
  // theme: precisa ser um nome conhecido do catálogo (senão ignora → default dark).
  if (typeof obj.theme === 'string') {
    const entry = themeByName(obj.theme);
    if (entry) out.theme = entry.name;
  }
  // tier: string opaca razoável (o broker valida de fato; aqui só forma).
  if (isReasonableOpaque(obj.tier)) out.tier = obj.tier.trim();
  // EST-0962 (BUG Custom) — model (slug Custom): MESMA validação de forma do tier,
  // mas só sobrevive ACOPLADO a `tier:'custom'`. Slug solto (sem custom) ou sob um
  // tier canônico é DESCARTADO — nunca slug fantasma fora de Custom (espelha a regra
  // do session-store / resolveResumedModel: o slug só existe sob `tier:'custom'`).
  if (out.tier === 'custom' && isReasonableOpaque(obj.model)) out.model = obj.model.trim();
  // EST-0990 — splitView: booleano de UI. Só sobrevive quando é boolean genuíno (um
  // valor não-boolean num arquivo adulterado some ⇒ cai no default OFF). NUNCA lança.
  if (typeof obj.splitView === 'boolean') out.splitView = obj.splitView;
  // EST-0989 (i18n) — lang: precisa ser um código conhecido do catálogo de idiomas
  // (`pt-BR`/`en`). Valor desconhecido/lixo some ⇒ cai na auto-detecção/default na
  // resolução. MESMA disciplina do `theme` (validação contra catálogo). NUNCA lança.
  if (typeof obj.lang === 'string') {
    const entry = langByCode(obj.lang);
    if (entry) out.lang = entry.code;
  }
  // EST-1000 · ADR-0076 §1 — fullscreen (cockpit): booleano de UI, MESMA disciplina do
  // splitView. Só sobrevive como boolean genuíno; lixo/ausente ⇒ default INLINE. NUNCA lança.
  if (typeof obj.fullscreen === 'boolean') out.fullscreen = obj.fullscreen;
  // F197 — suggestions (próximo prompt): booleano de UI, MESMA disciplina do split/
  // fullscreen. Só sobrevive como boolean genuíno; lixo/ausente ⇒ default ON (resolvido
  // em `resolveInitialSuggestions`, não aqui — aqui só preservamos o que foi salvo). NUNCA lança.
  if (typeof obj.suggestions === 'boolean') out.suggestions = obj.suggestions;
  // ADR-0120 — backend: só `broker`|`local` (lixo ⇒ descartado ⇒ default broker).
  if (obj.backend === 'broker' || obj.backend === 'local') out.backend = obj.backend;
  // ADR-0120 / ADR-0118 — localProvider: SLUG opaco razoável (ABERTO/config-driven).
  // Aceita qualquer id do catálogo (built-ins + providers.json, incl. custom); a
  // validação real é no catálogo, no uso. (Antes travava nos 3 ⇒ custom era descartado.)
  if (isReasonableOpaque(obj.localProvider)) out.localProvider = obj.localProvider.trim();
  // ADR-0120 — localModel: string opaca razoável (MESMA forma do tier).
  if (isReasonableOpaque(obj.localModel)) out.localModel = obj.localModel.trim();
  // ADR-0120 — localAuth: só `apikey`|`oauth` (lixo ⇒ descartado ⇒ default apikey).
  if (obj.localAuth === 'apikey' || obj.localAuth === 'oauth' || obj.localAuth === 'none')
    out.localAuth = obj.localAuth;
  // ADR-0120 — localBaseUrl: string opaca razoável; o anti-SSRF a valida no uso.
  if (isReasonableOpaque(obj.localBaseUrl)) out.localBaseUrl = obj.localBaseUrl.trim();

  // ADR-0119 — localBudget: booleano de preferência. Só sobrevive quando é boolean genuíno.
  if (typeof obj.localBudget === 'boolean') out.localBudget = obj.localBudget;

  // EST-1119 · ADR-0121 §5 — rooms.backend: string opaca razoável (MESMA forma do tier).
  // O core valida o valor de fato (resolveRoomBackend fail-closed); aqui só sanitizamos a forma.
  if (typeof obj.rooms === 'object' && obj.rooms !== null) {
    const rooms = obj.rooms as Record<string, unknown>;
    if (typeof rooms.backend === 'string') {
      const b = rooms.backend.trim().toLowerCase();
      if (b.length > 0 && b.length <= 32) {
        out.rooms = { backend: b };
      }
    }
  }

  // EST-1133 — profile: só 'turbo' | 'leve' (lixo ⇒ descartado ⇒ default 'turbo').
  if (obj.profile === 'turbo' || obj.profile === 'leve') {
    out.profile = obj.profile;
  }

  // embedder: só um slug do CATÁLOGO (bge-m3/mxbai-embed-large/nomic-embed-text); lixo ⇒
  // descartado ⇒ default. Validado contra o catálogo p/ não puxar/verificar modelo desconhecido.
  if (typeof obj.embedder === 'string' && embedderSpec(obj.embedder.trim()) !== undefined) {
    out.embedder = obj.embedder.trim();
  }

  // recallMinScore: número finito em [0,1]. Fora disso ⇒ descartado (cai no default 0.6).
  if (
    typeof obj.recallMinScore === 'number' &&
    Number.isFinite(obj.recallMinScore) &&
    obj.recallMinScore >= 0 &&
    obj.recallMinScore <= 1
  ) {
    out.recallMinScore = obj.recallMinScore;
  }

  // EST-1133 — sidecarToggles: objeto com booleanos genuínos.
  // Cada toggle só sobrevive se for boolean; ausente ⇒ default ON (reconciliação).
  if (typeof obj.sidecarToggles === 'object' && obj.sidecarToggles !== null) {
    const toggles = obj.sidecarToggles as Record<string, unknown>;
    const clean: { ollama?: boolean; mem0?: boolean; headroom?: boolean } = {};
    if (typeof toggles.ollama === 'boolean') clean.ollama = toggles.ollama;
    if (typeof toggles.mem0 === 'boolean') clean.mem0 = toggles.mem0;
    if (typeof toggles.headroom === 'boolean') clean.headroom = toggles.headroom;
    // Só grava se houver pelo menos UM toggle válido.
    if (Object.keys(clean).length > 0) {
      out.sidecarToggles = clean;
    }
  }

  // ADR-0150 (config único) — providers absorvidos do antigo providers.json.
  const providers = sanitizeProviderEntries(obj.providers);
  if (providers) out.providers = providers;

  // ADR-0150 EMENDA-1 (§8) — seção services (porta/host dos sidecars).
  const services = sanitizeServices(obj.services);
  if (services) out.services = services;

  // ADR-0134/0135 — conectores (allowlist do Telegram; token só no keychain).
  const connectors = sanitizeConnectors(obj.connectors);
  if (connectors) out.connectors = connectors;

  // ADR-0150 §5 (balde a) — limits promovidos das env (maxTokens/maxOutputTokens/maxIterations).
  const limits = sanitizeLimits(obj.limits);
  if (limits) out.limits = limits;

  // ADR-0150 §5 (balde a) — context promovido das env (window/autocompactAt/autocompactMax).
  const context = sanitizeContext(obj.context);
  if (context) out.context = context;

  // ADR-0146 (D4) — dial global de modelo/tier dos sub-agentes.
  const subAgent = sanitizeSubAgent(obj.subAgent);
  if (subAgent) out.subAgent = subAgent;

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-0150 (balde b) — TUNABLES NOVOS (subagents/cycle/mcp/session). Bloco
  // separado de propósito (ver nota de coordenação no topo do arquivo) para
  // minimizar conflito com outras adições paralelas a este `sanitize()`.
  // ─────────────────────────────────────────────────────────────────────────
  const subagents = sanitizeSubagents(obj.subagents);
  if (subagents) out.subagents = subagents;

  const cycle = sanitizeCycle(obj.cycle);
  if (cycle) out.cycle = cycle;

  const mcp = sanitizeMcp(obj.mcp);
  if (mcp) out.mcp = mcp;

  const session = sanitizeSession(obj.session);
  if (session) out.session = session;

  // ADR-0150 (Tier 2) — advanced (self-check/mem-pressure/web-fetch): tunables que
  // já tinham override por env+clamp; config só "termina o padrão".
  const advanced = sanitizeAdvanced(obj.advanced);
  if (advanced) out.advanced = advanced;

  return out;
}

/** Allowlist atual do Telegram (chat-ids) a partir da config. Ausente ⇒ vazia. */
export function telegramAllowlist(config: UserConfig): readonly number[] {
  return config.connectors?.telegram?.allowlist ?? [];
}

/** Adiciona um chat-id à allowlist do Telegram (dedup). Retorna a nova allowlist. PURO. */
export function addTelegramAllow(config: UserConfig, chatId: number): readonly number[] {
  const cur = telegramAllowlist(config);
  return cur.includes(chatId) ? cur : [...cur, chatId];
}

/** Remove um chat-id da allowlist do Telegram. Retorna a nova allowlist. PURO. */
export function removeTelegramAllow(config: UserConfig, chatId: number): readonly number[] {
  return telegramAllowlist(config).filter((id) => id !== chatId);
}

/**
 * STORE da config de preferências em `~/.aluy/config.json`. Leitura FAIL-SAFE
 * (defaults em qualquer erro) e escrita ATÔMICA `0600`. Não mantém estado em
 * memória além dos caminhos — cada `load` lê o disco (a sessão é curta; ler é
 * barato e evita cache stale entre processos).
 */
export class UserConfigStore {
  private readonly base: string; // ~/.aluy
  private readonly file: string; // ~/.aluy/config.json

  constructor(opts: UserConfigStoreOptions = {}) {
    this.base = opts.baseDir ?? join(homedir(), '.aluy');
    this.file = join(this.base, CONFIG_FILENAME);
  }

  /** Caminho do arquivo de config (p/ asserts de perm/local em teste). */
  get configPath(): string {
    return this.file;
  }

  /**
   * Lê a config do disco. FAIL-SAFE: ausente, vazia, JSON inválido, sem permissão
   * ou qualquer outro erro ⇒ `{}` (defaults). NUNCA lança. Campos inválidos são
   * descartados (sanitize); só preferências reconhecidas voltam.
   */
  load(): UserConfig {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      // ENOENT (1ª execução, sem config) e qualquer erro de leitura ⇒ defaults.
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Config corrompido (JSON inválido) ⇒ defaults, sem crash (fail-safe).
      return {};
    }
    return sanitize(parsed);
  }

  /**
   * Persiste `patch` mesclado sobre a config atual (read-modify-write). Só os
   * campos presentes em `patch` mudam; os demais são preservados. Best-effort:
   * uma falha de escrita NUNCA derruba a sessão (a troca em sessão já valeu; só
   * a persistência p/ a próxima sessão é que não ocorreu). Retorna `true` se
   * gravou, `false` se a escrita falhou silenciosamente.
   */
  save(patch: UserConfig): boolean {
    try {
      const next = sanitize({ ...this.load(), ...patch });
      this.writeAtomic(next);
      return true;
    } catch {
      // QoL não-crítica: persistência best-effort. Falha = silêncio (não derruba).
      return false;
    }
  }

  /** Açúcar: persiste só o tema (preserva o tier salvo). */
  saveTheme(theme: ThemeName): boolean {
    return this.save({ theme });
  }

  /** EST-0989 — açúcar: persiste só o idioma (preserva tema/tier salvos). */
  saveLang(lang: Lang): boolean {
    return this.save({ lang });
  }

  /**
   * Açúcar: persiste o tier (preserva o tema salvo). EST-0962 (BUG Custom): quando
   * `tier === 'custom'`, persiste TAMBÉM o `model` (o slug Custom) p/ a próxima
   * sessão NOVA reabrir no mesmo modelo Custom — hoje só o tier ia, então a sessão
   * nova caía em "custom sem modelo" e o usuário re-inputava. Ao trocar p/ um tier
   * CANÔNICO (ou Custom SEM slug), o `model` é LIMPO do config — sem slug fantasma
   * preso a um tier que não é mais Custom.
   *
   * O `model: undefined` no patch é DELIBERADO: ele sobrescreve o slug salvo no
   * disco (read-modify-write), e o `sanitize` então o descarta (slug só sobrevive
   * sob `tier:'custom'` COM forma válida). Resultado:
   *   - `saveTier('custom', 'x/y')` ⇒ `{ tier:'custom', model:'x/y' }` (slug gruda);
   *   - `saveTier('custom')`         ⇒ `{ tier:'custom' }` (slug ausente — não inventa);
   *   - `saveTier('aluy-deep')`      ⇒ `{ tier:'aluy-deep' }` (slug LIMPO se existia).
   */
  saveTier(tier: string, model?: string): boolean {
    const isCustom = tier.trim() === 'custom';
    const slug = isCustom && model !== undefined && model.trim() !== '' ? model.trim() : undefined;
    // Patch SEM `model` p/ um tier canônico: o merge mantém o slug do disco, mas o
    // `sanitize` o DESCARTA (slug só sobrevive sob `tier:'custom'`) ⇒ slug LIMPO. Com
    // slug Custom presente, incluímos `model` no patch p/ ele gravar/atualizar.
    return this.save(slug !== undefined ? { tier, model: slug } : { tier });
  }

  /** EST-0990 — Açúcar: persiste a preferência do split (preserva tema/tier salvos). */
  saveSplitView(splitView: boolean): boolean {
    return this.save({ splitView });
  }

  /**
   * EST-1000 · ADR-0076 §1 — Açúcar: persiste a preferência do MODO COCKPIT
   * (`/fullscreen`/`--fullscreen`), preservando as demais. `true` ⇒ a próxima sessão
   * reabre no cockpit; `false` ⇒ volta ao inline (o default). Só pref de UI.
   */
  saveFullscreen(fullscreen: boolean): boolean {
    return this.save({ fullscreen });
  }

  /**
   * F197 — Açúcar: persiste a preferência da SUGESTÃO DE PRÓXIMO PROMPT (`/suggest on|off`),
   * preservando as demais. `true` ⇒ a próxima sessão reabre com sugestões; `false` ⇒ off.
   * Só pref de UI (booleano) — jamais segredo (CLI-SEC-7).
   */
  saveSuggestions(suggestions: boolean): boolean {
    return this.save({ suggestions });
  }

  /**
   * EST-1112 · ADR-0119 — Açúcar: persiste a preferência de budget local
   * (`/budget`/`--budget`), preservando as demais. `true` ⇒ a próxima sessão
   * local reabre com budget ON; `false` ⇒ budget OFF no local. NÃO tem efeito
   * no remoto/broker. Só pref de custo.
   */
  saveLocalBudget(localBudget: boolean): boolean {
    return this.save({ localBudget });
  }

  /**
   * ADR-0146 (D4) — Açúcar: persiste (ou LIMPA, com `undefined`/vazio) o dial GLOBAL
   * de modelo/tier dos SUB-AGENTES (`subAgent.model`), preservando as demais
   * preferências. MESMO vocabulário do `model:` do `.md` (`same-as-parent`/tier/
   * `custom`/`custom:<slug>`) — só DADO/tier, nunca credencial (CLI-SEC-7).
   */
  saveSubAgentModel(model: string | undefined): boolean {
    const trimmed = model?.trim();
    return this.save({ subAgent: trimmed !== undefined && trimmed !== '' ? { model: trimmed } : {} });
  }

  /**
   * Escreve a config ATÔMICA: garante o `~/.aluy/` com `0700`, escreve um temp
   * com `0600` (open `O_CREAT|O_EXCL|O_WRONLY`, sem janela `0644`+chmod) e o
   * `rename` por cima do alvo (rename é atômico no mesmo filesystem). Em erro,
   * limpa o temp. `umask` é neutralizado pelo mode explícito no `open`.
   */
  private writeAtomic(config: UserConfig): void {
    mkdirSync(this.base, { recursive: true, mode: DIR_MODE });
    // temp único por escrita (pid evita colisão entre processos concorrentes).
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const body = JSON.stringify(config, null, 2) + '\n';
    let fd: number | undefined;
    try {
      // O_EXCL: nasce novo com `0600` (sem herdar perm de um arquivo pré-existente).
      fd = openSync(
        tmp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        FILE_MODE,
      );
      writeSync(fd, body);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.file);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* temp pode não existir — ignore */
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRECEDÊNCIA (puro, testável): flag CLI > config salva > default.
// O caller resolve QUE valor usar no startup combinando a flag (se veio), o que o
// `load()` devolveu e o default do domínio. Mantido aqui, sem I/O, p/ testar a
// ordem isoladamente (DoD: precedência flag > config > default).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve o TIER inicial. Ordem: `--tier` (flag) > `config.tier` > `defaultTier`.
 * `flag`/`config` vazios ou ausentes caem p/ o próximo nível. NUNCA devolve vazio
 * (sempre cai no default). O broker valida o tier de fato (aqui é só precedência).
 */
export function resolveInitialTier(
  flag: string | undefined,
  config: UserConfig,
  defaultTier: string,
): string {
  if (flag !== undefined && flag.trim() !== '') return flag.trim();
  if (config.tier !== undefined && config.tier.trim() !== '') return config.tier.trim();
  return defaultTier;
}

/**
 * Resolve o nome do TEMA salvo p/ aplicar no startup, SE houver. Ordem (a flag
 * `--theme`/COLORFGBG/auto-detecção é tratada pelo caller ANTES, com prioridade):
 * devolve `config.theme` quando válido, senão `undefined` (caller segue p/ a
 * auto-detecção/default). Não impõe default aqui — a ausência é sinal p/ o caller
 * cair na sua heurística (preferência do usuário > auto > default).
 */
export function configuredTheme(config: UserConfig): ThemeName | undefined {
  return config.theme;
}

/**
 * EST-0989 (i18n) — Resolve o IDIOMA salvo p/ aplicar no startup, SE houver. Espelha
 * o `configuredTheme`: devolve `config.lang` quando válido (já validado no load),
 * senão `undefined` — sinal p/ o caller cair no auto-detect do locale e, por fim, no
 * default pt-BR. A precedência completa (flag > config > auto-detect > pt-BR) mora no
 * `resolveInitialLang` (i18n/lang.ts), que recebe ESTE valor como o nível "config".
 */
export function configuredLang(config: UserConfig): Lang | undefined {
  return config.lang;
}

/**
 * EST-0990 — Resolve o estado INICIAL do split (`ui.splitView`). Ordem: `--split`
 * (flag, força ON) > `config.splitView` > default `false` (OFF — TUI de hoje). A flag
 * só LIGA (não há `--no-split` hoje); quando ausente, vale a preferência salva, e na
 * ausência dela o default OFF. PURO.
 */
export function resolveInitialSplitView(flag: boolean | undefined, config: UserConfig): boolean {
  if (flag === true) return true;
  return config.splitView ?? false;
}

/**
 * EST-1000 · ADR-0076 §1 — Resolve o estado INICIAL do MODO COCKPIT. Precedência
 * cravada no ADR §1: `--fullscreen` (flag de boot) > `ui.fullscreen` (pref persistida) >
 * default(INLINE=false). A flag só LIGA (não há `--no-fullscreen`; sair do cockpit em
 * sessão é o `/fullscreen` toggle); quando ausente, vale a pref salva; sem ela, o
 * DEFAULT é INLINE (ADR §1: "Opt-in NUNCA default — inline é o DEFAULT"). PURO.
 */
export function resolveInitialFullscreen(flag: boolean | undefined, config: UserConfig): boolean {
  if (flag === true) return true;
  return config.fullscreen ?? false;
}

/**
 * F197 — Resolve se a SUGESTÃO DE PRÓXIMO PROMPT nasce LIGADA. Precedência: env
 * `ALUY_SUGGESTIONS` (`0`/`false` desliga, `1`/`true` liga — override de sessão, estilo
 * dos demais `ALUY_*`) > `config.suggestions` (pref salva pelo `/suggest`) > default ON
 * (é uma OPÇÃO default-LIGADA, desligável). PURO. Diferente do split/fullscreen (default
 * OFF): aqui o default é ON por decisão do dono ("uma OPÇÃO ... default LIGADO").
 */
export function resolveInitialSuggestions(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env['ALUY_SUGGESTIONS']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return config.suggestions ?? true;
}

/**
 * EST-1112 · ADR-0119 — Resolve se o BUDGET LOCAL está ativo. Devolve o valor salvo
 * no config (`localBudget`) OU `undefined` se não salvo. NÃO impõe default aqui —
 * o default difere por backend (local=OFF, broker=ON), e quem chama decide.
 */
export function configuredLocalBudget(config: UserConfig): boolean | undefined {
  return config.localBudget;
}

/**
 * Embedder do mem0 EFETIVO (turbo): env `ALUY_MEM0_EMBEDDER` > `config.embedder` > default
 * (`DEFAULT_EMBEDDER_MODEL` = bge-m3). Sempre um slug VÁLIDO do catálogo (valida; lixo ⇒ default).
 * Fonte única p/ o provisioner (qual puxar+verificar), o boot (env do servidor) e o doctor.
 */
export function resolveEmbedderModel(
  config: UserConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env['ALUY_MEM0_EMBEDDER']?.trim();
  if (fromEnv !== undefined && fromEnv !== '' && embedderSpec(fromEnv) !== undefined)
    return fromEnv;
  if (config.embedder !== undefined && embedderSpec(config.embedder) !== undefined)
    return config.embedder;
  return DEFAULT_EMBEDDER_MODEL;
}
