// O MANIFESTO de um plugin do Aluy — e a fronteira de confiança que ele cria.
//
// Pedido do dono (10/09/2026): "quero que você tenha a opção de plugins do aluy como no
// claude". O aluy já tem TODAS as peças que um plugin empacota — agents, commands, skills,
// workflows, hooks, MCP — cada uma no seu diretório. O que falta é o BUNDLE: uma pasta que
// carrega várias delas juntas e pode ser instalada de uma vez.
//
// ── O QUE ISTO MUDA NA SEGURANÇA, e é o ponto do desenho ────────────────────────────────
//
// Os loaders de hoje separam duas proveniências (ver `user-agents.ts`):
//
//   `~/.aluy/agents/*.md`   CONFIG DO DONO — confiável; `origin:'global'`; entra na
//                           auto-seleção (delegar por nome não pede confirmação).
//   `.claude/agents/*.md`   DADO do projeto — não-confiável; `origin:'project'`.
//
// Um plugin instalado de `github.com/alguem/repo` não é nenhum dos dois. Não foi o dono que
// escreveu (≠ global), mas ele escolheu instalar deliberadamente (≠ um arquivo que veio de
// carona num clone). E o conteúdo é EXECUTÁVEL em efeito: um agente `.md` declara `tools:` e
// instruções; um hook roda comando; um `mcp.json` aponta para um servidor arbitrário.
//
// Por isso plugin ganha proveniência PRÓPRIA (`'plugin'`), FECHADA por default: nunca entra
// na auto-seleção, sempre rotulada na tela com o plugin de origem. Instalar um plugin é uma
// decisão de cadeia de suprimentos, e o desenho tem de dizer isso em vez de diluir código de
// terceiro no meio da config do dono.
//
// O que NÃO muda: a catraca. Todo efeito derivado de um plugin segue passando por
// `decide()` — plugin não relaxa permissão, exatamente como um agente global não relaxa.
//
// PURO: texto → manifesto validado. Sem I/O, sem rede. Falha FECHADA — manifesto ilegível
// não vira "plugin sem restrição", vira erro visível.

/** Os tipos de extensão que um plugin pode trazer. Espelha os diretórios de `~/.aluy/`. */
export const TIPOS_DE_EXTENSAO = ['agents', 'commands', 'skills', 'workflows', 'hooks'] as const;

export type TipoDeExtensao = (typeof TIPOS_DE_EXTENSAO)[number];

/** O manifesto VÁLIDO de um plugin (`aluy-plugin.json` na raiz do bundle). */
export interface PluginManifest {
  /** Identificador — vira o prefixo dos itens na tela (`meu-plugin:revisor`). */
  readonly name: string;
  /** Versão livre (semver por convenção; não impomos, para não bloquear ninguém). */
  readonly version?: string;
  /** Uma linha sobre o que o plugin faz — o que o `/plugin list` mostra. */
  readonly description?: string;
}

/** Resultado da leitura: o manifesto, ou um erro ACIONÁVEL (nunca um plugin degradado). */
export type ParseManifesto = { readonly manifest: PluginManifest } | { readonly error: string };

/**
 * Nome aceitável de plugin.
 *
 * Estreito de propósito: o nome vira PREFIXO de identificadores na tela e componente de
 * CAMINHO no disco. Barra, ponto-ponto e espaço abrem travessia de diretório e ambiguidade
 * visual (`meu plugin:x` não se lê); acentos e maiúsculas abrem dois plugins que parecem o
 * mesmo. Um charset chato aqui evita todos de uma vez.
 */
const NOME_ACEITAVEL = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Teto dos textos livres — input de terceiro não pode esticar a UI. */
const MAX_DESCRICAO = 200;
const MAX_VERSAO = 40;

function texto(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Lê e VALIDA o conteúdo de um `aluy-plugin.json`. PURO.
 *
 * Fail-closed em toda borda: JSON inválido, nome fora do charset, campo com tipo errado —
 * tudo vira `error`, nunca um manifesto pela metade. O conteúdo vem de terceiro; degradar
 * silenciosamente aqui seria aceitar o que não se conseguiu ler.
 */
export function parseManifesto(bruto: string): ParseManifesto {
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch (e) {
    return { error: `aluy-plugin.json não é JSON válido: ${e instanceof Error ? e.message : ''}` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { error: 'aluy-plugin.json precisa ser um objeto JSON.' };
  }
  const o = obj as Record<string, unknown>;

  const nome = texto(o.name);
  if (nome === undefined) {
    return { error: 'aluy-plugin.json: falta "name" (o identificador do plugin).' };
  }
  if (!NOME_ACEITAVEL.test(nome)) {
    return {
      error:
        `aluy-plugin.json: "name" inválido ("${nome.slice(0, 40)}"). Use minúsculas, ` +
        'números e hífen — ele vira prefixo na tela e nome de pasta no disco.',
    };
  }

  const versao = texto(o.version);
  const descricao = texto(o.description);
  return {
    manifest: {
      name: nome,
      ...(versao !== undefined ? { version: versao.slice(0, MAX_VERSAO) } : {}),
      ...(descricao !== undefined ? { description: descricao.slice(0, MAX_DESCRICAO) } : {}),
    },
  };
}

/**
 * O RÓTULO de um item vindo de plugin (`meu-plugin:revisor`).
 *
 * O prefixo não é decoração: sem ele, um agente de plugin chamado `revisor` fica
 * indistinguível de um `~/.aluy/agents/revisor.md` escrito pelo dono — e é exatamente essa
 * confusão que faria código de terceiro herdar a confiança da config dele. Mesmo cuidado do
 * aviso de homônimo global/projeto que já existe.
 */
export function rotuloDeItem(plugin: string, item: string): string {
  return `${plugin}:${item}`;
}

/** A descrição de PROVENIÊNCIA para a tela — a terceira, ao lado de global e projeto. */
export function descricaoDeOrigem(plugin: string): string {
  return `plugin · ${plugin}`;
}
