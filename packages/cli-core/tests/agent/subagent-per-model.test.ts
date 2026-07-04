// EST-SUBAGENT-MODEL · ADR-0061 §3 · ADR-0073 (tier por-request) · CLI-SEC-7 — cada
// SUB-AGENTE fala pelo TIER do PRÓPRIO perfil `.md`, em vez de todos usarem o caller
// do pai.
//
// A fiação é: `profile.model` (cru do `.md`) → `resolveModelTier` → CHAVE DE TIER →
// `callerForTier(tier)` PRA AQUELE FILHO. Sem `model` no `.md` (ou model sem cara de
// tier) ⇒ o filho cai no caller do PAI (back-compat). O `SharedBudget`/escopo/ordem
// seguem intactos — modelo-por-filho só troca a PISTA de tier (mesma rota de broker).
//
// Provas:
//   - 2 filhos com tiers diferentes (`opus`→aluy-deep + `granito`→aluy-granito) ⇒ cada
//     um chama o caller do SEU tier (mock registra o tier por chamada);
//   - filho SEM model no `.md` ⇒ usa o caller do PAI;
//   - tier inválido/inservível ⇒ o broker (mock) lança (422) ⇒ desfecho de erro p/ aquele
//     filho (degrade honesto), sem derrubar os outros;
//   - SharedBudget segue COMPARTILHADO/atômico sob tiers diferentes;
//   - a ORDEM dos resultados casa a ordem dos perfis.
//
// `childCallerFor` (PURO) é testado em separado — é o ponto único do juízo "qual tier".

import { describe, expect, it } from 'vitest';
import {
  SharedBudget,
  SubAgentSpawner,
  childCallerFor,
  PolicyPermissionEngine,
  NATIVE_TOOLS,
  type ModelCaller,
  type ModelCallResult,
  type SubAgentProfile,
  type ToolPorts,
  type NativeTool,
} from '../../src/index.js';
import { MemoryFs, RecordingShell, MemorySearch } from './helpers.js';

function ports(): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch() };
}

const base: readonly NativeTool<ToolPorts>[] = [...NATIVE_TOOLS];

/**
 * Caller MARCADO por um `tier` (ou rótulo) que registra CADA chamada num log
 * compartilhado: assim sabemos QUAL caller cada filho usou. Conclui de imediato
 * ("pronto") ⇒ o filho termina em 1 turno. `onCall` permite injetar erro (422).
 */
function taggedCaller(tag: string, log: { tag: string }[], onCall?: () => void): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      log.push({ tag });
      onCall?.();
      return {
        request_id: 'req',
        content: 'pronto.',
        finish_reason: 'stop',
        usage: { request_id: 'req', tier: tag, tokens_in: 1, tokens_out: 1 },
      };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// childCallerFor — o juízo PURO "qual caller por filho" (ponto único, testável).
// ════════════════════════════════════════════════════════════════════════════
describe('EST-SUBAGENT-MODEL · childCallerFor (PURO)', () => {
  const parent = taggedCaller('PARENT', []);
  const factory = (tier: string): ModelCaller => taggedCaller(`TIER:${tier}`, []);

  it('model do `.md` que resolve num tier ⇒ usa callerForTier(tier)', async () => {
    const calls: { tag: string }[] = [];
    const f = (tier: string): ModelCaller => taggedCaller(`TIER:${tier}`, calls);
    const c = childCallerFor({ label: 'x', goal: 'g', model: 'opus' }, parent, f);
    await c.call({ messages: [], idempotencyKey: 'k' });
    // opus → aluy-deep (sinônimo Claude → tier Aluy).
    expect(calls).toEqual([{ tag: 'TIER:aluy-deep' }]);
  });

  it('chave `aluy-*` desconhecida no `.md` PASSA ADIANTE como tier (broker valida)', async () => {
    const calls: { tag: string }[] = [];
    const f = (tier: string): ModelCaller => taggedCaller(`TIER:${tier}`, calls);
    const c = childCallerFor({ label: 'x', goal: 'g', model: 'aluy-quartzo' }, parent, f);
    await c.call({ messages: [], idempotencyKey: 'k' });
    expect(calls).toEqual([{ tag: 'TIER:aluy-quartzo' }]);
  });

  it('SEM model no `.md` ⇒ cai no caller do PAI (back-compat)', () => {
    const c = childCallerFor({ label: 'x', goal: 'g' }, parent, factory);
    expect(c).toBe(parent);
  });

  it('model SEM cara de tier (provider cru) ⇒ cai no caller do PAI (nunca provider direto)', () => {
    const c = childCallerFor({ label: 'x', goal: 'g', model: 'gpt-9-turbo' }, parent, factory);
    expect(c).toBe(parent);
  });

  it('SEM a fábrica injetada ⇒ cai no caller do PAI (back-compat — todos no do pai)', () => {
    const c = childCallerFor({ label: 'x', goal: 'g', model: 'opus' }, parent, undefined);
    expect(c).toBe(parent);
  });

  // ── ADR-0146 (D3) — sentinelas de HERANÇA/BYO ──────────────────────────────
  it('ADR-0146 · "same-as-parent"/"parent"/"inherit" ⇒ SEMPRE o caller do PAI', () => {
    for (const m of ['same-as-parent', 'parent', 'inherit', 'Same-As-Parent']) {
      const c = childCallerFor({ label: 'x', goal: 'g', model: m }, parent, factory);
      expect(c).toBe(parent);
    }
  });

  it('ADR-0146 · "custom" (sem slug) com customCallerFor ⇒ usa a fábrica CUSTOM, não a de tier', async () => {
    const customCalls: { tag: string }[] = [];
    const tierCalls: { tag: string }[] = [];
    const tierFactory = (tier: string): ModelCaller => taggedCaller(`TIER:${tier}`, tierCalls);
    const customFactory = (slug?: string): ModelCaller =>
      taggedCaller(`CUSTOM:${slug ?? '(sem slug)'}`, customCalls);
    const c = childCallerFor(
      { label: 'x', goal: 'g', model: 'custom' },
      parent,
      tierFactory,
      customFactory,
    );
    await c.call({ messages: [], idempotencyKey: 'k' });
    expect(customCalls).toEqual([{ tag: 'CUSTOM:(sem slug)' }]);
    expect(tierCalls).toHaveLength(0);
  });

  it('ADR-0146 · "custom:<slug>" ⇒ a fábrica CUSTOM recebe o SLUG indicado', async () => {
    const customCalls: { tag: string }[] = [];
    const customFactory = (slug?: string): ModelCaller =>
      taggedCaller(`CUSTOM:${slug ?? '(sem slug)'}`, customCalls);
    const c = childCallerFor(
      { label: 'x', goal: 'g', model: 'custom:meu-slug' },
      parent,
      undefined,
      customFactory,
    );
    await c.call({ messages: [], idempotencyKey: 'k' });
    expect(customCalls).toEqual([{ tag: 'CUSTOM:meu-slug' }]);
  });

  it('ADR-0146 · "custom" SEM a fábrica customCallerFor injetada ⇒ cai no caller do PAI (fail-safe)', () => {
    const c = childCallerFor({ label: 'x', goal: 'g', model: 'custom:algum-slug' }, parent);
    expect(c).toBe(parent);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SubAgentSpawner — roteamento POR FILHO end-to-end (mock de caller por tier).
// ════════════════════════════════════════════════════════════════════════════
describe('EST-SUBAGENT-MODEL · SubAgentSpawner roteia cada filho ao tier do seu `.md`', () => {
  it('2 filhos com tiers diferentes (opus + granito) ⇒ cada um chama o caller do SEU tier', async () => {
    const tierLog: { tag: string }[] = [];
    // A fábrica devolve um caller marcado pelo tier; cada chamada registra o tier.
    const callerForTier = (tier: string): ModelCaller => taggedCaller(tier, tierLog);
    // O caller do PAI é DISTINTO — não deve ser usado por nenhum filho com model.
    const parentLog: { tag: string }[] = [];
    const parent = taggedCaller('PARENT', parentLog);

    const spawner = new SubAgentSpawner({
      model: parent,
      callerForTier,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports(),
      baseTools: base,
    });

    const profiles: SubAgentProfile[] = [
      { label: 'pesquisa', goal: 'pesquise X', model: 'opus' }, // → aluy-deep
      { label: 'rascunho', goal: 'rascunhe Y', model: 'granito' }, // → aluy-granito
    ];
    const out = await spawner.spawn(profiles);

    // ambos concluíram
    expect(out.map((o) => o.stop)).toEqual(['final', 'final']);
    // cada filho falou pelo SEU tier — e o caller do PAI NÃO foi tocado.
    const tags = tierLog.map((e) => e.tag).sort();
    expect(tags).toEqual(['aluy-deep', 'aluy-granito']);
    expect(parentLog).toHaveLength(0);
  });

  it('filho SEM model no `.md` ⇒ usa o caller do PAI; os outros ⇒ o tier do `.md` (mix)', async () => {
    const tierLog: { tag: string }[] = [];
    const parentLog: { tag: string }[] = [];
    const callerForTier = (tier: string): ModelCaller => taggedCaller(tier, tierLog);
    const parent = taggedCaller('PARENT', parentLog);

    const spawner = new SubAgentSpawner({
      model: parent,
      callerForTier,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports(),
      baseTools: base,
    });

    const out = await spawner.spawn([
      { label: 'a', goal: 'g1', model: 'opus' }, // → aluy-deep
      { label: 'b', goal: 'g2' }, // SEM model ⇒ PAI
    ]);

    expect(out.map((o) => o.stop)).toEqual(['final', 'final']);
    expect(tierLog.map((e) => e.tag)).toEqual(['aluy-deep']);
    expect(parentLog.map((e) => e.tag)).toEqual(['PARENT']);
  });

  it('SEM callerForTier injetada ⇒ TODOS os filhos usam o caller do pai (back-compat puro)', async () => {
    const parentLog: { tag: string }[] = [];
    const parent = taggedCaller('PARENT', parentLog);
    const spawner = new SubAgentSpawner({
      model: parent,
      // SEM callerForTier
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports(),
      baseTools: base,
    });
    const out = await spawner.spawn([
      { label: 'a', goal: 'g1', model: 'opus' },
      { label: 'b', goal: 'g2', model: 'granito' },
    ]);
    expect(out.map((o) => o.stop)).toEqual(['final', 'final']);
    // mesmo com model no `.md`, sem fábrica TODOS caem no pai.
    expect(parentLog.map((e) => e.tag)).toEqual(['PARENT', 'PARENT']);
  });

  it('tier inservível (broker mock 422) ⇒ desfecho de ERRO p/ AQUELE filho, sem derrubar o outro', async () => {
    const tierLog: { tag: string }[] = [];
    const parent = taggedCaller('PARENT', []);
    // O caller do tier `aluy-quartzo` (inexistente no broker) LANÇA — como um 422 do
    // broker sobe ao loop do filho (BrokerError não é retentado; vira stop:'error').
    const callerForTier = (tier: string): ModelCaller =>
      taggedCaller(tier, tierLog, () => {
        if (tier === 'aluy-quartzo') {
          throw new Error('422 unservable_model: tier "aluy-quartzo" não existe no catálogo');
        }
      });

    const spawner = new SubAgentSpawner({
      model: parent,
      callerForTier,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports(),
      baseTools: base,
    });

    const out = await spawner.spawn([
      { label: 'bom', goal: 'g1', model: 'granito' }, // → aluy-granito (ok)
      { label: 'ruim', goal: 'g2', model: 'aluy-quartzo' }, // → 422 do broker
    ]);

    // o filho do tier válido conclui; o do tier inservível DEGRADA honesto (erro), e a
    // ORDEM dos resultados é preservada (não é "o que terminou primeiro").
    expect(out[0]!.label).toBe('bom');
    expect(out[0]!.stop).toBe('final');
    expect(out[1]!.label).toBe('ruim');
    expect(out[1]!.stop).toBe('error');
    expect(out[1]!.result).toMatch(/422|unservable|quartzo/i);
  });

  it('SharedBudget segue COMPARTILHADO/atômico sob tiers diferentes (modelo-por-filho não muda o budget)', async () => {
    // Teto de iterações pequeno e AGREGADO. Cada filho conclui em 1 iteração; com 3
    // filhos em tiers distintos, o budget consome EXATAMENTE 3 (compartilhado), não 1
    // por filho isolado. Provamos que o budget é o MESMO contador para todos os tiers.
    const shared = new SharedBudget({ maxIterations: 10, maxToolCalls: 10, maxTokens: 1000 });
    const tierLog: { tag: string }[] = [];
    const callerForTier = (tier: string): ModelCaller => taggedCaller(tier, tierLog);

    const spawner = new SubAgentSpawner({
      model: taggedCaller('PARENT', []),
      callerForTier,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports(),
      baseTools: base,
      sharedBudget: shared,
    });
    expect(spawner.sharedBudget).toBe(shared);

    await spawner.spawn([
      { label: 'a', goal: 'g', model: 'opus' }, // aluy-deep
      { label: 'b', goal: 'g', model: 'granito' }, // aluy-granito
      { label: 'c', goal: 'g', model: 'strata' }, // aluy-strata
    ]);

    // 3 filhos, 1 iteração cada ⇒ o MESMO SharedBudget contou 3 (agregado, não por-filho).
    expect(shared.usage.iterations).toBe(3);
    // e cada um falou pelo seu tier (a contabilidade compartilhada não embaralhou a pista).
    expect(tierLog.map((e) => e.tag).sort()).toEqual(['aluy-deep', 'aluy-granito', 'aluy-strata']);
  });
});
