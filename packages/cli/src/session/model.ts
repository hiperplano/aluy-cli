// EST-0948 — o MODELO DE VISÃO da sessão da TUI (dado puro, sem React/Ink).
//
// A TUI renderiza a sessão como COMPOSIÇÃO DE BLOCOS (spec §1: "bloco expressivo,
// não markup") a partir DESTE modelo. O wiring (session/run.tsx) traduz os
// eventos do loop/broker/catraca (EST-0943/0944/0945) nestes blocos, e os
// componentes os renderizam. Manter o modelo separado da renderização torna os
// blocos testáveis sem Ink e o estado previsível.
//
// HG-2: o modelo NUNCA carrega provider/modelo — só `tier`. Se um payload trouxer
// provider, é bug de contrato (não entra aqui).

import type {
  AskRequest,
  QuestionSpec,
  Quota,
  ServerLimits,
  SessionMode,
  TestScore,
} from '@hiperplano/aluy-cli-core';

/** Um turno do usuário (▌ você). */
export interface YouTurn {
  readonly kind: 'you';
  readonly text: string;
}

/** Um turno do agente (◇ aluy) — texto que faz stream token-a-token. */
export interface AluyTurn {
  readonly kind: 'aluy';
  readonly text: string;
  /** `true` enquanto o stream está chegando (cursor ▏ na ponta, ◇ pisca). */
  readonly streaming: boolean;
  /**
   * EST-0944 (refino #121) — este turno é uma PASSADA INTERNA de AUTO-VERIFICAÇÃO do
   * self-check (o modelo reconferindo a evidência ANTES de o loop aceitar o "pronto"),
   * NÃO uma resposta ao usuário. É MÁQUINA DO LOOP: o controller o REMOVE ao finalizar
   * (não vira bloco `Λ aluy` visível — no máximo uma nota dim "✓ auto-verificado"). A
   * resposta REAL é a `final` ANTERIOR (já visível) / a que o loop entrega no fim.
   * Ausente/`false` ⇒ turno normal (visível). Limpo se o modelo, em vez de confirmar,
   * ACHA UM GAP e volta a AGIR (uma tool dispara) — aí o trabalho seguinte é real.
   */
  readonly selfCheck?: boolean;
}

/** Uma linha de tool (⏺ verbo alvo resultado ✓/✗ · ◌ verbo … rodando…). */
export interface ToolLineBlock {
  readonly kind: 'tool';
  readonly verb: string; // read · edit · bash · grep · …
  readonly target: string; // alvo (path/comando/padrão)
  readonly result: string; // resultado QUANTIFICADO (48 linhas, 0 erros, …)
  // `running` = in-flight (◌ + gerúndio + onda, §2.6); vira `ok`/`err` ao concluir.
  readonly status: 'ok' | 'err' | 'running';
  /** Saída relevante (box "saída") quando `err`. Truncada pelo produtor. */
  readonly output?: string;
  /** Verbo no GERÚNDIO p/ o in-flight (`rodando`, `lendo`, `editando`). §2.6. */
  readonly verbGerund?: string;
  /**
   * EST-0982 (Fase 0) — DIFFSTAT de um edit/write: linhas adicionadas/removidas,
   * derivadas do diff unificado do `edit_file`. Alimentam a ATIVIDADE rica da FlowTree
   * (drill-in). Ausentes p/ tools que não editam (degrada — não mostra `+/−`).
   */
  readonly added?: number;
  readonly removed?: number;
  /**
   * EST-0982 — SAÍDA AO VIVO de um `run_command` enquanto roda (`status==='running'`).
   * Acumulada pelos chunks do shell (JÁ REDIGIDA, CLI-SEC-6, pelo core); a TUI a mostra
   * bounded pela cauda (windowTail/live-budget, anti-flicker intacto). É substituída
   * pelo resultado quantificado quando a linha resolve. Vazia p/ read/edit/grep (não
   * streamam).
   */
  readonly liveOutput?: string;
}

/** Um bloco de "deny" registrado (efeito recusado pelo usuário). */
export interface DenyBlock {
  readonly kind: 'deny';
  readonly verb: string;
  readonly exact: string;
}

/**
 * EST-0958 — bloco de saída de um `!comando` (atalho de shell do composer). É uma
 * ação do USUÁRIO (não turno do modelo): mostra o comando exato e a saída como um
 * BLOCO DE SAÍDA (§2.6), distinto da fala do agente. `blocked` = a catraca negou
 * (deny/ask-não-aprovado) e o comando NÃO executou.
 */
export interface BangBlock {
  readonly kind: 'bang';
  /** O comando EXATO digitado após o `!` (CLI-SEC-9). */
  readonly command: string;
  /** `running` enquanto avalia/executa; `ok`/`err` ao concluir; `blocked` se negado. */
  readonly status: 'running' | 'ok' | 'err' | 'blocked';
  /** Saída bruta (exit/stdout/stderr) ou o motivo do bloqueio. Truncada pelo produtor. */
  readonly output?: string;
  /**
   * EST-0982 — SAÍDA AO VIVO do `!comando` enquanto roda (`status==='running'`).
   * Acumulada pelos chunks do shell (JÁ REDIGIDA, CLI-SEC-6, pelo core); a TUI a mostra
   * bounded pela cauda (anti-flicker intacto). Substituída pelo `output` final quando
   * resolve.
   */
  readonly liveOutput?: string;
}

/**
 * EST-0969 (display) — UM sub-agente filho no indicador compacto. Status por filho
 * (`running` → `done`/`fail`), atualizado conforme cada um inicia/termina. NÃO
 * carrega o corpo/stream do filho — só o RÓTULO + estado + um resumo curto
 * (tokens/tools/stop) quando concluído. É o que substitui o despejo dos tokens crus
 * dos N filhos na região viva (que interleavava).
 */
export interface SubAgentChild {
  /** Rótulo de origem do filho (ex.: `rust`, `go`, `zig`). */
  readonly label: string;
  /**
   * EST-0982 · ADR-0063 — id do nó na árvore de fluxos (FlowTree) — p/ o drill-in
   * (VER) e o PARAR roteado por nó. Estável por (sessão, label). Opcional p/
   * back-compat dos testes da EST-0969 que não montam a árvore.
   */
  readonly nodeId?: string;
  /**
   * `running` enquanto vivo; `done` (sucesso) / `fail` (teto/timeout/erro) ao terminar.
   * EST-0982 — `cancelled` quando o usuário PAROU este filho (cessar≠falha): a11y
   * honesta (não é "falhou", é "parado").
   */
  readonly status: 'running' | 'done' | 'fail' | 'cancelled';
  /**
   * Resumo curto do desfecho — EST-0982 acrescenta o TEMPO (estilo Claude Code):
   * `74.4k tokens · 13 tools · 2.1s`. Só quando concluído.
   */
  readonly summary?: string;
  /** Motivo da parada (`final`/`limit`/`timeout`/`error`/`cancelled`) — a11y/auditoria. */
  readonly stop?: 'final' | 'limit' | 'timeout' | 'error' | 'cancelled';
  /**
   * ADR-0146 (D5) — o NOME do tier/modelo RESOLVIDO deste filho (`aluy-strata`,
   * `custom · <slug>`, `herdado (aluy-flux)`, `herdado (custom · <slug-do-pai>)`).
   * Preenchido pelo controller (`upsertSubAgentChild`) a partir da precedência de
   * resolução do modelo. NUNCA provider/base_url/credencial (HG-2/CLI-SEC-7) — só a
   * chave de tier/slug de catálogo, mesma natureza do que a status bar do pai já
   * mostra. Visível enquanto `status==='running'` e mantido no resumo final.
   */
  readonly model?: string;
}

/**
 * EST-0969 (display) — BLOCO de sub-agentes paralelos: `⊕ 3 sub-agentes:` com uma
 * linha de STATUS por filho. Substitui o despejo dos streams crus dos N filhos
 * (que interleavava virando lixo). É um bloco ESTÁVEL (sem jitter): só muda quando
 * um filho inicia/termina — não a cada token. Fica VIVO enquanto qualquer filho
 * roda (sufixo da região viva); quando TODOS concluem migra p/ o `<Static>`, e o
 * pai then streama o resultado AGREGADO normal, legível, no fluxo dele.
 */
export interface SubAgentsBlock {
  readonly kind: 'subagents';
  readonly children: readonly SubAgentChild[];
}

/** Erro de broker/rede/auth (◍ <headline>). */
export interface BrokerErrorBlock {
  readonly kind: 'broker-error';
  readonly status?: number;
  readonly message: string;
  /**
   * EST-0942 — TÍTULO classificado do bloco (`◍ <headline>`). "broker indisponível"
   * SÓ quando o broker não respondeu (transporte/down); auth ⇒ "sem credencial" /
   * "credencial recusada"; 402 ⇒ "sem crédito"; 502 do provedor ⇒ "provedor do tier
   * falhou". Ausente (auto-retry/backoff vivo) ⇒ o `<BrokerError>` cai no default
   * "broker indisponível" — o backoff já mostra "tentando de novo" por conta própria.
   */
  readonly headline?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  /**
   * EST-0948 (auto-retry) — segundos restantes até a PRÓXIMA tentativa automática
   * (countdown VISÍVEL do backoff). Presente só enquanto `retrying === true`; some
   * quando a tentativa dispara ou o ciclo esgota. O `<BrokerError>` o mostra como
   * "tentando de novo em Ns".
   */
  readonly retryInSeconds?: number;
  /**
   * EST-0948 (auto-retry) — `true` enquanto o bloco está num backoff ATIVO (o CLI vai
   * retentar sozinho). Marca o bloco como VIVO (re-renderiza a cada segundo do
   * countdown, fora do `<Static>` imutável). `false`/ausente ⇒ erro TERMINAL manual
   * (ciclo esgotado / não-retryable): r/esc decidem, e o bloco migra p/ o scrollback.
   */
  readonly retrying?: boolean;
  /**
   * F52 — backend ativo quando o erro ocorreu. "broker" (default) preserva o
   * comportamento atual; "local" troca o headline default p/ "provider local
   * indisponível" e a palavra "broker" some da mensagem.
   */
  readonly backend?: 'broker' | 'local';
}

/**
 * Nota do SISTEMA — saída de um slash-command (`/help`, `/model`, `/usage`,
 * `/whoami`…). Não é fala do agente nem do usuário: é a TUI respondendo um comando.
 * Renderizada como um bloco `◷` dim com um título e linhas. NUNCA carrega provider
 * (HG-2): `/model` só mostra o tier.
 */
export interface NoteBlock {
  readonly kind: 'note';
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * EST-0970 (ticks AO VIVO) — UMA linha da checklist do `/doctor`: o item aparece
 * `pending` (spinner ⠋ girando) e vira `ok`/`warn`/`fail` quando o check resolve. A
 * `detail`/`fix` chegam junto com o status (vazios enquanto pending). Espelha o
 * `DoctorCheck` da camada pura, + o estado `pending` que só a UI viva conhece.
 */
export interface DoctorCheckLine {
  readonly id: string;
  readonly label: string;
  readonly status: 'pending' | 'ok' | 'warn' | 'fail';
  readonly detail?: string;
  readonly fix?: string;
}

/**
 * EST-0970 (ticks AO VIVO) — bloco do `/doctor` na sessão: uma CHECKLIST PROGRESSIVA.
 * Nasce com TODOS os itens em `pending` (spinner) e cada um "acende" (✓/⚠/✗) quando o
 * probe resolve aquele check — como o `[nome] ✓` do spawn_agent. Bloco VIVO enquanto
 * houver `pending`; quando todos resolvem, fica estável (migra p/ o scrollback). O
 * `summary` (N ok · N aviso · N falha) entra ao fim.
 */
export interface DoctorBlock {
  readonly kind: 'doctor';
  readonly checks: readonly DoctorCheckLine[];
  /** Resumo final (`N ok · N aviso · N falha`) — só quando todos resolveram. */
  readonly summary?: string;
}

/**
 * EST-0982 · ADR-0063 (GS-C5) — confirmação de INJEÇÃO MID-TURN ("btw"): o usuário
 * disse algo ENQUANTO o agente rodava e o loop o INCORPOROU entre iterações. Esta
 * nota leve (`↳ encaixado`) avisa que o input ENTROU no turno vivo (e não foi
 * engolido / adiado p/ o próximo turno). Texto é a fala do usuário (truncável na
 * renderização). É UI/feedback — não vira contexto do modelo (o `user_inject` já
 * está no histórico do loop, à parte deste bloco).
 */
export interface InjectBlock {
  readonly kind: 'inject';
  readonly text: string;
}

/**
 * ADR-0112 · EST-RT-3 — bloco de progresso AO VIVO de `run_tests`.
 * Renderizado IN-PLACE (não no log que rola): barra + placar + falhas.
 * Atualizado a cada `onTestProgress` e coalescido por frame.
 */
export interface TestRunBlock {
  readonly kind: 'testrun';
  /** Placar corrente (snapshot imutável do acumulador). */
  readonly score: TestScore;
  /** Instante (epoch ms) em que a run começou — base do elapsed. */
  readonly startedAt: number;
  /** `true` enquanto a tool `run_tests` está rodando. */
  readonly running: boolean;
}

/** Um bloco renderizável da sessão. */
export type SessionBlock =
  | YouTurn
  | AluyTurn
  | ToolLineBlock
  | DenyBlock
  | BangBlock
  | SubAgentsBlock
  | BrokerErrorBlock
  | NoteBlock
  | DoctorBlock
  | InjectBlock
  | TestRunBlock;

/** Métrica viva da status bar (◷ % do budget, ⛁ % janela). */
export interface SessionMeta {
  readonly branch?: string;
  readonly cwd: string;
  readonly tier: string;
  /**
   * ADR-0120 — BACKEND de modelo EFETIVO desta sessão (`broker`|`local`), resolvido no
   * boot (flag>env>config>default). Só DISPLAY: a StatusBar indica o modo (`◷ broker · …`
   * vs `◷ local · …`). NUNCA credencial/base_url (HG-2/CLI-SEC-7).
   */
  readonly backend?: 'broker' | 'local';
  /**
   * EST-0962 (Custom, ADR-0030 §3) — slug da via Custom, espelhado p/ a StatusBar/
   * Header mostrarem `custom · <slug>`. `undefined` nos tiers canônicos. É um NOME
   * de modelo (público/escolhido pelo usuário), NUNCA credencial/provider (HG-2).
   */
  readonly model?: string;
  /**
   * EST-1015 (#24, pedido do dono) — o MODELO PRINCIPAL que o broker RESOLVEU p/ o
   * tier ativo, lido do `usage.model` (observabilidade pós-resposta — nome PÚBLICO do
   * catálogo, ADR-0030, NUNCA credencial/provider de roteamento; HG-2-safe). Espelhado
   * p/ a StatusBar mostrar `<tier> · <modelo>` mesmo FORA da via Custom (onde `model`
   * fica undefined). Só preenche após a 1ª resposta do broker (antes disso, só o tier).
   * DISTINTO de `model` (slug escolhido pelo usuário na via Custom): este é o que o
   * broker DE FATO usou. Quando ambos existem (Custom), `model` tem prioridade no display.
   */
  readonly activeModel?: string;
  /**
   * EST-0962 (/provider) — NOME do provider do modo Custom (`/provider`), espelhado p/ o
   * seletor marcar o ● ativo / a StatusBar. `undefined` fora de Custom ou quando o broker
   * escolhe o default. É o NOME PÚBLICO do provider (DADO de catálogo), NUNCA credencial/
   * base_url (HG-2/CLI-SEC-7). Só vale em par com `model` (slug Custom).
   */
  readonly provider?: string;
  /**
   * EST-0972 — RÓTULO amigável da sessão (`/rename`), exibido no composer (●+nome) e
   * no /history. `undefined`/'' = sem rótulo (composer não mostra nada — não polui).
   * DADO DE UI (identificador), NUNCA credencial (HG-2). Saneado (trim/teto) na origem.
   */
  readonly label?: string;
  /**
   * EST-0972 — COR de identificação da sessão (NOME de cor da paleta do DS — `ambar`,
   * `verde`…). Resolvida p/ a capacidade do terminal no render (theme.sessionColor).
   * Só faz sentido junto de um `label`. Default determinístico pelo nome; override via
   * `/rename <nome> --cor <cor>`. DADO DE UI — seguro persistir.
   */
  readonly labelColor?: string;
  /** Tokens CRUS acumulados na sessão (detalhe técnico — o display primário é o %). */
  readonly tokens: number;
  /** % da janela de contexto usada (0–100). Dim/amber/red por nível (§4). */
  readonly windowPct: number;
  /**
   * EST-0948 (footer/quota) — a QUOTA do usuário (janelas 5h/semana) que o BROKER
   * reportou no último turno. É BILLING (do broker), distinta do budget LOCAL
   * (`tokens`/`windowPct` acima, anti-runaway). `undefined` enquanto o broker NÃO
   * manda ⇒ o footer de quota NÃO renderiza (degrada/oculto — zero ruído). Acende
   * sozinho quando os headers chegarem. Display puro: o CLI só LÊ (HG-3/HG-4).
   */
  readonly quota?: Quota | undefined;
  /**
   * EST-0948 (server-limits / FU-VAU-003 · ADR-0069) — a dimensão CRÉDITO da conta lida
   * do `usage` do broker (canal que JÁ carrega `balance_after`). É a QUOTA DE PRODUTO do
   * ator CLI/PAT (saldo/consumo pay-per-use, ledger ADR-0038 — hard-cap 402 ao zerar),
   * DISTINTA do fail-safe LOCAL anti-runaway (`tokens`/`budgetPct`, CLI-SEC-8). Por
   * ADR-0069/APR-0074 o footer do CLI mostra CRÉDITO, NÃO a janela 5h+semanal do app
   * (ADR-0051) — essa estoura em minutos sob um loop agêntico (ADR-0053 §4). `undefined`
   * enquanto o broker não informa saldo legível ⇒ o cliente DEGRADA (omite o widget de
   * crédito — ADR-0069 §degradação; o fail-safe local segue intocado). Display puro:
   * o CLI só LÊ (HG-3/HG-4, read-only); CLI-SEC-7: nenhum saldo/markup/ledger hardcoded.
   */
  readonly serverLimits?: ServerLimits | undefined;
  /**
   * EST-0948 — % do TETO DA SESSÃO de tokens já consumido (`tokens/maxTokens`). É o
   * indicador PRIMÁRIO de consumo no `◷` da StatusBar (o número cru de tokens é difícil
   * de visualizar). Aos ~70% ganha um aviso `⚠` ANTES de pausar nos 100% (BUDGET_WARN_PCT).
   * `undefined`/0 quando a sessão não tem teto de tokens (sem % a mostrar).
   */
  readonly budgetPct?: number;
  /**
   * EST-1107 — NOME do workflow ATIVO no modo "use" (display no StatusBar como
   * `⚙ <nome>`). `undefined` = modo normal (sem workflow ativo).
   */
  readonly activeWorkflow?: string;
  /**
   * ADR-0126(A·PR2) — NOME do sub-agente em FOCO 1:1 (`/subagent <nome>`). Setado ⇒ a
   * StatusBar/composer mostram `[foco: <nome>]` e a entrada vai SÓ p/ ele. `undefined` =
   * sessão principal. DADO DE UI (identificador), nunca credencial.
   */
  readonly focus?: string | undefined;
}

/**
 * EST-0982 · ADR-0063 (CONTABILIDADE) — o resumo do TURNO do agente PRINCIPAL
 * (estilo Claude Code: tokens + duração no rodapé). Leitura/display puro (sem efeito
 * novo, sem segredo). `durationMs` é do relógio; `tokens` do budget/broker. `live`
 * enquanto o turno corre; ao terminar, o rodapé mostra o resumo final.
 */
export interface TurnAccountingView {
  readonly tokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
  readonly live: boolean;
}

/** Estado da confirmação pendente (ask) — o que o `<AskDialog>` renderiza. */
export interface PendingAsk {
  readonly request: AskRequest;
}

/**
 * EST-1110 · ADR-0114 — estado da PERGUNTA pendente (`perguntar`) — o que o
 * `<QuestionDialog>` renderiza. NÃO é permissão (sem efeito/categoria): é a pergunta
 * (single/multi/text + "Outro") que o agente fez e aguarda a resposta do usuário.
 */
export interface PendingQuestion {
  readonly spec: QuestionSpec;
}

/** Estado de teto/budget (CLI-SEC-8) — o que o `<BudgetGate>` renderiza. */
export interface PendingBudget {
  readonly reason: string;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly windowPct: number;
  /**
   * EST-0948 — % do TETO DA SESSÃO já consumido (tokens/maxTokens). Pode passar de
   * 100% quando o último turno estoura o teto (o gate mostra "130% do teto"). É o
   * indicador LEGÍVEL que substitui o número cru de tokens (difícil de visualizar).
   */
  readonly budgetPct: number;
  /** EST-0948 — o TETO de tokens da sessão (p/ o texto legível). Ausente ⇒ sem teto. */
  readonly maxTokens?: number;
}

/**
 * ADR-0137 (Fatia 3) — estado do GATE DO TETO do `/cycle` que o `<CycleCeilingGate>`
 * renderiza. O teto DURO (CLI-SEC-14) bateu, mas o JUIZ pediu `continue` — então em
 * vez de parar no silêncio, o `/cycle` PERGUNTA ao humano (`[c] continua · [n] encerra`)
 * exibindo o MOTIVO do juiz. O `reason` é DADO NÃO-CONFIÁVEL: já vem CLAMPADO a 1 linha
 * (C2) e a UI o rotula como "motivo do juiz (local · não verificado)". `c` ⇒ estende
 * EXATAMENTE um teto-worth (C4); `n`/timeout ⇒ ENCERRA (C3 — default seguro).
 */
export interface PendingCycleCeiling {
  /** Qual teto duro bateu (p/ o texto legível do gate). */
  readonly ceilingLabel: string;
  /**
   * O MOTIVO do juiz, JÁ clampado a 1 linha + N chars (C2) e redigido (CLI-SEC-6). DADO
   * não-confiável — a UI o rotula como tal e NUNCA o trata como texto de sistema.
   */
  readonly reason: string;
  /** Confiança do juiz (0..1) — display. */
  readonly confidence: number;
}

/**
 * EST-0969 (watchdog de TRAVAMENTO) — estado da PAUSA-PEDE-DIREÇÃO que o
 * `<StuckGate>` renderiza. O watchdog do loop detectou que o agente gira sem
 * avançar (mesma tool/erro/turno-vazio/sem-progresso); a sessão PAUSA e mostra
 * `[r] redirecionar · [c] continuar · [n] encerrar`, resumindo O QUE travou
 * (DADO, sem texto cru) p/ o usuário decidir com contexto. NÃO é um diálogo de
 * permissão (a catraca segue intocada) — é só uma pausa que vira um pedido de
 * direção acionável.
 */
export interface PendingStuck {
  /** Qual padrão travou (p/ o texto: "repetiu X", "erro Y", "respostas vazias"). */
  readonly kind: 'same-tool-call' | 'same-tool-error' | 'empty-turns' | 'no-progress';
  /** Quantas repetições/voltas estéreis ao disparar (o "4×" do aviso). */
  readonly count: number;
  /** Amostra CURTA e SEGURA do que se repetiu (nome da tool / assinatura do erro). */
  readonly sample: string;
}

/**
 * EST-0973 — descritor do PROGRESSO de uma operação longa, lido pela TUI p/ montar o
 * `<ProgressBar>`. Modo decidido pela presença de `value`+`max`:
 *  - DETERMINADO (ambos): barra + `N%` (ex.: resumir lote `m/M`);
 *  - INDETERMINADO (ausentes): spinner + ELAPSED — `elapsed = Date.now() - startedAt`
 *    é recomputado no render (o tick de 1s faz avançar), então só guardamos o INSTANTE
 *    de início (sem relógio mutável no estado). NÃO inventa % (honesto).
 * Leitura/display — não dispara efeito, não vaza segredo (HG-2: label genérico).
 */
export interface ProgressView {
  /** Verbo/descrição (`compactando a conversa`). Sempre presente (a11y §6). */
  readonly label: string;
  /** Instante (epoch ms) em que a operação começou — base do elapsed do indeterminado. */
  readonly startedAt: number;
  /** DETERMINADO: posição corrente (`m`). Junto de `max` ⇒ barra + %. */
  readonly value?: number | undefined;
  /** DETERMINADO: total (`M`). Veja `value`. */
  readonly max?: number | undefined;
}

/**
 * FATIA 1 (CICLOS/SUBCICLOS) — CACHE DE RENDER do PROGRESSO DO CICLO DE VIDA DO LOOP,
 * exibido PROMINENTE na StatusBar (`↻ ciclo N/M · subciclos K/T`). Torna VISÍVEL a
 * iteração do CycleEngine (CICLO ≡ iteração; `/cycle`=N recorrentes) e as caixas do
 * plano/ContextGraph (SUBCICLO ≡ caixa do `update_plan`). Só DISPLAY/leitura — NÃO muda
 * o comportamento do loop, NÃO carrega segredo. `iteration`/`max` vêm dos `ceilings` +
 * do `i` do `onCycleStart`; `subcyclesDone`/`subcyclesTotal` das caixas do
 * ContextGraph (fechadas/total). O controller LIMPA (`undefined`) quando o ciclo acaba
 * (cycleActive=false). Ausente ⇒ a barra NÃO mostra o indicador cíclico (uso simples).
 */
export interface CycleProgress {
  /** Iteração CORRENTE do CycleEngine (1-based no display; o `onCycleStart(i)` é 0-based). */
  readonly iteration: number;
  /** Nº MÁX de ciclos (de `ceilings.maxIterations`). */
  readonly max: number;
  /** Caixas do plano CONCLUÍDAS (closed) no ContextGraph. */
  readonly subcyclesDone: number;
  /** Total de caixas do plano no ContextGraph (0 ⇒ sem subciclos a mostrar). */
  readonly subcyclesTotal: number;
}

/** LOTE-2 — contagens da governança `.aluy/` carregada (StatusBar + `/stat`). */
export interface GovernanceCounts {
  readonly agents: number;
  readonly commands: number;
  readonly skills: number;
  readonly workflows: number;
  readonly memory: number;
}

/** O estado COMPLETO da sessão que a TUI renderiza. */
export interface SessionState {
  readonly blocks: readonly SessionBlock[];
  readonly meta: SessionMeta;
  // `boot`: splash inicial (◇ wordmark) ANTES do composer. Some na 1ª interação
  // (tecla/objetivo) ou após um curto timer — nunca ocupa a tela durante o trabalho.
  // `thinking`: pré-1º-token (§2.4) — o `<Working>` âmbar enche o "vácuo" entre o
  // submit e o 1º delta do modelo (eixo 2). Vira `streaming` quando o token chega.
  // `retrying`: EST-0948 (auto-retry) — uma falha RETRYABLE do broker está em backoff
  // automático ANTES de cair no `error` manual. A região viva mostra o bloco
  // `broker-error` com o countdown (`tentando de novo em Ns · N/M`); esc/Ctrl-C
  // cancelam o backoff (parável). Esgotado o ciclo (ou erro não-retryable) ⇒ `error`.
  // `stuck`: EST-0969 (watchdog) — o agente está girando sem avançar; a sessão
  // PAUSOU e PEDE DIREÇÃO (`[r] redirecionar · [c] continuar · [n] encerrar`). O
  // turno NÃO morreu nem continuou em silêncio — espera a decisão do usuário.
  // `compacting`: EST-0973 — uma operação LONGA com feedback de progresso está em
  // curso (a 1ª é COMPACTAR a conversa via broker). A região viva mostra o
  // `<ProgressBar>` (det/indet, ver `progress`) enquanto roda; some ao concluir
  // (vira `done`/`idle`/`thinking`) ou ao cancelar/falhar (nota honesta).
  // `questioning`: EST-1110 — o agente fez uma PERGUNTA (`perguntar`) e ESPERA a
  // resposta do usuário (single/multi/text + "Outro"). A região viva mostra o
  // `<QuestionDialog>`; some ao responder (volta a `streaming`) ou cancelar.
  readonly phase:
    | 'boot'
    | 'idle'
    | 'thinking'
    | 'streaming'
    | 'asking'
    | 'questioning'
    | 'budget'
    // ADR-0137 (Fatia 3) — o teto DURO do `/cycle` bateu E o juiz pediu `continue`: a
    // sessão PAUSA e PERGUNTA ao humano (`[c] continua · [n] encerra`) com o motivo do
    // juiz. `n`/timeout = encerrar (default seguro). Some ao decidir.
    | 'cycle-ceiling'
    | 'stuck'
    | 'retrying'
    | 'compacting'
    | 'error'
    | 'done';
  /**
   * Rótulo vivo da fase `thinking` (§2.4) ou de uma tool in-flight — o que o
   * `<Working>` mostra (`pensando`, `rodando npm test`). Em `thinking` é
   * `pensando`; some quando o stream começa.
   */
  readonly workingLabel?: string | undefined;
  // `| undefined` explícito (exactOptionalPropertyTypes): o controlador LIMPA
  // estes campos com `undefined` ao resolver o ask/budget — então o tipo precisa
  // admitir a ausência por atribuição, não só por omissão da chave.
  readonly pendingAsk?: PendingAsk | undefined;
  /**
   * EST-1110 · ADR-0114 — a PERGUNTA pendente (`perguntar`), `undefined` fora dela. O
   * controller a seta quando o resolver de pergunta publica e a limpa ao resolver
   * (resposta/cancelamento). Mesma mecânica de campo `| undefined` do `pendingAsk`.
   */
  readonly pendingQuestion?: PendingQuestion | undefined;
  readonly pendingBudget?: PendingBudget | undefined;
  /**
   * ADR-0137 (Fatia 3) — o GATE DO TETO pendente (`undefined` fora dele). O controller o
   * seta quando o teto duro do `/cycle` bate E o juiz pediu `continue`, e o limpa ao
   * decidir (`c`/`n`/timeout). Mesma mecânica de campo `| undefined` do `pendingBudget`.
   */
  readonly pendingCycleCeiling?: PendingCycleCeiling | undefined;
  /**
   * EST-0969 (watchdog) — a pausa-pede-direção pendente (`undefined` fora dela). O
   * controller a seta quando o watchdog do loop dispara e a limpa ao resolver
   * ([r]/[c]/[n]). Mesma mecânica de campo `| undefined` do `pendingBudget`.
   */
  readonly pendingStuck?: PendingStuck | undefined;
  /**
   * EST-0982 · ADR-0063 — contabilidade do TURNO do agente principal (tokens +
   * tempo), exibida no rodapé estilo Claude Code. `undefined` antes do 1º turno.
   * Leitura/display — não dispara efeito, não vaza segredo.
   */
  readonly turnAccounting?: TurnAccountingView | undefined;
  /**
   * EST-0959 · ADR-0055 — o MODO de sessão corrente (`plan | normal | unsafe`),
   * espelhado da engine de permissão. A TUI mostra o indicador de modo (glifo +
   * palavra, a11y) a partir DESTE campo, e o Tab o cicla. Default `normal`.
   */
  readonly mode: SessionMode;
  /**
   * EST-1015 · ADR-0072 §3b (decisão do dono, opção (c)) — `true` enquanto a CONFIRMAÇÃO de
   * entrada em `unsafe` (YOLO, catraca off) por Tab está PENDENTE. O `cycleMode` seta isto
   * em vez de trocar direto; a TUI mostra um prompt `[s/N]` e o usuário confirma
   * (`confirmUnsafe`) ou cancela (`cancelUnsafe`). Espelha a confirmação que o `--yolo` já
   * exige no boot — o Tab não a contornava antes (gap AG-0008). `undefined`/false fora dela.
   */
  readonly pendingUnsafeConfirm?: boolean | undefined;
  /**
   * EST-0981 · CLI-SEC-14 (guarda anti-colisão) — `true` enquanto UM `/cycle` está
   * ATIVO (do início ao fim/abort/erro). Espelho do flag do controller, p/ a TUI:
   * (a) a fila do type-ahead NÃO dispara no vão entre ciclos (`queueAtRest`); (b) a
   * UI pode indicar o ciclo vivo. Ausente/`false` = sem ciclo.
   */
  readonly cycleActive?: boolean | undefined;
  /**
   * FATIA 1 (CICLOS/SUBCICLOS) — CACHE DE RENDER do progresso do ciclo de vida do loop
   * (iteração N/M do CycleEngine + subciclos K/T das caixas do plano). A StatusBar mostra
   * `↻ ciclo N/M · subciclos K/T` PROMINENTE (accent) quando definido. O controller o
   * popula no início do `/cycle` e em cada `onCycleStart`, e o LIMPA (`undefined`) quando
   * o ciclo acaba (cycleActive=false). Ausente ⇒ uso simples (sem indicador cíclico).
   */
  readonly cycleProgress?: CycleProgress | undefined;
  /**
   * DETACH-FIX (item 4) — quantos sub-agentes DESACOPLADOS (sobreviventes de um esc)
   * seguem rodando em SEGUNDO PLANO. > 0 ⇒ a TUI mostra um aviso persistente ("N em
   * segundo plano — F8 para parar"): com o teto de relógio em "nunca" (decisão do dono),
   * F8 é o único stop, então o dono PRECISA ver que há trabalho órfão vivo. 0/ausente = nada.
   */
  readonly detachedSubagents?: number | undefined;
  /**
   * LOTE-2 (governança .aluy/) — CONTAGENS do que foi CARREGADO da `.aluy/` (+ `~/.aluy/`
   * global) no boot: agentes, comandos, skills, workflows e itens de memória de projeto. A
   * TUI mostra `⌁ Na·Cc·Ss·Ww·Mm` na StatusBar p/ o dono VER que a governança foi carregada
   * (decisão do dono: "mostrar quantos agentes/workflows/… estão carregados"). `/stat` detalha.
   * Ausente = ainda não computado (boot) ou nada carregado.
   */
  readonly governance?: GovernanceCounts | undefined;
  /**
   * EST-1106 — UM `/workflows run` está ATIVO (espelha `cycleActive`). Usado pela
   * TUI p/ segurar a fila do type-ahead (`queueAtRest`).
   */
  readonly workflowActive?: boolean | undefined;
  /**
   * EST-1107 — NOME do workflow ATIVO no modo "use" (exibido no StatusBar como
   * `⚙ <nome>`). `undefined` = modo normal (sem workflow ativo).
   */
  readonly activeWorkflow?: string | undefined;
  /**
   * EST-0973 — progresso da operação longa corrente (fase `compacting`). `undefined`
   * fora dela. O controller o seta ao iniciar (ex.: `/compact`) e o LIMPA ao concluir/
   * cancelar/falhar — a TUI renderiza o `<ProgressBar>` só quando definido.
   */
  readonly progress?: ProgressView | undefined;
  /**
   * EST-0982 (mid-turn UX) — ECOS REDIGIDOS dos inputs de texto puro INJETADOS num
   * turno VIVO (`injectInput('root', …)` → fila viva `liveInjected`) que AINDA não
   * foram drenados/incorporados pelo loop. É o "encaixando…" VISÍVEL entre o Enter e
   * a próxima iteração do loop — sem isto a mensagem some até o loop confirmar (a nota
   * "↳ encaixado", `InjectBlock`). FIFO, na MESMA ordem da fila viva. Esvazia conforme
   * o loop incorpora (`flushInjectNotes` remove o item drenado) e no fim/abort do turno
   * (não pode ghostar um indicador após o turno). CLI-SEC-6: SEMPRE o eco redigido
   * (`digestOf`, clamp 120) — NUNCA texto cru/segredo. Distinto de `<QueuedInputs>` (a
   * fila de SUBMIT do type-ahead, ainda viva, p/ slash/bang/anexo).
   */
  readonly pendingInjects: readonly string[];
  /**
   * `/ask` em VOO — perguntas do canal lateral (read-only, paralelo) ainda SEM resposta.
   * Renderizadas numa área SEPARADA da fila do agente principal (a fila é só pedido sem `/ask`).
   * Some quando a resposta chega (vira nota `↗ /ask:`). `{id, question}` (head redigido/curto).
   */
  readonly pendingAsks: readonly { readonly id: string; readonly question: string }[];
}

/**
 * EST-0981/0982 · CLI-SEC-14 — a fila do type-ahead só auto-submete em REPOUSO
 * REAL: fase `idle`/`done` E SEM ciclo ativo. O vão ENTRE ciclos de um `/cycle`
 * NÃO é repouso (a fase pode repousar por um instante, mas `cycleActive` segura a
 * fila) — disparar ali criaria um turno CONCORRENTE ao ciclo (gasto dobrado,
 * blocos intercalados). A fila re-tenta quando o ciclo TERMINA de verdade (o
 * controller limpa `cycleActive` no fim/abort/erro ⇒ o estado re-publica ⇒ o
 * efeito da fila re-roda). Pura/determinística (testável sem Ink).
 *
 * EST-0982 (P1-2) — `anyPickerOpen` (opcional) também SEGURA a fila: abrir um picker
 * (`/model`/`/theme`/`/history`/`/provider`/`/lang`/`/permissions`/`@file`/palette) NÃO
 * muda a fase (segue idle/done), então sem este sinal o drain iniciaria um turno SOB o
 * overlay ou EMPILHARIA um 2º picker. Modais são foco exclusivo: a fila PAUSA enquanto
 * há um aberto e RE-TENTA quando ele fecha (o estado re-publica ⇒ o efeito re-roda).
 * Omitido/`false` = comportamento de antes (compat com chamadas e testes existentes).
 */
export function queueAtRest(
  state: Pick<SessionState, 'phase' | 'cycleActive' | 'workflowActive'> & {
    readonly anyPickerOpen?: boolean;
  },
): boolean {
  return (
    (state.phase === 'idle' || state.phase === 'done') &&
    state.cycleActive !== true &&
    state.workflowActive !== true &&
    state.anyPickerOpen !== true
  );
}

/**
 * Verbo no GERÚNDIO p/ o in-flight (§2.6/§8): `rodando`, `lendo`, `editando`,
 * `buscando`. Mapeia o NOME da tool (não o verbo curto) p/ o gerúndio PT-BR. Tool
 * desconhecida cai num gerúndio genérico (`processando`).
 */
export function gerundOf(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return 'lendo';
    case 'edit_file':
      return 'editando';
    case 'run_command':
      return 'rodando';
    case 'grep':
      return 'buscando';
    default:
      return 'processando';
  }
}

/**
 * Teto de caracteres do ALVO de uma linha de tool (`⏺ bash <alvo>`). 1 linha de
 * terminal comum; acima disso o alvo deixa de identificar e passa a inundar.
 */
export const MAX_TARGET_CHARS = 100;

/**
 * Clampa o ALVO de uma linha de tool (`⏺`/`◌`) a UMA linha curta. Um batch/heredoc
 * de 100+ linhas passado como `command` NÃO pode virar o "alvo" — o transcript vira
 * um despejo (o alvo existe p/ IDENTIFICAR a ação, não p/ reproduzi-la; a saída/erro
 * têm canal próprio, já janelado). Multi-linha ⇒ 1ª linha não-vazia + `… (+N linhas)`;
 * linha longa ⇒ corte em `MAX_TARGET_CHARS` + `…`. Pura/determinística (testável sem Ink).
 */
export function clampTarget(target: string, maxChars: number = MAX_TARGET_CHARS): string {
  const lines = target.split('\n');
  // 1ª linha NÃO-VAZIA identifica melhor (um heredoc pode começar com quebra).
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx < 0) return '';
  const extra = lines.length - 1 - firstIdx;
  let head = lines[firstIdx] ?? '';
  if (head.length > maxChars) head = `${head.slice(0, maxChars - 1)}…`;
  return extra > 0 ? `${head} … (+${extra} ${extra === 1 ? 'linha' : 'linhas'})` : head;
}

/** Abrevia uma contagem de tokens p/ a status bar (`12.4k`, `1.2M`). */
export function abbreviateCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * EST-0982 · ADR-0063 — formata uma DURAÇÃO em ms p/ exibição (estilo Claude Code):
 * `0.4s`, `2.1s`, `1m3s`, `12m`. Sub-segundo arredonda a 1 casa; ≥1min usa `m`+`s`.
 * Determinístico, puro. Negativo/NaN ⇒ `0s` (fail-safe — nunca lança).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    // <1min: 1 casa decimal, sem `.0` redundante (`2s`, `2.1s`).
    return `${totalSec.toFixed(1).replace(/\.0$/, '')}s`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  return sec === 0 ? `${min}m` : `${min}m${sec}s`;
}

/**
 * EST-0965 — formata o ELAPSED do turno em `M:SS` (estilo cronômetro: `0:12`, `1:05`,
 * `12:30`), p/ o indicador de ATIVIDADE "esc interromper · 0:12" enquanto ocupado.
 * Distinto de `formatDuration` (`12.4s`, p/ o rodapé de contabilidade FINAL): aqui o
 * número AVANÇA 1×/seg e precisa de leitura estável (sem casa decimal pulando). Trunca
 * os segundos (não arredonda — o relógio nunca "pula" 1s à frente do real). Negativo/
 * NaN ⇒ `0:00` (fail-safe — nunca lança). Horas viram minutos acumulados (`75:00`).
 */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/** Abrevia o cwd (`~/proj/aluy-app`, `…/aluy-app` em telas estreitas). */
export function abbreviateCwd(cwd: string, home = process.env.HOME ?? ''): string {
  if (!home) return cwd;
  // EST-1015 (fix borda, irmã do #332 relCwd) — `startsWith(home)` CRU casa um IRMÃO
  // prefixo-STRING: com `home=/home/user`, um `/home/user-backup/p` "casava" e virava
  // o `~-backup/p` ENGANOSO. `~` só quando cwd É o home OU está SOB ele (borda de
  // separador). Cobre `/` e `\` (POSIX/Windows). Fora do home ⇒ caminho absoluto.
  if (cwd === home) return '~';
  if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}
