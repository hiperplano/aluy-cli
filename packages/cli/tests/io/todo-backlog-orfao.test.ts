// BUG-0029 (emenda) — o BACKLOG ÓRFÃO: a lista vazia não pode afirmar que nada foi
// anotado quando o que foi anotado está no arquivo de OUTRA conversa.
//
// O relato que originou isto (dono, 31/08): ele pediu ao agente que anotasse o
// trabalho, a própria CLI mandou REINICIAR a sessão (para descobrir um agente `.md`
// recém-criado), e o `list_todos` da sessão nova respondeu "nenhum item anotado
// ainda". O agente repetiu como fato — "não anotei nada que tenha esquecido". Era
// falso. A pergunta dele foi "sério que vc anotou e esqueceu?", e a resposta honesta
// era "anotei, e olhei no arquivo errado".
//
// O escopo por conversa (BUG-0029) está CERTO e este arquivo NÃO o afrouxa: o que
// atravessa é a CONTAGEM, nunca o texto — devolver conteúdo de outra conversa
// reabriria exatamente o vazamento que aquele bug fechou. O que se conserta aqui é o
// silêncio ambíguo: "não há nada" e "está em outro arquivo" saíam idênticos.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeTodoStore } from '../../src/io/todo-store.js';
import { listTodosTool } from '../../../cli-core/src/agent/todo/todo-tools.js';

let base: string;

beforeEach(() => {
  // tmpdir SEMPRE: a suíte nunca toca o `~/.aluy` real de quem roda.
  base = mkdtempSync(join(tmpdir(), 'aluy-todo-orfao-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Roda a tool `list_todos` contra um store, como o loop faria. */
async function listar(store: NodeTodoStore): Promise<{ ok: boolean; observation: string }> {
  const r = await listTodosTool.run({}, { todo: store } as never);
  return { ok: r.ok, observation: r.observation ?? '' };
}

describe('pendingElsewhere — conta os pendentes das outras conversas', () => {
  it('sem nenhuma outra conversa, conta ZERO', async () => {
    const s = new NodeTodoStore({ baseDir: base, sessionId: 'sozinha' });
    await s.add('algo');
    expect(await s.pendingElsewhere()).toBe(0);
  });

  it('conta os pendentes da conversa VIZINHA, sem contar os próprios', async () => {
    const antiga = new NodeTodoStore({ baseDir: base, sessionId: 'conversa-antiga' });
    await antiga.add('retomar o redesign do NovaBank');
    await antiga.add('criar o agente ux-frontend');

    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'conversa-nova' });
    await nova.add('item só desta conversa');

    // 2 da vizinha; o próprio item NÃO entra (o `list()` já o mostra).
    expect(await nova.pendingElsewhere()).toBe(2);
  });

  it('item FEITO não conta como pendente', async () => {
    const antiga = new NodeTodoStore({ baseDir: base, sessionId: 'antiga' });
    const id = await antiga.add('já resolvido');
    await antiga.done(id);
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    expect(await nova.pendingElsewhere()).toBe(0);
  });

  it('enxerga o backlog LEGADO global (`todos.json`) — quem rodou sem sessionId anotou lá', async () => {
    const legado = new NodeTodoStore({ baseDir: base });
    await legado.add('anotado antes do escopo por sessão');
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    expect(await nova.pendingElsewhere()).toBe(1);
  });

  it('arquivo com JSON sujo conta ZERO e não derruba a contagem', async () => {
    mkdirSync(join(base, 'todos'), { recursive: true });
    writeFileSync(join(base, 'todos', 'corrompida.json'), '{isto não é json[[[', 'utf8');
    const boa = new NodeTodoStore({ baseDir: base, sessionId: 'boa' });
    await boa.add('pendente de verdade');
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    // o lixo é ignorado, o pendente real segue contado
    expect(await nova.pendingElsewhere()).toBe(1);
  });
});

describe('list_todos — a lista vazia parou de mentir', () => {
  it('NÃO afirma "nenhum item anotado" quando há pendente em outra conversa', async () => {
    const antiga = new NodeTodoStore({ baseDir: base, sessionId: 'antiga' });
    await antiga.add('retomar o redesign do NovaBank');

    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    const { ok, observation } = await listar(nova);

    expect(ok).toBe(true);
    // A frase EXATA que produziu a mentira não pode mais aparecer.
    expect(observation).not.toContain('nenhum item anotado ainda');
    // E o agente é instruído a não repetir a afirmação falsa.
    expect(observation).toContain('NÃO afirme que nada foi anotado');
  });

  it('diz QUANTOS e COMO retomar', async () => {
    const antiga = new NodeTodoStore({ baseDir: base, sessionId: 'antiga' });
    await antiga.add('um');
    await antiga.add('dois');
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    const { observation } = await listar(nova);

    expect(observation).toContain('2 itens pendentes');
    expect(observation).toContain('--continue');
    expect(observation).toContain('--resume');
  });

  it('singular quando é um só (o texto não sai capenga)', async () => {
    const antiga = new NodeTodoStore({ baseDir: base, sessionId: 'antiga' });
    await antiga.add('só um');
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    expect((await listar(nova)).observation).toContain('1 item pendente');
  });

  it('NÃO vaza o TEXTO da outra conversa — o isolamento do BUG-0029 continua de pé', async () => {
    const antiga = new NodeTodoStore({ baseDir: base, sessionId: 'antiga' });
    await antiga.add('SEGREDO-DA-OUTRA-CONVERSA');
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    expect((await listar(nova)).observation).not.toContain('SEGREDO-DA-OUTRA-CONVERSA');
  });

  it('sem nada em lugar nenhum, segue dizendo que está vazio (sem alarme falso)', async () => {
    const nova = new NodeTodoStore({ baseDir: base, sessionId: 'nova' });
    const { observation } = await listar(nova);
    expect(observation).toContain('vazio');
    expect(observation).not.toContain('OUTRA(S) conversa');
  });
});
