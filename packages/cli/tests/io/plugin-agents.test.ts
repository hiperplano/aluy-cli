// Os AGENTES que vêm de plugin — e por que eles NÃO herdam a confiança do dono.
//
// O `AgentRegistry` tem duas camadas: `global` (`~/.aluy/agents/` — config do dono,
// confiável, entra na AUTO-SELEÇÃO) e `project` (DADO, não-confiável). Plugin é código de
// terceiro que o dono escolheu instalar: a camada é `project`, e o PREFIXO é o que torna a
// proveniência visível.
//
// Sem o prefixo, um `revisor` de plugin fica indistinguível de um `revisor.md` escrito pelo
// dono — e é essa confusão que faria código de fora herdar a confiança dele.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginStore } from '../../src/io/plugin-store.js';
import { carregarAgentesDePlugins } from '../../src/io/plugin-agents.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-pa-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Cria um plugin com um agente `.md` dentro. */
function comAgente(plugin: string, agente: string, corpo = 'Você revisa código.'): void {
  const dir = join(base, 'plugins', plugin, 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(base, 'plugins', plugin, 'aluy-plugin.json'),
    JSON.stringify({ name: plugin }),
  );
  writeFileSync(
    join(dir, `${agente}.md`),
    `---\nname: ${agente}\ndescription: revisa\n---\n\n${corpo}\n`,
  );
}

function carrega(desligados: string[] = []) {
  const { plugins } = new PluginStore({ baseDir: base, desligados }).load();
  return carregarAgentesDePlugins(plugins);
}

describe('agentes de plugin', () => {
  it('carrega com o nome PREFIXADO pelo plugin', () => {
    comAgente('meu-plugin', 'revisor');
    expect(carrega().profiles.map((p) => p.name)).toEqual(['meu-plugin:revisor']);
  });

  it('o prefixo separa homônimos de plugins DIFERENTES', () => {
    // Dois plugins com um `revisor` cada: sem o prefixo, um sumiria por colisão de nome.
    comAgente('plugin-a', 'revisor');
    comAgente('plugin-b', 'revisor');
    expect(
      carrega()
        .profiles.map((p) => p.name)
        .sort(),
    ).toEqual(['plugin-a:revisor', 'plugin-b:revisor']);
  });

  it('plugin DESLIGADO não carrega — desligar não é "carregar e esconder"', () => {
    // Um agente escondido ainda ocuparia o nome e ainda apareceria como homônimo.
    comAgente('desligado', 'revisor');
    expect(carrega(['desligado']).profiles).toEqual([]);
  });

  it('plugin sem dir de agentes é pulado sem erro', () => {
    mkdirSync(join(base, 'plugins', 'vazio'), { recursive: true });
    writeFileSync(
      join(base, 'plugins', 'vazio', 'aluy-plugin.json'),
      JSON.stringify({ name: 'vazio' }),
    );
    const r = carrega();
    expect(r.profiles).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('`.md` malformado vira erro VISÍVEL nomeando o plugin', () => {
    // RES-MD-3: um perfil ilegível NÃO vira "agente sem restrição" — é rejeitado, e a carga
    // fica visível. O que faltava era dizer de QUAL plugin veio.
    const dir = join(base, 'plugins', 'ruim', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(base, 'plugins', 'ruim', 'aluy-plugin.json'),
      JSON.stringify({ name: 'ruim' }),
    );
    writeFileSync(join(dir, 'sem-nome.md'), '---\ndescription: sem name\n---\n\ncorpo\n');
    const r = carrega();
    expect(r.profiles).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toContain('[plugin ruim]');
  });

  it('sem plugin nenhum ⇒ vazio (zero mudança para quem não usa)', () => {
    expect(carrega().profiles).toEqual([]);
  });
});
