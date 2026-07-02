// EST-0948 · CA-3 — roteamento de slash-commands (nativos + do usuário).

import { describe, expect, it } from 'vitest';
import {
  routeInput,
  buildSessionCommandsNote,
  SESSION_COMMANDS_NOTE_HEADER,
  filterCommands,
  isSlashMenuQuery,
  entryPath,
  entryCompletion,
  isTerminalSubcommand,
  terminalSubmitLine,
  isParallelWhileBusy,
  effortIsReadOnly,
  mcpIsReadOnly,
  menuEntries,
  slashMenuVisibleLines,
  windowSlashEntries,
  entrySection,
  NATIVE_COMMANDS,
  type SlashCommand,
  type SlashMenuEntry,
} from '../../src/slash/commands.js';

const USER: readonly SlashCommand[] = [
  { name: 'deploy', summary: 'sobe pra staging', source: 'user' },
];

// EST-0974 — helpers p/ os testes lerem a nova forma (ENTRADAS achatadas).
const paths = (es: readonly SlashMenuEntry[]): string[] => es.map(entryPath);
const cmdName = (e: SlashMenuEntry | undefined): string | undefined =>
  e?.kind === 'command' ? e.command.name : undefined;
const cmdId = (e: SlashMenuEntry | undefined): string | undefined =>
  e?.kind === 'command' ? e.command.id : undefined;

describe('routeInput', () => {
  it('linha sem `/` ⇒ objetivo p/ o agente', () => {
    const r = routeInput('explique a estrutura deste repo');
    expect(r.kind).toBe('goal');
    if (r.kind === 'goal') expect(r.text).toBe('explique a estrutura deste repo');
  });

  it('comando nativo é reconhecido e roteado', () => {
    const r = routeInput('/help');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.id).toBe('help');
  });

  it('EST-0977 — /agents é nativo e roteia p/ o id agents (workspace)', () => {
    const r = routeInput('/agents');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.id).toBe('agents');
      expect(r.command.source).toBe('native');
      expect(r.command.section).toBe('workspace');
    }
  });

  it('comando com argumentos separa nome e args', () => {
    const r = routeInput('/model turbo');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.name).toBe('model');
      expect(r.args).toBe('turbo');
    }
  });

  it('EST-0962 — /provider é nativo (sessão) e separa o nome do provider', () => {
    const r = routeInput('/provider deepseek');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.id).toBe('provider');
      expect(r.command.source).toBe('native');
      expect(r.command.section).toBe('sessão');
      expect(r.args).toBe('deepseek');
    }
  });

  it('comando do USUÁRIO (dado) é reconhecido', () => {
    const r = routeInput('/deploy', USER);
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.source).toBe('user');
  });

  // EST-0974 — chain completa Parte 1: `/deploy <args>` ⇒ command(user) + args; a
  // expansão do template (puro, cli-core) vira o OBJETIVO submetido. AUSENTE ⇒ não
  // existe (unknown-command), nunca um goal silencioso.
  it('comando do USUÁRIO com args separa nome e args (p/ a expansão do template)', () => {
    const r = routeInput('/deploy staging --force', USER);
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.source).toBe('user');
      expect(r.command.name).toBe('deploy');
      expect(r.args).toBe('staging --force');
    }
  });

  it('comando do USUÁRIO AUSENTE ⇒ unknown-command (não existe), não goal', () => {
    const r = routeInput('/inexistente', USER);
    expect(r.kind).toBe('unknown-command');
  });

  it('slash desconhecido ⇒ unknown-command (não vira goal silencioso)', () => {
    const r = routeInput('/inexistente');
    expect(r.kind).toBe('unknown-command');
  });

  it('F179 — /export é nativo (antes: unknown-command, apesar do hint prometê-lo)', () => {
    const r = routeInput('/export');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.id).toBe('export');
      expect(r.command.source).toBe('native');
    }
  });

  it('case-insensitive no nome do comando', () => {
    const r = routeInput('/HELP');
    expect(r.kind).toBe('command');
  });

  // EST-0990 — `/split` é nativo; `/view` é ALIAS (mesmo comando `split`).
  it('`/split` roteia p/ o comando nativo split', () => {
    const r = routeInput('/split');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.id).toBe('split');
  });

  it('`/view` é alias de `/split` (mesmo comando)', () => {
    const r = routeInput('/view');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.id).toBe('split');
  });

  // EST-0958 · CA-1 — `!comando` (atalho de shell) é roteado como `bang`, NÃO goal.
  it('`!` no início ⇒ bang com o comando (resto da linha, sem o `!`)', () => {
    const r = routeInput('!git status');
    expect(r.kind).toBe('bang');
    if (r.kind === 'bang') expect(r.command).toBe('git status');
  });

  it('`!ls -la` preserva o comando exato (não vai ao modelo como prompt)', () => {
    const r = routeInput('!ls -la');
    expect(r.kind).toBe('bang');
    if (r.kind === 'bang') expect(r.command).toBe('ls -la');
  });

  it('espaço após o `!` é tolerado (`! rm x` ⇒ comando `rm x`)', () => {
    const r = routeInput('!  rm x');
    expect(r.kind).toBe('bang');
    if (r.kind === 'bang') expect(r.command).toBe('rm x');
  });

  it('`!` sozinho ⇒ goal vazio (o caller ignora; não roda nada)', () => {
    const r = routeInput('!');
    expect(r.kind).toBe('goal');
    if (r.kind === 'goal') expect(r.text).toBe('');
  });

  it('`!` no MEIO da linha NÃO é modo shell (só no início)', () => {
    const r = routeInput('rode o teste com !bang no nome');
    expect(r.kind).toBe('goal');
  });
});

describe('filterCommands', () => {
  it('vazio ⇒ todas as entradas (nativos + subs achatados + usuário)', () => {
    // EST-0974 — agora ACHATA subcomandos: o total = #comandos + #subs (todos os
    // comandos) + 1 (o /deploy do usuário). Comprova que os subs entram no menu.
    const subCount = NATIVE_COMMANDS.reduce((n, c) => n + (c.subcommands?.length ?? 0), 0);
    expect(filterCommands('', USER).length).toBe(NATIVE_COMMANDS.length + subCount + 1);
  });

  it('filtra por prefixo incremental', () => {
    const r = filterCommands('lo');
    expect(paths(r)).toEqual(expect.arrayContaining(['login', 'logout']));
    expect(r.every((e) => entryPath(e).includes('lo'))).toBe(true);
  });

  it('EST-1015 — slashMenuVisibleLines = 1 (ajuda) + #entradas + #cabeçalhos de seção', () => {
    // `[]` ⇒ só a linha de ajuda.
    expect(slashMenuVisibleLines([])).toBe(1);
    // Caso REAL: conta os cabeçalhos como o render (1 por MUDANÇA de seção).
    for (const q of ['', 'l', 'mcp', 'deploy']) {
      const entries = filterCommands(q, USER);
      let headers = 0;
      let last: string | null = null;
      for (const e of entries) {
        const s = entrySection(e);
        if (s !== last) headers += 1;
        last = s;
      }
      expect(slashMenuVisibleLines(entries)).toBe(1 + entries.length + headers);
    }
    // `/deploy` (só o comando do usuário) ⇒ 1 ajuda + 1 cabeçalho 'usuário' + 1 entrada = 3.
    expect(slashMenuVisibleLines(filterCommands('deploy', USER))).toBe(3);
  });

  it('F89 (wrap-aware) — `columns` estreito conta MAIS linhas (entradas quebram)', () => {
    const entries = filterCommands('', USER);
    const wide = slashMenuVisibleLines(entries); // sem columns = por linha-fonte.
    const narrow = slashMenuVisibleLines(entries, 40); // cols=40 ⇒ entradas quebram.
    // Num terminal estreito a altura VISUAL é estritamente maior (várias entradas + ajuda quebram).
    expect(narrow).toBeGreaterThan(wide);
    // Largura enorme ⇒ nada quebra ⇒ igual ao por-linha-fonte (cada entrada 1 linha).
    expect(slashMenuVisibleLines(entries, 1000)).toBe(wide);
    // `[]` com columns ⇒ só a ajuda (1 linha, cabe em 1000 cols).
    expect(slashMenuVisibleLines([], 1000)).toBe(1);
  });

  describe('EST-1015 — windowSlashEntries CIENTE DE ALTURA (v2)', () => {
    /**
     * Helper: a INVARIANTE que a janela DEVE garantir — a altura renderizada REAL
     * do slice + os indicadores de overflow NUNCA excedem maxRows.
     */
    const invariantHolds = (w: ReturnType<typeof windowSlashEntries>, maxRows: number): boolean =>
      slashMenuVisibleLines(w.slice) + (w.hiddenAbove > 0 ? 1 : 0) + (w.hiddenBelow > 0 ? 1 : 0) <=
      maxRows;

    it('tela ALTA (maxRows enorme) ⇒ mostra tudo, sem janela', () => {
      const all = filterCommands('', USER);
      const full = windowSlashEntries(all, 0, 999);
      expect(full.slice.length).toBe(all.length);
      expect(full.hiddenAbove).toBe(0);
      expect(full.hiddenBelow).toBe(0);
      expect(invariantHolds(full, 999)).toBe(true);
    });

    it('tela BAIXA (maxRows=12) ⇒ janela, fatia MENOR que o total, invariante OK', () => {
      const all = filterCommands('', USER);
      const win = windowSlashEntries(all, 0, 12);
      expect(win.slice.length).toBeLessThan(all.length);
      expect(win.hiddenBelow).toBeGreaterThan(0);
      expect(invariantHolds(win, 12)).toBe(true);
    });

    it('item selecionado SEMPRE está dentro do slice', () => {
      const all = filterCommands('', USER);
      for (const sel of [0, Math.floor(all.length / 2), all.length - 1]) {
        const w = windowSlashEntries(all, sel, 8);
        expect(sel).toBeGreaterThanOrEqual(w.hiddenAbove);
        expect(sel).toBeLessThan(w.hiddenAbove + w.slice.length);
        // total preservado.
        expect(w.hiddenAbove + w.slice.length + w.hiddenBelow).toBe(all.length);
      }
    });

    it('ao menos 1 item (o selecionado) mesmo com maxRows MÍNIMO', () => {
      const all = filterCommands('', USER);
      // maxRows=6: mínimo realista p/ 1 entrada + 1 ajuda + cabeçalho de seção + 2 indicadores.
      const w = windowSlashEntries(all, 5, 6);
      expect(w.slice.length).toBeGreaterThanOrEqual(1);
      // o selecionado está no slice.
      expect(5).toBeGreaterThanOrEqual(w.hiddenAbove);
      expect(5).toBeLessThan(w.hiddenAbove + w.slice.length);
      expect(invariantHolds(w, 6)).toBe(true);
    });

    it('INVARIANTE com MUITOS cabeçalhos de seção + maxRows pequeno (5..20)', () => {
      // Constrói entradas MISTAS que forçam TODAS as seções (conta, sessão, workspace,
      // usuário) e subcomandos. Quanto MAIS cabeçalhos caírem na janela, MAIS a versão
      // antiga (contagem de itens) estourava — a v2 NUNCA estoura.
      const all = filterCommands('', USER); // lista completa: ~40 entradas, 4 seções.
      for (const mr of [5, 6, 7, 8, 10, 12, 15, 20]) {
        for (let sel = 0; sel < all.length; sel += 7) {
          const w = windowSlashEntries(all, sel, mr);
          expect(
            invariantHolds(w, mr),
            `INVARIANTE QUEBRADA: maxRows=${mr} sel=${sel} ` +
              `slice=${w.slice.length} acima=${w.hiddenAbove} abaixo=${w.hiddenBelow} ` +
              `altura=${slashMenuVisibleLines(w.slice)} + indicadores=${(w.hiddenAbove > 0 ? 1 : 0) + (w.hiddenBelow > 0 ? 1 : 0)} ` +
              `> maxRows=${mr}`,
          ).toBe(true);
          // selecionado está no slice.
          expect(sel).toBeGreaterThanOrEqual(w.hiddenAbove);
          expect(sel).toBeLessThan(w.hiddenAbove + w.slice.length);
        }
      }
    });

    it('navegação no TOPO: selected=0 com maxRows=6 ⇒ slice começa em 0', () => {
      const all = filterCommands('', USER);
      const w = windowSlashEntries(all, 0, 6);
      expect(w.hiddenAbove).toBe(0);
      expect(w.slice[0]).toBe(all[0]);
      expect(invariantHolds(w, 6)).toBe(true);
    });

    it('navegação no FIM: selected=last com maxRows=6 ⇒ slice termina em last', () => {
      const all = filterCommands('', USER);
      const w = windowSlashEntries(all, all.length - 1, 6);
      expect(w.hiddenBelow).toBe(0);
      expect(w.slice[w.slice.length - 1]).toBe(all[all.length - 1]);
      expect(invariantHolds(w, 6)).toBe(true);
    });

    it('navegação ↑↓ rola por TODOS os comandos (slice re-centra)', () => {
      const all = filterCommands('', USER);
      // Percorre do topo ao fim: a cada passo o selected está no slice.
      for (let sel = 0; sel < all.length; sel++) {
        const w = windowSlashEntries(all, sel, 8);
        expect(sel).toBeGreaterThanOrEqual(w.hiddenAbove);
        expect(sel).toBeLessThan(w.hiddenAbove + w.slice.length);
        expect(invariantHolds(w, 8)).toBe(true);
      }
    });
  });

  it('prefixo vem antes de substring (ranking)', () => {
    // `clear` contém "ea"? não. Usemos `e`: `help` (prefixo? não), … testa ordem
    // com `l`: prefixo (login/logout) antes de substring (clear, model, help).
    const r = filterCommands('l');
    const idxLogin = r.findIndex((e) => entryPath(e) === 'login');
    const idxClear = r.findIndex((e) => entryPath(e) === 'clear'); // contém 'l'
    expect(idxLogin).toBeGreaterThanOrEqual(0);
    if (idxClear >= 0) expect(idxLogin).toBeLessThan(idxClear);
  });

  it('/model existe e mostra tier (nunca provider) — presença do comando', () => {
    expect(NATIVE_COMMANDS.find((c) => c.id === 'model')?.summary).toMatch(/tier|broker/i);
  });

  it('EST-0960b — /undo e /redo estão no slash-menu (seção workspace)', () => {
    const undo = NATIVE_COMMANDS.find((c) => c.id === 'undo');
    const redo = NATIVE_COMMANDS.find((c) => c.id === 'redo');
    expect(undo?.name).toBe('undo');
    expect(redo?.name).toBe('redo');
    expect(undo?.section).toBe('workspace');
    expect(redo?.section).toBe('workspace');
    // roteamento reconhece /undo /redo (não cai em unknown nem em goal).
    expect(routeInput('/undo').kind).toBe('command');
    expect(routeInput('/redo').kind).toBe('command');
  });

  it('EST-0972 — /history está no slash-menu (seção sessão) e roteia como comando', () => {
    const history = NATIVE_COMMANDS.find((c) => c.id === 'history');
    expect(history?.name).toBe('history');
    expect(history?.section).toBe('sessão');
    expect(history?.summary).toMatch(/retoma|sess(ã|a)o|anterior/i);
    // roteamento reconhece /history e /history <id> (não cai em unknown nem em goal).
    expect(routeInput('/history').kind).toBe('command');
    const withId = routeInput('/history abc-123');
    expect(withId.kind).toBe('command');
    if (withId.kind === 'command') {
      expect(withId.command.id).toBe('history');
      expect(withId.args).toBe('abc-123');
    }
    // aparece no menu ao filtrar por "hist".
    expect(filterCommands('hist').some((e) => cmdId(e) === 'history')).toBe(true);
  });

  it('EST-0973 — /compact está no slash-menu (seção sessão) e roteia como comando', () => {
    const compact = NATIVE_COMMANDS.find((c) => c.id === 'compact');
    expect(compact?.name).toBe('compact');
    expect(compact?.section).toBe('sessão');
    const r = routeInput('/compact');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') expect(r.command.id).toBe('compact');
  });

  it('EST-0981 — /cycle está no slash-menu (seção sessão) e roteia como comando', () => {
    const cycle = NATIVE_COMMANDS.find((c) => c.id === 'cycle');
    expect(cycle?.name).toBe('cycle');
    expect(cycle?.section).toBe('sessão');
    const r = routeInput('/cycle 5m "rode os testes"');
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.id).toBe('cycle');
      // os argumentos (intervalo + tarefa) seguem p/ o handler do controller.
      expect(r.args).toContain('rode os testes');
    }
  });
});

describe('isSlashMenuQuery — o slash-menu só abre no NOME do comando (EST-0948)', () => {
  it('`/` sozinho abre o menu (lista tudo)', () => {
    expect(isSlashMenuQuery('/')).toBe(true);
  });

  it('NOME do comando sem espaço abre/mantém o menu', () => {
    expect(isSlashMenuQuery('/c')).toBe(true);
    expect(isSlashMenuQuery('/cyc')).toBe(true);
    expect(isSlashMenuQuery('/cycle')).toBe(true);
    expect(isSlashMenuQuery('/memory')).toBe(true);
  });

  it('PRIMEIRO espaço (entrou nos args) FECHA o menu — esta é a raiz do bug', () => {
    // comando SEM subs: o 1º espaço já é "entrei nos args" ⇒ menu fechado. Ex.: /usage.
    expect(isSlashMenuQuery('/usage ')).toBe(false);
    expect(isSlashMenuQuery('/model turbo')).toBe(false);
    // /cycle TEM subs (pause/resume/edit), mas o POSICIONAL multi-token também fecha:
    expect(isSlashMenuQuery('/cycle --max-iter 2 responda OK')).toBe(false);
    expect(isSlashMenuQuery('/cycle 5m "rode os testes"')).toBe(false);
    expect(isSlashMenuQuery('/memory edit abc texto')).toBe(false);
  });

  it('qualquer whitespace (tab) também conta como entrada nos args', () => {
    expect(isSlashMenuQuery('/usage\t2')).toBe(false); // /usage não tem subcomandos
  });

  it('linha que NÃO começa com `/` nunca abre o menu (objetivo/bang)', () => {
    expect(isSlashMenuQuery('')).toBe(false);
    expect(isSlashMenuQuery('liste os arquivos')).toBe(false);
    expect(isSlashMenuQuery('!git status')).toBe(false);
    expect(isSlashMenuQuery('@arquivo.ts')).toBe(false);
  });
});

// EST-0974 — SUBCOMANDOS no slash-menu (descoberta de `/mcp search` etc.).
describe('EST-0974 — subcomandos achatados no slash-menu', () => {
  it('/mcp e /memory declaram subcomandos', () => {
    const mcp = NATIVE_COMMANDS.find((c) => c.id === 'mcp');
    const mem = NATIVE_COMMANDS.find((c) => c.id === 'memory');
    // EST-0970 — o ciclo completo na sessão inclui disable/enable (sem desinstalar).
    expect(mcp?.subcommands?.map((s) => s.name)).toEqual([
      'search',
      'add',
      'list',
      'remove',
      'disable',
      'enable',
      'reconnect',
      'reload',
    ]);
    expect(mem?.subcommands?.map((s) => s.name)).toEqual(
      expect.arrayContaining(['forget', 'edit', 'pin']),
    );
    // cada sub tem summary (o menu exibe).
    expect(mcp?.subcommands?.every((s) => s.summary.length > 0)).toBe(true);
  });

  it('/cycle TEM subcomandos de lifecycle pause/resume/edit/status/stop (EST-1158)', () => {
    expect(NATIVE_COMMANDS.find((c) => c.id === 'cycle')?.subcommands?.map((s) => s.name)).toEqual([
      'pause',
      'resume',
      'edit',
      'status',
      'stop',
    ]);
  });

  it('/cron tem subcomandos de gerência (list/add/edit/enable/disable/rm) — EST-1158', () => {
    expect(NATIVE_COMMANDS.find((c) => c.id === 'cron')?.subcommands?.map((s) => s.name)).toEqual([
      'list',
      'add',
      'edit',
      'enable',
      'disable',
      'rm',
    ]);
  });

  it('digitar `/mcp` ⇒ o menu lista os 4 subs (search/add/list/remove) com summary', () => {
    // query `mcp` casa o pai E todos os subs (prefixo do caminho `mcp …`).
    const r = filterCommands('mcp');
    expect(paths(r)).toEqual(
      expect.arrayContaining(['mcp', 'mcp search', 'mcp add', 'mcp list', 'mcp remove']),
    );
    const search = r.find((e) => entryPath(e) === 'mcp search');
    expect(search?.kind).toBe('subcommand');
    if (search?.kind === 'subcommand') expect(search.sub.summary).toMatch(/registro|busca/i);
  });

  it('`/mcp s` (query `mcp s`) FILTRA `/mcp search`', () => {
    const r = filterCommands('mcp s');
    expect(paths(r)).toContain('mcp search');
    // não traz `/mcp add` (não casa `mcp s`).
    expect(paths(r)).not.toContain('mcp add');
  });

  it('o sub aparece ABAIXO do pai (ordem: comando, depois seus subs)', () => {
    const all = menuEntries();
    const iMcp = all.findIndex((e) => entryPath(e) === 'mcp');
    const iSearch = all.findIndex((e) => entryPath(e) === 'mcp search');
    expect(iMcp).toBeGreaterThanOrEqual(0);
    expect(iSearch).toBe(iMcp + 1);
  });

  it('completar um SUBcomando ⇒ `/mcp search ` (com espaço, pra digitar o termo)', () => {
    const search = filterCommands('mcp search').find((e) => entryPath(e) === 'mcp search')!;
    expect(entryCompletion(search)).toBe('/mcp search ');
  });

  it('completar um comando PAI (com subs) ⇒ `/mcp ` (drilla os subs)', () => {
    const mcp = filterCommands('mcp').find((e) => entryPath(e) === 'mcp')!;
    expect(entryCompletion(mcp)).toBe('/mcp ');
  });

  it('completar um comando FOLHA ⇒ `/help` (sem espaço, executável)', () => {
    const help = filterCommands('help').find((e) => cmdName(e) === 'help')!;
    expect(entryCompletion(help)).toBe('/help');
  });

  it('`/` sozinho lista TUDO (top-level + subs achatados)', () => {
    const r = filterCommands('');
    expect(paths(r)).toContain('mcp');
    expect(paths(r)).toContain('mcp search');
    expect(paths(r)).toContain('help');
  });
});

// EST-0983 (#157 fix) — SUBcomandos TERMINAIS (`/clear full`, `/clear memory`): verbos
// SEM argumento ⇒ o Enter SUBMETE, não fica preso re-completando. `isTerminalSubcommand`
// distingue-os dos subs que pedem argumento (`/mcp search <termo>`).
describe('EST-0983 — subcomandos TERMINAIS (verbo sem argumento)', () => {
  const sub = (path: string): Extract<SlashMenuEntry, { kind: 'subcommand' }> => {
    const e = filterCommands(path).find((x) => entryPath(x) === path);
    if (!e || e.kind !== 'subcommand') throw new Error(`não achou o sub ${path}`);
    return e;
  };

  it('`/clear full` e `/clear memory` são TERMINAIS (Enter deve submeter)', () => {
    expect(isTerminalSubcommand(sub('clear full'))).toBe(true);
    expect(isTerminalSubcommand(sub('clear memory'))).toBe(true);
  });

  it('subs que pedem argumento NÃO são terminais (Enter ainda completa e aguarda)', () => {
    // `/mcp search <termo>` precisa do termo; `/memory esquecer <id>` precisa do id.
    expect(isTerminalSubcommand(sub('mcp search'))).toBe(false);
    expect(isTerminalSubcommand(sub('memory forget'))).toBe(false);
  });

  it('um COMANDO (não-sub) nunca é terminal-de-sub', () => {
    const help = filterCommands('help').find((e) => entryPath(e) === 'help')!;
    expect(isTerminalSubcommand(help)).toBe(false);
  });

  it('terminalSubmitLine devolve `/<pai> <sub>` SEM trailing space (forma submetível)', () => {
    expect(terminalSubmitLine(sub('clear full'))).toBe('/clear full');
    expect(terminalSubmitLine(sub('clear memory'))).toBe('/clear memory');
  });

  it('routeInput aceita a linha submetível como o comando /clear com o verbo como arg', () => {
    // a linha que o Enter submete roteia EXATAMENTE como o usuário tivesse digitado tudo.
    const r = routeInput(terminalSubmitLine(sub('clear full')));
    expect(r.kind).toBe('command');
    if (r.kind === 'command') {
      expect(r.command.id).toBe('clear');
      expect(r.args).toBe('full');
    }
  });
});

// EST-0974 — o menu fica aberto durante a navegação do SUBcomando (1 espaço tolerado
// só p/ comandos COM subs), e fecha ao entrar nos ARGS do sub.
describe('EST-0974 — isSlashMenuQuery tolera o nível do subcomando', () => {
  it('`/mcp ` (espaço) MANTÉM o menu aberto (revela os subs)', () => {
    expect(isSlashMenuQuery('/mcp ')).toBe(true);
  });

  it('`/mcp s` e `/mcp search` mantêm o menu (digitando o nome do sub)', () => {
    expect(isSlashMenuQuery('/mcp s')).toBe(true);
    expect(isSlashMenuQuery('/mcp search')).toBe(true);
  });

  it('`/mcp search github` (2º espaço = args do sub) FECHA o menu', () => {
    expect(isSlashMenuQuery('/mcp search github')).toBe(false);
    expect(isSlashMenuQuery('/mcp search ')).toBe(false);
  });

  it('comando SEM subs NÃO regride: `/usage ` fecha (regra antiga)', () => {
    expect(isSlashMenuQuery('/usage ')).toBe(false);
    expect(isSlashMenuQuery('/model turbo')).toBe(false);
  });

  it('comando do USUÁRIO com subs também é tolerado (e sem subs, não)', () => {
    const userWithSubs: readonly SlashCommand[] = [
      {
        name: 'deploy',
        summary: 'sobe',
        source: 'user',
        subcommands: [{ name: 'staging', summary: 'sobe pra staging' }],
      },
    ];
    expect(isSlashMenuQuery('/deploy ', userWithSubs)).toBe(true);
    expect(isSlashMenuQuery('/deploy stag', userWithSubs)).toBe(true);
    expect(isSlashMenuQuery('/deploy staging now', userWithSubs)).toBe(false);
    // sem a lista (sem saber dos subs) ⇒ fecha no 1º espaço (conservador).
    expect(isSlashMenuQuery('/deploy ')).toBe(false);
  });
});

// EST-0982 · ADR-0080 — comando PARALELO-SEGURO mid-turn (`isParallelWhileBusy`).
describe('isParallelWhileBusy (EST-0982 · ADR-0080)', () => {
  it('o /ask é paralelo-seguro (flag `parallelWhileBusy` no registro nativo)', () => {
    const ask = NATIVE_COMMANDS.find((c) => c.id === 'ask');
    expect(ask).toBeDefined();
    expect(ask!.parallelWhileBusy).toBe(true);
    expect(isParallelWhileBusy(ask!)).toBe(true);
  });

  it('FALLBACK pelo id `ask` mesmo sem a flag (registro reconstruído)', () => {
    const askNoFlag: SlashCommand = {
      name: 'ask',
      summary: 'pergunta paralela',
      source: 'native',
      id: 'ask',
    };
    expect(askNoFlag.parallelWhileBusy).toBeUndefined();
    expect(isParallelWhileBusy(askNoFlag)).toBe(true);
  });

  it('MUTADORES (compact/model/clear) NÃO são paralelo-seguros ⇒ enfileiram mid-turn', () => {
    for (const id of ['compact', 'model', 'clear'] as const) {
      const cmd = NATIVE_COMMANDS.find((c) => c.id === id);
      expect(cmd, `comando /${id} deve existir`).toBeDefined();
      expect(isParallelWhileBusy(cmd!)).toBe(false);
    }
  });

  it('comando do USUÁRIO sem flag não é paralelo-seguro', () => {
    expect(isParallelWhileBusy({ name: 'deploy', summary: 'sobe', source: 'user' })).toBe(false);
  });

  // EST-0982 (P2-1) — read-only PUROS marcados `parallelWhileBusy` (rodam JÁ mid-turn).
  it('read-only puros (help/whoami/usage/doctor/agents) são paralelo-seguros', () => {
    for (const id of ['help', 'whoami', 'usage', 'doctor', 'agents'] as const) {
      const cmd = NATIVE_COMMANDS.find((c) => c.id === id);
      expect(cmd, `comando /${id} deve existir`).toBeDefined();
      expect(cmd!.parallelWhileBusy, `/${id} deve marcar parallelWhileBusy`).toBe(true);
      expect(isParallelWhileBusy(cmd!)).toBe(true);
    }
  });

  // EST-0982 (P2-1) — comandos que MEXEM na tela/contexto NÃO são paralelo-seguros (destruiriam
  // o turno vivo): history/fullscreen/split, além de model/provider/lang/theme/login/logout/etc.
  it('comandos que mexem na tela/contexto NÃO são paralelo-seguros', () => {
    for (const id of [
      'history',
      'fullscreen',
      'split',
      'model',
      'provider',
      'lang',
      'theme',
      'login',
      'logout',
      'rename',
      'undo',
      'redo',
      'cycle',
      'permissions',
      'init',
    ] as const) {
      const cmd = NATIVE_COMMANDS.find((c) => c.id === id);
      if (!cmd) continue; // alguns ids podem não existir como nativo; o que existe não pode vazar
      expect(isParallelWhileBusy(cmd, ''), `/${id} NÃO pode ser paralelo-seguro`).toBe(false);
    }
  });

  // EST-0982 (P2-1) — DUAL-MODE: `/effort` (leitura) paralelo; `/effort <v>` (mutador) enfileira.
  it('/effort é paralelo SÓ sem argumento (leitura); com valor MUTA ⇒ enfileira', () => {
    const effort = NATIVE_COMMANDS.find((c) => c.id === 'effort');
    expect(effort).toBeDefined();
    expect(effort!.parallelWhileBusyWith).toBeDefined();
    expect(isParallelWhileBusy(effort!, '')).toBe(true);
    expect(isParallelWhileBusy(effort!, '   ')).toBe(true);
    expect(isParallelWhileBusy(effort!, 'high')).toBe(false);
    // predicado puro:
    expect(effortIsReadOnly('')).toBe(true);
    expect(effortIsReadOnly('low')).toBe(false);
  });

  // EST-0982 (P2-1) — DUAL-MODE: `/mcp` listagem/list/search paralelo; add/remove/disable/
  // enable/reload/reconnect MEXEM (config/tools do turno) ⇒ enfileiram.
  it('/mcp é paralelo SÓ na listagem/list/search; mutadoras e reload/reconnect enfileiram', () => {
    const mcp = NATIVE_COMMANDS.find((c) => c.id === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp!.parallelWhileBusyWith).toBeDefined();
    expect(isParallelWhileBusy(mcp!, '')).toBe(true); // listagem
    expect(isParallelWhileBusy(mcp!, 'list')).toBe(true);
    expect(isParallelWhileBusy(mcp!, 'search redis')).toBe(true);
    for (const verb of ['add', 'remove', 'disable', 'enable', 'reload', 'reconnect']) {
      expect(isParallelWhileBusy(mcp!, verb), `/mcp ${verb} NÃO pode ser paralelo`).toBe(false);
    }
    // predicado puro:
    expect(mcpIsReadOnly('')).toBe(true);
    expect(mcpIsReadOnly('LIST')).toBe(true);
    expect(mcpIsReadOnly('add foo -- bar')).toBe(false);
    expect(mcpIsReadOnly('reload all')).toBe(false);
  });
});

describe('EST-1149 · ADR-0127 — buildSessionCommandsNote (auto-conhecimento)', () => {
  it('gera a nota do registro com o cabeçalho + a fronteira "recomende, não invoque"', () => {
    const note = buildSessionCommandsNote();
    expect(note).toBeDefined();
    expect(note!).toContain(SESSION_COMMANDS_NOTE_HEADER);
    expect(note!).toMatch(/RECOMENDA|RECOMENDE/);
    expect(note!).toContain('NÃO digita');
  });

  it('inclui o /cycle (o fix do bug reportado: agendar loop ⇒ /cycle, não Task Scheduler)', () => {
    const note = buildSessionCommandsNote()!;
    expect(note).toContain('/cycle');
    expect(note).toMatch(/loop|ciclo/i);
    // a nota orienta a NÃO sugerir Task Scheduler quando há comando nativo.
    expect(note).toContain('Task Scheduler');
  });

  it('é SINGLE-SOURCE: todo comando nativo com summary aparece (não hardcoded)', () => {
    const note = buildSessionCommandsNote()!;
    const withSummary = NATIVE_COMMANDS.filter((c) => c.summary.trim() !== '');
    for (const c of withSummary) expect(note).toContain(`/${c.name}`);
    expect(withSummary.length).toBeGreaterThan(10);
  });

  it('registro vazio ⇒ undefined (não injeta nada — não-regressão)', () => {
    expect(buildSessionCommandsNote([])).toBeUndefined();
  });
});
