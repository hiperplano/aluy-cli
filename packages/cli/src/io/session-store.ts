// EST-0972 — PERSISTÊNCIA de sessão (salvar/retomar — `--continue`/`--resume`).
//
// Guarda a TRANSCRIÇÃO da conversa (os blocos `you`/`aluy`/`tool`/`bang`/`note`/…
// — model.ts) + metadados (id, data, cwd, tier) em `~/.aluy/sessions/<id>.json`,
// FORA do workspace, no `~/.aluy/` confinado. Reabrir o `aluy` com `--continue`
// (última sessão do cwd) ou `--resume <id>` carrega a transcrição de volta como
// CONTEXTO da própria conversa.
//
// SEGURANÇA (sinalizar ao seguranca-light — CLI-SEC-6/7, AG-0008):
//   - A transcrição PODE conter dado sensível: a saída de uma tool/`!comando`
//     (run_command, read_file) é DADO ingerido do ambiente e pode trazer trecho de
//     segredo. Por isso o confinamento é IDÊNTICO ao journal/undo (EST-0960a) e ao
//     user-config (EST-0969): dir `~/.aluy/sessions/` nasce `0700`, cada arquivo
//     `0600` ATÔMICO (temp `O_CREAT|O_EXCL` + rename — sem janela `0644`+chmod),
//     `umask` neutralizado pelo mode explícito.
//   - `~/.aluy/` NUNCA é canal do agente: a path-deny do core já nega read/grep/
//     edit/run sobre `~/.aluy`. Este store é o ÚNICO leitor/escritor (kernel-de-
//     cliente), não um caminho que o agente alcance. A transcrição restaurada é o
//     histórico da PRÓPRIA conversa (não dado externo) — mas o conteúdo de tool/
//     `!`/arquivo DENTRO dela mantém o envelope ORIGINAL ao virar contexto do loop
//     (`blocksToHistory` → `observation`, que `buildMessages` envelopa como
//     DADO_NAO_CONFIAVEL). NADA ingerido é elevado a instrução (CLI-SEC-4).
//   - NUNCA grava CREDENCIAL: só blocos de UI + tier (string opaca) + (na via Custom)
//     o slug do modelo. O `tier` é a pista de modelo (HG-2); o `model` é a CHAVE de
//     catálogo da via Custom — MESMA natureza "string opaca" do tier (um NOME de
//     modelo escolhido pelo usuário), NÃO credencial nem provider. O broker resolve
//     provider/credencial server-side. O binário é público (CLI-SEC-7) — mas o ARQUIVO
//     de sessão é do usuário, local, `0600`. (EST-0972: persistir o slug Custom corrige
//     o resume que mandava `tier:custom` SEM model ⇒ 422.)
//   - sem log/telemetria do conteúdo: este módulo NUNCA imprime/loga o conteúdo dos
//     blocos nem o caminho-com-conteúdo (CLI-SEC-6).
//   - FAIL-SAFE: arquivo ausente/corrompido/ilegível ⇒ trata como SEM sessão (nova),
//     NUNCA lança. Uma QoL jamais derruba o startup. Auto-save é best-effort: falha
//     de escrita nunca derruba a sessão viva.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
  existsSync,
  constants as fsConstants,
} from 'node:fs';
import type { SessionBlock } from '../session/model.js';
import { sanitizeBlocks } from './session-record.js';
import { redactFileContentForJournal } from './journal-redact.js';

/** Permissões restritas: dir `0700`, arquivo `0600` (espelha o journal-store). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Subdir das sessões dentro de `~/.aluy/`. */
export const SESSIONS_DIRNAME = 'sessions';

/** Versão do formato do registro (migração futura: bump + tolerância na leitura). */
export const SESSION_RECORD_VERSION = 1;

/**
 * Um registro de sessão persistido. SÓ transcrição (blocos de UI) + metadados de
 * sessão — NUNCA credencial. `cwd` é o workspace ABSOLUTO (p/ casar `--continue`
 * com o diretório atual). `tier` é a string opaca de modelo (HG-2).
 */
export interface SessionRecord {
  readonly id: string;
  readonly version: number;
  /** ms epoch da criação (1ª gravação). */
  readonly createdAt: number;
  /** ms epoch da última gravação (auto-save). */
  readonly updatedAt: number;
  /** Workspace ABSOLUTO da sessão (cwd preso). Casa `--continue` ao cwd. */
  readonly cwd: string;
  /** Tier de modelo da sessão (HG-2: só o tier; o broker resolve o resto). */
  readonly tier: string;
  /**
   * EST-0972 (BUG Custom) — slug do modelo da via Custom. SÓ é gravado quando
   * `tier === 'custom'` (a chave de CATÁLOGO escolhida pelo usuário). HG-2: é uma
   * string OPACA da MESMA natureza do `tier` — NOME de modelo, NÃO credencial nem
   * provider; o broker é quem resolve provider/credencial server-side. Sem o slug,
   * retomar uma sessão Custom mandava `tier:custom` SEM model ⇒ 422. `undefined`
   * nos tiers canônicos (nunca grava slug fantasma fora de Custom).
   */
  readonly model?: string;
  /**
   * HUNT-PERSIST (round-trip incompleto — mesma classe do BUG Custom do `model`) —
   * NOME do provider da via Custom (`/provider`, ADR-0076 multi-vendor). SÓ é gravado
   * sob `tier === 'custom'` com slug presente. Sem isto, retomar uma sessão Custom que
   * escolheu um provider específico PERDIA o provider: o resume reaplicava só `{tier,
   * model}` e a próxima chamada caía no provider DEFAULT do slug — provider errado (ou
   * 422 quando o mesmo slug existe em vários providers). É o NOME PÚBLICO do provider
   * (DADO de catálogo, HG-2), NUNCA credencial/base_url — o broker resolve
   * `(provider, model)` → credencial server-side. `undefined` fora de Custom / quando o
   * broker escolhe o default.
   */
  readonly provider?: string;
  /**
   * EST-0972 (rename) — RÓTULO amigável da sessão (`/rename <nome>`), exibido no
   * composer (●+nome) e no /history. DADO DE UI (um identificador), NÃO credencial
   * (HG-2/CLI-SEC) — seguro persistir. `undefined` = sem rótulo (volta ao default).
   */
  readonly label?: string;
  /**
   * EST-0972 (rename) — COR de identificação (NOME de cor da paleta do DS: `ambar`,
   * `verde`…). Só faz sentido junto de um `label` (sem rótulo ⇒ não é gravada). DADO
   * DE UI — seguro persistir. Default determinístico pelo nome; override via `--cor`.
   */
  readonly labelColor?: string;
  /** A transcrição: os blocos da conversa (você/aluy/tool/bang/note/…). */
  readonly blocks: readonly SessionBlock[];
}

/** Metadados de uma sessão p/ a LISTA do `--resume` (sem carregar a transcrição). */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly tier: string;
  /** EST-0972 (BUG Custom) — slug Custom (só sob `tier:'custom'`). Espelha o record. */
  readonly model?: string;
  /** HUNT-PERSIST — provider Custom (só sob `tier:'custom'` com slug). Espelha o record. */
  readonly provider?: string;
  /** EST-0972 (rename) — rótulo amigável da sessão (p/ a lista do /history). */
  readonly label?: string;
  /** EST-0972 (rename) — cor de identificação (nome da paleta do DS). */
  readonly labelColor?: string;
  /** Nº de blocos (tamanho da conversa) — só p/ exibir, não carrega o conteúdo. */
  readonly blockCount: number;
  /** 1ª fala do usuário (truncada) p/ rotular a sessão na lista. Pode ser undefined. */
  readonly title?: string | undefined;
}

export interface SessionGcOptions {
  /** Idade máxima (ms) acima da qual uma sessão é removida. Default 30 dias. */
  readonly maxAgeMs?: number;
  /** Teto de sessões mantidas (as mais recentes). Default 50. */
  readonly maxCount?: number;
}

export interface SessionStoreOptions {
  /**
   * Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste (tmpdir), sem
   * nunca tocar o `~/.aluy/` real do dev na suíte.
   */
  readonly baseDir?: string;
  /** "Agora" em ms — injetável (teste determinístico de timestamps/GC). */
  readonly now?: () => number;
}

/** ADR-0150 (balde b) — DEFAULT de idade de GC (30 dias), exportado p/ `aluy config`. */
export const DEFAULT_GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
/** ADR-0150 (balde b) — DEFAULT de contagem de GC (50), exportado p/ `aluy config`. */
export const DEFAULT_GC_MAX_COUNT = 50;

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0150 (balde b) — `session.gcMaxAgeMs`/`gcMaxCount` viram TUNABLES de config
// (~/.aluy/config.json). Diferente dos anti-runaway (Tier 1 de custo/segurança),
// isto é RETENÇÃO/privacidade — ainda ganha uma sanidade MÍNIMA (não é teto-teto
// anti-runaway, mas evita um config absurdo: idade 0 apagaria tudo a cada boot,
// contagem 0 idem).
// ─────────────────────────────────────────────────────────────────────────────

/** ADR-0150 — sanidade MÍNIMA: nunca aceita idade de GC abaixo de 1 dia. */
export const MIN_GC_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 dia

/** ADR-0150 — sanidade MÍNIMA: nunca aceita manter menos de 1 sessão. */
export const MIN_GC_MAX_COUNT = 1;

/**
 * ADR-0150 — resolve as `SessionGcOptions` a partir da seção `session` do config
 * (`gcMaxAgeMs`/`gcMaxCount`), aplicando a sanidade MÍNIMA acima. Ausente/inválido ⇒
 * `{}` (o `gc()` cai nos próprios defaults, `DEFAULT_GC_MAX_AGE_MS`/`DEFAULT_GC_MAX_COUNT`).
 * PURO — sem I/O.
 */
export function resolveSessionGcOptions(config?: {
  readonly gcMaxAgeMs?: number;
  readonly gcMaxCount?: number;
}): SessionGcOptions {
  const out: { maxAgeMs?: number; maxCount?: number } = {};
  if (
    config?.gcMaxAgeMs !== undefined &&
    Number.isFinite(config.gcMaxAgeMs) &&
    config.gcMaxAgeMs > 0
  ) {
    out.maxAgeMs = Math.max(MIN_GC_MAX_AGE_MS, Math.floor(config.gcMaxAgeMs));
  }
  if (
    config?.gcMaxCount !== undefined &&
    Number.isFinite(config.gcMaxCount) &&
    config.gcMaxCount > 0
  ) {
    out.maxCount = Math.max(MIN_GC_MAX_COUNT, Math.floor(config.gcMaxCount));
  }
  return out;
}

/**
 * Teto-ALVO do record (escrita cabe abaixo dele; leitura íntegra abaixo dele). Um
 * record ATÉ aqui é lido inteiro como antes. ACIMA dele (legado pré-EST-1011, arquivo
 * de outra versão, ou margem de escrita insuficiente) o `load` NÃO descarta a sessão —
 * recupera a CAUDA via `fitBlocks` + nota honesta (EST-0972 · resume não-zera). É o
 * tamanho que o resto do código trata como "o record cabe".
 */
const MAX_RECORD_BYTES = 8 * 1024 * 1024; // 8 MiB
/**
 * EST-0972 (resume de sessão GRANDE não-zera) — teto-DURO de bytes que o `load` aceita
 * trazer p/ a memória. Entre `MAX_RECORD_BYTES` e este teto, o `load` lê o arquivo,
 * parseia e RECUPERA A CAUDA (fitBlocks) com uma nota de truncamento — em vez de
 * devolver `null` (que SUMIA a sessão no `--resume`/`--continue`/auto-resume). ACIMA
 * deste teto-duro recai no fail-safe `null` (anti-DoS: não carrega um arquivo
 * arbitrariamente gigante/adulterado p/ a RAM). Folga generosa (8×) sobre o alvo:
 * um record real fitado nunca chega perto; só um arquivo patológico cai fora.
 */
const MAX_LOADABLE_RECORD_BYTES = MAX_RECORD_BYTES * 8; // 64 MiB
/**
 * EST-1011 (Bug 7 do bug-hunt — `save` sem cap ⇒ sessão irrecuperável) — teto de
 * ESCRITA do body serializado. Uma sessão longa gerava um record > `MAX_RECORD_BYTES`;
 * no `load`, `statSync > MAX_RECORD_BYTES ⇒ null` ⇒ a sessão SUMIA no `--resume`
 * (escrevia o que nunca releria). Fix: no `save`, se o body exceder o cap, DESCARTA os
 * blocos mais ANTIGOS (mantém a CAUDA — o contexto recente da conversa) até caber.
 * Folga abaixo do cap de leitura p/ o envelope/metadados não estourarem na borda.
 */
const MAX_WRITE_RECORD_BYTES = Math.floor(MAX_RECORD_BYTES * 0.9); // ~7.2 MiB
/** id de sessão válido: hex/dígitos/dash — evita path-traversal por id forjado. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * EST-0972 (rename) — teto defensivo do rótulo/cor lidos/gravados (anti-record
 * adulterado com string gigante). O rótulo já é saneado na origem (rename.ts, teto
 * 32); aqui é só a barreira FINAL de I/O — corta qualquer string longa do disco/caller.
 */
const MAX_LABEL_FIELD = 64;

/** Saneia um campo de rótulo/cor (string curta, sem controle): trim + teto. PURO. */
/**
 * HUNT-FOLLOWUP (deferido pelo HUNT-PERSIST) — trunca por CODE POINT, não por unidade
 * UTF-16: um `slice(0, n)` cru cortaria NO MEIO de um par surrogate (emoji/astral) e
 * deixaria um surrogate ÓRFÃO — pintado como `�` no título/rótulo da lista do `--resume`.
 * Itera por code point (`[...s]`), nunca parte um par. Metadado de UI; não toca conteúdo.
 */
function truncateCodePoints(s: string, max: number): string {
  const cps = [...s];
  return cps.length > max ? cps.slice(0, max).join('') : s;
}

function sanitizeLabelField(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // troca QUALQUER caractere de controle (incl. novas linhas — o rótulo é UMA linha
  // densa) por espaço, colapsa espaços e apara. Filtro por codepoint (sem literal de
  // controle no fonte) — o rótulo nunca quebra a linha do composer/lista.
  let out = '';
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const t = out.replace(/\s+/g, ' ').trim();
  if (t === '') return undefined;
  return truncateCodePoints(t, MAX_LABEL_FIELD);
}

/** Título curto a partir do 1º bloco `you` (p/ a lista do `--resume`). */
function titleOf(blocks: readonly SessionBlock[]): string | undefined {
  for (const b of blocks) {
    if (b.kind === 'you') {
      const t = b.text.replace(/\s+/g, ' ').trim();
      if (t === '') return undefined;
      // code-point-safe (HUNT-FOLLOWUP): não parte emoji no corte do título.
      const cps = [...t];
      return cps.length > 60 ? cps.slice(0, 57).join('') + '…' : t;
    }
  }
  return undefined;
}

/**
 * STORE das sessões em `~/.aluy/sessions/<id>.json`. Escrita ATÔMICA `0600`,
 * leitura FAIL-SAFE (corrompido ⇒ ignorado), GC por idade/teto com unlink REAL.
 * Espelha o `UserConfigStore`/`NodeJournalStore`.
 */
export class SessionStore {
  private readonly base: string; // ~/.aluy
  private readonly dir: string; // ~/.aluy/sessions
  private readonly now: () => number;
  /**
   * HUNT-PERF (hot-path O(n)/token no auto-save) — cache em memória do `createdAt`
   * por session-id. O `save` PRECISA preservar o `createdAt` da 1ª gravação; antes
   * relia+parseava o record INTEIRO (`load`: statSync + readFileSync + JSON.parse +
   * `sanitizeBlocks` de TODOS os blocos) a CADA save só p/ esse número. Como o
   * auto-save dispara a cada state-change durante o stream (cada token/keystroke),
   * isso era O(tamanho-do-record) por token numa sessão grande — custo que cresce
   * sem teto conforme a conversa cresce. Agora o `createdAt` resolvido é cacheado:
   *   - 1º save de id NOVO ⇒ cache vazio + disco ausente ⇒ usa `now` (1 read, ENOENT);
   *   - sessão via `--resume`/`--continue` ⇒ `load`/`latestForCwd` SEMEIAM o cache ⇒
   *     o 1º save NÃO relê o disco;
   *   - processo REINICIADO (cache vazio) ⇒ 1 read no 1º save (do disco) e cacheia ⇒
   *     os saves seguintes NÃO releem.
   * Não muda o formato em disco nem o contrato público — só o CUSTO. Per-instância
   * (o ciclo de vida do `SessionStore` é o do processo); `remove`/`gc` limpam a entrada.
   */
  private readonly createdAtCache = new Map<string, number>();

  constructor(opts: SessionStoreOptions = {}) {
    this.base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(this.base, SESSIONS_DIRNAME);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Diretório das sessões (p/ asserts de local/perm em teste). */
  get sessionsDir(): string {
    return this.dir;
  }

  /** Caminho do arquivo de uma sessão (id já validado por quem chama o write). */
  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Persiste a sessão ATÔMICA (`0600`). Best-effort: retorna `true` se gravou,
   * `false` se a escrita falhou (auto-save NUNCA derruba a sessão viva). Preserva
   * o `createdAt` se já havia registro; atualiza `updatedAt` p/ agora. Saneia os
   * blocos (descarta o que não for bloco conhecido) — sem lixo no disco.
   */
  save(input: {
    readonly id: string;
    readonly cwd: string;
    readonly tier: string;
    /**
     * EST-0972 (BUG Custom) — slug Custom. Só é GRAVADO quando `tier === 'custom'`
     * E não-vazio; em qualquer tier canônico é IGNORADO (nunca slug fantasma fora de
     * Custom). É a chave de catálogo (HG-2), não credencial.
     */
    readonly model?: string;
    /**
     * HUNT-PERSIST — provider Custom corrente. Só é GRAVADO quando `tier === 'custom'`,
     * há `model` (slug) e o provider é não-vazio (provider sem slug não faz sentido). É
     * o NOME do provider (HG-2), não credencial.
     */
    readonly provider?: string;
    /**
     * EST-0972 (rename) — RÓTULO amigável da sessão (`/rename`). Persistido como DADO
     * DE UI (HG-2: não credencial). Saneado (controle/teto) antes de gravar. `undefined`
     * ou vazio ⇒ sessão SEM rótulo (a cor também não é gravada).
     */
    readonly label?: string;
    /** EST-0972 (rename) — cor de identificação (nome da paleta do DS). Só com `label`. */
    readonly labelColor?: string;
    readonly blocks: readonly SessionBlock[];
  }): boolean {
    if (!SAFE_ID.test(input.id)) return false;
    try {
      const now = this.now();
      // HUNT-PERF — resolve o `createdAt` SEM reler+parsear o record inteiro a cada
      // save. Cache em memória 1º; cache-miss (id novo OU processo reiniciado) cai p/
      // UM read do disco (só o `createdAt`, via load fail-safe), e na ausência (1ª
      // gravação) usa `now`. O resultado é cacheado ⇒ os saves seguintes não releem.
      const createdAt = this.resolveCreatedAt(input.id, now);
      // EST-0972 (BUG Custom) — só persiste o slug sob `tier:'custom'` e não-vazio.
      // Fora de Custom o campo NÃO existe no record (não vaza Custom em tier canônico).
      const persistModel =
        input.tier === 'custom' && typeof input.model === 'string' && input.model.trim() !== '';
      // HUNT-PERSIST — o provider só é gravado em PAR com o slug Custom (provider sem
      // slug não tem como ser reaplicado no resume). Nunca provider fantasma fora de Custom.
      const persistProvider =
        persistModel && typeof input.provider === 'string' && input.provider.trim() !== '';
      // EST-0972 (rename) — só grava a COR quando há RÓTULO (cor sem nome não faz
      // sentido — sem rótulo, o composer não mostra nada). Ambos saneados (controle/teto).
      const label = sanitizeLabelField(input.label);
      const labelColor = label !== undefined ? sanitizeLabelField(input.labelColor) : undefined;
      const base = {
        id: input.id,
        version: SESSION_RECORD_VERSION,
        createdAt,
        updatedAt: now,
        cwd: input.cwd,
        tier: input.tier,
        ...(persistModel ? { model: input.model!.trim() } : {}),
        ...(persistProvider ? { provider: input.provider!.trim() } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(labelColor !== undefined ? { labelColor } : {}),
      };
      // EST-1011 (Bug 7) — CABE NO CAP DE LEITURA: se o record serializado passar do
      // teto de escrita, descarta os blocos mais ANTIGOS (mantém a cauda — o contexto
      // recente) até caber. Sem isto, uma sessão longa gravava um arquivo que o `load`
      // recusava (statSync > MAX_RECORD_BYTES ⇒ null) e SUMIA no `--resume`.
      // EST-SEC-HARDEN (F23) · AG-0008 — REDAÇÃO AT-REST do conteúdo-de-arquivo
      // (`read_file`/`grep`/`@attach`) ANTES de tocar o disco: passa pelo MESMO
      // `redactOutputSecrets` (CLI-SEC-6) que o `run_command`/`web` já aplicam na
      // ORIGEM. Roda no SINK do journal (aqui), NÃO no que vai ao modelo nem no
      // in-memory/in-session (a fidelidade do ciclo read→write_file é preservada).
      // Cirúrgico: só os blocos de LEITURA, só os campos de conteúdo — não corrompe
      // edits/metadados. ANTES de `fitBlocks` (o tamanho fitado é o do redigido).
      const blocks = this.fitBlocks(
        base,
        redactFileContentForJournal(sanitizeBlocks(input.blocks)),
      );
      const record: SessionRecord = { ...base, blocks };
      this.writeAtomic(record);
      return true;
    } catch {
      // QoL não-crítica: persistência best-effort. Falha = silêncio (não derruba).
      return false;
    }
  }

  /**
   * HUNT-PERF — resolve o `createdAt` a preservar p/ este id, SEM reler o record
   * inteiro a cada save. Cache-hit ⇒ devolve o valor cacheado (zero I/O). Cache-miss
   * ⇒ UM `load` fail-safe (id novo: ENOENT ⇒ usa `now`; processo reiniciado: lê o
   * createdAt do disco). O valor resolvido é cacheado p/ os saves seguintes. PURO
   * quanto ao formato em disco — só decide qual número grávar, idêntico ao antigo
   * `existing?.createdAt ?? now`.
   */
  private resolveCreatedAt(id: string, now: number): number {
    const cached = this.createdAtCache.get(id);
    if (cached !== undefined) return cached;
    const createdAt = this.load(id)?.createdAt ?? now;
    this.createdAtCache.set(id, createdAt);
    return createdAt;
  }

  /**
   * Lê uma sessão pelo id. FAIL-SAFE: id inválido, arquivo ausente, gigante, JSON
   * inválido ou registro sem forma ⇒ `null` (⇒ sessão nova, sem crash). NUNCA lança.
   * Saneia os blocos (descarta o que não reconhece) — restaura só conteúdo válido.
   */
  load(id: string): SessionRecord | null {
    if (!SAFE_ID.test(id)) return null;
    const file = this.pathFor(id);
    let text: string;
    let oversized = false;
    try {
      const st = statSync(file);
      // EST-0972 (resume não-zera) — DOIS tetos. Acima do teto-DURO, fail-safe `null`
      // (anti-DoS: arquivo patológico não vai p/ a RAM). Entre o ALVO e o DURO, o
      // arquivo é grande mas legível: marcamos `oversized` p/ recuperar a CAUDA
      // (fitBlocks) + nota, em vez de descartar a sessão inteira (que era o bug —
      // statSync > MAX_RECORD_BYTES ⇒ null ⇒ sessão SUMIA no --resume/--continue).
      if (st.size > MAX_LOADABLE_RECORD_BYTES) return null;
      oversized = st.size > MAX_RECORD_BYTES;
      text = readFileSync(file, 'utf8');
    } catch {
      return null; // ENOENT / sem permissão / etc. ⇒ sem sessão.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null; // corrompido (JSON inválido) ⇒ sessão nova, sem crash.
    }
    let rec = this.sanitizeRecord(parsed);
    // EST-0972 (resume não-zera) — record GRANDE (> alvo): preserva a CAUDA recente
    // (o que o usuário estava fazendo) e omite o contexto ANTIGO, com uma NOTA HONESTA.
    // Reusa o MESMO `fitBlocks` da escrita (mantém a cauda; sufixo que cabe). Na próxima
    // volta, o pipeline de auto-compactação (EST-0973) reduz o resto pelo tokens_in real
    // — nunca zeramos a sessão. NÃO altera o disco (CLI-SEC-6 / formato at-rest): só o
    // que carregamos em memória p/ ESTA retomada; o arquivo permanece intacto até o
    // próximo save (que reescreve já fitado pelo cap de escrita).
    if (rec && oversized) {
      const { blocks: recBlocks, ...recBase } = rec;
      const fitted = this.fitBlocks(recBase, recBlocks);
      const dropped = recBlocks.length - fitted.length;
      const note: SessionBlock = {
        kind: 'note',
        title: 'sessão grande — contexto antigo omitido no resume',
        lines: [
          `Esta sessão era grande demais p/ recarregar inteira; ` +
            `${dropped} bloco(s) antigo(s) foram omitidos e a parte recente foi preservada.`,
          'O contexto restante será resumido automaticamente na próxima interação.',
        ],
      };
      rec = { ...rec, blocks: dropped > 0 ? [note, ...fitted] : fitted };
    }
    // HUNT-PERF — SEMEIA o cache de `createdAt` ao ler uma sessão íntegra (resume/
    // continue/list). Assim o 1º save de uma sessão retomada NÃO relê o disco — o
    // createdAt já está em memória. (`load` é o único caminho que parseia o record.)
    if (rec) this.createdAtCache.set(rec.id, rec.createdAt);
    return rec;
  }

  /**
   * Lista RESUMOS de todas as sessões válidas (p/ o `--resume`), das mais RECENTES
   * p/ as mais antigas. Ignora arquivos ilegíveis/corrompidos (best-effort). NUNCA
   * carrega a transcrição p/ o caller além da contagem/título — leitura mínima.
   */
  list(): readonly SessionSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return []; // dir ausente (1ª execução) ⇒ nenhuma sessão.
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const rec = this.load(id);
      if (!rec) continue;
      out.push({
        id: rec.id,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        cwd: rec.cwd,
        tier: rec.tier,
        ...(rec.model !== undefined ? { model: rec.model } : {}),
        ...(rec.provider !== undefined ? { provider: rec.provider } : {}),
        // EST-0972 (rename) — o rótulo+cor vão p/ a lista do /history (mostra ●+nome).
        ...(rec.label !== undefined ? { label: rec.label } : {}),
        ...(rec.labelColor !== undefined ? { labelColor: rec.labelColor } : {}),
        blockCount: rec.blocks.length,
        title: titleOf(rec.blocks),
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /**
   * A ÚLTIMA sessão (mais recente) cujo `cwd` é EXATAMENTE o `cwd` dado — o que o
   * `--continue` retoma. `null` se nenhuma sessão pertence a este diretório.
   */
  latestForCwd(cwd: string): SessionRecord | null {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return null; // dir ausente (1ª execução) ⇒ nenhuma sessão.
    }
    // HUNT-PERF — antes: `list()` carregava+saneava TODOS os records, depois `load()`
    // de novo o vencedor (DOUBLE-PARSE do escolhido). Agora um passe único guarda o
    // record completo do mais recente do cwd — sem 2º parse. Cada arquivo ainda é lido
    // 1× (necessário p/ saber cwd/updatedAt); o vencedor não é reparseado.
    let best: SessionRecord | null = null;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const rec = this.load(id);
      if (!rec || rec.cwd !== cwd) continue;
      if (best === null || rec.updatedAt > best.updatedAt) best = rec;
    }
    return best;
  }

  /** Remove uma sessão (unlink REAL). Idempotente; NUNCA lança. */
  remove(id: string): void {
    if (!SAFE_ID.test(id)) return;
    // HUNT-PERF — esquece o createdAt cacheado: se este id for recriado depois, a 1ª
    // gravação deve nascer com `now` (sessão NOVA), não herdar o createdAt da removida.
    this.createdAtCache.delete(id);
    try {
      unlinkSync(this.pathFor(id));
    } catch {
      /* já removida — idempotente */
    }
  }

  /**
   * GC das sessões antigas: remove as mais velhas que `maxAgeMs` E, do que sobra,
   * mantém só as `maxCount` mais recentes (unlink REAL). Best-effort — uma falha
   * num arquivo não impede os demais. NUNCA lança.
   */
  gc(opts: SessionGcOptions = {}): void {
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_GC_MAX_AGE_MS;
    const maxCount = opts.maxCount ?? DEFAULT_GC_MAX_COUNT;
    const summaries = this.list(); // já ordenado por updatedAt desc.
    const cutoff = this.now() - maxAgeMs;
    summaries.forEach((s, i) => {
      // remove por IDADE (mais velho que o teto) OU por TETO (além das N recentes).
      if (s.updatedAt < cutoff || i >= maxCount) this.remove(s.id);
    });
  }

  /**
   * Saneia um objeto desconhecido (do disco) num `SessionRecord` de confiança.
   * Exige a forma mínima (id seguro, números, strings, blocos). Descarta blocos
   * inválidos. `null` se a forma básica falhar — fail-safe (⇒ sessão nova).
   */
  private sanitizeRecord(raw: unknown): SessionRecord | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || !SAFE_ID.test(o.id)) return null;
    if (!Array.isArray(o.blocks)) return null;
    const createdAt = typeof o.createdAt === 'number' && o.createdAt >= 0 ? o.createdAt : 0;
    const updatedAt = typeof o.updatedAt === 'number' && o.updatedAt >= 0 ? o.updatedAt : createdAt;
    const cwd = typeof o.cwd === 'string' ? o.cwd : '';
    const tier = typeof o.tier === 'string' && o.tier.trim() !== '' ? o.tier : '';
    const version = typeof o.version === 'number' ? o.version : 0;
    // EST-0972 (BUG Custom) — o slug do disco só é aceito sob `tier:'custom'` e não-
    // vazio (string opaca, HG-2). Em qualquer outro tier é DESCARTADO (não restaura
    // um slug fantasma fora de Custom). Record legado `tier:'custom'` SEM model ⇒
    // `model` fica undefined — o restore (run.tsx) trata o fallback (não manda
    // `tier:custom` sem model).
    const model =
      tier === 'custom' && typeof o.model === 'string' && o.model.trim() !== ''
        ? o.model.trim()
        : undefined;
    // HUNT-PERSIST — o provider do disco só é aceito em PAR com o slug Custom (mesma
    // trava do `model`): nunca restaura um provider fantasma fora de Custom nem sem slug.
    const provider =
      model !== undefined && typeof o.provider === 'string' && o.provider.trim() !== ''
        ? o.provider.trim()
        : undefined;
    // EST-0972 (rename) — restaura o rótulo+cor (DADO DE UI), saneados de novo na
    // leitura (defesa contra record adulterado — controle/teto). A cor só vale com
    // rótulo (sem nome, descarta a cor — não há o que identificar).
    const label = sanitizeLabelField(o.label);
    const labelColor = label !== undefined ? sanitizeLabelField(o.labelColor) : undefined;
    return {
      id: o.id,
      version,
      createdAt,
      updatedAt,
      cwd,
      tier,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(labelColor !== undefined ? { labelColor } : {}),
      blocks: sanitizeBlocks(o.blocks),
    };
  }

  /**
   * EST-1011 (Bug 7) — ajusta os blocos para o record CABER no cap de leitura. Mede o
   * tamanho serializado real (`JSON.stringify(record) + '\n'`, em BYTES) e, enquanto
   * exceder `MAX_WRITE_RECORD_BYTES`, descarta os blocos mais ANTIGOS (do início),
   * preservando a CAUDA (o contexto recente — o que importa p/ retomar). Se nem 1 bloco
   * couber (metadados+1 bloco gigantes), devolve `[]` — o record mínimo SEMPRE cabe,
   * então a sessão volta a ser legível (nunca o caso "escreve o que não relê"). PURO.
   */
  private fitBlocks(
    base: Omit<SessionRecord, 'blocks'>,
    blocks: readonly SessionBlock[],
  ): readonly SessionBlock[] {
    // O byte-length do envelope serializado (record + '\n'); o `writeAtomic` grava igual.
    const fits = (bs: readonly SessionBlock[]): boolean =>
      Buffer.byteLength(JSON.stringify({ ...base, blocks: bs }) + '\n', 'utf8') <=
      MAX_WRITE_RECORD_BYTES;
    if (fits(blocks)) return blocks;
    // Busca binária pelo MAIOR SUFIXO (cauda recente) que cabe: drop dos blocos mais
    // antigos. `drop` = quantos descartar do início. Monotônico (cauda maior → mais
    // bytes), então o maior suffix que cabe está num corte único. O(log n) medições.
    let lo = 1; // pelo menos 1 a descartar (já sabemos que tudo NÃO cabe).
    let hi = blocks.length; // descartar tudo ⇒ `[]` (sempre cabe).
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (fits(blocks.slice(mid))) hi = mid;
      else lo = mid + 1;
    }
    return blocks.slice(lo);
  }

  /**
   * Escreve o registro ATÔMICO: garante `~/.aluy/sessions/` com `0700`, escreve um
   * temp `0600` (`O_CREAT|O_EXCL|O_WRONLY`, sem janela `0644`+chmod) e o `rename`
   * por cima do alvo (atômico no mesmo filesystem). Em erro, limpa o temp. `umask`
   * neutralizado pelo mode explícito. Espelha o `UserConfigStore.writeAtomic`.
   */
  private writeAtomic(record: SessionRecord): void {
    // Cada nível NOSSO nasce `0700` atômico (`~/.aluy/` e `sessions/`). `recursive`
    // aplica o mode aos níveis criados; um nível pré-existente não é relaxado.
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    const file = this.pathFor(record.id);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const body = JSON.stringify(record) + '\n';
    let fd: number | undefined;
    try {
      fd = openSync(
        tmp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        FILE_MODE,
      );
      writeSync(fd, body);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, file);
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

/** `true` se há ao menos uma sessão (qualquer cwd). Atalho p/ o `--resume` vazio. */
export function hasAnySession(store: SessionStore): boolean {
  return store.list().length > 0;
}

/** Garante que o dir existe p/ asserts de perm (uso interno/teste). */
export function existsSessionsDir(store: SessionStore): boolean {
  return existsSync(store.sessionsDir);
}
