// EST-0972 — store de persistência de sessão (`~/.aluy/sessions/<id>.json`).
// Bateria do DoD:
//   - SALVA + relê (save/load round-trip; preserva createdAt, atualiza updatedAt);
//   - LIST ordena por updatedAt desc; latestForCwd casa o cwd;
//   - `--continue` (latestForCwd) escolhe a última do cwd;
//   - `--resume <id>` (load) carrega a certa; id inexistente ⇒ null (nova);
//   - CORROMPIDO ⇒ null SEM crash (fail-safe); id inseguro rejeitado (anti-traversal);
//   - `0600` no arquivo / `0700` no dir; escrita atômica (sem temp órfão);
//   - GC por idade e por teto, com unlink REAL.
//
// Tudo sobre tmpdir (baseDir injetado) — a suíte NUNCA toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import type { SessionBlock } from '../../src/session/model.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const youHi: SessionBlock = { kind: 'you', text: 'olá mundo' };
const aluyHi: SessionBlock = { kind: 'aluy', text: 'oi!', streaming: false };

describe('SessionStore — persistência de sessão (EST-0972)', () => {
  let base: string;
  let aluyDir: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-sess-'));
    aluyDir = join(base, 'home', '.aluy');
    clock = 1_000;
    store = new SessionStore({ baseDir: aluyDir, now: () => clock });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // ── HUNT-FOLLOWUP: título não parte par surrogate (emoji) no corte ──────────
  it('título trunca por code point — emoji no limite NÃO vira surrogate órfão (�)', () => {
    // 56 ASCII + 🎉 (2 unidades UTF-16, índices 56-57): `slice(0,57)` CRU pegaria só a
    // metade ALTA do par ⇒ surrogate órfão no título da lista do --resume. >60 ⇒ trunca.
    const text = 'a'.repeat(56) + '🎉' + 'b'.repeat(10);
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [{ kind: 'you', text }] });
    const title = store.list()[0]?.title ?? '';
    // nenhum char, iterado por CODE POINT, é um surrogate solitário (0xD800–0xDFFF):
    const loneSurrogate = [...title].some((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0xd800 && c <= 0xdfff;
    });
    expect(loneSurrogate).toBe(false);
    expect(title).not.toContain('�');
    // o emoji inteiro sobreviveu no corte (truncou DEPOIS dele, com reticências):
    expect(title.startsWith('a'.repeat(56) + '🎉')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
  });

  // ── save + load round-trip ─────────────────────────────────────────────────
  it('salva e relê a transcrição + metadados', () => {
    expect(store.save({ id: 's1', cwd: '/proj', tier: 'aluy-deep', blocks: [youHi, aluyHi] })).toBe(
      true,
    );
    const rec = store.load('s1');
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('s1');
    expect(rec!.cwd).toBe('/proj');
    expect(rec!.tier).toBe('aluy-deep');
    expect(rec!.blocks).toEqual([youHi, aluyHi]);
    expect(rec!.createdAt).toBe(1_000);
    expect(rec!.updatedAt).toBe(1_000);
  });

  it('HUNT-PERSIST: round-trip de um edit PRESERVA o diffstat (+N/−M) no save→load', () => {
    // Bug observável no --resume/history: um edit_file gravado com `added/removed` voltava
    // SEM o diffstat (sanitizeBlock o descartava) ⇒ ActivityLog/FlowTree pintavam +0/−0.
    const edit: SessionBlock = {
      kind: 'tool',
      verb: 'edit',
      target: 'src/x.ts',
      result: '+12 −3',
      status: 'ok',
      added: 12,
      removed: 3,
    };
    store.save({ id: 'ed', cwd: '/p', tier: 't', blocks: [youHi, edit] });
    const rec = store.load('ed')!;
    const back = rec.blocks.find((b): b is Extract<SessionBlock, { kind: 'tool' }> => {
      return b.kind === 'tool' && b.verb === 'edit';
    });
    expect(back).toBeDefined();
    expect(back!.added).toBe(12);
    expect(back!.removed).toBe(3);
  });

  it('regravar PRESERVA createdAt e ATUALIZA updatedAt', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [youHi] });
    clock = 5_000;
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] });
    const rec = store.load('s1')!;
    expect(rec.createdAt).toBe(1_000);
    expect(rec.updatedAt).toBe(5_000);
    expect(rec.blocks).toHaveLength(2);
  });

  it('id inexistente ⇒ load null (⇒ sessão nova)', () => {
    expect(store.load('naoexiste')).toBeNull();
  });

  // ── list + latestForCwd ─────────────────────────────────────────────────────
  it('list ordena por updatedAt DESC e traz resumo (sem corpo)', () => {
    clock = 100;
    store.save({ id: 'a', cwd: '/x', tier: 't', blocks: [youHi] });
    clock = 300;
    store.save({ id: 'b', cwd: '/x', tier: 't', blocks: [youHi, aluyHi] });
    clock = 200;
    store.save({ id: 'c', cwd: '/y', tier: 't', blocks: [youHi] });
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(list[0]!.blockCount).toBe(2);
    expect(list[0]!.title).toBe('olá mundo');
  });

  it('latestForCwd casa o cwd EXATO e pega a mais recente', () => {
    clock = 100;
    store.save({ id: 'a', cwd: '/proj', tier: 't', blocks: [youHi] });
    clock = 400;
    store.save({ id: 'b', cwd: '/proj', tier: 't', blocks: [youHi] });
    clock = 500;
    store.save({ id: 'c', cwd: '/outro', tier: 't', blocks: [youHi] });
    expect(store.latestForCwd('/proj')!.id).toBe('b');
    expect(store.latestForCwd('/outro')!.id).toBe('c');
    expect(store.latestForCwd('/nada')).toBeNull();
  });

  // ── corrompido / inseguro ⇒ fail-safe ──────────────────────────────────────
  it('JSON inválido no disco ⇒ load null SEM crash', () => {
    mkdirSync(store.sessionsDir, { recursive: true });
    writeFileSync(store.pathFor('bad'), '{ não é json', 'utf8');
    expect(() => store.load('bad')).not.toThrow();
    expect(store.load('bad')).toBeNull();
    // e a list IGNORA a corrompida (não quebra a listagem).
    expect(store.list()).toEqual([]);
  });

  it('registro sem forma (array/sem blocks) ⇒ null', () => {
    mkdirSync(store.sessionsDir, { recursive: true });
    writeFileSync(store.pathFor('x'), JSON.stringify([1, 2, 3]), 'utf8');
    expect(store.load('x')).toBeNull();
    writeFileSync(store.pathFor('y'), JSON.stringify({ id: 'y', cwd: '/p' }), 'utf8'); // sem blocks
    expect(store.load('y')).toBeNull();
  });

  it('id inseguro (path traversal) é REJEITADO no save e no load', () => {
    expect(store.save({ id: '../escape', cwd: '/p', tier: 't', blocks: [youHi] })).toBe(false);
    expect(store.load('../../etc/passwd')).toBeNull();
    expect(store.load('a/b')).toBeNull();
  });

  it('blocos inválidos no disco são DESCARTADOS na leitura (saneamento)', () => {
    mkdirSync(store.sessionsDir, { recursive: true });
    const rec = {
      id: 'z',
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: '/p',
      tier: 't',
      blocks: [youHi, { kind: 'desconhecido', foo: 1 }, { kind: 'you' /* sem text */ }],
    };
    writeFileSync(store.pathFor('z'), JSON.stringify(rec), 'utf8');
    expect(store.load('z')!.blocks).toEqual([youHi]);
  });

  // ── permissões + atomicidade ────────────────────────────────────────────────
  it('arquivo nasce 0600 e o dir sessions/ 0700 (sem janela 0644)', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [youHi] });
    expect(mode(store.pathFor('s1'))).toBe(0o600);
    expect(mode(store.sessionsDir)).toBe(0o700);
    // o ~/.aluy também nasce 0700.
    expect(mode(aluyDir)).toBe(0o700);
  });

  it('reescrita atômica mantém 0600 e NÃO deixa temp órfão', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [youHi] });
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] });
    expect(mode(store.pathFor('s1'))).toBe(0o600);
    const leftovers = readdirSync(store.sessionsDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  // ── GC ──────────────────────────────────────────────────────────────────────
  it('GC por IDADE remove as mais velhas que maxAgeMs (unlink real)', () => {
    clock = 1_000;
    store.save({ id: 'velha', cwd: '/p', tier: 't', blocks: [youHi] });
    clock = 100_000;
    store.save({ id: 'nova', cwd: '/p', tier: 't', blocks: [youHi] });
    // agora=100_000; maxAge=50_000 ⇒ cutoff=50_000 ⇒ 'velha' (1_000) sai, 'nova' fica.
    store.gc({ maxAgeMs: 50_000 });
    expect(store.load('velha')).toBeNull();
    expect(store.load('nova')).not.toBeNull();
    expect(existsSync(store.pathFor('velha'))).toBe(false);
  });

  it('GC por TETO mantém só as N mais recentes', () => {
    for (let i = 0; i < 5; i++) {
      clock = 1_000 + i;
      store.save({ id: `s${i}`, cwd: '/p', tier: 't', blocks: [youHi] });
    }
    store.gc({ maxCount: 2, maxAgeMs: Number.MAX_SAFE_INTEGER });
    const remaining = store.list().map((s) => s.id);
    expect(remaining).toEqual(['s4', 's3']); // as 2 mais recentes.
  });

  it('remove() é idempotente e faz unlink real', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [youHi] });
    store.remove('s1');
    expect(store.load('s1')).toBeNull();
    expect(() => store.remove('s1')).not.toThrow(); // 2ª vez: idempotente.
  });

  it('não persiste transcrição com array de blocos vazio? (save aceita; o caller é quem evita)', () => {
    // o STORE aceita salvar vazio (decisão de "não salvar vazio" é do autoSaveSession);
    // aqui só garantimos round-trip de 0 blocos sem crash.
    expect(store.save({ id: 'e', cwd: '/p', tier: 't', blocks: [] })).toBe(true);
    expect(store.load('e')!.blocks).toEqual([]);
  });

  // ── bug-hunt #5: colisão de temp atômico (sufixo aleatório) ────────────────
  it('escrita concorrente do mesmo arquivo NÃO colide (cada save usa temp distinto)', () => {
    // Simula duas escritas "simultâneas" do mesmo processo no mesmo arquivo:
    // chama save duas vezes seguidas. Antes do fix (só pid), a 2ª batia no O_EXCL
    // do temp ainda existente da 1ª (EEXIST). Com sufixo aleatório, cada temp é único.
    const id = 'collide';
    expect(store.save({ id, cwd: '/p', tier: 't', blocks: [youHi] })).toBe(true);
    expect(store.save({ id, cwd: '/p', tier: 't', blocks: [youHi, aluyHi] })).toBe(true);
    // O arquivo final deve ter o conteúdo da última escrita (renome atômico).
    const rec = store.load(id)!;
    expect(rec.blocks).toHaveLength(2);
    expect(rec.blocks).toEqual([youHi, aluyHi]);
    // Nenhum temp sobrou.
    const leftovers = readdirSync(store.sessionsDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('três saves rápidos consecutivos funcionam SEM EEXIST', () => {
    const id = 'fast';
    for (let i = 0; i < 3; i++) {
      clock = 1_000 + i;
      expect(
        store.save({
          id,
          cwd: '/p',
          tier: 't',
          blocks: [youHi, { kind: 'aluy', text: `v${i}`, streaming: false }],
        }),
      ).toBe(true);
    }
    const rec = store.load(id)!;
    expect(rec.blocks).toHaveLength(2);
    expect((rec.blocks[1] as SessionBlock).text).toBe('v2');
    const leftovers = readdirSync(store.sessionsDir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  // ── EST-0972 (BUG Custom) — persistência do slug Custom (model?) ──────────────
  describe('slug Custom (model?) — só sob tier:custom; HG-2 = chave de catálogo', () => {
    it('tier:custom COM slug ⇒ grava model:<slug> e o restaura no load', () => {
      expect(
        store.save({
          id: 'cm',
          cwd: '/p',
          tier: 'custom',
          model: 'openrouter/some-model',
          blocks: [youHi],
        }),
      ).toBe(true);
      const rec = store.load('cm')!;
      expect(rec.tier).toBe('custom');
      expect(rec.model).toBe('openrouter/some-model');
    });

    it('tier CANÔNICO ⇒ NÃO grava model mesmo se passado (não vaza Custom fora de Custom)', () => {
      store.save({ id: 'cn', cwd: '/p', tier: 'aluy-flux', model: 'algum/slug', blocks: [youHi] });
      const rec = store.load('cn')!;
      expect(rec.tier).toBe('aluy-flux');
      expect(rec.model).toBeUndefined();
      // e o campo não está sequer no JSON gravado.
      const raw = JSON.parse(readFileSync(store.pathFor('cn'), 'utf8'));
      expect('model' in raw).toBe(false);
    });

    it('tier:custom SEM slug ⇒ NÃO grava model (campo ausente)', () => {
      store.save({ id: 'cs', cwd: '/p', tier: 'custom', blocks: [youHi] });
      const raw = JSON.parse(readFileSync(store.pathFor('cs'), 'utf8'));
      expect('model' in raw).toBe(false);
      expect(store.load('cs')!.model).toBeUndefined();
    });

    it('slug em branco ⇒ tratado como ausente (não grava)', () => {
      store.save({ id: 'cb', cwd: '/p', tier: 'custom', model: '   ', blocks: [youHi] });
      expect(store.load('cb')!.model).toBeUndefined();
    });

    it('record LEGADO (tier:custom SEM model no disco) ⇒ load com model undefined, sem crash', () => {
      mkdirSync(store.sessionsDir, { recursive: true });
      // simula um arquivo salvo ANTES do fix: tier custom, sem campo model.
      const legacy = {
        id: 'leg',
        version: 1,
        createdAt: 1,
        updatedAt: 2,
        cwd: '/p',
        tier: 'custom',
        blocks: [youHi],
      };
      writeFileSync(store.pathFor('leg'), JSON.stringify(legacy), 'utf8');
      const rec = store.load('leg')!;
      expect(rec.tier).toBe('custom');
      expect(rec.model).toBeUndefined(); // sem slug fantasma — o restore (run.tsx) faz fallback.
    });

    it('model do disco em tier CANÔNICO é DESCARTADO no load (defesa)', () => {
      mkdirSync(store.sessionsDir, { recursive: true });
      const tampered = {
        id: 'tmp',
        version: 1,
        createdAt: 1,
        updatedAt: 2,
        cwd: '/p',
        tier: 'aluy-deep',
        model: 'slug-fantasma',
        blocks: [youHi],
      };
      writeFileSync(store.pathFor('tmp'), JSON.stringify(tampered), 'utf8');
      expect(store.load('tmp')!.model).toBeUndefined();
    });

    it('list() inclui o model Custom no resumo (e não fora de Custom)', () => {
      clock = 200;
      store.save({ id: 'lc', cwd: '/x', tier: 'custom', model: 'foo/bar', blocks: [youHi] });
      clock = 100;
      store.save({ id: 'ln', cwd: '/x', tier: 'aluy-flux', blocks: [youHi] });
      const list = store.list();
      const byId = Object.fromEntries(list.map((s) => [s.id, s]));
      expect(byId['lc']!.model).toBe('foo/bar');
      expect(byId['ln']!.model).toBeUndefined();
    });

    it('regravar Custom→canônico LIMPA o model persistido (não fica slug velho)', () => {
      store.save({ id: 'rw', cwd: '/p', tier: 'custom', model: 'antigo/slug', blocks: [youHi] });
      expect(store.load('rw')!.model).toBe('antigo/slug');
      // troca p/ canônico (o caller manda tier sem model OU model undefined): o save
      // sob canônico não grava model ⇒ o slug velho some do record.
      store.save({ id: 'rw', cwd: '/p', tier: 'aluy-flux', blocks: [youHi, aluyHi] });
      expect(store.load('rw')!.model).toBeUndefined();
    });
  });

  // ── HUNT-PERSIST (round-trip incompleto — provider Custom sumia no resume) ──────────
  // Mesma classe do BUG Custom do `model`: o auto-save persistia tier+slug mas NÃO o
  // provider (`/provider`, ADR-0076 multi-vendor). Retomar uma sessão Custom com provider
  // específico perdia o provider ⇒ caía no DEFAULT do slug (provider errado / 422 quando o
  // mesmo slug existe em vários providers). Provider é gravado SÓ em par com o slug Custom.
  describe('HUNT-PERSIST — provider Custom (só em par com o slug sob tier:custom)', () => {
    it('tier:custom COM slug+provider ⇒ grava provider e o restaura no load', () => {
      store.save({
        id: 'pv',
        cwd: '/p',
        tier: 'custom',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
        blocks: [youHi],
      });
      const rec = store.load('pv')!;
      expect(rec.model).toBe('deepseek-v4-pro');
      expect(rec.provider).toBe('deepseek');
    });

    it('provider SEM slug ⇒ NÃO grava (provider sem modelo não é reaplicável)', () => {
      store.save({ id: 'ps', cwd: '/p', tier: 'custom', provider: 'deepseek', blocks: [youHi] });
      const raw = JSON.parse(readFileSync(store.pathFor('ps'), 'utf8'));
      expect('provider' in raw).toBe(false);
      expect(store.load('ps')!.provider).toBeUndefined();
    });

    it('provider fora de Custom ⇒ NÃO grava (não vaza provider fantasma)', () => {
      store.save({
        id: 'pc',
        cwd: '/p',
        tier: 'aluy-flux',
        model: 'x',
        provider: 'deepseek',
        blocks: [youHi],
      });
      const raw = JSON.parse(readFileSync(store.pathFor('pc'), 'utf8'));
      expect('provider' in raw).toBe(false);
    });

    it('provider do disco SEM slug é DESCARTADO no load (defesa anti-adulteração)', () => {
      mkdirSync(store.sessionsDir, { recursive: true });
      const tampered = {
        id: 'pt',
        version: 1,
        createdAt: 1,
        updatedAt: 2,
        cwd: '/p',
        tier: 'custom',
        provider: 'deepseek', // sem model — não deve restaurar provider órfão.
        blocks: [youHi],
      };
      writeFileSync(store.pathFor('pt'), JSON.stringify(tampered), 'utf8');
      const rec = store.load('pt')!;
      expect(rec.model).toBeUndefined();
      expect(rec.provider).toBeUndefined();
    });

    it('list() inclui o provider no resumo (e não sem slug)', () => {
      store.save({
        id: 'pl',
        cwd: '/x',
        tier: 'custom',
        model: 'm',
        provider: 'openrouter',
        blocks: [youHi],
      });
      const s = store.list().find((x) => x.id === 'pl')!;
      expect(s.provider).toBe('openrouter');
    });

    it('regravar trocando o provider atualiza o persistido (round-trip do valor novo)', () => {
      store.save({
        id: 'pr',
        cwd: '/p',
        tier: 'custom',
        model: 'm',
        provider: 'a',
        blocks: [youHi],
      });
      expect(store.load('pr')!.provider).toBe('a');
      store.save({
        id: 'pr',
        cwd: '/p',
        tier: 'custom',
        model: 'm',
        provider: 'b',
        blocks: [youHi],
      });
      expect(store.load('pr')!.provider).toBe('b');
    });
  });
});

// ── HUNT-PERF: `save` não relê+parseia o record inteiro a cada chamada ───────────
//
// O auto-save dispara a cada state-change durante o stream (cada token/keystroke). O
// `save` PRECISA preservar o `createdAt` da 1ª gravação. Antes, relia o record INTEIRO
// (load: statSync + readFileSync + JSON.parse + sanitizeBlocks de TODOS os blocos) a
// CADA save — O(tamanho-do-record) por token, custo que cresce sem teto. Estes testes
// provam: N saves ⇒ ≤1 read do disco (não N) E o `createdAt` original é preservado igual.
describe('SessionStore — auto-save não relê o record a cada save (HUNT-PERF)', () => {
  let base: string;
  let aluyDir: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-sess-perf-'));
    aluyDir = join(base, 'home', '.aluy');
    clock = 1_000;
    store = new SessionStore({ baseDir: aluyDir, now: () => clock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  // N saves do MESMO id ⇒ no MÁXIMO 1 `load` (o do 1º save, cache-miss). Antes do fix
  // cada save chamava `load` ⇒ N reads (falha-sem/passa-com).
  it('N saves do mesmo id ⇒ ≤1 load (não N) — o createdAt vem do cache', () => {
    const loadSpy = vi.spyOn(store, 'load');
    for (let i = 0; i < 10; i++) {
      clock = 1_000 + i; // updatedAt avança a cada save
      expect(store.save({ id: 'big', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] })).toBe(true);
    }
    // 10 saves ⇒ no máximo 1 read do record (o 1º, cache-miss). NUNCA 10.
    expect(loadSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // Idem com MUITOS saves (escala): o nº de reads NÃO cresce com N (era O(N) antes).
  // `load` é o ÚNICO caminho que faz statSync+readFileSync+JSON.parse+sanitizeBlocks do
  // record inteiro — contar `load` é contar os reads de disco O(record).
  it('o nº de reads NÃO escala com N saves (≤1 read p/ 50 saves)', () => {
    const loadSpy = vi.spyOn(store, 'load');
    for (let i = 0; i < 50; i++) {
      clock = 3_000 + i;
      store.save({ id: 'scale', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] });
    }
    expect(loadSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // O createdAt da 1ª gravação é preservado IGUAL através de muitos saves (comportamento
  // observável idêntico — só o custo mudou).
  it('createdAt do 1º save é preservado igual em todos os saves seguintes', () => {
    clock = 5_000;
    store.save({ id: 'c', cwd: '/p', tier: 't', blocks: [youHi] });
    const created = store.load('c')!.createdAt;
    expect(created).toBe(5_000);
    for (let i = 1; i <= 20; i++) {
      clock = 5_000 + i;
      store.save({ id: 'c', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] });
    }
    const rec = store.load('c')!;
    expect(rec.createdAt).toBe(5_000); // intocado
    expect(rec.updatedAt).toBe(5_020); // avançou
  });

  // Sessão RETOMADA via load (--resume/--continue): o load SEMEIA o cache ⇒ o 1º save
  // pós-resume NÃO relê o disco, e o createdAt do disco (não `now`) é preservado.
  it('resume (load) semeia o cache — o 1º save pós-resume não relê e preserva o createdAt', () => {
    clock = 100;
    store.save({ id: 'r', cwd: '/p', tier: 't', blocks: [youHi] });
    // Nova instância = processo "reiniciado" do ponto de vista do cache: load do resume.
    const store2 = new SessionStore({ baseDir: aluyDir, now: () => clock });
    const loaded = store2.load('r')!; // --resume
    expect(loaded.createdAt).toBe(100);
    const loadSpy = vi.spyOn(store2, 'load');
    for (let i = 0; i < 5; i++) {
      clock = 200 + i;
      store2.save({ id: 'r', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] });
    }
    expect(loadSpy.mock.calls.length).toBe(0); // cache já semeado pelo load ⇒ zero reads
    const rec = store2.load('r')!;
    expect(rec.createdAt).toBe(100); // do disco, não `now`
  });

  // Processo REINICIADO sem resume (cache vazio, arquivo no disco): o 1º save faz 1 read
  // p/ herdar o createdAt do disco; os seguintes não releem.
  it('processo reiniciado (cache vazio) ⇒ 1 read no 1º save, 0 nos seguintes; createdAt herdado', () => {
    clock = 700;
    store.save({ id: 'p2', cwd: '/p', tier: 't', blocks: [youHi] });
    const store2 = new SessionStore({ baseDir: aluyDir, now: () => clock });
    const loadSpy = vi.spyOn(store2, 'load');
    clock = 900;
    store2.save({ id: 'p2', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] }); // cache-miss ⇒ 1 read
    clock = 901;
    store2.save({ id: 'p2', cwd: '/p', tier: 't', blocks: [youHi, aluyHi] }); // cache-hit ⇒ 0 read
    expect(loadSpy.mock.calls.length).toBe(1);
    expect(store2.load('p2')!.createdAt).toBe(700); // herdou o do disco, não `now`(900)
  });

  // remove esquece o createdAt cacheado: recriar o mesmo id nasce com `now` (sessão nova).
  it('remove limpa o cache — recriar o mesmo id nasce com createdAt novo (não herda o removido)', () => {
    clock = 10;
    store.save({ id: 'x', cwd: '/p', tier: 't', blocks: [youHi] });
    expect(store.load('x')!.createdAt).toBe(10);
    store.remove('x');
    clock = 99;
    store.save({ id: 'x', cwd: '/p', tier: 't', blocks: [youHi] });
    expect(store.load('x')!.createdAt).toBe(99); // novo, não herdou o 10
  });
});
