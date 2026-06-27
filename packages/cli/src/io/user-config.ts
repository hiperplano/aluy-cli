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
  readonly localAuth?: 'apikey' | 'oauth';
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
   * ADR-0136 (config único) — catálogo de providers LOCAIS do usuário, ABSORVIDO do
   * antigo `~/.aluy/providers.json` (que passa a `.migrated`). É DADO PÚBLICO
   * (id/label/base_url/slug — CLI-SEC-7), NUNCA credencial (essa fica no keychain/env
   * por provider). Cada entrada espelha `LocalProviderEntry` cru; a validação profunda
   * é no `buildLocalCatalog` do core, no uso. Ausente ⇒ só o catálogo embutido.
   */
  readonly providers?: readonly UserProviderEntry[];
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

/**
 * Sanitiza o array de providers do config (ADR-0136). Mantém só entradas BEM-FORMADAS
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
    backend?: 'broker' | 'local';
    localProvider?: string;
    localModel?: string;
    localAuth?: 'apikey' | 'oauth';
    localBaseUrl?: string;
    localBudget?: boolean;
    rooms?: { backend?: string };
    profile?: 'turbo' | 'leve';
    sidecarToggles?: { ollama?: boolean; mem0?: boolean; headroom?: boolean };
    providers?: readonly UserProviderEntry[];
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
  // ADR-0120 — backend: só `broker`|`local` (lixo ⇒ descartado ⇒ default broker).
  if (obj.backend === 'broker' || obj.backend === 'local') out.backend = obj.backend;
  // ADR-0120 / ADR-0118 — localProvider: SLUG opaco razoável (ABERTO/config-driven).
  // Aceita qualquer id do catálogo (built-ins + providers.json, incl. custom); a
  // validação real é no catálogo, no uso. (Antes travava nos 3 ⇒ custom era descartado.)
  if (isReasonableOpaque(obj.localProvider)) out.localProvider = obj.localProvider.trim();
  // ADR-0120 — localModel: string opaca razoável (MESMA forma do tier).
  if (isReasonableOpaque(obj.localModel)) out.localModel = obj.localModel.trim();
  // ADR-0120 — localAuth: só `apikey`|`oauth` (lixo ⇒ descartado ⇒ default apikey).
  if (obj.localAuth === 'apikey' || obj.localAuth === 'oauth') out.localAuth = obj.localAuth;
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

  // ADR-0136 (config único) — providers absorvidos do antigo providers.json.
  const providers = sanitizeProviderEntries(obj.providers);
  if (providers) out.providers = providers;

  return out;
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
   * EST-1112 · ADR-0119 — Açúcar: persiste a preferência de budget local
   * (`/budget`/`--budget`), preservando as demais. `true` ⇒ a próxima sessão
   * local reabre com budget ON; `false` ⇒ budget OFF no local. NÃO tem efeito
   * no remoto/broker. Só pref de custo.
   */
  saveLocalBudget(localBudget: boolean): boolean {
    return this.save({ localBudget });
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
 * EST-1112 · ADR-0119 — Resolve se o BUDGET LOCAL está ativo. Devolve o valor salvo
 * no config (`localBudget`) OU `undefined` se não salvo. NÃO impõe default aqui —
 * o default difere por backend (local=OFF, broker=ON), e quem chama decide.
 */
export function configuredLocalBudget(config: UserConfig): boolean | undefined {
  return config.localBudget;
}
