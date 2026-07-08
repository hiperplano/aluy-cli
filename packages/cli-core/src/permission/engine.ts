// EST-0945 · CLI-SEC-3/4/9 — a ENGINE de permissão CONCRETA.
//
// Implementa `PermissionEngine.decide()` do seam (EST-0941). Pluga no ponto único
// `decide()` (CLI-SEC-H1) sem tocar o loop (EST-0944). Substitui o `denyAllEngine`
// por uma política REAL: allow/ask/deny, categorias sempre-ask não-relaxáveis,
// hooks, e o efeito EXATO anexado p/ a confirmação (CLI-SEC-9).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ ⚠ MODO YOLO (`--yolo`, modo interno `'unsafe'`) — PERMISSÃO COMPLETA NA      ║
// ║ MÁQUINA · ADR-0072 (decisão do dono, Tiago — Alternativa C, paridade literal ║
// ║ com `--dangerously-skip-permissions` do Claude Code).                       ║
// ║ Sob YOLO a `decide()` retorna `allow` p/ QUALQUER tool/efeito/path/host —    ║
// ║ INCLUSIVE: (a) as categorias sempre-ask (curl|sh, rm -rf, npm i, sudo, push  ║
// ║ --force, MCP de efeito, rede/egress); (b) o PISO de journal/`~/.aluy`        ║
// ║ (journal-read-deny -1.b E aluy-config-write-deny -1.c) — DERRUBADO no YOLO   ║
// ║ por decisão do dono (o agente PODE ler/escrever `~/.aluy`); (c) o anti-SSRF  ║
// ║ de faixas internas (relaxado no locus de rede — ver web-port/fetcher).      ║
// ║ Em YOLO NÃO há `ask` nem `deny` por permissão — é o `if (mode==='unsafe')    ║
// ║ return allow` no topo da precedência de PERMISSÃO (0). Opt-in EXPLÍCITO por  ║
// ║ sessão (flag `--yolo`/`--unsafe`), NUNCA default, NUNCA persistido; banner   ║
// ║ permanente + confirmação de entrada (TTY) + entrada DIRETA em headless (a    ║
// ║ flag é o consentimento) + recusa DURA só como root (AG-0008) vivem no         ║
// ║ @hiperplano/aluy-cli (yolo-guard).                                                      ║
// ║ NÃO CAEM no YOLO (são GASTO/integridade, não PERMISSÃO — ADR-0072 §4):       ║
// ║  · teto de profundidade de sub-agente (E-A1, prec. -2);                      ║
// ║  · toolset restrito do agente-`.md` (GS-MD1, prec. -1.9);                    ║
// ║  · teto de gravações de memória por sessão (anti-runaway, prec. -1.d);       ║
// ║  · modo Plan (prec. -1) — `plan` e `unsafe` são exclusivos (um só modo).     ║
// ║ → o `seguranca` (gate FORTE AG-0008) revisa isto com lupa: é a única porta   ║
// ║   que desliga a catraca E derruba a cerca/pisos.                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ EST-0959 · ADR-0055 — EIXO DE MODO DE SESSÃO (`mode`), avaliado na           ║
// ║ PRECEDÊNCIA -1 (acima até do `--unsafe`). `plan | normal | unsafe`, default  ║
// ║ `normal`. Em `plan` (TETO read-only): toda tool de EFEITO ⇒ DENY (não ask);  ║
// ║ só leitura LOCAL da allow-list FECHADA (plan.ts) é permitida. Plan VENCE     ║
// ║ allow-list/hook/`--unsafe`/injeção — é o degrau mais restritivo. `unsafe` é  ║
// ║ valor do MESMO eixo (mutuamente exclusivo com `plan`): não há "Plan+unsafe". ║
// ║ → o `seguranca` (AG-0008) reconfere: Plan precede tudo e nega TODO efeito.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ORDEM DE PRECEDÊNCIA (de cima p/ baixo; a primeira que decide, decide):
//  -2. E-A1 — teto de profundidade de sub-agente (`spawn_agent` negado num filho).
//      GASTO/estrutura, NÃO permissão: NÃO cai no YOLO (ADR-0072 §4).
// -1.9. GS-MD1 — toolset restrito do agente-`.md` (tool fora do escopo ⇒ deny).
//      Escopo, NÃO permissão: NÃO cai no YOLO.
// -1.d. CLI-SEC-15 — teto de gravações de memória por sessão (anti-runaway).
//      GASTO, NÃO permissão: NÃO cai no YOLO.
//  -1. MODO `plan` (TETO read-only) ⇒ DENY p/ toda tool de EFEITO ANTES de tudo —
//      inclusive antes do YOLO. `plan` e `unsafe` são valores EXCLUSIVOS do mesmo
//      eixo (a sessão tem UM modo), então nunca colidem; o teste é só defensivo.
//   0. ⚠ YOLO (`mode==='unsafe'`, flag `--yolo`) — PERMISSÃO COMPLETA. ⇒ allow p/
//      QUALQUER tool/efeito/path/host, SEM EXCEÇÃO. INCLUSIVE as categorias
//      sempre-ask E os antigos pisos de `~/.aluy` (journal-read-deny /
//      aluy-config-write-deny) — DERRUBADOS no YOLO por ADR-0072 (Alternativa C, do
//      dono). É a ÚNICA regra acima das categorias E dos pisos de path. Isolada num
//      único `if` no topo da precedência de PERMISSÃO. O anti-SSRF de faixas internas
//      é relaxado no LOCUS DE REDE (web-port/fetcher recebem `allowInternalHosts`
//      sob YOLO), não aqui — a engine não vê IPs.
//  0.b FRONTEIRA DE `~/.aluy` (journal-read-deny / aluy-config-write-deny) ⇒ DENY,
//      MAS SÓ FORA do YOLO. Em `normal`/`plan` segue DENY acima das categorias
//      (precedência 0.b, abaixo do YOLO). No YOLO já demos `allow` em (0), então
//      nunca chega aqui — o piso cai no YOLO e PERMANECE em normal/plan.
//   1. grant de sessão "sempre nesta sessão" (CA-5) ⇒ allow — MAS só existe p/
//      itens que NÃO são sempre-ask (a engine nunca grava grant p/ sempre-ask).
//   2. HOOK que diz `deny`           ⇒ deny  (o mais restritivo vence sempre)
//   3. CATEGORIA sempre-ask          ⇒ ask (ou deny p/ sensível-deny) — NÃO
//      relaxável por allow-list nem por hook-allow (CLI-SEC-3). SÓ o `--unsafe`
//      (precedência 0) passa por cima — por decisão explícita do operador.
//   4. HOOK que diz `ask`            ⇒ ask
//   5. HOOK que diz `allow`          ⇒ allow
//   6. REGRA de política do usuário  ⇒ o veredito da regra (allow/ask/deny)
//   7. DEFAULT por tool / piso seguro⇒ run_command=ask, edit_file=ask, write=ask,
//      read=allow (read_file/grep), tool desconhecida=ask
//
// A invariante de CLI-SEC-4 é preservada por CONSTRUÇÃO: a engine decide só pelo
// `name`+`input` do tool-call (a INTENÇÃO estruturada), NUNCA pelo TEXTO ingerido
// (observações). Conteúdo lido não vira instrução nem relaxa a catraca — ele nem
// chega aqui (o loop passa o tool-call, não a observação).

import {
  type PermissionCategory,
  type PermissionEngine,
  type PermissionVerdict,
  type SessionMode,
  type ToolCall,
} from './gate.js';
import { isPlanReadAllowed } from './plan.js';
import { classifyAlwaysAsk, type CategoryMatch } from './categories.js';
import { DEFAULT_MAX_MEMORY_WRITES_PER_SESSION } from '../agent/limits.js';
import { REMEMBER_TOOL_NAME, RECALL_TOOL_NAME } from '../agent/memory/contract.js';
import { ROOM_POST_TOOL_NAME } from '../agent/rooms/room-tools.js';
import { PLAN_TOOL_NAME } from '../agent/tools/plan.js';
import { QUESTION_TOOL_NAME } from '../agent/tools/question.js';
import {
  CAPABILITIES_TOOL_NAME,
  CAPABILITIES_TOOL_ALIAS,
} from '../agent/tools/capabilities.js';
import {
  SESSION_COMMAND_TOOL_NAME,
  SESSION_COMMAND_DESTRUCTIVE_CALL_NAME,
} from '../agent/tools/session-command.js';
import { EMPTY_POLICY, evaluatePolicyRules, type PermissionPolicy } from './policy.js';
import { runHooks, type PreToolUseHook } from './hooks.js';
import { SessionGrants } from './ask.js';
import { isSafeToolDefaultChange, type SafeToolDecision } from './panel.js';
import {
  commandEffect,
  diffEffect,
  networkEffect,
  networkTargetOf,
  pathEffect,
  type ToolEffectDescriptor,
} from './effect.js';

/**
 * Tools de leitura pura: default allow (não têm efeito mutante).
 *
 * EST-0982 — `change_dir` entra aqui: é NAVEGAÇÃO de sessão (move o `sessionCwd`),
 * NÃO lê/escreve/executa nada — e o cwd é SEMPRE clampado na raiz (não escapa). Sem
 * efeito mutante ⇒ default allow (senão todo `cd` viraria `ask`, ruído). O CONFINAMENTO
 * não depende deste allow: o cwd só muda a ORIGEM dos caminhos relativos, e o gate DURO
 * (resolveInside ≤ raiz) continua barrando qualquer escape de FS/exec. (Sinalizado ao
 * `seguranca` — ver a nota da estória; é a 1ª tool de NAVEGAÇÃO no baseline.)
 *
 * EST-0983 (extensão · recall) — `recall` entra aqui: é LEITURA pura da MEMÓRIA do
 * próprio usuário (`searchFacts`), sem path/rede/efeito (contraparte do `remember`).
 * Default allow (senão consultar a própria memória viraria `ask`, ruído). Os fatos
 * voltam como DADO (B): consultar não dá autoridade nova — efeito derivado re-passa a
 * catraca. (Sinalizado ao `seguranca`: leitura read-only da própria memória local.)
 */
// EST-1015 — `update_plan` (checklist) entra aqui: SEM efeito externo (só declara o plano
// do agente) ⇒ allow SILENCIOSO como as leituras locais. O Set é por-NOME (R1/E-B2: não
// confia no rótulo `effect`), por isso a tool é listada EXPLICITAMENTE (senão cairia em `ask`).
const READ_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'change_dir',
  RECALL_TOOL_NAME,
  PLAN_TOOL_NAME,
  // EST-1110 · ADR-0114 — `perguntar` NÃO tem efeito externo (só coleta um dado local de
  // UI do usuário); allow SILENCIOSO como as leituras locais (senão cairia em `ask` a cada
  // pergunta — UX péssima). Sinalizado ao `seguranca` (AG-0008): estado de UI, não efeito.
  QUESTION_TOOL_NAME,
  // ADR-0145 · AG-0008 — `capabilities` (+ sinônimo `list_tools`) SÓ FORMATA um
  // snapshot que o locus concreto já tem em mãos (nomes/efeitos/contadores de
  // tools/agentes/skills/MCP/memória/monitores) — SEM ler filesystem, SEM rede, SEM
  // falar com outro agente. allow SILENCIOSO como as demais leituras locais (senão
  // "em dúvida, confira o `capabilities`" viraria `ask` a cada chamada — o oposto do
  // que a onda pede: o agente deve poder checar suas capacidades sem fricção).
  CAPABILITIES_TOOL_NAME,
  CAPABILITIES_TOOL_ALIAS,
]);

export interface PermissionEngineOptions {
  /** Política do usuário (dado de config). Default: vazia (só defaults seguros). */
  readonly policy?: PermissionPolicy;
  /** Hooks de pré-decisão (mecanismo código, regras = dado). Default: nenhum. */
  readonly hooks?: readonly PreToolUseHook[];
  /**
   * EST-0959 · ADR-0055 — MODO de sessão (`plan | normal | unsafe`), o eixo de
   * maior precedência (-1). `plan` = teto read-only; `normal` = catraca EST-0945;
   * `unsafe` = BYPASS TOTAL. Default `normal`. `plan` e `unsafe` são valores do
   * MESMO eixo — passar ambos é impossível (um só valor). Se `mode` E o legado
   * `unsafe` forem passados, `mode` VENCE (fonte única do eixo).
   */
  readonly mode?: SessionMode;
  /**
   * LEGADO (EST-0948) — `--unsafe` como booleano solto. Refatorado para valor do
   * eixo `mode` (`mode='unsafe'`) na EST-0959. Mantido por compatibilidade: quando
   * `true` e `mode` ausente, equivale a `mode='unsafe'`. `mode` explícito VENCE
   * este flag (ex.: `mode='plan'` + `unsafe:true` ⇒ Plan vence, sem resíduo).
   * Default: `false`.
   *
   * YOLO — PERMISSÃO COMPLETA de sessão (ADR-0072, decisão do dono): `unsafe`
   * auto-aprova QUALQUER tool, INCLUSIVE as categorias sempre-ask E os pisos de
   * `~/.aluy` (journal/config). Opt-in EXPLÍCITO por sessão, NUNCA default, NUNCA
   * persistido (banner/confirmação/headless-root-guard no @hiperplano/aluy-cli).
   */
  readonly unsafe?: boolean;
  /** Store "sempre nesta sessão" (CA-5). Default: um novo (em memória). */
  readonly sessionGrants?: SessionGrants;
  /**
   * Resolvedor opcional de diff p/ a confirmação de `edit_file`/`write_file`
   * (CLI-SEC-9). Dá o diff EXATO a aprovar:
   *  - `write_file` (full content): chamado `(path, content)` ⇒ diff de adição.
   *  - `edit_file` (str_replace, EST-0944): chamado `(path, new_string, old_string)`
   *    ⇒ diff do TRECHO trocado (old→new). O resto do arquivo é preservado por
   *    construção, então o diff do trecho É o efeito exato.
   * Se ausente, a engine cai p/ `pathEffect` (mostra só o caminho; o diff completo
   * vem da tool no momento do efeito). PORTÁVEL: função pura sobre strings, não lê fs.
   */
  readonly diffPreview?: (path: string, newText: string, oldText?: string) => string;
  /**
   * EST-0969 · ADR-0057 (E-A1) — TETO DE PROFUNDIDADE. `true` ⇒ esta engine é a de
   * um SUB-AGENTE: `spawn_agent` é NEGADO na catraca ANTES de tudo (acima até do
   * `--unsafe`/Plan), de modo que um filho NUNCA cria netos, mesmo manipulado por
   * injeção a declarar/chamar `spawn_agent`. Default `false` (engine do PAI, que
   * pode delegar). NUNCA persiste — é propriedade da engine derivada por
   * `forSubAgent()`. Defesa-em-profundidade além da ausência da tool no toolset.
   */
  readonly denySpawnAgent?: boolean;
  /**
   * EST-0977 · ADR-0061 · CLI-SEC-11 (GS-MD1) — TOOLSET RESTRITO de um agente-`.md`
   * (`tools:` do frontmatter). Quando presente, é o conjunto de nomes de tool que
   * ESTE (sub-)agente pode usar — a INTERSEÇÃO com o escopo do pai (⊆ pai): QUALQUER
   * tool fora deste conjunto é NEGADA na `decide()`, ANTES de tudo (acima de Plan/
   * `--unsafe`/categoria), como FORA DE ESCOPO. É a prova-de-deny do GS-MD1: o `.md`
   * SÓ RESTRINGE — nunca amplia (uma tool no `tools:` que esteja fora do escopo do
   * PAI não é "concedida pelo arquivo"; ela cai no piso normal e o pai já não a tinha,
   * então segue negada por construção do toolset do pai). `undefined` = SEM restrição
   * extra (herda o toolset do pai inteiro). NUNCA persiste — é derivado por
   * `forSubAgent(toolScope)`. Não confundir com a política do usuário (allow/ask/deny):
   * isto é um TETO de QUAIS tools existem p/ o filho, não COMO cada uma decide.
   */
  readonly toolScope?: ReadonlySet<string>;
  /**
   * EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M2/RES-M-2) — TETO de gravações de memória
   * (`remember`) por sessão (anti-runaway/anti-ruído). Além do teto, a catraca BARRA
   * a tool `remember` (categoria `memory-write`, deny) — anti-runaway, NÃO-relaxável
   * por `--unsafe`. Default `DEFAULT_MAX_MEMORY_WRITES_PER_SESSION` (conservador).
   */
  readonly maxMemoryWritesPerSession?: number;
  /**
   * GS-MD8 (carve-out F49) — tools ISENTAS da checagem GS-MD1 (`toolScope`) QUANDO
   * concedidas por sala (`room:`). Se a engine é de um sub-agente spawnado com `room:`,
   * as tools `room_post`/`room_read` entram neste set: o `decide()` PULA a checagem
   * `toolScope` para elas (mas TODAS as outras travas — hooks, categorias, política,
   * Plan, E-A1 — continuam). `undefined`/vazio ⇒ sem isenção (não-regressão).
   */
  readonly roomExemptTools?: ReadonlySet<string>;
}

/**
 * CLI-SEC-11 (⊆ pai) — INTERSEÇÃO de toolScopes p/ derivar o escopo de um filho a
 * partir do pai. É a regra que torna "tools do filho ⊆ tools do pai" verdadeira POR
 * CONSTRUÇÃO (não por coincidência do wiring):
 *  - pai `undefined` (sem teto — ex.: root) ⇒ usa o pedido do filho como está;
 *  - filho `undefined` (não declara `tools:`) ⇒ HERDA a restrição do pai (NÃO o toolset
 *    cheio — sem isto, um filho sem `tools:` de um pai restrito escalaria p/ tudo);
 *  - ambos definidos ⇒ só os nomes em AMBOS (interseção; o filho nunca AMPLIA o pai).
 * PURA.
 */
function intersectToolScope(
  parent: ReadonlySet<string> | undefined,
  child: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  const out = new Set<string>();
  for (const name of child) if (parent.has(name)) out.add(name);
  return out;
}

/**
 * A engine concreta. Imutável após construída (a política é dado injetado). Para
 * ligar/desligar `--unsafe` em runtime, crie outra instância (ou use o setter
 * explícito `setUnsafe`, que registra a mudança de sessão sem persistir).
 */
export class PolicyPermissionEngine implements PermissionEngine {
  private readonly policy: PermissionPolicy;
  private readonly hooks: readonly PreToolUseHook[];
  private readonly grants: SessionGrants;
  private readonly diffPreview?: (path: string, newText: string, oldText?: string) => string;
  // EST-0959 · ADR-0055 — o ÚNICO estado do eixo de modo. `plan` (teto read-only),
  // `normal` (catraca EST-0945) ou `unsafe` (BYPASS TOTAL). É a FONTE ÚNICA: não há
  // booleano `unsafe` separado a sincronizar (R3: migração atômica, sem resíduo).
  private modeValue: SessionMode;
  // EST-0968 — OVERLAY de defaults de tools SEGURAS, mutavel POR SESSAO pelo painel
  // `/permissions`. Sobrepoe `policy.defaults` (config) so p/ as tools que o painel
  // pode mexer. Cada gravacao passa pela guarda `isSafeToolDefaultChange`: `allow`
  // SO entra p/ tool read-only (SAFE_TOGGLEABLE_TOOLS); jamais p/ run_command/
  // edit_file nem p/ categoria sempre-ask. NUNCA persistido (morre com a sessao).
  private readonly safeDefaults = new Map<string, SafeToolDecision>();
  // EST-0969 (E-A1) — `true` numa engine de SUB-AGENTE: nega `spawn_agent` (teto
  // de profundidade ≤1). FONTE ÚNICA; setado só na construção (forSubAgent()).
  private readonly denySpawnAgent: boolean;
  // EST-0977 (GS-MD1) — toolset RESTRITO do agente-`.md` (⊆ pai). `undefined` numa
  // engine de pai (sem restrição extra); presente numa engine de agente nomeado: a
  // `decide()` NEGA qualquer tool fora deste conjunto (FONTE ÚNICA; setado só na
  // construção por `forSubAgent(toolScope)`).
  private readonly toolScope?: ReadonlySet<string>;
  // GS-MD8 (carve-out F49) — tools isentas da checagem GS-MD1 quando concedidas
  // por sala (`room:`). `undefined` ⇒ sem isenção (não-regressão).
  private readonly roomExemptTools?: ReadonlySet<string>;
  // EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M2) — TETO + contador de gravações de
  // memória (`remember`) desta SESSÃO. O contador avança no `allow` (registro pela
  // `noteMemoryWrite`, chamada pelo loop só quando a gravação de fato OCORREU); além
  // do teto a `decide()` devolve DENY (categoria `memory-write`), anti-runaway. NUNCA
  // persiste — morre com a sessão. FONTE ÚNICA do limite (não vai p/ a política).
  private readonly maxMemoryWrites: number;
  private memoryWrites = 0;

  constructor(opts: PermissionEngineOptions = {}) {
    this.policy = opts.policy ?? EMPTY_POLICY;
    this.hooks = opts.hooks ?? [];
    this.grants = opts.sessionGrants ?? new SessionGrants();
    // `mode` explícito VENCE o legado `unsafe:boolean`. Sem nenhum dos dois ⇒
    // `normal` (default seguro). `unsafe:true` (sem `mode`) ⇒ `mode='unsafe'`.
    this.modeValue = opts.mode ?? (opts.unsafe ? 'unsafe' : 'normal');
    if (opts.diffPreview) this.diffPreview = opts.diffPreview;
    this.denySpawnAgent = opts.denySpawnAgent ?? false;
    if (opts.toolScope !== undefined) this.toolScope = opts.toolScope;
    if (opts.roomExemptTools !== undefined) this.roomExemptTools = opts.roomExemptTools;
    this.maxMemoryWrites = opts.maxMemoryWritesPerSession ?? DEFAULT_MAX_MEMORY_WRITES_PER_SESSION;
  }

  /**
   * EST-0969 · ADR-0057 (E-A1/E-A3) — deriva a engine de um SUB-AGENTE a partir
   * desta (a do pai). O filho COMPARTILHA a política/hooks/diffPreview e HERDA o
   * MODO corrente (Plan/normal/`--unsafe`) — então o `decide()` do filho é o MESMO
   * do pai (escopo ⊆ pai), MAS:
   *   - E-A3: recebe um `SessionGrants` PRÓPRIO (novo, vazio) — aprovar um efeito
   *     sempre-ask no filho A NÃO destrava o filho B; cada um pergunta de novo.
   *     (Um grant de sessão pré-existente do pai TAMBÉM não vaza p/ o filho.)
   *   - E-A1: `denySpawnAgent=true` — `spawn_agent` é NEGADO na catraca do filho
   *     (teto de profundidade ≤1), acima até do `--unsafe`. Nenhum neto nasce.
   * NÃO persiste nada. O modo é CAPTURADO no instante da derivação (snapshot).
   *
   * EST-0977 (GS-MD1) — `toolScope` OPCIONAL: o `tools:` do agente-`.md`. Quando dado,
   * a engine do filho NEGA na catraca qualquer tool fora desse conjunto (⊆ pai —
   * RESTRINGE, nunca amplia). Ausente ⇒ o filho herda o toolset do pai inteiro
   * (default seguro: o teto continua o do pai). `spawn_agent` segue NEGADO pelo
   * `denySpawnAgent` mesmo que apareça no `toolScope` (E-A1/GS-MD2 — precedência -2).
   */
  forSubAgent(
    toolScope?: ReadonlySet<string>,
    roomExemptTools?: ReadonlySet<string>,
  ): PolicyPermissionEngine {
    // CLI-SEC-11 — o escopo do filho é a INTERSEÇÃO do pedido com o escopo do PAI
    // (`intersectToolScope`), NÃO o pedido cru. Sem isto, "tools ⊆ pai" valia só por
    // coincidência (root sem toolScope + cap de profundidade só-root-spawna): se o pai
    // TIVESSE um toolScope (root lançado como `.md`, ou se o cap mudasse), um filho pedindo
    // tools mais amplas — ou nenhuma (= toolset cheio) — escalaria além do pai. Agora a
    // restrição do pai é SEMPRE herdada/intersectada (⊆ pai por construção). Não-regressão:
    // root tem toolScope `undefined` ⇒ interseção devolve o pedido do filho, como antes.
    const childScope = intersectToolScope(this.toolScope, toolScope);
    return new PolicyPermissionEngine({
      policy: this.policy,
      hooks: this.hooks,
      mode: this.modeValue, // herda Plan/normal/unsafe do pai (escopo ⊆ pai)
      sessionGrants: new SessionGrants(), // E-A3: grants ISOLADOS por filho
      denySpawnAgent: true, // E-A1: teto de profundidade
      ...(childScope !== undefined ? { toolScope: childScope } : {}), // GS-MD1: tools ⊆ pai
      ...(roomExemptTools !== undefined ? { roomExemptTools } : {}), // GS-MD8: carve-out sala
      ...(this.diffPreview ? { diffPreview: this.diffPreview } : {}),
    });
  }

  /**
   * EST-0959 · ADR-0055 — troca o MODO de sessão (eixo de precedência -1) ATÔMICA
   * e sem resíduo (R3): como `mode` é a fonte única do eixo, ir de `unsafe`→`plan`
   * descarta qualquer "yolo herdado" por construção (não há outro estado a limpar).
   * Os grants de sessão (CA-5) são checados ABAIXO de Plan na precedência, então em
   * Plan eles não abrem efeito — mesmo um grant pré-existente. NÃO persiste nada.
   */
  setMode(mode: SessionMode): void {
    this.modeValue = mode;
  }

  /** O MODO de sessão corrente (`plan | normal | unsafe`) — p/ a TUI indicar. */
  get mode(): SessionMode {
    return this.modeValue;
  }

  /**
   * LEGADO (EST-0948) — liga/desliga `--unsafe` SÓ nesta sessão. Refatorado p/ o
   * eixo `mode`: `setUnsafe(true)` ⇒ `mode='unsafe'`; `setUnsafe(false)` ⇒
   * `normal`. NÃO sai de `plan` por engano (se já estava em plan, desligar unsafe
   * cairia em normal — mas chamadores devem usar `setMode`). Não persiste nada.
   */
  setUnsafe(on: boolean): void {
    this.modeValue = on ? 'unsafe' : 'normal';
  }

  /** `true` se a sessão está em modo `unsafe` (p/ o header pintar o aviso). */
  get isUnsafe(): boolean {
    return this.modeValue === 'unsafe';
  }

  /** `true` se a sessão está em modo `plan` (teto read-only). */
  get isPlan(): boolean {
    return this.modeValue === 'plan';
  }

  /** O store de grants de sessão (p/ o orquestrador gravar `approve-session`). */
  get sessionGrants(): SessionGrants {
    return this.grants;
  }

  decide(call: ToolCall): PermissionVerdict {
    const effect = this.describeEffect(call);

    // -2) EST-0969 · ADR-0057 (E-A1) — TETO DE PROFUNDIDADE ≤1, no TOPO ABSOLUTO da
    //     precedência (acima até de Plan/journal/`--unsafe`). Se esta engine é a de
    //     um SUB-AGENTE (`denySpawnAgent`), `spawn_agent` é NEGADO — um filho NUNCA
    //     cria netos, nem manipulado por injeção a declarar/chamar a tool, nem sob
    //     `--unsafe`. É a propriedade que torna E-A1 garantida pela CATRACA (não só
    //     pela ausência da tool no toolset do filho). CA-A1: deny ⇒ nenhum neto.
    if (this.denySpawnAgent && call.name === 'spawn_agent') {
      return ok(
        'deny',
        'profundidade de sub-agente ≤1 (E-A1): um sub-agente NÃO pode criar netos — spawn_agent negado na catraca',
        'policy:deny',
        effect,
      );
    }

    // -1.9) EST-0977 · ADR-0061 (GS-MD1) — TOOLSET RESTRITO do agente-`.md` (`tools:`).
    //     Logo abaixo do teto de profundidade (E-A1) e ACIMA de Plan/`--unsafe`/
    //     categoria: se esta engine é a de um agente nomeado COM `toolScope` e a tool
    //     chamada NÃO está no escopo, é NEGADA como FORA DE ESCOPO (⊆ pai). É a
    //     prova-de-deny do GS-MD1: o `.md` SÓ RESTRINGE — uma tool fora da lista é
    //     negada na `decide()`, não "concedida pelo arquivo". Não amplia: uma tool
    //     DENTRO da lista mas fora do que o pai concederia segue avaliada normalmente
    //     abaixo (o piso/política do pai a barra como sempre). `--unsafe` NÃO fura
    //     este teto — o `toolScope` é QUAIS tools existem p/ o filho, não o COMO; o
    //     bypass de modo libera o COMO das tools que o filho TEM, não inventa tools.
    //
    // GS-MD8 (carve-out F49) — se a tool está no `roomExemptTools` (ex.: `room_post`/
    // `room_read` concedidas por `room:`), PULA a checagem GS-MD1: a isenção é
    // ESPECÍFICA para tools de coordenação de sala, QUE O PAI JÁ CONCEDEU ao spawnar
    // com `room:`. Todas as outras travas (hooks, categorias, política, Plan, E-A1)
    // CONTINUAM — o carve-out só remove a barreira do `toolScope` do `.md`.
    if (
      this.toolScope !== undefined &&
      !(this.roomExemptTools?.has(call.name) ?? false) &&
      !this.toolScope.has(call.name)
    ) {
      return ok(
        'deny',
        `tool "${call.name}" fora do toolset declarado do agente (tools ⊆ pai, GS-MD1) — negada na catraca`,
        'policy:deny',
        effect,
      );
    }

    // As categorias sempre-ask são inspecionadas UMA vez (input estruturado).
    // Reusadas em duas posições: os pisos de `~/.aluy` (journal-read-deny /
    // aluy-config-write-deny, precedência 0.b — ABAIXO do YOLO) e a avaliação
    // normal das categorias (precedência 3).
    const cats = classifyAlwaysAsk(call.name, call.input);

    // -1.d) EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M2/RES-M-2) — TETO DE GRAVAÇÕES DE
    //     MEMÓRIA, anti-runaway, acima ATÉ do YOLO. A tool `remember` é allow
    //     SILENCIOSO (autônoma), mas com TETO por sessão: além do teto, a catraca
    //     BARRA (DENY, categoria `memory-write`). Isto é anti-runaway/anti-ruído (uma
    //     memória que cresce sem fim é DoS), NÃO confirmação de efeito — por isso
    //     NÃO é relaxável por `--unsafe`/`--yolo` (espelha o anti-runaway do `/cycle`,
    //     CLI-SEC-14). A porta da tool segue confinada a `memory/` de qualquer modo.
    //     Em Plan, o `remember` já daria DENY abaixo (efeito) — mas o teto-deny é
    //     avaliado antes só p/ dar o motivo anti-runaway preciso quando aplicável.
    if (call.name === REMEMBER_TOOL_NAME && this.memoryWrites >= this.maxMemoryWrites) {
      return ok(
        'deny',
        `teto de gravações de memória por sessão atingido (${this.memoryWrites}/${this.maxMemoryWrites}) — lembrança autônoma barrada para evitar gravações em excesso. Use /memory para revisar/podar a memória.`,
        'memory-write',
        effect,
      );
    }

    // -1) EST-0959 · ADR-0055 — MODO `plan` (TETO read-only). Avaliado ANTES do
    //     YOLO. `plan` e `unsafe` são valores EXCLUSIVOS do mesmo eixo (a sessão
    //     tem UM modo), então este teste e o do YOLO nunca disputam a MESMA call —
    //     mantê-lo antes é só defensivo (read-only é o teto). Em Plan, só a leitura
    //     LOCAL positivamente na allow-list FECHADA (plan.ts: read_file/grep/ls/glob,
    //     sem alvo remoto) segue p/ a avaliação normal; QUALQUER outra tool é
    //     EFEITO ⇒ DENY (não ask). R1/R2/R4 vivem aqui.
    if (this.modeValue === 'plan' && !isPlanReadAllowed(call)) {
      return ok(
        'deny',
        `modo Plan (read-only): "${call.name}" tem efeito (ou é rede) — só leitura local é permitida`,
        'mode:plan-deny',
        effect,
      );
    }

    // -0.9) ADR-0147 · CLI-SEC-3 — RE-PASSE do gate DESTRUTIVO de `session_command`. A
    //     PORTA concreta (`@hiperplano/aluy-cli`, que possui o registro/classificação —
    //     ver `agent/tools/session-command.ts`) chama `decide()` uma 2ª vez com este
    //     ToolCall SINTÉTICO (nunca uma tool REGISTRADA) quando o comando de sessão
    //     pedido é `destructive` (ex.: `/clear full`, `/logout`, `/cron rm`). Forçamos
    //     SEMPRE `ask`/`always-ask:destructive` aqui — na MESMA família de precedência
    //     do teto de profundidade (-2)/toolScope (-1.9)/teto de memória (-1.d)/Plan (-1):
    //     ACIMA do YOLO (0), então `--yolo`/`--unsafe` NÃO relaxa (decisão do dono,
    //     ADR-0147 — destrutivo de SESSÃO nunca auto-aprova, nem no bypass total; ao
    //     contrário das categorias sempre-ask "normais", que o YOLO deliberadamente
    //     derruba por ADR-0072). O `effect.exact` (via `describeEffect`) já carrega o
    //     texto EXATO do escopo (ex.: "apaga N fatos — IRREVERSÍVEL") que a porta montou.
    if (call.name === SESSION_COMMAND_DESTRUCTIVE_CALL_NAME) {
      return ok(
        'ask',
        `comando de sessão destrutivo — confirmação obrigatória (CLI-SEC-3, nunca auto-aprovável, nem sob --yolo): ${effect.exact}`,
        'always-ask:destructive',
        effect,
      );
    }

    // 0) ⚠ YOLO (`mode==='unsafe'`, flag `--yolo`/`--unsafe`) — PERMISSÃO COMPLETA.
    //    Auto-aprova TUDO, ANTES de qualquer regra de permissão, INCLUSIVE as
    //    categorias sempre-ask (destrutivo/rede/sudo/exec-pacote/config/MCP) E os
    //    antigos pisos de `~/.aluy` (journal-read-deny / aluy-config-write-deny, que
    //    em normal/plan ficam em 0.b ABAIXO daqui). É a decisão do dono (ADR-0072,
    //    Alternativa C — paridade com `--dangerously-skip-permissions`), isolada
    //    neste único `if` p/ o gate FORTE do `seguranca` (AG-0008) auditar. Sem YOLO,
    //    a catraca E os pisos abaixo seguem intactos. NÃO alcançável dentro de Plan
    //    (modos exclusivos). Os TETOS de gasto/estrutura (spawn-depth -2, toolScope
    //    -1.9, memory-teto -1.d) já rodaram ACIMA e NÃO caem no YOLO. O anti-SSRF de
    //    faixas internas é relaxado no LOCUS DE REDE (web-port/fetcher), não aqui.
    if (this.modeValue === 'unsafe') {
      // EST-0959 — a nota cita o nome de PRODUTO da flag (`--yolo`); a categoria
      // interna do modo continua `'unsafe'` (não renomear).
      return ok('allow', 'PERMISSÃO COMPLETA de sessão (--yolo)', 'policy:allow', effect);
    }

    // 0.b) FRONTEIRA DE `~/.aluy` — DENY abaixo do YOLO, acima das categorias.
    //     · journal-read-deny (EST-0960a · R7/B1): leitura do journal `~/.aluy/`
    //       (conteúdo-antes capturado, possível segredo) ⇒ DENY.
    //     · aluy-config-write-deny (EST-0974 · ADR-0053 §2.2): ESCRITA na config
    //       local `~/.aluy/` (hooks.json/commands/config) ⇒ DENY (auto-modificação
    //       do sistema de confiança = ato do USUÁRIO, não do agente).
    //     Em `normal`/`plan` estes pisos PERMANECEM (default seguro intacto). No
    //     YOLO já demos `allow` em (0) — por ADR-0072 (decisão do dono) o agente
    //     PODE ler/escrever `~/.aluy` sob YOLO, então esta fronteira CAI só no YOLO.
    const aluyDeny = cats.find(
      (c) =>
        (c.category === 'always-ask:journal-read-deny' ||
          c.category === 'always-ask:aluy-config-write-deny') &&
        c.deny,
    );
    if (aluyDeny) {
      return ok('deny', reasonOf(cats), aluyDeny.category, effect);
    }

    // 0.5) EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M2/GS-M8) — `remember` = ALLOW
    //     SILENCIOSO (lembrança autônoma, Q1/Q2 do Tiago). Chegou aqui ⇒ NÃO está em
    //     Plan (Plan já deu DENY acima — `remember` não está na allow-list de leitura)
    //     e NÃO estourou o teto (deny acima). Então a gravação é liberada SEM `ask`
    //     (memória é inútil se perguntar a cada fato). A autonomia é segura por
    //     construção porque o RECALL é DADO, nunca `system` (§2/GS-M3): mesmo um fato
    //     gravado de conteúdo não-confiável volta como dado e qualquer efeito derivado
    //     re-passa a catraca. A porta da tool é estreita (não recebe path do modelo).
    if (call.name === REMEMBER_TOOL_NAME) {
      return ok(
        'allow',
        'lembrança autônoma de memória (allow silencioso; recall = dado, CLI-SEC-15)',
        'memory-write',
        effect,
      );
    }

    // 0.6) EST-ROOMS-2 · ADR-0081 §8.2 + §13.1 · CLI-SEC-3 (gate AG-0008, P1) —
    //     `room_post` = COMUNICAÇÃO ENTRE AGENTES (categoria `agent-comms`). Chegou
    //     aqui ⇒ NÃO está em Plan (Plan já deu DENY acima: `room_post` NÃO está na
    //     allow-list FECHADA de leitura `PLAN_READ_ALLOWLIST` ⇒ efeito ⇒ deny — a
    //     prova "plan nega room_post" é por construção, NÃO por esta branch) e NÃO está
    //     em YOLO (que já liberou em 0). A decisão de segurança (§13.1): a MEMBERSHIP
    //     da sala É o consentimento — `room_post` de um MEMBRO NÃO re-pergunta a cada
    //     mensagem (`ask`-por-post é inutilizável numa conversa multi-agente). A authz
    //     REAL é a MESH (`postMessage` recusa quem não está em `policy.writers`) + o
    //     código como capability (~256 bits) + a allow-list POR SALA. Por isso o
    //     default é `allow` SILENCIOSO — MAS uma REGRA EXPLÍCITA do usuário por sala
    //     (`room_post:<code>` deny/ask) ainda VENCE: avaliamos a política ANTES de
    //     liberar, p/ honrar "permito esta sala, nego aquela" (§8.2 allow-list
    //     granular; NUNCA `allow` global se o usuário negou um código). A defesa de
    //     LAUNDERING é o envelope DADO na LEITURA (`room_read`, §13.2), não o `ask`.
    if (call.name === ROOM_POST_TOOL_NAME) {
      const roomCode = primaryArg(call);
      const rule = evaluatePolicyRules(this.policy, call.name, roomCode);
      if (rule && rule.decision !== 'allow') {
        // o usuário NEGOU/pediu `ask` p/ esta sala (`room_post:<code>`): honra (a
        // allow-list granular do §8.2 — escopo por código). Allow segue p/ o default.
        return ok(
          rule.decision,
          `política do usuário (room_post: ${rule.match ?? 'qualquer sala'})`,
          'agent-comms',
          effect,
        );
      }
      return ok(
        'allow',
        'comunicação entre agentes (membership = consentimento, §13.1; authz na mesh: writer∈writers)',
        'agent-comms',
        effect,
      );
    }

    // 0.7) ADR-0147 — `session_command` (a via única p/ o agente disparar comandos de
    //     SESSÃO) SEMPRE passa direto NESTE ponto (allow). O roteamento REAL por CLASSE
    //     de efeito (`read-only`/`session-effect` ⇒ executa; `destructive` ⇒ RE-PASSA
    //     `decide()` com o ToolCall sintético acima, ANTES de qualquer efeito;
    //     `human-only`/não-classificado ⇒ deny honesto) acontece DENTRO da porta
    //     concreta (`@hiperplano/aluy-cli`), que possui o registro/classificação — não
    //     aqui. Chegou aqui ⇒ já passou Plan (que já negaria `session_command` como
    //     qualquer outro efeito fora da allow-list de leitura) e o teto de profundidade/
    //     toolScope/memória acima. Nada de novo na catraca além do que CADA comando
    //     roteado já faz (GS-SC1: a tool não contorna o ponto único — é mais um
    //     tool-call atrás dele; o efeito PRÓPRIO de um comando session-effect, ex.: os
    //     `run_command` de dentro de um `/cycle`, segue passando por `decide()` normal).
    if (call.name === SESSION_COMMAND_TOOL_NAME) {
      return ok(
        'allow',
        'session_command: roteamento por classe de efeito ocorre na porta (ADR-0147) — destrutivos re-passam decide() internamente',
        'default',
        effect,
      );
    }

    // 1) grant "sempre nesta sessão" (CA-5). A engine só GRAVA grants p/ itens
    //    não-sempre-ask (ver `grantSession`), então um grant aqui implica que o
    //    item não é sempre-ask — seguro liberar.
    if (this.grants.has(call)) {
      return ok('allow', 'liberado nesta sessão (sempre-permitir)', 'policy:allow', effect);
    }

    // 2) hooks que NEGAM vencem tudo (o mais restritivo).
    const hook = runHooks(this.hooks, call);
    if (hook?.decision === 'deny') {
      return ok('deny', `hook: ${hook.reason}`, 'hook', effect);
    }

    // 3) CATEGORIAS sempre-ask — o DENTE, inspeciona o input. NÃO relaxável por
    //    allow-list/hook-allow (só o YOLO de precedência 0 passa por cima). Os
    //    pisos de `~/.aluy` (journal/config) já deram DENY em 0.b acima quando fora
    //    do YOLO; aqui sobram as demais categorias sempre-ask.
    if (cats.length > 0) {
      const denyCat = cats.find((c) => c.deny);
      if (denyCat) {
        return ok('deny', reasonOf(cats), denyCat.category, effect);
      }
      // ask não-relaxável: nem hook-allow, nem allow-list cobrem.
      return ok('ask', reasonOf(cats), primaryCategory(cats), effect);
    }

    // 4) hook que pede ask.
    if (hook?.decision === 'ask') {
      return ok('ask', `hook: ${hook.reason}`, 'hook', effect);
    }

    // 5) hook que libera.
    if (hook?.decision === 'allow') {
      return ok('allow', `hook: ${hook.reason}`, 'hook', effect);
    }

    // 6) regra de política do usuário (allow/ask/deny). Allow aqui é seguro: as
    //    categorias sempre-ask já foram aplicadas em (3) e teriam vencido.
    const arg = primaryArg(call);
    const rule = evaluatePolicyRules(this.policy, call.name, arg);
    if (rule) {
      const r = rule.match ? `${rule.match}` : 'qualquer input';
      return ok(
        rule.decision,
        `política do usuário (${call.name}: ${r})`,
        ruleCategory(rule.decision),
        effect,
      );
    }

    // 7) DEFAULT por tool / piso seguro (CLI-SEC-3).
    return this.defaultFor(call, effect);
  }

  /**
   * Grava um grant "sempre nesta sessão" (CA-5). RECUSA-SE a gravar p/ categorias
   * sempre-ask (CLI-SEC-3: cada ocorrência pergunta de novo) — devolve `false`.
   * Devolve `true` se gravou. O orquestrador chama isto APÓS o usuário escolher
   * "approve-session" no diálogo.
   */
  grantSession(call: ToolCall): boolean {
    if (classifyAlwaysAsk(call.name, call.input).length > 0) return false;
    this.grants.grant(call);
    return true;
  }

  /**
   * EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M2) — REGISTRA que uma gravação de memória
   * (`remember`) OCORREU nesta sessão, avançando o contador do teto. O loop chama
   * isto APÓS a tool `remember` rodar COM SUCESSO (não na decisão — uma gravação que
   * falhou no I/O não consome cota). Quando o contador atinge o teto, a `decide()`
   * passa a NEGAR `remember` (anti-runaway). NUNCA persiste — estado de sessão.
   */
  noteMemoryWrite(): void {
    this.memoryWrites += 1;
  }

  /** EST-0983 — gravações de memória já feitas / teto desta sessão (p/ a TUI/`/memory`). */
  get memoryWriteUsage(): { readonly used: number; readonly max: number } {
    return { used: this.memoryWrites, max: this.maxMemoryWrites };
  }

  /**
   * EST-0968 · CLI-SEC-3 — AJUSTA o default de uma tool SEGURA pelo painel
   * `/permissions` (estado de SESSAO). Devolve `true` se aplicou; `false` se a
   * mudanca NAO e segura (rejeitada — a guarda `isSafeToolDefaultChange` barra
   * qualquer `allow` p/ tool que nao seja read-only). E a PROTECAO ANTI-INJECAO do
   * painel: nenhum caminho aqui sete uma tool de efeito (run_command/edit_file) nem
   * uma categoria sempre-ask p/ `allow`. `ask` e sempre aceito (mais restritivo).
   * NUNCA persiste. O gate FORTE do `seguranca` confere que SO esta porta muda
   * default — e que ela jamais emite allow fora de SAFE_TOGGLEABLE_TOOLS.
   */
  setSafeToolDefault(tool: string, decision: SafeToolDecision): boolean {
    if (!isSafeToolDefaultChange(tool, decision)) return false;
    this.safeDefaults.set(tool, decision);
    return true;
  }

  /**
   * EST-0968 — o default EFETIVO de uma tool segura p/ o painel exibir o estado
   * atual. Le, em ordem: overlay de sessao (painel) → `policy.defaults` (config) →
   * piso seguro da engine (read-only ⇒ allow; o resto ⇒ ask). So-leitura.
   */
  effectiveSafeDefault(tool: string): SafeToolDecision {
    const fromOverlay = this.safeDefaults.get(tool);
    if (fromOverlay) return fromOverlay;
    const fromConfig = this.policy.defaults?.[tool];
    if (fromConfig === 'allow' || fromConfig === 'ask') return fromConfig;
    return READ_TOOLS.has(tool) ? 'allow' : 'ask';
  }

  // ── default seguro por tool (piso de CLI-SEC-3) ──────────────────────────────
  private defaultFor(call: ToolCall, effect: ToolEffectDescriptor): PermissionVerdict {
    // EST-0968 — OVERLAY do painel `/permissions` (estado de sessao) vence o default
    // de config p/ tools SEGURAS. So contem valores que passaram pela guarda
    // anti-injecao (allow SO p/ read-only; o piso `floor` ainda re-trava run_command/
    // edit_file por garantia). Avaliado AQUI (precedencia 7): as categorias sempre-ask
    // (3) ja venceram acima — um overlay NUNCA alcanca um comando perigoso.
    const fromOverlay = this.safeDefaults.get(call.name);
    if (fromOverlay) {
      const floored = this.floor(call.name, fromOverlay);
      return ok(floored, `default ajustado no painel (${call.name})`, 'default', effect);
    }
    const fromConfig = this.policy.defaults?.[call.name];
    if (fromConfig) {
      // PISO: run_command nunca abaixo de ask; nenhum default rebaixa write p/ allow.
      const floored = this.floor(call.name, fromConfig);
      return ok(floored, `default configurado (${call.name})`, 'default', effect);
    }
    if (READ_TOOLS.has(call.name)) {
      return ok('allow', `leitura pura (${call.name}) — default allow`, 'default', effect);
    }
    if (call.name === 'run_command') {
      return ok('ask', 'run_command = ask por padrão (CLI-SEC-3)', 'default', effect);
    }
    if (call.name === 'edit_file') {
      return ok('ask', 'edit_file = ask com diff (CLI-SEC-9)', 'default', effect);
    }
    if (call.name === 'write_file') {
      return ok('ask', 'write_file = ask com diff (CLI-SEC-9)', 'default', effect);
    }
    // tool desconhecida / qualquer efeito sem regra ⇒ ask (nunca allow silencioso).
    return ok(
      'ask',
      `sem regra explícita p/ "${call.name}" — ask (deny-por-padrão)`,
      'default',
      effect,
    );
  }

  /** Aplica o PISO de CLI-SEC-3: run_command/edit_file não descem abaixo de ask. */
  private floor(
    name: string,
    decision: PermissionVerdict['decision'],
  ): PermissionVerdict['decision'] {
    if (
      (name === 'run_command' || name === 'edit_file' || name === 'write_file') &&
      decision === 'allow'
    ) {
      return 'ask';
    }
    return decision;
  }

  /** Descreve o efeito EXATO p/ a confirmação (CLI-SEC-9). */
  private describeEffect(call: ToolCall): ToolEffectDescriptor {
    if (call.name === 'run_command') {
      const command = strInput(call, 'command');
      const host = networkTargetOf(command);
      return host
        ? networkEffect('run_command', command, host)
        : commandEffect('run_command', command);
    }
    if (call.name === 'edit_file') {
      // EST-0944 — edit_file é str_replace: a confirmação (CLI-SEC-9) mostra o DIFF
      // do trecho EXATO (old_string→new_string). NÃO há "conteúdo inteiro" no input —
      // o resto do arquivo é preservado por construção, então o diff do trecho É o
      // efeito exato a aprovar. `diffPreview` é injetado pelo locus concreto.
      const path = strInput(call, 'path');
      const oldStr = strInput(call, 'old_string');
      const newStr = strInput(call, 'new_string');
      if (this.diffPreview) {
        return diffEffect('edit_file', path, this.diffPreview(path, newStr, oldStr));
      }
      return pathEffect('edit_file', path);
    }
    if (call.name === 'write_file') {
      // write_file é o sobrescreve-tudo: a confirmação mostra o conteúdo COMPLETO
      // como diff de adição (não há old_string).
      const path = strInput(call, 'path');
      const content = strInput(call, 'content');
      if (this.diffPreview) {
        return diffEffect('write_file', path, this.diffPreview(path, content));
      }
      return pathEffect('write_file', path);
    }
    if (call.name === 'read_file' || call.name === 'grep') {
      return pathEffect(call.name, strInput(call, 'path'));
    }
    // EST-0944 — `glob` é leitura de NOMES de arquivo confinada (efeito `read`). O
    // descritor mostra o diretório-base (alvo da varredura), não o padrão.
    if (call.name === 'glob') {
      return pathEffect('glob', strInput(call, 'path') || '.');
    }
    // EST-0983 · CLI-SEC-15 — efeito de gravação de memória: o FATO + o escopo
    // (global|projeto). Allow-silencioso (sem confirmação), mas o descritor existe
    // p/ auditoria/observabilidade (`/memory`, GS-M6). NUNCA recebe path do modelo —
    // o input é só `{ fact, scope }`, então o efeito mostra o fato, não um caminho.
    if (call.name === REMEMBER_TOOL_NAME) {
      const fact = strInput(call, 'fact');
      const scope = strInput(call, 'scope') || 'global';
      return { kind: 'path', tool: REMEMBER_TOOL_NAME, exact: `[memória/${scope}] ${fact}` };
    }
    // EST-0971 · CLI-SEC-9/13 — efeito de REDE das tools nativas web_fetch/web_search:
    // a confirmação mostra a URL/destino EXATO (web_fetch) ou a query (web_search).
    // É um `networkEffect` com `target` = o destino exato, p/ a TUI destacar "para
    // onde" o egress vai (CLI-SEC-5/9). A query do web_search é o "destino lógico"
    // da busca (a redação de segredo é da TOOL, no momento do egress).
    if (call.name === 'web_fetch') {
      const url = strInput(call, 'url');
      return networkEffect('web_fetch', `web_fetch ${url}`, url);
    }
    if (call.name === 'web_search') {
      const query = strInput(call, 'query');
      return networkEffect('web_search', `web_search ${query}`, 'duckduckgo.com');
    }
    // EST-ROOMS-2 · ADR-0081 — efeito de COMUNICAÇÃO ENTRE AGENTES: a sala (code) + o
    // destinatário (to) + o kind. Allow-silencioso (membership=consentimento), mas o
    // descritor existe p/ AUDITORIA (CLI-SEC-10 / `/rooms`): mostra PARA ONDE a fala
    // foi (qual sala, qual agente), nunca o corpo cru. `kind:'path'` (alvo lógico).
    if (call.name === ROOM_POST_TOOL_NAME) {
      const code = strInput(call, 'code');
      const to = strInput(call, 'to');
      const kind = strInput(call, 'kind');
      return {
        kind: 'path',
        tool: ROOM_POST_TOOL_NAME,
        exact: `[sala ${code}] ${kind || 'msg'} → ${to || '?'}`,
      };
    }
    // ADR-0147 — efeito de `session_command`: mostra `/comando args` (o comando de
    // sessão pedido), como um `commandEffect` (o mesmo formato de `run_command`).
    if (call.name === SESSION_COMMAND_TOOL_NAME) {
      const command = strInput(call, 'command');
      const args = strInput(call, 'args');
      return commandEffect(SESSION_COMMAND_TOOL_NAME, `/${command}${args ? ` ${args}` : ''}`);
    }
    // ADR-0147 — efeito EXATO do RE-PASSE destrutivo: a porta concreta já preparou o
    // texto do escopo (`exact`, ex.: "apaga N fatos — IRREVERSÍVEL") no input sintético;
    // ausente ⇒ cai no `/comando args` cru (mesma forma do caso acima, fail-safe).
    if (call.name === SESSION_COMMAND_DESTRUCTIVE_CALL_NAME) {
      const command = strInput(call, 'command');
      const args = strInput(call, 'args');
      const exact = strInput(call, 'exact');
      const base = `/${command}${args ? ` ${args}` : ''}`;
      return commandEffect(SESSION_COMMAND_TOOL_NAME, exact ? `${base} — ${exact}` : base);
    }
    // tool desconhecida: descreve o que der (nome + input serializado curto).
    // FU (EST-0946/0948) — NÃO implementar em v1, só registrado: `describeEffect`
    // de tool DESCONHECIDA serializa só `primaryArg` (CLI-SEC-9 PARCIAL p/ MCP
    // futuro). Quando entrarem tools MCP, descrever o efeito completo do input
    // (não só o 1º arg) p/ a confirmação humana mostrar o efeito exato.
    return { kind: 'command', tool: call.name, exact: `${call.name} ${primaryArg(call)}`.trim() };
  }
}

/** Atalho de construção do veredito (DRY). */
function ok(
  decision: PermissionVerdict['decision'],
  reason: string,
  category: PermissionCategory,
  effect: ToolEffectDescriptor,
): PermissionVerdict {
  return { decision, reason, category, effect };
}

function reasonOf(cats: readonly CategoryMatch[]): string {
  return cats.map((c) => c.reason).join('; ');
}

function primaryCategory(cats: readonly CategoryMatch[]): PermissionCategory {
  return cats[0]!.category;
}

function ruleCategory(decision: PermissionVerdict['decision']): PermissionCategory {
  return decision === 'deny' ? 'policy:deny' : 'policy:allow';
}

function primaryArg(call: ToolCall): string {
  // EST-ROOMS-2 — `room_post` é escopado por SALA: o arg principal é o `code` (a
  // capability). Expô-lo aqui é o que torna a allow-list POR SALA (`room_post:<code>`,
  // ADR-0081 §8.2) avaliável pela política do usuário.
  if (call.name === ROOM_POST_TOOL_NAME) return strInput(call, 'code');
  return strInput(call, 'command') || strInput(call, 'path') || strInput(call, 'pattern') || '';
}

function strInput(call: ToolCall, key: string): string {
  const v = call.input[key];
  return typeof v === 'string' ? v : '';
}
