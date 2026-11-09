// Metadados de APRESENTAÇÃO dos comandos nativos (menu `/`, palette, `/help`).
//
// Revisão de UX dos menus: descrição em voz única (infinitivo PT-BR, sem jargão), seção
// nova, palavras-chave PT-BR para a busca, comandos raros (fora da lista padrão, mas
// buscáveis) e comandos que só valem em certo modo. Fica num arquivo próprio — DADO puro —
// para o registro (`commands.ts`) continuar sendo só roteamento/efeito. `commands.ts`
// aplica este mapa por cima do registro (`applyMeta`), então nome/efeito/subcomandos
// seguem onde sempre estiveram e só o que o dono LÊ mora aqui.
//
// Identificadores (nome, args, valores) seguem em inglês; só o texto de UI é PT-BR.

import type { NativeCommandId, SlashSection } from './commands.js';

/** Quando o comando faz sentido (fora disso o menu não o lista; digitado, segue funcionando). */
export type CommandAvailability = 'concierge' | 'not-concierge' | 'subagent-focus';

export interface CommandMeta {
  /** Seção do menu. */
  readonly section: SlashSection;
  /** Descrição curta (≤ ~55 colunas), infinitivo, sem jargão nem sintaxe. */
  readonly summary: string;
  /**
   * Palavras-chave PT-BR (e sinônimos) para a busca: `tema`, `sair`, `parar`, `senha`…
   * O nome em inglês e a descrição já casam por si; aqui entra o que o dono DIGITARIA.
   */
  readonly keywords: readonly string[];
  /** Raro: fora da lista padrão do `/`; aparece (e funciona) ao buscar. */
  readonly rare?: true;
  /** Só vale em certo modo; ausente ⇒ sempre. */
  readonly availability?: CommandAvailability;
}

export const COMMAND_META: Readonly<Record<NativeCommandId, CommandMeta>> = {
  // ── conversa ──────────────────────────────────────────────────────────────────
  help: {
    section: 'conversa',
    summary: 'ver comandos e atalhos',
    keywords: ['ajuda', 'comandos', 'atalhos', 'teclas', 'como usar'],
  },
  ask: {
    section: 'conversa',
    summary: 'fazer uma pergunta sem interromper o trabalho',
    keywords: ['pergunta', 'perguntar', 'dúvida', 'paralela'],
    availability: 'not-concierge',
  },
  task: {
    section: 'conversa',
    summary: 'ver e parar tarefas em segundo plano',
    keywords: [
      'tarefa',
      'tarefas',
      'parar',
      'segundo plano',
      'background',
      'cancelar',
      'concierge',
    ],
    availability: 'concierge',
  },
  approve: {
    section: 'conversa',
    summary: 'aprovar o pedido pendente (/a)',
    keywords: ['aprovar', 'permitir', 'autorizar', 'liberar', 'sim', 'pedido', 'permissão'],
    availability: 'concierge',
  },
  deny: {
    section: 'conversa',
    summary: 'negar o pedido pendente (/n)',
    keywords: ['negar', 'recusar', 'bloquear', 'não', 'pedido', 'permissão'],
    availability: 'concierge',
  },
  conversation: {
    section: 'conversa',
    summary: 'escolher o modo de conversa',
    keywords: ['conversa', 'modo', 'concierge', 'clássico', 'classic'],
  },
  classic: {
    section: 'conversa',
    summary: 'voltar ao modo clássico (um laço só, como antes)',
    keywords: ['clássico', 'classico', 'tradicional', 'antigo', 'normal', 'classic'],
    availability: 'concierge',
  },
  concierge: {
    section: 'conversa',
    summary: 'usar o concierge (a conversa nunca espera o trabalho)',
    keywords: ['concierge', 'tarefas', 'paralelo', 'paralelas', 'segundo plano'],
    availability: 'not-concierge',
  },
  history: {
    section: 'conversa',
    summary: 'retomar uma sessão anterior',
    keywords: ['histórico', 'sessões', 'retomar', 'continuar', 'anterior', 'resume'],
  },
  rename: {
    section: 'conversa',
    summary: 'dar nome e cor à sessão',
    keywords: ['renomear', 'nome', 'cor da sessão', 'etiqueta', 'rótulo'],
  },
  clear: {
    section: 'conversa',
    summary: 'limpar a conversa (mantém a memória)',
    keywords: ['limpar', 'apagar', 'zerar', 'nova conversa', 'reset', 'esquecer'],
  },
  compact: {
    section: 'conversa',
    summary: 'resumir a conversa para liberar contexto',
    keywords: ['compactar', 'resumir', 'contexto', 'liberar', 'encurtar'],
  },
  export: {
    section: 'conversa',
    summary: 'exportar a conversa (sem segredos) para um arquivo',
    keywords: ['exportar', 'salvar', 'arquivo', 'transcrição', 'baixar', 'transcript'],
  },
  quit: {
    section: 'conversa',
    summary: 'sair do aluy',
    keywords: ['sair', 'fechar', 'encerrar', 'exit', 'terminar'],
  },

  // ── interface ─────────────────────────────────────────────────────────────────
  theme: {
    section: 'interface',
    summary: 'trocar o tema de cores',
    keywords: ['tema', 'cor', 'cores', 'escuro', 'claro', 'dark', 'light', 'aparência'],
  },
  lang: {
    section: 'interface',
    summary: 'trocar o idioma',
    keywords: ['idioma', 'língua', 'português', 'inglês', 'language'],
  },
  fullscreen: {
    section: 'interface',
    summary: 'alternar tela cheia (cockpit) (/cockpit)',
    keywords: ['tela cheia', 'cockpit', 'maximizar', 'expandir'],
  },
  split: {
    section: 'interface',
    summary: 'mostrar ou ocultar o painel de log (/view)',
    keywords: ['dividir', 'painel', 'log', 'lateral', 'registro'],
  },
  statusline: {
    section: 'interface',
    summary: 'escolher o rodapé (completo, compacto, oculto)',
    keywords: ['rodapé', 'barra', 'status', 'completo', 'compacto', 'oculto', 'footer'],
  },
  suggest: {
    section: 'interface',
    summary: 'ligar ou desligar a sugestão do próximo prompt',
    keywords: ['sugestão', 'sugerir', 'próximo', 'prompt', 'automática', 'tab'],
  },
  notify: {
    section: 'interface',
    summary: 'escolher quando o aluy avisa',
    keywords: ['notificação', 'notificações', 'avisar', 'aviso', 'som', 'sino', 'alerta'],
  },

  // ── modelo ────────────────────────────────────────────────────────────────────
  model: {
    section: 'modelo',
    summary: 'trocar o modelo',
    keywords: ['modelo', 'tier', 'llm', 'trocar'],
  },
  provider: {
    section: 'modelo',
    summary: 'trocar o provedor (OpenRouter, Ollama…)',
    keywords: ['provedor', 'openrouter', 'ollama', 'api', 'local', 'servidor'],
  },
  effort: {
    section: 'modelo',
    summary: 'ajustar o esforço de raciocínio',
    keywords: ['esforço', 'raciocínio', 'reasoning', 'pensar', 'pensamento', 'low', 'high'],
  },
  window: {
    section: 'modelo',
    summary: 'definir a janela de contexto do modelo (ex.: 128k)',
    keywords: ['janela', 'contexto', 'tokens', 'limite', 'tamanho'],
    rare: true,
  },
  usage: {
    section: 'modelo',
    summary: 'ver tokens e janela de contexto da sessão',
    keywords: ['uso', 'tokens', 'gasto', 'custo', 'cota', 'quota', 'consumo', 'quanto'],
  },

  // ── trabalho ──────────────────────────────────────────────────────────────────
  undo: {
    section: 'trabalho',
    summary: 'desfazer a última edição de arquivo do agente',
    keywords: ['desfazer', 'reverter', 'edição', 'arquivo'],
  },
  redo: {
    section: 'trabalho',
    summary: 'refazer a edição desfeita',
    keywords: ['refazer', 'repetir edição'],
    rare: true,
  },
  rewind: {
    section: 'trabalho',
    summary: 'voltar a um ponto anterior da sessão',
    keywords: ['voltar', 'rebobinar', 'checkpoint', 'ponto', 'restaurar'],
  },
  cycle: {
    section: 'trabalho',
    summary: 'repetir uma tarefa a cada intervalo, com limites',
    keywords: ['ciclo', 'repetir', 'loop', 'intervalo', 'periódico', 'rodar de novo'],
  },
  cron: {
    section: 'trabalho',
    summary: 'agendar tarefas recorrentes',
    keywords: ['agendar', 'agenda', 'recorrente', 'horário', 'rotina', 'tarefa agendada'],
  },
  permissions: {
    section: 'trabalho',
    summary: 'ver e ajustar as permissões do agente',
    keywords: ['permissões', 'segurança', 'modo', 'plan', 'yolo', 'acesso', 'catraca'],
  },
  'add-dir': {
    section: 'trabalho',
    summary: 'liberar mais uma pasta para o agente nesta sessão',
    keywords: ['pasta', 'diretório', 'adicionar', 'liberar', 'acesso', 'workspace'],
  },
  init: {
    section: 'trabalho',
    summary: 'criar o ALUY.md do projeto',
    keywords: ['iniciar', 'criar', 'projeto', 'instruções', 'aluy.md'],
  },
  secret: {
    section: 'trabalho',
    summary: 'passar um segredo ao agente sem digitar no chat',
    keywords: ['segredo', 'senha', 'chave', 'token', 'credencial', 'api key', 'variável'],
  },
  todo: {
    section: 'trabalho',
    summary: 'ver e concluir os pedidos anotados (lista de afazeres)',
    keywords: ['afazeres', 'lista', 'anotações', 'pendências', 'backlog', 'anotado'],
  },

  // ── extensões ─────────────────────────────────────────────────────────────────
  memory: {
    section: 'extensões',
    summary: 'ver e editar a memória do agente',
    keywords: ['memória', 'lembrar', 'esquecer', 'fatos', 'fixar', 'lembranças'],
  },
  mcp: {
    section: 'extensões',
    summary: 'gerenciar servidores MCP',
    keywords: ['servidor', 'servidores', 'integração', 'conectar', 'ferramentas externas'],
  },
  plugin: {
    section: 'extensões',
    summary: 'gerenciar plugins',
    keywords: ['plugins', 'extensão', 'extensões', 'ligar', 'desligar', 'bundle'],
  },
  workflows: {
    section: 'extensões',
    summary: 'executar fluxos de trabalho salvos',
    keywords: ['fluxos', 'fluxo', 'automação', 'workflow', 'executar'],
  },
  subagent: {
    section: 'extensões',
    summary: 'conversar 1:1 com um sub-agente',
    keywords: ['sub-agente', 'subagente', 'agente', 'perfil', 'conversar'],
  },
  inventory: {
    section: 'extensões',
    summary: 'ver tudo que foi carregado de .aluy/',
    keywords: ['inventário', 'carregado', 'tudo', 'agentes', 'skills', 'comandos'],
  },
  tools: {
    section: 'extensões',
    summary: 'listar as ferramentas disponíveis',
    keywords: ['ferramentas', 'tools', 'inventário', 'o que o agente faz'],
  },
  agents: {
    section: 'extensões',
    summary: 'listar os agentes (.md) disponíveis',
    keywords: ['agentes', 'perfis', 'subagentes'],
    rare: true,
  },
  skills: {
    section: 'extensões',
    summary: 'listar as skills disponíveis',
    keywords: ['habilidades', 'skill', 'skills'],
    rare: true,
  },
  service: {
    section: 'extensões',
    summary: 'gerenciar serviços em segundo plano',
    keywords: ['serviço', 'serviços', 'daemon', 'segundo plano', 'iniciar', 'logs'],
    rare: true,
  },
  rooms: {
    section: 'extensões',
    summary: 'salas de conversa entre agentes',
    keywords: ['salas', 'sala', 'frota', 'agentes', 'observar'],
    rare: true,
  },
  back: {
    section: 'extensões',
    summary: 'voltar ao agente principal',
    keywords: ['voltar', 'principal', 'sair do foco', 'sub-agente'],
    rare: true,
    availability: 'subagent-focus',
  },

  // ── conta ─────────────────────────────────────────────────────────────────────
  login: {
    section: 'conta',
    summary: 'entrar na conta Aluy',
    keywords: ['entrar', 'conectar', 'autenticar', 'conta'],
  },
  logout: {
    section: 'conta',
    summary: 'sair da conta e apagar a credencial local',
    keywords: ['sair', 'desconectar', 'credencial', 'conta'],
  },
  whoami: {
    section: 'conta',
    summary: 'ver conta, organização e permissões',
    keywords: ['eu', 'quem', 'conta', 'usuário', 'organização', 'escopos'],
  },
  doctor: {
    section: 'conta',
    summary: 'diagnosticar a instalação',
    keywords: ['diagnóstico', 'problema', 'erro', 'saúde', 'verificar', 'checar', 'instalação'],
  },
  upgrade: {
    section: 'conta',
    summary: 'atualizar o aluy para a versão mais nova',
    keywords: ['atualizar', 'versão', 'atualização', 'update'],
    rare: true,
  },
  telegram: {
    section: 'conta',
    summary: 'conectar o Telegram (status, liberar, bloquear)',
    keywords: ['bot', 'mensagem', 'chat', 'conector', 'liberar', 'bloquear'],
    rare: true,
  },
};

/** Ordem das seções no menu (a lista é agrupada por seção contígua). */
export const SECTION_ORDER: readonly SlashSection[] = [
  'conversa',
  'interface',
  'modelo',
  'trabalho',
  'extensões',
  'conta',
  'usuário',
];

/** Contexto de modo p/ decidir quais comandos o menu lista. */
export interface MenuContext {
  /** Conversa em modo concierge? */
  readonly concierge: boolean;
  /** Há um sub-agente em foco 1:1 (`/subagent`)? */
  readonly subagentFocused: boolean;
}

/** O comando vale no contexto dado? (`false` ⇒ o menu não o lista.) */
export function availableIn(
  meta: { readonly availability?: CommandAvailability | undefined } | undefined,
  ctx: MenuContext,
): boolean {
  switch (meta?.availability) {
    case 'concierge':
      return ctx.concierge;
    case 'not-concierge':
      return !ctx.concierge;
    case 'subagent-focus':
      return ctx.subagentFocused;
    default:
      return true;
  }
}

/** Tira acento e caixa: `Sessão` e `sessao` se igualam na busca. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
