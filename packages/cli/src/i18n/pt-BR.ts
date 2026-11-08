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
  'composer.shellHint': '› roda direto, sem pedir · o agente vê a saída · !! só local',
  'composer.moreLines': 'linhas',

  // ── FooterHints (§4.3) ────────────────────────────────────────────────────
  // F-DICAS (relato do dono: "o status envia deveria ser melhor") — a linha tinha
  // CINCO itens competindo, e três deles se aprendem no primeiro uso (`ctrl-c` p/ sair,
  // `ctrl-p` que o `/` já abre). Sobra o que o dono ainda não sabe de cor. O símbolo `⏎`
  // no lugar da palavra "enter" é o padrão de teclado — lê-se sem traduzir.
  'hints.idle': '{enter} enviar · \\⏎ nova linha · / comandos · {up} histórico',
  'hints.thinking': 'esc interromper · ctrl-b soltar · ctrl-c×2 sair',
  'hints.streaming': 'esc interromper · ctrl-b soltar · ctrl-c×2 sair',
  'hints.ask': 'a aprova · s sempre · n nega · e edita · esc cancela',
  'hints.askDestructive': 'n nega (recomendado) · a aprova mesmo assim · esc cancela',
  'hints.slash': '↑↓ navega · enter executa · esc fecha',
  'hints.palette': 'digite p/ buscar · ↑↓ navega · enter executa · esc fecha',
  'hints.budget': 'c continua · n encerra',
  'hints.error': 'r tentar · esc cancela',
  'hints.conciergeWork': 'fale à vontade · esc só limpa o rascunho · F8 para tudo · /task',
  'hints.conciergeTasks': 'enter envia · F8 para tudo · ctrl-t painel de tarefas · /task',
  'hints.conciergeAsk': '/a aprova · /n nega · segue conversando · F8 para tudo',
  'hints.workSubagents': 'esc para o pai · ctrl-b soltar · F8 para tudo · /help',
  'hints.quotaPause': 'esc cancela o turno · ctrl-c×2 sair',
  'hints.detachInline': 'ctrl-b solta',
  'hints.idleSubagents': 'enter envia · F8 para os sub-agentes · /help',
  'hints.ctrlcAgain': 'pressione ctrl-c de novo para sair',
  'hints.cockpit': 'tab foca · pgup/pgdn rola · ctrl-s exporta · /fullscreen sai · ctrl-c×2 sair',
  // F197 — sugestão de próximo prompt: Tab aceita o ghost no composer.
  'hints.suggest': 'tab aceita a sugestão',

  // ── Linha de trabalho ─────────────────────────────────────────────────────
  // Verbos de espera (sorteados 1× por passo; `ALUY_SPINNER_VERBS=plain` os desliga). Só
  // substituem os rótulos GENÉRICOS (pensando/lembrando/preparando/maestro avaliando).
  'working.verbs':
    'Matutando|Fuçando|Garimpando|Destrinchando|Lapidando|Costurando|Tricotando|Desenrolando|Caçando bugs|Fermentando|Ruminando|Bolando|Arquitetando|Tecendo|Engatilhando|Desembaraçando|Afinando|Peneirando|Cozinhando|Apurando|Alinhavando|Esmiuçando|Destilando|Mapeando|Rabiscando|Rascunhando|Burilando|Calibrando|Cavucando|Escavando|Fiando|Moldando|Encaixando|Depurando|Rastreando|Farejando|Vasculhando|Cultivando|Semeando|Podando|Montando|Soldando|Polindo|Alinhando|Empilhando|Desatando|Tramando|Cogitando|Imaginando|Traçando|Revirando|Desbravando|Navegando|Pescando|Temperando|Amadurecendo|Combinando|Orquestrando|Desmontando|Remontando|Garimpando bits|Ponderando|Planejando|Tateando|Cruzando dados|Decifrando',

  // ── F197 — frases de sugestão (viram o texto do composer ao aceitar) ──────────────────
  'suggest.runTests': 'rode os testes e me mostre o resultado',
  'suggest.fixFailing': 'investigue e corrija os testes que falharam',
  'suggest.summarize': 'resuma o que mudou neste turno',
  'suggest.retryDifferent': 'tente outra abordagem para resolver isso',
  'suggest.implement': 'implemente a mudança que discutimos',
  'suggest.explain': 'explique o que você fez e por quê',
  'suggest.nextStep': 'o que devo revisar ou fazer a seguir?',
  // F199 — variantes com o FATO do turno (ver catalog.ts). Estilo denso, sem ponto final
  // (mesmo registro das genéricas acima).
  'suggest.summarizeNamed': 'revise as mudanças em {files}',
  'suggest.fixFailingNamed': 'investigue por que "{test}" falhou',
  'suggest.runTestsNamed': 'rode "{command}" de novo',
  'suggest.retryDifferentNamed': 'tente outra abordagem — o erro foi "{error}"',

  // ── Cockpit (ADR-0076) ────────────────────────────────────────────────────
  'cockpit.conversa': 'conversa',
  'cockpit.log': 'log',
  'cockpit.welcomeTitle': 'Λluy — cockpit',
  'cockpit.welcomeHint': 'digite um objetivo abaixo para começar · /help · /fullscreen sai',
  'cockpit.entered': 'tab alterna conversa⇄log · pgup/pgdn rola · ctrl-s exporta · /fullscreen sai',
  'cockpit.left': 'modo inline restaurado (scrollback nativo).',
  'cockpit.renderFault':
    'falha ao desenhar a tela cheia; voltei para o modo inline (detalhes em ~/.aluy/logs/crash.log).',
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
  // F-PAINEL — rótulos da coluna esquerda do painel de status. Curtos de propósito:
  // é o ALINHAMENTO deles que cria a coluna, e um rótulo longo comeria a área do valor.
  'boot.instructions': 'instruções',
  'painel.config': 'config',
  'painel.credito': 'crédito',
  'painel.sessao': 'sessão',
  'painel.estado': 'estado',
  'painel.uso': 'uso',
  'statusbar.window': 'janela',
  'statusbar.session': 'sessão',
  'statusbar.quota': 'quota',
  'statusbar.cycle': 'ciclo',
  'statusbar.subcycles': 'subciclos',
  'statusbar.mcpFailed': 'falhou',
  // F-SIDECAR-USO — rótulo do chip de uso dos sidecars (turbo). A forma narrow encurta
  // p/ caber em <60 col sem embaralhar a barra, como o `banner.yolo.narrow` faz.
  'statusbar.sidecars': 'sidecars',
  'statusbar.sidecars.narrow': 'sc',
  // FATIA 2 (CICLOS/SUBCICLOS) — cabeçalho cíclico na árvore de fluxos (<FlowTreeView>).
  'flowtree.cycle': 'ciclo',
  'flowtree.subcycles': 'subciclos',
  'flowtree.turn': 'turno',

  // ── Boot / splash ─────────────────────────────────────────────────────────
  'boot.broker': 'broker',
  // F-ASCII-DE-VERDADE — o `Λ` NÃO pode ficar cravado no catálogo: em perfil ASCII
  // (TERM=linux / locale não-UTF-8 / `--ascii`) ele vira caixa vazia, que é justamente
  // o que esse perfil existe para evitar. Texto de UI passa pelo catálogo; a MARCA passa
  // pelo tema — `{brand}` é o que liga um ao outro (mesmo padrão do `{enter}`/`{up}`).
  'boot.tagline': '{brand} · agente de terminal',
  'boot.connecting': 'conectando',
  'boot.entering': 'entrando',

  // ── Pickers ───────────────────────────────────────────────────────────────
  'picker.theme.help': 'trocar tema · ↑↓ navega · enter troca · esc fecha',
  'picker.lang.help': 'trocar idioma · ↑↓ navega · enter troca · esc fecha',
  'picker.provider.help': 'setar o provider do modelo Custom · ↑↓ navega · enter seta · esc fecha',
  'picker.provider.default': 'padrão',
  'picker.provider.fallback': '⚠ não foi possível listar os cadastrados — mostrando os conhecidos',
  'picker.provider.more': '… {count} providers a mais (↑↓ rola)',
  // Defeito 2 (relato do dono, "tokenrouter aparece na lista de instalação mas não em
  // /provider"): não havia dessincronia — o nome era só o EXEMPLO deste campo livre,
  // mas por ser marca REAL (e o site ter um card apontando pra tokenrouter.com) lia
  // como opção suportada. Trocado por um placeholder obviamente genérico.
  'picker.provider.addCustom.id': 'id do provider (ex.: meu-provider) — enter avança',
  'picker.provider.addCustom.baseUrl':
    'base URL (OpenAI-compatível, ex.: https://api.exemplo.com/v1) — enter avança',
  'picker.provider.addCustom.model':
    'modelo default (enter vazio usa o id do provider) — enter confirma',
  'picker.provider.addCustom.help':
    'esc cancela · a credencial NÃO entra aqui — depois use `aluy login --provider <id>`',
  // F-PROV-CRED (relato do dono: "mudei o provider no picker e ele não pediu nada") —
  // campo de chave entre escolher o provider e aplicar. NUNCA ecoado (mascarado com •).
  'picker.provider.credential.label': 'API key de {provider} (oculta) — enter grava e aplica',
  'picker.provider.credential.help': 'esc volta pra lista · a chave NUNCA aparece em claro na tela',
  'picker.provider.credential.retryTitle': '✗ a chave não passou no teste de conexão — cole outra',

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
  'picker.effort.standaloneHelp': 'esforço de raciocínio · ↑↓ navega · enter aplica · esc fecha',

  // ── LocalModelPicker (/model sob backend LOCAL/BYO) ───────────────────────
  'picker.localModel.help':
    'trocar modelo do provider local · digite p/ filtrar · ↑↓ navega · enter seleciona · esc fecha',
  'picker.localModel.empty': 'nenhum modelo conhecido casa "{query}" — enter usa o texto digitado',
  'picker.localModel.more': '… {count} modelos a mais (refine o filtro)',
  'picker.localModel.loading': '⋯ buscando mais modelos no provider…',
  'picker.localModel.fallback':
    '⚠ não foi possível listar os modelos do provider — mostrando só o catálogo conhecido',
  'picker.localModel.customHint': '· digite um slug que não está na lista p/ testá-lo (custom)',

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
  'cmd.help': 'ver comandos e atalhos',
  'cmd.login': 'entrar na conta Aluy',
  'cmd.logout': 'sair da conta e apagar a credencial local',
  'cmd.whoami': 'ver conta, organização e permissões',
  'cmd.telegram': 'conectar o Telegram (status, liberar, bloquear)',
  'cmd.model': 'trocar o modelo',
  'cmd.provider': 'trocar o provedor (OpenRouter, Ollama…)',
  'cmd.effort': 'ajustar o esforço de raciocínio',
  'cmd.theme': 'trocar o tema de cores',
  'cmd.lang': 'trocar o idioma',
  'cmd.usage': 'ver tokens e janela de contexto da sessão',
  'cmd.rename': 'dar nome e cor à sessão',
  'cmd.history': 'retomar uma sessão anterior',
  'cmd.notify': 'escolher quando o aluy avisa',
  'cmd.undo': 'desfazer a última edição de arquivo do agente',
  'cmd.redo': 'refazer a edição desfeita',
  'cmd.rewind': 'voltar a um ponto anterior da sessão',
  'cmd.clear': 'limpar a conversa (mantém a memória)',
  'cmd.compact': 'resumir a conversa para liberar contexto',
  'cmd.cycle': 'repetir uma tarefa a cada intervalo, com limites',
  'cmd.permissions': 'ver e ajustar as permissões do agente',
  'cmd.addDir': 'liberar mais uma pasta para o agente nesta sessão',
  'cmd.init': 'criar o ALUY.md do projeto',
  'cmd.memory': 'ver e editar a memória do agente',
  'cmd.mcp': 'gerenciar servidores MCP',
  'cmd.doctor': 'diagnosticar a instalação',
  'cmd.fullscreen': 'alternar tela cheia (cockpit) (/cockpit)',
  'cmd.export': 'exportar a conversa (sem segredos) para um arquivo',
  'cmd.quit': 'sair do aluy',
  'cmd.workflows': 'executar fluxos de trabalho salvos',
  'cmd.service': 'gerenciar serviços em segundo plano',
  'cmd.tools': 'listar as ferramentas disponíveis',
  'cmd.todo': 'ver e concluir os pedidos anotados (lista de afazeres)',
};
