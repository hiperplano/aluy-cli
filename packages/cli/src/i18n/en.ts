// EST-0989 · i18n — catálogo en (PARCIAL: `Partial<Catalog>`).
//
// English interface, natural sentence case. É PARCIAL por design: qualquer chave
// ausente aqui cai no pt-BR (catálogo canônico) pelo `t()` — nunca mostra a chave
// crua. Na Fase 1 cobrimos as telas migradas (composer/hints/statusbar/boot/pickers/
// lang + summaries dos comandos); a Fase 2 (FU) completa o resto. Os atalhos de
// teclado (`enter`, `esc`, `ctrl-c`, `↑↓`) NÃO se traduzem — são teclas físicas;
// só o VERBO ao redor vira inglês.
//
// Voz: inglês natural, sentence case, sem emoji novo; glifos/tokens do DS inalterados
// (vêm do tema, não do idioma).

import type { PartialCatalog } from './catalog.js';

export const en: PartialCatalog = {
  // ── Composer ──────────────────────────────────────────────────────────────
  'composer.placeholder': 'type a goal or /command…',
  'composer.shellHint': '› runs directly, no prompt · agent sees the output · !! local only',
  'composer.moreLines': 'lines',

  // ── FooterHints ───────────────────────────────────────────────────────────
  'hints.idle': '{enter} send · \\⏎ new line · / commands · {up} history',
  'hints.thinking': 'esc interrupt · ctrl-b detach · ctrl-c×2 quit',
  'hints.streaming': 'esc interrupt · ctrl-b detach · ctrl-c×2 quit',
  'hints.ask': 'a approve · s always · n deny · e edit · esc cancel',
  'hints.askDestructive': 'n deny (recommended) · a approve anyway · esc cancel',
  'hints.slash': '↑↓ navigate · enter run · esc close',
  'hints.palette': 'type to search · ↑↓ navigate · enter run · esc close',
  'hints.budget': 'c continue · n end',
  'hints.error': 'r retry · esc cancel',
  'hints.conciergeWork': 'keep talking · esc only clears the draft · F8 stops all · /task',
  'hints.conciergeTasks': 'enter sends · F8 stops all · ctrl-t task panel · /task',
  'hints.conciergeAsk': '/a approves · /n denies · keep chatting · F8 stops all',
  'hints.workSubagents': 'esc stops the parent · ctrl-b detach · F8 stops all · /help',
  'hints.quotaPause': 'esc cancels the turn · ctrl-c×2 quit',
  'hints.detachInline': 'ctrl-b detach',
  'hints.idleSubagents': 'enter sends · F8 stops the sub-agents · /help',
  'hints.ctrlcAgain': 'press ctrl-c again to quit',
  'hints.cockpit':
    'tab focuses · pgup/pgdn scroll · ctrl-s export · /fullscreen exits · ctrl-c×2 quit',
  // F197 — next-prompt suggestion: Tab accepts the ghost into the composer.
  'hints.suggest': 'tab accepts the suggestion',

  // ── F197 — suggestion phrases (become the composer text when accepted) ─────────────────
  'suggest.runTests': 'run the tests and show me the result',
  'suggest.fixFailing': 'investigate and fix the failing tests',
  'suggest.summarize': 'summarize what changed in this turn',
  'suggest.retryDifferent': 'try a different approach to solve this',
  'suggest.implement': 'implement the change we discussed',
  'suggest.explain': 'explain what you did and why',
  'suggest.nextStep': 'what should I review or do next?',
  // F199 — variants carrying the turn's FACT (see catalog.ts).
  'suggest.summarizeNamed': 'review the changes in {files}',
  'suggest.fixFailingNamed': 'investigate why "{test}" failed',
  'suggest.runTestsNamed': 'run "{command}" again',
  'suggest.retryDifferentNamed': 'try a different approach — the error was "{error}"',

  // ── Cockpit (ADR-0076) ────────────────────────────────────────────────────
  'cockpit.conversa': 'conversation',
  'cockpit.log': 'log',
  'cockpit.welcomeTitle': 'Λluy — cockpit',
  'cockpit.welcomeHint': 'type a goal below to get started · /help · /fullscreen exits',
  'cockpit.entered': 'tab switches chat⇄log · pgup/pgdn scroll · ctrl-s export · /fullscreen exits',
  'cockpit.left': 'inline mode restored (native scrollback).',
  'cockpit.renderFault':
    'full-screen render failed; back to inline mode (details in ~/.aluy/logs/crash.log).',
  'cockpit.refuseNarrow': 'narrow terminal (<80 col): cockpit unavailable, using inline.',
  'cockpit.refuseShort': 'short terminal (too few rows): cockpit unavailable, using inline.',
  'cockpit.exported': 'transcript exported (redacted) to',

  // ── ModeIndicator / UnsafeBanner ──────────────────────────────────────────
  'mode.label': 'mode',
  'mode.plan.caption': 'read-only — view only, no effects',
  'mode.normal.caption': 'default gate (approval on effect)',
  'mode.unsafe.caption': 'approval OFF',
  'banner.yolo': 'YOLO MODE — approval OFF, the agent runs ANY command without asking',
  'banner.yolo.narrow': 'YOLO MODE — approval OFF',

  // ── StatusBar ─────────────────────────────────────────────────────────────
  'statusbar.brokerError': 'broker error',
  // F-PAINEL — rótulos da coluna esquerda do painel de status. Curtos de propósito:
  // é o ALINHAMENTO deles que cria a coluna, e um rótulo longo comeria a área do valor.
  'boot.instructions': 'instructions',
  'painel.config': 'config',
  'painel.credito': 'credit',
  'painel.sessao': 'session',
  'painel.estado': 'state',
  'painel.uso': 'usage',
  'statusbar.window': 'window',
  'statusbar.session': 'session',
  'statusbar.quota': 'quota',
  'statusbar.cycle': 'cycle',
  'statusbar.subcycles': 'subcycles',
  'statusbar.mcpFailed': 'failed',
  // F-SIDECAR-USO — "sidecars" é termo de PRODUTO (igual nos dois idiomas); só a forma
  // narrow existe p/ caber na barra estreita. Mantém a paridade 1:1 com o pt-BR.
  'statusbar.sidecars': 'sidecars',
  'statusbar.sidecars.narrow': 'sc',

  // ── Boot / splash ─────────────────────────────────────────────────────────
  'boot.broker': 'broker',
  // F-ASCII-DE-VERDADE — ver a nota em pt-BR.ts: `{brand}` é resolvido pelo tema.
  'boot.tagline': '{brand} · terminal agent',
  'boot.connecting': 'connecting',
  'boot.entering': 'signing in',

  // ── Pickers ───────────────────────────────────────────────────────────────
  'picker.theme.help': 'change theme · ↑↓ navigate · enter switch · esc close',
  'picker.lang.help': 'change language · ↑↓ navigate · enter switch · esc close',
  'picker.provider.help': 'set the Custom model provider · ↑↓ navigate · enter set · esc close',
  'picker.provider.default': 'default',
  'picker.provider.fallback': '⚠ could not list the registered ones — showing the known providers',
  'picker.provider.more': '… {count} more providers (↑↓ scroll)',
  // Defeito 2 — see pt-BR.ts: "tokenrouter" was only a placeholder here, but being a
  // real product name (echoed by a partner card on the site) read as a supported
  // option. Swapped for an obviously generic placeholder.
  'picker.provider.addCustom.id': 'provider id (e.g. my-provider) — enter advances',
  'picker.provider.addCustom.baseUrl':
    'base URL (OpenAI-compatible, e.g. https://api.example.com/v1) — enter advances',
  'picker.provider.addCustom.model':
    'default model (empty enter uses the provider id) — enter confirms',
  'picker.provider.addCustom.help':
    'esc cancels · the credential does NOT go here — afterwards use `aluy login --provider <id>`',
  // F-PROV-CRED — key field between picking the provider and applying it. NEVER echoed
  // (masked with •). See pt-BR.ts for the owner-reported motivation.
  'picker.provider.credential.label': '{provider} API key (hidden) — enter saves and applies',
  'picker.provider.credential.help': 'esc goes back to the list · the key is NEVER shown in clear',
  'picker.provider.credential.retryTitle':
    '✗ the key failed the connection test — paste another one',

  // ── ModelPicker (/model) ──────────────────────────────────────────────────
  'picker.model.help': 'change model · ↑↓ navigate · enter select · esc close',
  'picker.model.loading': 'loading tiers from the broker…',
  'picker.model.customLine': 'browse/filter the models',
  'picker.model.fallback': 'broker catalog unavailable — showing the known tiers',
  'picker.model.browseHelp':
    'Custom models · type to filter · ↑↓ navigate · ^T tools-only · enter select · esc back',
  'picker.model.browseCount': '{filtered} of {total}',
  'picker.model.toolsOnlySuffix': ' · tools only',
  'picker.model.moreAbove': '↑ more above',
  'picker.model.moreBelow': '↓ more below',
  'picker.model.noFilterMatch':
    'no model matches the filter — enter uses the typed text (free slug)',
  'picker.model.noTools':
    "⚠ this model doesn't support tools — the agent falls back to the text parser / may not use MCP/tools well",
  'picker.model.freeHelp': 'Custom model · type/paste the slug · enter confirm · esc cancel',
  'picker.model.outOfCatalog':
    '⚠ outside the curated catalog — cost/quality may vary (enter uses it anyway)',

  // ── EFFORT step of the conjugated /model (EST-1117) ───────────────────────
  'picker.effort.help': 'reasoning effort · ↑↓ navigate · enter apply · esc back',
  'picker.effort.keep': 'keep (do not change the current effort)',
  'picker.effort.low': 'low',
  'picker.effort.medium': 'medium',
  'picker.effort.high': 'high',
  'picker.effort.custom': 'custom (type a value)',
  'picker.effort.customHelp': 'custom effort · type the value · enter confirm · esc back',
  'picker.effort.warnEmpty': '⚠ type a value (cannot be empty)',
  'picker.effort.warnTooLong': '⚠ at most 32 characters',
  'picker.effort.standaloneHelp': 'reasoning effort · ↑↓ navigate · enter apply · esc close',

  // ── LocalModelPicker (/model under LOCAL/BYO backend) ─────────────────────
  'picker.localModel.help':
    'change the local provider model · type to filter · ↑↓ navigate · enter select · esc close',
  'picker.localModel.empty': 'no known model matches "{query}" — enter uses the typed text',
  'picker.localModel.more': '… {count} more models (refine the filter)',
  'picker.localModel.loading': '⋯ fetching more models from the provider…',
  'picker.localModel.fallback':
    '⚠ could not list the provider models — showing only the known catalog',
  'picker.localModel.customHint': "· type a slug that isn't in the list to test it (custom)",

  // ── HistoryPicker (/history) ──────────────────────────────────────────────
  'picker.history.help': 'resume session · ↑↓ navigate · enter resume · esc cancel',
  'picker.history.empty': 'no previous session',
  'picker.history.more': '… {count} more sessions (↑↓ scroll)',

  // ── RewindPicker (/rewind · Esc Esc) ──────────────────────────────────────
  'picker.rewind.help': 'rewind to a point · ↑↓ navigate · enter choose · esc cancel',
  'picker.rewind.empty': 'no restore point in this session',
  'picker.rewind.more': '… {count} more points (↑↓ scroll)',
  'picker.rewind.action.help': 'restore what? · ↑↓ navigate · enter confirm · esc back',
  'picker.rewind.action.both': 'code + conversation',
  'picker.rewind.action.conversation': 'conversation only',
  'picker.rewind.action.code': 'code only',
  'picker.rewind.barrier.warn': 'command(s) ran after this point — shell effects are NOT undone',

  // ── FilePicker (@ attach) ─────────────────────────────────────────────────
  'picker.file.help': '@ to attach a file · ↑↓ navigate · enter attach · esc close',
  'picker.file.empty': 'no file matches "{query}"',
  'picker.file.more': '… {count} more files (refine the filter)',

  // ── CommandPalette (ctrl-p) ───────────────────────────────────────────────
  'picker.palette.help': '⌘ commands · ↑↓ navigate · enter run · esc close',
  'picker.palette.search': 'search command…',
  'picker.palette.empty': 'no command matches "{query}"',
  'picker.palette.more': '… {count} more commands (refine the search)',

  // ── /lang ─────────────────────────────────────────────────────────────────
  'lang.changed': 'language changed to {label}',
  'lang.unknown': 'unknown language: {input}',
  'lang.current': 'current language: {label}',
  'lang.listTitle': 'available languages',

  // ── Slash-commands (summary) ──────────────────────────────────────────────
  'cmd.help': 'see commands and shortcuts',
  'cmd.login': 'sign in to your Aluy account',
  'cmd.logout': 'sign out and delete the local credential',
  'cmd.whoami': 'see account, organization and permissions',
  'cmd.telegram': 'connect Telegram (status, allow, block)',
  'cmd.model': 'switch the model',
  'cmd.provider': 'switch the provider (OpenRouter, Ollama…)',
  'cmd.effort': 'adjust the reasoning effort',
  'cmd.theme': 'switch the color theme',
  'cmd.lang': 'switch the language',
  'cmd.usage': 'see session tokens and context window',
  'cmd.rename': 'give the session a name and color',
  'cmd.history': 'resume a previous session',
  'cmd.notify': 'choose when aluy notifies you',
  'cmd.undo': "undo the agent's last file edit",
  'cmd.redo': 'redo the undone edit',
  'cmd.rewind': 'go back to an earlier point in the session',
  'cmd.clear': 'clear the conversation (keeps memory)',
  'cmd.compact': 'summarize the conversation to free context',
  'cmd.cycle': 'repeat a task on an interval, with limits',
  'cmd.permissions': "see and adjust the agent's permissions",
  'cmd.addDir': 'allow the agent one more folder in this session',
  'cmd.init': "create the project's ALUY.md",
  'cmd.memory': "see and edit the agent's memory",
  'cmd.mcp': 'manage MCP servers',
  'cmd.doctor': 'diagnose the installation',
  'cmd.fullscreen': 'toggle full screen (cockpit) (/cockpit)',
  'cmd.export': 'export the conversation (no secrets) to a file',
  'cmd.quit': 'quit aluy',
  'cmd.workflows': 'run saved workflows',
  'cmd.service': 'manage background services',
  'cmd.todo': 'see and complete noted requests (to-do list)',
  'cmd.tools': 'list the available tools',

  // ── FlowTree (rótulos do log de atividade) — fechavam a "Fase 2 (FU)" declarada no
  //    topo deste arquivo: eram as ÚNICAS chaves do contrato ainda sem par em inglês, e
  //    caíam no pt-BR pelo fallback do `t()` (o usuário `--lang en` lia "ciclo"/"turno").
  'flowtree.cycle': 'cycle',
  'flowtree.subcycles': 'subcycles',
  'flowtree.turn': 'turn',
};
