// EST-0970 — `/doctor` (sessão) + `aluy doctor` (shell): HEALTH-CHECK read-only do
// aluy. Diagnostica instalação/config/conectividade e reporta OK/⚠/✗ por item, com
// a DICA de conserto (estilo do `/doctor` do Claude Code). Inspirado em design, sem
// cópia de código (Q9).
//
// Esta camada é PURA e testável: NÃO faz I/O. Recebe os FATOS já coletados (o probe
// `probe.ts` é quem toca keychain/broker/filesystem) e os MAPEIA em `DoctorCheck`
// com status + dica. Cada check é INDEPENDENTE — um falhar não derruba os outros
// (o probe captura erros e entrega um fato "indisponível", nunca lança aqui).
//
// REGRA DE STATUS:
//   • 'ok'   = verde ✓ — o item está saudável.
//   • 'warn' = amarelo ⚠ — degradado mas USÁVEL (ex.: catálogo de tier 401 ⇒ fallback;
//              um perfil .md rejeitado entre outros válidos; um server MCP legado).
//   • 'fail' = vermelho ✗ — quebrado de fato (ex.: sem credencial, broker fora,
//              config.json corrompido). SÓ 'fail' faz o `aluy doctor` sair com exit≠0.

import { DEFAULT_BROKER_BASE_URL } from '../model/config.js';

/** Host do PLACEHOLDER default do broker (quando `ALUY_BROKER_URL` não foi configurado). */
const PLACEHOLDER_BROKER_HOST = (() => {
  try {
    return new URL(DEFAULT_BROKER_BASE_URL).host;
  } catch {
    return DEFAULT_BROKER_BASE_URL;
  }
})();

/** Severidade de um item do diagnóstico. */
export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** Um item do diagnóstico: o que foi checado, o veredito e (se não-ok) como consertar. */
export interface DoctorCheck {
  /** Chave estável do check (p/ teste/ordenação; não exibida crua). */
  readonly id: string;
  /** Rótulo curto exibido (PT-BR). */
  readonly label: string;
  /** Veredito. */
  readonly status: DoctorStatus;
  /** Linha de detalhe (estado observado). Ex.: "broker.dev.aluy.example · 200". */
  readonly detail: string;
  /** Dica de conserto — só quando status≠ok (ex.: "rode `aluy login`"). */
  readonly fix?: string;
}

// ── FATOS de entrada (o que o probe coleta) ──────────────────────────────────
// Tipos pequenos e independentes: cada um descreve UM resultado já-coletado (ou o
// fato de que coletá-lo falhou). NUNCA carregam segredo (só metadados/contagens).

/** #1 Credencial/auth (reusa o check de credencial do whoami/#82). */
export interface AuthFact {
  /** Há credencial no keychain? */
  readonly present: boolean;
  /** Identificador do usuário (device-flow) ou undefined (PAT/desconhecido). */
  readonly user?: string;
  /** Org da credencial, se conhecida. */
  readonly org?: string;
  /** `pat` | `device`, se conhecido. */
  readonly kind?: string;
  /** O keychain do SO está acessível? (false ⇒ não dá nem p/ ler a credencial). */
  readonly keychainAvailable: boolean;
  /**
   * EST-0970 (validação ATIVA) — a credencial AUTENTICA de verdade? Um toque LEVE no
   * broker que EXIGE auth mas NÃO gasta modelo (`GET /v1/quota`, GET sem body — #123).
   * `true` = o broker aceitou o PAT (200) ⇒ credencial BOA; `false` = recusou (401/403)
   * ⇒ credencial INVÁLIDA ("rode aluy login"); `undefined` = não deu p/ validar (broker
   * fora / sem token / não-probed) ⇒ NÃO derruba (degrada p/ "presente, não-validado").
   */
  readonly authValidated?: boolean;
  /** Status HTTP do toque de validação (quando houve resposta) — p/ o detalhe. */
  readonly authStatus?: number;
}

/** Resultado de um ping HTTP leve (broker/catálogo/custom). */
export interface ProbeFact {
  /** Alcançou o servidor? (false = timeout/transporte/DNS — servidor fora). */
  readonly reached: boolean;
  /** Status HTTP, se houve resposta. */
  readonly status?: number;
}

/** #2 Broker — ping leve em `/healthz` (sem auth, sem gasto de modelo). */
export interface BrokerFact {
  readonly url: string;
  readonly probe: ProbeFact;
  /**
   * Backend local (ADR-0120 BYO): o broker NÃO é usado ⇒ o check vira N/A (ok),
   * não ✗ "inalcançável" (falso-negativo no modo local). EST-1133-bis.
   */
  readonly localSkip?: boolean;
}

/** #3 Catálogo de tiers + modelos custom. */
export interface CatalogFact {
  /** `GET /v1/tiers/catalog`. */
  readonly tiers: ProbeFact;
  /** `GET /v1/models/custom`. */
  readonly custom: ProbeFact;
  /** Quantos modelos custom o broker devolveu (quando 200). */
  readonly customCount?: number;
  /** Backend local: catálogo do broker não se aplica ⇒ N/A (ok). */
  readonly localSkip?: boolean;
}

/** Um server MCP listado (subset do McpListedServer, só o que o doctor precisa). */
export interface McpServerFact {
  readonly name: string;
  readonly origin: string;
  /** `true` se a config é inválida (ex.: command legado `--`). */
  readonly invalid: boolean;
  /** Aviso pronto (com a correção) quando inválida. */
  readonly invalidWarning?: string;
  /** `true` se o server está desativado (`disabled: true`). */
  readonly disabled: boolean;
  /**
   * EST-0970 (validação ATIVA) — resultado do HANDSHAKE REAL: conectamos ao server
   * (lança o processo, faz o initialize) e contamos as tools. `true` = conectou
   * (`toolCount` válido); `false` = falhou (`connectError` com a causa); `undefined` =
   * NÃO tentamos conectar (config inválida/desativado, ou conexão desligada no probe).
   */
  readonly connected?: boolean;
  /** Quantas tools o server expôs no handshake (quando `connected`). */
  readonly toolCount?: number;
  /** Mensagem de erro do handshake (quando `connected===false`). */
  readonly connectError?: string;
}

/** #4 MCP — servers configurados + erros de parse de config. */
export interface McpFact {
  readonly servers: readonly McpServerFact[];
  /** Erros de leitura/parse das fontes de config (ex.: JSON inválido). */
  readonly configErrors: readonly string[];
}

/** Um perfil de agente rejeitado (RES-MD-3) — só metadados. */
export interface RejectedProfileFact {
  readonly file: string;
  readonly reason: string;
}

/** #5 Perfis de agente (.md) — válidos + rejeitados (fail-closed RES-MD-3). */
export interface AgentsFact {
  readonly validCount: number;
  readonly rejected: readonly RejectedProfileFact[];
}

/** #6 Config — `~/.aluy/config.json` + limites/flags efetivos. */
export interface ConfigFact {
  /** A config existe? (false = 1ª execução, defaults — NÃO é erro). */
  readonly exists: boolean;
  /** O arquivo está corrompido (JSON inválido)? (existe-mas-ilegível ⇒ ✗). */
  readonly corrupted: boolean;
  /** Tema salvo, se houver. */
  readonly theme?: string;
  /** Tier salvo, se houver. */
  readonly tier?: string;
  /**
   * EST-0970 (validação de VALORES) — o `theme` salvo EXISTE no catálogo de temas?
   * `undefined` quando não há tema salvo (defaults). `false` ⇒ ⚠ (tema órfão: cai no
   * default, mas o `/theme` salvou um nome que não resolve — vale o aviso).
   */
  readonly themeKnown?: boolean;
  /**
   * EST-0970 (validação de VALORES) — o `tier` salvo EXISTE no catálogo conhecido/
   * fallback? `undefined` sem tier salvo. `false` ⇒ ⚠ (tier desconhecido: pode ser um
   * tier novo do broker OU um nome inválido — degrada, nunca ✗).
   */
  readonly tierKnown?: boolean;
  /** Teto efetivo de tokens (resolvido flag>env>default). */
  readonly maxTokens: number;
  /** Teto efetivo de iterações (resolvido flag>env>default). */
  readonly maxIterations: number;
  /** Flags ativas (ex.: `--yolo`, `ALUY_NATIVE_TOOLS_OFF`). */
  readonly flags: readonly string[];
}

/** #7 Versão/build — versão do aluy + node. */
export interface VersionFact {
  readonly aluy: string;
  readonly node: string;
}

/** #8 Memória — store acessível? quantos fatos? (só conta, não despeja). */
export interface MemoryFact {
  /** O store foi lido com sucesso? (false = ilegível/erro ⇒ ✗). */
  readonly accessible: boolean;
  /** Quantos fatos persistidos (quando acessível). */
  readonly count: number;
}

/** #9 Sidecars do Maestro — estado dos 3 sidecars + perfil ativo (read-only). */
export interface SidecarsFact {
  /** Probe do headroom em `GET http://127.0.0.1:8787/health`. */
  readonly headroom: ProbeFact;
  /** Probe do Ollama em `GET http://127.0.0.1:11434/api/tags`. */
  readonly ollama: ProbeFact;
  /** Probe do Mem0 em `GET http://127.0.0.1:11435/health`. */
  readonly mem0: ProbeFact;
  /** Perfil ativo: `leve` | `turbo`. */
  readonly profile: 'leve' | 'turbo';
  /** Toggles ON (ex.: `['ollama']`). Default TURBO = ['ollama', 'mem0']. */
  readonly toggles: readonly string[];
}

/** #10 Maestro — supervisor de sessão. Reusa `resolveMaestro` do wiring. */
export interface MaestroFact {
  /** Maestro está ligado? (`resolveMaestro` não retornou `undefined`). */
  readonly enabled: boolean;
}

/**
 * EST-0970 (--deep / opt-in que GASTA modelo) — teste REAL do tier corrente: manda 1
 * token mínimo ao modelo p/ provar que o tier RESPONDE. SÓ coletado sob `--deep`/`--test`
 * (custa 1 chamada). Ausente no `/doctor` rápido (default NÃO chama modelo — valida auth
 * via GET, não via chat).
 */
export interface TierFact {
  /** O tier corrente testado (ex.: `aluy-granito`). */
  readonly tier: string;
  /** O modelo respondeu? `true` = o tier está VIVO (respondeu); `false` = falhou. */
  readonly responded: boolean;
  /** Causa da falha (broker fora / sem crédito / provedor) quando `responded===false`. */
  readonly error?: string;
}

/** Todos os fatos coletados pelo probe — entrada da camada de checks. */
export interface DoctorFacts {
  readonly auth: AuthFact;
  readonly broker: BrokerFact;
  readonly catalog: CatalogFact;
  readonly mcp: McpFact;
  readonly agents: AgentsFact;
  readonly config: ConfigFact;
  readonly version: VersionFact;
  readonly memory: MemoryFact;
  /** #9 Sidecars do Maestro — estado dos 3 sidecars + perfil ativo. */
  readonly sidecars: SidecarsFact;
  /** #10 Maestro — supervisor de sessão (resolveMaestro do wiring). */
  readonly maestro: MaestroFact;
  /**
   * EST-0970 — só presente sob `--deep`/`--test` (opt-in que GASTA modelo). Ausente ⇒ o
   * relatório NÃO inclui a linha do tier (o default não chama o modelo).
   */
  readonly tier?: TierFact;
}

/** O relatório completo: a lista ordenada de checks. */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
}

// ── builders por check (puros) ───────────────────────────────────────────────

function checkAuth(f: AuthFact): DoctorCheck {
  if (!f.keychainAvailable) {
    return {
      id: 'auth',
      label: 'credencial',
      status: 'fail',
      detail: 'keychain do SO indisponível',
      fix: 'instale um keychain (libsecret/Keychain/Credential Manager) e rode `aluy login`.',
    };
  }
  if (!f.present) {
    return {
      id: 'auth',
      label: 'credencial',
      status: 'fail',
      detail: 'não autenticado',
      fix: 'rode `aluy login`.',
    };
  }
  const who = f.user ?? (f.kind === 'pat' ? 'PAT' : '—');
  const org = f.org !== undefined ? ` · org ${f.org}` : '';
  // EST-0970 (validação ATIVA) — a credencial está presente; o toque LEVE no broker
  // (`GET /v1/quota`, sem modelo) prova que AUTENTICA. 401/403 ⇒ a credencial existe no
  // keychain mas o broker a RECUSA (expirada/revogada) ⇒ ✗ "rode aluy login". 200 ⇒
  // "autenticado". Sem validação possível (broker fora / não-probed) ⇒ degrada p/ ✓
  // "presente (não-validado)" — NÃO inventa ✗ por não ter alcançado o broker.
  if (f.authValidated === false) {
    return {
      id: 'auth',
      label: 'credencial',
      status: 'fail',
      detail: `${who}${org} · broker recusou (${f.authStatus ?? '401'})`,
      fix: 'credencial inválida/expirada — rode `aluy login`.',
    };
  }
  const validNote = f.authValidated === true ? ' · autenticado' : ' · presente (não-validado)';
  return { id: 'auth', label: 'credencial', status: 'ok', detail: `${who}${org}${validNote}` };
}

function checkBroker(f: BrokerFact): DoctorCheck {
  // Backend local (BYO): o modelo NÃO passa pelo broker ⇒ pingá-lo é irrelevante.
  // N/A (ok), não ✗ — evita falso-negativo no modo local (EST-1133-bis).
  if (f.localSkip) {
    return {
      id: 'broker',
      label: 'broker',
      status: 'ok',
      detail: 'N/A (backend local — BYO, sem broker)',
    };
  }
  const host = hostOf(f.url);
  const p = f.probe;
  if (!p.reached) {
    // EST-1015 — mensagem ENGANOSA: quando o host é o PLACEHOLDER default (`ALUY_BROKER_URL`
    // não configurado), "o broker pode estar fora" sugere um broker real caído. O correto é
    // dizer que NÃO HÁ broker configurado e como apontar um. Distingue "não-configurado" de
    // "configurado-mas-fora".
    const isPlaceholder = host === PLACEHOLDER_BROKER_HOST;
    return {
      id: 'broker',
      label: 'broker',
      status: 'fail',
      detail: isPlaceholder ? `${host} · inalcançável (placeholder)` : `${host} · inalcançável`,
      fix: isPlaceholder
        ? 'ALUY_BROKER_URL não configurado — `broker.dev.aluy.example` é um placeholder de dev. ' +
          'Defina ALUY_BROKER_URL p/ o seu broker (ex.: `export ALUY_BROKER_URL=http://127.0.0.1:8121` em dev).'
        : 'cheque a rede e o ALUY_BROKER_URL; o broker pode estar fora.',
    };
  }
  // /healthz é EXEMPT de auth (não deve dar 401); qualquer 2xx ⇒ ok.
  if (p.status !== undefined && p.status >= 200 && p.status < 300) {
    return { id: 'broker', label: 'broker', status: 'ok', detail: `${host} · ${p.status}` };
  }
  if (p.status === 401 || p.status === 403) {
    return {
      id: 'broker',
      label: 'broker',
      status: 'fail',
      detail: `${host} · ${p.status}`,
      fix: 'credencial recusada — rode `aluy login`.',
    };
  }
  return {
    id: 'broker',
    label: 'broker',
    status: 'warn',
    detail: `${host} · ${p.status ?? '?'}`,
    fix: 'broker respondeu, mas não-ok no /healthz — verifique o status do serviço.',
  };
}

function checkCatalog(f: CatalogFact): DoctorCheck {
  // Backend local (BYO): o catálogo de tiers/custom do broker não se aplica ⇒ N/A (ok).
  if (f.localSkip) {
    return {
      id: 'catalog',
      label: 'catálogo/tiers',
      status: 'ok',
      detail: 'N/A (backend local — modelo/base_url vêm da config BYO)',
    };
  }
  // O `GET /v1/tiers/catalog` HOJE dá 401 (sem o scope/sem login pleno): isso é ⚠
  // "usando fallback", NUNCA ✗ (o `/model` segue trocando tier offline). `/v1/models/
  // custom` 200 é o sinal saudável (conta os modelos). Broker fora ⇒ ⚠ (degradado).
  const tiers = f.tiers;
  const custom = f.custom;
  const customOk = custom.reached && custom.status !== undefined && ok2xx(custom.status);
  const tiersOk = tiers.reached && tiers.status !== undefined && ok2xx(tiers.status);

  if (!tiers.reached && !custom.reached) {
    return {
      id: 'catalog',
      label: 'catálogo/tiers',
      status: 'warn',
      detail: 'broker fora — usando o catálogo fallback',
      fix: 'sem o catálogo do broker o /model usa os tiers conhecidos; cheque o broker.',
    };
  }
  if (tiersOk && customOk) {
    const n = f.customCount ?? 0;
    return {
      id: 'catalog',
      label: 'catálogo/tiers',
      status: 'ok',
      detail: `catálogo ok · ${n} modelo(s) custom`,
    };
  }
  // Catálogo de tier indisponível (ex.: 401) ⇒ ⚠ fallback (não ✗).
  const tierDetail = tiersOk
    ? 'catálogo de tier ok'
    : `catálogo de tier indisponível (${statusText(tiers)})`;
  const customDetail = customOk
    ? `${f.customCount ?? 0} modelo(s) custom`
    : `custom indisponível (${statusText(custom)})`;
  return {
    id: 'catalog',
    label: 'catálogo/tiers',
    status: 'warn',
    detail: `${tierDetail} · ${customDetail} — usando fallback`,
    fix: 'o /model cai no catálogo fallback; rode `aluy login` se for falta de scope.',
  };
}

function checkMcp(f: McpFact): DoctorCheck {
  const total = f.servers.length;
  const invalid = f.servers.filter((s) => s.invalid);
  const disabled = f.servers.filter((s) => s.disabled && !s.invalid);
  const active = total - invalid.length - disabled.length;

  if (f.configErrors.length > 0) {
    return {
      id: 'mcp',
      label: 'MCP',
      status: 'fail',
      detail: `config inválida: ${f.configErrors[0]}`,
      fix: 'conserte o JSON do mcp.json (~/.aluy/mcp.json ou .mcp.json do projeto).',
    };
  }
  if (total === 0) {
    return { id: 'mcp', label: 'MCP', status: 'ok', detail: 'nenhum server configurado' };
  }
  if (invalid.length > 0) {
    const w = invalid[0]?.invalidWarning ?? `server "${invalid[0]?.name}" com command inválido`;
    return {
      id: 'mcp',
      label: 'MCP',
      status: 'warn',
      detail: `${total} server(es) · ${invalid.length} com config inválida`,
      fix: w,
    };
  }

  // EST-0970 (validação ATIVA) — quando o probe TENTOU conectar (handshake real), os
  // servers carregam `connected`/`toolCount`/`connectError`. Um que FALHOU ao conectar ⇒
  // ✗ "X · falhou ao conectar: <erro>" (é o teste de verdade, não só leitura). Os que
  // conectaram viram "✓ playwright · 21 tools". Se o probe NÃO tentou conectar (todos
  // `connected===undefined`), cai no resumo de presença anterior (sem regressão #120).
  const probed = active > 0 && f.servers.some((s) => s.connected !== undefined);
  if (probed) {
    const failed = f.servers.filter((s) => s.connected === false);
    const okServers = f.servers.filter((s) => s.connected === true);
    const okDesc = okServers.map((s) => `${s.name} · ${s.toolCount ?? 0} tools`).join(', ');
    if (failed.length > 0) {
      const first = failed[0]!;
      const okPart = okServers.length > 0 ? ` · ok: ${okDesc}` : '';
      return {
        id: 'mcp',
        label: 'MCP',
        status: 'fail',
        detail: `${failed.length}/${active} falhou ao conectar — ${first.name}: ${first.connectError ?? 'erro'}${okPart}`,
        fix: 'cheque o command/args do server no mcp.json e se o binário está instalado.',
      };
    }
    const dis = disabled.length > 0 ? ` · ${disabled.length} desativado(s)` : '';
    return {
      id: 'mcp',
      label: 'MCP',
      status: 'ok',
      detail: `${okServers.length} conectado(s): ${okDesc}${dis}`,
    };
  }

  const parts = [`${active} ativo(s)`];
  if (disabled.length > 0) parts.push(`${disabled.length} desativado(s)`);
  return {
    id: 'mcp',
    label: 'MCP',
    status: 'ok',
    detail: `${total} server(es) · ${parts.join(', ')}`,
  };
}

function checkAgents(f: AgentsFact): DoctorCheck {
  if (f.rejected.length > 0) {
    const first = f.rejected[0];
    return {
      id: 'agents',
      label: 'perfis de agente',
      status: 'warn',
      detail: `${f.validCount} válido(s) · ${f.rejected.length} rejeitado(s): ${first?.file} (${first?.reason})`,
      fix: 'conserte o frontmatter do .md (ex.: `tools:` precisa ser uma lista legível — RES-MD-3 falha fechada).',
    };
  }
  return {
    id: 'agents',
    label: 'perfis de agente',
    status: 'ok',
    detail: f.validCount === 0 ? 'nenhum perfil' : `${f.validCount} válido(s)`,
  };
}

function checkConfig(f: ConfigFact): DoctorCheck {
  const limits = `max-tokens ${f.maxTokens} · max-iterations ${f.maxIterations}`;
  const flags = f.flags.length > 0 ? ` · flags: ${f.flags.join(', ')}` : '';
  if (f.corrupted) {
    return {
      id: 'config',
      label: 'config',
      status: 'fail',
      detail: `~/.aluy/config.json corrompido (JSON inválido) — usando defaults · ${limits}${flags}`,
      fix: 'conserte ou apague ~/.aluy/config.json (será recriado pelo /theme e /model).',
    };
  }
  const pref: string[] = [];
  if (f.theme !== undefined) pref.push(`tema ${f.theme}`);
  if (f.tier !== undefined) pref.push(`tier ${f.tier}`);
  const prefStr = f.exists && pref.length > 0 ? pref.join(', ') : 'defaults';

  // EST-0970 (validação de VALORES, não só presença) — um `theme`/`tier` salvo que NÃO
  // resolve no catálogo é ⚠ (não ✗: o app cai no default e segue): o `/theme`/`/model`
  // gravou um nome órfão (typo, tema removido, tier renomeado). Avisa com a correção.
  const badTheme = f.theme !== undefined && f.themeKnown === false;
  const badTier = f.tier !== undefined && f.tierKnown === false;
  if (badTheme || badTier) {
    const probs: string[] = [];
    if (badTheme) probs.push(`tema "${f.theme}" não está no catálogo`);
    if (badTier) probs.push(`tier "${f.tier}" desconhecido`);
    return {
      id: 'config',
      label: 'config',
      status: 'warn',
      detail: `${probs.join(' · ')} — usando defaults · ${limits}${flags}`,
      fix: badTheme
        ? 'rode `/theme` p/ escolher um tema válido (dark/light/slate).'
        : 'rode `/model` p/ escolher um tier conhecido.',
    };
  }
  return {
    id: 'config',
    label: 'config',
    status: 'ok',
    detail: `${prefStr} · ${limits}${flags}`,
  };
}

// ── #9 (--deep) tier ao vivo — opt-in que GASTA modelo ───────────────────────
function checkTier(f: TierFact): DoctorCheck {
  if (f.responded) {
    return {
      id: 'tier',
      label: 'tier (--deep)',
      status: 'ok',
      detail: `${f.tier} respondeu ao modelo`,
    };
  }
  return {
    id: 'tier',
    label: 'tier (--deep)',
    status: 'fail',
    detail: `${f.tier} não respondeu${f.error ? ` · ${f.error}` : ''}`,
    fix: 'o tier não respondeu ao modelo — cheque crédito (`/usage`), o broker e o `/model`.',
  };
}

function checkVersion(f: VersionFact): DoctorCheck {
  return {
    id: 'version',
    label: 'versão',
    status: 'ok',
    detail: `aluy ${f.aluy} · node ${f.node}`,
  };
}

function checkMemory(f: MemoryFact): DoctorCheck {
  if (!f.accessible) {
    return {
      id: 'memory',
      label: 'memória',
      status: 'fail',
      detail: 'store de memória ilegível',
      fix: 'cheque permissões de ~/.aluy/ (deve ser 0700, seu).',
    };
  }
  return {
    id: 'memory',
    label: 'memória',
    status: 'ok',
    detail: f.count === 0 ? 'store ok · 0 fato' : `store ok · ${f.count} fato(s)`,
  };
}

// ── #10 sidecars do Maestro ──────────────────────────────────────────────
function checkSidecars(f: SidecarsFact): DoctorCheck {
  const parts: string[] = [];
  let fail = false;
  let warn = false;

  // headroom
  if (f.headroom.reached && f.headroom.status !== undefined && ok2xx(f.headroom.status)) {
    parts.push(`headroom ✓ (${f.headroom.status})`);
  } else if (f.headroom.reached) {
    parts.push(`headroom ⚠ (${f.headroom.status ?? '?'})`);
    warn = true;
  } else {
    parts.push('headroom ✗ (fora)');
    fail = true;
  }

  // ollama
  if (f.ollama.reached && f.ollama.status !== undefined && ok2xx(f.ollama.status)) {
    parts.push(`ollama ✓ (${f.ollama.status})`);
  } else if (f.ollama.reached) {
    parts.push(`ollama ⚠ (${f.ollama.status ?? '?'})`);
    warn = true;
  } else {
    parts.push('ollama ✗ (fora)');
    fail = true;
  }

  // mem0
  if (f.mem0.reached && f.mem0.status !== undefined && ok2xx(f.mem0.status)) {
    parts.push(`mem0 ✓ (${f.mem0.status})`);
  } else if (f.mem0.reached) {
    parts.push(`mem0 ⚠ (${f.mem0.status ?? '?'})`);
    warn = true;
  } else {
    parts.push('mem0 ✗ (fora)');
    fail = true;
  }

  const toggleList = f.toggles.length > 0 ? f.toggles.join(', ') : 'nenhum';
  parts.push(`perfil ${f.profile.toUpperCase()} (toggles: ${toggleList})`);

  const status: DoctorStatus = fail ? 'fail' : warn ? 'warn' : 'ok';
  const fix = fail
    ? 'sidecar(es) fora — provisione/suba com `aluy init` (perfil TURBO). No boot eles sobem sozinhos se já instalados.'
    : warn
      ? 'sidecar(es) com status inesperado — cheque os logs do Maestro.'
      : undefined;

  return {
    id: 'sidecars',
    label: 'sidecars/Maestro',
    status,
    detail: parts.join(' · '),
    ...(fix !== undefined ? { fix } : {}),
  };
}

function checkMaestro(f: MaestroFact): DoctorCheck {
  return {
    id: 'maestro',
    label: 'Maestro',
    status: 'ok',
    detail: f.enabled ? 'ligado' : 'desligado',
  };
}

/**
 * Constrói o relatório completo a partir dos fatos coletados. Ordem ESTÁVEL (a do
 * enunciado: auth → broker → catálogo → mcp → perfis → config → versão → memória →
 * sidecars → maestro).
 * Puro: cada builder é independente; não lança.
 */
export function buildDoctorReport(facts: DoctorFacts): DoctorReport {
  const checks: DoctorCheck[] = [
    checkAuth(facts.auth),
    checkBroker(facts.broker),
    checkCatalog(facts.catalog),
    checkMcp(facts.mcp),
    checkAgents(facts.agents),
    checkConfig(facts.config),
    checkVersion(facts.version),
    checkMemory(facts.memory),
    checkSidecars(facts.sidecars),
    checkMaestro(facts.maestro),
  ];
  // EST-0970 (--deep) — a linha do tier ao vivo só entra quando o probe a coletou (opt-in
  // que gasta modelo). Sem `--deep`, `facts.tier` é undefined ⇒ relatório idêntico ao #120
  // (o default NÃO chama o modelo).
  if (facts.tier !== undefined) checks.push(checkTier(facts.tier));
  return { checks };
}

/**
 * EST-0970 — a ORDEM ESTÁVEL dos `id`s dos checks (a mesma de `buildDoctorReport`). A UI
 * ao vivo semeia a checklist com TODOS os itens em `pending` ANTES de coletar os fatos
 * (os ticks "acendem" um a um). `deep` inclui o item do tier ao fim. PURA/testável.
 */
export function plannedCheckIds(deep = false): readonly { id: string; label: string }[] {
  const base = [
    { id: 'auth', label: 'credencial' },
    { id: 'broker', label: 'broker' },
    { id: 'catalog', label: 'catálogo/tiers' },
    { id: 'mcp', label: 'MCP' },
    { id: 'agents', label: 'perfis de agente' },
    { id: 'config', label: 'config' },
    { id: 'version', label: 'versão' },
    { id: 'memory', label: 'memória' },
    { id: 'sidecars', label: 'sidecars/Maestro' },
    { id: 'maestro', label: 'Maestro' },
  ];
  return deep ? [...base, { id: 'tier', label: 'tier (--deep)' }] : base;
}

/** `true` se há ALGUM ✗ no relatório (⇒ `aluy doctor` sai com exit≠0). */
export function hasFailure(report: DoctorReport): boolean {
  return report.checks.some((c) => c.status === 'fail');
}

/**
 * EST-0970 (ticks AO VIVO) — constrói o `DoctorCheck` de UM id a partir dos fatos PARCIAIS
 * coletados até agora. Devolve `undefined` se o fato daquele check ainda não resolveu (o
 * item segue `pending` na UI). É o mapeamento incremental que acende cada tick um a um —
 * reusa EXATAMENTE os mesmos builders do relatório final (zero divergência). Puro.
 */
export function buildSingleCheck(id: string, facts: Partial<DoctorFacts>): DoctorCheck | undefined {
  switch (id) {
    case 'auth':
      return facts.auth ? checkAuth(facts.auth) : undefined;
    case 'broker':
      return facts.broker ? checkBroker(facts.broker) : undefined;
    case 'catalog':
      return facts.catalog ? checkCatalog(facts.catalog) : undefined;
    case 'mcp':
      return facts.mcp ? checkMcp(facts.mcp) : undefined;
    case 'agents':
      return facts.agents ? checkAgents(facts.agents) : undefined;
    case 'config':
      return facts.config ? checkConfig(facts.config) : undefined;
    case 'version':
      return facts.version ? checkVersion(facts.version) : undefined;
    case 'memory':
      return facts.memory ? checkMemory(facts.memory) : undefined;
    case 'sidecars':
      return facts.sidecars ? checkSidecars(facts.sidecars) : undefined;
    case 'maestro':
      return facts.maestro ? checkMaestro(facts.maestro) : undefined;
    case 'tier':
      return facts.tier ? checkTier(facts.tier) : undefined;
    default:
      return undefined;
  }
}

/** Resumo `N ok · N aviso · N falha` de um relatório (compartilhado UI/shell). PURO. */
export function summarize(checks: readonly DoctorCheck[]): string {
  let nOk = 0;
  let nWarn = 0;
  let nFail = 0;
  for (const c of checks) {
    if (c.status === 'ok') nOk++;
    else if (c.status === 'warn') nWarn++;
    else nFail++;
  }
  return `${nOk} ok · ${nWarn} aviso · ${nFail} falha`;
}

// ── helpers puros ────────────────────────────────────────────────────────────

function ok2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function statusText(p: ProbeFact): string {
  if (!p.reached) return 'broker fora';
  return p.status !== undefined ? String(p.status) : '?';
}

/** Extrai só o host de uma URL p/ exibição compacta (fail-safe: devolve cru). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
