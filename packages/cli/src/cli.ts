import { CORE_VERSION, type SessionMode } from '@hiperplano/aluy-cli-core';
import { CLI_VERSION } from './version.js';

// Parser fino do binário `aluy`. Resolve --version/--help, os subcomandos de
// auth (login/logout/whoami — EST-0942) e a TUI default. O loop de agente
// (EST-0944), broker (EST-0943) e a TUI rica (EST-0948) chegam adiante.
// Mantido PURO (sem I/O) para ser testável; o binário (bin/aluy.ts) faz o I/O.

export type CliAction =
  | { kind: 'version'; text: string }
  | { kind: 'help'; text: string }
  // EST-0962 (`--provider`) — ERRO DE USO de flag (combinação inválida na largada, ex.:
  // `--provider` SEM `--model`). O binário imprime `message` no stderr e sai com `exitCode`
  // (≠0) SEM montar a sessão (não puxa broker/MCP) — "$? confiável" p/ script.
  | { kind: 'usage-error'; message: string; exitCode: number }
  // ADR-0120 / EST-1113/1114 — `aluy login [--provider <p>] [--oauth]`:
  //  · sem `--provider` ⇒ login do BROKER (device-flow/PAT, comportamento de hoje).
  //  · com `--provider <p>` ⇒ login do BACKEND LOCAL (BYO): grava a API KEY do
  //    provider no keychain (lê de `--token`/stdin), OU faz OAuth-PKCE com `--oauth`.
  | {
      kind: 'login';
      token?: string;
      org?: string;
      forceDeviceFlow: boolean;
      provider?: string;
      oauth?: boolean;
    }
  | { kind: 'logout' }
  | { kind: 'whoami' }
  // EST-0970 — `aluy doctor`: health-check read-only com VALIDAÇÃO ATIVA (credencial via
  // GET, MCP conecta de verdade, valores de config). Exit≠0 se houver ✗ (útil em script/
  // CI). `--deep`/`--test` ADICIONA o teste do tier ao vivo (gasta 1 chamada ao modelo).
  // `--json` imprime o resultado como JSON.stringify de um array {id,status,label,detail}.
  | { kind: 'doctor'; deep: boolean; json: boolean }
  // `aluy config` — visão consolidada read-only da config efetiva (valor + origem).
  | { kind: 'config'; json: boolean }
  // EST-0977 · ADR-0061 — `aluy agents`: lista os perfis de sub-agente .md MAPEADOS
  // (válidos + rejeitados c/ motivo RES-MD-3) das DUAS camadas (global + projeto/cwd).
  // Read-only, sem modelo, sem rede; reusa os MESMOS loaders do boot. Exit 0 (listagem).
  | { kind: 'agents' }
  // EST-1112 · ADR-0116 — `aluy skills`: lista as SKILLS (SKILL.md) mapeadas (global +
  // projeto/cwd), válidas + rejeitadas (RES-MD-3). Read-only, sem modelo. Exit 0.
  | { kind: 'skills' }
  // EST-1105 — `aluy workflows`: lista os fluxos de atividade .md mapeados (global +
  // projeto/cwd), válidos + rejeitados (RES-MD-3). Read-only, sem modelo. Exit 0.
  | { kind: 'workflows' }
  // EST-1133 / ADR-0130 — `aluy bootstrap`: provisionamento EXPLÍCITO de sidecars user-space.
  // Só sob perfil TURBO (default); LEVE sai sem provisionar. Passo EXPLÍCITO
  // (nunca download no boot — CA-G2-11). Read-only quanto ao modelo; faz I/O
  // de instalação (download/venv).
  // EST-1133-bis — `--agent` HABILITA a DELEGAÇÃO ao agente quando o SO não tem
  // artefato pinado (não-Linux): em vez de baixar o tarball Linux, o aluy instala
  // via o próprio agente (⚠ usa --yolo). Consentimento EXPLÍCITO via flag. Sem a
  // flag em SO não-Linux ⇒ instrui em vez de tentar baixar errado.
  | { kind: 'bootstrap'; agent: boolean }
  // `aluy uninstall [--agent]`: remove os complementos (sidecars). Determinístico nos venvs
  // de ~/.aluy; `--agent` remove o ollama de SISTEMA (curl/sudo) via o próprio agente.
  | { kind: 'uninstall'; agent: boolean }
  // `aluy onboard` — o instalador/onboarding interativo (Node + Ink) p/ onde o
  // bootstrap mínimo entrega: splash + idioma + backend + provider(+custom) + chave
  // + modelo + sidecars. Substitui o setup em script (porco/encoding/sem i18n).
  | { kind: 'onboard' }
  // EST-1116 — `aluy models`/`aluy providers`: lista os providers/modelos DISPONÍVEIS —
  // seção LOCAL (BYO: anthropic/openai/openrouter + auth + default) + seção BROKER (tiers/
  // providers/custom do catálogo VIVO, FAIL-SOFT). Read-only, exit 0 (listagem). `--json`
  // p/ script; `--backend local|broker` foca uma seção. `which` distingue models|providers.
  | {
      kind: 'models';
      scope: 'local' | 'broker' | 'both';
      json: boolean;
      which: 'models' | 'providers';
    }
  // ADR-0134/0135 — `aluy telegram <sub>`: gestão do conector Telegram (login=token no
  // keychain; allow/deny=allowlist de chat-ids no config; status). Sem rede nesta fatia.
  | {
      kind: 'telegram';
      sub: 'login' | 'logout' | 'allow' | 'deny' | 'status';
      token?: string;
      chatId?: number;
    }
  // EST-0970 (search) — `aluy mcp search <query>`: busca no REGISTRO OFICIAL ABERTO
  // (sem key). SÓ lista + sugere `aluy mcp add`; instalar é ato separado.
  | { kind: 'mcp-search'; query: string }
  // EST-0970 — `aluy mcp add/list/remove`: gerencia servers MCP (escreve `~/.aluy/mcp.json`
  // ou `.mcp.json`). O subcomando tem o PRÓPRIO parser; o parser fino captura o `argv` cru.
  | { kind: 'mcp'; argv: readonly string[] }
  // EST-1150 · ADR-0128 — `aluy cron`: agendamento PERSISTENTE (jobs disparados
  // pelo cron do SO, sem daemon próprio na v1). 1ª fatia: Linux (crontab).
  | { kind: 'cron'; argv: readonly string[] }
  // invocação interativa default (sem objetivo) ou com objetivo direto
  // (`aluy "objetivo"`). `mode`/`dense` são flags de sessão (não persistem).
  // `unsafe` é derivado de `mode==='unsafe'` (legado, p/ não quebrar chamadores).
  // EST-0959 · ADR-0055: `--plan` e `--yolo` são valores do MESMO eixo `mode`
  // (`--unsafe` é alias DEPRECADO de `--yolo` — decisão de produto do Tiago);
  // se ambos vierem, Plan VENCE (read-only é o teto).
  | {
      kind: 'launch';
      goal?: string;
      mode: SessionMode;
      unsafe: boolean;
      // EST-0959 — a flag de bypass foi RENOMEADA `--unsafe` → `--yolo` (superfície
      // de usuário; o identificador INTERNO do modo continua `'unsafe'`). Este campo
      // marca que o usuário usou o ALIAS deprecado `--unsafe`, p/ o binário emitir
      // um aviso curto no stderr (sem quebrar scripts: o comportamento é idêntico).
      unsafeAliasUsed: boolean;
      // F109 — flags `--xxx` NÃO reconhecidas (typo): o binário AVISA no stderr ("você
      // quis dizer …?") em vez de ignorar SILENCIOSAMENTE. Crítico p/ flags de segurança:
      // um `--plna` (quis `--plan`) era dropado ⇒ rodava em modo NORMAL (escreve) quando o
      // usuário esperava read-only. Vazio/ausente ⇒ nenhuma flag desconhecida.
      readonly unknownFlags?: readonly string[];
      dense: boolean;
      // EST-0962 — tier de modelo inicial (`--tier <x>`). Sem ele ⇒ o default do
      // wiring. Troca em runtime pelo seletor `/model`. HG-2: só o tier (o broker
      // resolve provider/credencial).
      tier?: string;
      // EST-1007 · EST-0962 · HG-2/CLI-SEC-7 — `--model <slug>`: passa um modelo CUSTOM
      // direto, espelhando o que o `/model` custom já faz na TUI. RESOLVE p/ `tier:'custom'`
      // + este SLUG no wiring (vide bin/aluy.ts). O slug é o nome curado do modelo NO
      // CATÁLOGO do broker — DADO, NÃO credencial (seguro logar/persistir). NUNCA aceita
      // provider/api-key: o broker resolve slug→(provider,credencial). `--model` VENCE
      // `--tier` (força custom). `undefined` quando a flag não veio. Não persiste.
      model?: string;
      // EST-0962 · HG-2/CLI-SEC-7/PROV-SEC-5 — `--provider <name>` (alias `-p`? NÃO —
      // `-p` é headless): em PAR com `--model`, injeta o NOME do provider no corpo do
      // request Custom (`provider:"<name>"`), pareado com o `model`. EXIGE `--model` (erro
      // se sozinho). É só o NOME curado do provider no broker (ex.: `deepseek`) — DADO,
      // NÃO credencial: NUNCA base_url/api_key (o broker resolve `(provider,model)` →
      // credencial server-side, no vault). `undefined` quando a flag não veio (retrocompat:
      // sem a flag, nada muda — o broker escolhe o provider pelo catálogo). Não persiste.
      provider?: string;
      /**
       * EST-0962 (`--effort`) — `reasoning_effort` PASSTHROUGH (qualquer string não-vazia
       * ≤32 chars; low/medium/high são comuns mas CUSTOM é aceito). SEM tier-gate: vale em
       * qualquer tier. Vai no corpo do request ao broker. `undefined` ⇒ não veio na linha de
       * comando (não é enviado; o provider usa o default).
       */
      effort?: string;
      // ADR-0120 / EST-1113 — BACKEND de modelo: `broker` (default) | `local` (BYO).
      // Sob `local`, o CLI fala com o provider de LLM DIRETO com credencial BYO
      // (keychain→env), em vez de ir pelo aluy-broker central. Cru aqui (string); o
      // wiring resolve flag>env(ALUY_BACKEND)>config>default broker. `undefined` ⇒ não
      // veio na linha (cai nas demais fontes). Não persiste por si (a config persiste).
      backend?: string;
      // ADR-0120 / EST-1113 — config do PROVIDER do backend local (só sob `backend:local`):
      //   --local-provider <anthropic|openrouter|openai> · --local-model <slug nativo> ·
      //   --local-auth <apikey|oauth> · --local-base-url <url> (validado por anti-SSRF).
      // Cru aqui; o wiring resolve flag>env(ALUY_LOCAL_*)>config>default. NÃO credencial.
      localProvider?: string;
      localModel?: string;
      localAuth?: string;
      localBaseUrl?: string;
      // EST-1007 — MODO HEADLESS one-shot (`-p`/`--print`/`--exec`, igual `claude -p`).
      // Roda o prompt, imprime SÓ o resultado final no stdout (sem chrome de TUI) e SAI —
      // EXPLÍCITO, mesmo em TTY (não depende de detecção de pipe). Reusa o caminho não-TTY
      // (runLinear/loop) por baixo, acionado pela FLAG. `true` quando a flag veio.
      print: boolean;
      // EST-1007 — o prompt vindo de `-p "prompt"` / `--print=<x>` / `--exec=<x>` (valor da
      // flag). É flag-VALOR ⇒ NÃO é o objetivo posicional. Precedência do prompt headless
      // (resolvida no binário, que faz o I/O de stdin): printArg > goal posicional > STDIN.
      // `undefined` quando a flag veio SEM valor inline (cai no posicional/stdin).
      printArg?: string;
      // EST-1007 — formato de saída do headless (`--output-format text|json|stream-json`).
      // `text` (default) = só o resultado; `json` = `{result, tier, model, ok, ...}` p/ parsing;
      // `stream-json` = NDJSON de eventos AO VIVO (tool_call, tool_result, text, phase, result).
      // `undefined` ⇒ text. Só vale sob `print` (ignorado no modo TUI).
      outputFormat?: string;
      // EST-0989 (i18n) — idioma da TUI (`--lang pt-BR|en`). Precedência flag > config
      // (`~/.aluy/config.json` lang) > auto-detect do locale do SO > default pt-BR. Cru
      // aqui (string); a resolução/validação mora em `resolveInitialLang` (i18n/lang.ts).
      // `undefined` quando a flag não veio (cai p/ a preferência salva / auto-detect).
      lang?: string;
      // EST-0972 — retomada de sessão (QoL):
      //   `continue`   = `--continue`: retoma a ÚLTIMA sessão deste cwd.
      //   `resume`     = `--resume`: lista as sessões p/ escolher (sem id) ou
      //                  retoma a de `--resume <id>` (com id). Mutuamente exclusivos;
      //                  se ambos vierem, `--continue` vence (atalho mais direto).
      resume?: { kind: 'continue' } | { kind: 'resume'; id?: string };
      // EST-0972 (BUG 2) — `--new`: começa do ZERO, IGNORANDO a oferta de retomar a
      // sessão recente do mesmo cwd. Sem `--new` (e sem `--continue`/`--resume`),
      // o boot OFERECE retomar a conversa anterior do cwd (se houver uma recente).
      // `--new` é o opt-out explícito dessa oferta. Não persiste.
      fresh: boolean;
      // EST-0969 · ADR-0057 — sub-agentes locais PARALELOS (tool `spawn_agent`).
      // LIGADO por padrão; `--no-subagents` desliga (mono-agente). Não persiste.
      subAgents: boolean;
      // EST-0984 — perfil SEGURO de glifos (`--ascii`): força o conjunto de
      // cobertura quase universal mesmo em UTF-8 (terminal/fonte teimosos, ex.:
      // Terminator). Equivale a ALUY_SAFE_GLYPHS=1. Não persiste.
      safeGlyphs: boolean;
      // ADR-0134/0135 — `--telegram` ATIVA a bridge Telegram no boot: o agente passa a
      // RECEBER mensagens do dono allowlistado (long-poll) e pode responder (`telegram_send`).
      // DORMENTE sem credencial: sem token no keychain a bridge NÃO sobe (avisa `aluy telegram
      // login`) — zero egress. Só LIGA (não persiste; `false`/ausente ⇒ inerte, como hoje).
      telegram: boolean;
      // EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG). `--split` LIGA na largada
      // (precedência flag > config `ui.splitView` > default OFF). `undefined` quando
      // a flag não veio (cai p/ a preferência salva). É a ÚNICA flag que MAPEIA p/ uma
      // pref persistida (o toggle `Ctrl+L`/`/split` em runtime persiste igual).
      split?: boolean;
      // EST-1000 · ADR-0076 §1 — MODO COCKPIT (tela cheia, alt-screen). `--fullscreen`
      // LIGA na largada (precedência flag > config `ui.fullscreen` > default INLINE).
      // `undefined` quando a flag não veio (cai p/ a pref salva). MAPEIA p/ a pref
      // persistida (o toggle `/fullscreen` em runtime persiste igual). INLINE é o DEFAULT.
      fullscreen?: boolean;

      // EST-1112 · ADR-0119 — BUDGET de sessão no backend LOCAL. `--budget` LIGA,
      // `--no-budget` DESLIGA (vetor booleano COM negativa, diferente de split/fullscreen).
      // `undefined` quando nenhuma flag veio (cai p/ env > config > default). MAPEIA p/
      // a pref persistida `localBudget` (`/budget` em runtime persiste igual).
      budget?: boolean;
      // EST-0948 — TETO de tokens da sessão (`--max-tokens N`). Precedência flag>env
      // (ALUY_MAX_TOKENS)>default; o wiring valida e CLAMPA (anti-runaway). Cru aqui
      // (string) — o parse/validação numérico mora no core (resolveMaxTokens). Não persiste.
      maxTokens?: string;
      // EST-0948 — TETO de ITERAÇÕES do loop (`--max-iterations N`). Precedência flag>env
      // (ALUY_MAX_ITERATIONS)>default (300); o wiring valida e CLAMPA (anti-runaway). Cru
      // aqui (string) — o parse/validação numérico mora no core (resolveMaxIterations).
      // Não persiste.
      maxIterations?: string;
      // EST-0948 — `max_tokens` de OUTPUT POR CHAMADA ao modelo (`--max-output-tokens N`),
      // anti-TRUNCAMENTO. ⚠ DISTINTO de `maxTokens` (budget LOCAL acumulado da sessão):
      // este é o teto de OUTPUT de UMA chamada (vai no corpo do request → broker). Precedência
      // flag>env (ALUY_MAX_OUTPUT_TOKENS)>UNSET. DEFAULT UNSET: por padrão NÃO mandamos
      // `max_tokens` ⇒ o broker decide. Cru aqui (string) — o resolve/validação/clamp mora
      // no core (resolveMaxOutputTokens). Não persiste.
      maxOutputTokens?: string;
      // EST-0944 — SELF-CHECK de atenção (`--self-check` liga / `--no-self-check`
      // desliga). Compensa modelo BARATO/FRACO: re-âncora de objetivo a cada K
      // iterações + auto-verificação pré-"pronto". Cru aqui (`'1'`/`'0'` ou undefined);
      // o gating flag>env>tier-fraco e a validação moram no core (resolveSelfCheck).
      // A flag VENCE o tier (força ON/OFF). Não persiste.
      selfCheck?: string;
      // EST-0973 — AUTO-COMPACTAÇÃO da janela (`--autocompact-at <razão|%|off>`): o
      // LIMIAR de ocupação da janela (~85%) que dispara a compactação AUTOMÁTICA do
      // contexto p/ o agente continuar sem stallar. Cru aqui (string); o gating
      // flag>env (ALUY_AUTOCOMPACT_AT)>default(0.85) e o clamp moram no core
      // (resolveAutoCompact). `off`/`0` desligam. Não persiste.
      autoCompactAt?: string;
      // EST-1007 — `--quiet`: cala o progresso human-readable do stderr no modo headless
      // (`-p`/`--print`/`--exec`). O stdout (resultado do agente) segue limpo e íntegro;
      // só suprime os ticks/mensagens de progresso no stderr p/ scripts que querem stdout
      // + stderr SEM ruído de tool-calls. Sem efeito na TUI interativa. `true` quando a
      // flag veio; `undefined` (default) ⇒ progresso visível.
      quiet?: boolean;
      // EST-XXXX · ADR-0062 — `--cycle`: (com -p) Roda o objetivo em CICLOS autônomos
      // (como /cycle), sem interação. `true` quando a flag veio; `undefined` (default)
      // ⇒ comportamento headless normal (one-shot).
      cycle?: boolean;
      // EST-1019 · ADR-0062 §Addendum 1 (APR-0086) — TETO do CICLO via flag de boot:
      // `--cycles <N>` = nº de ITERAÇÕES (re-disparos), §2(b). DISTINTO de `--max-iterations`
      // (teto do LOOP agêntico interno — NÃO sobrecarregado como teto de ciclo). Cru aqui
      // (string); o wiring resolve/valida e a flag VENCE o teto embutido no goal quando
      // divergem. `undefined` quando a flag não veio. Não persiste.
      cycles?: string;
      // EST-1019 · ADR-0062 §Addendum 1 (APR-0086) — TETO do CICLO via flag de boot:
      // `--cycle-for <dur>` = DURAÇÃO total do ciclo (relógio de parede, ex.: `30m`, `2h`),
      // §2(a). Cru aqui (string); o wiring resolve/valida e a flag VENCE o teto embutido no
      // goal quando divergem. `undefined` quando a flag não veio. Não persiste.
      cycleFor?: string;
    };

export const HELP_TEXT = `aluy — agente de terminal que roda na sua máquina, com o seu provider de LLM

Uso:
  aluy ["objetivo"] [--plan | --yolo] [--dense] [--tier <tier>] [--lang <pt-BR|en>]
  aluy -p "prompt" [--model <slug>] [--output-format text|json|stream-json]   (headless, script)
  aluy --continue | --resume [<id>]
  aluy onboard                  (instalador guiado — primeiro uso)
  aluy bootstrap [--no-agent]   (provisiona os complementos opcionais — turbo)
  aluy uninstall [--agent]      (remove os complementos; --agent tira o ollama de sistema)
  aluy login [--token <PAT>] [--org <id>] [--device]
  aluy logout
  aluy whoami
  aluy doctor [--deep]
  aluy agents
  aluy skills
  aluy workflows
  aluy cron

Opções:
  -v, --version   Mostra a versão e sai
  -h, --help      Mostra esta ajuda e sai
  -p, --print, --exec <prompt>
                  MODO HEADLESS one-shot (igual \`claude -p\`): roda o prompt, imprime
                  SÓ o resultado final do assistente no stdout (sem chrome de TUI, sem
                  cores — respeita NO_COLOR) e SAI. EXPLÍCITO: vale mesmo em terminal
                  interativo (não depende de pipe). O prompt vem de 3 formas: \`-p "x"\`,
                  posicional (\`aluy -p "x"\`) ou STDIN (\`echo x | aluy -p\`). Diagnóstico
                  (avisos/erros) vai p/ o STDERR — o stdout fica LIMPO p/ script. Exit
                  code: 0 = sucesso; ≠0 = erro (provider fora / objetivo sem resposta)
                  ⇒ o script checa $?. SEGURANÇA (fail-closed): sem TTY não há como
                  CONFIRMAR a permissão ⇒ as categorias sempre-ask (rede/destrutivo/
                  escalada/exec) NEGAM por padrão; só --yolo libera (a flag é o
                  consentimento, igual \`claude -p --dangerously-skip-permissions\`). A
                  permissão \`decide()\` NÃO é relaxada no modo normal.
  --model <slug>  Passa um modelo direto (ex.: \`--model openai/gpt-4o\`). Resolve p/
                  tier:custom + o slug — o MESMO que escolher Custom na TUI via /model.
                  O <slug> é o nome do modelo (DADO, não credencial — seguro logar);
                  NUNCA aceita api-key na flag. --model VENCE --tier (força custom).
                  Vale na TUI e no headless (-p).
  --provider <name>
                  Em PAR com --model: o NOME do provider/vendor p/ resolver o <slug>
                  (ex.: \`--provider <provider> --model <slug>\`). EXIGE --model
                  (erro se sozinho). É SÓ o NOME (DADO, não credencial); NUNCA
                  base_url/api-key na flag — a credencial vem do keychain/env do
                  provider. Sem a flag, usa o provider configurado.
  --output-format text|json|stream-json
                  (só com -p) Formato da saída headless. text (padrão) = só o resultado;
                  json = {result, ok, tier, model, ...} numa linha p/ parsing. stream-json
                  = NDJSON de EVENTOS AO VIVO (tool_call, tool_result, text, phase, result)
                  — um JSON por linha no stdout, p/ quem chama o -p acompanhar o progresso
                  sem ficar cego (igual \`claude -p --output-format stream-json\`). Erros
                  seguem no stderr; o exit code segue refletindo sucesso/falha.
  --quiet         (só com -p) Cala o progresso human-readable do stderr (stdout limpo).
  --cycle         (só com -p) Roda o objetivo em CICLOS autônomos (como /cycle), sem
                  interação. Ex.: \`aluy -p "rode os testes" --cycle --cycles 3\`.
                  EXIGE um teto do ciclo (--cycles e/ou --cycle-for, ou teto embutido
                  no goal) — SEM teto NÃO inicia e sai com exit 2 (anti-runaway).
  --cycles N      (com --cycle) TETO de ITERAÇÕES do ciclo: o nº de re-disparos antes
                  de parar (ex.: \`--cycles 3\`). DISTINTO de --max-iterations (esse é o
                  teto do LOOP agêntico INTERNO de UMA sessão, não o nº de ciclos).
                  Vence o teto embutido no goal quando divergem. Não persiste.
  --cycle-for <dur>
                  (com --cycle) TETO de DURAÇÃO TOTAL do ciclo (relógio de parede; ex.:
                  \`--cycle-for 30m\`, \`--cycle-for 2h\`). Para ao fim da duração. Vence o
                  teto embutido no goal quando divergem. Clampado num teto-teto duro
                  (não dá p/ configurar infinito). Não persiste.
  --continue      Retoma a ÚLTIMA sessão deste diretório (carrega o histórico no
                  contexto e segue). Sem sessão neste cwd ⇒ começa uma nova.
  --resume [<id|nome>] Lista as sessões salvas p/ escolher e retomar. Com <id> (ou o
                  NOME dado no /rename), retoma
                  direto aquela sessão. Sessão ausente/corrompida ⇒ começa uma nova.
                  A transcrição salva mora em ~/.aluy/sessions/ (0600, fora do
                  workspace) — pode conter saída de comando/arquivo; nunca credencial.
  --new           Começa do ZERO, ignorando a oferta de retomar a conversa anterior
                  deste diretório. Sem --new (nem --continue/--resume), ao reabrir o
                  aluy no mesmo diretório ele OFERECE retomar a sessão recente.
  --backend <local|broker>
                  Backend de modelo. local (PADRÃO): o CLI fala com o seu provider
                  de LLM DIRETO, com a SUA credencial (BYO) — sem intermediário, sem
                  metering. Configure a credencial com \`aluy login --provider <p>\`
                  (keychain) ou a env do provider (ANTHROPIC_API_KEY /
                  OPENROUTER_API_KEY / OPENAI_API_KEY). Escolha provider/modelo por
                  env (ALUY_LOCAL_PROVIDER / ALUY_LOCAL_MODEL /
                  ALUY_LOCAL_AUTH=apikey|oauth / ALUY_LOCAL_BASE_URL) ou na config;
                  base_url override é validado por anti-SSRF (não aponta p/ rede
                  interna). broker: backend central opcional (quando disponível) —
                  ative com ALUY_BACKEND=broker ou \`backend\` no
                  ~/.aluy/config.json.
  --tier <tier>   Tier de modelo da sessão. Troque a qualquer momento na TUI com
                  /model. Não persiste entre sessões.
  --lang <code>   Idioma da TUI: pt-BR (padrão) ou en. Precedência: --lang > pref
                  salva (/lang) > locale do SO (LANG/LC_*; só promove en se for
                  claramente inglês) > pt-BR. Troque a qualquer momento com /lang.
                  PERSISTE a escolha (~/.aluy/config.json). Não traduz o que o
                  agente produz nem o prompt do modelo — só a interface.
  --plan          Modo Plan (read-only): o agente LÊ e ANALISA para planejar, mas
                  NÃO produz efeito algum — toda escrita/comando/rede é NEGADA (não
                  perguntada). Só leitura local (read_file/grep/ls/glob). Teto de
                  segurança: vence allow-list/hook/--yolo. Tab alterna os modos;
                  saia de Plan p/ executar. Não persiste. (--plan vence --yolo.)
  --yolo          ⚠ PERMISSÃO COMPLETA na máquina. Auto-aprova TUDO, SEM
                  EXCEÇÃO — categorias sempre-ask (rede/destrutivo/escalada/exec-de-
                  pacote/config/MCP), a cerca de workspace CAI (disco inteiro) e o
                  anti-SSRF de rede interna é suspenso. O agente roda QUALQUER comando,
                  lê/escreve QUALQUER arquivo e abre rede p/ QUALQUER destino SEM
                  perguntar. Uma injeção de prompt pode comprometer a máquina. Em TTY
                  pede confirmação ao entrar. Em headless/CI (-p) entra DIRETO — a flag
                  é o consentimento (igual \`claude -p --dangerously-skip-permissions\`;
                  ALUY_YOLO_HEADLESS NÃO é mais necessário). RECUSA SEMPRE como root
                  (uid 0) — único bloqueio duro: YOLO + root destrói a máquina. Não
                  persiste entre sessões. Use por sua conta e risco. (--unsafe é alias.)
  --dense         Densidade compacta da TUI (menos respiro vertical).
  --split         Liga o MODO VIEW AVANÇADO (split CHAT | LOG): a conversa à esquerda
                  e o LOG de atividade (agrupado por agente) à direita. Em telas
                  ≥100 colunas fica lado-a-lado; 60–99 vira abas (Tab/Ctrl+L alterna);
                  <60 desabilita (1 coluna, com aviso). Toggle em runtime com Ctrl+L
                  ou /split. PERSISTE a escolha (ui.splitView). (--view é alias.)
  --fullscreen    Liga o MODO COCKPIT (tela cheia, alt-screen): a TUI toma a tela
                  inteira em 6 regiões fixas (header/conversa/log/status/composer/
                  hints), cada uma com scroll próprio (pgup/pgdn · Tab foca). Perde o
                  scrollback/copy-paste NATIVOS (use /export ou ctrl+s p/ o transcript
                  redigido). INLINE é o DEFAULT — sair (/fullscreen) volta a ele limpo.
                  <80 col cai pro inline com aviso. PERSISTE (ui.fullscreen). Toggle em
                  runtime com /fullscreen (alias /cockpit). (--cockpit é alias.)
  --ascii         Perfil SEGURO de glifos: usa só caracteres de cobertura ampla
                  (equivale a ALUY_SAFE_GLYPHS=1). Para terminais/fontes teimosos
                  (ex.: Terminator) onde alguns glifos Unicode viram "tofu". Não
                  persiste. (TERM=linux / locale não-UTF-8 já caem no ASCII puro.)
  --no-subagents  Desliga os SUB-AGENTES locais paralelos (tool spawn_agent). Por
                  padrão o agente pode delegar subtarefas independentes a sub-agentes
                  que rodam em PARALELO (profundidade ≤1; herdam suas permissões e o
                  MESMO teto agregado de sessão). Use p/ forçar o modo mono-agente.
  --max-tokens N  Teto de tokens da sessão (fail-safe anti-runaway). Default
                  1.000.000 — uso agêntico consome muito (um sub-agente sozinho usa
                  200k+). Também via ALUY_MAX_TOKENS (a flag vence). Validado e CLAMPADO
                  num teto-teto (o anti-runaway é preservado). Bater o teto PAUSA e
                  pergunta ([c] continuar estende +1 janela; [n] encerra). Não persiste.
  --max-iterations N
                  Teto de ITERAÇÕES do loop (modelo→tool→observação) por objetivo
                  (fail-safe anti-runaway). Default 300 — um projeto
                  multi-arquivo gasta dezenas de iterações. Também via
                  ALUY_MAX_ITERATIONS (a flag vence). Validado e CLAMPADO num
                  teto-teto. Bater o teto PAUSA e pergunta ([c] continuar estende
                  +50; [n] encerra). Não persiste.
  --budget, --no-budget
                  Liga/desliga o ORÇAMENTO DE SESSÃO (gate de maxTokens/maxIterations)
                  no backend LOCAL (BYO). Por padrão é OFF no local — os tetos
                  --max-tokens/--max-iterations não atuam (o circuit-breaker de
                  tokens/iterações fica inativo). Use --budget p/ RELIGAR o gate
                  (idêntico ao remoto), ou --no-budget p/ garantir OFF. Também via
                  ALUY_BUDGET=1|true|on / 0|false|off (env) ou localBudget no
                  ~/.aluy/config.json. A precedência é flag > env > config > default.
                  No backend broker o budget é SEMPRE ON: pedir OFF é ignorado com
                  aviso no stderr. Não persiste (mas /budget na TUI persiste).
  --max-output-tokens N
                  max_tokens de OUTPUT por CHAMADA ao modelo (anti-truncamento). É
                  DISTINTO de --max-tokens (aquele é o budget LOCAL acumulado da
                  sessão; este é o teto de saída de UMA chamada). Por padrão NÃO é
                  enviado (UNSET) — o provider escolhe o teto do modelo. Use só p/
                  forçar respostas/arquivos maiores quando o default truncar.
                  Também via ALUY_MAX_OUTPUT_TOKENS (a flag vence). Inválido ⇒ ignorado
                  com aviso; clampado num teto CLI-side. Vale p/ sub-agentes. Não persiste.
  --self-check    Liga o SELF-CHECK de atenção (compensa modelos baratos/fracos): re-âncora
                  do objetivo a cada K iterações (mantém o foco em loops longos) + uma
                  AUTO-VERIFICAÇÃO antes de declarar "pronto" (confere a evidência real,
                  não a memória — pega o "achei que fiz mas não fiz"). Custa +1 chamada por
                  conclusão + re-âncora periódica (mais tokens, mais confiável). Liga sozinho
                  no tier custom (BYO); --self-check força ON, --no-self-check força
                  OFF (a flag vence o tier). Também via ALUY_SELF_CHECK=1/0; ALUY_SELF_CHECK_EVERY
                  (K da re-âncora, default 8) e ALUY_SELF_CHECK_MAX (cap de verificações,
                  default 2) afinam. Não persiste.
  --autocompact-at R
                  LIMIAR (razão 0..1, ou % como 85) de OCUPAÇÃO da JANELA de contexto que
                  dispara a AUTO-COMPACTAÇÃO: quando o contexto cruza ~85%, o agente
                  resume sozinho o que já leu e CONTINUA (não stalla em 100%, não pede
                  confirmação). Default 0.85. --autocompact-at off (ou 0) DESLIGA. Também
                  via ALUY_AUTOCOMPACT_AT (a flag vence); ALUY_AUTOCOMPACT_MAX afina o
                  anti-loop (máx. compactações seguidas sem progresso, default 2). O
                  /compact manual e o budget gate seguem existindo. Não persiste.

Variáveis de ambiente (web):
  ALUY_WEB_FETCH_MAX_CHARS  TETO de caracteres da OBSERVAÇÃO do web_fetch (o conteúdo
                  que entra no contexto do modelo). Default ~60000. Anti-OOM:
                  um web_fetch de resposta gigante (catálogo de modelos, etc.) é TRUNCADO
                  ao teto, com marcador do tamanho original — não satura a janela nem
                  estoura a RAM. Clampado (config errada NÃO desliga o teto). A LEITURA de
                  rede tem teto de bytes próprio (a porta para de ler no limite).

Instalação:
  onboard  Instalador guiado (TUI) — o passo 1 (\`npm i -g @hiperplano/aluy-cli && aluy onboard\`).
           Configura idioma, provider/modelo (BYO; faz um TESTE de conectividade real
           antes de prosseguir) e, opcionalmente, MCPs e os complementos. Substitui
           o setup manual. Funciona em Linux, macOS e Windows.
  bootstrap [--agent]
           Provisiona os COMPLEMENTOS opcionais (modo turbo): modelos locais (Ollama),
           memória persistente (mem0) e gestão de contexto (headroom). Rode depois do
           onboard, ou quando quiser ligar o turbo. \`--agent\` usa a rota via agente.

Comandos de auth:
  login    Autentica via device-flow (RFC 8628) ou PAT (--token / ALUY_TOKEN).
           --org <id> escolhe a organização (ou ALUY_ORG). --device força o
           caminho device-flow mesmo com ALUY_TOKEN no ambiente.
  login --provider <p> [--oauth]   Login do BACKEND LOCAL (BYO):
           sem --oauth ⇒ grava a API KEY do provider <p> (anthropic|openrouter|
           openai) no keychain (lê de --token ou de um prompt secreto). Com
           --oauth ⇒ login por ASSINATURA via OAuth-PKCE (Claude Pro/Max, ChatGPT;
           abre o browser, refresh automático). ⚠ OAuth de assinatura em cliente
           não-oficial é zona cinzenta de ToS do provider — opção consciente sua.
  logout   Revoga a sessão no servidor e apaga a credencial do keychain do SO.
  whoami   Mostra usuário/org/escopos da credencial atual (sem o segredo).
  doctor   Health-check read-only que TESTA e VALIDA: credencial (autentica via GET,
           sem gastar modelo), o backend (quando configurado), catálogo/tiers, servers MCP
           (CONECTA de verdade — handshake + conta tools), perfis de agente (.md),
           config (valida tema/tier no catálogo), versão e memória. Ticks ✓/⚠/✗
           progressivos + como consertar. Exit≠0 se houver ✗ (útil em script/CI).
           --deep/--test: ADICIONA o teste do tier ao vivo (1 chamada mínima ao
           modelo — opt-in, pois gasta). Sem --deep, NÃO chama o modelo.
  config   Visão CONSOLIDADA read-only da configuração efetiva: cada chave, o valor
           e a ORIGEM (default / env ALUY_* / config.json), na precedência real. Mostra
           também os outros arquivos (mcp/hooks/estado) e seus papéis. --json p/ script.

Conector Telegram (preparação — a bridge ainda NÃO está ativa):
  telegram login [--token <t>]   Guarda o token do bot (@BotFather) no KEYCHAIN do SO
                                 (nunca em arquivo). Sem --token, pede no prompt sem eco.
  telegram allow <chat-id>       Autoriza um chat-id (a allowlist do dono — default fechado).
  telegram deny <chat-id>        Remove um chat-id da allowlist.
  telegram status                Mostra token (redigido), allowlist e o estado da bridge.
  telegram logout                Apaga o token do bot do keychain.

Agentes .md:
  agents   Lista os perfis de sub-agente .md que o aluy MAPEOU — GLOBAIS
           (~/.aluy/agents/*.md, config do dono) e de PROJETO (.claude/agents/*.md no
           cwd, dado do repo), com nome, escopo, tools (⊆ pai) e a persona. Mostra
           também os REJEITADOS (.md malformado / tools: ilegível) com o
           motivo + a dica de conserto. São os perfis que o spawn_agent invoca por
           nome. Read-only, sem modelo, sem rede.

Skills .md:
  skills   Lista as SKILLS (SKILL.md) que o aluy MAPEOU — GLOBAIS
           (~/.aluy/skills/<nome>/SKILL.md, config do dono) e de PROJETO
           (.claude/skills/<nome>/SKILL.md no cwd, dado do repo), com nome, escopo e
           descrição. Mostra também as REJEITADAS (sem name / corpo vazio)
           com o motivo. Uma skill é uma capacidade empacotada cujas instruções são
           injetadas no contexto sob demanda. Read-only, sem modelo, sem rede.

Workflows .md:
  workflows  Lista os WORKFLOWS .md que o aluy MAPEOU — GLOBAIS
             (~/.aluy/workflows/*.md) e de PROJETO (.aluy/workflows/*.md no cwd), com
             nome, escopo e descrição. Um workflow é uma sequência de passos
             reutilizável. Read-only, sem modelo, sem rede.

Providers e modelos:
  models [--backend local|broker] [--json]
           Lista os providers/modelos DISPONÍVEIS, em duas seções: LOCAL (BYO —
           anthropic/openai/openrouter, o modo de auth de cada e o modelo default;
           pro OpenRouter, aponta pro catálogo vivo dele) e BROKER (os tiers com o
           modelo principal resolvido, os providers registrados e os modelos custom,
           do catálogo VIVO do broker). FAIL-SOFT: broker fora / sem login ⇒
           avisa "indisponível" e mostra só a seção local (exit 0, não quebra).
           --backend foca uma seção; --json imprime o objeto p/ script. Só nomes/slugs
           públicos (nunca credencial/base_url). Read-only.
  providers [--backend local|broker] [--json]
           Mesma discoverability, focada nos providers (local + registrados no broker).

Servers MCP:
  mcp search <query>
           Busca servers MCP no REGISTRO OFICIAL ABERTO (registry.modelcontextprotocol.io,
           sem login/sem key). Lista nome, descrição e COMO RODAR, e mostra a linha
           pronta "→ aluy mcp add …" p/ instalar o que você escolher.
  mcp add <nome> <command> [args...] [--env K=V]... [--project] [--force]
           Adiciona um server LOCAL (stdio) ao ~/.aluy/mcp.json (ou ao .mcp.json do
           projeto com --project) — sem editar o JSON à mão. Merge: preserva os outros.
  mcp list   Lista os servers de TODAS as fontes (~/.aluy, projeto, Codex) com a origem.
  mcp remove <nome> [--project]
           Remove o server de onde o aluy escreve (não toca no config do Claude/Codex).
  - Declare servers LOCAIS (stdio) em ~/.aluy/mcp.json (config = DADO; sem segredo
    literal — use --env K=$VAR, referência, não o segredo cru). As tools deles entram
    no toolset, ATRÁS da catraca de permissão — efeito por padrão (toda tool MCP pede
    confirmação; nunca auto-allow). Na sessão, /mcp lista servers + tools + estado.
  - ⚠ v1 NÃO isola o processo-server em sandbox de SO: o server
    roda com OS TEUS privilégios e pode ler o teu filesystem direto. SÓ PLUGUE
    SERVERS QUE VOCÊ CONFIA. A credencial do Aluy NUNCA é repassada ao server
    Plugue só servers que você confia.

Notas:
  - O modelo é chamado direto pelo seu provider (BYO); o backend broker é opcional.
  - Credencial SÓ no keychain do SO — nunca em texto em claro.
  - Loop de agente + ferramentas nativas + controle de permissão integrados.`;

/**
 * Extrai o valor de uma flag `--nome <valor>` (ou `--nome=valor`).
 *
 * O token seguinte que começa com `--` NÃO é o valor — é OUTRA flag: tratamos como
 * valor AUSENTE (`undefined`). Sem isso, `--effort --tier x` engoliria `--tier` como
 * o valor de `--effort` (e `--tier` perderia o seu), um misparse silencioso. Com a
 * guarda, cada flag-de-valor sem valor cai no mesmo caminho de "valor ausente" do fim
 * do argv (ex.: usage-error de `--effort`, ou default de `--tier`). [F10 · dogfooding]
 */
function flagValue(
  argv: readonly string[],
  name: string,
  opts: { readonly allowDashValue?: boolean } = {},
): string | undefined {
  // EST-1015 (fix borda, irmã do F10) — o token seguinte só conta como VALOR se NÃO parecer
  // outra flag. Antes guardávamos só `--` (long flag), então `--effort -p "x"` ENGOLIA o `-p`
  // como valor de `--effort` (e o `-p` headless se PERDIA — misparse silencioso). Agora, por
  // default, rejeitamos QUALQUER token iniciado por `-` (alinha com o `shortFlagValue`): a flag
  // sem valor cai no caminho de "valor ausente" (usage-error/default) e a flag seguinte é
  // preservada. EXCEÇÃO `allowDashValue` (print/exec): o PROMPT pode começar com `-` (ex.:
  // `--print "-v significa verbose"`), então ali só `--` desqualifica (preserva o comportamento).
  const eq = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      const next = argv[i + 1];
      if (next === undefined) return undefined;
      const looksLikeFlag = opts.allowDashValue ? next.startsWith('--') : next.startsWith('-');
      return looksLikeFlag ? undefined : next;
    }
    if (a !== undefined && a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

/**
 * EST-1007 — extrai o valor de uma flag CURTA `-x <valor>` (ou `-x=valor`). Espelha o
 * `flagValue` p/ as flags de uma letra (ex.: `-p "prompt"`). O token seguinte só conta
 * como valor se NÃO for outra flag (senão `-p` veio sem valor inline ⇒ cai no stdin).
 */
function shortFlagValue(argv: readonly string[], name: string): string | undefined {
  const eq = `-${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `-${name}`) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('-') ? next : undefined;
    }
    if (a !== undefined && a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

export function versionText(): string {
  // Expõe as duas versões (binário + engine) — o engine é pacote separado.
  return `aluy ${CLI_VERSION} (@hiperplano/aluy-cli-core ${CORE_VERSION})`;
}

/** Resolve, a partir dos argumentos (sem o `node` e o script), o que fazer. */
/**
 * F109 — flags LONGAS reconhecidas no caminho de LAUNCH (`aluy [obj] [flags]`). Fonte
 * única p/ detectar TYPO: um `--xxx` fora deste conjunto (e que não é VALOR de flag) é
 * "desconhecido". Superset deliberado (inclui flags de subcomando) — só erra a favor de
 * NÃO avisar; o objetivo é pegar typo, não validar contexto. Mantida em sync por teste.
 */
const KNOWN_LONG_FLAGS: ReadonlySet<string> = new Set([
  'agent',
  'no-agent',
  'ascii',
  'autocompact-at',
  'backend',
  'budget',
  'cockpit',
  'continue',
  'cycle',
  'cycle-for',
  'cycles',
  'deep',
  'dense',
  'device',
  'effort',
  'exec',
  'fullscreen',
  'help',
  'json',
  'lang',
  'local-auth',
  'local-base-url',
  'local-model',
  'local-provider',
  'max-iterations',
  'max-output-tokens',
  'max-tokens',
  'model',
  'new',
  'no-autocompact',
  'no-budget',
  'no-self-check',
  'no-subagent',
  'no-subagents',
  'nome',
  'oauth',
  'output-format',
  'plan',
  'print',
  'provider',
  'quiet',
  'resume',
  'self-check',
  'split',
  'telegram',
  'test',
  'tier',
  'unsafe',
  'version',
  'view',
  'yolo',
]);

/**
 * F109 — flags cujo VALOR vem no token SEGUINTE (forma separada `--flag valor`). O token
 * seguinte é o valor (slug/url/nº/prompt) — pode começar com `--` e NÃO é typo. Curtas de
 * prompt (`-p`) incluídas. A forma `--flag=valor` é o próprio token (sem valor separado).
 */
const VALUE_TAKING_FLAGS: readonly string[] = [
  '-p',
  '--print',
  '--exec',
  '--tier',
  '--lang',
  '--model',
  '--provider',
  '--effort',
  '--output-format',
  '--backend',
  '--local-provider',
  '--local-model',
  '--local-auth',
  '--local-base-url',
  '--max-tokens',
  '--max-iterations',
  '--max-output-tokens',
  '--autocompact-at',
  '--cycles',
  '--cycle-for',
  '--resume',
];

/** Distância de edição (Levenshtein) clampada — p/ o "você quis dizer …?". PURA. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

/** O flag conhecido mais próximo de `name` (≤2 edições), p/ sugerir. `undefined` se nenhum. */
export function suggestFlag(name: string): string | undefined {
  let best: string | undefined;
  let bestD = 3; // só sugere se ≤2 edições.
  for (const k of KNOWN_LONG_FLAGS) {
    const d = editDistance(name, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/**
 * F109 — flags `--xxx` no LAUNCH que NÃO são conhecidas NEM valor de outra flag. PURA.
 * `valueIndices` = índices de argv que são VALOR de uma flag separada (não checar).
 * Para no separador `--` (tudo depois é posicional). Ignora `--flag=valor` pelo nome
 * antes do `=`. Curtas (`-x`) não são checadas (menos ambíguas; -p value etc.).
 */
function detectUnknownFlags(argv: readonly string[], valueIndices: ReadonlySet<number>): string[] {
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break; // separador POSIX: o resto é posicional.
    if (!a.startsWith('--') || a.length === 2) continue; // só flags longas.
    if (valueIndices.has(i)) continue; // é VALOR de uma flag separada.
    const name = a.slice(2).split('=', 1)[0]!;
    if (name === '' || KNOWN_LONG_FLAGS.has(name)) continue;
    unknown.push(`--${name}`);
  }
  return unknown;
}

export function parseArgs(argv: readonly string[]): CliAction {
  const sub = argv[0];

  // Subcomandos de auth (EST-0942). `--help` dentro do subcomando ⇒ help geral.
  if (sub === 'login' && !argv.includes('-h') && !argv.includes('--help')) {
    const rest = argv.slice(1);
    const token = flagValue(rest, 'token');
    const org = flagValue(rest, 'org');
    const forceDeviceFlow = rest.includes('--device');
    // ADR-0120 — login do BACKEND LOCAL (BYO): `--provider <p>` + (`--oauth` | API key).
    const provider = flagValue(rest, 'provider');
    const oauth = rest.includes('--oauth');
    return {
      kind: 'login',
      forceDeviceFlow,
      ...(token !== undefined ? { token } : {}),
      ...(org !== undefined ? { org } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(oauth ? { oauth: true } : {}),
    };
  }
  if (sub === 'logout' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'logout' };
  }
  if (sub === 'whoami' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'whoami' };
  }
  // EST-0970 — `aluy doctor`: health-check read-only com validação ATIVA. `--deep`/`--test`
  // adiciona o teste do tier ao vivo (opt-in que GASTA 1 chamada ao modelo).
  // `--json` imprime o JSON dos checks no stdout (sem ticks).
  if (sub === 'doctor' && !argv.includes('-h') && !argv.includes('--help')) {
    const deep = argv.includes('--deep') || argv.includes('--test');
    const json = argv.includes('--json');
    return { kind: 'doctor', deep, json };
  }
  // `aluy config` — visão consolidada read-only da config efetiva. `--json` p/ script.
  if (sub === 'config' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'config', json: argv.includes('--json') };
  }
  // EST-0977 — `aluy agents`: lista os perfis de sub-agente .md mapeados. Read-only,
  // sem args/flags próprias. `--help` cai no help geral.
  if (sub === 'agents' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'agents' };
  }
  if (sub === 'bootstrap' && !argv.includes('-h') && !argv.includes('--help')) {
    // O AGENTE EMBUTIDO é o DEFAULT (instala pré-requisitos + sidecars adaptativo, qualquer
    // SO). `--no-agent` força o caminho direto (tarball pinado, só Linux c/ python pronto).
    // `--agent` segue aceito (redundante/explícito).
    return { kind: 'bootstrap', agent: !argv.includes('--no-agent') };
  }
  // `aluy uninstall [--agent]` — remove os complementos. `--agent` (opt-in) remove também o
  // ollama de SISTEMA via o próprio agente (⚠ --yolo + sudo). `--help` cai no help geral.
  if (sub === 'uninstall' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'uninstall', agent: argv.includes('--agent') };
  }
  // `aluy onboard` — onboarding interativo (Ink). Sem args/flags próprias nesta fatia;
  // `--help` cai no help geral. O bootstrap mínimo o invoca reanexado ao TTY real.
  if (sub === 'onboard' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'onboard' };
  }
  // EST-1112 — `aluy skills`: lista as SKILLS (SKILL.md) mapeadas. Read-only, sem
  // args/flags próprias. `--help` cai no help geral. Espelha `agents`.
  if (sub === 'skills' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'skills' };
  }
  // EST-1105 — `aluy workflows`: lista os fluxos de atividade .md mapeados. Read-only,
  // sem args/flags próprias. `--help` cai no help geral. Espelha `agents`.
  if (sub === 'workflows' && !argv.includes('-h') && !argv.includes('--help')) {
    return { kind: 'workflows' };
  }
  // EST-1116 — `aluy models` / `aluy providers`: lista os providers/modelos disponíveis
  // (LOCAL BYO + BROKER do catálogo vivo, fail-soft). `--json` p/ script; `--backend
  // local|broker` foca uma seção (default: ambas). `--help` cai no help geral. Exit 0.
  if (
    (sub === 'models' || sub === 'providers') &&
    !argv.includes('-h') &&
    !argv.includes('--help')
  ) {
    const json = argv.includes('--json');
    // `--backend <x>` ou `--backend=<x>` ⇒ foca a seção; valor inválido ⇒ ambas (tolerante).
    const idx = argv.findIndex((a) => a === '--backend' || a.startsWith('--backend='));
    let scope: 'local' | 'broker' | 'both' = 'both';
    if (idx !== -1) {
      const raw = argv[idx]!.includes('=')
        ? argv[idx]!.slice('--backend='.length)
        : (argv[idx + 1] ?? '');
      const v = raw.trim().toLowerCase();
      if (v === 'local') scope = 'local';
      else if (v === 'broker') scope = 'broker';
    }
    return { kind: 'models', scope, json, which: sub === 'providers' ? 'providers' : 'models' };
  }

  // ADR-0134/0135 — `aluy telegram <login|logout|allow|deny|status> [args]`. `--help` cai
  // no help geral. Subcomando inválido/ausente ⇒ usage-error.
  if (sub === 'telegram' && !argv.includes('-h') && !argv.includes('--help')) {
    const tgSub = argv[1];
    const valid = ['login', 'logout', 'allow', 'deny', 'status'] as const;
    if (tgSub === undefined || !(valid as readonly string[]).includes(tgSub)) {
      return {
        kind: 'usage-error',
        message: 'uso: aluy telegram <login|logout|allow|deny|status>',
        exitCode: 2,
      };
    }
    const rest = argv.slice(2);
    if (tgSub === 'login') {
      const token = flagValue(rest, 'token');
      return { kind: 'telegram', sub: 'login', ...(token !== undefined ? { token } : {}) };
    }
    if (tgSub === 'allow' || tgSub === 'deny') {
      const raw = rest.find((a) => !a.startsWith('-'));
      const chatId = raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : undefined;
      if (chatId === undefined) {
        return {
          kind: 'usage-error',
          message: `uso: aluy telegram ${tgSub} <chat-id>  (um inteiro)`,
          exitCode: 2,
        };
      }
      return { kind: 'telegram', sub: tgSub, chatId };
    }
    return { kind: 'telegram', sub: tgSub as 'logout' | 'status' };
  }

  // EST-0970 (search) — `aluy mcp search <query…>` PRIMEIRO (mais específico): busca no
  // registro oficial aberto. A query é o resto dos posicionais juntados.
  if (sub === 'mcp' && argv[1] === 'search' && !argv.includes('-h') && !argv.includes('--help')) {
    const query = argv
      .slice(2)
      .filter((a) => !a.startsWith('-'))
      .join(' ')
      .trim();
    return { kind: 'mcp-search', query };
  }
  // EST-0970 — demais `aluy mcp …` (add/list/remove): parser próprio, delega ao runner.
  if (sub === 'mcp') {
    return { kind: 'mcp', argv: argv.slice(1) };
  }
  // EST-1150 · ADR-0128 — `aluy cron ...`: agendamento PERSISTENTE. Passa o argv cru para
  // o runner (subcomandos create/list/remove/run-now são parseados dentro do módulo cron.ts).
  if (sub === 'cron') {
    return { kind: 'cron', argv: argv.slice(1) };
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    return { kind: 'version', text: versionText() };
  }
  if (argv.includes('-h') || argv.includes('--help')) {
    return { kind: 'help', text: HELP_TEXT };
  }
  // Launch (TUI): flags de sessão + objetivo posicional opcional (`aluy "obj"`).
  // EST-0959 · ADR-0055 — `--plan` e `--yolo` são valores do MESMO eixo `mode`.
  // Mutuamente exclusivos: se AMBOS vierem, Plan VENCE (read-only é o teto — nunca
  // resolvemos p/ unsafe quando o usuário também pediu plan). Sem nenhum ⇒ normal.
  // `--yolo` é o nome OFICIAL (decisão de produto); `--unsafe` segue como ALIAS
  // deprecado, idêntico (compat de script). O modo INTERNO continua `'unsafe'` —
  // catraca/specs/CLI-SEC referenciam o identificador, não a flag.
  const plan = argv.includes('--plan');
  const unsafeAliasUsed = argv.includes('--unsafe');
  const yoloFlag = argv.includes('--yolo') || unsafeAliasUsed;
  const mode: SessionMode = plan ? 'plan' : yoloFlag ? 'unsafe' : 'normal';
  const dense = argv.includes('--dense');
  // EST-0984 — `--ascii` força o perfil SEGURO de glifos (opt-in explícito).
  const safeGlyphs = argv.includes('--ascii');
  // ADR-0134/0135 — `--telegram` ATIVA a bridge no boot (só LIGA; ausente ⇒ inerte). A
  // ativação real é DORMENTE: sem token no keychain a bridge não sobe (avisa e segue).
  const telegram = argv.includes('--telegram');
  // EST-0990 — `--split` (alias `--view`) LIGA o modo view avançado na largada. Só
  // LIGA (não há `--no-split`); ausente ⇒ `undefined` (o wiring cai na pref salva).
  const split = argv.includes('--split') || argv.includes('--view') ? true : undefined;
  // EST-1000 · ADR-0076 §1 — `--fullscreen` (alias `--cockpit`) LIGA o cockpit na largada.
  // Só LIGA (não há `--no-fullscreen`; sair em sessão é o `/fullscreen`); ausente ⇒
  // `undefined` (o wiring cai na pref `ui.fullscreen`). INLINE é o DEFAULT do ADR.
  const fullscreen = argv.includes('--fullscreen') || argv.includes('--cockpit') ? true : undefined;
  // EST-1112 · ADR-0119 — `--budget` LIGA o orçamento local (gate de tokens/iterações),
  // `--no-budget` DESLIGA (ilimitado). Diferente de `--split`/`--fullscreen` (que só
  // LIGAM), aqui há vetor booleano COM negativa. Ausente ⇒ `undefined` (cai p/ env >
  // config > default). MAPEIA p/ a pref `localBudget` no config persistente.
  const budget = argv.includes('--no-budget')
    ? false
    : argv.includes('--budget')
      ? true
      : undefined;
  const tier = flagValue(argv, 'tier');
  // EST-0989 (i18n) — `--lang pt-BR|en`: idioma da TUI (cru aqui; o wiring resolve
  // flag>config>auto-detect>pt-BR via resolveInitialLang). Valor inválido cai p/ a
  // pref/auto-detect (resolveLang rejeita lixo) — nunca quebra.
  const lang = flagValue(argv, 'lang');
  // EST-0948 — `--max-tokens N`: teto de tokens da sessão (cru aqui; o wiring resolve
  // flag>env>default e clampa via resolveMaxTokens do core).
  const maxTokens = flagValue(argv, 'max-tokens');
  // EST-0948 — `--max-iterations N`: teto de iterações do loop (cru aqui; o wiring
  // resolve flag>env>default e clampa via resolveMaxIterations do core).
  const maxIterations = flagValue(argv, 'max-iterations');
  // EST-0948 — `--max-output-tokens N`: max_tokens de OUTPUT por chamada (cru aqui; o
  // wiring resolve flag>env>UNSET e clampa via resolveMaxOutputTokens do core). DISTINTO
  // do budget local `--max-tokens`.
  const maxOutputTokens = flagValue(argv, 'max-output-tokens');
  // EST-0969 · ADR-0057 — sub-agentes paralelos LIGADOS por padrão; `--no-subagents`
  // desliga (mono-agente). Aceita também `--no-subagent` (singular) por conveniência.
  const subAgents = !(argv.includes('--no-subagents') || argv.includes('--no-subagent'));
  // EST-0944 — SELF-CHECK de atenção. Flag booleana de TRÊS estados: `--self-check`
  // força ON (`'1'`), `--no-self-check` força OFF (`'0'`), nenhuma ⇒ undefined (o
  // wiring cai em env>tier-fraco). A flag VENCE o tier. `--no-self-check` vence
  // `--self-check` se ambas vierem (desligar é o lado seguro/explícito).
  const selfCheck = argv.includes('--no-self-check')
    ? '0'
    : argv.includes('--self-check')
      ? '1'
      : undefined;
  // EST-0973 — `--autocompact-at <razão|%|off>`: limiar da auto-compactação da janela
  // (cru aqui; o wiring/controller resolve flag>env>default 0.85 e clampa/desliga via
  // resolveAutoCompact do core). `--no-autocompact` é açúcar p/ `--autocompact-at off`.
  const autoCompactAt = argv.includes('--no-autocompact')
    ? 'off'
    : flagValue(argv, 'autocompact-at');

  // EST-1007 — `--quiet`: cala o progresso human-readable do stderr no modo headless
  // (`-p`/`--print`/`--exec`). Flag booleana: presente ⇒ quiet:true; ausente ⇒ undefined.
  // Sem efeito na TUI interativa. Só vale sob `print` (ignorado no modo TUI).
  const quiet = argv.includes('--quiet') ? true : undefined;

  // EST-XXXX · ADR-0062 — `--cycle`: (com -p) Roda o objetivo em CICLOS autônomos
  // (como /cycle), sem interação. Flag booleana: presente ⇒ cycle:true; ausente ⇒ undefined.
  // Só vale sob `print` (ignorado no modo TUI).
  const cycle = argv.includes('--cycle') ? true : undefined;

  // EST-1019 · ADR-0062 §Addendum 1 (APR-0086) — TETO do CICLO via flags de boot dedicadas
  // (aresta b do BUG-0023). `--cycles <N>` = teto de ITERAÇÕES (nº de ciclos); `--cycle-for
  // <dur>` = teto de DURAÇÃO total. Cru aqui (string; a forma `--flag valor` SEPARADA usa o
  // mesmo `flagValue` com o guard contra valor `--…` — F10); o wiring resolve/valida e a flag
  // de boot VENCE o teto embutido no goal quando divergem. São DISTINTAS de `--max-iterations`
  // (teto do LOOP agêntico interno — NÃO sobrecarregado como teto de ciclo, APR-0086 §A1.1).
  const cycles = flagValue(argv, 'cycles');
  const cycleFor = flagValue(argv, 'cycle-for');

  // ADR-0120 / EST-1113 — `--backend <broker|local>`: seleciona o backend de modelo.
  // Cru aqui (string); o wiring resolve flag>env>config>default broker. Valor inválido
  // ⇒ ignorado lá (cai no default), sem usage-error (mais tolerante que --tier custom).
  const backend = flagValue(argv, 'backend');
  // ADR-0120 / EST-1113 — flags do provider do backend local (cru; o wiring resolve).
  const localProvider = flagValue(argv, 'local-provider');
  const localModel = flagValue(argv, 'local-model');
  const localAuth = flagValue(argv, 'local-auth');
  const localBaseUrl = flagValue(argv, 'local-base-url');

  // EST-1007 · EST-0962 — `--model <slug>`: modelo CUSTOM direto (HG-2: só o SLUG, nunca
  // credencial). Implica `tier:'custom'` (resolvido no binário). `--model` VENCE `--tier`.
  const model = flagValue(argv, 'model');

  // EST-0962 · HG-2/CLI-SEC-7/PROV-SEC-5 — `--provider <name>`: NOME do provider em PAR
  // com `--model`, injetado no corpo do request Custom. Só o NOME (DADO, não credencial).
  const provider = flagValue(argv, 'provider');
  // `--provider` EXIGE `--model` (são par: provider escolhe o vendor do <slug>). PRESENÇA
  // da flag (mesmo `--provider=`) sem `--model` (ausente/vazio) ⇒ ERRO DE USO (exit 2, sem
  // sessão). Sem a flag, nada muda (retrocompat). O valor em si pode ser qualquer NOME.
  const providerFlagPresent =
    argv.includes('--provider') || argv.some((a) => a.startsWith('--provider='));
  if (providerFlagPresent && (model === undefined || model.trim() === '')) {
    return {
      kind: 'usage-error',
      message: 'aluy: --provider exige --model (ex.: --provider <provider> --model <slug>)',
      exitCode: 2,
    };
  }

  // HUNT-CATALOG — `--tier custom` NU (sem `--model`) é um beco-sem-saída: a via Custom
  // (ADR-0030 §3) EXIGE um slug — sem ele o request sai `tier:custom` sem model e o broker
  // 422a numa chamada tardia (falha confusa, longe da causa). Recusa CEDO e EXPLÍCITO (como
  // `--provider` sem `--model`): o usuário ou passa `--model <slug>` ou escolhe um tier
  // canônico. Case-insensitive + trim (o resolvedor de tier aceita `custom`/`CUSTOM`).
  // Só `--tier` LITERAL `custom`; um `--model` presente já força custom COM slug (ok).
  if (
    (model === undefined || model.trim() === '') &&
    tier !== undefined &&
    tier.trim().toLowerCase() === 'custom'
  ) {
    return {
      kind: 'usage-error',
      message:
        'aluy: --tier custom exige --model <slug> (ex.: --model deepseek-v4-pro). ' +
        'A via Custom precisa do slug do modelo; sem ele use um tier canônico (aluy-flux, aluy-granito, …).',
      exitCode: 2,
    };
  }

  // EST-0962 — `--effort <valor>`: reasoning_effort PASSTHROUGH (qualquer string ≤32 chars).
  // SEM tier-gate: vale em qualquer tier. SÓ valida: não-vazio E ≤32 chars. NÃO restringe
  // a low/medium/high — o broker/provider validam.
  const effortRaw = flagValue(argv, 'effort');
  const effortFlagPresent =
    argv.includes('--effort') || argv.some((a) => a.startsWith('--effort='));
  let effort: string | undefined;
  if (effortRaw !== undefined) {
    if (effortRaw.trim() === '') {
      return {
        kind: 'usage-error',
        message: 'aluy: --effort requer um valor (ex.: --effort low)',
        exitCode: 2,
      };
    }
    if (effortRaw.length > 32) {
      return {
        kind: 'usage-error',
        message: 'aluy: --effort aceita no máximo 32 caracteres',
        exitCode: 2,
      };
    }
    effort = effortRaw;
  } else if (effortFlagPresent) {
    // Flag presente mas sem valor (ex.: `--effort` sozinho ou `--effort=` vazio).
    return {
      kind: 'usage-error',
      message: 'aluy: --effort requer um valor (ex.: --effort low)',
      exitCode: 2,
    };
  }

  // EST-1007 — MODO HEADLESS one-shot (`-p`/`--print`/`--exec`). Aceita as 3 formas do
  // prompt (igual Claude Code): `-p "x"` (valor inline), prompt POSICIONAL, ou STDIN
  // (o binário lê o stdin quando não há valor inline nem posicional). Aqui só detectamos
  // a flag e capturamos o VALOR inline (se houver) — o stdin é I/O, mora no binário.
  const print =
    argv.includes('-p') ||
    argv.includes('--print') ||
    argv.includes('--exec') ||
    argv.some((a) => a.startsWith('-p=') || a.startsWith('--print=') || a.startsWith('--exec='));
  // O VALOR inline de `-p`/`--print`/`--exec` (forma `-p x`, `-p=x`, `--print=x`). Na forma
  // SEPARADA (`-p x`), o token seguinte é o prompt — e NÃO o objetivo posicional.
  const printArg = print
    ? (flagValue(argv, 'print', { allowDashValue: true }) ??
      flagValue(argv, 'exec', { allowDashValue: true }) ??
      shortFlagValue(argv, 'p') ??
      undefined)
    : undefined;
  // EST-1007 — formato de saída do headless (só sob `print`). `text` (default) | `json`.
  const outputFormat = print ? flagValue(argv, 'output-format') : undefined;

  // EST-0972 (BUG 2) — `--new`: pula a oferta de retomar a sessão recente do cwd e
  // começa do ZERO. Sem ele, o boot oferece retomar a conversa anterior (se houver).
  const fresh = argv.includes('--new');

  // EST-0972 — retomada de sessão. `--continue` retoma a última deste cwd;
  // `--resume [<id>]` lista (sem id) ou retoma a `<id>`. `--continue` vence se ambos
  // vierem (atalho mais direto). O valor de `--resume` é OPCIONAL: só conta como id
  // o token seguinte se ele NÃO for outra flag (senão `--resume` ficou sem id ⇒ lista).
  const hasContinue = argv.includes('--continue');
  const resumeIdx = argv.indexOf('--resume');
  // id de `--resume <id>` (preferindo `--resume=<id>` se vier nessa forma).
  const resumeEq = argv.find((a) => a.startsWith('--resume='));
  const hasResume = resumeIdx >= 0 || resumeEq !== undefined;
  let resumeId: string | undefined;
  if (resumeEq !== undefined) {
    resumeId = resumeEq.slice('--resume='.length);
  } else if (resumeIdx >= 0) {
    const next = argv[resumeIdx + 1];
    if (next !== undefined && !next.startsWith('-')) resumeId = next;
  }
  // índices de tokens que são VALOR de uma flag (não são o objetivo posicional).
  const tierValueIdx = tier !== undefined ? argv.indexOf('--tier') + 1 : -1;
  // EST-0989 — `--lang <code>` (forma SEPARADA): o token seguinte é VALOR, não goal.
  // A forma `--lang=<code>` já é o próprio token (começa com `-`), filtrado adiante.
  const langSep = lang !== undefined && !argv.some((a) => a.startsWith('--lang='));
  const langValueIdx = langSep ? argv.indexOf('--lang') + 1 : -1;
  const resumeValueIdx = resumeId !== undefined && resumeEq === undefined ? resumeIdx + 1 : -1;
  // EST-0948 — só conta como valor o token seguinte à flag SEPARADA (`--max-tokens N`),
  // não a forma `--max-tokens=N` (essa é o próprio token, já começa com `-`).
  const maxTokensSep = maxTokens !== undefined && !argv.some((a) => a.startsWith('--max-tokens='));
  const maxTokensValueIdx = maxTokensSep ? argv.indexOf('--max-tokens') + 1 : -1;
  // EST-0948 — idem p/ `--max-iterations N` (forma SEPARADA): o token seguinte é VALOR,
  // não o objetivo posicional. A forma `--max-iterations=N` já é o próprio token.
  const maxIterationsSep =
    maxIterations !== undefined && !argv.some((a) => a.startsWith('--max-iterations='));
  const maxIterationsValueIdx = maxIterationsSep ? argv.indexOf('--max-iterations') + 1 : -1;
  // EST-1019 — idem p/ `--cycles N` (forma SEPARADA): o token seguinte é VALOR (nº de
  // ciclos), não o objetivo posicional. A forma `--cycles=N` já é o próprio token.
  const cyclesSep = cycles !== undefined && !argv.some((a) => a.startsWith('--cycles='));
  const cyclesValueIdx = cyclesSep ? argv.indexOf('--cycles') + 1 : -1;
  // EST-1019 — idem p/ `--cycle-for <dur>` (forma SEPARADA): o token seguinte é VALOR
  // (duração), não o objetivo posicional. A forma `--cycle-for=<dur>` já é o próprio token.
  const cycleForSep = cycleFor !== undefined && !argv.some((a) => a.startsWith('--cycle-for='));
  const cycleForValueIdx = cycleForSep ? argv.indexOf('--cycle-for') + 1 : -1;
  // EST-0948 — idem p/ `--max-output-tokens N` (forma SEPARADA): o token seguinte é VALOR,
  // não o objetivo posicional. A forma `--max-output-tokens=N` já é o próprio token.
  const maxOutputTokensSep =
    maxOutputTokens !== undefined && !argv.some((a) => a.startsWith('--max-output-tokens='));
  const maxOutputTokensValueIdx = maxOutputTokensSep ? argv.indexOf('--max-output-tokens') + 1 : -1;
  // EST-0973 — idem p/ `--autocompact-at <v>` (forma SEPARADA): o token seguinte é VALOR,
  // não o objetivo posicional. A forma `--autocompact-at=v` já é o próprio token. (O
  // açúcar `--no-autocompact` não tem valor separado.)
  const autoCompactAtSep =
    autoCompactAt !== undefined &&
    !argv.includes('--no-autocompact') &&
    !argv.some((a) => a.startsWith('--autocompact-at='));
  const autoCompactAtValueIdx = autoCompactAtSep ? argv.indexOf('--autocompact-at') + 1 : -1;
  // ADR-0120 — `--backend <x>` (forma SEPARADA): o token seguinte é o VALOR, não o goal.
  const backendSep = backend !== undefined && !argv.some((a) => a.startsWith('--backend='));
  const backendValueIdx = backendSep ? argv.indexOf('--backend') + 1 : -1;
  // ADR-0120 — idem p/ as flags do provider local (forma SEPARADA): o token seguinte é VALOR.
  const valueIdxOf = (name: string, val: string | undefined): number =>
    val !== undefined && !argv.some((a) => a.startsWith(`--${name}=`))
      ? argv.indexOf(`--${name}`) + 1
      : -1;
  const localProviderValueIdx = valueIdxOf('local-provider', localProvider);
  const localModelValueIdx = valueIdxOf('local-model', localModel);
  const localAuthValueIdx = valueIdxOf('local-auth', localAuth);
  const localBaseUrlValueIdx = valueIdxOf('local-base-url', localBaseUrl);
  // EST-1007 — `--model <slug>` (forma SEPARADA): o token seguinte é o SLUG, não o goal.
  const modelSep = model !== undefined && !argv.some((a) => a.startsWith('--model='));
  const modelValueIdx = modelSep ? argv.indexOf('--model') + 1 : -1;
  // EST-0962 — `--provider <name>` (forma SEPARADA): o token seguinte é o NOME, não o goal.
  const providerSep = provider !== undefined && !argv.some((a) => a.startsWith('--provider='));
  const providerValueIdx = providerSep ? argv.indexOf('--provider') + 1 : -1;
  // EST-0962 — `--effort <value>` (forma SEPARADA): o token seguinte é o VALOR, não o goal.
  const effortSep = effort !== undefined && !argv.some((a) => a.startsWith('--effort='));
  const effortValueIdx = effortSep ? argv.indexOf('--effort') + 1 : -1;
  // EST-1007 — `--output-format <x>` (forma SEPARADA): token seguinte é VALOR, não goal.
  const outputFormatSep =
    outputFormat !== undefined && !argv.some((a) => a.startsWith('--output-format='));
  const outputFormatValueIdx = outputFormatSep ? argv.indexOf('--output-format') + 1 : -1;
  // EST-1007 — `-p <prompt>` / `--print <prompt>` / `--exec <prompt>` (forma SEPARADA): o
  // token seguinte é o PROMPT headless, NÃO o objetivo posicional. Só quando o prompt
  // veio inline na forma separada (printArg setado e não na forma `=`). Cobre as 3 flags.
  const printValueIdx =
    printArg !== undefined &&
    !argv.some((a) => a.startsWith('-p=') || a.startsWith('--print=') || a.startsWith('--exec='))
      ? Math.max(argv.indexOf('-p'), argv.indexOf('--print'), argv.indexOf('--exec')) + 1
      : -1;
  // O objetivo posicional é o 1º token que NÃO é flag NEM valor de
  // --tier/--lang/--model/--output-format/-p/--resume/--max-tokens/--max-iterations/--max-output-tokens.
  const goal = argv.find(
    (a, i) =>
      !a.startsWith('-') &&
      i !== tierValueIdx &&
      i !== langValueIdx &&
      i !== backendValueIdx &&
      i !== localProviderValueIdx &&
      i !== localModelValueIdx &&
      i !== localAuthValueIdx &&
      i !== localBaseUrlValueIdx &&
      i !== modelValueIdx &&
      i !== providerValueIdx &&
      i !== effortValueIdx &&
      i !== outputFormatValueIdx &&
      i !== printValueIdx &&
      i !== resumeValueIdx &&
      i !== maxTokensValueIdx &&
      i !== maxIterationsValueIdx &&
      i !== maxOutputTokensValueIdx &&
      i !== autoCompactAtValueIdx &&
      i !== cyclesValueIdx &&
      i !== cycleForValueIdx,
  );

  const resume = hasContinue
    ? ({ kind: 'continue' } as const)
    : hasResume
      ? ({ kind: 'resume', ...(resumeId !== undefined ? { id: resumeId } : {}) } as const)
      : undefined;

  // F109 — TODOS os índices de argv que são VALOR de uma flag separada (não são typo).
  const valueIndices = new Set<number>(
    [
      tierValueIdx,
      langValueIdx,
      backendValueIdx,
      localProviderValueIdx,
      localModelValueIdx,
      localAuthValueIdx,
      localBaseUrlValueIdx,
      modelValueIdx,
      providerValueIdx,
      effortValueIdx,
      outputFormatValueIdx,
      printValueIdx,
      resumeValueIdx,
      maxTokensValueIdx,
      maxIterationsValueIdx,
      maxOutputTokensValueIdx,
      autoCompactAtValueIdx,
      cyclesValueIdx,
      cycleForValueIdx,
    ].filter((i) => i >= 0),
  );
  // F109 — o token logo após uma flag de VALOR SEPARADO é o valor (prompt/slug/url/nº),
  // texto arbitrário que PODE começar com `--` (ex.: `-p "--algo"`). Exclui INCONDICIONAL-
  // MENTE (mesmo quando o parser não o capturou por parecer flag) p/ não falso-positivar.
  for (const vf of VALUE_TAKING_FLAGS) {
    const idx = argv.indexOf(vf);
    if (idx >= 0 && !argv[idx]!.includes('=')) valueIndices.add(idx + 1);
  }
  const unknownFlags = detectUnknownFlags(argv, valueIndices);

  return {
    kind: 'launch',
    mode,
    unsafe: mode === 'unsafe', // legado: derivado do eixo (Plan zera o unsafe)
    unsafeAliasUsed, // EST-0959 — p/ o binário avisar "`--unsafe` agora é `--yolo`"
    ...(unknownFlags.length > 0 ? { unknownFlags } : {}),
    dense,
    fresh,
    subAgents,
    safeGlyphs,
    telegram, // ADR-0134/0135 — ativa a bridge Telegram no boot (dormente sem token).
    print, // EST-1007 — modo headless one-shot (`-p`/`--print`/`--exec`).
    ...(split !== undefined ? { split } : {}),
    ...(fullscreen !== undefined ? { fullscreen } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(tier !== undefined ? { tier } : {}),
    // ADR-0120 — backend de modelo (broker default | local BYO). Cru; o wiring resolve.
    ...(backend !== undefined ? { backend } : {}),
    // ADR-0120 — config do provider do backend local (só sob backend:local). Cru.
    ...(localProvider !== undefined ? { localProvider } : {}),
    ...(localModel !== undefined ? { localModel } : {}),
    ...(localAuth !== undefined ? { localAuth } : {}),
    ...(localBaseUrl !== undefined ? { localBaseUrl } : {}),
    ...(model !== undefined ? { model } : {}),
    // EST-0962 (`--provider`) — NOME do provider (só entra quando a flag veio E pareada com
    // `--model`, já garantido pelo gate acima). Só o NOME (DADO, não credencial — HG-2).
    ...(provider !== undefined ? { provider } : {}),
    // EST-0962 (`--effort`) — reasoning_effort PASSTHROUGH (sem tier-gate). Já validado
    // (não-vazio, ≤32 chars). undefined ⇒ não veio na linha de comando.
    ...(effort !== undefined ? { effort } : {}),
    ...(printArg !== undefined ? { printArg } : {}),
    ...(outputFormat !== undefined ? { outputFormat } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(selfCheck !== undefined ? { selfCheck } : {}),
    ...(autoCompactAt !== undefined ? { autoCompactAt } : {}),
    ...(quiet !== undefined ? { quiet } : {}),
    ...(cycle !== undefined ? { cycle } : {}),
    // EST-1019 — tetos do CICLO via flags de boot (`--cycles`/`--cycle-for`). Cru aqui; o
    // wiring resolve/valida e a flag VENCE o teto embutido no goal quando divergem.
    ...(cycles !== undefined ? { cycles } : {}),
    ...(cycleFor !== undefined ? { cycleFor } : {}),
  };
}
