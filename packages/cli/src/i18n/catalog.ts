// EST-0989 · i18n — o CATÁLOGO (chaves estáveis) + o tipo de cada catálogo.
//
// Uma chave i18n é uma string ESTÁVEL e namespaced (`composer.placeholder`,
// `hints.idle`, `boot.broker`). O catálogo de um idioma mapeia chave → texto. O
// pt-BR é o catálogo COMPLETO/CANÔNICO (define o conjunto de chaves); o `en` é
// PARCIAL (Partial) — uma chave faltando nele cai no pt-BR pelo `t()` (fallback).
// Por isso só o pt-BR tipa `Catalog` (todas as chaves); o `en` é `Partial<Catalog>`.
//
// As chaves são literais no `Catalog` ⇒ o TypeScript GARANTE em compile-time que o
// pt-BR cobre todas e que ninguém chama `t()` com chave inexistente — a 1ª linha de
// defesa contra "chave crua na tela". O runtime tem a 2ª linha (fallback no `t()`).

/**
 * O conjunto FECHADO de chaves i18n (Fase 1). Cada propriedade é uma chave estável;
 * o valor é o texto naquele idioma. Namespaces por tela/feature p/ navegar:
 *   - `composer.*`  — input
 *   - `hints.*`     — footer de atalhos por estado (FooterHints)
 *   - `statusbar.*` — rótulos/erros da barra de status
 *   - `boot.*`      — splash de boot
 *   - `picker.*`    — linhas de ajuda dos seletores (theme/lang)
 *   - `lang.*`      — mensagens do `/lang`
 *   - `cmd.*`       — descrições (summary) dos slash-commands nativos
 *
 * Fase 2 (FU) adiciona `ask.*`, `permissions.*`, `doctor.*`, `agents.*`, `mcp.*`,
 * `error.*`, `onboarding.*` — o framework já comporta; só faltam as chaves+textos.
 */
export interface Catalog {
  // ── Composer (input) ──────────────────────────────────────────────────────
  'composer.placeholder': string;
  /** Selo de modo shell (`!comando`): a cola após o texto digitado. */
  'composer.shellHint': string;
  /** BUG P2-C — sufixo do marcador de linhas escondidas do composer multi-linha (cockpit). */
  'composer.moreLines': string;

  // ── FooterHints (§4.3) — uma linha de atalhos por estado ──────────────────
  'hints.idle': string;
  'hints.thinking': string;
  'hints.streaming': string;
  'hints.ask': string;
  'hints.askDestructive': string;
  'hints.slash': string;
  'hints.palette': string;
  'hints.budget': string;
  'hints.error': string;
  'hints.workSubagents': string;
  'hints.idleSubagents': string;
  // EST-1015 — duplo Ctrl+C p/ sair: confirmação após o 1º Ctrl+C no composer vazio.
  'hints.ctrlcAgain': string;
  // EST-1000 · ADR-0076 §3/§4 — atalhos do MODO COCKPIT (alt-screen, 6 regiões).
  'hints.cockpit': string;

  // ── Cockpit (ADR-0076) — rótulos das regiões + avisos de modo/degradação ──
  /** Rótulo da região de CONVERSA (scroll próprio). */
  'cockpit.conversa': string;
  /** Rótulo da região de LOG (atividade agêntica, altura cheia). */
  'cockpit.log': string;
  /** EST-1015 — TÍTULO do boas-vindas centralizado na CONVERSA vazia (idle/boot). */
  'cockpit.welcomeTitle': string;
  /** EST-1015 — DICA do boas-vindas (digite um objetivo · /help · /fullscreen sai). */
  'cockpit.welcomeHint': string;
  /** Aviso ao ENTRAR no cockpit (alt-screen). */
  'cockpit.entered': string;
  /** EST-1000 · ADR-0076 — nota de que o cockpit é EXPERIMENTAL (inline é o recomendado). */
  /** Aviso ao SAIR do cockpit (volta ao inline). */
  'cockpit.left': string;
  /** Recusa por tela ESTREITA (<80 col) — cai pro inline (ADR §6). */
  'cockpit.refuseNarrow': string;
  /** Recusa por tela BAIXA (poucas linhas) — cai pro inline (ADR §6). */
  'cockpit.refuseShort': string;
  /** Confirmação do `/export` (arquivo gravado, redigido). */
  'cockpit.exported': string;

  // ── ModeIndicator / UnsafeBanner (EST-0959/EST-0948) ──────────────────────
  // O eixo de modo (plan|normal|unsafe) é SEMPRE visível e INEQUÍVOCO (a11y): a
  // PALAVRA do modo (`PLAN`/`NORMAL`/`YOLO`) é identificador de PRODUTO e NÃO se
  // traduz; só a PROSA ao redor (o prefixo `modo` e o caption) vira i18n.
  /** Prefixo antes da palavra do modo no indicador compacto (`modo PLAN`). */
  'mode.label': string;
  /** Caption (cauda explicativa) por modo — só no indicador compacto, não-narrow. */
  'mode.plan.caption': string;
  'mode.normal.caption': string;
  'mode.unsafe.caption': string;
  /** Banner YOLO (aprovação DESLIGADA) — forma larga e forma narrow (telas <60col). */
  'banner.yolo': string;
  'banner.yolo.narrow': string;

  // ── StatusBar — rótulos/erros lidos pelo humano ───────────────────────────
  /** Texto a11y do selo de erro de broker (acompanha o glifo `⚠`). */
  'statusbar.brokerError': string;
  /** Rótulo do medidor de janela de contexto (`⛁ NN% janela`). */
  'statusbar.window': string;
  /** Rótulo do medidor do teto de tokens da sessão (`◔ NN% sessão`). */
  'statusbar.session': string;
  /** Rótulo do medidor de quota de billing (`◔ NN% quota`). */
  'statusbar.quota': string;
  /** FATIA 1 — rótulo do CICLO de vida do loop (`↻ ciclo N/M`). */
  'statusbar.cycle': string;
  /** FATIA 1 — rótulo dos SUBCICLOS (caixas do plano) (`· subciclos K/T`). */
  'statusbar.subcycles': string;
  /** FATIA 2 — rótulo do CICLO no cabeçalho da árvore de fluxos (`↻ ciclo N/M`). */
  'flowtree.cycle': string;
  /** FATIA 2 — rótulo dos SUBCICLOS no cabeçalho da árvore (`subciclos K/T`). */
  'flowtree.subcycles': string;
  /** FATIA 2 — rótulo do TURNO em curso no cabeçalho da árvore (`turno`). */
  'flowtree.turn': string;

  // ── Boot / splash ─────────────────────────────────────────────────────────
  'boot.broker': string;
  'boot.tagline': string;
  'boot.connecting': string;
  'boot.entering': string;

  // ── Pickers (theme/lang/provider) — linha de ajuda (mecânica espelhada) ────
  'picker.theme.help': string;
  'picker.lang.help': string;
  // EST-0962 (/provider) — ajuda + dica do item DEFAULT no seletor de provider.
  'picker.provider.help': string;
  'picker.provider.default': string;
  'picker.provider.fallback': string;
  /** Indicador de janela: `… {count} providers a mais` quando a lista é janelada. */
  'picker.provider.more': string;

  // ── ModelPicker (/model · EST-0962) — ajuda, estados e browser Custom ──────
  /** Linha de ajuda no topo do seletor de tier. */
  'picker.model.help': string;
  /** Aviso enquanto o catálogo de tiers carrega do broker. */
  'picker.model.loading': string;
  /** Cauda da linha CUSTOM (abre o browser de modelos). */
  'picker.model.customLine': string;
  /** Aviso NEUTRO (HG-2) de catálogo do broker indisponível (mostra tiers conhecidos). */
  'picker.model.fallback': string;
  /** Ajuda do BROWSER Custom (digitar filtra; ↑↓; ^T só-tools; enter; esc). */
  'picker.model.browseHelp': string;
  /** Contador "N de M" do browser. params: {filtered},{total} */
  'picker.model.browseCount': string; // params: {filtered}, {total}
  /** Sufixo do contador quando o filtro "só com tools" está ligado. */
  'picker.model.toolsOnlySuffix': string;
  /** Indicador de itens acima da janela (scroll p/ cima). */
  'picker.model.moreAbove': string;
  /** Indicador de itens abaixo da janela (scroll p/ baixo). */
  'picker.model.moreBelow': string;
  /** Lista carregada mas nada casa o filtro ⇒ enter usa o texto digitado (slug livre). */
  'picker.model.noFilterMatch': string;
  /** Aviso warn-but-allow do realce SEM suporte a tools. */
  'picker.model.noTools': string;
  /** Ajuda do texto-livre puro (lista NÃO carregou — digita/cola o slug). */
  'picker.model.freeHelp': string;
  /** Aviso warn-but-allow de slug fora do catálogo curado. */
  'picker.model.outOfCatalog': string;

  // ── Passo de EFFORT do /model conjugado (EST-1117) ────────────────────────
  /** Ajuda do passo de effort (↑↓ navega; enter aplica o trio; esc volta). */
  'picker.effort.help': string;
  /** Opção "manter" o effort atual (não muda). */
  'picker.effort.keep': string;
  /** Opção nível baixo. */
  'picker.effort.low': string;
  /** Opção nível médio. */
  'picker.effort.medium': string;
  /** Opção nível alto. */
  'picker.effort.high': string;
  /** Opção "custom" (abre o texto-livre passthrough). */
  'picker.effort.custom': string;
  /** Ajuda do effort custom (digite o valor; enter confirma; esc volta). */
  'picker.effort.customHelp': string;
  /** Aviso: effort custom vazio. */
  'picker.effort.warnEmpty': string;
  /** Aviso: effort custom acima de 32 caracteres. */
  'picker.effort.warnTooLong': string;

  // ── HistoryPicker (/history · EST-0972) ───────────────────────────────────
  /** Linha de ajuda no topo do seletor de sessões. */
  'picker.history.help': string;
  /** Estado vazio (nenhuma sessão anterior). */
  'picker.history.empty': string;
  /** Indicador de janela: `… {count} sessões a mais` quando a lista é janelada. */
  'picker.history.more': string;

  // ── RewindPicker (/rewind · Esc Esc · EST-XXXX) ───────────────────────────
  /** Linha de ajuda no topo do seletor de checkpoints. */
  'picker.rewind.help': string;
  /** Estado vazio (nenhum ponto de restauração nesta sessão). */
  'picker.rewind.empty': string;
  /** Indicador de janela: `… {count} pontos a mais` quando a lista é janelada. */
  'picker.rewind.more': string;
  /** Linha de ajuda da escolha de AÇÃO sobre o ponto selecionado. */
  'picker.rewind.action.help': string;
  /** Ação: restaurar código + conversa. */
  'picker.rewind.action.both': string;
  /** Ação: só a conversa (trunca o histórico). */
  'picker.rewind.action.conversation': string;
  /** Ação: só o código (reverte arquivos editados depois do ponto). */
  'picker.rewind.action.code': string;
  /** Aviso de barreira não-reversível (run_command) depois do ponto. */
  'picker.rewind.barrier.warn': string;

  // ── FilePicker (@ anexar · EST-0957) ──────────────────────────────────────
  /** Linha de ajuda no topo do fuzzy-pick de arquivos. */
  'picker.file.help': string;
  /** Estado vazio (nenhum arquivo casa a query). params: {query} */
  'picker.file.empty': string; // params: {query}
  /** Cauda "… N arquivos a mais (refine o filtro)". params: {count} */
  'picker.file.more': string; // params: {count}

  // ── CommandPalette (ctrl-p · EST-0961) ────────────────────────────────────
  /** Linha de ajuda no topo da paleta de comandos. */
  'picker.palette.help': string;
  /** Placeholder do campo de busca (query vazia). */
  'picker.palette.search': string;
  /** Estado vazio (nenhum comando casa a query). params: {query} */
  'picker.palette.empty': string; // params: {query}
  /** Cauda "… N comandos a mais (refine a busca)". params: {count} */
  'picker.palette.more': string; // params: {count}

  // ── /lang (mensagens não-TTY / avisos) ────────────────────────────────────
  'lang.changed': string; // params: {label}
  'lang.unknown': string; // params: {input}
  'lang.current': string; // params: {label}
  'lang.listTitle': string;

  // ── Slash-commands — descrições (summary) lidas no menu/palette ───────────
  'cmd.help': string;
  'cmd.login': string;
  'cmd.logout': string;
  'cmd.whoami': string;
  'cmd.telegram': string;
  'cmd.model': string;
  'cmd.provider': string;
  'cmd.effort': string;
  'cmd.theme': string;
  'cmd.lang': string;
  'cmd.usage': string;
  'cmd.rename': string;
  'cmd.history': string;
  'cmd.notify': string;
  'cmd.undo': string;
  'cmd.redo': string;
  'cmd.rewind': string;
  'cmd.clear': string;
  'cmd.compact': string;
  'cmd.cycle': string;
  'cmd.permissions': string;
  'cmd.addDir': string;
  'cmd.init': string;
  'cmd.memory': string;
  'cmd.mcp': string;
  'cmd.doctor': string;
  'cmd.todo': string;
  'cmd.tools': string;
  /** EST-1000 · ADR-0076 — `/fullscreen` (alias `/cockpit`). */
  'cmd.fullscreen': string;
  /** F179 — `/export` (transcript redigido em ~/.aluy/exports/). */
  'cmd.export': string;
  'cmd.quit': string;
  /** EST-1105 · ADR-workflows — `/workflows`: lista os workflows .md mapeados. */
  'cmd.workflows': string;
}

/** Toda chave i18n válida (derivada do `Catalog` — fonte única). */
export type I18nKey = keyof Catalog;

/**
 * Os PARÂMETROS de interpolação aceitos por uma chave. Só strings/números (texto
 * inerte): o `t()` NÃO interpola HTML/shell — o valor entra cru no texto da TUI
 * (CLI-SEC: sem injeção via catálogo, params são dados, não markup/comando).
 */
export type I18nParams = Readonly<Record<string, string | number>>;

/** Um catálogo COMPLETO de um idioma (todas as chaves) — o pt-BR canônico. */
export type FullCatalog = Catalog;

/** Um catálogo PARCIAL (en pode faltar chaves ⇒ fallback p/ pt-BR no `t()`). */
export type PartialCatalog = Partial<Catalog>;
