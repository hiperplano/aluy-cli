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
  'composer.shellHint': '› behind the gate · Enter runs · the gate asks on effect',
  'composer.moreLines': 'lines',

  // ── FooterHints ───────────────────────────────────────────────────────────
  'hints.idle': 'enter sends · / commands · ctrl-p palette · ↑ history · ctrl-c×2 quit',
  'hints.thinking': 'esc interrupt · ctrl-c×2 quit',
  'hints.streaming': 'esc interrupt · ctrl-c×2 quit',
  'hints.ask': 'a approve · s always · n deny · e edit · esc cancel',
  'hints.askDestructive': 'n deny (recommended) · a approve anyway · esc cancel',
  'hints.slash': '↑↓ navigate · enter run · esc close',
  'hints.palette': 'type to search · ↑↓ navigate · enter run · esc close',
  'hints.budget': 'c continue · n end',
  'hints.error': 'r retry · esc cancel',
  'hints.workSubagents': 'esc stops the parent · F8 stops all · ctrl-t view/stop · ctrl-c×2 quit',
  'hints.idleSubagents': 'enter sends · F8 stops the sub-agents · ctrl-t view/stop · ctrl-c×2 quit',
  'hints.ctrlcAgain': 'press ctrl-c again to quit',
  'hints.cockpit':
    'tab focuses · pgup/pgdn scroll · ctrl-s export · /fullscreen exits · ctrl-c×2 quit',

  // ── Cockpit (ADR-0076) ────────────────────────────────────────────────────
  'cockpit.conversa': 'conversation',
  'cockpit.log': 'log',
  'cockpit.welcomeTitle': 'Λluy — cockpit',
  'cockpit.welcomeHint': 'type a goal below to get started · /help · /fullscreen exits',
  'cockpit.entered':
    'cockpit mode (full screen) — tab switches chat⇄log · pgup/pgdn scroll · ctrl-s export · /fullscreen exits',
  'cockpit.left': 'inline mode restored (native scrollback).',
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
  'statusbar.window': 'window',
  'statusbar.session': 'session',
  'statusbar.quota': 'quota',
  'statusbar.cycle': 'cycle',
  'statusbar.subcycles': 'subcycles',

  // ── Boot / splash ─────────────────────────────────────────────────────────
  'boot.broker': 'broker',
  'boot.tagline': 'Aluy Cli · terminal agent',
  'boot.connecting': 'connecting',
  'boot.entering': 'signing in',

  // ── Pickers ───────────────────────────────────────────────────────────────
  'picker.theme.help': 'change theme · ↑↓ navigate · enter switch · esc close',
  'picker.lang.help': 'change language · ↑↓ navigate · enter switch · esc close',
  'picker.provider.help': 'set the Custom model provider · ↑↓ navigate · enter set · esc close',
  'picker.provider.default': 'default',
  'picker.provider.fallback': '⚠ could not list the registered ones — showing the known providers',
  'picker.provider.more': '… {count} more providers (↑↓ scroll)',

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
  'cmd.help': 'show this list',
  'cmd.login': 'sign in',
  'cmd.logout': 'sign out',
  'cmd.whoami': 'current account, org and scopes',
  'cmd.telegram': 'Telegram connector · status/allow/deny/logout (in-session setup)',
  'cmd.model': 'switch the tier',
  'cmd.provider': 'set the Custom model provider',
  'cmd.effort': 'set the reasoning_effort (low/medium/high/custom) · passthrough ≤32 chars',
  'cmd.theme': 'switch the theme (dark/light) · auto-detected on boot',
  'cmd.lang': 'switch the language (pt-BR/en) · auto-detected on boot',
  'cmd.usage': 'tokens and window for this session',
  'cmd.rename': 'name + color-tag the session · ●name in the composer',
  'cmd.history': 'browse and RESUME a previous session · without leaving aluy',
  'cmd.notify': 'toggle the attention bell (on/off)',
  'cmd.undo': "undo the agent's last file edit",
  'cmd.redo': 'redo the last undone edit',
  'cmd.rewind': 'rewind the session to a point (code and/or conversation) · Esc Esc',
  'cmd.clear': "clear the session (context) · full also WIPES the agent's memory",
  'cmd.compact': 'compact the context (summarize the conversation and continue)',
  'cmd.cycle': 'run a task in cycles · with hard caps and a stop (anti-runaway)',
  'cmd.permissions': 'panel · mode, grants and safe tools (always-ask locked)',
  'cmd.addDir': 'authorize an EXTRA directory for the agent (session) · no args lists',
  'cmd.init': 'create an ALUY.md in this project',
  'cmd.memory': "view/edit/forget/pin the agent's memory (global + project)",
  'cmd.mcp': 'list/manage MCP servers (add/remove/disable/enable · search <term>)',
  'cmd.doctor': 'diagnose the install · credential, broker, MCP, config (read-only)',
  'cmd.fullscreen': 'cockpit mode (full screen, alt-screen)',
  'cmd.export': 'export this session REDACTED transcript to ~/.aluy/exports/ (0600)',
  'cmd.quit': 'quit aluy',
  'cmd.workflows': 'list mapped .md workflows (global + project · valid + rejected)',
  'cmd.todo': 'list the backlog (the agent notes items; done <id> / clear)',
};
