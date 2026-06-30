// EST-0989 · i18n — catálogo pt-BR (DEFAULT, CANÔNICO e COMPLETO).
//
// Este é o catálogo de referência: define TODAS as chaves do `Catalog` (o TS exige
// cobertura total — `FullCatalog`). Os textos são os MESMOS que estavam hardcoded
// nas telas (migração 1:1, sem mudar a voz). Sentence case pt-BR, sem emoji novo;
// os glifos/tokens do DS NÃO entram aqui (são do tema, não do idioma).
//
// `en.ts` é PARCIAL: uma chave faltando lá cai AQUI pelo `t()` (fallback). Por isso
// este arquivo nunca pode ter buraco — é o piso de todo idioma.

import type { FullCatalog } from './catalog.js';

export const ptBR: FullCatalog = {
  // ── Composer ──────────────────────────────────────────────────────────────
  'composer.placeholder': 'digite um objetivo ou /comando…',
  'composer.shellHint': '› atrás da catraca · Enter roda · catraca pergunta no efeito',
  'composer.moreLines': 'linhas',

  // ── FooterHints (§4.3) ────────────────────────────────────────────────────
  'hints.idle': 'enter envia · / comandos · ctrl-p paleta · ↑ histórico · ctrl-c×2 sair',
  'hints.thinking': 'esc interromper · ctrl-c×2 sair',
  'hints.streaming': 'esc interromper · ctrl-c×2 sair',
  'hints.ask': 'a aprova · s sempre · n nega · e edita · esc cancela',
  'hints.askDestructive': 'n nega (recomendado) · a aprova mesmo assim · esc cancela',
  'hints.slash': '↑↓ navega · enter executa · esc fecha',
  'hints.palette': 'digite p/ buscar · ↑↓ navega · enter executa · esc fecha',
  'hints.budget': 'c continua · n encerra',
  'hints.error': 'r tentar · esc cancela',
  'hints.workSubagents': 'esc para o pai · F8 para tudo · ctrl-t ver/parar · ctrl-c×2 sair',
  'hints.idleSubagents': 'enter envia · F8 para os sub-agentes · ctrl-t ver/parar · ctrl-c×2 sair',
  'hints.ctrlcAgain': 'pressione ctrl-c de novo para sair',
  'hints.cockpit': 'tab foca · pgup/pgdn rola · ctrl-s exporta · /fullscreen sai · ctrl-c×2 sair',

  // ── Cockpit (ADR-0076) ────────────────────────────────────────────────────
  'cockpit.conversa': 'conversa',
  'cockpit.log': 'log',
  'cockpit.welcomeTitle': 'Λluy — cockpit',
  'cockpit.welcomeHint': 'digite um objetivo abaixo para começar · /help · /fullscreen sai',
  'cockpit.entered':
    'modo cockpit (tela cheia) — tab alterna conversa⇄log · pgup/pgdn rola · ctrl-s exporta · /fullscreen sai',
  'cockpit.left': 'modo inline restaurado (scrollback nativo).',
  'cockpit.refuseNarrow': 'terminal estreito (<80 col): cockpit indisponível, usando inline.',
  'cockpit.refuseShort': 'terminal baixo (poucas linhas): cockpit indisponível, usando inline.',
  'cockpit.exported': 'transcript exportado (redigido) para',

  // ── ModeIndicator / UnsafeBanner ──────────────────────────────────────────
  'mode.label': 'modo',
  'mode.plan.caption': 'read-only — só leitura, nenhum efeito',
  'mode.normal.caption': 'catraca padrão (aprovação por efeito)',
  'mode.unsafe.caption': 'aprovação DESLIGADA',
  'banner.yolo': 'MODO YOLO — aprovação DESLIGADA, o agente roda QUALQUER comando sem perguntar',
  'banner.yolo.narrow': 'MODO YOLO — aprovação DESLIGADA',

  // ── StatusBar ─────────────────────────────────────────────────────────────
  'statusbar.brokerError': 'erro de broker',
  'statusbar.window': 'janela',
  'statusbar.session': 'sessão',
  'statusbar.quota': 'quota',

  // ── Boot / splash ─────────────────────────────────────────────────────────
  'boot.broker': 'broker',
  'boot.tagline': 'Aluy Cli · agente de terminal',
  'boot.connecting': 'conectando',
  'boot.entering': 'entrando',

  // ── Pickers ───────────────────────────────────────────────────────────────
  'picker.theme.help': 'trocar tema · ↑↓ navega · enter troca · esc fecha',
  'picker.lang.help': 'trocar idioma · ↑↓ navega · enter troca · esc fecha',
  'picker.provider.help': 'setar o provider do modelo Custom · ↑↓ navega · enter seta · esc fecha',
  'picker.provider.default': 'padrão',
  'picker.provider.fallback': '⚠ não foi possível listar os cadastrados — mostrando os conhecidos',
  'picker.provider.more': '… {count} providers a mais (↑↓ rola)',

  // ── ModelPicker (/model) ──────────────────────────────────────────────────
  'picker.model.help': 'trocar modelo · ↑↓ navega · enter seleciona · esc fecha',
  'picker.model.loading': 'carregando tiers do broker…',
  'picker.model.customLine': 'navegar/filtrar os modelos',
  'picker.model.fallback': 'catálogo do broker indisponível — mostrando os tiers conhecidos',
  'picker.model.browseHelp':
    'modelos Custom · digite p/ filtrar · ↑↓ navega · ^T só-tools · enter seleciona · esc volta',
  'picker.model.browseCount': '{filtered} de {total}',
  'picker.model.toolsOnlySuffix': ' · só com tools',
  'picker.model.moreAbove': '↑ mais acima',
  'picker.model.moreBelow': '↓ mais abaixo',
  'picker.model.noFilterMatch':
    'nenhum modelo casa o filtro — enter usa o texto digitado (slug livre)',
  'picker.model.noTools':
    '⚠ este modelo não suporta ferramentas — o agente cai no parser de texto / pode não usar MCP/tools bem',
  'picker.model.freeHelp': 'modelo Custom · digite/cole o slug · enter confirma · esc cancela',
  'picker.model.outOfCatalog':
    '⚠ fora do catálogo curado — pode ter custo/qualidade variável (enter usa assim mesmo)',

  // ── Passo de EFFORT do /model conjugado (EST-1117) ────────────────────────
  'picker.effort.help': 'esforço de raciocínio · ↑↓ navega · enter aplica · esc volta',
  'picker.effort.keep': 'manter (não mudar o esforço atual)',
  'picker.effort.low': 'low (baixo)',
  'picker.effort.medium': 'medium (médio)',
  'picker.effort.high': 'high (alto)',
  'picker.effort.custom': 'custom (digitar um valor)',
  'picker.effort.customHelp': 'esforço custom · digite o valor · enter confirma · esc volta',
  'picker.effort.warnEmpty': '⚠ digite um valor (não pode ser vazio)',
  'picker.effort.warnTooLong': '⚠ no máximo 32 caracteres',

  // ── HistoryPicker (/history) ──────────────────────────────────────────────
  'picker.history.help': 'retomar sessão · ↑↓ navega · enter retoma · esc cancela',
  'picker.history.empty': 'nenhuma sessão anterior',
  'picker.history.more': '… {count} sessões a mais (↑↓ rola)',

  // ── RewindPicker (/rewind · Esc Esc) ──────────────────────────────────────
  'picker.rewind.help': 'voltar a um ponto · ↑↓ navega · enter escolhe · esc cancela',
  'picker.rewind.empty': 'nenhum ponto de restauração nesta sessão',
  'picker.rewind.more': '… {count} pontos a mais (↑↓ rola)',
  'picker.rewind.action.help': 'o que restaurar? · ↑↓ navega · enter confirma · esc volta',
  'picker.rewind.action.both': 'código + conversa',
  'picker.rewind.action.conversation': 'só a conversa',
  'picker.rewind.action.code': 'só o código',
  'picker.rewind.barrier.warn':
    'comando(s) rodaram depois deste ponto — o efeito de shell NÃO é desfeito',

  // ── FilePicker (@ anexar) ─────────────────────────────────────────────────
  'picker.file.help': '@ para anexar arquivo · ↑↓ navega · enter anexa · esc fecha',
  'picker.file.empty': 'nenhum arquivo casa "{query}"',
  'picker.file.more': '… {count} arquivos a mais (refine o filtro)',

  // ── CommandPalette (ctrl-p) ───────────────────────────────────────────────
  'picker.palette.help': '⌘ comandos · ↑↓ navega · enter executa · esc fecha',
  'picker.palette.search': 'buscar comando…',
  'picker.palette.empty': 'nenhum comando casa "{query}"',
  'picker.palette.more': '… {count} comandos a mais (refine a busca)',

  // ── /lang ─────────────────────────────────────────────────────────────────
  'lang.changed': 'idioma trocado para {label}',
  'lang.unknown': 'idioma desconhecido: {input}',
  'lang.current': 'idioma atual: {label}',
  'lang.listTitle': 'idiomas disponíveis',

  // ── Slash-commands (summary) ──────────────────────────────────────────────
  'cmd.help': 'mostra esta lista',
  'cmd.login': 'entrar na conta',
  'cmd.logout': 'sair da conta',
  'cmd.whoami': 'conta, org e escopos atuais',
  'cmd.telegram': 'conector Telegram · status/allow/deny/logout (setup na sessão)',
  'cmd.model': 'trocar o tier',
  'cmd.provider': 'seta o provider do modelo Custom',
  'cmd.effort': 'seta o reasoning_effort (low/medium/high/custom) · passthrough ≤32 chars',
  'cmd.theme': 'trocar o tema (dark/light) · auto-detecta no boot',
  'cmd.lang': 'trocar o idioma (pt-BR/en) · auto-detecta no boot',
  'cmd.usage': 'tokens e janela desta sessão',
  'cmd.rename': 'dá um nome + cor de identificação à sessão · ●nome no composer',
  'cmd.history': 'navega e RETOMA uma sessão anterior · sem sair do aluy',
  'cmd.notify': 'liga/desliga o sino de atenção (on/off)',
  'cmd.undo': 'desfaz a última edição de arquivo do agente',
  'cmd.redo': 'refaz a última edição desfeita',
  'cmd.rewind': 'volta a um ponto da sessão (código e/ou conversa) · Esc Esc',
  'cmd.clear': 'limpa a sessão (contexto) · full também APAGA a memória do agente',
  'cmd.compact': 'compacta o contexto (resume a conversa e continua)',
  'cmd.cycle': 'roda uma tarefa em ciclos · com tetos duros e parada (anti-runaway)',
  'cmd.permissions': 'painel · modo, grants e tools seguras (sempre-ask travado)',
  'cmd.addDir': 'autoriza um diretório EXTRA p/ o agente (sessão) · sem args lista',
  'cmd.init': 'cria um ALUY.md neste projeto',
  'cmd.memory': 'vê/edita/esquece/fixa a memória do agente (global + projeto)',
  'cmd.mcp': 'lista/gerencia servers MCP (add/remove/disable/enable · search <termo>)',
  'cmd.doctor': 'diagnóstico da instalação · credencial, broker, MCP, config (read-only)',
  'cmd.fullscreen': 'modo cockpit (tela cheia, alt-screen)',
  'cmd.quit': 'sair do aluy',
  'cmd.workflows': 'fluxos de atividades que coordenam o agente — lista, executa e ativa',
  'cmd.tools': 'inventário unificado das ferramentas · nativas, MCP, permissão (read-only)',
  'cmd.todo': 'vê/gerencia o backlog de tarefas anotadas (done/clear)',
};
