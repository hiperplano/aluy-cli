// EST-0961 · command palette — registro ÚNICO + filtro fuzzy (puro, sem Ink).
//
// O coração do DoD: a palette e o slash-menu leem a MESMA fonte de comandos
// (NATIVE_COMMANDS + comandos do usuário). Aqui provamos isso sem montar a TUI:
// um comando novo no registro aparece nos DOIS, e o fuzzy filtra/ordena.

import { describe, expect, it } from 'vitest';
import {
  paletteItems,
  filterPalette,
  filterCommands,
  entryPath,
  NATIVE_COMMANDS,
  PALETTE_ACTIONS,
  type SlashCommand,
} from '../../src/slash/commands.js';

const USER: readonly SlashCommand[] = [
  { name: 'deploy', summary: 'sobe pra staging', source: 'user' },
];

describe('paletteItems — fonte ÚNICA (mesma do slash-menu) + ações', () => {
  it('inclui TODOS os comandos nativos como itens da palette', () => {
    const items = paletteItems();
    for (const cmd of NATIVE_COMMANDS) {
      expect(items.some((it) => it.label === `/${cmd.name}`)).toBe(true);
    }
  });

  it('inclui as ações puras (não-slash), ex.: "trocar modo"', () => {
    const items = paletteItems();
    expect(items.some((it) => it.action.kind === 'action' && it.label === 'trocar modo')).toBe(
      true,
    );
    expect(items.length).toBe(NATIVE_COMMANDS.length + PALETTE_ACTIONS.length);
  });

  it('inclui os comandos do USUÁRIO (mesmo dado de ~/.aluy/commands/)', () => {
    const items = paletteItems(USER);
    const deploy = items.find((it) => it.label === '/deploy');
    expect(deploy).toBeDefined();
    expect(deploy?.action.kind).toBe('command');
  });

  it('um comando novo no registro aparece NO slash-menu E NA palette (mesma fonte)', () => {
    // Adicionar um comando do usuário é a forma testável de "novo comando no
    // registro" sem mutar o módulo: ambos os caminhos o enxergam.
    const novel: SlashCommand = { name: 'snapshot', summary: 'tira um snapshot', source: 'user' };
    const inSlash = filterCommands('snapshot', [novel]).some((e) => entryPath(e) === 'snapshot');
    const inPalette = filterPalette('snapshot', [novel]).some((h) => h.label === '/snapshot');
    expect(inSlash).toBe(true);
    expect(inPalette).toBe(true);
  });
});

describe('filterPalette — fuzzy sobre label + descrição', () => {
  it('query vazia ⇒ todos, sem highlight', () => {
    const hits = filterPalette('');
    expect(hits.length).toBe(NATIVE_COMMANDS.length + PALETTE_ACTIONS.length);
    expect(hits.every((h) => h.matched.length === 0)).toBe(true);
  });

  it('fuzzy de subsequência: "thm" casa "/theme"', () => {
    const hits = filterPalette('thm');
    expect(hits.some((h) => h.label === '/theme')).toBe(true);
    // o melhor match (label) carrega índices de realce.
    const theme = hits.find((h) => h.label === '/theme');
    expect(theme?.matched.length).toBeGreaterThan(0);
  });

  it('casa também pela DESCRIÇÃO (recall): "limpa" acha /clear', () => {
    // /clear tem summary "limpa a conversa…" — casa por descrição mesmo sem casar
    // o label "clear".
    const hits = filterPalette('limpa');
    expect(hits.some((h) => h.label === '/clear')).toBe(true);
  });

  it('match exato no LABEL ranqueia acima de só-descrição', () => {
    // "model" casa o label /model (exato) e nada melhor; deve vir no topo.
    const hits = filterPalette('model');
    expect(hits[0]?.label).toBe('/model');
  });

  it('não casa nada ⇒ lista vazia', () => {
    expect(filterPalette('zzzqqq')).toHaveLength(0);
  });

  it('a ação "trocar modo" é alcançável por fuzzy ("modo")', () => {
    const hits = filterPalette('modo');
    expect(hits.some((h) => h.action.kind === 'action' && h.label === 'trocar modo')).toBe(true);
  });

  it('os índices matched são relativos ao LABEL (p/ realçar no lugar certo)', () => {
    const hits = filterPalette('clear');
    const clear = hits.find((h) => h.label === '/clear');
    expect(clear).toBeDefined();
    // "/clear": os caracteres c-l-e-a-r estão nos índices 1..5.
    expect(clear!.matched.every((i) => i >= 0 && i < clear!.label.length)).toBe(true);
  });
});
