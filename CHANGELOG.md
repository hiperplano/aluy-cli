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
