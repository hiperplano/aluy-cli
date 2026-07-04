// EST-0944 — contrato das tools nativas + PORTAS de I/O injetáveis.
//
// As tools são código no pacote (ADR-0053 §2.2), mas o `@hiperplano/aluy-cli-core` é
// PORTÁVEL: NÃO importa `node:fs`/`node:child_process`. Em vez disso, cada tool
// depende de uma PORTA (interface) que o locus concreto injeta — `@hiperplano/aluy-cli`
// liga a porta a `fs`/`child_process` reais (EST-0948); no futuro server-side, a
// MESMA tool liga a um sandbox da nuvem. Isso é a fronteira do §8/§8-bis viva no
// nível da tool: a mecânica (parse/contrato/efeito) é portável, o I/O é injetado.
//
// CADA tool declara se tem EFEITO (`effect: true`): write/exec/rede. Toda tool
// com efeito é OBRIGADA a passar pelo gate (CLI-SEC-H1) ANTES do efeito — o loop
// é quem garante isso; aqui só se DECLARA a natureza para o loop saber.

/** Categoria de efeito de uma tool (governa a obrigatoriedade do gate). */
export type ToolEffect =
  | 'read' // só lê (não muta estado externo): read_file, grep
  | 'write' // muta o filesystem do usuário: edit_file
  | 'exec' // executa comando arbitrário: bash/run_command
  // EST-0971 · CLI-SEC-13 — tool que faz EGRESS de rede (web_fetch/web_search). É
  // efeito ⇒ PASSA pelo gate (categoria always-ask:network, não-relaxável; Plan ⇒
  // deny — ADR-0055). NUNCA é tratada como leitura local.
  | 'network'
  // EST-0970 · ADR-0058 · CLI-SEC-12 — tool vinda de um SERVER MCP de terceiro. É
  // EFEITO POR PADRÃO (E-B2): a natureza real é não-confiável (o server pode
  // mentir), então o gate a trata como efeito (⇒ `ask`/`deny`, NUNCA allow
  // silencioso) e a CLASSIFICA por sinais do input (rede/path), não por rótulo
  // auto-declarado. Plan a nega (não está na allow-list fechada de leitura local).
  | 'mcp'
  // EST-0983 · ADR-0064 · CLI-SEC-15 — tool dedicada de MEMÓRIA (`remember`). Efeito
  // de ESCRITA confinada a `memory/` por uma porta PRÓPRIA (não recebe path do
  // modelo). É efeito ⇒ PASSA pelo gate (categoria `memory-write`: allow silencioso +
  // Plan-deny + teto por sessão). NÃO é carve-out do `edit_file`/`run_command` (que
  // seguem DENY em todo `~/.aluy/`); é um canal separado que só sabe falar com `memory/`.
  | 'memory'
  // EST-ROOMS-2 · ADR-0081 §8.2 + §13.1 · CLI-SEC-3 (gate AG-0008, P1) — tool de
  // COMUNICAÇÃO ENTRE AGENTES (`room_post`): escreve numa SALA que OUTRO agente lê e
  // pode reagir. É EFEITO INDIRETO (não leitura): um sub-agente comprometido por
  // prompt-injection (CLI-T1) usaria a sala como vetor de influência. ⇒ PASSA pelo
  // gate (categoria `agent-comms`): **Plan ⇒ DENY** (efeito, read-only não permite);
  // em normal/unsafe NÃO há `ask`-por-post — a MEMBERSHIP da sala É o consentimento
  // (§13.1: o humano consentiu ao criar a sala + escolher os writers; perguntar a
  // cada fala é inutilizável numa conversa multi-agente). A authz REAL é a mesh
  // (`postMessage` recusa quem não está em `policy.writers`) + allow-list por sala
  // (`room_post:<code>`). NÃO é `'read'` (a label `read` mentia: room_post tem efeito).
  | 'comms';

/**
 * Resultado da execução de uma tool. `ok=false` NÃO lança — vira observação de
 * erro devolvida ao modelo (CLI-SEC-4: o modelo trata, mas não "obedece" o texto).
 * `display` é o efeito exato a confirmar (CLI-SEC-9, consumido pela EST-0945/0948):
 * o comando, o diff ou o caminho — nunca um resumo vago.
 */
export interface ToolResult {
  readonly ok: boolean;
  /** Texto que volta ao modelo como observação (DADO, CLI-SEC-4). */
  readonly observation: string;
  /** Pré-visualização exata do efeito p/ confirmação (CLI-SEC-9). Opcional. */
  readonly display?: string;
}

/**
 * EST-0982 — CONTEXTO de uma execução de tool: cancelamento + saída ao vivo.
 *
 * O loop (e o `!comando`) injeta este contexto em `tool.run` p/ dois eixos da
 * EST-0982, ambos REUSANDO o MESMO sinal de abort do loop/root-flow (EST-0944/0969):
 *  - `signal` — o MESMO `AbortSignal` que `esc`/Ctrl-C/`interrupt` disparam. A tool
 *    o repassa à porta de I/O (ex.: `ShellPort.exec`) p/ que um comando longo/infinito
 *    (server, `input()`) seja MORTO ao abortar — não fique vivo até o timeout.
 *  - `onShellChunk` — callback de STREAMING: a porta emite stdout/stderr ao vivo e a
 *    tool os repassa aqui p/ o controller renderizar no bloco da tool viva (bounded
 *    pelo orçamento da região viva, anti-flicker intacto). A saída JÁ vem REDIGIDA
 *    pela porta concreta (CLI-SEC-6) — o callback nunca recebe segredo em claro.
 *  - ADR-0112 · EST-RT-2 — `onTestProgress`: callback de PROGRESSO ESTRUTURADO de
 *    testes (canal de tool-ao-vivo, padrão Monitor/ADR-0079). A tool `run_tests`
 *    o chama com cada `TestEvent` + `TestScore` (snapshot do placar); a UI assina
 *    p/ atualizar o bloco vivo dedicado (barra + placar + falhas). Separado do chunk
 *    cru — é "mais um tipo de evento no barramento". Tipado via `import(...)` p/
 *    evitar acoplamento cíclico (mesma técnica do WebPort/SubAgentPort).
 *
 * OPCIONAL e backward-compatible: `run(input, ports)` sem `ctx` segue funcionando
 * idêntico (sem cancelamento dirigido nem streaming) — não-regressão das tools que
 * não consomem o contexto (read_file/grep/edit_file).
 */
export interface ToolRunContext {
  /** O MESMO sinal de abort do loop/root-flow (EST-0944/0969/0982). */
  readonly signal?: AbortSignal;
  /** Saída ao vivo do shell, JÁ redigida (CLI-SEC-6) pela porta concreta. */
  readonly onShellChunk?: (chunk: ShellChunk) => void;
  /**
   * ADR-0112 · EST-RT-2 — progresso ESTRUTURADO de testes (canal de tool-ao-vivo).
   * O `run_tests` chama com cada evento parseado + snapshot do placar. OPCIONAL.
   */
  readonly onTestProgress?: (
    event: import('../testing/test-parse.js').TestEvent,
    score: import('../testing/test-parse.js').TestScore,
  ) => void;
}

/**
 * ADR-0145 (frente d) — AGRUPAMENTO por INTENÇÃO de uma tool nativa. Alimenta DOIS
 * consumidores a partir da MESMA fonte (`NativeTool.group`): o MENU do `capabilities`
 * (agrupa por intenção) e, no futuro, qualquer outra vista por-intenção. Tool MCP
 * (`mcp__<server>__<tool>`) NÃO declara `group` — é inferido como `'mcp'` por quem
 * monta o snapshot (dado de terceiro, sem grupo auto-declarado confiável).
 */
export type CapabilityGroup =
  | 'arquivo'
  | 'busca'
  | 'execucao'
  | 'delegacao'
  | 'memoria'
  | 'assincrono'
  | 'web'
  | 'plano'
  | 'mcp'
  | 'outro';

/**
 * Contrato de uma tool nativa. `run` recebe o input já parseado (do protocolo), a
 * porta de I/O concreta e um CONTEXTO opcional (EST-0982: abort + streaming). NÃO
 * consulta o gate — o gate é responsabilidade do LOOP (ponto único; a tool não pode
 * contorná-lo). A tool valida o seu input e devolve `ok=false` se inválido (nunca
 * lança por input ruim).
 */
export interface NativeTool<Ports = unknown> {
  readonly name: string;
  readonly effect: ToolEffect;
  /** Descrição curta p/ o prompt do agente (o modelo aprende a tool por aqui). */
  readonly description: string;
  /**
   * ADR-0145 (frente b/d) — FONTE ÚNICA do "quando usar": uma frase curta, em
   * PT-BR, iniciada por um verbo/contexto de uso (ex.: "localizar ONDE algo está
   * ANTES de editar"), SEM ponto final. Alimenta DOIS lugares a partir do MESMO
   * texto (autorado uma vez, sem duplicar verdade):
   *  - a `description` da tool (frente b) embute este texto ("Use QUANDO: …");
   *  - o menu do `capabilities` (frente d) o exibe junto ao nome da tool.
   * OPCIONAL: tools MCP NÃO declaram `when` (dado de terceiro, não-confiável) — o
   * campo fica ausente e o `capabilities` simplesmente omite a coluna "quando" p/
   * elas. Tools nativas sem `when` (a maioria — já têm gatilho claro, ex.:
   * `spawn_agent`/`recall`/`monitor`) também podem omiti-lo sem regressão.
   */
  readonly when?: string;
  /** ADR-0145 (frente d) — grupo de intenção (ver `CapabilityGroup`). OPCIONAL. */
  readonly group?: CapabilityGroup;
  /**
   * JSON Schema do INPUT da tool (objeto) — FONTE ÚNICA dos parâmetros, consumida
   * pelos DOIS caminhos de tool-calling (EST-0996 nativo + EST-0970 texto):
   *
   *  - NATIVO (EST-0996): quando o modelo SUPORTA function-calling, vira o
   *    `function.parameters` do catálogo `tools` enviado ao broker
   *    (`toToolFunctionSchemas`/`toToolFunctionSchema`) — o schema vai ESTRUTURADO,
   *    como objeto. Ausente ⇒ schema permissivo (objeto livre).
   *  - TEXTO/FALLBACK (EST-0970): quando o modelo NÃO suporta nativo (ou nativo
   *    desligado), o `system` deriva deste MESMO schema, via `paramsFromJsonSchema`
   *    (tool-param-docs.ts), a lista de PARÂMETROS e a renderiza COMPACTA no
   *    `toolDocs` — p/ o modelo saber QUAIS campos passar e quais são OBRIGATÓRIOS.
   *    Sem isto, o modelo adivinha os args de tools complexas (ex.: MCP playwright
   *    `browser_type` exige `{element, ref, text}`) e a chamada falha por campo
   *    faltante.
   *
   * OPCIONAL e trust-neutral (E-B2): para tool MCP o schema vem do server de
   * terceiro (`inputSchema`) — DADO NÃO-CONFIÁVEL. NÃO é validação de runtime (cada
   * tool revalida o seu input no `run`, boundary não-confiável) nem fonte de
   * confiança; só GUIA o modelo. As descrições derivadas dele são SANITIZADAS na
   * renderização do prompt (`sanitizeUntrustedDoc`), nunca elevadas a instrução.
   * Ausente ⇒ tool entra no prompt SEM params e no nativo com schema permissivo
   * (idêntico ao de antes; não-regressão).
   */
  readonly parameters?: Readonly<Record<string, unknown>>;
  run(
    input: Readonly<Record<string, unknown>>,
    ports: Ports,
    ctx?: ToolRunContext,
  ): Promise<ToolResult>;
}

// ── Portas de I/O (injetáveis; o concreto mora em @hiperplano/aluy-cli) ──────────────────

/** Resultado de uma leitura COM metadado de completude (EST-0944 · anti-data-loss). */
export interface FileReadMeta {
  /** O conteúdo lido (texto). Se `!complete`, é só um PREFIXO (ou vazio p/ binário). */
  readonly content: string;
  /**
   * `true` SÓ se o conteúdo é o arquivo INTEIRO e legível como texto. `false` quando
   * o locus concreto truncou por teto de bytes (arquivo gigante) OU o arquivo é
   * binário — casos em que `content` NÃO representa o arquivo. O editor (edit_file/
   * write_file) usa isto p/ RECUSAR reescrever sobre uma leitura parcial (senão o
   * write-back TRUNCA o arquivo e ainda injeta o marcador de truncamento no fonte).
   */
  readonly complete: boolean;
}

/** Porta de filesystem (read/edit). Caminhos resolvidos pelo locus concreto. */
export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** `true` se o arquivo existe (p/ o edit decidir criar vs sobrescrever). */
  exists(path: string): Promise<boolean>;
  /**
   * EST-0944 (anti-data-loss) — leitura COM completude. OPCIONAL/aditivo: portas
   * antigas que só têm `readFile` continuam válidas (o caller degrada). Quando
   * presente, o editor a usa p/ NÃO reescrever sobre uma leitura truncada/binária.
   */
  readFileMeta?(path: string): Promise<FileReadMeta>;
}

/** Resultado bruto de um comando de shell. */
export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /**
   * EST-0982 — `true` quando o comando foi MORTO por um abort cooperativo
   * (`esc`/Ctrl-C/interrupt), distinto do timeout (anti-hang) e do exit normal. A
   * porta concreta mata o processo (grupo) na hora; o resultado reporta o
   * encerramento limpo p/ o turno cessar sem esperar o teto.
   */
  readonly aborted?: boolean;
}

/**
 * EST-0982 — um CHUNK de saída ao vivo de um comando de shell (streaming). A porta
 * concreta o emite enquanto o comando roda; o texto JÁ vem REDIGIDO (CLI-SEC-6) —
 * nunca carrega segredo em claro p/ a observação/render.
 */
export interface ShellChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/**
 * EST-0982 — opções de `ShellPort.exec`: cancelamento + streaming. AMBOS opcionais
 * (backward-compatible: `exec(command)` segue válido):
 *  - `signal` — o MESMO `AbortSignal` do loop/root-flow (EST-0944/0969). Ao abortar,
 *    a porta MATA o processo (grupo) — SIGTERM e, após um grace curto, SIGKILL — em
 *    vez de deixar o filho vivo até o timeout. Já abortado ⇒ não roda nada.
 *  - `onChunk` — callback de saída ao vivo (stdout/stderr), JÁ redigido (CLI-SEC-6).
 */
export interface ShellExecOptions {
  readonly signal?: AbortSignal;
  readonly onChunk?: (chunk: ShellChunk) => void;
}

/** Porta de shell (bash/run_command). O concreto aplica timeout/cwd reais. */
export interface ShellPort {
  /**
   * Executa `command`. `options.signal` (EST-0982) propaga o abort do loop — ao
   * disparar, a porta MATA o processo (grupo) sem esperar o timeout. `options.onChunk`
   * emite stdout/stderr ao vivo (redigido, CLI-SEC-6). Ambos opcionais.
   */
  exec(command: string, options?: ShellExecOptions): Promise<ShellResult>;
}

/**
 * EST-0982 — DIRETÓRIO DE TRABALHO DE SESSÃO (`sessionCwd`). Porta ESTREITA que a
 * tool `change_dir` usa p/ NAVEGAR um cwd de sessão que TODOS os tools respeitam:
 *  - `run_command` roda NELE (não na raiz fixa);
 *  - `read_file`/`edit_file`/`grep`/`@arquivo` resolvem caminhos RELATIVOS contra ELE.
 *
 * CONFINAMENTO PRESERVADO (o ponto de segurança): `setCwd` SEMPRE resulta num cwd
 * DENTRO da raiz canonicalizada do workspace — `cd ..` além da raiz ⇒ CLAMPADO na
 * raiz (nunca escapa). A contenção/`resolveInside` do FS/exec continua = raiz; o
 * `sessionCwd` é só um cwd RELATIVO dentro dela. A porta NÃO faz I/O de efeito (não
 * lê/escreve/executa) — só move o ponteiro de navegação; por isso a `change_dir` é
 * efeito `read` (não passa por confirmação destrutiva), mas é AUDITÁVEL (linha `⏺`).
 *
 * OPCIONAL em `ToolPorts`: sem `cwd` injetado, `change_dir` devolve erro claro (não
 * há navegação) e o resto do agente segue na raiz como antes (não-regressão).
 */
export interface CwdPort {
  /** O `sessionCwd` corrente (absoluto, canonicalizado, ⊆ raiz). Default = raiz. */
  readonly cwd: string;
  /** A raiz canonicalizada (teto do confinamento) — p/ exibir o cwd RELATIVO. */
  readonly root: string;
  /**
   * EST-0982 · /add-dir — TODAS as raízes AUTORIZADAS da sessão (a primária + as
   * extras que o USUÁRIO autorizou via `/add-dir`), canonicalizadas. OPCIONAL
   * (não-regressão): ausente ⇒ o conjunto é `[root]` (single-root, como antes). O
   * core NÃO tem como AMPLIAR este conjunto — a porta só o EXPÕE p/ display; a
   * ampliação é ato do USUÁRIO no locus concreto (slash, NUNCA tool — o agente não
   * se auto-amplia, nem em `--unsafe`).
   */
  readonly roots?: readonly string[];
  /**
   * Navega o `sessionCwd` p/ `requested` (relativo ao cwd corrente, ou absoluto).
   * SEMPRE clampa nas raízes autorizadas (nunca escapa o conjunto). Devolve o novo
   * `sessionCwd` absoluto. Lança apenas se o alvo não for um DIRETÓRIO existente
   * dentro das raízes.
   */
  setCwd(requested: string): string;
}

/** Um acerto de busca (grep). */
export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/**
 * EST-1016 · addendum ADR-0053 — SINAL DE TRUNCAMENTO da busca. Os tetos anti-OOM/
 * anti-flood (EST-1010) PERMANECEM; este sinal só os torna VISÍVEIS p/ que o usuário
 * (e o agente no loop) NUNCA trate um resultado PARCIAL como COMPLETO. Distingue as
 * TRÊS causas independentes de corte:
 *  - `byScanBytes` — arquivos lidos SÓ até o teto de bytes/arquivo (`maxScanBytes`):
 *    o conteúdo ALÉM do teto NÃO foi varrido (pode haver acertos não vistos nesses
 *    arquivos). Lista os paths afetados.
 *  - `byMaxMatches` — a varredura PAROU ao atingir o teto de acertos (`maxMatches`):
 *    `matches.length === maxMatches` e pode haver MAIS ocorrências não devolvidas.
 *  - `byMaxFiles` — a varredura PAROU ao atingir o teto de arquivos (`maxFiles`):
 *    arquivos restantes NÃO foram varridos.
 *
 * AUSÊNCIA de um campo = aquele ramo NÃO disparou. `truncated` SEM nenhum ramo ativo
 * (sem `byScanBytes`/`byMaxMatches`/`byMaxFiles`) = varredura COMPLETA (zero corte).
 */
export interface SearchTruncation {
  /** Paths lidos SÓ até o teto de bytes/arquivo (resto do arquivo NÃO varrido). */
  readonly byScanBytes?: readonly string[];
  /** `true` se a varredura parou no teto de acertos (`maxMatches`) — pode haver mais. */
  readonly byMaxMatches?: boolean;
  /** `true` se a varredura parou no teto de arquivos (`maxFiles`) — restantes não vistos. */
  readonly byMaxFiles?: boolean;
}

/**
 * EST-1016 — RESULTADO da busca: os acertos + o sinal HONESTO de truncamento. Antes,
 * `search()` devolvia só `readonly SearchMatch[]` — sem nenhum aviso de que o resultado
 * era parcial (bug F6 do dogfood: contava "200" de 300 e apresentava como definitivo).
 * Agora o port é OBRIGADO a reportar quando cortou (ver `SearchTruncation`).
 */
export interface SearchOutcome {
  readonly matches: readonly SearchMatch[];
  readonly truncated: SearchTruncation;
}

/**
 * EST-0944 — SINAL DE TRUNCAMENTO do `glob` (espelha `SearchTruncation`, mas a busca de
 * ARQUIVOS por padrão tem só DUAS causas de corte, ambas anti-OOM/anti-runaway):
 *  - `byMaxResults` — a lista PAROU ao atingir o teto de caminhos devolvidos
 *    (`maxResults`): há MAIS arquivos que casaram, não devolvidos. Política F18/grep.
 *  - `byMaxScanned` — a VARREDURA parou ao atingir o teto de arquivos inspecionados
 *    (`maxScanned`): arquivos restantes NÃO foram nem testados (podem casar e sumiram).
 *
 * AUSÊNCIA de um campo = aquele ramo NÃO disparou. Sem nenhum ramo = varredura COMPLETA.
 */
export interface GlobTruncation {
  /** `true` se a lista parou no teto de resultados (`maxResults`) — pode haver mais. */
  readonly byMaxResults?: boolean;
  /** `true` se a varredura parou no teto de arquivos inspecionados (`maxScanned`). */
  readonly byMaxScanned?: boolean;
}

/**
 * EST-0944 — RESULTADO do `glob`: os caminhos RELATIVOS (POSIX `/`) que casaram, em
 * ordem estável, + o sinal HONESTO de truncamento. Espelha `SearchOutcome` (mesma
 * disciplina F6/F18: um resultado PARCIAL nunca é apresentado como COMPLETO).
 */
export interface GlobOutcome {
  /** Caminhos RELATIVOS à raiz (separador `/`), que casaram o padrão. */
  readonly paths: readonly string[];
  readonly truncated: GlobTruncation;
}

/** Porta de busca (grep + glob). O concreto varre o filesystem; aqui é abstrato. */
export interface SearchPort {
  /**
   * Busca `pattern` a partir de `path` (confinado à raiz pelo locus concreto). Devolve
   * os acertos E o sinal de truncamento (EST-1016): o concreto popula `truncated` quando
   * bate qualquer teto anti-OOM/anti-flood (`maxScanBytes`/`maxMatches`/`maxFiles`).
   */
  search(pattern: string, path: string): Promise<SearchOutcome>;

  /**
   * EST-0944 — `glob`: acha ARQUIVOS por PADRÃO de caminho (ex.: todos os .ts em
   * qualquer profundidade, ou os test_*.py sob src) sob
   * `path` (confinado à raiz pelo locus concreto). Enumera os arquivos do workspace
   * RESPEITANDO O `.gitignore` (como o `@arquivo`/file-index) e testa cada caminho
   * RELATIVO contra o padrão (matcher PURO `compileGlob`, anti-ReDoS). Devolve os
   * caminhos casados + o sinal de truncamento. É LEITURA pura (não lê conteúdo, só
   * nomes). Lança em padrão sintaticamente inválido (erro VISÍVEL, não silêncio).
   *
   * OPCIONAL (aditivo, como `cwd`/`journal` em `ToolPorts`): um port sem `glob` (ex.:
   * fakes de teste que só implementam `search`) segue válido — a tool `glob` degrada
   * com erro CLARO ("indisponível nesta sessão"), nunca quebra. O locus concreto
   * (@hiperplano/aluy-cli) sempre liga o `glob` real (NodeSearchPort).
   */
  glob?(pattern: string, path: string): Promise<GlobOutcome>;
}

/**
 * EST-0960a · ADR-0056 — gancho MÍNIMO de captura de snapshot que a `edit_file`
 * invoca ANTES de sobrescrever (CA-1). Reusa o `before` JÁ lido p/ o diff
 * (CLI-SEC-9) — a tool não relê o arquivo. É a face estreita do `SnapshotJournal`
 * (journal/index.ts) que as tools enxergam; a pilha/restauração completas ficam
 * fora da tool. OPCIONAL em `ToolPorts`: sem journal injetado, `edit_file` segue
 * funcionando idêntico (sem snapshot) — não-regressão.
 */
export interface ToolJournalPort {
  /** Captura o conteúdo-antes de uma edição aprovada (no ponto de efeito). */
  captureEdit(input: {
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly createdByEdit: boolean;
  }): Promise<void>;
  /**
   * EST-0960a · CA-3 — marca a BARREIRA não-reversível de um `run_command` na
   * pilha (NÃO captura snapshot; efeito de shell não é auto-reversível). A 0960b
   * usa a barreira p/ avisar "aqui rodou `<cmd>` — não desfeito".
   */
  markBarrier(command: string): Promise<void>;
}

/** Conjunto de portas que as tools nativas precisam. */
export interface ToolPorts {
  readonly fs: FileSystemPort;
  readonly shell: ShellPort;
  readonly search: SearchPort;
  /**
   * EST-0982 — porta do DIRETÓRIO DE TRABALHO DE SESSÃO (`sessionCwd`) que a tool
   * `change_dir` navega (confinada à raiz). OPCIONAL: sem ela, `change_dir` é inerte
   * (erro claro, nenhum efeito) e o agente segue na raiz (não-regressão). O locus
   * concreto (@hiperplano/aluy-cli) liga esta porta ao `NodeWorkspace`, que owna o `sessionCwd`
   * que o `shell`/`fs`/`search` já consultam — uma ÚNICA fonte de verdade do cwd.
   */
  readonly cwd?: CwdPort;
  /**
   * EST-0960a — journal de snapshot-do-antes (OPCIONAL). Quando presente, a
   * `edit_file` captura o `antes` antes de sobrescrever; quando ausente, a tool
   * funciona igual (sem snapshot). NUNCA bloqueia/altera o efeito — a captura é
   * best-effort sob a disciplina já aplicada pela catraca.
   */
  readonly journal?: ToolJournalPort;
  /**
   * EST-0971 · CLI-SEC-13 — porta de REDE (web_fetch/web_search): resolver DNS +
   * fetcher pinado (anti-SSRF) + egress-allowlist + tetos. OPCIONAL: sem `web`, as
   * tools de rede devolvem erro claro (não há rede) e o resto do agente segue igual
   * (não-regressão). Tipada por `import(...)` p/ não acoplar este módulo de contrato
   * ao módulo concreto de web (evita ciclo de import; mesma técnica do gate/effect).
   */
  readonly web?: import('../web/web-port.js').WebPort;
  /**
   * EST-0969 · ADR-0057 — porta de SPAWN de sub-agentes locais PARALELOS (OPCIONAL).
   * Quando presente, a tool `spawn_agent` a usa p/ delegar subtarefas em paralelo;
   * sem ela, `spawn_agent` é inerte (erro, nenhum efeito — fail-safe). Tipada por
   * `import(...)` p/ não acoplar este contrato ao módulo concreto (evita ciclo). O
   * locus concreto (@hiperplano/aluy-cli) liga esta porta ao `SubAgentSpawner`, que carrega a
   * MESMA engine/ports/budget do pai (não-bypass + escopo ⊆ pai + E-A2).
   */
  readonly subAgents?: import('./spawn-agent.js').SubAgentPort;
  /**
   * EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M1) — porta de MEMÓRIA (OPCIONAL). Duas faces
   * ESTREITAS, ambas confinadas a `memory/` (nunca um path do modelo):
   *  - ESCRITA (`remember`, GS-M1): a tool `remember` grava um FATO (global|projeto).
   *  - LEITURA SOB DEMANDA (`searchFacts`, OPCIONAL no tipo — extensão recall): a tool
   *    `recall` CONSULTA os fatos já gravados. É a CONTRAPARTE de leitura do `remember`;
   *    `searchFacts` é opcional p/ não quebrar mocks write-only existentes (sem ela,
   *    `recall` é inerte/erro-claro). O read-deny de `~/.aluy/memory/` p/ o agente
   *    PERMANECE — só esta porta interna lê.
   * Sem a porta toda, `remember`/`recall` são inertes (erro claro — fail-safe). Tipada
   * por `import(...)` p/ não acoplar este contrato à mecânica de memória (evita ciclo;
   * mesma técnica do journal/web/subAgents). O locus concreto (@hiperplano/aluy-cli) liga esta porta
   * à `AgentMemory` (escreve/lê `~/.aluy/memory/` 0600/0700 atômico + `.aluy/memory/`).
   */
  readonly memory?: import('../memory/remember-tool.js').MemoryWritePort &
    Partial<import('../memory/recall-tool.js').MemoryReadPort>;
  /**
   * EST-1108 — porta do BACKLOG/TODO (OPCIONAL). A tool `add_todo` anota um item
   * pendente; `list_todos` consulta; `done_todo` marca concluído. Porta ESTREITA
   * (espelha GS-M1): a tool NUNCA recebe um path — só opera pelo contrato
   * `TodoStorePort`. Sem a porta, as tools de TODO são inertes (erro claro).
   * O locus concreto liga ao `TodoStore` (`~/.aluy/todos.json`, fail-safe).
   */
  readonly todo?: import('../todo/contract.js').TodoStorePort;
  /**
   * EST-1015 (pedido do dono) — porta do PLANO/CHECKLIST (OPCIONAL). Quando presente, a
   * tool `update_plan` empurra o plano vivo (passos + status) p/ o painel `<Checklist>`
   * da TUI; sem ela, `update_plan` segue funcional (devolve o checklist renderizado como
   * observação) — só não há painel (não-regressão). Tipada por `import(...)` p/ não
   * acoplar este contrato ao módulo concreto (evita ciclo; mesma técnica de memory/web).
   */
  readonly plan?: import('./plan.js').PlanPort;
  /**
   * EST-1126 · ADR-0123 §4.3 — porta do GRAFO DE CAIXAS do Maestro (OPCIONAL).
   * Quando presente, `update_plan` projeta o grafo como checklist (horizonte,
   * aninhamento); sem ele, `update_plan` segue com render flat (não-regressão).
   * Tipada por `import(...)` p/ não acoplar este contrato ao módulo concreto
   * (evita ciclo; mesma técnica de plan/memory/web). ESTADO PURO (portável):
   * ContextGraph é dado+heurística, SEM I/O (ADR-0053 §8).
   */
  readonly graph?: import('../maestro/context-box-graph.js').ContextGraph;
  /**
   * EST-1110 · ADR-0114 — porta de PERGUNTA ao usuário (OPCIONAL). Quando presente, a
   * tool `perguntar` a usa p/ fazer uma pergunta interativa (single/multi/text + "Outro")
   * e devolver a resposta como observação. Sem ela, `perguntar` é inerte (erro acionável,
   * fail-safe não-pendura) — não-regressão. Tipada por `import(...)` p/ não acoplar este
   * contrato à mecânica concreta (evita ciclo; mesma técnica de plan/memory/web). O locus
   * concreto (@hiperplano/aluy-cli) liga esta porta ao `TuiQuestionResolver` (controlador da TUI).
   */
  readonly question?: import('./question.js').QuestionPort;
  /**
   * ADR-0145 (frente d) · CLI-SEC-4 — porta do MENU VIVO de capacidades (OPCIONAL).
   * Quando presente, a tool `capabilities` (e o sinônimo `list_tools`) a consulta p/
   * devolver, SOB DEMANDA, o que o agente pode disparar AGORA — agrupado por
   * intenção, com ESTADO VIVO (MCP conectados neste boot, agentes `.md`, monitores
   * armados, nº de fatos na memória, skills descobertas). A tool SÓ FORMATA o
   * snapshot (sem I/O próprio); o locus concreto (`@hiperplano/aluy-cli`) monta o
   * snapshot a partir do que JÁ TEM em mãos no controller (mesmo padrão das portas
   * `memory`/`subAgents`/`question`). Sem a porta, `capabilities` devolve erro claro
   * (fail-safe) — não-regressão. Tipada por `import(...)` p/ não acoplar este
   * contrato ao módulo concreto da tool (evita ciclo; mesma técnica de plan/memory/web).
   */
  readonly capabilities?: CapabilitiesPort;
}

/**
 * ADR-0145 (frente d) — um item de tool NATIVA no snapshot de `capabilities`. `group`
 * vem de `NativeTool.group` (tool MCP ⇒ sempre `'mcp'`, inferido pelo prefixo
 * `mcp__<server>__`, nunca auto-declarado pelo server). `when` vem de `NativeTool.when`
 * (ausente p/ MCP — dado de terceiro).
 */
export interface CapabilityToolInfo {
  readonly name: string;
  readonly effect: ToolEffect;
  readonly group: CapabilityGroup;
  readonly when?: string;
}

/**
 * ADR-0145 (frente d/e) — um item NOMEADO (agente `.md` ou skill) no snapshot.
 * `summary` é UMA linha (a `description` do agente/skill, ou a 1ª linha do corpo —
 * já SANITIZADA por quem monta o snapshot quando `origin==='project'`, CLI-SEC-4: DADO
 * de terceiro nunca vira instrução via este canal). `invocable` só faz sentido p/
 * skills (ADR-0145 §e): `true` SÓ para `origin==='global'` — skill `project` é
 * DESCOBERTA-APENAS (o agente a menciona/recomenda, nunca a injeta sozinho).
 * Agentes `.md` não usam `invocable` (delegação já é via `spawn_agent`, tool própria).
 */
export interface CapabilityNamedItem {
  readonly name: string;
  readonly summary: string;
  readonly origin: 'global' | 'project';
  readonly invocable?: boolean;
}

/** ADR-0145 (frente d) — um SERVER MCP conectado (metadado NOSSO, não a description de terceiro). */
export interface CapabilityMcpServer {
  readonly server: string;
  readonly toolCount: number;
  /** Prefixo de nome das tools deste server (ex.: `"mcp__playwright__"`). */
  readonly prefix: string;
}

/**
 * ADR-0145 (frente d) — o MENU VIVO completo. CONDIÇÕES DE SEGURANÇA (AG-0008,
 * obrigatórias — ver `capabilities.ts` e os testes anti-vazamento):
 *  - NUNCA carrega credencial/provider/base_url/api_key/`model`/`tier` — só nomes,
 *    efeitos, contadores e agrupamento (o que já está, em prosa, no `system`).
 *  - `mcpServers` NUNCA leva a `description` da tool MCP de terceiro — só
 *    `server`/`toolCount`/`prefix` (metadado NOSSO).
 *  - `memory` NUNCA leva o conteúdo dos fatos — só `factCount`.
 *  - Summaries de origem `project` (agentes/skills) chegam JÁ sanitizadas
 *    (`sanitizeUntrustedDoc`) por quem monta o snapshot.
 */
export interface CapabilitiesSnapshot {
  readonly tools: readonly CapabilityToolInfo[];
  readonly agents: readonly CapabilityNamedItem[];
  readonly skills: readonly CapabilityNamedItem[];
  readonly mcpServers: readonly CapabilityMcpServer[];
  readonly memory?: { readonly factCount: number };
  readonly monitors?: readonly { readonly id: string; readonly label: string; readonly type: string }[];
  /** Comandos `/…` que o HUMANO digita (nunca invocados pelo agente) — auto-conhecimento do produto. */
  readonly sessionCommands: readonly { readonly name: string; readonly about: string }[];
}

/**
 * ADR-0145 (frente d) — porta que o locus concreto implementa p/ montar o snapshot
 * (mesmo padrão de `memory`/`subAgents`/`question`: o core define o CONTRATO puro; o
 * `@hiperplano/aluy-cli` monta o dado concreto a partir do que já tem no controller).
 */
export interface CapabilitiesPort {
  snapshot(): CapabilitiesSnapshot | Promise<CapabilitiesSnapshot>;
}
