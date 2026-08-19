# Changelog

Todas as mudanças relevantes do `aluy` (binário) e dos pacotes do monorepo
(`@hiperplano/aluy-cli`, `@hiperplano/aluy-cli-core`) ficam registradas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/). Os pacotes são versionados
em **sincronia** (mesma versão em `@hiperplano/aluy-cli`, `@hiperplano/aluy-cli-core` e nas constantes
`CLI_VERSION`/`CORE_VERSION`).

> **Distribuição:** entrega **monolítica** — o usuário instala só `@hiperplano/aluy-cli`
> (binário `aluy`); o `@hiperplano/aluy-cli-core` entra **bundlado**, não é publicado
> standalone.

## [Não lançado]

## [1.0.0-rc.138] — 2026-08-19

### Corrigido

- 🧠 **O aluy jogava fora o RACIOCÍNIO do modelo — e com ele, às vezes, o turno inteiro:** modelo de raciocínio manda pensamento e resposta em campos DIFERENTES, e o `content` fica NULO enquanto ele pensa. Medido em dois provedores distintos servindo o MESMO `deepseek-v4-pro`: 15 a 18 chunks só de raciocínio antes do primeiro token de fala. O adapter lia apenas `content` — a palavra `reasoning` não existia em lugar nenhum do código — então a tela ficava vazia durante todo o trabalho do modelo, e ficava vazia PARA SEMPRE quando o turno acabava dentro do raciocínio (`finish_reason: 'length'`, `content: ""`): `Λ aluy` e nada, sem uma palavra de explicação. Não havia padrão de nome a seguir, então as três grafias em uso passam a ser aceitas — `reasoning_content` (convenção da DeepSeek e dos relays que servem o upstream cru), `reasoning` (como o OpenRouter normaliza — MEDIDO, não suposto) e `thinking_delta` (Anthropic, que o adapter conhecia e descartava de propósito). O pensamento vai num canal PRÓPRIO: aparece esmaecido enquanto o modelo trabalha, vira uma linha-resumo quando ele responde, e PERMANECE quando não houve resposta — que é justamente o caso que produzia o bloco mudo. Nunca entra no texto final do turno: rascunho não é resposta, e esse texto é o que vira histórico, resumo e contexto das chamadas seguintes. Fica fora do detector de degeneração e do teto de bytes pelo mesmo motivo — eles medem a FALA, e um raciocínio longo é normal nesses modelos.
- 🔌 **O canal novo morria no meio do caminho, em silêncio — e a causa era uma lista escrita à mão:** o evento nascia no adapter, atravessava o client (medido: 15 eventos emitidos) e desaparecia no wiring, que encaminhava ao controller um objeto com cinco callbacks digitados um a um. Quem adiciona um canal ao `StreamSink` e esquece de somá-lo ali não recebe erro nenhum: o evento simplesmente não existe do controller para cima. É a MESMA classe do `upstreamByModel` da rc.137 (campo lido e nunca usado). O conserto não foi somar a linha faltante — foi trocar a lista por DELEGAÇÃO (`delegatingSink`), que encaminha todo canal por construção; o alvo segue resolvido por chamada, porque o controller nasce depois do caller.
- 🔁 **Reinstalar forçava o modelo ANTIGO:** relato do dono — "instalei setando outro modelo e ele forçou o mesmo". O onboarding só gravava `localModel` quando o campo não estava vazio, e `store.save` é MERGE: numa máquina que já tinha instalação, o modelo da instalação anterior sobrevivia intacto. Como a resolução dá precedência a `config.localModel` sobre o `defaultModel` do provider, o modelo VELHO vencia o provider NOVO que o dono acabara de escolher — em silêncio. Em máquina limpa não havia valor velho, então o sintoma só aparecia em REINSTALAÇÃO, que é exatamente como ele o descreveu. Agora o onboarding sempre RESOLVE o campo: grava o modelo escolhido ou LIMPA (`undefined` no patch sobrescreve o disco — mecanismo já documentado no store), e a resolução cai no default do provider escolhido. A decisão virou função pura exportada (`resolveOnboardLocalModel`) para ter teste, seguindo a disciplina do `mcpCatalog` (a UI/Ink em si se verifica no TTY).

## [1.0.0-rc.137] — 2026-08-19

### Corrigido

- 🧊 **A TUI congelava e não respondia mais nada (o dono trocou p/ `/fullscreen` e mandou uma mensagem):** uma linha-fonte patológica — JSON numa linha só, base64, `!cat` de um bundle minificado — faz o `wrap-ansi` rodar por SEGUNDOS numa ÚNICA chamada (medido: ~500 mil chars ⇒ vários segundos só no wrap cru), e ele é usado tanto pelo `wrappedLineCount` do cockpit quanto pelo PRÓPRIO Ink ao medir `<Text wrap>`. O bloqueio é SÍNCRONO: não digita, não responde, e nem o watchdog de timeout de um teste dispara (um timer não roda com o event loop preso) — que é literalmente "congelou e não respondeu mais nada". O gatilho é que `windowTailVisual` SÓ janelava quando `maxLines` estava definido, e o turno CONCLUÍDO passa `maxLines: undefined` DE PROPÓSITO ("nada se perde": o histórico mostra o bloco inteiro) — então a linha patológica ia intacta pro `<Markdown>` sem nunca passar por lá. Agora há um piso POR-LINHA (`capSourceLineChars`, 4000 chars, corte por code point p/ nunca partir um par surrogate) aplicado SEMPRE, independente de `maxLines`/`columns`, mais o mesmo teto no `<ToolLine>` e no `<BangBlock>` — os dois renderizavam `output.split('\n')` CRU, sem janela nenhuma, na saída CONCLUÍDA. O fullscreen agravava porque o laço de encolhimento do `clipConversaBlock` re-mede a cada iteração, multiplicando o custo por ~15-20×.
- 📋 **Colar dentro de um picker caía no COMPOSER escondido atrás dele:** em `/provider` → "+ adicionar provider custom", colar a URL não ia pro campo do formulário — ia pro composer de cima. A causa: o canal de bracketed-paste roda ANTES do Ink, direto no `stdin`, e não passava pelo MESMO switch de foco que o `useInput` usa p/ rotear cada TECLA ao modal certo; a colagem sempre terminava em `insertPaste`. Não era bug só do `/provider`: TODO modal com campo de texto PRÓPRIO tinha o mesmo furo (`localModelPicker`, `palette`, `modelPicker`, `effortPicker` e a pergunta livre do `perguntar`) — o `@`-mention escapava por ler a query DO composer. Agora a colagem é roteada pelo mesmo critério de foco e na mesma ordem de precedência, e num picker que é só LISTA (tema/idioma/histórico/permissões) ela é IGNORADA: o usuário não vê pra onde o texto foi, então sumir é pior que não fazer nada. Fim de linha sobrando no clipboard é retirado nos campos de UMA linha, o que `appendCustom` já fazia sozinho.
- 🧩 **Tool nativa recusava o que o modelo barato erra na FORMA, e não dizia o que tinha chegado:** medido com um modelo tentando `update_plan` QUATRO vezes seguidas, idêntico, até desistir do plano — o erro dizia o que ele deveria mandar, nunca o que ele tinha mandado, então não havia o que corrigir. Duas classes, as duas espalhadas por quase toda tool: (1) array aninhado STRINGIFICADO (`steps: "[{…}]"` — o mais comum: o modelo estrutura o objeto de fora e serializa o de dentro), objeto de chaves numéricas no lugar de array, booleano como texto, número onde se espera string; (2) mensagem de erro sem o `Recebi:`. O conserto virou módulo (`input-shape.ts`) e alcança `read_file`, `edit_file`, `write_file`, `run_command`, `run_tests`, `grep`, `glob`, `change_dir`, `session_command`, `add_todo`/`done_todo`, `spawn_agent` e `perguntar`. A REGRA que governa: recuperar só quando a intenção é INEQUÍVOCA, nunca inventar quando é ambígua — `steps: "um passo só"` segue RECUSADO (um plano plausível com um passo lixo é pior que uma recusa), e `content` NÃO entra como sinônimo de `new_string` no `edit_file` porque era o nome do campo na API antiga de reescrita total, removida por perda de dados. No `perguntar` havia um agravante: `options` irreconhecível degradava em SILÊNCIO p/ `kind:'text'` — as opções sumiam e o modelo nunca ficava sabendo; agora é erro visível.
- 🛣️ **Roteamento de upstream declarado no config era ignorado em silêncio:** o caso é "quero o modelo X servido pela gmicloud, não por outro revendedor do OpenRouter". `providers[].upstreamByModel` já era lido e sanitizado do `~/.aluy/config.json`, e o adapter já sabia mesclar um `extraBody` cru no corpo — mas NADA ligava um no outro: o dono declarava o upstream e a requisição saía sem ele, sem erro, sem aviso. O fio agora existe ponta a ponta (config → `LocalProviderConfig` → `LocalRequest.extraBody` → corpo), com a consulta POR REQUEST sobre o slug ATIVO: o `/model` troca o modelo sem reconstruir o client, então resolver no boot congelaria o roteamento do primeiro modelo em todos os seguintes. O `/provider` relê o mapa do provider NOVO, e o sub-agente roteado a um modelo local sai pelo MESMO upstream do pai. O aluy NÃO INTERPRETA o fragmento — roteamento de upstream não é parte do protocolo OpenAI e cada agregador inventou o seu dialeto; o dono escreve o do provider que escolheu e o aluy repassa, sem jamais sobrescrever `messages`/`model`/`stream`.
- 🏷️ **"tokenrouter" parecia um provider suportado e não era:** relato do dono, "tokenrouter aparece na lista de instalação mas não em `/provider`". Não havia dessincronia nenhuma — o nome era só o EXEMPLO do campo livre de id, mas por ser marca REAL (e o site ter um card apontando pra tokenrouter.com) lia como opção da lista, ao lado de itens de verdade. Trocado por placeholder obviamente genérico no onboarding e nos dois catálogos de i18n; `vLLM` saiu pelo mesmo motivo.
- 🅰️ **O onboarding desenhava uma marca e o terminal abria com outra:** instalar e abrir acontecem no mesmo minuto, e a `<Wordmark>` plana do onboard não era a sombreada do splash. Passa a espelhar a decisão do `<SplashScreen>` (3D quando o terminal comporta, plana como fallback fiel), sem animação — aqui a marca é identidade, e o brilho varrendo competiria com a lista de escolha logo abaixo.
- 📐 **Piso de colunas no cockpit:** na TROCA de modo/resize existe uma janela real em que `stdout.columns` chega 0/`undefined`/negativo antes do próximo layout assentar, e `columns - indent` vazava negativo. Não havia crash (as funções de baixo já clampavam), mas a proteção ficava a 2-3 chamadas do ponto onde o número nasce. Agora a garantia é LOCAL, no lugar onde a subtração acontece, com `Number.isFinite` cobrindo NaN/Infinity.

## [1.0.0-rc.136] — 2026-08-15

### Corrigido

- 🪟 **O cofre em arquivo era inutilizável no Windows (dois defeitos medidos em Win 11 real, não deduzidos de documentação):** (1) NTFS não tem modo POSIX — `writeFileSync({mode:0o600})` e `chmodSync` são praticamente no-ops e o `statSync().mode` reporta `0o666`; com a checagem `(mode & 0o077) !== 0` incondicional, o cofre GRAVAVA o arquivo e recusava LER o que ele mesmo tinha acabado de gravar, toda vez, para todo usuário Windows. `platform` virou opção injetável e a checagem é pulada em `win32` — pular não é afrouxar a regra, é parar de FINGIR que a verifico (proteção real ali é ACL, outro mecanismo); a CIFRA, que é a defesa que importa contra cópia, segue igual nas três plataformas, e no POSIX a recusa continua valendo com teste que a exige. (2) `renameSync` falha com `EPERM` no Windows quando alguém mantém o alvo aberto (antivírus varrendo, indexador, outra instância) e deixava um `credentials.enc.tmp-<pid>-<ts>` órfão no disco com a credencial cifrada dentro — agora há retry com espera crescente (o lock é transitório) e limpeza no `finally`, que cobre também o caminho de exceção. Validado com controle na máquina do dono: alvo travado por 500ms ⇒ falha `EPERM`; por 100ms ⇒ a escrita vence em 137ms e lê o valor de volta.
- 🔢 **`version.ts` ficou para trás na rc.135:** ele é GERADO por `scripts/gen-version.mjs` a partir do `package.json`, o bump foi feito e o gerador não rodou — a rc.135 publicada se reportava como rc.134. A suíte verde de ANTES do bump escondeu isso; o `version-sync.test.ts` pegou depois. Regenerado.

## [1.0.0-rc.135] — 2026-08-15

### Adicionado

- 🔐 **Cofre em arquivo CIFRADO — credencial que sobrevive ao reboot sem lock-in de SO:** em servidor recém-instalado o `aluy login` gravava a chave e ela sumia. O próprio aviso F165 já explicava: sem Secret Service o `@napi-rs/keyring` cai no keyring do KERNEL, que é MEMÓRIA — e servidor headless é justamente onde Secret Service nunca existe, então o fallback dava MENOS durabilidade sem dar mais segurança. O CLI-SEC-2 foi EMENDADO, não revogado (ver `CLAUDE.md`, Regra 3): a regra proíbe credencial EM CLARO, não arquivo cifrado, e exigir keychain do SO era lock-in. Agora `~/.aluy/credentials.enc` (AES-256-GCM, `0600`, chave por HKDF do machine-id + usuário) é lugar legítimo, e o keychain do SO passa a ser ACELERADOR — usado quando existe e não é volátil, nunca requisito. A propriedade que justifica o arquivo: a chave deriva do machine-id, que NÃO viaja junto — um `tar` de `~/.aluy`, snapshot de disco, imagem de container ou `scp` levam um blob inútil, enquanto um `0600` puro sai inteiro e útil em qualquer cópia. O que NÃO protege, dito no código: contra processo com o MESMO UID não adianta (ele deriva a mesma chave) — nenhum cofre local resolve isso, keychain destravado inclusive; o que se compra é o vetor de CÓPIA. Três caminhos de erro, nenhum silencioso: blob de outra máquina (o GCM recusa o auth tag) manda refazer o login; machine-id ilegível cai para env; permissão mais aberta que `0600` é RECUSADA com o `chmod 600` na mensagem — sem consertar sozinho, porque permissão frouxa é sinal de que algo copiou o arquivo.

### Corrigido

- 🔑 **A API key vazava em texto claro quando o prompt era interrompido:** o relato do dono é o que resolveu o diagnóstico — "não aparece na hora de colar; quando eu dei Ctrl-C mostrou TODAS as vezes que eu tinha colado". Uma chave real ficou visível no terminal e teve de ser rotacionada. A causa NÃO era a supressão de eco: sem um listener de `SIGINT` no `rl`, o readline tem um fallback PRÓPRIO para Ctrl-C — `close()` interno, silencioso — que devolve o tty ao modo cooked (eco do KERNEL ligado de novo) e NUNCA dispara o callback do `rl.question()` pendente. O `await` fica pendurado para sempre: o processo segue vivo, mudo, com o terminal já ecoando — e dali em diante o mute de `rl.output.write` nem chega a rodar, porque o readline não repassa mais nada. Sem entender que o prompt tinha travado, o dono colou de novo, e cada tentativa foi despejada em claro. Registrar o listener muda o padrão (o readline emite `SIGINT` para NÓS decidirmos em vez de sumir sozinho); o mute também endureceu (o filtro antigo deixava passar tudo que CONTIVESSE o texto do prompt — uma condição a errar) e os streams ficaram INJETÁVEIS, que é o que torna a propriedade verificável: o comentário antigo admitia "supressão de eco (…) é frágil e SEM teste direto", e foi assim que quebrou calada. Sem o conserto os três testes de regressão falham por TIMEOUT — o timeout É o bug.
- ➕ **"+ adicionar provider" não fazia nada:** "clico na opção e não acontece nada" — sem erro, sem navegação. `confirm()` chamava `setOpen(false)` INCONDICIONALMENTE, mas "+ adicionar" não é escolha final: a App recebe o nome de volta, reconhece o sentinela e chama `startAddCustom()` p/ reusar o MESMO picker como formulário. Como o picker já tinha fechado, o passo `id` era armado com `open=false` e o formulário nunca desenhava — Enter virava no-op silencioso. Os testes não pegaram porque chamavam `startAddCustom()` ISOLADO, nunca pelo caminho que a App percorre: o caminho testado não era o caminho executado, e o teste novo dirige o fluxo REAL.

## [1.0.0-rc.134] — 2026-08-06

### Corrigido

- ⏱️ **`activity-timeout` aceita as duas línguas — e FALA quando não entende:** a chave é inglês (`activity-timeout`) e o único valor aceito era português (`sem-teto`). O dono escreveu `activity-timeout: unlimited`, que é o que a chave induz a escrever; o valor caiu no `parseDuration`, virou `undefined`, e o caller usou o default de 30min EM SILÊNCIO — sem aviso no log, sem aparecer em "campos ignorados", sem sair no `service status`. O efeito não foi cosmético: a vigília do serviço de execução bloqueia até um horário do relógio (~40min por janela), estourou o teto de 1800s que não deveria existir, o turno encerrou em `limit` e o runner derrubou os 10 daemons junto — a mesa fechou às 14:21 num pregão que ia até 17:40, e ninguém percebeu por 25 minutos. Agora `unlimited`/`none`/`off` valem junto com `sem-teto`, e valor não reconhecido gera aviso no `runner.log` citando o que foi escrito, o que vai acontecer no lugar (30min) e a grafia certa.
- 🛡️ **A mesa não morre mais com o supervisor:** o runner derrubava os daemons no fim de TODO turno, embora a linha do log dissesse "fim do expediente" — não era só o texto que estava errado, era o comportamento. Quando a atividade acima estourou o teto, os 7 daemons que sustentavam a execução (bridge MT5, 5 estratégias, guarda de posição), todos SAUDÁVEIS, morreram junto: o MOTOR morreu porque o ACESSÓRIO adoeceu, que é a inversão exata de prioridade para um serviço que opera dinheiro. `until:` é o que define EXPEDIENTE — enquanto a janela está aberta, fim de turno agora MANTÉM os daemons (o `startDaemons` é idempotente e pula o que já vive), e a derrubada só acontece quando o expediente fecha. A soneca passou a acordar no que vier PRIMEIRO (próximo turno ou fim do expediente), senão um turno que terminasse cedo deixaria a mesa de pé a noite inteira. Serviço SEM `until:` declarado não muda em nada: cada turno é o expediente e a derrubada segue no fim dele.

- 📓 **O log do serviço mostra o que ACONTECEU, não só o que falhou:** o dono abriu o `runner.log` de um pregão inteiro e encontrou 83 linhas — só fronteiras de atividade e subida de daemon (45 daemon · 13 atividade · 5 runner · 3 acordou · 3 attach · 2 turno). As 17 tools POR ATIVIDADE que fizeram o trabalho estavam gravadas em `.state/sessions/*.json`, JSON de transcrição que ninguém abre para auditar um dia de operação; no log, nada. Palavras dele: "não consigo ver efetivamente o que aconteceu em cada atividade". A causa era uma decisão anterior, escrita no próprio código ("Só ERRO: sucesso continua fora do log, para não afogar o diagnóstico no ruído"): otimizava para DIAGNOSTICAR FALHA quando um serviço autônomo que opera dinheiro precisa de AUDITORIA — numa mesa, o passo que DEU CERTO é exatamente o que se precisa reler depois ("por que fechou aquela posição às 14:20?"). Agora toda tool entra no `runner.log`, e a fala final de cada atividade também (é ela que diz o que o agente concluiu), CLAMPADA a uma linha por `clampLinhaDeLog` — log se lê com `tail`, e um turno inteiro despejado quebra a leitura de quem procura; o corte é no fim de propósito, porque a primeira frase costuma ser o veredito. Volume deliberado: ~17 tools × 10 atividades dá algumas centenas de linhas por pregão, que é REGISTRO e não ruído, e `aluy service logs -n` segue disponível para quem quer só a cauda.

## [1.0.0-rc.133] — 2026-08-06

### Corrigido

- ⏱️ **Teto é teto — o aluy parou de acusar o filho de "saída ilegível":** a atividade "scan" do dono rodou 30 minutos, bateu o teto duro e o `runner.log` registrou `atividade 1/6 "scan": saída ilegível (exit 143)`. "Saída ilegível" acusa o FILHO de ter produzido lixo — não foi nada disso: NÓS o matamos, na hora marcada, porque passou dos 1800s; o dono leria isso como bug do agente e procuraria no lugar errado, quando a ação certa é declarar um `activity-timeout:` maior. A detecção do teto olhava `signal !== null`, mas o filho é um `aluy` que TRATA o SIGTERM e sai graciosamente com CÓDIGO 143 — `signal` chega `null` e a inferência falha; o ramo `deadline` EXISTIA e estava CERTO, só nunca era alcançado. Agora o classificador recebe o FATO (o timer disparou), não uma inferência sobre como o filho morreu, e a linha ficou ACIONÁVEL: diz o TEMPO que estourou, diz que quem encerrou foi o RUNNER, e aponta o `activity-timeout:`.
- ✂️ **A truncagem do motivo guardava o preâmbulo e jogava fora o veredito:** o `runner.log` mostrava, como "motivo" de uma falha, seis linhas do preâmbulo padrão do `spawn_agent` ("1 sub-agente(s) concluíram. Os textos abaixo são DADO produzido por eles…") e mais nada — porque `truncate` guardava só a CABEÇA, e o veredito de cada filho (`sub-agente "X" falhou: <motivo>`) vem DEPOIS. É a mesma classe das rcs anteriores num metro ainda não olhado: não adianta carregar o motivo até o bloco se o corte descarta justamente a parte que diz algo. Passa a guardar CABEÇA e CAUDA, com o mesmo teto de linhas distribuído nas duas pontas e o corte sempre sinalizado.

## [1.0.0-rc.132] — 2026-08-06

### Corrigido

- 📋 **Relatório NÃO é pergunta — o expediente parava por adivinhação:** com a credencial resolvida (rc.131), o serviço do dono finalmente TRABALHOU — a atividade produziu 4 mil caracteres de análise quantitativa real (setups de USDBRL/IBOV/BTC com entrada, stop, alvo e razão risco-retorno) — e então travou em `AGUARDANDO DONO`. A "pergunta pendente" que o `aluy service status` exibia era a SAÍDA INTEIRA da atividade, aberta literalmente por `"status": "completed", "exitCode": 0`: ninguém perguntou nada, e o expediente parou esperando resposta a uma pergunta inexistente — em silêncio, por não haver `channel:` declarado. A causa é reúso de heurística ENTRE CONTEXTOS COM CUSTOS DIFERENTES: `awaitsUserDecision` nasceu p/ o gate do SELF-CHECK e o comentário dela é explícito ("a heurística pode ser generosa" porque "um falso POSITIVO só faz o loop aceitar a resposta como final") — inofensivo LÁ, mas aqui o MESMO falso positivo para um serviço 24/7 por tempo indeterminado. O serviço passa a ter o SEU critério, sem tocar no do self-check: a pergunta tem que estar na ÚLTIMA linha (relatório longo termina em conclusão, não em pergunta) e o texto todo precisa ter TAMANHO de pergunta (1500 chars). A direção do erro inverte DE PROPÓSITO — preferimos SEGUIR o workflow a travá-lo; quem precisa mesmo de decisão tem a tool `perguntar`, que é sinal EXPLÍCITO e não adivinhação sobre prosa. Um teste trava a divergência: o MESMO texto que o serviço agora ignora continua sendo "espera o usuário" p/ o self-check.

## [1.0.0-rc.131] — 2026-08-06

### Corrigido

- 🔐 **O runner SEGURA a credencial — a atividade 2 não morre porque a 1 rodou:** já na rc.130, o serviço do dono fez `atividade 1/6 "scan": ok.` e, DOIS SEGUNDOS depois, `atividade 2/6 "traduzir": erro — o keychain do SO NÃO respondeu (Couldn't access platform storage: KeyRevoked)`. O `/proc/keys` da máquina fecha o caso: `user keyring:openrouter:apikey@aluy-cli-local: 73` + `expd _ses: empty` — o backend do keychain ali é o keyring do KERNEL (keyutils, máquina sem Secret Service: a condição que o F165 já detecta e avisa no login), preso a keyrings de SESSÃO que expiram. Como cada atividade é um processo NOVO que relê a credencial do zero, o serviço vivia à mercê de qual sessão ainda estava viva — e o cache em memória da rc.130 não alcança este caso (morre junto com o processo, que é justamente a atividade). O RUNNER é o único que dura o expediente inteiro: resolve UMA vez e sustenta os filhos pelo catch-all `ALUY_LOCAL_API_KEY` que o resolvedor já consultava. É ÚLTIMO DEGRAU (keychain e env próprias do filho vêm antes — se o dono exportou a chave, a dele vence) e credencial VAZIA não é injetada (`''` faria o filho achar que tem chave e falhar depois com mensagem pior). TRADE-OFF EXPLÍCITO: env de processo é legível por `/proc/<pid>/environ` — 0400, MESMO usuário; o keychain protege contra OUTRO usuário e contra roubo em repouso, e isso segue valendo (nada em disco, nada em log, nem a chave nem o tamanho dela), sendo que a chave já precisa estar na memória do filho de qualquer forma. A resolução é PREGUIÇOSA (1º turno) e não no boot: um `await` entre o "runner iniciado" e o registro do `onSignal` abria uma janela real em que um SIGTERM chegava SEM handler — foi o teste de sinal que mostrou. NÃO substitui o conserto durável do ambiente (Secret Service instalado ou env var exportada): torna o serviço resiliente enquanto o runner vive.

## [1.0.0-rc.130] — 2026-08-06

### Corrigido

- 🔑 **Um blip do keychain não derruba mais um serviço 24/7 (a causa RAIZ do serviço do dono morrendo há dias):** o `runner.log` mostrava `sub-agente "macro" falhou: backend local: sem credencial apikey p/ "openrouter". configure a chave: …` com a chave PRESENTE no keychain o tempo todo — 73 caracteres, lida sem erro nenhum no MESMO ambiente do runner (reconstruído de `/proc/<pid>/environ`), pelo MESMO `@napi-rs/keyring`, segundos depois; e turnos INTERCALADOS passavam (02:10 concluiu uma atividade, 03:55 e 04:00 morreram). Três defeitos empilhados: (1) a credencial é resolvida a CADA requisição — por design, p/ pegar rotação de chave sem reiniciar — e sem cache UM blip do Secret Service derruba o turno inteiro, que num serviço é o expediente; (2) `readKeychain` engolia QUALQUER exceção e devolvia `undefined`, então "não tem entrada" e "não consegui ler" viravam a MESMA coisa; (3) por causa de (2), a mensagem mandava "configure a chave" — conselho ERRADO quando a chave já está lá, fazendo o dono reconfigurar o que já estava certo e o sintoma voltar no blip seguinte. Agora a leitura DISTINGUE ausência de avaria; uma credencial que o keychain entregou de verdade fica memorizada EM MEMÓRIA do processo (nunca em disco/log — CLI-SEC-7 intacto; é a mesma exposição que já existe enquanto a chave viaja em cada requisição) e só é USADA quando a leitura FALHA e não há env; e o erro restante aponta o Secret Service com o motivo CRU do backend em vez de mandar reconfigurar. A ROTAÇÃO continua soberana (leitura boa sempre atualiza o cache, `storeApiKey` idem) e `forgetCachedApiKey` é o ponto de invalidação p/ logout/revogação. Só foi possível achar porque as três rcs anteriores tornaram o erro VISÍVEL — a linha que revela tudo é literalmente o ALVO-MUDO + a cauda do ATTACH-CEGO + o motivo do provider, juntos.

## [1.0.0-rc.129] — 2026-08-06

### Corrigido

- 🕰️ **O DESFECHO do turno headless é DESTE turno — não de um turno antigo (o pior achado da rodada):** na máquina do dono, DUAS execuções headless devolveram `aluy: erro de broker: não consegui falar com o provider local.` + `{"result":"","ok":false}` — e as DUAS tinham terminado BEM (a transcrição prova: blocos 1111-1114 = `you: responda apenas: ok` → `aluy: ok`, duas vezes). O erro citado era UM bloco só, no índice 1110, de horas antes, de uma sessão de TUI. A extração do resultado varria `controller.blocks` INTEIRO, e numa sessão retomada (`--resume`/`--continue`) essa lista COMEÇA com a transcrição antiga restaurada: o primeiro `broker-error` encontrado, de qualquer época, virava o veredito do turno atual — um `ok:false` grudado PARA SEMPRE numa sessão que um dia teve falha de rede. O ESPELHO é pior: o laço da fala final também varria tudo para trás, então um turno só-tool devolvia a RESPOSTA DO TURNO ANTERIOR como resultado — um sucesso INVENTADO, com texto plausível e sem relação com o pedido. Contamina QUALQUER consumidor do contrato JSON, inclusive o runner de serviço (que lê exatamente esse `{"result":…,"ok":…}` para decidir se a atividade passou). Ambos os caminhos (`runHeadlessPrint`, `runHeadlessStreamJson`) passam a ancorar `controller.blocks.length` ANTES do submit e a olhar só o que veio depois; turno sem bloco nenhum cai no "sem fala final", o desfecho honesto. Dois fakes de teste foram corrigidos: o getter `blocks` devolvia o snapshot FINAL mesmo ANTES do submit — infidelidade à dimensão TEMPO, justamente a que o bug explorava; nenhuma asserção foi afrouxada.

## [1.0.0-rc.128] — 2026-08-06

### Corrigido

- 🔇 **No BYO local, o erro do provider passa a dizer o MOTIVO:** a sessão do dono parou com `provider local indisponível / não consegui falar com o provider local.` e MAIS NADA — sem status, sem causa, sem log em lugar nenhum (`ALUY_DEBUG_RENDER` é só de render). Nem com o código do aluy na frente dava p/ diagnosticar sem reproduzir a chamada À MÃO, por fora da ferramenta. A regra "nunca ecoa `err.message` cru" existe pela invariante HG-2: no broker HOSPEDADO a mensagem não pode revelar QUAL vendor atende o tier (roteamento multi-tenant é segredo do serviço). No backend LOCAL isso NÃO se aplica — o provider é do PRÓPRIO DONO, endpoint e credencial dele; esconder a razão ali não protege ninguém, só cega quem tem o poder de corrigir. Não é precedente novo: o MESMO classificador já abre exceção idêntica no 422 ("é o usuário que precisa corrigir a entrada, então a frase útil tem que chegar a ele"). O motivo vai REDIGIDO (`redactOutputSecrets`, CLI-SEC-6 — um corpo de erro de provider pode ecoar o payload e junto o `Authorization`) e CLAMPADO a uma linha de 240 chars; vale p/ os dois caminhos cegos (transporte e inesperado). O lado HOSPEDADO fica intacto, travado por teste: causa crua não vaza no broker e o default do parâmetro segue `broker`.

## [1.0.0-rc.127] — 2026-08-06

### Corrigido

- 👻 **O aluy parava de INVENTAR falha — `running` não é `err` (achado rodando o serviço do dono):** o `runner.log` mostrava `[tool] spawn_agent  → err` para um `spawn_agent` que estava trabalhando NORMALMENTE — 3 processos filhos vivos naquele instante, atividade concluindo "ok" minutos depois, e `output` vazio porque não havia erro para ter motivo. Ele passou horas caçando um erro que NUNCA EXISTIU. A cadeia: `sanitizeBlock` demovia `running`→`err`, sob a premissa "a sessão restaurada é inerte, não há tool em voo" — VERDADEIRA quando o save só acontecia no FIM do turno; a FASE 4 (attach) fez o autosave rodar DURANTE o turno, justamente p/ o dono ver ao vivo, e a mesma linha passou a carimbar "falhou" em cima de "está trabalhando". O saneamento agora é FIEL; a demoção de ÓRFÃO continua onde é VERDADE (`sanitizeOrphans` na fronteira de entrada do controller, e `blocksToHistory` com "interrompido" — nem falha inventada, nem espera eterna); lixo/desconhecido segue virando `err`, fail-closed.
- ⏳ **O DESFECHO que nunca chegava (mesma família):** o tail do attach avança por `slice(emittedCount)` e um bloco resolve IN PLACE (o `resolveToolLine` SUBSTITUI a linha viva, não empurra outra) — sem reemissão, corrigir o item acima só trocaria um erro falso por um silêncio: o dono ficaria com "…processando" para sempre. `pollNewServiceBlocks` passa a acompanhar os blocos sem desfecho e a reemitir quando resolvem, com o MOTIVO em caso de falha.
- ✂️ **A RESPOSTA cortada (mesma família):** `streaming` era forçado a `false` no save, declarando "resposta completa" sobre um texto que ainda estava chegando — o attach emitia o pedaço parcial e nunca mais o corrigia, e o dono lia uma frase cortada no meio como se fosse a resposta final.
- 🎯 **`spawn_agent` diz QUAL agente (ALVO-MUDO):** repare nos DOIS espaços em `spawn_agent  → err` — o alvo era vazio. `targetOf` só conhecia `command`/`path`/`pattern`/`question` e o input do spawn é `{agents:[{label?,goal,agent?}]}`; o dono sabia QUE uma delegação falhou, nunca QUAL. Numa cadeia macro→quant→data-engineer→backtest, é a diferença entre um log diagnosticável e um log inútil.
- 🔗 **FONTE ÚNICA do alvo:** `controller.targetOfCall` (que rotula a linha VIVA `◌`) era uma CÓPIA da lógica do alvo, com um comentário jurando "MESMA regra do `tool-reporter.targetOf`" — e a cópia JÁ tinha divergido: sem o ramo de `question`, um `perguntar` em voo aparecia sem alvo e ganhava um ao resolver. Como a resolução é in-place, isso é uma linha trocando de identidade na frente do dono. Passa a ser UMA função.

## [1.0.0-rc.126] — 2026-08-05

### Adicionado

- 📂 **`workspace:` no `service.md` — o serviço declara ONDE trabalha (achado em produção):** o runner spawna cada atividade com `cwd: serviceDir`, então a raiz do workspace é a pasta do SERVIÇO — e o trabalho do dono está em outro diretório. O `runner.log` dele mostrava `[tool] glob /home/aluy/projects/fluider → erro: acesso fora do workspace bloqueado`. A cerca estava funcionando como projetada (é ela que torna `autonomy: yolo-scoped` seguro); faltava poder ABRIR A PORTA CERTA, explicitamente — o `/add-dir` já existia, mas é comando de SESSÃO e um serviço headless não tem como usar. Aceita as DUAS gramáticas (uma linha com vírgulas e lista YAML com `-`), reusando o helper do `tools:` em vez de um segundo parser; caminho absoluto é legítimo aqui (é o caso de uso, ao contrário do `workflow:`), relativo resolve contra a pasta do serviço, `~` expande no locus concreto. **NÃO é `unconfined`**: a raiz declarada vira AUTORIZADA e o vizinho não declarado continua NEGADO — provado com `NodeWorkspace`/`resolveInside` REAIS, sem mock. ACRESCENTA, nunca substitui: a pasta do serviço segue como raiz. **O PISO NÃO CAI:** declarar `~/.aluy` (ou subcaminho) é RECUSADO, e recusa o manifesto INTEIRO fail-closed antes de entrar no registry — sem isso um serviço autônomo poderia abrir caminho para reescrever a própria config de confiança; três camadas independentes (parser, registry, wiring), cada uma testada com HOME falso. O manifesto visível DESTACA as raízes extras (⚠, mesma classe do aviso de autonomia): abrir acesso fora da própria pasta é ato de confiança e o dono precisa VER antes de confirmar. FORA DE ESCOPO com motivo: validar no INSTALL foi implementado e REVERTIDO — caminho relativo resolveria contra o staging temporário em vez do destino final, dando veredito ERRADO; validar em todo `list`/`get`/`start` troca "aparece mais cedo" por "aparece correto".

## [1.0.0-rc.125] — 2026-08-05

### Corrigido

- 👁️ **o `attach` mostrava `→ err` e ESCONDIA o motivo — que ele já tinha:** depois de horas travado, o dono: *"tá dando erro e não consigo ver"*. No `aluy service attach` aparecia `[tool] spawn_agent → err` e não havia caminho NENHUM para a razão — nem no attach, nem no `runner.log`, nem na transcrição da sessão (o bloco vinha com `result: ""`). O que dói: a razão SEMPRE existiu — `tool-reporter.ts` já grava `output: truncate(result.observation)` exatamente quando `status === 'err'`; ela chegava íntegra ao bloco e era DESCARTADA no último metro, porque a linha era montada com `${b.result || b.status}` e em erro o `result` vem VAZIO, então o `||` caía no `status` e imprimia só "err". Agora a razão aparece — e vai TAMBÉM para o `runner.log`, porque o attach é EFÊMERO (quem não estava conectado no instante do erro nunca via, e a transcrição morre com o turno) e falha de tool é a informação mais cara de um serviço autônomo. Só ERRO entra no log: sucesso continua fora, ou dezenas de tools por turno afogariam o diagnóstico. Cinco testes travam o comportamento, incluindo os mutantes (erro sem `output` degrada para "err", nunca "err: undefined"; sucesso não ganha cauda; o gate é o STATUS, não a presença do campo). SEXTO caso da mesma classe num só dia de dogfooding — a varredura da CLASSE fica como próximo passo.

## [1.0.0-rc.124] — 2026-08-05

### Adicionado

- ⏱️ **`immediate: true` no `service.md`:** roda um turno AO LIGAR, antes do primeiro sleep de cron (o dono tinha escrito esse campo achando que existia — e ele era ignorado em silêncio). `until:` VENCE: não dispara fora do expediente, porque a regra de expediente é dura em todo o resto do runner e abrir exceção por conveniência seria incoerente. Vale só na PRIMEIRA volta. RISCO ACEITO E DOCUMENTADO: dispara em TODO reinício (crash-loop, `stop`/`start`, reboot) — num serviço que opera, pode virar ordem repetida; marcado com ⚠ no manifesto visível.

### Corrigido

- 🧩 **`tools:` dos `agents/*.md` aceita LISTA YAML (a causa raiz de uma mesa inteira quebrada):** o dono montou 5 agentes num serviço e TODOS foram rejeitados — o `spawn_agent` por nome falhava e as atividades voltavam vazias. Os `.md` usavam `tools:` seguido de itens com `-`, e o parser só aceitava `tools: a, b` numa linha; a linha `tools:` ficava vazia ⇒ "presente mas ilegível" ⇒ perfil rejeitado. O argumento decisivo: foi o PRÓPRIO MODELO que escolheu o formato de lista ao escrever os `.md` a partir do prompt-guia do produto — se a forma natural é recusada, o problema é do parser. As duas formas passam a produzir resultado IDÊNTICO. `tools:` VAZIO segue recusado fail-closed (lista vazia nunca vira "herda tudo" — seria CONCEDER em vez de restringir). A mensagem de erro passa a ENSINAR as duas formas, e o prompt-guia do `/service create` ganhou exemplo literal.
- 🔦 **diagnóstico de boot chega ao `runner.log` e ao `attach`:** os erros de carga de agente eram `pushNote` — feito para a TUI — posicionado DEPOIS do `return` do ramo headless, portanto INALCANÇÁVEL em `-p`. O serviço falhava com "turno terminou com erro" e o motivo não saía do processo: `attach` e `runner.log` ficavam cegos exatamente quando mais se precisa deles. Agora vão ao stderr (mesma disciplina já usada para as notas de anexo recusadas), e o ramo de saída ilegível do runner anexa a cauda do stderr do filho. Stdout INTOCADO — é contrato: o runner lê a última linha como JSON.
- 🔕 **campos ignorados do `service.md` param de sumir em silêncio:** chave desconhecida era descartada sem aviso — `immediate: true` (inventado) e `activty-timeout` (typo) tinham o mesmo destino invisível. Agora aparecem como `⚠ campos ignorados: …` no manifesto visível e no `status`. NÃO recusa o manifesto: a tolerância a chave desconhecida é deliberada (o `.md` pode ter anotação do dono); o que faltava era VISIBILIDADE. Tunável numérico não entra na lista.

## [1.0.0-rc.123] — 2026-08-05

### Adicionado

- 🏷️ **`group:` e `model:` no `service.md`, e `--group` nos comandos:** o dono está montando uma "mesa" de vários serviços com um MAESTRO que os orquestra — e o maestro não tinha como DESCOBRIR os irmãos (precisaria dos nomes chumbados). `group:` é RÓTULO (sem estado, sem acoplar ciclo de vida: cada serviço segue processo independente com lock próprio) e vira a fronteira de autoridade — `aluy service list --group <nome>` é como o maestro descobre a mesa; `start`/`stop --group` iteram, reportando serviço a serviço, e a falha de um NÃO derruba os outros. `model:` fixa o modelo do turno por serviço (antes TODO serviço usava o default global do config, então trocar o padrão trocava a mesa inteira) — propagado como `--model` ao turno-filho só quando declarado, e o `model:` do AGENTE continua vencendo (mais específico ganha). Ambos aparecem no manifesto visível ANTES do install. Ausentes ⇒ comportamento idêntico ao de hoje.

### Corrigido

- 🪟 **pickers sumiam ou não respondiam — os dois caminhos de render divergiam (3 bugs, 1 causa):** o aluy tem DOIS caminhos de render (inline e cockpit) e cada um mantinha sua PRÓPRIA lista MANUAL dos mesmos overlays; as listas divergiram. (1) `/provider` não desenhava no INLINE — o componente existia só no bloco do cockpit; o comando rodava, o gate casava, o picker abria com as 11 entradas carregadas, e não havia o que desenhar: nada na tela, nem erro. Por isso a leitura do código não achava nada — não HAVIA nada errado, faltava DESENHAR (só apareceu instrumentando o binário: `open=true n=11`). (2) `Ctrl+P` idem com a paleta, e pior: o rodapé ANUNCIA "ctrl-p paleta". (3) No COCKPIT o teclado não chegava aos pickers — o ramo de navegação de região se desviava só para 3 dos 11 modais, engolia ↑↓ para rolar e retornava ANTES do handler (a dica do rodapé seguia sendo a do composer, denunciando o foco errado); o comentário do bloco já PROMETIA "picker captura antes" e não cumpria. A causa comum foi eliminada: a lista virou ÚNICA, usada pelos dois caminhos (−179 linhas duplicadas). O ESPAÇAMENTO NÃO foi unificado de propósito — difere por motivo real (no cockpit o overlay é popover ACIMA da conversa, no inline fica ABAIXO do composer), e unificar removeria 9 paddings, mexendo na altura da região viva justo na área que acabou de custar caro estabilizar. VERIFICADO no WezTerm real, inline E fullscreen: abre, ↑↓ navegam, enter APLICA.

## [1.0.0-rc.122] — 2026-08-05

### Adicionado

- 🤖 **`autonomy: yolo-scoped` — serviço autônomo, MAS confinado:** sem isto NENHUM serviço operava sozinho. O runner spawnava cada atividade SEM modo de permissão, então o turno-filho rodava sob a catraca normal, headless e sem TTY — todo efeito que pedisse aprovação FALHAVA FECHADO, porque não há humano para aprovar. Um serviço de trading travava na primeira chamada à bridge. E o `autonomy:` do manifesto não enforçava nada: era validado e exibido, mas nunca chegava ao runtime. A saída ÓBVIA seria passar `--yolo` ao filho — e é justamente o que NÃO se faz: `--yolo` liga `unconfined`, derrubando a cerca de workspace e suspendendo o anti-SSRF; dar isso a um agente que opera dinheiro real é inaceitável. O QUE MUDOU: "não pergunta" e "sem cerca" estavam colados numa flag só, e agora são eixos separados — `unconfined`/`allowInternalHosts` continuam derivando SÓ de `mode === 'unsafe'`, e como o modo novo é um valor DIFERENTE do mesmo eixo, a cerca nunca cai POR CONSTRUÇÃO, sem nenhum `if` novo. O corte do "não pergunta" vira `ask` → `allow` preservando o motivo; QUALQUER `deny` passa INTOCADO (pisos de `~/.aluy`, teto de profundidade, toolScope do agente, teto de memória e modo Plan retornam ANTES desse ponto). O manifesto visível DESTACA (⚠) o serviço que não pergunta — instalar é o momento do consentimento, e não pode existir serviço autônomo que o dono não viu que era autônomo. Só `ask` e `yolo-scoped` são aceitos; `yolo`/`unsafe` seguem recusados fail-closed. PROVADO com binário real sem TTY: sem `autonomy:` o `write_file` NÃO executa; com o modo novo DENTRO do serviço executa; com o modo novo FORA do serviço é NEGADO — esta última é o que distingue o modo do `--yolo`. SINALIZADO (fora de escopo): o guardrail de "autonomia + tier fraco + conteúdo não confiável" é keyed em `unsafe` e não dispara no modo novo. AINDA FALTA para a esteira ficar segura: os tunáveis (`perda-maxima-dia`, `max-contratos`) são parseados e exibidos mas o runner NÃO os lê — a cerca financeira ainda é texto no prompt, então autonomia em PRODUÇÃO só depois disso.

## [1.0.0-rc.121] — 2026-08-04

### Adicionado

- 🕵️ **`aluy --anonymous` — sessão que não deixa rastro (achado em dogfooding):** cada complemento do modo turbo é instalado spawnando o próprio aluy headless, e essa execução persistia sessão como qualquer outra — então o próximo `aluy` interativo oferecia **retomar a instalação do headroom** como se fosse conversa do dono. Plumbing interno vazando como histórico. `--anonymous` cobre três coisas e só: (1) **conteúdo da sessão** — `SessionStore` desligado ANTES de qualquer I/O, nem o diretório `~/.aluy/sessions/` chega a ser criado; implica sessão nova e é RECUSADO junto com `--continue`/`--resume` (combinação contraditória, refutada com mensagem clara em vez de adivinhada); (2) **sidecars de dados** — mem0 e headroom não sobem nem são consultados; **ollama é intocado**, porque é provedor de MODELO local e desligá-lo deixaria a sessão sem modelo em vez de anônima; (3) **memória** — store de disco trocado por um em RAM, `remember`/`recall` seguem funcionando DENTRO da sessão mas nada chega em `~/.aluy/memory/`. Os DOIS spawns internos passam a usar: instalação e **desinstalação** (`uninstall --agent` tinha o mesmo defeito — e pior, o dono acabou de pedir para REMOVER coisas e o comando deixava rastro NOVO para trás). Prova empírica com binário real e `HOME` isolado: sem a flag, 1 sessão gravada; com a flag, ZERO e diretório inexistente. FORA DE ESCOPO (declarado): journal de undo e backlog de todos.

### Corrigido

- 🎯 **`/model` no backend local (BYO) lista os modelos DE VERDADE do provider:** uma entrega anterior (rc.117) DIZIA resolver isto e não resolveu — trocou a FONTE da lista (broker → catálogo local) mas a lista continuou ESTÁTICA, e foi declarada pronta sem ninguém abrir o `/model` com a config real. Resultado: sob `openrouter`, o picker mostrava **5 modelos** declarados no catálogo embutido, e o modelo que o dono de fato usa (`xiaomi/mimo-v2.5-pro`) **não estava entre eles** — o picker não conseguia nem exibir o modelo ativo. Agora o picker consulta o provider (`GET {baseUrl}/models`) ao abrir, com estado de carregamento e aviso honesto de fallback quando o provider está inacessível; a lista é a UNIÃO de declarados ∪ registrados na sessão ∪ **modelo ativo** ∪ vindos do provider — o ativo aparece sempre. ARMADILHA no caminho: a função que já buscava do provider DESCARTA modelos sem `context_length`, exatamente o caso do provider custom `tokenrouter` do dono (19 modelos, nenhum com o campo) — reusá-la ingenuamente teria mostrado ZERO; foi preciso um parser irmão que preserva todo `id`. Reusa o MESMO fetch pinado anti-SSRF, sem segundo caminho de rede. **Medido em rede real: 5 → 338 modelos, com o modelo ativo presente.** O caminho de modelo CUSTOM já funcionava — o bug era DESCOBERTA (nada dizia que dá para digitar um slug fora da lista); agora há dica permanente.
- 🔒 **`workflow:` podia apontar para FORA do diretório do serviço:** o valor vira caminho (`<serviceDir>/workflows/<valor>.md`) sem validação nenhuma, então `workflow: ../../../../etc/passwd` escapava da árvore. Pior que o acesso: o "manifesto visível" exibido ANTES do `install` mostra só o valor DECLARADO — dava para esconder da revisão do dono qual arquivo de fato roda, justamente a tela onde ele decide confiar no serviço. SUBPASTA CONTINUA PERMITIDA (`intraday/turno`) — era o pedido legítimo que revelou o furo; o que se recusa é ESCAPAR. Três camadas redundantes de propósito: FORMA no parser puro (segmento `..` em qualquer posição, absoluto posix/windows, barra invertida, byte nulo — manifesto INTEIRO rejeitado, fail-closed), CAMINHO RESOLVIDO no registry (rede para symlink/normalização de plataforma), e RECONFERÊNCIA no runner antes de ler (ele é quem executa, e relê o manifesto A CADA despertar — o disco pode ter mudado). Nome com `..` que NÃO é segmento (`re..tro`) segue aceito; teste trava isso contra um `includes('..')` cru.

## [1.0.0-rc.120] — 2026-08-04

### Corrigido

- 🖥️ **redimensionar com VOLUME congelava a tela e comia o histórico (achado em dogfooding, reprodução determinística no terminal real):** o dono descreveu — *"se tiver rodando algo e eu quiser redimensionar às vezes ele para de atualizar e a tela fica um pouco congelada, se dou enter parece que volta"*. "Volta com Enter" é assinatura de FRAME PARADO esperando evento, não de layout errado. **A variável que faltava era VOLUME**: com sessão pequena, quatro formas de encolher (largura, altura, gradual, rajada) não reproduzem NADA; com uma sessão real de 1943 blocos, reproduz toda vez. CAUSA: o cooldown de 500ms entre repaints era um debounce SÓ DE BORDA DE SUBIDA — o 1º settle da rajada pintava e os seguintes, caindo dentro dos 500ms, eram DESCARTADOS (`return` seco, sem reagendar). Numa rajada de arraste, o settle FINAL — justamente o que carrega as dimensões definitivas — é um dos descartados; a tela ficava no frame do PRIMEIRO settle, com o layout das dimensões VELHAS, e nada mais disparava correção (o Enter "consertava" porque qualquer input provoca render novo). FIX: a borda de descida que faltava — settle suprimido é REAGENDADO para quando o cooldown vencer, em vez de perdido. O cooldown volta a ser LIMITADOR DE FREQUÊNCIA (segue não pagando O(histórico) por settle) em vez de descarte de ESTADO FINAL; no máximo UM repaint extra por rajada, nunca N. MEDIDO no WezTerm real, mesma sessão e mesma sequência: lacuna ao abrir 23→3 linhas; após rajada 38→0; e o conteúdo PARA de ser comido — antes sobravam 7 linhas vivas (só composer e barra, 58 em branco acima), agora sobram 28 de histórico real. O A/B (rc.116 sem o fix anterior × rc.118 com ele) deu números IDÊNTICOS, provando que o `WEZTERM-GAP` da rc.117 é inerte neste caminho — mantido mesmo assim, pois cobre o regime de estouro que este teste não exercita. AINDA NÃO MEDIDO: redimensionar COM UM TURNO EM EXECUÇÃO (a causa explica o sintoma, mas explicar não é medir); se persistir nesse caso, a suspeita seguinte é o custo de re-emitir o histórico inteiro a cada repaint — desempenho, não lógica de repaint.

### CI

- 🚑 **um 403 transitório não deixa mais a release pela metade (achado real na rc.119):** o `npm publish` deu certo e o passo seguinte — mover o dist-tag `latest` — tomou 403 do registry segundos depois, com o MESMO token, no MESMO job (propagação). Três consequências silenciosas: (1) `latest` ficou na versão ANTERIOR, então quem instala sem tag — inclusive o `install.sh` do site — continuou recebendo a versão velha enquanto o npm dizia "publicado"; (2) o passo de GitHub Release foi PULADO, e como o site lê a versão DAS RELEASES, a versão nova não aparecia; (3) re-rodar era impossível, porque o publish batia em `EPUBLISHCONFLICT` e o job morria antes dos passos que faltavam. Agora: retry com espera crescente no dist-tag (5 tentativas), a GitHub Release deixa de depender do dist-tag (basta o PUBLISH ter dado certo — se o pacote está no registry, a release tem que existir), e o publish vira IDEMPOTENTE ("já publicada" = sucesso), tornando a re-execução uma opção real. Não afrouxa o gate: republicar o MESMO número é o no-op desejado, e 403/ENEEDAUTH/erro de rede seguem FALHANDO (verificado contra as strings de erro reais do npm).

## [1.0.0-rc.119] — 2026-08-03

### Adicionado

- 💾 **`/provider save` — fixa o provider BYO ativo como padrão (achado em dogfooding):** trocar de provider na sessão nunca persistia, e o dono estranhou. Escopo-de-sessão como DEFAULT continua (experimentar um provider numa tarefa não contamina todas as sessões futuras) — o que faltava era o ato EXPLÍCITO de "fixa isso". Grava pelo MESMO `UserConfigStore` do `onboard` (caminho único de escrita). Só BYO/local: sob broker o `/provider` pareia com o slug Custom e resolve no servidor, então o comando REPORTA isso em vez de gravar algo sem sentido. Round-trip provado com a função que o BOOT de fato chama (`resolveLocalProviderConfig`) — sem essa prova, "salvar" poderia não ter efeito nenhum na sessão seguinte. Falha de escrita não derruba a sessão; o config gravado tem só `localProvider`/`localModel`, nenhuma credencial. FORA DE ESCOPO (declarado): `/effort` (sem infra de persistência) e `/model` (já persiste hoje).

### Corrigido

- 📡 **`channel:` deixa de ser obrigatório na prática (achado em dogfooding: "eu não quero ser obrigado a ter um channel"):** o parser JÁ aceitava a ausência — quem obrigava era o RUNTIME. Turno fechava com pergunta pendente, não havia canal utilizável, e o runner ENCERRAVA o processo. Ou seja: um serviço sem canal morria na PRIMEIRA pergunta — e como a v1 só aceita `autonomy: ask`, perguntar é o normal, não a exceção. Agora, sem canal utilizável (não declarado, valor não-Telegram, ou sem token) e com o attach fiado, a ask-espera vira ESPERA SILENCIOSA: o serviço fica vivo, a pergunta fica no `runner.log` e no `status.json`, e o dono responde com `aluy service attach` — reusando o MESMO evento `say` que já corria contra o Telegram. O canal remoto passa a ser o que sempre deveria ter sido: camada de ALCANCE, não requisito de existência. Regra dura intacta (só resposta do dono retoma; nunca supõe), teto de 24h intacto. Nenhum `setTimeout` com o teto inteiro (tick de 1s + relógio puro) — um timer com o teto cru estoura o inteiro de 32 bits, bug que este repo já pagou. O prompt do `/service create` parou de empurrar canal: agora diz OPCIONAL e manda omitir a linha se o dono não pediu aviso remoto.
- 🔌 **a troca de `/provider` agora alcança TUDO (fecha lacuna declarada na rc.117):** duas portas continuavam fechadas sobre o que o BOOT resolveu — `callerForLocalModel` (roteamento de sub-agente a modelo local) e `discoverContextWindow`. Depois de um `/provider` no meio da sessão, um sub-agente roteado saía pelo endpoint e credencial do provider ANTERIOR, em silêncio — o mesmo tipo de defeito que o `/provider` original tinha. Ambas passam a reler o provider ATIVO a cada chamada, pelo mesmo par mutável que `switchLocalProvider` escreve só no sucesso. Políticas de falha diferentes de propósito: roteamento é FAIL-CLOSED (erro explícito, nunca pelo endpoint errado); descoberta de janela é FAIL-OPEN (é enfeite de barra de status, não caminho de segurança). O `slug` — única coisa que vem de dado externo — nunca influencia qual provider é usado.
- 🧹 **jargão interno some do texto visível, inclusive o de TODA confirmação:** varredura pela AST do compilador TypeScript (comentário fica de fora por construção, mais confiável que grep) achou 30 ocorrências de `CLI-SEC-N`/`EST-N`/`RES-MD-N`/`TC-N`/`GS-MDN` em strings. A pior era de altíssima frequência: `run_command = ask por padrão (CLI-SEC-3)` aparecia em TODA confirmação de comando na catraca. 12 strings limpas (razões default da catraca, negação de comando destrutivo, as duas citações de ADR-0065 no sandbox, ajuda de `cron`/`mcp`/`config`, hint do `doctor`, descarte do mesh, teto anti-spam do serviço). 5 marcadores MANTIDOS de propósito (`GS-MD1`, `GS-MD7`, `EST-1121`, `EST-0970`, `RES-MD-3`): estão fixados por asserção de teste — a maioria em teste de catraca, onde o marcador identifica QUAL regra disparou; relaxar a especificidade de um teste de segurança tem que ser decisão deliberada, não efeito colateral de limpeza. Comentários de código intactos.

### Testes

- 🧪 **cobertura de `runner.ts` (o loop do daemon de serviços): 46% → 95% de statements, 57% → 100% de funções.** Auditoria anterior (cobertura + mutation testing, dois ângulos convergentes) apontava este como o arquivo mais fracamente testado do subsistema, com aviso explícito de resolver ANTES de uso autônomo mais pesado — e agora há um serviço real prestes a rodar nele 24/7. O gap não estava nas funções puras (já testadas) e sim na INTEGRAÇÃO: spawn, ask-espera, ciclo de vida. Em vez de mockar `child_process` (que testaria o mock), um fixture age como um `aluy -p` FALSO spawnado como processo-filho de verdade, pelos pontos de injeção que já existiam. 10 arquivos + 2 fixtures, ZERO linhas de produção alteradas. Mutantes mortos: fronteiras numéricas no limite exato, ordem de guardas (`stopAborted` > deadline), caminhos de erro/degrade, e limpeza de recursos em TODO caminho de saída (um `return` que esquece o pidfile deixa órfão apontando pra processo morto).

## [1.0.0-rc.118] — 2026-08-03

### Corrigido

- 🛡️ **anexo de IMAGEM não acendia o guardrail de conteúdo não-confiável (achado em auditoria pós-rc.117):** `@foto.png`/`--image` sob `--yolo` NÃO disparava `hasUntrustedInContext` — o aviso de "modo autônomo ativo com conteúdo externo no contexto" simplesmente não aparecia; anexo de TEXTO disparava normalmente. A checagem tinha duas pernas (o PAPEL `observation`/`tool_result`, e um fallback pelo literal `<<<DADO_NAO_CONFIAVEL` no `text`) e o `attachment_image` (ADR-0159) escapava das DUAS: não estava na lista de papéis, e é a ÚNICA proveniência não-confiável que não passa pelo `wrapUntrusted` — não por ser mais confiável, mas porque aquele envelope é de TEXTO e destruiria os bytes base64 (ver `buildMessages`); o item nem campo `text` tem pra casar. Caía na lacuna entre os dois mecanismos. Importa porque é o caso MAIS perigoso: instrução embutida numa imagem escapa de qualquer varredura de texto e é lida como ordem por um modelo de visão. Agora `attachment_image` entra pela checagem de PAPEL — a fronteira de proveniência (CLI-SEC-4), independente de o envelope de texto caber ou não naquele tipo de conteúdo.

## [1.0.0-rc.117] — 2026-08-03

### Adicionado

- ⏱️ **teto por atividade configurável, com opção explícita "sem-teto" (achado em dogfooding real):** o dono quer o serviço rodando 24/7, mas o teto anti-runaway POR ATIVIDADE era 30min CHUMBADO no runner — atividade longa morria no meio sem como afrouxar. O `service.md` passa a aceitar `activity-timeout:` no frontmatter (`45m`/`2h`, mesma gramática de duração do `/cycle`, ou `sem-teto`). Ausente/malformado ⇒ 30min, o default INALTERADO. `sem-teto` NUNCA vira um `setTimeout` com número gigante: `resolveActivityTimeout` devolve um caso PRÓPRIO no tipo e o caller simplesmente não cria timer — simular infinito com número grande reintroduziria o overflow de 32-bit do `setTimeout` (>24.8 dias colapsa pra ~1ms) já corrigido antes NESTE mesmo arquivo pro sleep entre ciclos. `until:` segue independente e sempre enforçado ("sem teto por atividade" ≠ "sem fim de expediente"). O manifesto visível do `install` mostra o teto — quem instala vê `sem-teto` ANTES de confirmar.
- 🎨 **diff colorido compacto no histórico do transcript:** o diff verde/vermelho só existia no popup da catraca (`<AskDialog>`) — de uma vez só. Em `--yolo`, ou depois de aprovar, nada ficava no scrollback: não dava pra rolar de volta e ver o que mudou. Agora todo `edit_file`/`write_file` concluído anexa um bloco compacto abaixo da linha `⏺`, reusando o MESMO renderer e o MESMO teto de linhas do ask (cabeça+cauda + "+N linhas ocultas") — nunca despeja o arquivo inteiro. Estruturalmente restrito à região ESTÁTICA: o produtor só popula o diff quando o `ToolResult` já resolveu, e o ramo `running` retorna antes de qualquer lógica de diff — travado por teste (`isLiveBlock` ignora `diff`, olha só `status`).

### Corrigido

- 🪟 **resize no WezTerm apagava o histórico (só no WezTerm):** redimensionar depois de já haver conversa gerava um espaço vazio enorme (até ~59 linhas) entre a saída e o composer. Causa raiz achada por leitura do `ink.js` + reprodução via PTY real — e ela REFUTA a hipótese inicial de que era só o cooldown: quando a região viva não cabe em `rows`, o PRÓPRIO Ink escreve `clearTerminal + fullStaticOutput` cru, sem passar pelo `log-update` interno dele, deixando o `previousLineCount` dessincronizado da tela real. O F196 pula nosso `clearScreen()` nesse regime assumindo "o Ink repinta sozinho" — verdade só pra AQUELE frame; a dessincronia sobrevive à volta pro regime "cabe" e o próximo `eraseLines` do Ink apaga a contagem ERRADA, comendo linhas reais do histórico. Só um `clearScreen()` de verdade cura — mas o cooldown de 500ms podia suprimir exatamente esse repaint de recuperação, deixando a dessincronia PERMANENTE. O WezTerm dispara porque reporta resize com granularidade muito maior durante o arrasto. Fix: sinal sticky força o repaint de recuperação ignorando o cooldown; o cooldown segue intacto no caso comum. Os 6 testes de resize existentes passam sem nenhuma alteração de asserção.
- 🔌 **`/provider` e `/model` no backend local (BYO) — 4 lacunas de uma raiz só:** o `/provider` listava os providers do BROKER em vez do catálogo LOCAL do usuário; o `/model` não aceitava slug custom fora da lista; não havia como adicionar provider custom pelo `/provider`; e a lista de modelos não seguia o provider escolhido. Por baixo, o bug de fundo: o `LocalModelClient` NUNCA lê o campo `provider` do request — trocar de provider sob backend local era um NO-OP SILENCIOSO (aceito, exibido, sem efeito nenhum). Agora: `/provider` lê `loadLocalProviderCatalog()` (embutidos + `~/.aluy/config.json`), relido a cada abertura; `/model` roteia texto livre sem match pro `verifyAndRegisterLocalModel` (test-then-register — SONDA o provider ao vivo, só aplica em caso de sucesso e RECUSA mantendo o modelo ativo intocado quando a sonda falha, nunca troca às cegas); entrada `"+ adicionar provider custom"` grava pelo MESMO `addLocalProviderOverride` do `onboard` (caminho único de persistência); e `SessionController.setLocalProvider` reconstrói o client pelo mesmo caminho do BOOT (`buildLocalModelClient`), fail-closed. O caminho do broker segue idêntico. FORA DE ESCOPO (declarado): roteamento de sub-agente a modelo local e descoberta de janela de contexto ainda apontam pro provider do BOOT após troca no meio da sessão.
- 🧹 **poluição de "ADR-0158" no texto visível dos serviços:** linhas como `instalar é ato de CONFIANÇA explícito (ADR-0158 §9/§Consequências)` e `PARADO — aluy service start <nome> para ligar (ADR-0158 §5)` chegavam ao terminal de quem só quer usar o produto. Número de ADR é rastreabilidade INTERNA. 14 arquivos de produção limpos (help do `aluy service`, manifesto visível, erro do `daemon.md` sem `command`, mensagens de retomada/ask-espera/attach, listagem, parser, i18n en+pt-BR, slash commands/handlers); comentários de código-fonte mantêm as citações INTACTAS.

## [1.0.0-rc.116] — 2026-08-03

### Corrigido

- 🔇 **anexo/imagem recusado em `-p` era descartado em silêncio (achado em dogfooding real):** `aluy -p "descreva" --image /tmp/foto.png` (ou `@caminho` fora do workspace) fazia o modelo responder "não recebi imagem nenhuma" sem NENHUM sinal do motivo. A recusa (confinamento do `@attach` — decisão da ADR-0159, intocada aqui) já era corretamente calculada por `resolveLinearMentions`, mas nunca escrita em lugar nenhum nos dois modos headless (`runHeadlessPrint`/`runHeadlessStreamJson`). Agora ambos escrevem a nota (`aluy: [anexo recusado] @caminho — motivo` / `aluy: [anexo] @caminho`) no stderr; stdout/NDJSON seguem limpos.
- 🗂️ **`/mcp list` reorganizado:** resumo no topo (N servers, quantos ativos/erro/desativados/sem-descoberta, total de tools), agrupado por estado, tools numa tabela com bordas (reusa o `boxTable` já usado por `/agents`/`/skills`, nunca aplicado a `/mcp` até agora). `env:` continua só com as CHAVES.
- 🔒 **`/service create` não vaza mais "ADR-0158" no prompt visível:** o prompt-guia da entrevista conversacional citava a ADR e seções internas de governança em 12 pontos — texto que o usuário vê na tela como se fosse a própria pergunta do sistema. Removidas as citações do texto, significado preservado; comentários de código (nunca alcançam a tela) intocados.
- 🎯 **`/model` e `/effort` ganham picker dedicado no backend local (BYO):** o fuzzy-search já existia pro backend broker (tiers); sob `backend:'local'` (o caminho PRINCIPAL do produto — BYO provider), `/model` sem argumento caía numa nota estática, sem lista nenhuma. Agora abre um picker dedicado sobre os slugs do provider ativo; `/effort` ganha seletor standalone (keep/low/medium/high/custom).
- 🐛 **boot fatal sob TTY travava pra sempre (severidade alta, achado via PTY real):** um erro fatal no boot (ex.: `--local-base-url` recusado pelo anti-SSRF) deixava o splash girando infinitamente — o processo nunca saía sozinho, só com Ctrl-C manual. `process.exitCode` era setado mas `process.exit()` nunca era chamado; o timer da animação do splash mantinha o event loop vivo. Corrigido — verificado com PTY real (antes: hang infinito; depois: sai em ~4s).
- 🔇 **`@arquivo-inexistente` + Enter descartava o texto em silêncio:** o picker fechava sem nenhum aviso, inconsistente com `/comando-inexistente`. Agora avisa pelo mesmo canal já usado pra recusa de anexo.

## [1.0.0-rc.115] — 2026-08-01

### Adicionado

- 🖼️ **suporte a imagem (ADR-0159/APR-0149):** `@screenshot.png` no composer interativo e em `aluy -p "descreva @screenshot.png"` (headless) — mesma menção `@`, mesmo `AttachReader` que já servia texto, sem mecanismo paralelo. `--image <path>` (repetível) como açúcar sintático p/ automação. Detecção por MAGIC BYTES (não extensão — não-spoofável), lista FECHADA de 4 tipos (`png`/`jpeg`/`gif`/`webp`) que os adapters sabem serializar; qualquer outro binário continua rejeitado exatamente como antes. `ChatMessage`/`LocalMessage.content` viram `string | ContentPart[]` (união retrocompatível); os adapters OpenAI-compat, Anthropic e broker-client aprendem o bloco de imagem. Confinamento/path-deny do `@attach` correm exatamente como hoje, antes do ramo de imagem — nenhuma relaxação geral do guard. Paste de clipboard/terminal (OSC52/Kitty/iTerm2) fica fora de escopo desta entrega.

### Testes

- Cobertura e mutation testing (Stryker, diagnóstico pontual — não entrou no repo) do subsistema de SERVIÇOS (ADR-0158): +38 testes de imagem, +8 de cobertura real (`attach-client.ts`, limpeza self-healing de `daemons.ts`), +56 de fronteira/boundary (achados por mutation testing — ranges min/max nunca testados no limite exato). Verificação empírica via PTY real confirmou operação nonstop/autônoma de um serviço rodando (múltiplos turnos agendados, `attach`/`say`/detach ao vivo, `stop` sem órfãos) — zero bugs encontrados no subsistema. Achado convergente (cobertura + mutation, ângulos independentes): `packages/cli/src/service/runner.ts` (o loop do daemon) é o arquivo mais fracamente testado do subsistema — sinalizado para follow-up antes de uso autônomo mais pesado.

## [1.0.0-rc.114] — 2026-08-01

### Corrigido

- 🔒 **enforcement REAL do funil (fecha o degrade #3 da rc.113):** o `[agente]` de uma atividade do workflow de serviço deixa de ser dica textual — o turno headless NASCE travado na persona, reusando a trilha já testada do `/subagent` (`childEngineOf`: tools ⊆ pai negadas na catraca; `bindNamedAgent`: fail-closed em nome desconhecido — exit≠0 antes de montar sessão, provider nunca é chamado). Prova decisiva na fumaça real: um estudo sem `write_file` foi BLOQUEADO **mesmo sob `--yolo`** — o gate de persona intercepta antes do relaxamento de modo. A garantia central do funil (ADR-0158 §4.1: "a ferramenta não existe no mundo do estudo") agora é estrutural, não pedido educado.

## [1.0.0-rc.113] — 2026-08-01

### Adicionado

- 🌱 **SERVIÇOS plugáveis (ADR-0158/APR-0148) — o aluy como "uma pessoa ou um time" contínuo:** um serviço é um DIRETÓRIO em `~/.aluy/services/<nome>/` (`service.md` com frontmatter=contrato duro e corpo=orquestrador + `agents/`/`workflows/`/`skills/`/`daemons/`/`rules.md`/`mcp.json` nos formatos existentes). Superfície completa: `aluy service create|install|start|stop|status|logs|attach|uninstall` com `/service` in-session como canal PRINCIPAL. Runner = UM PROCESSO POR SERVIÇO (dorme até o `schedule`, sobe daemons próprios, roda o workflow em turnos headless com wiring ESCOPADO ao diretório, enforça `until:`/`budget:` por CÓDIGO); canal Telegram (reporte de fechamento, alerta de falha, ASK-ESPERA: pergunta pendente vai ao chat do dono e o turno retoma com a resposta — allowlist só o chat-id do manifesto, egresso travado TC-5/TC-6); ATTACH (socket UNIX 0600: ver a conversa viva, falar com o serviço via `say`, detach sem parar); CREATE conversacional (prompt-guia estilo `/init`, escreve em STAGING — a catraca `aluy-config-write-deny` foi verificada e PRESERVADA; fluxo create→revisar→install com manifesto visível→start). Topologia de FUNIL nativa: `tools:` por persona (só o decisor executa), room como DADO, teto no script do dono, `autonomy: ask`. 5 fases, +254 testes (676 arquivos / 8470 passing), cada fase fumada no binário real. ⚠ Gate `seguranca` (AG-0008) do ADR segue ABERTO — recomendado antes de uso com dinheiro real.

### Corrigido

- 🩹 **runner não loopa mais com `schedule` distante:** `setTimeout` de um tiro clampava >2^31-1ms (~24,8 dias) para ~1ms — agora dorme em fatias de 1 dia.

## [1.0.0-rc.112] — 2026-07-31

### Alterado

- 🔴 **retentativa em falha transitória passa a nascer LIGADA por padrão** (ADR-0156/APR-0146, decisão do Tiago): antes exigia `ALUY_RETRY=on` explícito, porque colidia com o invariante testado CA-5 ("erro estruturado sobe sem virar retry"). O ADR foi escrito, a pergunta foi decidida: liga. `ALUY_RETRY=off` continua disponível pra quem quiser o comportamento antigo. O teste CA-5 foi EMENDADO (não descartado) — passa `retry:RETRY_OFF` explícito para provar que o invariante segue disponível sob opt-out — e um teste novo cobre o baseline atual (falha transitória é retentada por default e o turno se recupera). Classificação de erro, tetos anti-runaway (20 tentativas, 60s de espera máxima) e o não-retry de cancelamento/erro desconhecido continuam os mesmos.

### Interno

- 📚 **4 ADRs aprovados** (APR-0144 a APR-0147, Tiago): conectores/Telegram (número livre `ADR-0154`, corrige colisão com `ADR-0134`/`ADR-0135`), janela de contexto por modelo (`ADR-0155`), retry-default (`ADR-0156`, implementado nesta release) e o gate `awaitsUserDecision` (`ADR-0157`, ratificado sem mudança de código). Numeração `TC-1..TC-8` dos conectores fecha em `TC-1/2/3/5/6` — `TC-4`/`TC-7`/`TC-8` não são definidas.

## [1.0.0-rc.111] — 2026-07-31

### Corrigido

- 🩹 **sentinela binário em `wiring.ts` silenciava grep no arquivo inteiro:** um NUL byte literal (`'\x00__inherit__'`) usado como sentinela do `Map` de callers CUSTOM/BYO (ADR-0146 D3) fazia `file`/`grep` sem `-a` classificarem o ARQUIVO INTEIRO como binário. Já causou diagnóstico errado nesta sessão de trabalho (uma busca concluiu que uma função "não tinha chamador" só porque o grep não via o arquivo). Trocado por `'__ALUY_INHERIT_PARENT__'` (ASCII, mesma semântica).
- 🩹 **rodapé mostrava o modelo duas vezes em vez de `provider · modelo`:** no backend local/BYO, após um turno, `local · deepseek/deepseek-v4-pro · deepseek/deepseek-v4-pro` em vez de `local · tokenrouter · deepseek/deepseek-v4-pro`. O literal `meta` do boot nunca copiava `opts.provider` — só a variável interna `bootProvider` (travada em `tier==='custom'`) alimentava o CALLER; essa trava nunca deveria valer para o DISPLAY. `state.meta.provider` nascia `undefined`, a StatusBar caía no fallback, e após o 1º turno o campo do modelo preenchia o vazio — dando a impressão de duplicação.

### Interno

- 🧹 `prettier --write .` em 94 arquivos (só formatação — reflow de assinaturas longas, colapso de chamadas que cabem numa linha; zero mudança de comportamento, confirmado por spot-check).

## [1.0.0-rc.110] — 2026-07-31

### Corrigido

- 🩹 **usage do trailer OpenAI era perdido — fecha `⛁ 0% janela`/`◔ 0 sessão`/`0 tokens` no BYO INTEIRO:** a causa raiz por trás de TRÊS sintomas reportados separadamente, mesmo após a rc.109 corrigir a resolução da janela e a nota de descoberta — NENHUM turno BYO em streaming jamais reportava usage, pai ou sub-agente. No estilo OpenAI com `stream_options:{include_usage:true}`, o `usage` REAL vem num chunk SEPARADO, DEPOIS do chunk que traz `finish_reason` — mas o adapter emitia `done` assim que via `finish_reason`, e `done` FECHA O SOCKET; o chunk trailer de usage nunca era lido. Provado no código real (fixture SSE cru via `LocalModelClient.stream()`): antes, `delta → done(finish_reason:"stop")` com `usage: undefined`; depois, `delta → usage{...} → done(...)` com o usage completo. O `done` agora é ADIADO até o sentinela `[DONE]` (depois do trailer); um `ProviderAdapter.finalize?(acc)` novo (opcional) cobre o provider que fecha a conexão sem `[DONE]`, fechando o turno com o `finish_reason` REAL; e um teto anti-hang (`MAX_TRAILER_EVENTS=8`) evita pendurar a sessão num trailer que nunca termina. Confirmado que `anthropic-adapter.ts` não precisa do `finalize`: `usage` e `done` já saem juntos, no mesmo `message_delta`, sem trailer separado no protocolo Anthropic.

## [1.0.0-rc.109] — 2026-07-31

### Corrigido

- 🩹 **status bar espremida no BYO — o modelo agora é campo DESCARTÁVEL:** o chip `◈ sidecars` da rc.108 ESTAVA aparecendo — a barra INTEIRA é que embaralhava entre ~90 e 115 colunas. No backend local o modelo ia COLADO dentro do `tierDisplay` (`local · <provider> · <modelo>`), campo que por projeto nunca é descartado; o limiar `MODEL_MIN_COLS` foi calibrado em 90 col ANTES de o chip existir. Medido no binário instalado (100 col): antes, `◷` sumia e `sidecars`→`sidecar`/`0%`→`0`; depois, a linha inteira cabe. O modelo do BYO passa a viajar no campo descartável `model`, e `sidecarChipCols()` MEDE o custo real do chip em vez de um número fixo.
- 🩹 **descoberta de janela vazia deixa de ser SILENCIOSA:** investigado no binário real (provider tokenrouter) — não é bug de código, é DADO AUSENTE na fonte: o `/v1/models` do tokenrouter responde 200 sem nenhum campo de janela (confirmado também via `/api/pricing`, headers, `/v1/models/<id>`). A mecânica está certa (provado gravando sozinho a janela ao apontar para o OpenRouter, que publica `context_length`) — só faltava avisar. Agora, descoberta vazia e janela efetiva ainda 0 ⇒ nota dizendo onde declarar (`providers[].contextByModel`), gateada por um getter só-leitura para quem já tem janela conhecida não ver nota nenhuma.

## [1.0.0-rc.108] — 2026-07-31

### Corrigido

- 🩹 **a JANELA DE CONTEXTO passa a vir do MODELO em BYO — e é DESCOBERTA sozinha (fecha `0% janela` + "não auto-compacta"):** a janela era procurada por **tier** (`contextWindowForTier`), mas no backend local o tier é o literal `custom`, que devolve **0** por design ("janela imprevisível"). Só que em BYO ela NÃO é imprevisível — o dono declarou um modelo CONCRETO; faltava ONDE guardar o número e QUEM perguntar. Com janela 0 o `⛁ %` CONGELA (a guarda `contextWindow > 0` do `onUsage` nunca passa) **e** a auto-compactação fica INERTE (`decideAutoCompact` sai em `contextWindow <= 0`) — sessão longa sem rede de segurança, até o provider recusar o request. Pior: TODO `/model` e TODA retomada (`resolveResumedModel` → `setTier('custom', slug)`) RE-ZERAVAM a janela do boot, então sessão NOVA funcionava e quebrava no 1º `/model`/`--continue`. Agora: `contextByModel` (mapa slug→tokens) no catálogo BYO; 5º degrau `modelWindow` no `resolveContextWindow` (abaixo do override explícito do usuário, acima de 0); o boot alimenta as fontes (`resolveWindowSources`, pura — e sob BROKER o slug local NÃO sai, senão mostraria a janela de um modelo que nem está em uso); o `setTier` re-resolve pelo modelo NOVO; e a **descoberta automática** (`GET {baseUrl}/models` → `context_length`) persiste o valor, no molde do `test-then-register` (ADR-0153) com fetch PINADO anti-SSRF e credencial do keychain — dispara DEPOIS do `buildSession` (não bloqueia render/headless), só sob backend local real e só se ainda não houver janela declarada, então da 2ª sessão em diante nem há chamada. NÃO é "não rebaixar" cego: sem janela declarada nem descoberta o 0 continua valendo, e o **F134** (janela desconhecida ⇒ size-aware do Compactor OFF) passa INTACTO — o conserto foi dar a RESPOSTA CERTA, não suprimir a pergunta. Fail-open total (provider sem `context_length`, 401, timeout, egress recusado, wireFormat não-OpenAI ⇒ não descobre, não grava, não quebra).
- 🩹 **a caixa de `perguntar` voltou a aparecer:** o agente encerrava o turno com a pergunta em TEXTO PURO ("qual caminho você prefere?", após listar opções) e nenhuma caixa surgia. O wiring nunca quebrou — o problema era ONDE morava a orientação: TODA instrução viva mandando usar `perguntar` estava dentro de textos CONDICIONAIS (o probe do self-check e os nudges de continuação). A rc.107 plugou o `awaitsUserDecision` nesses dois seams para consertar o agente ATROPELAR o dono, e sem querer removeu o único empurrão que existia para a tool: pergunta em texto virou estratégia bem-sucedida e silenciosa. O gate NÃO foi revertido (pergunta em texto DEVE encerrar o turno); a orientação é que virou PERMANENTE — entrada nova no MAPA DE CAPACIDADES do system prompt (não havia NENHUMA para `perguntar`), `description` da tool reescrita com o gatilho explícito (o "Use com parcimônia" saiu — desencorajava a única tool que abre a caixa) e exemplo few-shot em tier fraco. Tudo GATED pela presença da tool (sub-agente roda sem ela).
- 🩹 **o bloco `Λ aluy` respira depois de uma linha de ferramenta:** o respiro entre turnos é sempre pago pelo `paddingBottom` do bloco DE CIMA, e o `ToolLine` não paga nada (de propósito — ferramentas consecutivas leem como lista compacta), então `você → aluy` respirava e `ferramenta → aluy` colava. Regra agora em módulo PURO (`block-rhythm.ts`), com `prevKind` plumbado nos dois call-sites. O `i === 0` do slice vivo fica sem contexto DE PROPÓSITO: o container da região viva já é `<Box paddingY={1}>`, então passar o vizinho absoluto ali rendia DUAS linhas em branco (medido em PTY) — e assim a contabilidade de altura fica estável quando o bloco cai no scrollback. Cockpit fora de escopo por decisão (mexer no ritmo lá exigiria editar em sincronia a medição-espelho `measureConversaBlock`, sob pena de reintroduzir o mis-clip do Ink da F170). Verificado em PTY real + anti-flicker em 4 tamanhos (0 `\x1b[2J` em 8 execuções).

### Adicionado

- 🌱 **chip de USO dos sidecars na status bar (perfil turbo):** o que existia media DISPONIBILIDADE (health probe do `/doctor` diz que o sidecar está DE PÉ, não que foi CONSULTADO) e não havia sinal de uso em lugar nenhum. Agora os pontos de consulta REAL são instrumentados, cada um separando USO de FALHA: headroom/compress (só conta quando passou por todas as travas HR-SEC **e** a resposta foi aplicada — o caminho é fail-open), headroom/retrieve (2º ponto real, quem consulta é o modelo), ollama/juiz (só `mode:'llm'`; degradação p/ motor-a conta falha) e mem0 (`add` gravado, `search` respondido — recall VAZIO conta uso, porque projeto novo ≠ sidecar caído). Os 3 estados são derivados SEM probe: `used` (≥1 chamada aproveitada), `idle` (ligado, zero chamadas) e `off` (fora do fio OU de pé com toda chamada falhando — chamar de "ocioso" um sidecar caído seria mentira). Renderiza `◈ sidecars hdr·12 oll mem✗`, com o nº de consultas carregando o sentido; perfil LEVE não ganha campo nenhum. `/doctor` ganha a linha de uso da sessão (ausente no `aluy doctor` de shell: processo novo não tem contadores, e zeros ali mentiriam "nunca usado"). i18n 137/137.
- 🌱 **retentativa em falha TRANSITÓRIA (DESLIGADA por default, `ALUY_RETRY=on`):** a infraestrutura sempre existiu e ninguém a executava — `errors.ts` já classificava `retryable` e parseava `Retry-After`, e a `Idempotency-Key` nasce no loop JUSTAMENTE p/ que um retry reuse a mesma key e o broker deduplique o billing; mas `errors.ts` dizia "a decisão é do loop" e o `loop.ts` dizia "quem retenta é o ModelCaller", e nenhuma retentava. Um blip de rede matava o turno inteiro. Agora há política PURA (`isTransient`/`decideRetry`/`resolveRetry`) e laço no `StreamingModelCaller`, por cima do degrade de tools, com espera ABORTÁVEL (Ctrl-C não fica preso até o fim do timer) e `Retry-After` honrado/clampado. O que **não** se retenta é o ponto: "o provider NEGOU" ≠ "não respondeu" — 401/403/404/400/422 são determinísticos e, no BYO (sem dedup de broker), repetir QUEIMA DINHEIRO; cancelamento nunca se retenta (é ordem do dono); erro desconhecido também não (fail-safe). Nasce DESLIGADO porque o invariante **CA-5** do `streaming-caller` ("erro estruturado SOBE, sem virar uma 2ª rota/retry") é documentado E testado, e ligar por default muda toda sessão ⇒ decisão de ADR, não default trocado de lado.

## [1.0.0-rc.107] — 2026-07-30

### Corrigido

- 🩹 **o self-check para de TOMAR decisões que são do usuário (o mais grave desta leva):** quando o modelo encerrava o turno PERGUNTANDO ("Quer que eu reconfigure assim?"), a auto-verificação pré-"pronto" entrava e o modelo, seguindo o probe, EXECUTAVA a ação que acabara de oferecer — no caso real (dogfooding) editou um `start_daemons.sh` e deu `kill -9` em 5 daemons. Duas causas somadas: (1) o probe oferecia só duas saídas — "confirmo que cumpri" (mentira) ou _"se faltou QUALQUER coisa … CONTINUE trabalhando (use as ferramentas)"_ — sem admitir "o que falta é a decisão do dono"; (2) o gate era só `selfCheck.enabled && successfulToolCalls > 0`, **sem olhar o conteúdo da resposta final**. Agora o probe declara explicitamente que decisão/autorização pendente é conclusão LEGÍTIMA de turno (não continue, não execute, entregue a pergunta — e use a tool `perguntar` se precisar da resposta para seguir), E existe um gate NOSSO (`awaitsUserDecision`) que não depende de o modelo honrar a instrução: fechamento interrogativo ou fórmula de pedido de decisão (PT-BR + EN) ⇒ o loop NÃO sonda e entrega a pergunta. Isso importa porque o self-check liga por DEFAULT exatamente nos tiers FRACOS (`WEAK_TIERS = ['custom']`, todo BYO), que são os que menos honram instrução condicional. Direção do erro é segura por construção: falso positivo só significa "não sondei" = baseline com self-check desligado. Mesma família do gate `successfulToolCalls > 0` (não sonda turno conversacional "por não haver evidência"): aqui não sonda porque **o que falta não é trabalho nosso**. A catraca nunca foi furada (todo tool-call segue passando por `decide()`) — era defeito de AGÊNCIA, que sob `--yolo` (catraca auto-aprovando) virou efeito destrutivo.
- 🩹 **seam de CONTINUAÇÃO unificado no mesmo juízo (o detector fraco guardava a porta perigosa):** o gate `askedUser` do nudge de continuação já tinha a intenção CORRETA desde a estória original ("se o turno final termina numa pergunta ao usuário, NÃO nudgar"), mas usava `endsWithUserQuestion`, que só reconhece `?` no fim da última linha. Pedido de decisão SEM interrogação — "Aguardo sua confirmação.", "Me diga qual prefere.", "Please confirm." — PASSAVA, e este é o seam que injeta o nudge mandando EXECUTAR o próximo passo (`buildPlanPendingNudge`/`buildContinuationNudge`), com o gatilho `pendingPlan` que dispara só por haver caixa aberta no grafo. Havia, portanto, DOIS heurísticos divergentes para o MESMO conceito no mesmo diretório, e o pior deles cobria o caminho de maior efeito. Os dois seams passam a usar `awaitsUserDecision`, que por sua vez DELEGA a parte do `?` ao `endsWithUserQuestion` (fonte única: ele já limpa emoji/pictográficos/ZWJ e decoração markdown antes de olhar o `?`, então pega `**Posso aplicar?**` e `… assim? 🤔`, que uma regex ingênua perderia).
- 🩹 **`aluy onboard` volta a ABRIR a sessão no final — a tela prometia e nada acontecia:** o passo final exibe `enter p/ entrar no aluy`, mas o handler era `if (key.return || key.escape || input) app.exit()` — Enter, Esc e **qualquer** tecla só fechavam o Ink, o processo terminava e o usuário caía no shell depois de configurar tudo. Agora as três intenções são distintas: **Enter** abre a sessão (`runSession`, o mesmo caminho do `aluy launch`); **Esc** sai sem abrir (antes não havia como recusar); **qualquer outra tecla** é ignorada (antes um toque acidental encerrava o onboarding). No perfil **turbo** a cadeia `onboard → bootstrap → aluy` roda inteira — optar pelo turbo É o consentimento da instalação (`docs/turbo.md`), então não se pede o comando de novo; o `runInit` decide sozinho o que falta (perfil leve e "nada a instalar" já eram no-op lá). O bootstrap roda em **processo FILHO** (`stdio: inherit`), não in-process: o provisionamento deixa handles vivos (`ollama serve` detached, watchers do agente) — a mesma razão pela qual o `case 'bootstrap'` força `process.exit()` — e in-process eles travariam este processo ANTES de a TUI abrir. Bootstrap com falha **avisa e abre de todo jeito** (os complementos são enriquecimentos; `/doctor fix` é o reparo), em vez de prender o usuário fora da sessão por causa de um sidecar. Provado em PTY real com HOME isolado (`scripts/ptydrive-onboard-launch.py`).
- 🩹 **`FRONTEIRA DE DADOS` deixa de reaparecer a cada turno (e de acumular no contexto):** o reforço anti-injeção do guardrail de yolo+tier-fraco (F21) tinha o one-shot numa variável **local do `runLoop`** — ou seja, one-shot por EXECUÇÃO. Como a TUI faz um `run`/`resume` por TURNO do usuário, a flag renascia `false` a cada turno e uma cópia NOVA do lembrete era injetada, acumulando no histórico re-semeado (turno N carregava N cópias): exatamente a inflação de contexto que o CAP existe para evitar, além de fazer o modelo gastar turno REAGINDO ao lembrete em vez de trabalhar (o reanchor entra como mensagem `assistant`, então um modelo fraco o trata como fala própria e o papagaia). O estado passa a ser **derivado do histórico** (`hasWeakYoloReanchor`), o que mantém o `AgentLoop` STATELESS entre execuções (invariante documentada em `controller.clear()`) e dá o reset certo de graça: `/clear` zera as sementes ⇒ o guardrail RE-ARMA no contexto novo. Provado em PTY real (`scripts/ptydrive-weak-yolo-reanchor.py`): antes 1→2→3 cópias por turno, agora teto em 1.
- 🩹 **o onboard não duplica a cadeia do instalador:** como o `install.sh` já conduz `onboard → bootstrap → exec aluy` por conta própria (cada etapa reanexada ao `/dev/tty`, porque o stdin do processo é o pipe do `curl`), o fix acima faria a cadeia rodar DUAS vezes pelo caminho `curl | bash` — bootstrap 2× e duas sessões em sequência. O instalador passa a sinalizar `ALUY_ONBOARD_NO_LAUNCH=1` e o onboard retorna após SALVAR a config (que é o que ele tem de garantir). Seguro contra skew nas duas direções: CLI antigo ignora a variável (a cadeia do instalador faz tudo, como sempre) e instalador antigo não a define (o CLI novo abre — correto p/ quem roda `aluy onboard` na mão). Par no repo do site: `aluy-cli-site#4`.
- 🩹 **catálogo `en` completo (fecha a "Fase 2" do i18n):** as 4 últimas chaves do contrato sem par em inglês — `flowtree.cycle`/`flowtree.subcycles`/`flowtree.turn` e `cmd.tools` — caíam no pt-BR pelo fallback do `t()`, então quem rodava `--lang en` lia "ciclo"/"subciclos"/"turno" no log de atividade. Contrato 135 · `en` 135 · faltando 0.

### Alterado

- 🔴 **gate de RELEASE igualado ao de CI (fim de um known-red mascarado):** o `release.yml` ainda excluía `headless-exit.test.ts` e `headless-yolo-bin.test.ts` da validação — os MESMOS testes que o `ci.yml` já havia REINCORPORADO depois que a causa real (um `stub-token` reprovado no `isPat`) foi corrigida na F166. O gate que publica no npm estava, portanto, mais FRACO que o gate que barra o merge — precisamente o que o comentário do `ci.yml` condena. Excludes removidos; a suíte passa inteira (636 arquivos · 8007 testes).

## [1.0.0-rc.106] — 2026-07-10

### Adicionado

- 🌱 **`test-then-register` de modelo local desconhecido — catálogo BYO verificado que cresce sozinho** (ADR-0153, emenda ao ADR-0152 D6c; `seguranca` gate FORTE): no backend `local`, quando um sub-agente pede um modelo local (`model` explícito — spawn/`.md`/dial de config) cujo slug NÃO está no catálogo (declarado nem registrado-na-sessão), o CLI deixa de barrar fail-closed ou de fazer warn-but-allow cego (ADR-0152) e passa a TESTAR AO VIVO uma vez (`checkModelConnectivity`, ping `max_tokens:1`) contra o MESMO provider já autorizado pelo dono, com o fetch PINADO anti-SSRF (EST-1115) e a credencial do keychain/env do boot — nunca `globalThis.fetch`, nunca credencial derivada do spawn/`.md`/config. Se o modelo RESPONDE, o slug é REGISTRADO (append idempotente em `~/.aluy/config.json` `providers[<ativo>].models` + na sessão) e o filho ROTEIA, com uma nota visível; se não responde, o filho recebe um erro acionável (`HTTP 404 — modelo ou baseURL errado?`, com sugestão por distância de edição) ANTES de rodar, sem derrubar os irmãos. Resolve o caso de providers tipo router (ex. tokenrouter/OpenRouter) que servem dezenas de modelos mas cujo catálogo declarado à mão lista só um ou dois — agora qualquer slug real do provider funciona na primeira vez que é pedido, e fica confirmado para sempre. Memoizado por slug (N filhos no mesmo slug = 1 teste); teto de 64 verificações distintas por sessão; slug já conhecido nunca re-testa. O DWIM (`dwimAgentFieldAsLocalModel`, rc.105) é **intocado** — continua fail-closed via catálogo confirmado, nunca dispara o teste vivo (o campo `agent` é inferência de campo errado, não intenção explícita de nomear um modelo).

### Segurança

- 🔒 **Sanitização do erro de conectividade antes da TUI:** `checkModelConnectivity` podia ecoar até 160 caracteres do corpo cru da resposta do provider (potencialmente com sequências ANSI/BEL ou texto sensível) e, no branch de erro de rede/timeout/redirect-bloqueado, a `location`/`baseURL` via a mensagem da exceção. O caminho novo de test-then-register nunca repassa esse texto cru: extrai só o status HTTP (+ dica "chave inválida?"/"modelo ou baseURL errado?" para 401/403/404) quando há uma resposta, ou um texto fixo genérico ("rede/baseURL, ou egress bloqueado pelo anti-SSRF") quando não há — nunca interpola o corpo do provider nem a mensagem da exceção.

## [1.0.0-rc.105] — 2026-07-10

### Corrigido

- 🩹 **`spawn_agent` auto-corrige quando o modelo põe o slug do modelo no campo `agent` por engano** (backend `local`, `seguranca` APROVOU-COM-CONDIÇÕES): pedidos como "spawna sub-agentes no modelo `deepseek/deepseek-v4-flash`" faziam o modelo-pai (mais fraco) colocar o slug no parâmetro `agent` — pensado para o NOME de um perfil `.md` — em vez do parâmetro `model`, e a delegação era recusada com "agente desconhecido" (GS-MD7), levando o modelo a desistir. Agora, quando o `agent` NÃO resolve a nenhum `.md` do registro, o backend `local` reinterpreta o valor como `model` e roteia pelo MESMO caminho D6 (ADR-0152) — SEMPRE com uma nota visível explicando a reinterpretação. Fail-closed: só dispara sob backend local, sem `model` explícito já declarado (o `model` explícito nunca é sobrescrito), com o mesmo juízo `kind:'local'`+slug concreto do D6, e com o catálogo local CONFIRMANDO o slug (catálogo não-listável ou slug ausente dele ⇒ mantém o erro original de "agente desconhecido", nunca o erro de "modelo local desconhecido" — não vaza o palpite). Zero regressão: broker/hospedado, `model` explícito e agentes `.md` reais continuam inalterados.

## [1.0.0-rc.104] — 2026-07-10

### Corrigido

- 🔓 **Roteamento de sub-agente para modelos `vendor/model`/`nome:tag` no backend local** (ADR-0152, condição de segurança 3 REVISADA/re-aprovada pelo `seguranca`): a validação de forma do slug de modelo (`isReasonableModelSlug`) barrava `/` e `:` no corpo do slug — isso impedia rotear um filho a modelos reais de providers multi-vendor no formato `vendor/model` (ex. `deepseek/deepseek-v4-flash` no OpenRouter/tokenrouter) ou com tags no formato `nome:tag` (ex. `llama3:8b` no Ollama), mesmo com o `kind:'local'`/D6 introduzido em rc.103. Agora `/` e `:` são aceitos no corpo do slug — a validação segue barrando SOMENTE caracteres de controle (CR/LF/NUL/TAB/DEL), vazio e o teto de tamanho, já que o slug só alimenta o corpo JSON (`body.model`) da chamada ao provider, nunca um path/header/arquivo.
- 📎 **Orientação do agente para rodar um sub-agente num modelo específico:** a descrição do parâmetro `model` do `spawn_agent` agora deixa explícito que o modelo por-filho vai NESTE campo (ex. `"model": "deepseek/deepseek-v4-flash"`) — e que o agente NÃO deve tentar trocar o provider/modelo da SESSÃO inteira (via shell ou `/provider`/`/model`) para atender um pedido de modelo pontual num sub-agente.

## [1.0.0-rc.103] — 2026-07-10

### Adicionado

- 🎛️ **Rotear um sub-agente para um modelo LOCAL específico** (ADR-0152 D6, backend local/BYO): agora você pode pedir "spawna esse filho no `deepseek-v4-flash`" e o filho roda naquele modelo do seu provider local, **diferente** do pai — reusando o MESMO provider/auth/base*url/fetch-pinado (só o `model` muda; zero credencial ou escopo novo). Novo `kind:'local'` no resolvedor: no backend local um slug cru (ou `local:<slug>`, e `custom:<slug>` como alias) roteia; slug desconhecido com catálogo listável **falha antes com sugestão**, sem catálogo emite **aviso visível** e deixa o provider validar (nunca fallback silencioso). O rótulo mostra `local · <slug>` enquanto roda. Revisado pelo `seguranca` (APROVADO-COM-CONDIÇÕES; 9 condições + bateria T1–T9 no verde). No backend broker/hospedado nada muda. \_Limitação conhecida:* um filho roteado a modelo local usa o protocolo de tool-calling por TEXTO (não o nativo) — aceitável no baseline, a refinar depois.

### Corrigido

- 🔒 Validação de forma do slug de modelo em TODAS as fontes (prompt/`.md`/config): rejeita `/`, CR, LF e chars de controle antes de virar alvo de request (anti-injeção de header/path).

### Corrigido

- 🏷️ **Sub-agente que HERDA o pai mostra o modelo LOCAL concreto** (ADR-0152 D5-bis): no backend **local** (broker local/BYO), o rótulo do filho exibia o tier abstrato (`herdado (aluy-flux)`) em vez do modelo que o pai de fato usa. Agora mostra o concreto — `herdado (deepseek-v4-pro)` — lendo o `activeModel` que o broker reporta. No backend hospedado (broker) nada muda (preserva a abstração de tier). _(Próximo passo, E2/ADR-0152 D6: poder ROTEAR um filho para um modelo local diferente do pai — ex.: "spawna no deepseek-v4-flash" — em release seguinte, com revisão de segurança.)_

## [1.0.0-rc.101] — 2026-07-10

### Corrigido

- 🪟 REDIMENSIONAR a janela não deixa mais aquele "buraco no meio da tela" (espaço vazio) no modo inline ao AUMENTAR o tamanho: o `clearScreen` do resize agora arma um limpa-tela ATÔMICO dentro do envelope de saída sincronizada (`?2026`) — o erase e o re-render viajam juntos, sem frame intermediário só-limpo. Coberto por teste byte-a-byte.
- 🏷️ O MODELO do sub-agente volta a aparecer na UI em TODOS os renderizadores (ADR-0146): o rótulo (ex.: `· herdado (tier)` / `· custom · <slug>`) era CLIPADO porque 3 renderizadores irmãos (`live-budget`, `cockpit-conversa`, `linear`) e o `export-transcript` não estavam sincronizados com o campo `model` — o `live-budget` subestimava a altura visual e disparava o bug de linhas mescladas do Ink 5.2.1. Agora os 4 threadam o `model` e a altura é contada certa; PARAR um sub-agente também PRESERVA o rótulo (antes o `cancelFlow` o descartava).

### Alterado

- 📊 As notas de carregamento de MCP saíram da tela principal (não poluem mais o composer logo após o splash): viram uma BARRA DE PROGRESSO no status bar (`MCP ▰▰▱ n/total`) enquanto conecta e um ✓ rápido (`✓ MCP n/n`) por ~2s ao terminar, que se auto-limpa. Em terminais estreitos (<60 col) a barra cai fora, como o resto do conteúdo suplementar.
- 🎨 O HEADER da UI principal agora mostra o MESMO logo 3D do splash (marca âmbar em relevo + sombra âmbar-escura), porém ESTÁTICO — com as cores e a fonte, sem o efeito de brilho (shimmer). Degrada para o wordmark 2D em terminais mais baixos e para o ASCII `/\` no fallback `TERM=linux`.

_(vazio)_

## [1.0.0-rc.100] — 2026-07-08

### Adicionado

- ⚡ O AGENTE agora dispara COMANDOS DE SESSÃO (ADR-0147): nova tool `session_command` deixa o agente rodar `/cycle`, `/compact`, `/doctor` etc. quando pertinente (fecha o círculo do self-use). Cada comando é classificado por efeito: os SEGUROS disparam direto; os DESTRUTIVOS (ex.: `/clear full` que apaga memória) RE-PASSAM a catraca e pedem CONFIRMAÇÃO — nem `--yolo` relaxa isso; comandos não-classificados negam por padrão (fail-closed). O agente pode INICIAR `/cycle` sozinho, com os tetos duros do CycleEngine como rede anti-runaway.

### Alterado

- 🚀 Boot muito mais rápido (opção 2): o composer aparece em ~6s (era ~34s/~68s) — a descoberta de MCP foi DESACOPLADA do splash e roda em background; as tools MCP se anexam à sessão viva conforme cada server conecta (com nota "N/M conectados"). Também: tecla pra PULAR o splash, e o tool-calling nativo agora se re-anuncia no `/mcp reload`.

_(vazio)_

## [1.0.0-rc.99] — 2026-07-04

### Adicionado

- 🧩 Controle de modelo dos SUB-AGENTES (ADR-0146): agora dá pra escolher o modelo/tier de um sub-agente por 4 vias (todas humanas): parâmetro `model` no `spawn_agent` (você pede no prompt), `model:` no `.md`, dial global `subAgent.model` no config, ou herança do pai. Aceita `same-as-parent`/`custom` (usa o teu BYO), com probe que valida o nome e sugere correção. A UI mostra o modelo de cada sub-agente enquanto roda. Nunca vaza credencial.
- 🎛️ Tunables de operação no config (ADR-0150): o teto de sub-agentes paralelos, a concorrência, os timeouts de MCP, os defaults de `/cycle`, gravações de memória/sessão e mais viraram configuráveis no `~/.aluy/config.json` (com `aluy config` listando), cada um com um teto-teto DURO de segurança que o config não pode furar.

_(vazio)_

## [1.0.0-rc.98] — 2026-07-04

### Adicionado

- 🧠 Self-use (ADR-0145): o agente ganha um MAPA DE CAPACIDADES no prompt + gatilhos "use QUANDO" nas descrições + few-shot no tier fraco + a tool `capabilities` (lista o que ele pode disparar agora) + descoberta de skills. Alvo: com modelo médio (BYO), ele enxerga e DISPARA as próprias capacidades em vez de responder em texto.

### Alterado

- 🎨 Splash: a sombra 3D do wordmark agora SHIMMEIA em ÂMBAR escuro em sincronia com a luz da marca (era teal fixo) — a luz atravessa marca e sombra na mesma passada.
- 📝 O indicador de backend "local" aparece só no rodapé (removido do header, onde duplicava).
- ⚡ Boot ~2× mais rápido: a descoberta de MCP agora conecta os servers EM PARALELO (`Promise.all`) em vez de sequencial.

### Corrigido

- 🔴 Fullscreen: hardening do scroll — o differ do cockpit ficou auto-corretivo (força full-repaint em desalinhamento) e a medição de altura passou a filtrar ANSI, matando a duplicação de header/status-bar ao rolar em sessões grandes.

_(vazio)_

## [1.0.0-rc.97] — 2026-07-04

### Corrigido

- 🔴 Modo inline: redimensionar o terminal aumentava a DISTÂNCIA (gap) entre a área de saída e o composer, crescendo a cada resize (bug antigo, visível com histórico grande / terminais que reflowam). Causa: cada resize remontava o `<Static>` inteiro (Ink reescrevia o histórico + acumulava cópias no `fullStaticOutput`). Fix: resize que muda só a altura pula o clear desnecessário + cooldown entre remontes forçados.

_(vazio)_

## [1.0.0-rc.96] — 2026-07-04

### Alterado

- 🎨 Splash: a SOMBRA 3D do wordmark Λluy voltou a ser TEAL (verde, papel `depth`), destacando o logo e o shimmer âmbar por cima. O logo/shimmer seguem âmbar (accent/accentMid).

_(vazio)_

## [1.0.0-rc.95] — 2026-07-03

### Corrigido

- 🔴 CRASH duro no fullscreen (`RangeError: Invalid array length`): em transições (retomar sessão + entrar no alt-screen + resize) o `stdout.rows` chegava `NaN`, driblava o guard `rows < MIN` (pois `NaN < MIN` é `false`), virava altura de região `NaN` e o Ink fazia `new Array(NaN)` → o processo MORRIA (e levava o Ctrl-C junto). Guard duro: toda dimensão é clampada para inteiro ≥ 1 (ou recusa pro inline) antes de chegar ao Ink/differ.
- 🔴 `/clear` no fullscreen deixava a TELA BRANCA (o differ mantinha o frame velho e só repintava a conversa). Agora `/clear` reseta o differ → full-repaint do cockpit vazio.
- 🎨 Fullscreen: o menu de `/` ficava preso ao limpar o composer com Ctrl-C; agora fecha junto.

- 🔴 Fullscreen (cockpit): o COMPOSER se desconstruía ao digitar texto que quebra em várias linhas — o texto fragmentava e o cursor descasava. Causa: a linha do input eram `<Text>` IRMÃOS (prompt·texto·cursor) e o Ink não flui `<Text>` irmãos como texto contínuo. Fix: virou um `<Text wrap>` único com os segmentos aninhados.
- 🔴 Fullscreen: COMPOSER FANTASMA (duplicado) após transições — ao entrar no /fullscreen vindo do inline, o scrollback antigo prependava cada frame do cockpit, estourava `rows`, o terminal rolava e o diff por-linha dessincronizava. Fix: o differ do cockpit clipa o frame para as últimas `rows` linhas + `overflow:hidden` nas regiões de altura cravada.
- 🎨 Fullscreen: o LOG ocupava espaço morto (dimensionava para conteúdo não pintado) e a conversa VAZIA deixava um vão gigante. Agora o LOG casa o conteúdo real e a sessão vazia mostra uma dica + notas centradas.

_(vazio)_

## [1.0.0-rc.94] — 2026-07-03

### Alterado

- ✨ Splash: o "pisca-pisca" (a sombra 3D que respirava) foi trocado por um **shimmer/brilho** que desliza da ESQUERDA pra DIREITA sobre o wordmark Λluy, em laço com pausa calma (F198). Frame-driven, anti-flicker (6 linhas estáveis), reduced-motion ⇒ estático.
- 🎨 Degradê do pulso e do shimmer agora é **TODO ÂMBAR** (accent→accentMid→accentDim), sem o teal do papel `depth`. Novo papel de tema `accentMid` (âmbar-500) nos 6 temas.

_(vazio)_

## [1.0.0-rc.93] — 2026-07-03

### Corrigido

- 🔴 Espaço em branco gigante com resposta LONGA: uma resposta mais alta que o terminal, streamando, gerava um bloco de dezenas de linhas em branco no scrollback. Fix via **synchronized output mode** do terminal (`\x1b[?2026h/l`) — o terminal bufferiza a atualização e não expõe estados parciais em branco.

### Alterado

- 🎨 Logo Λluy: a perninha (rabo) do "y" foi encurtada (descender de 2→1 linha, ainda ganchando à esquerda) — mais enxuta, fiel ao site.
- 🎨 Pulso de progresso da status bar: maior (4→7 blocos) e com **degradê de 3 tons âmbar** (cabeça `accent` → corpo `depth` → cauda `accentDim`), ligado ao tema.

_(vazio)_

## [1.0.0-rc.92] — 2026-07-03

### Adicionado

- 🟢 Sugestão de próximo prompt (F197): após um turno terminar, o composer mostra um **ghost dim** com uma sugestão do que pedir a seguir; **Tab** aceita (só inline + composer vazio, sem quebrar o Tab de foco/modo); digitar descarta. Heurística LOCAL (custo ZERO de token do provider BYO). Opção togglável: `/suggest on|off`, `ALUY_SUGGESTIONS=0`, `ui.suggestions`. Cérebro portável no cli-core, anti-flicker, cor por papel.

_(vazio)_

## [1.0.0-rc.91] — 2026-07-03

### Adicionado

- 🟢 Splash & marca (F195): (1) splash **sem borda** — layout arejado centrado (marca 3D → tagline âmbar → carregando → versão), estilo profissional, degradação limpa (ASCII/NO_COLOR/estreito); (2) **wordmark Λluy refeito fiel ao logo do site** — Λ com ápice simétrico + splay geométrico até base larga, e o "y" com o rabo CURVADO (gancho à esquerda) do logo real; (3) novo **indicador de progresso `████`** (cursor grosso) na status bar que enche/esvazia quando algo processa, adicional ao Λ piscando. Anti-flicker (frame estável, sem setInterval), fonte-única (splash+header), cores por papel do tema.

_(vazio)_

## [1.0.0-rc.90] — 2026-07-02

### Corrigido

- 🔴 Resize: redimensionar o terminal com a sessão CHEIA (região viva ≥ rows) não gera mais um "espaço em branco gigantesco" que CRESCE a cada resize (F196). Causa: o Ink nunca reseta o `fullStaticOutput`, e o `clearScreen` do resize remontava o `<Static>` → o Ink re-anexava o histórico inteiro → o repaint reescrevia 2×,3×,…N× o scrollback (provado por bytes). Nova `liveRegionMinRows()`: no regime de estouro garantido, o `<App>` PULA o `clearScreen` do resize (redundante+nocivo); o caminho que cabe mantém o clearScreen (limpeza de órfãos intacta). Teste prova por bytes (≤1 cópia por repaint).

_(vazio)_

## [1.0.0-rc.89] — 2026-07-02

### Corrigido

- 🔴 Retomada de sessão: uma sessão morta no MEIO de um turno (Ctrl-C) logo após uma mensagem "encaixada" (btw) perdia o CONTEXTO do modelo ao reabrir (F193) — o transcript aparecia todo na tela, mas o modelo não "se lia" (perdia a própria referência). Causa: `blocksToHistory` DESCARTAVA os blocos `inject` (a fala do usuário injetada mid-turn) ao reconstruir o histórico — a única prova daquela mensagem após save+reload. Agora o `inject` volta como `goal` (canal `user`, como o `you`), com guarda de vazio. Vale p/ `--resume`/`/history`/rewind.

_(vazio)_

## [1.0.0-rc.88] — 2026-07-02

### Adicionado

- 🟢 `/fullscreen` / `/cockpit` RELIGADO para o usuário (F194, pedido do dono): o comando estava desativado atrás do escape hatch `ALUY_FULLSCREEN=1` (só avisava "desativado nesta versão"). O gate foi removido — o modo tela cheia (cockpit) agora entra sob demanda. Já é anti-flicker (stress do cockpit: 0 `\x1b[2J`) e degrada pro inline com aviso quando a tela não cabe. Boot segue INLINE por padrão.

_(vazio)_

## [1.0.0-rc.87] — 2026-07-02

### Corrigido

- 🟡 Permissão: "sempre nesta sessão" numa CRIAÇÃO de arquivo (`write_file`) agora cobre EDIÇÕES subsequentes (`edit_file`) do MESMO arquivo (F192). O grant era chaveado pelo nome cru da tool, então aprovar-sessão ao criar não cobria editar depois (re-perguntava a cada mudança), apesar de `categories.ts` já tratar `write_file`/`edit_file` como a mesma classe. A chave normaliza os dois p/ `file_write` (mantendo o path — segue path-específico). **Segurança:** NÃO relaxa o gate always-ask (destrutivo/fora-do-workspace/sensível), checado à parte em `grantSession` — invariante provado por teste. Session-only, nunca persistido.

_(vazio)_

## [1.0.0-rc.86] — 2026-07-02

### Adicionado

- 🟢 ESC "expedite" — acelerar o encaixe (F191, pedido do dono): com uma mensagem já ESPERANDO encaixe (`user_inject`), o ESC agora CORTA a geração de modelo em voo e SEGUE (drena o inject na volta seguinte), SEM parar o turno. Antes o ESC-com-inject-pendente era no-op. Soft-interrupt novo no core-loop (`ExpediteSignal`/`ExpeditePort` + `combineAbort`), distinto do hard-abort: `interrupt()`/Ctrl-C/ESC-com-tudo-vazio seguem sendo o ÚNICO freio total (precedência do hard-abort preservada). O parcial do turno `aluy` é descartado (o inject supersede). 7 testes cobrindo os invariantes.

_(vazio)_

## [1.0.0-rc.85] — 2026-07-02

### Corrigido

- 🟢 Sessões: o aluy não grava mais sessões-fantasma sem conteúdo retomável (só notas de boot config/tools/inventory, sem mensagem nem rótulo) (F190) — o gate do auto-save era `blocks.length === 0`, que não pegava as sessões só-de-notas (17 de 50 no dogfooding acumuladas em `~/.aluy/sessions/`). Predicado único (`hasResumableContent`) no auto-save E no epílogo de saída (não anuncia "Sessão salva" sem ter salvado). A conversa de install (turnos do agente, F187) segue gravada.

_(vazio)_

## [1.0.0-rc.84] — 2026-07-02

### Corrigido

- 🟢 `aluy agents` / `aluy skills`: o texto de ajuda do estado vazio dizia "frontmatter mínimo: name, description", mas só `name` é obrigatório (fail-closed) — `description`/`tools` são opcionais (sem `description`, o corpo/1ª linha das instruções vira o resumo). Texto corrigido p/ refletir o comportamento real (F189).

_(vazio)_

## [1.0.0-rc.83] — 2026-07-02

### Corrigido

- 🟡 Resume: o boot não oferece mais retomar conversas SÓ do agente (instalação/conserto de sidecars, sem mensagem do usuário) (F187) — `countUserTurns` (só `you`) no boot-offer/`--continue`/lista do `--resume`; ficam gravadas e recuperáveis por id, só ocultas. Também some sessões vazias de boot da oferta.

### Adicionado

- 🟢 Resume: ao sair, a dica de retomada mostra também `aluy --resume <nome>` (além do id) quando a conversa tem rótulo (F188).

_(vazio)_

## [1.0.0-rc.82] — 2026-07-02

### Corrigido

- 🟡 `aluy config`: a lista de arquivos de `~/.aluy/` agora inclui o estado do usuário antes ausente (F186) — `sessions/` (histórico das conversas), `audit.jsonl` (trilha de auditoria), `cron`, `exports/` e `undo/`. Antes só mostrava config/mcp/hooks/providers/memory/logs.

_(vazio)_

## [1.0.0-rc.81] — 2026-07-02

### Corrigido

- 🟡 `aluy config`: a view de config efetiva agora lista os limites de orçamento `maxTokens`/`maxOutputTokens`/`maxIterations` (F185) — estavam ausentes apesar de serem config durável (ADR-0136), sobreponíveis por `ALUY_MAX_*` e mostrados pelo `doctor`. Com valor efetivo, origem (env/config/default) e precedência.

_(vazio)_

## [1.0.0-rc.80] — 2026-07-02

### Corrigido

- 🟡 Diagnóstico de erro de modelo no backend LOCAL (BYO): não sai mais como `erro de broker: …provider local` (prefixo contradizendo o corpo) (F184) — agora `erro do provider local: …`. O bloco já sabia o backend (F52); faltava usá-lo no render linear/headless. Família do F182/F183.

_(vazio)_

## [1.0.0-rc.79] — 2026-07-02

### Corrigido

- 🟡 `aluy whoami` no backend LOCAL (BYO): não reporta mais o falso `não autenticado — rode aluy login` (exit 1) (F183) — agora mostra mensagem honesta de BYO (a credencial é a chave do provider; veja `aluy models`/`aluy config`) + exit 0, sem tocar o keychain do broker. Irmão do F182 (doctor).

_(vazio)_

## [1.0.0-rc.78] — 2026-07-02

### Corrigido

- 🟡 `aluy doctor` no backend LOCAL (BYO): `credencial` e `tier (--deep)` não reportam mais falsos-negativos (F182) — antes davam `✗ não autenticado`/`✗ sessão expirou` com conselho de broker (`aluy login`) que não cabe no BYO; agora viram `N/A (backend local)` como `broker`/`catálogo` já faziam. Sem probar o broker nem gastar turno do modelo.

_(vazio)_

## [1.0.0-rc.77] — 2026-07-02

### Corrigido

- 🔴 Sinais: o aluy agora ENCERRA em SIGINT/SIGTERM externos (F181) — `kill`, `kill -INT`, `kill -TERM`, systemd/`docker stop` não o derrubavam (só SIGHUP/SIGKILL), porque dois handlers de sinal restauravam o terminal mas nenhum chamava exit (a suposição "o Ink encerra no SIGINT" era falsa — o Ink lê o byte \x03 do stdin, não o sinal). O handler de restauração agora encerra deterministicamente (exit 130/143), sem afetar o duplo-Ctrl-C interativo (raw mode ⇒ Ctrl-C é byte, não sinal).

_(vazio)_

## [1.0.0-rc.76] — 2026-07-02

### Corrigido

- 🟡 CLI: `aluy <nome-de-comando-de-sessão>` (ex.: `aluy add-dir /x`, `aluy rename`) não vira mais um objetivo enviado ao modelo (gastava turno) — vira `usage-error` (exit 2) com hint p/ o slash equivalente (F180). Ultra-conservador: só quando o objetivo é EXATAMENTE uma palavra igual a um comando de sessão; multi-palavra (`aluy \"rename o arquivo X\"`) segue objetivo normal.

_(vazio)_

## [1.0.0-rc.75] — 2026-07-02

### Adicionado

- `/export` como comando (F179): grava o transcript REDIGIDO (CLI-SEC-6) desta sessão em `~/.aluy/exports/` (0600), em QUALQUER modo. Antes o hint do `/fullscreen` prometia `/export` mas o comando não existia ("comando desconhecido") — só havia o ctrl+s do cockpit (desativado).

## [1.0.0-rc.74] — 2026-07-02

### Corrigido

- Painel `/permissions`: strings acentuadas (F178) — "catraca padrão", "aprovação DESLIGADA", "modo de sessão", "TRAVADO por segurança · só via --yolo", "o painel não relaxa… o único bypass total é --yolo" (antes sem acento, destoando do resto da UI PT-BR).

## [1.0.0-rc.73] — 2026-07-02

### Corrigido

- 🟡 `aluy cron add/edit`: valida a FAIXA dos campos cron (minuto 0-59, hora 0-23, …), não só a contagem (F177) — antes um `99 99 * * *` era salvo e o crontab do SO rejeitava com erro cru (exit 0, job-lixo persistido); agora falha cedo com mensagem clara e exit 1, sem salvar.

## [1.0.0-rc.72] — 2026-07-02

### Corrigido

- 🟡 TUI: `/rename <nome> --cor <inválida>` não descarta mais o nome válido (F176) — aplica o nome com a cor automática e avisa que a cor caiu (antes o rename inteiro abortava e o nome se perdia). `--cor` sem nome segue erro.

## [1.0.0-rc.71] — 2026-07-02

### Corrigido

- 🟡 Headless: `--output-format` com valor inválido (ex.: `xml`) agora falha CEDO com `usage-error` (exit 2) em vez de rodar o turno (gastando modelo) e não imprimir nada (F175).

## [1.0.0-rc.70] — 2026-07-02

### Corrigido

- 🟡 TUI: anexo `@arquivo` pendente deixou de sobreviver ao Ctrl-C (F174) — o chip contava só o texto, então "limpar o composer" deixava o anexo pendurado (grudava no próximo objetivo) e, com texto vazio + chip, o Ctrl-C armava a saída em vez de limpar o anexo. Agora o Ctrl-C limpa texto E anexos.

## [1.0.0-rc.69] — 2026-07-02

### Corrigido

- 🟡 TUI: `/comando` DESCONHECIDO + Enter deixou de ser tecla morta (F173) — com o slash-menu aberto e nenhum match, o Enter fecha o menu, limpa o composer e avisa `comando desconhecido: /xyz — veja /help` (antes: nada acontecia, o rodapé "enter executa" mentia). Um `/xyz` nunca vira objetivo do modelo.

## [1.0.0-rc.68] — 2026-07-02

### Corrigido

- 🟡 Modo tela cheia (cockpit, ADR-0076; segue DESATIVADO — escape hatch `ALUY_FULLSCREEN=1`): UX consertada de ponta a ponta (#5). F170 — a CONVERSA janelava por nº de BLOCOS (como se cada um ocupasse 1 linha): conteúdo estourava a região fixa e o Ink 5.2.1 MESCLAVA linhas ("texto embaralhado/sobreposto"); agora a janela é por LINHAS VISUAIS (`cockpit-conversa.ts`: medição espelho do render, wrap por palavra idêntico ao do Ink via `wrap-ansi`, clip NA FONTE do que não cabe — soma visível ≤ região por construção). F171 — o LOG estourava a Box fixa (tail de evento `running` não contado; bootInfo sem teto) e as notas de boot relocadas ficavam INVISÍVEIS (log recolhia p/ 1 linha); tudo bounded e contado no sinal adaptativo. F172 — scroll da conversa não alcançava o topo (clamp com unidades trocadas) e submeter com a vista rolada deixava a resposta fora da janela (agora snap p/ a cauda). Densidade: régua do log lisa (rótulo/estado dentro da região, com ▌ de foco a11y). Anti-flicker PROVADO no novo modo `cockpit` do `pty-flicker-stress`: 0 `\x1b[2J` em 24×80, 33×196, 22×60 e 50×220 com sessão gigante + saída viva.

## [1.0.0-rc.67] — 2026-07-02

### Corrigido

- 🟡 Salas: `room_read`/`room_post` de sala inexistente deixou de ser beco sem saída (F157) — o erro lista as salas VIVAS da sessão e explica como salas nascem (`spawn_agent room:"<código>"` · `/rooms`); antes o agente tentava variações às cegas.

## [1.0.0-rc.66] — 2026-07-02

### Corrigido

- 🟡 Discovery de agentes/comandos/workflows aceita SYMLINKS p/ `.md` (F154) — `Dirent.isFile()` não segue o link e os perfis do projeto (symlinks p/ o specs) sumiam, forçando cópias como workaround. O confinamento fica intacto: symlink escapando o workspace segue rejeitado (resolveInside + statSync com teto). Fix nos 6 discoveries (project/user × agents/commands/workflows).

## [1.0.0-rc.65] — 2026-07-02

### Adicionado

- `--resume <nome>` (F169, pedido do dono): retomada de sessão também pelo NOME dado no `/rename` (case-insensitive), não só pelo id. Nome ambíguo (2+ sessões) ⇒ abre o seletor filtrado nelas; id literal sempre vence o nome.

### Corrigido

- 🟠 "Te aviso quando terminar" agora AVISA (F168): um evento de conclusão (fan-out/monitor/conector) que chegava com o pai fora de idle/done era descartado pelo guard do wake e ninguém re-tentava — o resultado ficava preso até o usuário cutucar. `setPhase(idle|done)` re-arma o wake: o turno de incorporação nasce sozinho (mesma catraca; prova-vermelho executada).

## [1.0.0-rc.64] — 2026-07-02

> Lote de estabilização do dogfooding (PR #2, squash `843e4df`): F159–F167 + anti-despejo + anti-flicker de sessão gigante + gitleaks via CLI pinado + suíte 100% na esteira.

### Adicionado

- Paste/colapso: colapsa pastes grandes em chip no composer e expande no submit (#230).
- Sandbox P1: confinamento de SO do bash com opt-in — `cgroups` (fork-bomb/DoS) (#225) e rede sob política de egress (#223).
- Sandbox: montagem de `/proc` e `/dev` nos binds corretos (#227).
- Comandos `--cycles`/`--cycle-for` no CLI e `/cycle` no TUI com exit code 2 no `--cycle` sem teto (#220).
- Salas multi-agente: `spawn_agent room:` permite sub-agentes se comunicarem via sala compartilhada (#219).
- Salas: `room_post` + `room_read` + teste de anti-laundering (#216).
- Salas: `RoomStore` com holder mutável por código e capacidade (#211).
- Salas Fase 2: write/mesh com authz e anti-loop (#186).
- Salas Fase 1: mensagens-como-dado com código/TTL/revogação (#179).
- Monitor (vigias assíncronos): tools `monitor`/`monitors`/`monitor_cancel` + wiring na sessão — file-watch + process-wait (#214, #212, #207).
- Monitor: `EventQueue` + drenagem no loop como DADO (#202).
- Comando `/ask`: side-query paralela read-only e slash `/ask` — controller.askParallel (#213, #206).
- Comando `/provider`: seletor de provider do modo Custom (picker+menu+estado) (#178).
- Flags `--effort`/`/effort`: `reasoning_effort` com custom passthrough ao broker (#199).
- Flag `--cycle`: objetivo em ciclos autônomos no `-p`, em par com `/cycle` (#210).
- Flag `--provider <name>`: injeta o nome do provider no body Custom (#176).
- `--output-format stream-json` no headless: eventos NDJSON ao vivo no `-p` (#196).
- Headless: progresso human-readable no stderr (default-on) + `--quiet` (#201).
- `/mcp reconnect` + `/mcp reload` ao vivo: recupera server MCP sem reiniciar (#197, #209).
- Backstop de OOM: `heap-limit` adaptativo (fração da RAM) + monitor de pressão de memória (#177, #195).
- Teste de segurança: corpus de avaliação com gate numérico (#182).
- Teste sandbox: teste dedicado do `resourceWarning` surfado no shell-port — FU gate cgroups (#228).
- Teste de release: scan "binário público limpo" do bundle + prova-vermelho (#184).
- CI: gate de SCA/supply-chain (npm audit prod + osv-scanner) (#53).

### Mudado

- `publishConfig.access` agora `"public"` nos pacotes — preparação para publicação npm (#185).
- CI de release: bundle + scan no `release.yml`; guarda obsoleta removida (#185).
- Build de release: embute `@hiperplano/aluy-cli-core` no bundle de publicação (#183).

### Corrigido

- 🔴 Testes: `npm test` CLOBBERAVA o `localProvider` REAL do usuário (F167) — o save de `backend/localProvider` do `aluy login` usava `new UserConfigStore()` fixo (HOME real) e os testes de local-login exercitavam o caminho sem injetar o store ⇒ cada rodada da suíte trocava o provider configurado pelo dos testes (openrouter/anthropic) e o login "sumia". `configStore` agora é injetável e todos os testes usam store de tmpdir (com teste-prova de isolamento).
- 🔴 CI: os testes de binário (headless-exit/headless-yolo-bin) estavam EXCLUÍDOS da esteira (`--exclude` no ci.yml — known-red mascarado, F166): o token de teste `stub-token` reprovava no `isPat` do fallback `ALUY_TOKEN` e o binário morria em "sem credencial". Token corrigido p/ o formato válido (`pat_<32hex>_<secret>`) e exclusão removida — a suíte volta a rodar INTEIRA na CI.
- 🔴 Login BYO "sumindo" sozinho (F165): em Linux SEM Secret Service (VPS/servidor headless) o keychain cai no keyring do KERNEL — memória, some em todo reboot — e o CLI gravava ali EM SILÊNCIO. Agora `aluy login`/onboard detectam o cofre volátil (`/proc/keys`) e avisam com o caminho de correção (instalar gnome-keyring ou exportar `ALUY_<PROVIDER>_API_KEY`). Sem fallback em claro (CLI-SEC-2 intacto).
- Catraca: efeito GIGANTE (batch/heredoc/diff de 100+ linhas) no AskDialog é JANELADO (F164, decisão do dono) — cabeça + `… (+N linhas ocultas — [e] editar mostra tudo)` + cauda; antes o box estourava a tela e o COMEÇO do comando rolava p/ fora antes da decisão. Recorte com marcador explícito, nunca resumo (CLI-SEC-9 honesto); abaixo de 14 linhas o render é idêntico.
- 🔴 TUI: flicker de SESSÃO GIGANTE em tela baixa/estreita (F163) — três furos no orçamento anti-flicker faziam o frame cruzar `rows` e o Ink reescrever o histórico INTEIRO a cada frame (medido: 22x60 ⇒ 32 clearTerminal/15MB em ~3s): (a) StatusBar/FooterHints quebram p/ 2 linhas em colunas < 80 sem entrar no orçamento (`narrowChromeOverhead`); (b) o cabeçalho `◌ running` de tool/bang era contado como 1 linha fixa mas quebra com alvo/comando largo (`runningHeaderVisualLines`); (c) a cauda viva de shell era FIXA em 6 linhas mesmo sem espaço (`liveShellTailMaxLines` — cap adaptativo, mesma fonte p/ orçamento e render). Após o fix: 0 clears em todas as dimensões testadas; harness de regressão em `scripts/pty-flicker-stress.mjs`.
- CI: o job `secrets` (gitleaks) deixou de ser known-red — a gitleaks-action exige licença de org (`GITLEAKS_LICENSE`, ausente) e falhava em TODA branch; agora roda o CLI pinado (binário v8.30.1 + SHA256 verificado, padrão do secrets-scan central). O scan de histórico REAL achou 2 fixtures sintéticas dos testes de redação do juiz (ADR-0137 C1) — allowlist honesta por path-exato no `.gitleaks.toml`.
- 🔴 Undo: o journal deixou de DERRUBAR comandos — `~/.aluy/undo` apagado no meio da sessão recriava ENOENT eterno em TODO `run_command`; o store agora recria a árvore e tenta 1×, e o seam da tool degrada (marca `degraded`) em vez de propagar (F162).
- TUI: `/model` no backend LOCAL (BYO) não oferece mais os tiers do broker (beco sem saída) — mostra a nota do caminho local (`/provider` · `ALUY_LOCAL_MODEL`/`--model`) (F161).
- TUI: Esc SOZINHO volta a funcionar (fechar picker/dialog) — o guard de CSI-u (#18) retinha um `\x1b` solitário PARA SEMPRE aguardando o resto da sequência; agora um flush por timeout (75ms) o entrega como tecla quando a continuação não vem (F159).
- TUI: saída por duplo Ctrl-C confiável — o armado vive num ref com timestamp (janela de 2,5s por tempo real), não no estado React do closure; dois Ctrl-C no mesmo tick do Ink agora SAEM (F160).
- TUI: o ALVO das linhas de tool (`◌`/`⏺`) é clampado a 1 linha — um batch/heredoc de 100+ linhas como `command` não despeja mais o conteúdo inteiro no transcript (`clampTarget`: 1ª linha + `… (+N linhas)`).
- 🔴 TUI: gap infinito entre o transcript e o composer em sessão RENOMEADA — o orçamento anti-flicker media o wrap do composer com indent fixo de 2 colunas, ignorando a tag `● <nome> ` do `/rename`; com nome longo o frame estourava `rows` e o Ink acumulava linhas em branco a cada tecla (`composerIndentCols`: indent real, uma fonte só p/ App e Composer).
- TUI: o marcador `↑N linhas` da janela do composer contava CHARS no recorte de linha única longa (ex.: `↑1307 linhas` num input de ~16) — agora converte p/ linhas visuais.
- 🔴 TUI: sequência CSI-u de tecla funcional do kitty keyboard protocol (ex.: `\x1b[57414u`) não derruba mais o app — um guard no canal RAW filtra a sequência antes de chegar ao `parseKeypress` do Ink, que crashava em `use-input.js` (`startsWith` sobre `undefined`) (#18).
- Splash: elimina reticências duplicado em "carregando…/descobrindo MCP…" (#229).
- Cockpit: overflow `hidden` na região de conversa — fim da sangria/perda de conteúdo (#224).
- Eviction de monitores mortos no arm — fim do cap sem reuso (#222).
- Eviction de salas mortas no `create` — fim do cap sem reuso (#221).
- Headless: hooks `pre-tool`/`post-tool` no `-p` (#218).
- TUI: percentual da janela reflete o contexto atual (`tokens_in`), não o cumulativo (#215).
- Headless: dispara lifecycle hooks (`session-start` + `turn-end`) no `-p` (#204).
- CLI: `flagValue` não engole a próxima flag como valor (#205).
- Search: truncamento visível no `SearchPort` + nota honesta no grep (#198).
- Headless: `stream-json` não imprime resposta crua — só NDJSON (#200).
- Doctor: `timeout` no `close()` do probe MCP — `/doctor` não trava em "testando…" (#189).
- Shell: Windows — kill por árvore (`taskkill /T`) no timeout/abort (#188).
- Sub-agente: herda o **provider** do pai (não só tier+model) (#187).
- IO: sufixo aleatório no temp atômico evita colisão EEXIST (#180).
- CLI: teto de bytes no stream + binário em read/`@attach` + cleanup SIGINT/SIGTERM (#171).
- 3 correções da 2ª caça: Ctrl-C abortável no device-flow + `isRecord` rejeita array + meta de memória validada (#175).
- Watchdog: serializador de input estável recursivo — corrige falso-positivo do cheque de travamento (#173).
- Permissão (catraca): recall do `rm` long-form/pós-operando + escalada (su/chown/setcap) (#174).
- Anexo (`@path`): menção aceita espaços — aspas/escape (#172).
- Audit: yolo vai para `~/.aluy/audit.jsonl`, não para o stderr — fim do ruído a cada boot (#208).
- Testes: migra `search-port` para o contrato `{matches,truncated}` — corrige `main` vermelho (#203).

### Segurança

- Sandbox P0/P1: cgroups (fork-bomb/DoS) + rede sob política de egress (#225, #223).
- Sandbox: montagem correta de `/proc` e `/dev` depois dos binds — fim do `/dev/null` quebrado (#227).
- Salas: anti-laundering + authz write/mesh + anti-loop (#216, #186).
- Permissão: catraca aprimorada — recall de `rm` long-form/pós-operando + escalada (su/chown/setcap) (#174).
- SCA: gate de supply-chain (npm audit prod + osv-scanner) (#53).

## [0.1.0] — não lançado

Pré-release. Núcleo agêntico do `aluy`: loop de ferramentas local, TUI Ink, MCP,
sub-agentes, ponto único de permissão e o provider BYO do usuário.

[Não lançado]: https://github.com/hiperplano/aluy-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hiperplano/aluy-cli/releases/tag/v0.1.0
