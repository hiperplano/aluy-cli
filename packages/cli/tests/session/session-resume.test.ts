// EST-0972 — INTEGRAÇÃO da persistência/retomada de sessão através do `runSession`
// (caminho NÃO-TTY, sem Ink). Cobre o DoD:
//   - SALVA ao longo da sessão (após um turno, há um arquivo em ~/.aluy/sessions/);
//   - `--continue` retoma a ÚLTIMA sessão do cwd (e SEMEIA o contexto: a conversa
//     anterior volta nas mensagens enviadas ao broker no turno seguinte);
//   - `--resume <id>` carrega a sessão CERTA;
//   - ausente ⇒ sessão NOVA (id diferente, sem seed);
//   - corrompido ⇒ NOVA sem crash;
//   - `0600`/`0700` do arquivo/dir persistidos.
//
// Sem rede real: broker stub captura as mensagens e emite um turno final mínimo.
// Credential store em memória; workspace e ~/.aluy em tmpdir — NUNCA toca o real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  BrokerModelClient,
  ChatMessage,
  CredentialStore,
  StoredCredential,
} from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/session-store.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import { UserAgentsLoader } from '../../src/io/index.js';

class MemoryStore implements CredentialStore {
  cred: StoredCredential | null = null;
  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(c: StoredCredential): Promise<void> {
    this.cred = c;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}

const stubCatalog = { list: async () => [] };

/** O request capturado de uma chamada ao broker (tier/model além das mensagens). */
type CapturedRequest = { tier?: string; model?: string; messages: ChatMessage[] };

/** Broker stub: captura as mensagens de CADA chamada; emite um turno final mínimo. */
function capturingBroker(): {
  client: BrokerModelClient;
  calls: ChatMessage[][];
  requests: CapturedRequest[];
} {
  const calls: ChatMessage[][] = [];
  const requests: CapturedRequest[] = [];
  const client: BrokerModelClient = {
    async *stream(args: {
      request: { tier?: string; model?: string; messages: readonly ChatMessage[] };
    }) {
      calls.push([...args.request.messages]);
      requests.push({
        ...(args.request.tier !== undefined ? { tier: args.request.tier } : {}),
        ...(args.request.model !== undefined ? { model: args.request.model } : {}),
        messages: [...args.request.messages],
      });
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: 'feito.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, calls, requests };
}

function nonTtyStdout(): NodeJS.WriteStream & { text: () => string } {
  const pt = new PassThrough();
  let buf = '';
  pt.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  const s = pt as unknown as NodeJS.WriteStream & { text: () => string };
  s.text = () => buf;
  return s;
}

// EST-0972 (flake crônico de CI #131) — com o boot agora HERMÉTICO (`mcpTools: []` +
// loader de agentes no tmpdir, ver `hermetic()` abaixo), `runSession` não lança mais
// os servers MCP reais (que custavam ~2s CADA). Cada caso roda em ~ms ISOLADO.
// F66 — o teto de 10s ainda flakava na SUÍTE CHEIA: este worker é IN-PROCESS e
// rápido, mas os outros suites que spawnam o BINÁRIO real sobre-inscrevem a CPU e
// STARVAM este worker — ms de trabalho viram >10s de wall-clock, e o teste caía
// VERMELHO sem regressão alguma (a dor da F66). Lição: wall-clock por-teste mede
// CONTENÇÃO da máquina junto com o trabalho do teste — é guarda GROSSO de
// hang/runaway, NÃO um gate FINO de perf de boot (esse intento já era ilusório,
// pois flakava). 25s absorve a contenção sem mascarar um runaway de verdade. Se um
// dia se quiser DE FATO um gate de perf de boot, meça a duração IN-PROCESS explícita
// (excluindo a contenção), não o wall-clock do teste.
const RESUME_TIMEOUT_MS = 25_000;

describe(
  'runSession — persistência/retomada de sessão (EST-0972, não-TTY)',
  { timeout: RESUME_TIMEOUT_MS },
  () => {
    let base: string;
    let aluyDir: string;
    let workspaceRoot: string;

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'aluy-sess-int-'));
      aluyDir = join(base, 'home', '.aluy');
      workspaceRoot = join(base, 'project');
      mkdirSync(workspaceRoot, { recursive: true });
    });

    afterEach(() => rmSync(base, { recursive: true, force: true }));

    // EST-0972 (flake crônico de CI #131) — HERMETICIDADE do boot do `runSession`.
    // CAUSA-RAIZ do flake: o boot NÃO injetava a config GLOBAL de MCP/agentes, então
    // `setupMcp` lia o `~/.aluy/mcp.json` REAL da máquina (dev/runner) e LANÇAVA os
    // servers MCP de verdade (`npx -y …`, ~2s de handshake CADA, por chamada de
    // `runSession`). Um teste que roda 2–3 `runSession` ⇒ 4–8s; sob a instrumentação
    // de cobertura v8 (~3×) + a contenção do runner self-hosted ⇒ estourava os 20s.
    // Nada de mascarar: passamos `mcpTools: []` (curto-circuita o spawn de servers —
    // o que estes testes cobrem é persist/resume, NÃO MCP) e apontamos o loader de
    // agentes GLOBAIS p/ o tmpdir (não lê `~/.aluy/agents` real). Boot vira ~ms; as
    // asserções de persist/resume seguem INTACTAS. Honra o "NUNCA toca o real" do topo.
    const hermetic = (): {
      mcpTools: [];
      userAgentsLoader: UserAgentsLoader;
    } => ({
      mcpTools: [],
      userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
    });

    /** Roda um turno e devolve o store + broker usados. */
    async function runTurn(opts: {
      goal: string;
      resume?: { kind: 'continue' } | { kind: 'resume'; id?: string };
      tier?: string;
      model?: string;
      store?: SessionStore;
    }): Promise<{
      store: SessionStore;
      calls: ChatMessage[][];
      requests: CapturedRequest[];
      out: ReturnType<typeof nonTtyStdout>;
    }> {
      const store = opts.store ?? new SessionStore({ baseDir: aluyDir });
      const { client, calls, requests } = capturingBroker();
      const out = nonTtyStdout();
      await runSession({
        goal: opts.goal,
        stdout: out,
        env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
        store: new MemoryStore(),
        brokerClient: client,
        catalogClient: stubCatalog as never,
        workspaceRoot,
        sessionStore: store,
        // HERMÉTICO — config no tmpdir (não lê o `~/.aluy/config.json` REAL do dev, cujo
        // `tier` pode estar em `custom` e contaminar a precedência destes testes).
        configStore: new UserConfigStore({ baseDir: aluyDir }),
        // HERMÉTICO — memória GLOBAL no tmpdir (não lê o `~/.aluy/memory/` REAL): sem isto,
        // o `recall()` semeia memórias reais do dev/máquina e contamina os testes de seed
        // (ex.: `--continue` sem sessão prévia esperaria 0 seed mas pegaria a memória real).
        memoryBaseDir: aluyDir,
        ...hermetic(),
        ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.resume ? { resume: opts.resume } : {}),
      });
      return { store, calls, requests, out };
    }

    // ── SALVA ao longo da sessão ────────────────────────────────────────────────
    it('após um turno, a transcrição é PERSISTIDA em ~/.aluy/sessions/', async () => {
      const { store } = await runTurn({ goal: 'crie um plano' });
      const list = store.list();
      expect(list).toHaveLength(1);
      const rec = store.load(list[0]!.id)!;
      // a transcrição tem o turno do usuário e a fala do modelo.
      expect(rec.blocks.some((b) => b.kind === 'you' && b.text === 'crie um plano')).toBe(true);
      expect(rec.blocks.some((b) => b.kind === 'aluy')).toBe(true);
      expect(rec.cwd).toBe(store.list()[0]!.cwd); // cwd absoluto do workspace.
    });

    it('o arquivo persistido nasce 0600 e o dir 0700', async () => {
      const { store } = await runTurn({ goal: 'oi' });
      const id = store.list()[0]!.id;
      expect(statSync(store.pathFor(id)).mode & 0o777).toBe(0o600);
      expect(statSync(store.sessionsDir).mode & 0o777).toBe(0o700);
    });

    // ── --continue retoma a última do cwd + SEMEIA contexto ─────────────────────
    // Roda DOIS `runSession` em sequência; com o boot hermético (sem spawn de MCP) são
    // ~ms. O teto da suíte (RESUME_TIMEOUT_MS, 10s) governa — sem override inflado.
    it('`--continue` retoma a ÚLTIMA sessão do cwd e SEMEIA a conversa anterior', async () => {
      // 1º turno: cria a sessão.
      const first = await runTurn({ goal: 'objetivo inicial' });
      const id = first.store.list()[0]!.id;

      // 2º turno com --continue: deve reusar o MESMO id e mandar a conversa anterior.
      const second = await runTurn({ goal: 'segundo objetivo', resume: { kind: 'continue' } });
      // mesmo arquivo de sessão (continuidade): ainda 1 só.
      expect(second.store.list()).toHaveLength(1);
      expect(second.store.list()[0]!.id).toBe(id);

      // o contexto da chamada ao broker no 2º turno carrega o objetivo ANTERIOR
      // (semente reconstruída) ANTES do novo objetivo.
      const msgs = second.calls[0]!;
      const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.content);
      expect(userTexts.some((t) => t.includes('objetivo inicial'))).toBe(true);
      expect(userTexts.some((t) => t.includes('segundo objetivo'))).toBe(true);

      // e a transcrição acumulada tem AMBOS os objetivos.
      const rec = second.store.load(id)!;
      const yous = rec.blocks
        .filter((b) => b.kind === 'you')
        .map((b) => (b as { text: string }).text);
      expect(yous).toContain('objetivo inicial');
      expect(yous).toContain('segundo objetivo');
    });

    // ── --resume <id> carrega a certa ────────────────────────────────────────────
    // TRÊS `runSession` (A, B, retoma A) — o mais pesado do arquivo; com o boot
    // hermético ainda é ~ms, bem abaixo do teto da suíte (10s).
    it('`--resume <id>` carrega a sessão CERTA (e não outra)', async () => {
      const a = await runTurn({ goal: 'sessao A' });
      const idA = a.store.list()[0]!.id;
      // segunda sessão NOVA (sem resume) — outro id.
      const b = await runTurn({ goal: 'sessao B' });
      const idB = b.store.list().find((s) => s.id !== idA)!.id;
      expect(idB).not.toBe(idA);

      // retoma A explicitamente: o contexto traz "sessao A", não "sessao B".
      const resumed = await runTurn({ goal: 'continua A', resume: { kind: 'resume', id: idA } });
      const userTexts = resumed.calls[0]!.filter((m) => m.role === 'user').map((m) => m.content);
      expect(userTexts.some((t) => t.includes('sessao A'))).toBe(true);
      expect(userTexts.some((t) => t.includes('sessao B'))).toBe(false);
    });

    // ── ausente ⇒ nova ───────────────────────────────────────────────────────────
    it('`--continue` SEM sessão prévia ⇒ sessão NOVA (sem seed, sem crash)', async () => {
      const { calls, store } = await runTurn({ goal: 'novo', resume: { kind: 'continue' } });
      // criou uma sessão nova (1 arquivo) e o contexto só tem o objetivo atual.
      expect(store.list()).toHaveLength(1);
      const userTexts = calls[0]!.filter((m) => m.role === 'user').map((m) => m.content);
      expect(userTexts.some((t) => t.includes('novo'))).toBe(true);
      expect(userTexts).toHaveLength(1); // sem semente de conversa anterior.
    });

    it('`--resume <id>` inexistente ⇒ sessão NOVA, sem crash', async () => {
      const { store } = await runTurn({ goal: 'x', resume: { kind: 'resume', id: 'nao-existe' } });
      expect(store.list()).toHaveLength(1); // nova, não a fantasma.
    });

    // ── corrompido ⇒ nova sem crash ──────────────────────────────────────────────
    it('sessão CORROMPIDA no disco ⇒ `--continue` começa NOVA sem crash', async () => {
      // planta um arquivo corrompido com um id qualquer.
      const sessionsDir = join(aluyDir, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'corrompida.json'), '{ lixo não-json', 'utf8');

      const out = nonTtyStdout();
      const store = new SessionStore({ baseDir: aluyDir });
      const { client } = capturingBroker();
      await expect(
        runSession({
          goal: 'apesar do lixo',
          stdout: out,
          env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
          store: new MemoryStore(),
          brokerClient: client,
          catalogClient: stubCatalog as never,
          workspaceRoot,
          sessionStore: store,
          ...hermetic(),
          resume: { kind: 'continue' },
        }),
      ).resolves.toBeUndefined();
      // a corrompida foi ignorada; uma sessão nova válida foi criada.
      const valid = store.list();
      expect(valid.length).toBeGreaterThanOrEqual(1);
      expect(valid.every((s) => s.id !== 'corrompida')).toBe(true);
    });

    // ── --resume sem id LISTA ─────────────────────────────────────────────────────
    it('`--resume` SEM id LISTA as sessões salvas (e não roda turno)', async () => {
      await runTurn({ goal: 'primeira' });
      const out = nonTtyStdout();
      const store = new SessionStore({ baseDir: aluyDir });
      const { client, calls } = capturingBroker();
      await runSession({
        stdout: out,
        env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
        store: new MemoryStore(),
        brokerClient: client,
        catalogClient: stubCatalog as never,
        workspaceRoot,
        sessionStore: store,
        ...hermetic(),
        resume: { kind: 'resume' }, // sem id ⇒ lista.
      });
      // listou (texto com instrução de retomar) e NÃO chamou o broker (não rodou turno).
      expect(out.text()).toMatch(/--resume <id>/);
      expect(calls).toHaveLength(0);
    });

    // ── EST-0972 — `/history` LINEAR (não-TTY): lista + retoma por id ─────────────
    it('`/history` (sem id) LISTA as sessões e NÃO chama o broker', async () => {
      await runTurn({ goal: 'sessao listável' });
      const out = nonTtyStdout();
      const store = new SessionStore({ baseDir: aluyDir });
      const { client, calls } = capturingBroker();
      await runSession({
        goal: '/history',
        stdout: out,
        env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
        store: new MemoryStore(),
        brokerClient: client,
        catalogClient: stubCatalog as never,
        workspaceRoot,
        sessionStore: store,
        ...hermetic(),
      });
      // listou (prefixo [history] + dica de retomar por id) e não rodou turno.
      expect(out.text()).toMatch(/\[history\]/);
      expect(out.text()).toMatch(/history <id>/);
      expect(calls).toHaveLength(0);
    });

    it('`/history` SEM sessão alguma ⇒ "nenhuma sessão anterior."', async () => {
      const out = nonTtyStdout();
      const store = new SessionStore({ baseDir: aluyDir });
      const { client, calls } = capturingBroker();
      await runSession({
        goal: '/history',
        stdout: out,
        env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
        store: new MemoryStore(),
        brokerClient: client,
        catalogClient: stubCatalog as never,
        workspaceRoot,
        sessionStore: store,
        ...hermetic(),
      });
      expect(out.text()).toMatch(/nenhuma sessão anterior/);
      expect(calls).toHaveLength(0);
    });

    it('`/history <id>` RETOMA aquela sessão (troca o alvo do auto-save, não cria nova)', async () => {
      // cria uma sessão A com conteúdo.
      const a = await runTurn({ goal: 'objetivo de A' });
      const idA = a.store.list()[0]!.id;

      // `/history <idA>` num novo runSession: retoma A — NÃO cria uma sessão nova, e a
      // transcrição de A permanece (o auto-save consolidou no arquivo dela).
      const out = nonTtyStdout();
      const store = new SessionStore({ baseDir: aluyDir });
      const { client, calls } = capturingBroker();
      await runSession({
        goal: `/history ${idA}`,
        stdout: out,
        env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
        store: new MemoryStore(),
        brokerClient: client,
        catalogClient: stubCatalog as never,
        workspaceRoot,
        sessionStore: store,
        ...hermetic(),
      });
      // confirmou a retomada e NÃO rodou turno (o id não é objetivo p/ o agente).
      expect(out.text()).toMatch(/retomada/);
      expect(calls).toHaveLength(0);
      // não criou uma sessão nova: ainda só A (o auto-save gravou no arquivo de A).
      const ids = store.list().map((s) => s.id);
      expect(ids).toEqual([idA]);
      // a transcrição de A segue intacta (objetivo de A preservado).
      const rec = store.load(idA)!;
      expect(rec.blocks.some((b) => b.kind === 'you' && b.text === 'objetivo de A')).toBe(true);
    });

    it('`/history <id>` inexistente ⇒ avisa, NÃO cria sessão fantasma', async () => {
      const out = nonTtyStdout();
      const store = new SessionStore({ baseDir: aluyDir });
      const { client, calls } = capturingBroker();
      await runSession({
        goal: '/history nao-existe',
        stdout: out,
        env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
        store: new MemoryStore(),
        brokerClient: client,
        catalogClient: stubCatalog as never,
        workspaceRoot,
        sessionStore: store,
        ...hermetic(),
      });
      expect(out.text()).toMatch(/não encontrada/);
      expect(calls).toHaveLength(0);
      // nada foi gravado (transcrição corrente vazia ⇒ auto-save não persiste).
      expect(store.list()).toHaveLength(0);
    });

    // ── EST-0972 (BUG Custom) — o slug Custom PERSISTE e VOLTA no resume (sem 422) ────
    describe('via Custom: slug persiste e é restaurado no resume (#74/#86)', () => {
      const SLUG = 'openrouter/algum-modelo-custom';

      it('sessão Custom ⇒ persiste tier:custom + model:<slug>', async () => {
        const r = await runTurn({ goal: 'objetivo custom', tier: 'custom', model: SLUG });
        const rec = r.store.load(r.store.list()[0]!.id)!;
        expect(rec.tier).toBe('custom');
        expect(rec.model).toBe(SLUG);
        // a 1ª chamada JÁ levou o model (não manda custom-sem-model).
        expect(r.requests[0]!.tier).toBe('custom');
        expect(r.requests[0]!.model).toBe(SLUG);
      });

      it('`--continue` de uma sessão Custom ⇒ a 1ª chamada manda tier:custom + model (NÃO 422)', async () => {
        const store = new SessionStore({ baseDir: aluyDir });
        // 1º turno: cria a sessão Custom (persiste o slug).
        await runTurn({ goal: 'inicio custom', tier: 'custom', model: SLUG, store });
        const id = store.list()[0]!.id;
        // 2º turno SEM passar tier/model (só --continue): o slug tem que VOLTAR do disco.
        const second = await runTurn({
          goal: 'continua custom',
          resume: { kind: 'continue' },
          store,
        });
        expect(second.store.list()[0]!.id).toBe(id); // mesma sessão.
        // O FIX: a chamada após retomar carrega tier:custom E o slug (sem isto ⇒ 422).
        expect(second.requests[0]!.tier).toBe('custom');
        expect(second.requests[0]!.model).toBe(SLUG);
        // e o record continua com o slug (não foi apagado na retomada).
        expect(second.store.load(id)!.model).toBe(SLUG);
      });

      it('record Custom LEGADO (sem model no disco) ⇒ resume NÃO manda custom-sem-model (fallback + aviso)', async () => {
        const store = new SessionStore({ baseDir: aluyDir });
        // 1º turno Custom (cwd casado pelo próprio runSession), depois SIMULA o legado
        // removendo o campo `model` do arquivo no disco (record salvo ANTES do fix).
        await runTurn({ goal: 'inicio legado', tier: 'custom', model: SLUG, store });
        const id = store.list()[0]!.id;
        const file = store.pathFor(id);
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        delete raw.model; // tier:'custom' SEM model ⇒ exatamente o record legado.
        writeFileSync(file, JSON.stringify(raw), 'utf8');
        expect(store.load(id)!.model).toBeUndefined(); // confirma o legado no disco.

        const second = await runTurn({
          goal: 'continua legado',
          resume: { kind: 'continue' },
          store,
        });
        // o ponto central: a chamada NÃO foi tier:custom sem model (que daria 422).
        expect(second.requests[0]!.tier).not.toBe('custom');
        expect(second.requests[0]!.model).toBeUndefined();
        // avisou o usuário do fallback (nota honesta menciona Custom).
        expect(second.out.text().toLowerCase()).toMatch(/custom/);
      });
    });

    // ── EST-0962 (BUG Custom — PREFERÊNCIA) — o slug Custom GRUDA entre sessões NOVAS ──
    // O furo do #91 cobriu o RESUME (mesma sessão). Aqui é a PREFERÊNCIA: uma sessão NOVA
    // (sem --resume/--continue), só lendo `~/.aluy/config.json`. Antes do fix a pref só
    // tinha `tier:custom` (sem slug) ⇒ a sessão nova ia "custom sem modelo" e o usuário
    // re-inputava. Com o fix, a pref carrega o slug e a 1ª chamada já o leva.
    describe('via PREFERÊNCIA: o slug Custom gruda na sessão NOVA (EST-0962)', () => {
      const SLUG = 'openrouter/algum-modelo-custom';

      it('pref { tier:custom, model:X } ⇒ sessão NOVA inicia em custom+X (1ª chamada leva o slug, sem re-input)', async () => {
        // pré-grava a pref como se uma sessão anterior tivesse escolhido o Custom no /model.
        new UserConfigStore({ baseDir: aluyDir }).saveTier('custom', SLUG);
        // sessão NOVA: SEM passar tier/model (nada de flag) e SEM resume — só a pref vale.
        const r = await runTurn({ goal: 'objetivo da sessao nova' });
        // O FIX: a 1ª chamada já saiu como tier:custom + slug (sem custom-sem-model / 422).
        expect(r.requests[0]!.tier).toBe('custom');
        expect(r.requests[0]!.model).toBe(SLUG);
      });

      it('flag --tier (canônica) VENCE a pref Custom (precedência preservada)', async () => {
        new UserConfigStore({ baseDir: aluyDir }).saveTier('custom', SLUG);
        const r = await runTurn({ goal: 'objetivo', tier: 'aluy-deep' });
        // a flag ganhou: tier canônico e NENHUM slug Custom fantasma.
        expect(r.requests[0]!.tier).toBe('aluy-deep');
        expect(r.requests[0]!.model).toBeUndefined();
      });

      it('pref LEGADA { tier:custom } SEM slug ⇒ sessão nova NÃO manda custom-sem-model (fallback + aviso)', async () => {
        // simula a pref gravada ANTES do fix: tier:custom sem o campo model no disco.
        const cfg = new UserConfigStore({ baseDir: aluyDir });
        mkdirSync(aluyDir, { recursive: true });
        writeFileSync(cfg.configPath, JSON.stringify({ tier: 'custom' }), 'utf8');
        const r = await runTurn({ goal: 'objetivo legado pref' });
        // o ponto central: NÃO foi tier:custom sem model (evita 422 silencioso).
        expect(r.requests[0]!.tier).not.toBe('custom');
        expect(r.requests[0]!.model).toBeUndefined();
        // avisou do fallback (nota honesta menciona Custom).
        expect(r.out.text().toLowerCase()).toMatch(/custom/);
      });

      it('RESUME VENCE a pref: pref custom+X mas a sessão retomada era canônica ⇒ a 1ª chamada é a do resume', async () => {
        const store = new SessionStore({ baseDir: aluyDir });
        // cria uma sessão canônica (aluy-deep) e a retoma; a pref aponta p/ custom.
        await runTurn({ goal: 'inicio canonico', tier: 'aluy-deep', store });
        new UserConfigStore({ baseDir: aluyDir }).saveTier('custom', SLUG);
        const second = await runTurn({
          goal: 'continua',
          resume: { kind: 'continue' },
          store,
        });
        // o resume (canônico) venceu a pref (custom): a chamada NÃO é custom.
        expect(second.requests[0]!.tier).toBe('aluy-deep');
        expect(second.requests[0]!.model).toBeUndefined();
      });
    });
  },
);

/** Garante que a pasta de sessões não vaza p/ fora (asserts de local). */
describe(
  'runSession — confinamento da persistência (EST-0972)',
  { timeout: RESUME_TIMEOUT_MS },
  () => {
    it('grava SÓ dentro de ~/.aluy/sessions (nunca no workspace)', async () => {
      const base = mkdtempSync(join(tmpdir(), 'aluy-confine-'));
      const aluyDir = join(base, '.aluy');
      const workspaceRoot = join(base, 'project');
      mkdirSync(workspaceRoot, { recursive: true });
      const store = new SessionStore({ baseDir: aluyDir });
      const { client } = capturingBroker();
      try {
        await runSession({
          goal: 'oi',
          stdout: nonTtyStdout(),
          env: { ALUY_MEM_OFF: '1' }, // HERMÉTICO: mem0 OFF (não vaza o sidecar :11435 real da máquina)
          store: new MemoryStore(),
          brokerClient: client,
          catalogClient: stubCatalog as never,
          workspaceRoot,
          sessionStore: store,
          // hermético — não lança os servers MCP reais nem lê `~/.aluy/agents` (flake #131).
          mcpTools: [],
          userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
        });
        // o workspace não ganhou nenhum arquivo de sessão.
        expect(readdirSync(workspaceRoot)).toEqual([]);
        // a sessão está em ~/.aluy/sessions.
        expect(readdirSync(join(aluyDir, 'sessions')).some((n) => n.endsWith('.json'))).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);
