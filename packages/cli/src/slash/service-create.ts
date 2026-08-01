// ADR-0158 §10 — `create` CONVERSACIONAL: o dono DESCREVE o serviço em prosa; o
// agente ENTREVISTA o que faltar e ESCREVE o diretório completo do serviço para
// revisão — PARADO (criar não é ligar; a sequência é create → revisar → install →
// start). Mesmo padrão do `/init` (`slash/init.ts`, EST-INIT-02, "PROMPT-DRIVEN"):
// um PROMPT-GUIA que vira o GOAL de um turno normal da sessão — o agente escreve
// pelas tools normais (`write_file`), que passam pela CATRACA como qualquer
// escrita (ZERO atalho privilegiado). Nada aqui entra no SYSTEM PROMPT da sessão
// (teto de 25.000 chars) — é conteúdo de COMANDO, só expandido quando `/service
// create`/`aluy service create` é invocado (mesmo mecanismo do `/init`, confirmado
// em `session/run.tsx`: `buildScaffoldSystemPrompt(desc)` → `controller.submit(goal)`).
//
// DECISÃO 1 (POR QUE STAGING, NUNCA `~/.aluy/services/` direto) — a categoria
// `always-ask:aluy-config-write-deny` (`cli-core/permission/categories.ts`,
// `looksLikeAluyJournal`) já NEGA — fail-closed, ACIMA do `--unsafe`, só cai no
// YOLO — qualquer escrita do agente sob `~/.aluy/`. Não é uma trava nova para o
// `create`: é a catraca EXISTENTE fazendo exatamente o que o próprio ADR-0158 §8.5
// documenta ("a categoria… existe precisamente para que o agente não reescreva a
// própria configuração em ~/.aluy/"). Abrir uma exceção aqui furaria a fronteira
// mais sensível do aluy — a missão desta fase é explícita: "NUNCA a relaxe". A
// saída escolhida é MELHOR que um contorno: o `create` escreve em STAGING
// (`aluy-services-drafts/<nome>/`, RELATIVO à raiz do workspace — dentro do
// confinamento normal do `write_file`, sem nem precisar do "ask" de
// outside-workspace) e o dono roda `aluy service install <path>` depois — que já
// MOSTRA o manifesto visível (§9) e PEDE confirmação antes de copiar para
// `~/.aluy/services/`. Resultado: revisão explícita EM DOBRO (o diff de cada
// arquivo durante o `create`, o manifesto visível no `install`) — mais seguro do
// que se a catraca permitisse escrita direta no destino final.
//
// DECISÃO 2 (shell `aluy service create` NÃO abre sessão via-agente) — ao
// contrário do `aluy bootstrap --agent` (que delega a um turno headless porque
// instalar pacotes é uma tarefa DETERMINÍSTICA, sem pergunta de julgamento pro
// dono responder), o `create` é uma ENTREVISTA de verdade (schedule? canal? existe
// funil de risco — N estudos e 1 decisor? tetos duros?) — e um turno headless de
// UM TIRO (`aluy -p`) não tem CANAL para essa ida-e-volta: sem TTY, sem Telegram
// configurado ainda (o serviço nem existe), a tool `perguntar` cairia no fail-safe
// `unavailable` (ADR-0114/ADR-0157) e o agente teria que ADIVINHAR o resto — o
// oposto do que o ADR pede ("o agente entrevista o que faltar"). Por isso
// `aluy service create` no shell ORIENTA para o canal PRINCIPAL (`/service create`
// DENTRO da sessão, ADR-0158 §10, emenda de aprovação do dono) — mesmo padrão que
// `/service install`/`uninstall` já usam hoje (fase 1/2, `commands/service.ts`),
// só INVERTIDO: lá é a sessão que aponta pro shell; aqui é o shell que aponta pra
// sessão, porque a ENTREVISTA só faz sentido onde há conversa de verdade.

/** Nome do subdiretório de STAGING (relativo à raiz do workspace) onde o `create`
 * escreve os rascunhos de serviço — NUNCA em `~/.aluy/services/` (Decisão 1
 * acima). Deliberadamente SEM o prefixo `.aluy` (evita qualquer ambiguidade visual
 * com a config real, e fica fora do alcance do matcher `looksLikeAluyJournal`,
 * que só reconhece o diretório `.aluy` — aqui nem precisaria, já que o staging
 * fica DENTRO do workspace, mas o nome também não tenta parecer o que não é). */
export const SERVICE_DRAFTS_DIRNAME = 'aluy-services-drafts';

/**
 * Monta o PROMPT-GUIA que vira o `goal` do turno de criação conversacional
 * (ADR-0158 §10). PURA (sem I/O) — mesma forma de `buildScaffoldSystemPrompt`
 * (`slash/init.ts`): embute o FORMATO de cada arquivo do diretório-serviço
 * (§1), a doutrina de funil (§4 — `tools:` por persona), a separação
 * regra-de-julgamento × regra-dura (§3), e a trava CRIAR NÃO É LIGAR (§10) — e
 * termina pedindo ao agente que ENTREVISTE antes de escrever o que a descrição
 * não cobrir.
 */
export function buildServiceCreateSystemPrompt(descricao: string): string {
  const desc = descricao.trim();
  return [
    'Você é um especialista em SERVIÇOS plugáveis do aluy (ADR-0158). Sua tarefa é',
    'conduzir a criação CONVERSACIONAL de um serviço a partir da descrição do dono',
    'abaixo: ENTREVISTAR o que faltar e depois ESCREVER o diretório completo do',
    'serviço — para REVISÃO, não para ligar (ver "CRIAR NÃO É LIGAR" no final).',
    '',
    '## Primeiro passo: ENTREVISTE o que faltar',
    '',
    'A descrição do dono raramente cobre tudo. ANTES de escrever qualquer arquivo,',
    'confira se você sabe (use a tool `perguntar` para o que faltar — não invente):',
    '  - Nome curto do serviço (vira o nome do diretório — minúsculas, `[a-z0-9_-]`).',
    '  - `schedule:` (expressão cron — "quando o serviço acorda") e `until:` (fim do',
    '    expediente, `HH:MM`) — sem os dois o runner não sabe operar (ADR-0158 §5).',
    '  - `channel:` — para onde reporta e pergunta (ex.: `telegram:<chat-id>`). Sem',
    '    canal, um `autonomy: ask` fica sem onde perguntar.',
    '  - `autonomy:` — a v1 do aluy SÓ aceita `ask` (qualquer outro valor é rejeitado',
    '    pelo parser). Não ofereça outra opção.',
    '  - Tetos DUROS (circuit breakers) e tunáveis com FAIXA — números que o runner',
    '    ENFORÇA em código (ex.: `perda-maxima-dia: 500`, `tamanho-posicao: 2 [1..5]`).',
    '  - HÁ um funil de decisão? (a marca registrada do ADR-0158: "N estudos, nenhum',
    '    dispara sozinho — tudo passa por um decisor de risco"). Se sim: quantos',
    '    agentes de estudo/análise, e qual é o único agente EXECUTOR?',
    '  - Existem SCRIPTS/skills que o dono vai trazer (ex.: uma integração com uma',
    '    corretora, uma API própria)? Você só cria o ESQUELETO — o código é dele.',
    '',
    'Pergunte objetivamente (uma rodada é suficiente na maioria dos casos — não',
    'interrogue o dono por mais do que o necessário). Só depois de ter o essencial,',
    'passe a escrever.',
    '',
    '## Onde escrever — STAGING, NUNCA `~/.aluy/services/`',
    '',
    `Escreva TUDO dentro de \`${SERVICE_DRAFTS_DIRNAME}/<nome>/\` (relativo à raiz do`,
    'workspace atual) — NUNCA em `~/.aluy/services/<nome>/` diretamente. Isto não é',
    'uma escolha de estilo: a catraca de segurança do aluy NEGA, por design,',
    'qualquer escrita sob `~/.aluy/` feita pelo agente (categoria',
    '`aluy-config-write-deny` — o mesmo freio que impede o agente de reescrever a',
    'própria config de confiança). Não tente contornar, driblar ou pedir para o',
    'dono relaxar isso — é intencional. Depois de escrito e revisado, o PRÓPRIO',
    `DONO roda \`aluy service install ${SERVICE_DRAFTS_DIRNAME}/<nome>\` para copiar`,
    'para o lugar de verdade (o `install` mostra o manifesto visível e pede',
    'confirmação — ADR-0158 §9).',
    '',
    '## O que criar (formato EXATO — ADR-0158 §1)',
    '',
    '1. **`service.md`** (na raiz do diretório do serviço) — frontmatter chave-valor',
    '   plano (CONTRATO DURO, o que o runner enforça em código) + corpo em prosa (o',
    '   ORQUESTRADOR — "rege, não opera"). Formato:',
    '   ```',
    '   ---',
    '   name: <nome>',
    '   description: <1 frase>',
    '   schedule: "<cron expr>"     # ex.: "0 9 * * 1-5" — quando o serviço acorda',
    '   until: "HH:MM"              # fim do expediente — ENFORÇADO pelo runner',
    '   workflow: turno             # aponta para workflows/turno.md deste serviço',
    '   channel: <conector>:<alvo>  # ex.: telegram:123456',
    '   budget: <N>k/turno          # teto de tokens por turno',
    '   autonomy: ask               # a v1 só aceita "ask"',
    '   <tunável-ou-teto>: <número> [min..max]?  # com faixa = tunável; sem = duro',
    '   ---',
    '   Você rege, não opera. [Persona do orquestrador: como abre o turno, como',
    '   despacha as atividades do workflow, como avalia o que o time traz, quando',
    '   escala pelo canal em vez de improvisar execução — SEM ferramentas de',
    '   execução do domínio, essas são só do agente executor.]',
    '   ```',
    '',
    '2. **`agents/*.md`** — UM arquivo por persona do time (mesmo formato de',
    '   `.aluy/agents/*.md`: frontmatter `name`/`description`/`tools`/`model`',
    '   opcional + corpo = system prompt da persona). **TOPOLOGIA DE FUNIL (ADR-0158',
    '   §4), quando houver decisor de risco/execução:**',
    '   - As personas de ESTUDO/ANÁLISE (`estudo-*.md`) NÃO levam a(s) skill(s) de',
    '     execução no `tools:` — elas só OBSERVAM e relatam. A ferramenta perigosa',
    '     simplesmente não existe no mundo delas.',
    '   - SÓ o agente DECISOR (ex. `risco.md`) declara `tools:` incluindo a skill de',
    '     execução. É a ÚNICA persona que pode agir de verdade.',
    '   - Isto é estrutural, não uma instrução de prompt — mesmo que uma persona de',
    '     estudo seja convencida/injetada a "mandar executar", ela não TEM a',
    '     ferramenta. Não pule este ponto: é o núcleo do pedido do dono no ADR-0158.',
    '',
    '3. **`workflows/turno.md`** — a rotina do turno principal (mesmo formato de',
    '   `.aluy/workflows/*.md`): frontmatter `name`/`description` + atividades',
    '   numeradas `N. id [agente] — objetivo`. `[agente]` é OPCIONAL — atividades',
    '   sem agente rodam como o ORQUESTRADOR (o corpo do `service.md`). A ÚLTIMA',
    '   atividade do turno deve ser o FECHAMENTO/reporte (ADR-0158 §8.2 — "um turno',
    '   que não reportou é um workflow que não terminou"). Se o dono descreveu uma',
    '   ROTINA de revisão periódica (retro), crie também `workflows/retro.md` com um',
    '   `schedule:` PRÓPRIO no frontmatter dele (ex.: sexta 18h — ADR-0158 §8.4).',
    '',
    '4. **`rules.md`** (opcional) — regras de JULGAMENTO em prosa (ex.: "prefira',
    '   sair antes de payroll"). ATENÇÃO à doutrina do ADR-0158 §3: se algo que o',
    '   dono descreveu é na verdade uma REGRA DURA (limite de horário, teto',
    '   numérico) NÃO a escreva aqui como prosa — ela pertence ao FRONTMATTER do',
    '   `service.md` (`schedule`/`until`/`budget`/tunável com teto), onde o CÓDIGO a',
    '   enforça. Regra dura nunca é prompt.',
    '',
    '5. **`skills/<nome>/SKILL.md`** — só o ESQUELETO (frontmatter mínimo + o que a',
    '   skill deveria fazer em prosa) para cada script que o dono mencionou — NÃO',
    '   escreva o script de verdade (é código PRÓPRIO dele, "desenvolvido fora e',
    '   plugado depois", ADR-0158 §1/§6). Se a skill tem teto de execução (ex.: "no',
    '   máximo N contratos"), documente no `SKILL.md` que o teto vive DENTRO do',
    '   script (§4.3) — não como algo que o modelo decide.',
    '',
    '6. **`commands/`, `mcp.json`, `daemons/`** — só crie o que a descrição do dono',
    '   claramente pedir (ex.: um `daemons/<nome>/daemon.md` se ele mencionou um',
    '   processo próprio tipo bridge/position-guard). Não infle o diretório com',
    '   pastas vazias por completude.',
    '',
    '## Regras de escrita',
    '',
    '- Escreva CADA arquivo com a ferramenta `write_file` (que passa pela catraca',
    '  normal — o dono pode ver/aprovar cada escrita, dependendo do modo da sessão).',
    `- Caminhos RELATIVOS à raiz do workspace: \`${SERVICE_DRAFTS_DIRNAME}/<nome>/service.md\`,`,
    `  \`${SERVICE_DRAFTS_DIRNAME}/<nome>/agents/<persona>.md\`, etc.`,
    '- NÃO crie diretórios explicitamente — o `write_file` já os cria.',
    '- Seja FIEL ao que o dono descreveu — não invente escopo/risco que ele não',
    '  pediu (ex.: não adicione autonomia além de `ask`, não invente um canal).',
    '',
    '## CRIAR NÃO É LIGAR (ADR-0158 §10 — não pule este final)',
    '',
    'Depois de escrever todos os arquivos, feche o turno com um RESUMO claro:',
    '  - o que foi criado (lista de arquivos) e por quê;',
    '  - que o diretório está PARADO — nada roda ainda;',
    '  - os PRÓXIMOS PASSOS explícitos, nesta ordem: (1) o dono REVISA os arquivos;',
    `    (2) \`aluy service install ${SERVICE_DRAFTS_DIRNAME}/<nome>\` — copia para`,
    '    `~/.aluy/services/` mostrando o manifesto visível e pedindo confirmação;',
    '    (3) só então `aluy service start <nome>` (ou `/service start <nome>`) —',
    '    a chave de ignição é SEMPRE um ato explícito do dono, mesmo para um',
    '    serviço que você acabou de escrever.',
    '',
    '## Descrição do serviço (o dono)',
    '',
    desc,
    '',
  ].join('\n');
}
