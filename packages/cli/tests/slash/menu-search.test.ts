// Menu `/` — busca por nome, alias, palavra-chave PT-BR e descrição; lista padrão sem raros
// nem comandos de outro modo; descrições sem jargão (revisão de UX dos menus, §6).

import { describe, expect, it } from 'vitest';
import {
  NATIVE_COMMANDS,
  entryPath,
  entrySection,
  filterCommands,
  filterPalette,
  type SlashMenuEntry,
} from '../../src/slash/commands.js';
import { COMMAND_META, SECTION_ORDER, type MenuContext } from '../../src/slash/command-meta.js';

const CLASSIC: MenuContext = { concierge: false, subagentFocused: false };
const CONCIERGE: MenuContext = { concierge: true, subagentFocused: false };
const FOCUSED: MenuContext = { concierge: false, subagentFocused: true };

const search = (q: string, ctx: MenuContext = CLASSIC): string[] =>
  filterCommands(q, [], NATIVE_COMMANDS, ctx).map(entryPath);

describe('busca do menu / (PT-BR, alias, descrição)', () => {
  it.each([
    ['tema', 'theme'],
    ['cor', 'theme'],
    ['escuro', 'theme'],
    ['claro', 'theme'],
    ['sair', 'quit'],
    ['fechar', 'quit'],
    ['senha', 'secret'],
    ['chave', 'secret'],
    ['token', 'secret'],
    ['resumir', 'compact'],
    ['contexto', 'compact'],
    ['idioma', 'lang'],
    ['rodape', 'statusline'], // sem acento também casa
    ['rodapé', 'statusline'],
    ['agendar', 'cron'],
    ['memória', 'memory'],
  ])('/%s acha /%s em primeiro', (q, first) => {
    expect(search(q)[0]).toBe(first);
  });

  it('parar / tarefa / "segundo plano" acham /task (no concierge)', () => {
    expect(search('parar', CONCIERGE)[0]).toBe('task');
    expect(search('tarefa', CONCIERGE)).toContain('task');
    expect(search('segundo plano', CONCIERGE)).toContain('task');
  });

  it('casa a descrição (palavra que só existe no texto)', () => {
    // "pergunta" é keyword; "interromper" só existe na descrição de /ask
    expect(search('interromper')).toContain('ask');
  });

  it('nome exato e prefixo vêm antes de palavra-chave e descrição', () => {
    // "model" é nome exato; /provider tem "modelo" só como palavra de descrição/keyword
    const r = search('model');
    expect(r[0]).toBe('model');
    const t = search('th');
    expect(t[0]).toBe('theme');
  });

  it('prefixo do nome vem antes de quem só contém o trecho (/in: init e inventory antes de rewind)', () => {
    const r = search('in');
    expect(r.slice(0, 2)).toEqual(['init', 'inventory']);
    expect(r.indexOf('rewind')).toBeGreaterThan(1);
  });

  it('1 letra só casa nome/alias (não polui com descrição)', () => {
    const r = search('s');
    expect(r.every((p) => p.toLowerCase().includes('s') || p === 'approve')).toBe(true);
    // e nenhum comando entra só por ter "s" na descrição
    expect(r).not.toContain('quit');
  });

  it('aliases acham o comando: view→split, cockpit→fullscreen, a→approve, n→deny', () => {
    expect(search('view')[0]).toBe('split');
    expect(search('cockpit')[0]).toBe('fullscreen');
    expect(search('a', CONCIERGE)[0]).toBe('approve');
    expect(search('n', CONCIERGE)[0]).toBe('deny');
  });

  it('aliases aparecem na descrição de quem os tem', () => {
    const sum = (id: string): string => NATIVE_COMMANDS.find((c) => c.id === id)!.summary;
    expect(sum('split')).toContain('/view');
    expect(sum('fullscreen')).toContain('/cockpit');
    expect(sum('approve')).toContain('/a');
    expect(sum('deny')).toContain('/n');
  });

  it('palette (ctrl+p) também acha por palavra-chave PT-BR', () => {
    expect(filterPalette('tema')[0]?.label).toBe('/theme');
    expect(filterPalette('senha').map((h) => h.label)).toContain('/secret');
    // e na mesma ordem do menu: palavra-chave exata antes de quem só cita a palavra na descrição
    expect(filterPalette('tarefa')[0]?.label).toBe('/task');
    expect(filterPalette('sair')[0]?.label).toBe('/quit');
  });
});

describe('lista padrão do menu /', () => {
  const names = (ctx: MenuContext): string[] => search('', ctx);

  it('esconde os raros e os subcomandos achatados', () => {
    const n = names(CLASSIC);
    for (const rare of [
      'rooms',
      'service',
      'upgrade',
      'window',
      'telegram',
      'agents',
      'skills',
      'redo',
    ]) {
      expect(n).not.toContain(rare);
    }
    expect(n.every((p) => !p.includes(' '))).toBe(true);
  });

  it('raros continuam buscáveis (e executáveis)', () => {
    for (const rare of [
      'rooms',
      'service',
      'upgrade',
      'window',
      'telegram',
      'agents',
      'skills',
      'redo',
    ]) {
      expect(search(rare)).toContain(rare);
    }
  });

  it('/task, /approve e /deny só no concierge', () => {
    for (const c of ['task', 'approve', 'deny']) {
      expect(names(CLASSIC)).not.toContain(c);
      expect(search(c, CLASSIC)).not.toContain(c);
      expect(names(CONCIERGE)).toContain(c);
    }
  });

  it('/back só com sub-agente em foco; /ask some no concierge', () => {
    expect(names(CLASSIC)).not.toContain('back');
    expect(search('back', CLASSIC)).not.toContain('back');
    expect(search('back', FOCUSED)).toContain('back');
    expect(names(CLASSIC)).toContain('ask');
    expect(names(CONCIERGE)).not.toContain('ask');
  });

  it('seções contíguas, na ordem conversa→interface→modelo→trabalho→extensões→conta', () => {
    const entries: SlashMenuEntry[] = [...filterCommands('', [], NATIVE_COMMANDS, CONCIERGE)];
    const seen: string[] = [];
    for (const e of entries) {
      const s = entrySection(e);
      if (seen[seen.length - 1] !== s) seen.push(s);
    }
    expect(seen).toEqual(SECTION_ORDER.filter((s) => seen.includes(s)));
    expect(new Set(seen).size).toBe(seen.length); // nenhuma seção reaparece
  });

  it('sem contexto (legado) lista tudo, inclusive subcomandos', () => {
    expect(filterCommands('').length).toBeGreaterThan(NATIVE_COMMANDS.length);
  });
});

describe('descrições (6.1, 6.4)', () => {
  const JARGAO =
    /\b(tier|BYO|passthrough|ghost|alt-screen|anti-runaway|sidecar|jobs?|grants|backlog)\b/i;

  it('todo comando nativo tem metadado, palavras-chave e descrição curta sem jargão', () => {
    for (const c of NATIVE_COMMANDS) {
      expect(c.id && COMMAND_META[c.id], c.name).toBeDefined();
      expect(c.keywords?.length, c.name).toBeGreaterThan(0);
      expect(c.summary.length, c.name).toBeLessThanOrEqual(60);
      expect(c.summary, c.name).not.toMatch(JARGAO);
      for (const s of c.subcommands ?? [])
        expect(s.summary, `${c.name} ${s.name}`).not.toMatch(JARGAO);
    }
  });

  it('voz única: infinitivo (1ª palavra termina em r) ou nome de lista', () => {
    // "salas de conversa entre agentes" (/rooms) é o único substantivo, de propósito.
    for (const c of NATIVE_COMMANDS) {
      if (c.id === 'rooms') continue;
      expect(c.summary.split(' ')[0], c.name).toMatch(/r$/);
    }
  });

  it('/todo e /task têm descrições distintas', () => {
    const d = (id: string): string => NATIVE_COMMANDS.find((c) => c.id === id)!.summary;
    expect(d('todo')).not.toBe(d('task'));
    expect(d('task')).toMatch(/segundo plano/);
    expect(d('todo')).toMatch(/anotad/);
  });

  it('/window descreve que DEFINE a janela (não "informa")', () => {
    expect(NATIVE_COMMANDS.find((c) => c.id === 'window')!.summary).toMatch(/^definir/);
  });
});

describe('/classic e /concierge — atalhos de modo no menu', () => {
  it('/classic só aparece no concierge; /concierge só no clássico', () => {
    expect(search('', CONCIERGE)).toContain('classic');
    expect(search('', CONCIERGE)).not.toContain('concierge');
    expect(search('', CLASSIC)).toContain('concierge');
    expect(search('', CLASSIC)).not.toContain('classic');
  });
  it('descrições no infinitivo e seção conversa', () => {
    expect(COMMAND_META.classic.summary).toBe('voltar ao modo clássico (um laço só, como antes)');
    expect(COMMAND_META.concierge.summary).toBe(
      'usar o concierge (a conversa nunca espera o trabalho)',
    );
    expect(COMMAND_META.classic.section).toBe('conversa');
    expect(COMMAND_META.concierge.section).toBe('conversa');
  });
  it.each(['clássico', 'tradicional', 'antigo', 'normal'])('"%s" acha /classic', (q) => {
    expect(search(q, CONCIERGE)).toContain('classic');
  });
  it.each(['tarefas', 'paralelo', 'concierge'])('"%s" acha /concierge', (q) => {
    expect(search(q, CLASSIC)).toContain('concierge');
  });
});
