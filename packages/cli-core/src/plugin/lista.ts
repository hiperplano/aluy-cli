// O TEXTO do `/plugin list` — o que o dono lê para saber o que está instalado.
//
// PURO: dados → linhas. A leitura de disco fica no `PluginStore` (locus concreto).
//
// O que esta nota precisa dizer, e por quê:
//
//   • QUE PLUGINS existem, e se estão ligados. Um plugin desligado que não aparecesse na
//     lista viraria um mistério ("instalei e sumiu").
//   • QUE EXTENSÕES cada um traz. É o que responde "por que este plugin não fez nada?" —
//     um bundle sem `agents/` não vai registrar agente nenhum, e isso não é defeito.
//   • QUAIS FALHARAM, e o motivo. Bundle ilegível é carga VISÍVEL: silenciar aqui repetiria
//     o defeito que este produto já teve em toda outra carga (agentes, MCP, skills).

import type { PluginManifest } from './manifest.js';

/** A fatia de um plugin que a listagem precisa. Estreita — não depende do I/O. */
export interface PluginParaListar {
  readonly manifest: PluginManifest;
  readonly extensoes: readonly string[];
  readonly ativo: boolean;
}

export interface FalhaParaListar {
  readonly dir: string;
  readonly motivo: string;
}

/**
 * As linhas da nota do `/plugin list`. PURO.
 *
 * Sem plugin nenhum, diz ONDE instalar em vez de só "nenhum": a pergunta seguinte de quem lê
 * "nenhum plugin" é sempre "e como eu ponho um?".
 */
export function linhasDaListaDePlugins(
  plugins: readonly PluginParaListar[],
  falhas: readonly FalhaParaListar[] = [],
  dir = '~/.aluy/plugins',
): readonly string[] {
  const linhas: string[] = [];

  if (plugins.length === 0 && falhas.length === 0) {
    linhas.push('nenhum plugin instalado.');
    linhas.push(`instale com \`/plugin install <caminho>\` — eles vivem em ${dir}/`);
    return linhas;
  }

  for (const p of plugins) {
    const partes: string[] = [p.manifest.name];
    if (p.manifest.version !== undefined) partes.push(`v${p.manifest.version}`);
    if (!p.ativo) partes.push('· DESLIGADO');
    linhas.push(partes.join(' '));
    if (p.manifest.description !== undefined) linhas.push(`   ${p.manifest.description}`);
    // Sem extensões o plugin é inerte — dizer isso evita o "instalei e não fez nada".
    linhas.push(
      p.extensoes.length > 0
        ? `   traz: ${[...p.extensoes].sort().join(', ')}`
        : '   ⚠ não traz nenhuma extensão reconhecida (agents/commands/skills/workflows/hooks)',
    );
  }

  for (const f of falhas) {
    linhas.push(`⚠ ${f.dir}: ${f.motivo}`);
  }
  return linhas;
}
