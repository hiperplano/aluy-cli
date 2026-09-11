// Os AGENTES que vêm de plugins instalados.
//
// Pedido do dono (10/09/2026): "quero que você tenha a opção de plugins do aluy como no
// claude". Este é o primeiro tipo de extensão a entrar de fato — é o que o `spawn_agent`
// consome, então é onde um plugin rende mais.
//
// ── POR QUE A CAMADA É `project`, e não uma terceira ─────────────────────────────────────
//
// O `AgentRegistry` tem DUAS camadas por desenho: `global` (config do dono — confiável,
// entra na AUTO-SELEÇÃO, delegar por nome não pede confirmação) e `project` (DADO — não
// confiável). Plugin é código de TERCEIRO que o dono escolheu instalar.
//
// A propriedade que importa é "não entra na auto-seleção", e a camada `project` já a
// garante. Inventar uma terceira camada no registro só para dizer "plugin" mudaria o
// vocabulário de `agent-registry.ts`, `agents-list.ts` e do aviso de homônimo — três
// arquivos, para obter a MESMA garantia que já existe. A proveniência fica visível pelo
// PREFIXO do nome (`meu-plugin:revisor`), que é o que o dono lê na tela.
//
// O prefixo não é decoração: sem ele um `revisor` de plugin fica indistinguível de um
// `~/.aluy/agents/revisor.md` escrito pelo dono, e é essa confusão que faria código de
// terceiro herdar a confiança da config dele.
//
// Reusa o `UserAgentsLoader` apontado para o dir do plugin — mesmo parser, mesmo
// confinamento, mesmos tetos, mesma falha-fechada (RES-MD-3). Nenhum caminho de leitura
// novo: um caminho novo seria uma segunda chance de errar o confinamento.

import { rotuloDeItem, type AgentProfile, type AgentProfileError } from '@hiperplano/aluy-cli-core';
import { UserAgentsLoader } from './user-agents.js';
import type { PluginInstalado } from './plugin-store.js';

export interface CargaDeAgentesDePlugin {
  readonly profiles: readonly AgentProfile[];
  readonly errors: readonly AgentProfileError[];
}

/**
 * Carrega os agentes de TODOS os plugins ATIVOS, com o nome prefixado pelo plugin.
 *
 * Plugin desligado (`/plugin disable`) é PULADO — desligar tem de significar "não carrega",
 * não "carrega e esconde": um agente escondido ainda ocuparia o nome e ainda apareceria
 * como homônimo.
 *
 * Determinístico (ordem dos plugins, que o store já entrega alfabética).
 */
export function carregarAgentesDePlugins(
  plugins: readonly PluginInstalado[],
): CargaDeAgentesDePlugin {
  const profiles: AgentProfile[] = [];
  const errors: AgentProfileError[] = [];

  for (const p of plugins) {
    if (!p.ativo) continue;
    const dir = p.extensoes.agents;
    if (dir === undefined) continue;

    // O loader espera `<base>/agents`, então passamos a RAIZ do plugin como base — o
    // caminho que ele monta é exatamente `p.extensoes.agents`.
    const carga = new UserAgentsLoader({ baseDir: p.raiz }).load();
    for (const perfil of carga.profiles) {
      profiles.push({
        ...perfil,
        name: rotuloDeItem(p.manifest.name, perfil.name),
        // `origin` REESCRITO — e este é o ponto mais importante do arquivo.
        //
        // Reusar o `UserAgentsLoader` traz de brinde o carimbo dele: `origin:'global'`, que
        // significa CONFIG DO DONO — confiável, entra na auto-seleção. Passar o perfil no
        // array de projeto NÃO basta: o `AgentRegistry` re-filtra PELO CAMPO
        // (`if (p.origin !== 'project') continue`), justamente para que a camada não dependa
        // de quem chamou.
        //
        // Sem esta linha acontecia o pior dos dois mundos, e eu medi na tela: o agente
        // aparecia na listagem como `escopo: global` (mentira — código de terceiro com a
        // etiqueta de confiança do dono) e NÃO era registrado (a defesa do construtor o
        // descartava). Listagem mentindo e funcionalidade ausente, ao mesmo tempo.
        origin: 'project' as const,
      });
    }
    // O erro guarda o nome do ARQUIVO, não do agente — prefixá-lo daria um caminho que não
    // existe. O que falta ali é dizer de QUAL plugin veio, e isso vai no texto.
    for (const erro of carga.errors) {
      errors.push({ ...erro, reason: `[plugin ${p.manifest.name}] ${erro.reason}` });
    }
  }
  return { profiles, errors };
}
