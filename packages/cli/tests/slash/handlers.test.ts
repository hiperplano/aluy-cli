// EST-0948 · CA-3 — execução dos slash-commands (corrige o bug do no-op).
//
// O bug do Tiago: /help, /model, /usage, /permissions, /login, /logout, /whoami,
// /init caíam em `default: break` (Enter não fazia nada). Aqui provamos que CADA
// um produz um EFEITO REAL — e que /model NUNCA expõe provider (HG-2).

import { describe, expect, it } from 'vitest';
import type { LoginService } from '@aluy/cli-core';
import { buildSlashEffect, runAsyncSlash, type SlashContext } from '../../src/slash/handlers.js';

const CTX: SlashContext = { usage: { tokens: 12400, windowPct: 38, tier: 'turbo' } };

describe('buildSlashEffect — cada comando tem efeito (nada de no-op silencioso)', () => {
  it('/help ⇒ nota com a lista de comandos', () => {
    const e = buildSlashEffect('help', CTX);
    expect(e.kind).toBe('note');
    if (e.kind === 'note') {
      const joined = e.note.lines.join('\n');
      expect(joined).toContain('/model');
      expect(joined).toContain('/usage');
    }
  });

  it('/model ⇒ mostra o TIER — NUNCA o provider nem o mecanismo do broker (HG-2)', () => {
    const e = buildSlashEffect('model', CTX);
    expect(e.kind).toBe('note');
    if (e.kind === 'note') {
      const joined = e.note.lines.join('\n').toLowerCase();
      expect(joined).toContain('turbo');
      // HG-2: NÃO expõe o provider NEM o mecanismo de resolução (a msg "via broker —
      // provider/modelo resolvido pelo broker (nunca exibido)" foi removida — pedido do dono).
      expect(joined).not.toMatch(/openai|anthropic|gpt|claude|gemini|sonnet|haiku/);
      expect(joined).not.toContain('via broker');
      expect(joined).not.toContain('resolvido pelo broker');
    }
  });

  it('/usage ⇒ tokens da sessão + % janela', () => {
    const e = buildSlashEffect('usage', CTX);
    if (e.kind === 'note') {
      const joined = e.note.lines.join('\n');
      expect(joined).toContain('12.4k');
      expect(joined).toContain('38%');
    }
  });

  it('/permissions ⇒ resume a catraca (sem unsafe = ask nas categorias)', () => {
    const e = buildSlashEffect('permissions', CTX);
    if (e.kind === 'note') {
      const joined = e.note.lines.join('\n');
      expect(joined).toMatch(/ask/);
      expect(joined).toMatch(/sempre-ask|destrutivo/);
    }
  });

  it('/permissions com unsafe deixa explícito o BYPASS (texto de produto: YOLO)', () => {
    const e = buildSlashEffect('permissions', { ...CTX, unsafe: true });
    if (e.kind === 'note') {
      const joined = e.note.lines.join('\n');
      // EST-0959 — o texto de usuário diz YOLO (o modo interno segue `unsafe`).
      expect(joined).toMatch(/YOLO/);
      expect(joined).toMatch(/DESLIGAD/);
    }
  });

  it('/init ⇒ orienta o AGENT.md', () => {
    const e = buildSlashEffect('init', CTX);
    if (e.kind === 'note') expect(e.note.lines.join('\n')).toMatch(/AGENT\.md/);
  });

  it('/login ⇒ orienta o device-flow (não no-op)', () => {
    const e = buildSlashEffect('login', CTX);
    if (e.kind === 'note') expect(e.note.lines.join('\n')).toMatch(/aluy login/);
  });

  it('/clear ⇒ efeito clear', () => {
    expect(buildSlashEffect('clear', CTX).kind).toBe('clear');
  });

  it('/quit ⇒ efeito quit', () => {
    expect(buildSlashEffect('quit', CTX).kind).toBe('quit');
  });

  it('EST-0972 — /history sem roteamento real ⇒ nota honesta (TTY abre o picker)', () => {
    const e = buildSlashEffect('history', CTX);
    expect(e.kind).toBe('note');
    if (e.kind === 'note') {
      expect(e.note.title).toBe('history');
      expect(e.note.lines.join('\n')).toMatch(/sess(õ|o)es anteriores|retoma/i);
      // a nota explica o atalho do não-TTY (`/history <id>`).
      expect(e.note.lines.join('\n')).toMatch(/history <id>/);
    }
  });

  it('/whoami e /logout ⇒ async (consomem EST-0942)', () => {
    expect(buildSlashEffect('whoami', CTX).kind).toBe('async');
    expect(buildSlashEffect('logout', CTX).kind).toBe('async');
  });

  // Fallbacks honestos: comandos roteados-ANTES em run.tsx caem aqui só sem o wiring
  // (não-TTY) — devem dar uma NOTA explicativa, nunca no-op silencioso.
  it('EST-0970 — /mcp (fallback sem wiring) ⇒ nota explica add/remove/disable/enable + catraca', () => {
    const e = buildSlashEffect('mcp', CTX);
    expect(e.kind).toBe('note');
    if (e.kind === 'note') {
      expect(e.note.title).toBe('mcp');
      const text = e.note.lines.join('\n');
      expect(text).toContain('/mcp add');
      expect(text).toContain('/mcp disable');
      expect(text).toContain('catraca');
    }
  });

  it('EST-0977 — /agents (fallback sem wiring) ⇒ nota explica global/projeto + rejeitados', () => {
    const e = buildSlashEffect('agents', CTX);
    expect(e.kind).toBe('note');
    if (e.kind === 'note') {
      expect(e.note.title).toBe('agents');
      const text = e.note.lines.join('\n');
      expect(text).toContain('~/.aluy/agents');
      expect(text).toContain('.claude/agents');
      expect(text).toContain('rejeitados');
      expect(text).toContain('spawn_agent');
    }
  });

  it('/theme (fallback) ⇒ lista os temas sem trocar', () => {
    const e = buildSlashEffect('theme', CTX);
    expect(e.kind).toBe('theme');
  });

  it('/notify (fallback) ⇒ efeito notify', () => {
    expect(buildSlashEffect('notify', CTX).kind).toBe('notify');
  });

  it('/undo e /redo (fallback) ⇒ nota de indisponível (sem journal)', () => {
    expect(buildSlashEffect('undo', CTX).kind).toBe('note');
    expect(buildSlashEffect('redo', CTX).kind).toBe('note');
  });

  it('/memory, /compact, /cycle (fallback) ⇒ nota explicativa', () => {
    for (const id of ['memory', 'compact', 'cycle'] as const) {
      const e = buildSlashEffect(id, CTX);
      expect(e.kind).toBe('note');
    }
  });
});

describe('runAsyncSlash — whoami/logout consomem o LoginService', () => {
  it('/whoami autenticado ⇒ user/org/escopos, NUNCA o segredo', async () => {
    const login = {
      whoami: async () => ({
        user: 'tiago',
        organization_id: 'org-1',
        scopes: ['agent.run'],
        kind: 'device',
        token_hint: 'aluy_…f00',
      }),
    } as unknown as LoginService;
    const note = await runAsyncSlash('whoami', login);
    const joined = note.lines.join('\n');
    expect(joined).toContain('tiago');
    expect(joined).toContain('org-1');
    expect(joined).toContain('agent.run');
    expect(joined).toContain('redigido'); // hint, nunca o token
  });

  it('/whoami não autenticado ⇒ orienta `aluy login`', async () => {
    const login = { whoami: async () => null } as unknown as LoginService;
    const note = await runAsyncSlash('whoami', login);
    expect(note.lines.join('\n')).toMatch(/não autenticado|aluy login/);
  });

  it('/logout ⇒ confirma revogação/apagamento', async () => {
    const login = { logout: async () => ({ revoked: true }) } as unknown as LoginService;
    const note = await runAsyncSlash('logout', login);
    expect(note.lines.join('\n')).toMatch(/revogada|apagada/);
  });

  it('/logout que falha ⇒ mensagem NEUTRA (CLI-SEC-1), sem vazar causa', async () => {
    const login = {
      logout: async () => {
        throw new Error('boom interno');
      },
    } as unknown as LoginService;
    const note = await runAsyncSlash('logout', login);
    expect(note.lines.join('\n')).not.toContain('boom interno');
    expect(note.lines.join('\n')).toMatch(/tente de novo/);
  });
});
