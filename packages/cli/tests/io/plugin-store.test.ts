// O STORE de plugins e a fronteira de confiança que ele guarda.
//
// Pedido do dono (10/09/2026): "quero que você tenha a opção de plugins do aluy como no
// claude". O que estes casos travam não é a leitura de JSON — é o que acontece quando o
// bundle vem de terceiro e tenta se passar por outra coisa.
//
// NENHUM teste toca `~/.aluy` real: `baseDir` é injetado, sempre para um tmpdir.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginStore } from '../../src/io/plugin-store.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-plug-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Cria um bundle no disco. `manifesto` como string permite escrever JSON inválido. */
function bundle(nome: string, manifesto?: string, extensoes: string[] = []): string {
  const raiz = join(base, 'plugins', nome);
  mkdirSync(raiz, { recursive: true });
  if (manifesto !== undefined) writeFileSync(join(raiz, 'aluy-plugin.json'), manifesto);
  for (const e of extensoes) mkdirSync(join(raiz, e), { recursive: true });
  return raiz;
}

const ok = (nome: string, extra = '') => `{"name":"${nome}"${extra}}`;

describe('PluginStore — o caminho feliz', () => {
  it('lê um bundle válido e diz quais extensões ele traz', () => {
    bundle('meu-plugin', ok('meu-plugin', ',"version":"1.0","description":"faz x"'), [
      'agents',
      'commands',
    ]);
    const { plugins, erros } = new PluginStore({ baseDir: base }).load();
    expect(erros).toEqual([]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest).toMatchObject({ name: 'meu-plugin', version: '1.0' });
    expect(Object.keys(plugins[0]!.extensoes).sort()).toEqual(['agents', 'commands']);
    expect(plugins[0]?.ativo).toBe(true);
  });

  it('só reporta as extensões que EXISTEM — não inventa diretório', () => {
    bundle('so-agentes', ok('so-agentes'), ['agents']);
    const { plugins } = new PluginStore({ baseDir: base }).load();
    expect(Object.keys(plugins[0]!.extensoes)).toEqual(['agents']);
  });

  it('ordem alfabética — a carga é determinística', () => {
    bundle('zeta', ok('zeta'));
    bundle('alfa', ok('alfa'));
    const { plugins } = new PluginStore({ baseDir: base }).load();
    expect(plugins.map((p) => p.manifest.name)).toEqual(['alfa', 'zeta']);
  });

  it('dir ausente ⇒ vazio, nunca lança (QoL não derruba o boot)', () => {
    const { plugins, erros } = new PluginStore({ baseDir: join(base, 'inexistente') }).load();
    expect(plugins).toEqual([]);
    expect(erros).toEqual([]);
  });
});

describe('falha FECHADA — bundle de terceiro não carrega "no melhor esforço"', () => {
  it('sem manifesto ⇒ erro VISÍVEL, não plugin mudo', () => {
    bundle('sem-manifesto', undefined, ['agents']);
    const { plugins, erros } = new PluginStore({ baseDir: base }).load();
    expect(plugins).toEqual([]);
    expect(erros[0]?.motivo).toContain('aluy-plugin.json');
  });

  it('JSON inválido ⇒ erro, não plugin vazio', () => {
    bundle('quebrado', '{ não é json');
    const { erros } = new PluginStore({ baseDir: base }).load();
    expect(erros).toHaveLength(1);
  });

  it('o "name" do manifesto TEM de bater com a pasta', () => {
    // Sem isto, um bundle na pasta `inofensivo/` se declararia `name:"backend-eng"` e
    // rotularia os itens como se fossem de OUTRO plugin — e o rótulo é justamente o que
    // carrega a proveniência na tela.
    bundle('inofensivo', ok('backend-eng'));
    const { plugins, erros } = new PluginStore({ baseDir: base }).load();
    expect(plugins).toEqual([]);
    expect(erros[0]?.motivo).toContain('não bate com a pasta');
  });

  it('um bundle ruim não derruba os bons', () => {
    bundle('bom', ok('bom'));
    bundle('ruim', '{{{');
    const { plugins, erros } = new PluginStore({ baseDir: base }).load();
    expect(plugins.map((p) => p.manifest.name)).toEqual(['bom']);
    expect(erros).toHaveLength(1);
  });
});

describe('desligar significa NÃO CARREGAR', () => {
  it('plugin desligado vem com `ativo:false`', () => {
    bundle('desligado', ok('desligado'), ['agents']);
    bundle('ligado', ok('ligado'), ['agents']);
    const { plugins } = new PluginStore({ baseDir: base, desligados: ['desligado'] }).load();
    const porNome = Object.fromEntries(plugins.map((p) => [p.manifest.name, p.ativo]));
    expect(porNome).toEqual({ desligado: false, ligado: true });
  });
});
