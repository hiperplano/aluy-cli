// EST-0965 (FLICKER, causa-raiz medida no PTY) — POLÍTICA dos DOIS ticks.
//
// O DoD principal: em `streaming`/`retrying` o tick de ANIMAÇÃO de 120ms NÃO roda (só
// o de 1s do elapsed); em `thinking`/`boot` o de 120ms roda. Isolar a decisão em
// funções puras dá o teste DETERMINÍSTICO sem depender do loop de efeitos do Ink (que
// o harness não dispara). A App liga `useTick` EXATAMENTE a estes predicados.

import { describe, expect, it } from 'vitest';
import { animTickEnabled, elapsedTickEnabled } from '../../src/session/tick-policy.js';
import type { SessionState } from '../../src/session/model.js';

type Phase = SessionState['phase'];
const ALL: Phase[] = [
  'boot',
  'idle',
  'thinking',
  'streaming',
  'asking',
  'budget',
  'stuck',
  'retrying',
  'compacting',
  'error',
  'done',
];

describe('tick-policy — ANIMAÇÃO de 120ms: vácuo SEMPRE; streaming SÓ com sync (EST-0965)', () => {
  it('LIGA em thinking e boot (vácuo pré-progresso) — em AMBOS os modos de sync', () => {
    expect(animTickEnabled('thinking', true)).toBe(true);
    expect(animTickEnabled('thinking', false)).toBe(true);
    expect(animTickEnabled('boot', true)).toBe(true);
    expect(animTickEnabled('boot', false)).toBe(true);
  });

  it('streaming/retrying ⇒ LIGA quando o sync está ATIVO (frame atômico #76, sem tremor)', () => {
    // Religa a "parte animada" que o #75 desligou: com BSU…ESU o redraw 8×/seg não treme.
    expect(animTickEnabled('streaming', true)).toBe(true);
    expect(animTickEnabled('retrying', true)).toBe(true);
  });

  it('streaming/retrying ⇒ DESLIGA quando o sync está OFF (preserva o anti-flicker #75)', () => {
    // Caminho sem-sync (ALUY_SYNC_OUTPUT=0 / terminal sem suporte): NÃO redesenha por
    // frame — o #75 protege contra o flicker e não pode regredir aqui.
    expect(animTickEnabled('streaming', false)).toBe(false);
    expect(animTickEnabled('retrying', false)).toBe(false);
  });

  it('default de `syncActive` é TRUE (sync ON por padrão) ⇒ streaming anima sem o flag', () => {
    // O wiring monta a App sem o flag quando o sync está ligado (caso comum); o default
    // do predicado tem que casar com `syncOutputEnabled` (ON por padrão).
    expect(animTickEnabled('streaming')).toBe(true);
    expect(animTickEnabled('retrying')).toBe(true);
  });

  it('compacting (EST-0973) ⇒ LIGA em AMBOS os modos (vácuo de progresso, como thinking)', () => {
    // O spinner do <ProgressBar> precisa girar mesmo sem sync: é 1 célula numa linha
    // pequena (não redesenha a tela toda) ⇒ não reintroduz o flicker.
    expect(animTickEnabled('compacting', true)).toBe(true);
    expect(animTickEnabled('compacting', false)).toBe(true);
  });

  it('DESLIGA em todas as fases ociosas/decisão (sem re-render por frame), com ou sem sync', () => {
    for (const p of ['idle', 'asking', 'budget', 'stuck', 'error', 'done'] as Phase[]) {
      expect(animTickEnabled(p, true)).toBe(false);
      expect(animTickEnabled(p, false)).toBe(false);
    }
  });

  it('tabela total: com sync ⇒ {boot,compacting,retrying,streaming,thinking}; sem ⇒ {boot,compacting,thinking}', () => {
    const withSync = ALL.filter((p) => animTickEnabled(p, true));
    expect(withSync.sort()).toEqual(['boot', 'compacting', 'retrying', 'streaming', 'thinking']);
    const withoutSync = ALL.filter((p) => animTickEnabled(p, false));
    expect(withoutSync.sort()).toEqual(['boot', 'compacting', 'thinking']);
  });
});

describe('tick-policy — ELAPSED de 1s (indicador de atividade): em TODA fase ocupada', () => {
  it('LIGA em thinking, streaming, retrying e compacting (o turno/op está em curso)', () => {
    expect(elapsedTickEnabled('thinking')).toBe(true);
    expect(elapsedTickEnabled('streaming')).toBe(true);
    expect(elapsedTickEnabled('retrying')).toBe(true);
    // EST-0973 — o elapsed `M:SS` do <ProgressBar> indeterminado precisa avançar 1×/seg.
    expect(elapsedTickEnabled('compacting')).toBe(true);
  });

  it('DESLIGA fora do trabalho (idle/ask/budget/stuck/done/error/boot)', () => {
    for (const p of ['boot', 'idle', 'asking', 'budget', 'stuck', 'error', 'done'] as Phase[]) {
      expect(elapsedTickEnabled(p)).toBe(false);
    }
  });

  it('o elapsed cobre o streaming SEM-sync — onde a ANIMAÇÃO fica OFF (a tela não congela)', () => {
    // Invariante do design no caminho SEM sync: anim OFF (anti-flicker #75) mas elapsed
    // ON. Sem isto, durante args de um edit_file grande (sem token) a tela ficaria
    // estática = "travada". (Com sync, a animação volta e o elapsed segue — os dois ON.)
    expect(animTickEnabled('streaming', false)).toBe(false);
    expect(elapsedTickEnabled('streaming')).toBe(true);
    // com sync, ambos ON (animação religada sobre o frame atômico):
    expect(animTickEnabled('streaming', true)).toBe(true);
    expect(elapsedTickEnabled('streaming')).toBe(true);
  });
});
