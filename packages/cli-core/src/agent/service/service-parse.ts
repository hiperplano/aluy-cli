// ADR-0158 §1/§3/§8.3/§8.5 — SERVIÇOS plugáveis: parser PURO do manifesto `service.md`.
//
// Um SERVIÇO é um diretório `~/.aluy/services/<nome>/` cujo único arquivo NOVO é o
// `service.md` (ADR-0158 §1): frontmatter chave-valor plano = CONTRATO DURO (o que o
// runner ENFORÇA em código, §3) + corpo em prosa = o ORQUESTRADOR do serviço (mesma
// gramática de `agents/*.md`/`workflows/*.md` — anti-framework, §Decisão).
//
//   ---
//   name: trader
//   description: Opera contas MT5 no intradiário
//   schedule: "0 9 * * 1-5"     # cron expr (validado pelo LOADER confinado — §8.5)
//   until: "17:30"               # fim do expediente — ENFORÇADO pelo runner (fase 2)
//   workflow: turno               # rotina do turno (workflows/turno.md do serviço)
//   channel: telegram:<chat-id>  # onde reporta/pergunta (ADR-0154)
//   budget: 200k/turno           # teto de tokens (reusa limits.ts na fase 2)
//   activity-timeout: sem-teto   # teto por ATIVIDADE — default 30min; "sem-teto" remove
//   autonomy: ask                # v1 SÓ aceita `ask` (§Consequências — escopo v1)
//   perda-maxima-dia: 500        # circuit breaker — SEM faixa (§8.3)
//   tamanho-posicao: 2 [1..5]    # tunável COM faixa — a retro ajusta só dentro dela (§8.5a)
//   ---
//   Você rege, não opera. Abre o turno lendo a memória do serviço…  ← corpo = orquestrador
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ FRONTEIRA (o que o gate FORTE do `seguranca`/AG-0008 reconfere) — este      ║
// ║ MÓDULO É PARSER PURO; ele NÃO concede nada, NÃO agenda nada, NÃO enforça    ║
// ║ nada em runtime (isso é o runner, fase 2 do ADR-0158).                     ║
// ║                                                                            ║
// ║ • `name` obrigatório (RES-MD-3: sem name ⇒ ServiceManifestError).           ║
// ║ • corpo (orquestrador) obrigatório e não-vazio — mesma disciplina de        ║
// ║   `agent-profile.ts`/`skill.ts`: um serviço sem persona-orquestradora não   ║
// ║   é um serviço, é um cron job (ADR-0158 alternativa D, rejeitada).          ║
// ║ • `autonomy:` — a v1 SÓ aceita `ask` (ADR-0158 §Consequências, escopo v1:   ║
// ║   "autonomy: ask apenas — adiar yolo-scoped"). Qualquer outro valor         ║
// ║   declarado é FALHA FECHADA (nunca "ignora e segue com ask implícito" —     ║
// ║   um dono que escreveu `autonomy: yolo-scoped` pensando que já vale isso    ║
// ║   precisa de um erro, não de um silêncio que reduz sozinho a autonomia      ║
// ║   pretendida).                                                              ║
// ║ • `until:`/`channel:` — validados só ESTRUTURALMENTE aqui (forma). A        ║
// ║   VALIDAÇÃO SEMÂNTICA de `schedule:` (5 campos cron, `validateCronExpr`) e   ║
// ║   de `workflow:` (arquivo existe em `workflows/` do serviço) exige I/O —     ║
// ║   fica no REGISTRY confinado (`@hiperplano/aluy-cli`, `io/services-store.ts`), não aqui. ║
// ║ • Tunáveis/circuit-breakers (§8.3/§8.5a): QUALQUER chave de frontmatter que  ║
// ║   não seja uma das conhecidas E cujo valor CASE o padrão numérico           ║
// ║   `<número> [min..max]?` vira um `ServiceTunable`. Uma faixa malformada      ║
// ║   (min > max, ou o valor DECLARADO fora da própria faixa) é FALHA FECHADA — ║
// ║   o dono escreveu uma faixa que não bate com o próprio valor inicial; isso   ║
// ║   é erro de configuração, não algo pra o runner "descobrir" mais tarde.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): parser de string PURO (sem `node:*`, sem I/O). A LEITURA
// confinada de `~/.aluy/services/<nome>/service.md` é do locus concreto
// (@hiperplano/aluy-cli, io/services-store.ts).

/** Um tunável/circuit-breaker numérico declarado no frontmatter (§8.3/§8.5a). */
export interface ServiceTunable {
  /** A chave crua do frontmatter (ex.: `perda-maxima-dia`, `tamanho-posicao`). */
  readonly key: string;
  /** O valor numérico atual. */
  readonly value: number;
  /**
   * Faixa declarada (`[min..max]`), quando presente. AUSENTE ⇒ é um circuit
   * breaker DURO (§8.3: "perdeu Z no dia ⇒ o runner ENCERRA o turno" — sem
   * margem de auto-ajuste). PRESENTE ⇒ é um tunável (§8.5a: a retro pode
   * auto-ajustar o valor dentro da faixa; fora dela vira PROPOSTA, §8.5b).
   */
  readonly min?: number;
  readonly max?: number;
}

/**
 * O manifesto `service.md` já PARSEADO. Frontmatter = contrato duro (o que o
 * runner da fase 2 enforça em código, ADR-0158 §3); `orchestrator` = o corpo em
 * prosa, a persona de QUEM COORDENA o serviço (§1 — "rege, não opera").
 */
export interface ServiceManifest {
  /** Identidade do serviço (frontmatter `name`) — nome do dir em `~/.aluy/services/`. */
  readonly name: string;
  /** O que o serviço faz (frontmatter `description`). Opcional. */
  readonly description?: string;
  /**
   * Expressão cron CRUA (frontmatter `schedule`). A validação de FORMA (5 campos,
   * faixas) é do registry confinado via `validateCronExpr` — este parser não a
   * repete (evitaria duplicar a regra em duas camadas divergentes).
   */
  readonly schedule?: string;
  /** Fim do expediente `HH:MM` (frontmatter `until`) — ENFORÇADO pelo runner (fase 2). */
  readonly until?: string;
  /** Nome do workflow do turno principal (frontmatter `workflow`) — resolve p/ `workflows/<nome>.md`. */
  readonly workflow?: string;
  /** Canal cru `<conector>:<alvo>` (frontmatter `channel`, ex.: `telegram:123456`). */
  readonly channel?: string;
  /** Teto de tokens CRU (frontmatter `budget`, ex.: `200k/turno`) — parsing numérico é da fase 2 (`limits.ts`). */
  readonly budget?: string;
  /**
   * Teto anti-runaway POR ATIVIDADE, CRU (frontmatter `activity-timeout`, ex.:
   * `45m`, `2h`, `sem-teto`) — ausente/malformado ⇒ o runner cai no default
   * `MAX_ACTIVITY_MS` (30min); parsing semântico é `parseServiceActivityTimeout`.
   */
  readonly activityTimeout?: string;
  /** Autonomia — a v1 só aceita `ask` (frontmatter `autonomy`, validado abaixo). */
  readonly autonomy?: 'ask';
  /** Circuit-breakers (sem faixa) + tunáveis (com faixa) — §8.3/§8.5a. */
  readonly tunables: readonly ServiceTunable[];
  /** O corpo do `.md` = a persona do ORQUESTRADOR do serviço (§1). Nunca vazio. */
  readonly orchestrator: string;
}

/**
 * RES-MD-3 — FALHA FECHADA. Quando o `service.md` é malformado, o parser devolve
 * ISTO em vez de um `ServiceManifest`. O serviço NÃO entra no registry (nunca vira
 * "serviço sem orquestrador" ou "serviço com autonomia diferente da declarada").
 */
export interface ServiceManifestError {
  readonly kind: 'error';
  /** Basename do arquivo que falhou (`service.md`) — p/ a mensagem de carga. */
  readonly file: string;
  /** Motivo legível da rejeição. */
  readonly reason: string;
}

/** Resultado do parse: o manifesto OU o erro fail-closed (RES-MD-3). */
export type ServiceManifestParse = ServiceManifest | ServiceManifestError;

/** `true` se o parse falhou (fail-closed) — o loader descarta com erro visível. */
export function isServiceManifestError(p: ServiceManifestParse): p is ServiceManifestError {
  return (p as ServiceManifestError).kind === 'error';
}

/** Teto defensivo do nome (anti-nome-gigante / anti-DoS de registro). */
const MAX_NAME_LEN = 64;
/** Teto defensivo de quantos tunáveis um `.md` pode declarar (anti-lista-gigante). */
const MAX_TUNABLES = 64;

/**
 * Normaliza o NOME de um serviço: minúsculas + só `[a-z0-9_-]`, bordas aparadas,
 * teto de tamanho. Casa a gramática de identificador (o dir em `~/.aluy/services/`
 * leva este nome). Vazio após normalizar ⇒ `''` (o parser rejeita). PURO.
 */
export function normalizeServiceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LEN);
}

/** As chaves de frontmatter CONHECIDAS — tudo mais é candidato a tunável (§8.3/§8.5a). */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'schedule',
  'until',
  'workflow',
  'channel',
  'budget',
  'activity-timeout',
  'autonomy',
]);

/**
 * Extrai o VALOR de uma linha `chave: valor  # comentário`, tolerando o estilo
 * usado no exemplo do ADR-0158 §1 (valores entre aspas COM comentário à direita,
 * ex.: `schedule: "0 9 * * 1-5"     # cron expr…`). Duas formas:
 *   - valor ENTRE ASPAS: devolve só o conteúdo interno (o que vem depois das
 *     aspas de fechamento é sempre comentário, nunca dado).
 *   - valor SEM aspas: corta a partir do primeiro ` #` (espaço+hash) — permite
 *     valores com `#` colado (raro) sem confundir com comentário. PURO.
 */
function stripInlineComment(raw: string): string {
  const quoted = /^(["'])((?:\\.|(?!\1).)*)\1/.exec(raw);
  if (quoted) return quoted[2]!;
  const hashIdx = raw.search(/\s#/);
  return (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
}

/** Frontmatter cru de um `service.md`, campo a campo (antes de validar/normalizar). */
interface RawServiceFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly schedule?: string;
  readonly until?: string;
  readonly workflow?: string;
  readonly channel?: string;
  readonly budget?: string;
  readonly activityTimeout?: string;
  /** `undefined` = chave `autonomy:` ausente (distinto de presente-mas-inválida). */
  readonly autonomyRaw?: string;
  /** Pares (chave, valor-cru) de tudo que NÃO é uma chave conhecida — candidatos a tunável. */
  readonly extras: ReadonlyArray<readonly [string, string]>;
}

/**
 * Extrai o frontmatter YAML-MÍNIMO (bloco `---`…`---` no TOPO) + o corpo. Só pares
 * `chave: valor` de 1 linha (sem YAML aninhado — mesma filosofia anti-framework dos
 * parsers irmãos). Tolera BOM/CRLF e comentário inline (`stripInlineComment`). Sem
 * frontmatter ⇒ tudo é corpo (sem `name` ⇒ o parser rejeita). PURO.
 */
function splitServiceFrontmatter(raw: string): { fm: RawServiceFrontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: { extras: [] }, body: text.trim() };

  const out: {
    name?: string;
    description?: string;
    schedule?: string;
    until?: string;
    workflow?: string;
    channel?: string;
    budget?: string;
    activityTimeout?: string;
    autonomyRaw?: string;
  } = {};
  const extras: Array<readonly [string, string]> = [];

  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = stripInlineComment(kv[2]!.trim());
    switch (key) {
      case 'name':
        out.name = value;
        break;
      case 'description':
        out.description = value;
        break;
      case 'schedule':
        out.schedule = value;
        break;
      case 'until':
        out.until = value;
        break;
      case 'workflow':
        out.workflow = value;
        break;
      case 'channel':
        out.channel = value;
        break;
      case 'budget':
        out.budget = value;
        break;
      case 'activity-timeout':
        out.activityTimeout = value;
        break;
      case 'autonomy':
        out.autonomyRaw = value;
        break;
      default:
        if (!KNOWN_KEYS.has(key)) extras.push([key, value]);
        break;
    }
  }
  return { fm: { ...out, extras }, body: text.slice(m[0].length).trim() };
}

/**
 * Parseia UM extra `chave: valor` candidato a tunável/circuit-breaker (§8.3/§8.5a):
 * `<número> [min..max]?`. Devolve `undefined` se o valor não CASA o padrão numérico
 * (a chave é então silenciosamente IGNORADA — forward-compat: um `.md` pode ter
 * anotações do dono que não são nem um campo conhecido nem um tunável, ex.:
 * `estrategia: momentum-v2` — texto, não número; não é erro, só não vira tunável).
 * Devolve um `ServiceTunable` OU uma STRING de erro quando o valor TEM cara de
 * tunável (número presente) mas a faixa é malformada (min>max ou valor fora da
 * própria faixa) — aí sim é FALHA FECHADA (§ cabeçalho do módulo). PURO.
 */
function parseTunableCandidate(key: string, rawValue: string): ServiceTunable | string | undefined {
  const m =
    /^(-?\d+(?:\.\d+)?)\s*(?:\[\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\s*\])?$/.exec(
      rawValue.trim(),
    );
  if (!m) return undefined; // não tem cara de número ⇒ não é tunável, é ignorado (forward-compat).

  const value = Number(m[1]);
  if (m[2] === undefined) return { key, value }; // sem faixa ⇒ circuit breaker duro (§8.3).

  const min = Number(m[2]);
  const max = Number(m[3]);
  if (min > max) {
    return `tunável "${key}": faixa malformada [${min}..${max}] (min > max) — corrija a faixa.`;
  }
  if (value < min || value > max) {
    return (
      `tunável "${key}": valor ${value} fora da própria faixa declarada [${min}..${max}] — ` +
      `o valor inicial precisa estar DENTRO da faixa que o autoriza.`
    );
  }
  return { key, value, min, max };
}

/**
 * Parseia o conteúdo cru de um `service.md` num `ServiceManifest` OU num
 * `ServiceManifestError` (RES-MD-3, fail-closed).
 *
 * Rejeita (erro de manifesto, NÃO entra no registry):
 *   - `name` ausente/vazio após normalizar;
 *   - corpo (orquestrador) vazio;
 *   - `autonomy:` presente com valor ≠ `ask` (a v1 só aceita `ask` — §Consequências);
 *   - qualquer tunável/circuit-breaker com faixa malformada (min>max, ou valor
 *     inicial fora da própria faixa).
 *
 * `until`/`channel` são validados só ESTRUTURALMENTE (forma `HH:MM` / `<x>:<y>`);
 * a validação SEMÂNTICA de `schedule`/`workflow` (I/O) é do registry confinado. PURO.
 */
export function parseServiceManifest(basename: string, raw: string): ServiceManifestParse {
  const file = basename;
  const { fm, body } = splitServiceFrontmatter(raw);

  const name = normalizeServiceName(fm.name ?? '');
  if (name === '') {
    return {
      kind: 'error',
      file,
      reason: `serviço "${file}": frontmatter sem "name" válido — manifesto rejeitado (fail-closed)`,
    };
  }
  if (body === '') {
    return {
      kind: 'error',
      file,
      reason:
        `serviço "${name}" (${file}): corpo vazio — sem orquestrador ` +
        `(o corpo É a persona de quem coordena o serviço), manifesto rejeitado`,
    };
  }

  // `autonomy:` — v1 SÓ aceita `ask` (fail-closed p/ qualquer outro valor declarado).
  let autonomy: 'ask' | undefined;
  if (fm.autonomyRaw !== undefined) {
    const a = fm.autonomyRaw.trim().toLowerCase();
    if (a !== 'ask') {
      return {
        kind: 'error',
        file,
        reason:
          `serviço "${name}" (${file}): "autonomy: ${fm.autonomyRaw}" não é suportado nesta ` +
          `fase — a v1 só aceita "autonomy: ask" (yolo-scoped fica p/ fase futura).`,
      };
    }
    autonomy = 'ask';
  }

  // `until:` — forma HH:MM (a semântica de "fim de expediente" é do runner, fase 2).
  if (fm.until !== undefined && !/^\d{2}:\d{2}$/.test(fm.until.trim())) {
    return {
      kind: 'error',
      file,
      reason: `serviço "${name}" (${file}): "until: ${fm.until}" — formato esperado "HH:MM".`,
    };
  }

  // `channel:` — forma `<conector>:<alvo>` (ex.: `telegram:123456`); resolver o
  // conector de verdade é do registry/instalação (I/O), não deste parser puro.
  if (fm.channel !== undefined && !/^[a-z][a-z0-9_-]*:.+$/.test(fm.channel.trim())) {
    return {
      kind: 'error',
      file,
      reason:
        `serviço "${name}" (${file}): "channel: ${fm.channel}" — formato esperado ` +
        `"<conector>:<alvo>" (ex.: "telegram:123456").`,
    };
  }

  // Tunáveis/circuit-breakers (§8.3/§8.5a) — cada extra numérico vira um `ServiceTunable`;
  // uma faixa malformada é FALHA FECHADA do manifesto inteiro (não só do campo).
  const tunables: ServiceTunable[] = [];
  for (const [key, rawValue] of fm.extras) {
    if (tunables.length >= MAX_TUNABLES) break;
    const parsed = parseTunableCandidate(key, rawValue);
    if (parsed === undefined) continue; // não tem cara de número ⇒ ignorado (forward-compat).
    if (typeof parsed === 'string') {
      return { kind: 'error', file, reason: `serviço "${name}" (${file}): ${parsed}` };
    }
    tunables.push(parsed);
  }

  const description =
    fm.description !== undefined && fm.description.trim() !== ''
      ? fm.description.trim()
      : undefined;
  const schedule = fm.schedule !== undefined && fm.schedule !== '' ? fm.schedule : undefined;
  const until = fm.until !== undefined && fm.until !== '' ? fm.until : undefined;
  const workflow = fm.workflow !== undefined && fm.workflow !== '' ? fm.workflow : undefined;
  const channel = fm.channel !== undefined && fm.channel !== '' ? fm.channel : undefined;
  const budget = fm.budget !== undefined && fm.budget !== '' ? fm.budget : undefined;
  const activityTimeout =
    fm.activityTimeout !== undefined && fm.activityTimeout !== '' ? fm.activityTimeout : undefined;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(workflow !== undefined ? { workflow } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(activityTimeout !== undefined ? { activityTimeout } : {}),
    ...(autonomy !== undefined ? { autonomy } : {}),
    tunables,
    orchestrator: body,
  };
}
