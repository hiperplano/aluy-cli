// CLI-SEC-H1 — ponto de interceptação único de tool-calls (a SEMENTE).
//
// ADR-0053 §8-bis + ficha aluy-vau §Segurança: ANTES de qualquer efeito de uma
// tool, a engine consulta ESTE ponto único, que decide allow / ask / deny. É a
// invariante que DEVE sobreviver ao split futuro de locus (client-side hoje,
// server-side amanhã) — a engine, em QUALQUER locus, só executa tool depois de
// passar por aqui.
//
// IMPORTANTE — o que esta estória (EST-0941) entrega vs o que NÃO entrega:
//   - ENTREGA: o SEAM. O tipo do veredito, o contrato da `PermissionEngine`, e
//     o ponto único `decide()` pelo qual todo tool-call passa. Sem este seam, a
//     EST-0945 não teria onde aterrissar.
//   - NÃO entrega: o engine de permissão CONCRETO (allow/ask/deny reais,
//     categorias sempre-ask não-relaxáveis, `--unsafe`, hooks). Isso é a EST-0945
//     (TRAVA do `seguranca`, gate FORTE). O default aqui é deny-by-default
//     (ver `denyAllEngine`): seguro por construção até a EST-0945 plugar a
//     política real. Nunca relaxar o default para allow.

/** Categorias de veredito da catraca de permissão (allow/ask/deny). */
export type PermissionDecision = 'allow' | 'ask' | 'deny';

/**
 * EST-0959 · ADR-0055 — EIXO DE MODO DE SESSÃO (ortogonal à decisão por
 * categoria). Avaliado no TOPO de `decide()` (precedência 0), antes de tudo.
 * É estado de SESSÃO (dado do usuário), nunca persistido como default global.
 *
 *   - `plan`   ⇒ TETO read-only: nega (DENY, não ask) toda tool de EFEITO;
 *                permite só LEITURA LOCAL (allow-list FECHADA). Plan vence
 *                allow-list/hook/`--unsafe`/injeção (read-only é o teto).
 *   - `normal` ⇒ não interfere; a catraca EST-0945 decide (default seguro).
 *   - `unsafe` ⇒ BYPASS TOTAL (EST-0948): auto-aprova TUDO, inclusive
 *                sempre-ask. Opt-in explícito.
 *
 * `plan` e `unsafe` são valores do MESMO eixo (mutuamente exclusivos por
 * construção): a sessão tem UM modo. Default `normal`.
 */
export type SessionMode = 'plan' | 'normal' | 'unsafe';

/** Descreve um efeito de tool a ser avaliado ANTES de executar. */
export interface ToolCall {
  /** Nome da tool (ex.: "read_file", "run_command", "edit_file"). */
  readonly name: string;
  /** Argumentos da chamada — opacos para o gate (a política os interpreta). */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Categoria que motivou um veredito `ask`/`deny`. Para auditoria (CLI-SEC-10) e
 * para a TUI saber que tipo de confirmação renderizar. `always-ask:*` são as
 * categorias NÃO-relaxáveis de CLI-SEC-3 (rede, destrutivo, escalada, etc.) — a
 * engine concreta (EST-0945) as preenche; o seam só conhece o tipo.
 */
export type PermissionCategory =
  | 'always-ask:network'
  | 'always-ask:destructive'
  | 'always-ask:escalation'
  | 'always-ask:package-exec'
  | 'always-ask:config-startup'
  | 'always-ask:outside-workspace'
  | 'always-ask:sensitive-read'
  // EST-0960a · ADR-0056 §5 / R7 — leitura do journal `~/.aluy/` é NEGADA por
  // QUALQUER canal (read_file/grep/edit_file E run_command/cat). Fecha o vetor
  // de exfiltração do conteúdo-antes capturado (possível segredo) via injeção
  // (CLI-SEC-4/CLI-T2). É DENY (não ask), não-relaxável.
  | 'always-ask:journal-read-deny'
  // EST-0974 · ADR-0053 §2.2 — ESCRITA na config local `~/.aluy/` (hooks.json,
  // commands/, config) é NEGADA por QUALQUER canal do agente (edit_file E
  // run_command que escreva lá). Editar a config de HOOK = ato do USUÁRIO, não do
  // agente — senão um README malicioso faria o agente plantar um hook que roda
  // sempre (persistência). É DENY (não ask), acima até do `--unsafe`, pelo mesmo
  // motivo do `journal-read-deny`: o `--unsafe` libera EFEITOS de trabalho, NÃO a
  // auto-modificação do sistema de confiança do próprio Aluy.
  | 'always-ask:aluy-config-write-deny'
  // EST-0970 · ADR-0058 · CLI-SEC-12 — tool de um SERVER MCP de terceiro. EFEITO
  // por padrão (E-B2): a natureza real é não-confiável (o server pode declarar
  // "readonly" e mesmo assim escrever/POST). ⇒ `ask`, NUNCA allow silencioso, e
  // NÃO-relaxável por allow-list/hook (categoria sempre-ask). Quando o input mostra
  // sinal de rede/path sensível, a engine ANEXA também a categoria específica
  // (network/sensitive-read/journal/aluy-write/outside) p/ o motivo e o DENY certo.
  | 'always-ask:mcp-effect'
  // EST-0983 · ADR-0064 · CLI-SEC-15 — ESCRITA na memória de agente pela tool
  // dedicada `remember` (porta de I/O PRÓPRIA, confinada a `memory/`). Categoria
  // PRÓPRIA, distinta do `edit_file`/`run_command` (que seguem DENY em TODO
  // `~/.aluy/`): a memória NÃO é carve-out do write-deny — é um canal separado que
  // SÓ sabe escrever em `memory/`. Default `allow` SILENCIOSO (a lembrança é
  // autônoma — inútil se perguntar a cada fato; Q1/Q2 do Tiago), MAS:
  //   - Plan ⇒ DENY (escrita = efeito; ADR-0055), avaliado no eixo de modo;
  //   - teto de gravações por sessão (CLI-SEC-8): além do teto ⇒ DENY (anti-
  //     runaway/anti-ruído), sinalizado por `deny:true` no `CategoryMatch`.
  // Mesmo com `--unsafe`/`--yolo`, `remember` só escreve em `memory/` (a porta da
  // tool é estreita por construção — não recebe path do modelo). A segurança da
  // autonomia vem do RECALL = DADO (nunca `system`), não de perguntar a cada fato.
  | 'memory-write'
  // EST-ROOMS-2 · ADR-0081 §8.2 + §13.1 · CLI-SEC-3 (gate AG-0008, P1) — COMUNICAÇÃO
  // ENTRE AGENTES pela tool `room_post` (escreve numa sala que outro agente lê e pode
  // reagir). EFEITO INDIRETO (não leitura): um sub-agente comprometido por injeção
  // (CLI-T1) usaria a sala como vetor de influência sobre outro agente. Categoria
  // PRÓPRIA (distinta de `network`/`exec`) p/ POLÍTICA GRANULAR — allow-listável só
  // por sala (`room_post:<code>`), NUNCA global. Diferente de `network`/`destructive`:
  //   - NÃO é `ask`-por-post — a MEMBERSHIP da sala É o consentimento (§13.1: o humano
  //     consentiu ao criar a sala + escolher os writers; `ask` a cada fala é
  //     inutilizável numa conversa multi-agente — espelha ADR-0079 §6.1 / ADR-0062);
  //   - a authz REAL é a mesh (`postMessage`: writerId∈writers) + o código como
  //     capability (~256 bits, ADR-0078) + a allow-list por sala;
  //   - em `plan` (ADR-0055) ⇒ DENY (efeito; read-only não posta) — avaliado no eixo
  //     de modo, ACIMA desta categoria;
  //   - a defesa de LAUNDERING é o envelope DADO na LEITURA (`room_read`, §13.2), não
  //     a aprovação por-post. Por isso `allow` (sem `ask`) é seguro AQUI.
  | 'agent-comms'
  // EST-0959 · ADR-0055 — DENY do teto read-only do modo Plan (efeito proibido
  // no modo, NÃO `ask`). Precedência 0; vence allow-list/hook/`--unsafe`/injeção.
  | 'mode:plan-deny'
  | 'policy:deny'
  | 'policy:allow'
  | 'hook'
  | 'default';

/** Veredito do gate, com motivo auditável. */
export interface PermissionVerdict {
  readonly decision: PermissionDecision;
  /** Motivo legível (auditoria/UX). */
  readonly reason: string;
  /**
   * Categoria que motivou o veredito (opcional; a engine concreta da EST-0945
   * preenche). Mantém o seam compatível com vereditos `{decision, reason}` puros.
   */
  readonly category?: PermissionCategory;
  /**
   * O EFEITO EXATO a confirmar (CLI-SEC-9): o comando, o diff ou a URL/destino —
   * nunca um resumo vago. Presente em `ask` (e útil em `deny` p/ auditoria). A
   * TUI (EST-0948) renderiza ISTO no diálogo de confirmação. Opcional no seam;
   * a engine concreta o anexa. `type: ToolEffectDescriptor` definido em
   * `./effect.ts` — referenciado por `unknown` aqui p/ o seam não depender da
   * engine concreta (evita ciclo). A engine retorna o tipo concreto.
   */
  readonly effect?: import('./effect.js').ToolEffectDescriptor;
}

/**
 * Contrato do engine de permissão. A EST-0945 fornece a implementação concreta
 * (allow/ask/deny, sempre-ask, hooks). Qualquer locus (CLI ou, no futuro,
 * runtime) injeta a sua implementação — mas SEMPRE passa por `decide()`.
 */
export interface PermissionEngine {
  decide(call: ToolCall): PermissionVerdict;
}

/**
 * Default seguro até a EST-0945: nega tudo. Deny-by-default garante que nenhum
 * efeito escape do gate enquanto a política real não existe. NÃO trocar por
 * allow — isso furaria CLI-SEC-H1.
 */
export const denyAllEngine: PermissionEngine = {
  decide: (call) => ({
    decision: 'deny',
    reason: `engine de permissão concreto ainda não plugado (EST-0945) — deny-by-default para "${call.name}"`,
  }),
};

/**
 * Ponto de interceptação ÚNICO. Todo tool-call da engine passa por aqui antes
 * de qualquer efeito. É deliberadamente fino e sem I/O: o efeito real só ocorre
 * a jusante, e SÓ se o veredito for `allow` (a engine de loop, EST-0944, é quem
 * respeita o veredito). Mantê-lo único e portável é a invariante atravessa-loci.
 */
export function decide(engine: PermissionEngine, call: ToolCall): PermissionVerdict {
  return engine.decide(call);
}
