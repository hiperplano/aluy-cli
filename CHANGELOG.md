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

_(vazio)_

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
