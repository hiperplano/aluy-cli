// EST-0948 · CLI-SEC-5 — EGRESS ALLOWLIST default-deny (cravada do `seguranca`).
//
// Nasce JUNTO do seam de bash concreto (shell-port.ts): todo comando de shell que
// fala com a rede tem o DESTINO inspecionado contra uma allowlist. A allowlist é
// DEFAULT-DENY: só os hosts da própria Aluy (broker/identity) e, opcionalmente,
// hosts liberados por config local nascem permitidos. Destino FORA da allowlist
// ⇒ a TUI mostra `⚠ rede · ask · destino fora da allowlist` com o host EXATO
// (CLI-SEC-5) e o usuário aprova "para onde" o dado vai.
//
// IMPORTANTE: este módulo NÃO decide allow/ask/deny sozinho — a catraca (EST-0945)
// já força `ask` p/ qualquer comando de rede (categoria `always-ask:network`,
// não-relaxável). O papel da allowlist é ENRIQUECER o `ask`: marcar se o destino
// está dentro (silencioso) ou fora (warning explícito) da allowlist, e extrair o
// host exato. É a base concreta do `⚠ rede` da spec-tui §2.8.
//
// PORTÁVEL? É lógica de string (sem rede real), mas vive no @hiperplano/aluy-cli porque a
// allowlist concreta (hosts da Aluy + config local) é wiring do locus.

/** Os hosts da própria Aluy — sempre na allowlist (broker/identity). */
const ALUY_DEFAULT_HOSTS: readonly string[] = [
  // Sufixos de domínio da Aluy. Um host casa se for igual ou subdomínio destes.
  'aluy.app',
  'aluy.dev',
  'aluy.example', // defaults de dev (.env.example)
];

/**
 * EST-0971 (fix) · CLI-SEC-5/13 — os hosts do DuckDuckGo, BACKEND SANCIONADO do
 * `web_search`. São default-allowed para que a busca funcione out-of-the-box (o
 * usuário NÃO escolhe o host do search; é fixo, é a Aluy quem o crava). Isto é
 * SÓ para a checagem de egress-allowlist (CLI-SEC-5): o DDG resolve para IP
 * PÚBLICO e CONTINUA passando por toda a malha anti-SSRF (denylist dura de IP +
 * pin + revalidação de redirect, ssrf.ts/fetcher.ts). Um DDG comprometido/rebind
 * para um IP interno SEGUE sendo barrado no IP — o default-allow aqui NÃO
 * enfraquece a denylist. `web_fetch` para hosts arbitrários NÃO é coberto por
 * isto: segue exigindo allowlist do usuário (default-deny estrito).
 */
export const DDG_SEARCH_HOSTS: readonly string[] = [
  'html.duckduckgo.com', // endpoint HTML usado pelo web_search (ddg.ts)
  'lite.duckduckgo.com', // fallback HTML "lite" do DDG
  'duckduckgo.com', // domínio raiz (redirect /l/?uddg=… desembrulhado pela busca)
];

/** Resultado da inspeção de egress de um comando. */
export interface EgressInspection {
  /** `true` se o comando aciona rede (tem destino externo detectável). */
  readonly hasNetwork: boolean;
  /** O destino/host exato extraído (CLI-SEC-9), quando detectável. */
  readonly target?: string;
  /**
   * `true` se o destino está FORA da allowlist (default-deny). A TUI mostra o
   * warning `⚠ rede · ask · destino fora da allowlist`. `false` quando o destino
   * está na allowlist (rede silenciosa) OU quando não há destino detectável.
   */
  readonly outsideAllowlist: boolean;
}

export interface EgressAllowlistOptions {
  /**
   * Hosts/sufixos extra liberados por config local (`~/.aluy/config`). DADO, não
   * código. Default-deny: começa só com os hosts da Aluy; estes ESTENDEM.
   */
  readonly allow?: readonly string[];
  /** Override dos hosts default da Aluy (testes). */
  readonly aluyHosts?: readonly string[];
  /**
   * EST-0971 (fix) — inclui os hosts do DDG (backend do `web_search`) no default.
   * `true` (default): a busca funciona out-of-the-box. `false`: só p/ testes que
   * provam o comportamento sem o seed (ex.: que SEM o seed o host do DDG é negado).
   * NÃO afeta o anti-SSRF — é só a checagem de egress-allowlist (CLI-SEC-5).
   */
  readonly includeSearchHosts?: boolean;
}

/**
 * Allowlist de egress default-deny (CLI-SEC-5). Construída com os hosts da Aluy
 * + os liberados por config. `inspect()` extrai o destino de um comando e diz se
 * está dentro ou fora.
 */
export class EgressAllowlist {
  private readonly allowed: readonly string[];

  constructor(opts: EgressAllowlistOptions = {}) {
    const base = opts.aluyHosts ?? ALUY_DEFAULT_HOSTS;
    // EST-0971 (fix): o backend do `web_search` (DDG) nasce permitido p/ a busca
    // funcionar sem config. Só CLI-SEC-5 (egress); a denylist de IP segue valendo.
    const search = opts.includeSearchHosts === false ? [] : DDG_SEARCH_HOSTS;
    const extra = (opts.allow ?? []).map(normalizeHost).filter(Boolean);
    this.allowed = [...base, ...search, ...extra];
  }

  /** `true` se `host` casa um sufixo permitido (igual ou subdomínio). */
  isAllowed(host: string): boolean {
    const h = normalizeHost(host);
    if (!h) return false;
    return this.allowed.some((suffix) => h === suffix || h.endsWith('.' + suffix));
  }

  /**
   * Inspeciona o egress de um comando de shell. Extrai o host do 1º destino de
   * rede (URL `http(s)://`, `user@host`, ou alvo de ssh/scp/curl). DEFAULT-DENY:
   * se há destino e ele NÃO está na allowlist ⇒ `outsideAllowlist=true`.
   */
  inspect(command: string): EgressInspection {
    // SEC-SBX-NET-1 (gate AG-0008): default-deny sobre o CONJUNTO de destinos do comando,
    // NÃO só o 1º host. O `--share-net` do sandbox vale pro `sh -c <comando>` INTEIRO — então
    // `curl ok && curl evil` abriria rede pro comando todo, vazando p/ `evil` (que a catraca
    // nem mostra). Logo: `outsideAllowlist` é true se QUALQUER destino está fora da allowlist;
    // a rede só abre quando TODOS os destinos da linha são permitidos. `target` (display da
    // catraca, CLI-SEC-9) segue sendo o 1º — não regride a UX, só endurece a decisão de rede.
    const targets = networkTargetsOf(command);
    if (targets.length === 0) {
      return { hasNetwork: false, outsideAllowlist: false };
    }
    const outside = targets.some((t) => {
      const host = hostOf(t);
      return host === undefined || !this.isAllowed(host);
    });
    return { hasNetwork: true, target: targets[0]!, outsideAllowlist: outside };
  }
}

/** Normaliza um host: minúsculo, sem porta, sem `.` final, sem esquema. */
function normalizeHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // tira esquema
  h = h.replace(/^[^@]*@/, ''); // tira user@
  h = h.replace(/[/:].*$/, ''); // tira path/porta
  h = h.replace(/\.$/, ''); // tira ponto final
  return h;
}

/** Extrai o host de um destino bruto (URL, user@host, host:porta). */
function hostOf(target: string): string | undefined {
  const h = normalizeHost(target);
  return h.length > 0 ? h : undefined;
}

/**
 * Extrai o destino externo de um comando de shell (CLI-SEC-9: o destino EXATO).
 * Mesma família de heurística da engine (engine.ts::networkTargetOf), mas aqui o
 * objetivo é a allowlist concreta. Best-effort, conservador.
 */
export function networkTargetOf(command: string): string | undefined {
  const url = command.match(/\bhttps?:\/\/[^\s"';|&]+/);
  if (url) return url[0];
  const scpLike = command.match(/\b[\w.-]+@[\w.-]+:[^\s"';|&]*/);
  if (scpLike) return scpLike[0];
  const userHost = command.match(/\b[\w.-]+@[\w.-]+/);
  if (userHost) return userHost[0];
  const host = command.match(/\b(?:ssh|scp|sftp|telnet|nc|ncat)\s+(?:-\w+\s+)*([\w.-]+)/);
  if (host?.[1]) return host[1];
  // gerenciadores de pacote que acessam registries conhecidos (npm/pip/etc.) NÃO
  // expõem um host literal no comando — a categoria package-exec já força ask;
  // aqui não inventamos host (sem destino literal ⇒ sem warning de allowlist).
  return undefined;
}

/**
 * SEC-SBX-NET-1 (gate AG-0008) — como `networkTargetOf`, mas devolve TODOS os destinos da
 * linha (multi-match com flag `g`), pra a decisão de egress ser **default-deny sobre o
 * CONJUNTO**: um comando composto (`curl ok && curl evil`) tem 2 destinos, e a rede do sandbox
 * (`--share-net` no `sh -c` inteiro) só pode abrir se TODOS forem permitidos. Over-matching é
 * SEGURO (fail-closed: checa destinos A MAIS, nunca a menos — sobreposição scp/userHost resolve
 * pro mesmo host, inofensivo); under-matching abriria rede indevida. `networkTargetOf` (1º
 * destino) segue para o DISPLAY da catraca; este conjunto, para a DECISÃO de rede.
 */
export function networkTargetsOf(command: string): string[] {
  const out: string[] = [];
  const patterns: readonly RegExp[] = [
    /\bhttps?:\/\/[^\s"';|&]+/g,
    /\b[\w.-]+@[\w.-]+:[^\s"';|&]*/g,
    /\b[\w.-]+@[\w.-]+/g,
  ];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) out.push(m[0]);
  }
  for (const m of command.matchAll(/\b(?:ssh|scp|sftp|telnet|nc|ncat)\s+(?:-\w+\s+)*([\w.-]+)/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}
