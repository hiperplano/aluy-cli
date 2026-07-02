// EST-0972 — resolução da retomada (`--continue`/`--resume [<id>]`) sobre o store.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import {
  resolveResume,
  resolveAutoResume,
  decideBootResume,
  countMessages,
  countUserTurns,
  resolveResumedModel,
  resolvePreferredModel,
  RESUME_CUSTOM_FALLBACK_TIER,
  DEFAULT_AUTORESUME_WINDOW_MS,
} from '../../src/session/resume.js';
import type { SessionBlock } from '../../src/session/model.js';

const you: SessionBlock = { kind: 'you', text: 'oi' };
const aluy: SessionBlock = { kind: 'aluy', text: 'olá', streaming: false };

describe('resolveResume (EST-0972)', () => {
  let base: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-resume-'));
    clock = 1_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('pedido ausente ⇒ none (sessão nova)', () => {
    expect(resolveResume(undefined, store, '/p')).toEqual({ kind: 'none' });
  });

  it('--continue com sessão no cwd ⇒ resumed (a mais recente daquele cwd)', () => {
    clock = 100;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you] });
    clock = 200;
    store.save({ id: 'b', cwd: '/p', tier: 't', blocks: [you] });
    clock = 300;
    store.save({ id: 'c', cwd: '/outro', tier: 't', blocks: [you] });
    const r = resolveResume({ kind: 'continue' }, store, '/p');
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.id).toBe('b');
  });

  it('--continue SEM sessão no cwd ⇒ none (nova)', () => {
    store.save({ id: 'a', cwd: '/outro', tier: 't', blocks: [you] });
    expect(resolveResume({ kind: 'continue' }, store, '/p')).toEqual({ kind: 'none' });
  });

  it('--resume <id> existente ⇒ resumed daquela sessão', () => {
    store.save({ id: 'alvo', cwd: '/p', tier: 't', blocks: [you] });
    const r = resolveResume({ kind: 'resume', id: 'alvo' }, store, '/qualquer');
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.id).toBe('alvo');
  });

  it('F169 — `--resume <nome>` retoma pelo RÓTULO do /rename (case-insensitive)', () => {
    store.save({
      id: 'abc123',
      cwd: '/p',
      tier: 't',
      blocks: [you],
      label: 'FLUIDER-ORCHESTRATOR',
    });
    const r = resolveResume({ kind: 'resume', id: 'fluider-orchestrator' }, store, '/q');
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.id).toBe('abc123');
  });

  it('F169 — nome AMBÍGUO (2+ sessões com o mesmo rótulo) ⇒ pick FILTRADO nelas', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [you], label: 'aluy' });
    clock += 10;
    store.save({ id: 's2', cwd: '/p', tier: 't', blocks: [you], label: 'ALUY' });
    clock += 10;
    store.save({ id: 's3', cwd: '/p', tier: 't', blocks: [you], label: 'outra' });
    const r = resolveResume({ kind: 'resume', id: 'aluy' }, store, '/q');
    expect(r.kind).toBe('pick');
    if (r.kind === 'pick') {
      expect(r.choices.map((c) => c.id).sort()).toEqual(['s1', 's2']);
    }
  });

  it('F169 — id LITERAL vence o nome (sessão cujo id colide com rótulo alheio)', () => {
    store.save({ id: 'alvo', cwd: '/p', tier: 't', blocks: [you] });
    store.save({ id: 'outra', cwd: '/p', tier: 't', blocks: [you], label: 'alvo' });
    const r = resolveResume({ kind: 'resume', id: 'alvo' }, store, '/q');
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.id).toBe('alvo');
  });

  it('F110 — `--resume <id>` inexistente ⇒ not-found (com o id), NÃO none (p/ o boot AVISAR)', () => {
    // Distinto de `none` (nada pedido): o id explícito não-achado vira `not-found` p/ o
    // boot avisar "sessão <id> não encontrada — nova" em vez de cair calado numa sessão branca.
    expect(resolveResume({ kind: 'resume', id: 'fantasma' }, store, '/p')).toEqual({
      kind: 'not-found',
      requestedId: 'fantasma',
    });
  });

  it('--resume SEM id e HÁ sessões ⇒ pick (lista p/ escolher)', () => {
    clock = 1;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you] });
    clock = 2;
    store.save({ id: 'b', cwd: '/q', tier: 't', blocks: [you] });
    const r = resolveResume({ kind: 'resume' }, store, '/p');
    expect(r.kind).toBe('pick');
    if (r.kind === 'pick') expect(r.choices.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('--resume SEM id e SEM sessões ⇒ none (nova)', () => {
    expect(resolveResume({ kind: 'resume' }, store, '/p')).toEqual({ kind: 'none' });
  });
});

// ── EST-0972 (BUG 2) — auto-oferta de retomada no boot (sem flag explícita) ──────
describe('resolveAutoResume (EST-0972, BUG 2)', () => {
  let base: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-autoresume-'));
    clock = 1_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('sessão recente do MESMO cwd, sem flag ⇒ offer (com nº de mensagens + idade)', () => {
    clock = 100_000;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy, you] });
    // boot 5 min depois, no MESMO cwd, sem flag e sem --new.
    const now = 100_000 + 5 * 60_000;
    const r = resolveAutoResume(undefined, false, store, '/p', now);
    expect(r.kind).toBe('offer');
    if (r.kind === 'offer') {
      expect(r.record.id).toBe('a');
      expect(r.messageCount).toBe(3); // 2 `you` + 1 `aluy` (notas/tools não contam)
      expect(r.ageMs).toBe(5 * 60_000);
    }
  });

  it('cwd DIFERENTE ⇒ none (sessão nova, não oferta a de outro diretório)', () => {
    clock = 100_000;
    store.save({ id: 'a', cwd: '/outro', tier: 't', blocks: [you, aluy] });
    const r = resolveAutoResume(undefined, false, store, '/p', 100_000);
    expect(r).toEqual({ kind: 'none' });
  });

  it('SEM sessão alguma ⇒ none', () => {
    expect(resolveAutoResume(undefined, false, store, '/p', 1)).toEqual({ kind: 'none' });
  });

  it('--new ⇒ explicit (ignora a sessão anterior, começa do zero)', () => {
    clock = 100_000;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    const r = resolveAutoResume(undefined, true, store, '/p', 100_000);
    expect(r).toEqual({ kind: 'explicit' });
  });

  it('pedido EXPLÍCITO (--continue/--resume) ⇒ explicit (não auto-oferta por cima)', () => {
    clock = 100_000;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    expect(resolveAutoResume({ kind: 'continue' }, false, store, '/p', 100_000)).toEqual({
      kind: 'explicit',
    });
    expect(resolveAutoResume({ kind: 'resume', id: 'a' }, false, store, '/p', 100_000)).toEqual({
      kind: 'explicit',
    });
  });

  it('sessão VELHA (fora da janela) ⇒ none (não surpreende com conversa esquecida)', () => {
    clock = 100_000;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    const now = 100_000 + DEFAULT_AUTORESUME_WINDOW_MS + 1;
    expect(resolveAutoResume(undefined, false, store, '/p', now)).toEqual({ kind: 'none' });
  });

  it('sessão VAZIA (0 mensagens) ⇒ none (nada a retomar)', () => {
    clock = 100_000;
    // só uma nota — nenhum `you`/`aluy`: countMessages = 0.
    const note: SessionBlock = { kind: 'note', title: 'x', lines: ['y'] };
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [note] });
    expect(resolveAutoResume(undefined, false, store, '/p', 100_000)).toEqual({ kind: 'none' });
  });

  it('a janela é configurável (sessão dentro de uma janela maior ⇒ offer)', () => {
    clock = 100_000;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you] });
    const now = 100_000 + 2 * DEFAULT_AUTORESUME_WINDOW_MS;
    // janela default ⇒ velha demais (none); janela 3× ⇒ ainda recente (offer).
    expect(resolveAutoResume(undefined, false, store, '/p', now).kind).toBe('none');
    expect(
      resolveAutoResume(undefined, false, store, '/p', now, 3 * DEFAULT_AUTORESUME_WINDOW_MS).kind,
    ).toBe('offer');
  });

  it('countMessages conta só `you`/`aluy` (ignora nota/tool/erro)', () => {
    const note: SessionBlock = { kind: 'note', title: 't', lines: ['l'] };
    expect(countMessages([you, note, aluy, you])).toBe(3);
    expect(countMessages([note])).toBe(0);
    expect(countMessages([])).toBe(0);
  });
});

// ── EST-0972 (BUG 2) — orquestração do boot: oferta aceita/recusada + flags ──────
describe('decideBootResume (EST-0972, BUG 2 — wiring do boot)', () => {
  let base: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-bootresume-'));
    clock = 100_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const yes = async (): Promise<boolean> => true;
  const no = async (): Promise<boolean> => false;
  const boom = async (): Promise<boolean> => {
    throw new Error('prompt explodiu');
  };

  it('sessão recente do cwd + boot SEM flag + ACEITA ⇒ resumed (retoma a conversa)', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    let asked = '';
    const r = await decideBootResume({
      request: undefined,
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: async (p) => {
        asked = p;
        return true;
      },
      now: clock + 60_000,
    });
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.id).toBe('a');
    // o prompt mostrou nº de mensagens + recência (só metadados, nunca o corpo).
    expect(asked).toContain('retomar a conversa anterior');
    expect(asked).toMatch(/2 mensagens/);
  });

  it('sessão recente do cwd + RECUSA ⇒ none (sessão nova, do zero como o usuário quis)', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    const r = await decideBootResume({
      request: undefined,
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: no,
      now: clock + 60_000,
    });
    expect(r).toEqual({ kind: 'none' });
  });

  it('--new ⇒ NUNCA pergunta, vai direto p/ sessão nova (ignora a anterior)', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    let asked = false;
    const r = await decideBootResume({
      request: undefined,
      fresh: true,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: async () => {
        asked = true;
        return true;
      },
      now: clock + 60_000,
    });
    expect(r).toEqual({ kind: 'none' });
    expect(asked).toBe(false); // não houve prompt — `--new` é explícito.
  });

  it('--continue ⇒ retoma SEM perguntar (caminho explícito, não a auto-oferta)', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    let asked = false;
    const r = await decideBootResume({
      request: { kind: 'continue' },
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: async () => {
        asked = true;
        return false;
      },
      now: clock + 60_000,
    });
    expect(r.kind).toBe('resumed');
    expect(asked).toBe(false); // `--continue` resolve direto, sem oferta.
  });

  it('SEM TTY ⇒ NUNCA pergunta (não há prompt possível) ⇒ none (sessão nova)', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    let asked = false;
    const r = await decideBootResume({
      request: undefined,
      fresh: false,
      isTty: false, // pipe/CI
      store,
      cwd: '/p',
      promptYesNo: async () => {
        asked = true;
        return true;
      },
      now: clock + 60_000,
    });
    expect(r).toEqual({ kind: 'none' });
    expect(asked).toBe(false);
  });

  it('cwd diferente ⇒ none (não oferta a conversa de outro diretório)', async () => {
    store.save({ id: 'a', cwd: '/outro', tier: 't', blocks: [you, aluy] });
    const r = await decideBootResume({
      request: undefined,
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: yes,
      now: clock + 60_000,
    });
    expect(r).toEqual({ kind: 'none' });
  });

  it('prompt que LANÇA ⇒ fail-safe none (nunca derruba o boot)', async () => {
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you, aluy] });
    const r = await decideBootResume({
      request: undefined,
      fresh: false,
      isTty: true,
      store,
      cwd: '/p',
      promptYesNo: boom,
      now: clock + 60_000,
    });
    expect(r).toEqual({ kind: 'none' });
  });
});

// ── EST-0972 (BUG Custom) — resolveResumedModel: restaurar tier + slug + legado ──────
describe('resolveResumedModel (EST-0972 — BUG Custom)', () => {
  it('tier CANÔNICO ⇒ devolve só o tier, sem model', () => {
    expect(resolveResumedModel({ tier: 'aluy-flux' })).toEqual({ tier: 'aluy-flux' });
    expect(resolveResumedModel({ tier: 'aluy-deep', model: 'fantasma' })).toEqual({
      tier: 'aluy-deep',
    });
  });

  it('tier:custom COM slug ⇒ restaura tier:custom + model (o slug volta)', () => {
    const r = resolveResumedModel({ tier: 'custom', model: 'openrouter/x' });
    expect(r.tier).toBe('custom');
    expect(r.model).toBe('openrouter/x');
    expect(r.warning).toBeUndefined();
  });

  it('slug com espaços é trimado', () => {
    expect(resolveResumedModel({ tier: 'custom', model: '  foo/bar  ' }).model).toBe('foo/bar');
  });

  it('LEGADO: tier:custom SEM slug ⇒ FALLBACK p/ tier canônico + warning (NUNCA custom-sem-model)', () => {
    const r = resolveResumedModel({ tier: 'custom' });
    expect(r.tier).toBe(RESUME_CUSTOM_FALLBACK_TIER);
    expect(r.tier).not.toBe('custom'); // o ponto central do fix: jamais custom sem model.
    expect(r.model).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });

  it('LEGADO: tier:custom com slug VAZIO ⇒ mesmo fallback (warn-but-safe)', () => {
    const r = resolveResumedModel({ tier: 'custom', model: '   ' });
    expect(r.tier).toBe(RESUME_CUSTOM_FALLBACK_TIER);
    expect(r.model).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });

  it('fallbackTier é injetável (casa com o DEFAULT_TIER do wiring)', () => {
    const r = resolveResumedModel({ tier: 'custom' }, 'aluy-strata');
    expect(r.tier).toBe('aluy-strata');
  });

  it('tier vazio ⇒ devolve tier vazio (o caller decide), sem model', () => {
    expect(resolveResumedModel({ tier: '' })).toEqual({ tier: '' });
  });

  // ── HUNT-PERSIST — o provider Custom acompanha o slug na retomada ─────────────────
  it('tier:custom COM slug+provider ⇒ restaura tier+model+provider juntos', () => {
    const r = resolveResumedModel({
      tier: 'custom',
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
    });
    expect(r).toEqual({ tier: 'custom', model: 'deepseek-v4-pro', provider: 'deepseek' });
  });

  it('provider é trimado e só vale em par com o slug', () => {
    expect(
      resolveResumedModel({ tier: 'custom', model: 'm', provider: '  openrouter  ' }).provider,
    ).toBe('openrouter');
    // slug ausente (legado) ⇒ fallback canônico, provider DESCARTADO (nunca provider órfão).
    const legacy = resolveResumedModel({ tier: 'custom', provider: 'deepseek' });
    expect(legacy.provider).toBeUndefined();
    expect(legacy.tier).toBe(RESUME_CUSTOM_FALLBACK_TIER);
  });

  it('provider vazio ⇒ undefined (broker default), sem chave fantasma', () => {
    const r = resolveResumedModel({ tier: 'custom', model: 'm', provider: '   ' });
    expect(r.provider).toBeUndefined();
    expect('provider' in r).toBe(false);
  });

  it('tier canônico nunca carrega provider (mesmo se vier no record)', () => {
    expect(resolveResumedModel({ tier: 'aluy-flux', provider: 'deepseek' })).toEqual({
      tier: 'aluy-flux',
    });
  });
});

// ── EST-0962 (BUG Custom — PREFERÊNCIA) — resolvePreferredModel: pref custom+slug ─────
describe('resolvePreferredModel (EST-0962 — BUG Custom na pref salva)', () => {
  it('pref VAZIA ⇒ tier vazio (o caller cai na precedência/DEFAULT), sem model nem warning', () => {
    expect(resolvePreferredModel({})).toEqual({ tier: '' });
  });

  it('pref com tier CANÔNICO ⇒ só o tier (slug solto é ignorado)', () => {
    expect(resolvePreferredModel({ tier: 'aluy-deep' })).toEqual({ tier: 'aluy-deep' });
    expect(resolvePreferredModel({ tier: 'aluy-deep', model: 'fantasma' })).toEqual({
      tier: 'aluy-deep',
    });
  });

  it('pref custom COM slug ⇒ { tier:custom, model } (sessão nova reabre no Custom, sem re-input)', () => {
    const r = resolvePreferredModel({ tier: 'custom', model: 'openrouter/x' });
    expect(r.tier).toBe('custom');
    expect(r.model).toBe('openrouter/x');
    expect(r.warning).toBeUndefined();
  });

  it('LEGADO: pref custom SEM slug ⇒ FALLBACK canônico + warning (NUNCA custom-sem-model)', () => {
    const r = resolvePreferredModel({ tier: 'custom' });
    expect(r.tier).toBe(RESUME_CUSTOM_FALLBACK_TIER);
    expect(r.tier).not.toBe('custom');
    expect(r.model).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });

  it('mesma decisão de legado do resume (convergência resume/pref — DoD #5)', () => {
    expect(resolvePreferredModel({ tier: 'custom' })).toEqual(
      resolveResumedModel({ tier: 'custom' }),
    );
  });

  it('fallbackTier injetável casa com o DEFAULT_TIER do wiring', () => {
    expect(resolvePreferredModel({ tier: 'custom' }, 'aluy-strata').tier).toBe('aluy-strata');
  });
});

describe('F187 — conversas SÓ do agente (install/conserto) ficam ocultas do resume', () => {
  const note: SessionBlock = { kind: 'note', title: 'config', lines: ['MCP: 5 server(s)'] };
  const tool: SessionBlock = {
    kind: 'tool',
    verb: 'bash',
    target: 'aluy bootstrap',
    result: '',
    status: 'ok',
  };
  const agentOnly: SessionBlock[] = [note, aluy, tool]; // sem nenhum `you`

  let base: string;
  let store: SessionStore;
  let clock: number;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-f187-'));
    clock = 1_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('boot NÃO oferece uma sessão só do agente (sem turno do usuário)', () => {
    clock = 5_000;
    store.save({ id: 'install', cwd: '/p', tier: 't', blocks: agentOnly });
    const r = resolveAutoResume(undefined, false, store, '/p', 5_100, DEFAULT_AUTORESUME_WINDOW_MS);
    expect(r.kind).toBe('none'); // antes: 'offer' (contava os turnos `aluy`)
  });

  it('boot OFERECE quando há turno do usuário', () => {
    clock = 5_000;
    store.save({ id: 'real', cwd: '/p', tier: 't', blocks: [note, you, aluy] });
    const r = resolveAutoResume(undefined, false, store, '/p', 5_100, DEFAULT_AUTORESUME_WINDOW_MS);
    expect(r.kind).toBe('offer');
  });

  it('--continue pula a sessão só-do-agente e pega a última COM turno do usuário', () => {
    clock = 100;
    store.save({ id: 'user', cwd: '/p', tier: 't', blocks: [you, aluy] });
    clock = 200; // a MAIS recente é só do agente
    store.save({ id: 'install', cwd: '/p', tier: 't', blocks: agentOnly });
    const r = resolveResume({ kind: 'continue' }, store, '/p');
    expect(r.kind).toBe('resumed');
    if (r.kind === 'resumed') expect(r.record.id).toBe('user');
  });

  it('--resume (lista) oculta a sessão só-do-agente, mostra as com usuário/rótulo', () => {
    store.save({ id: 'install', cwd: '/p', tier: 't', blocks: agentOnly });
    store.save({ id: 'user', cwd: '/p', tier: 't', blocks: [you] });
    store.save({ id: 'rotulada', cwd: '/p', tier: 't', blocks: agentOnly, label: 'setup' });
    const r = resolveResume({ kind: 'resume' }, store, '/p');
    expect(r.kind).toBe('pick');
    if (r.kind === 'pick') {
      const ids = r.choices.map((c) => c.id).sort();
      expect(ids).toEqual(['rotulada', 'user']); // 'install' oculta; rotulada mantida
    }
  });

  it('countUserTurns conta só `you` (não `aluy`)', () => {
    expect(countUserTurns([note, aluy, tool])).toBe(0);
    expect(countUserTurns([you, aluy, you])).toBe(2);
  });
});
