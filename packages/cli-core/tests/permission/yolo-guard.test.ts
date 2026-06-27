// EST-0991 · EST-1007 · ADR-0072 · AG-0008 — guarda de ENTRADA do YOLO
// (opt-in/headless/root + auditoria).
//
// Prova o "mínimo blindado" que o YOLO MANTÉM (não são pisos de função; são o opt-in
// ser barulhento, espelhando o Claude Code), PÓS AG-0008 (alinhamento ao Claude Code,
// decisão do dono — relax de gate, sinalizado ao `seguranca`):
//   (b) confirmação de entrada one-shot em TTY (requiresConfirmation);
//   (b) HEADLESS (sem TTY) ENTRA DIRETO — a flag `--yolo` é o consentimento (igual
//       `claude -p --dangerously-skip-permissions`); sem confirmação, só o banner;
//   (d) recusa DURA como ROOT — o ÚNICO bloqueio que sobra (não há env de escape);
//   (5) auditoria com FLAG DE MODO `yolo` (forense, CLI-SEC-10).
//
// MUDANÇA: caiu o duplo opt-in `ALUY_YOLO_HEADLESS`. Headless não recusa mais; root
// recusa SEMPRE (TTY ou não).

import { describe, expect, it } from 'vitest';
import {
  decideYoloEntry,
  yoloAuditEvent,
  YOLO_ENTRY_NOTICE,
  YOLO_WARNING,
  type YoloContext,
} from '../../src/index.js';

function ctx(over: Partial<YoloContext> = {}): YoloContext {
  return { tty: true, root: false, ...over };
}

describe('(b) — TTY interativa não-root ⇒ allow + confirmação one-shot', () => {
  it('allow e PEDE confirmação (requiresConfirmation)', () => {
    const v = decideYoloEntry(ctx({ tty: true, root: false }));
    expect(v.outcome).toBe('allow');
    if (v.outcome === 'allow') {
      expect(v.requiresConfirmation).toBe(true);
      expect(v.notice).toBe(YOLO_ENTRY_NOTICE);
      // o aviso é honesto, sem eufemismo (ADR-0072 §3b).
      expect(v.notice).toMatch(/PERMISSÃO COMPLETA|DESLIGADA|injeção/);
      // EST-1007 — em TTY o `notice` CARREGA a pergunta de confirmação (há quem responda).
      expect(v.notice).toMatch(/Continuar\? \[s\/N\]/);
    }
  });
});

describe('(b) — HEADLESS (sem TTY) não-root ENTRA DIRETO (a flag é o consentimento)', () => {
  it('sem TTY e não-root ⇒ allow SEM confirmação (não há TTY p/ responder)', () => {
    // EST-1007 · AG-0008 — antes RECUSAVA sem ALUY_YOLO_HEADLESS=1; agora a flag basta.
    const v = decideYoloEntry(ctx({ tty: false, root: false }));
    expect(v.outcome).toBe('allow');
    if (v.outcome === 'allow') {
      expect(v.requiresConfirmation).toBe(false);
      // o aviso (banner) ainda existe — o caller o emite no stderr no headless.
      expect(v.notice).toBe(YOLO_ENTRY_NOTICE);
      // EST-1007 — o `warning` é o que o headless emite: banner HONESTO mas SEM a pergunta
      // "Continuar? [s/N]" (a flag já consentiu; não há prompt a responder no headless).
      expect(v.warning).toBe(YOLO_WARNING);
      expect(v.warning).toMatch(/PERMISSÃO COMPLETA|DESLIGADA|injeção/);
      expect(v.warning).not.toMatch(/Continuar\?|\[s\/N\]/);
    }
  });
});

describe('(d) — ROOT recusa SEMPRE (único bloqueio duro; espelha o Claude)', () => {
  it('root em TTY ⇒ RECUSA com motivo `root` (sem fallback nem env de escape)', () => {
    const v = decideYoloEntry(ctx({ tty: true, root: true }));
    expect(v.outcome).toBe('refuse');
    if (v.outcome === 'refuse') {
      expect(v.reason).toBe('root');
      expect(v.message).toMatch(/root/i);
      expect(v.message).toMatch(/usuário normal/i);
    }
  });

  it('root em HEADLESS (sem TTY) ⇒ RECUSA igualmente (root vence headless)', () => {
    const v = decideYoloEntry(ctx({ tty: false, root: true }));
    expect(v.outcome).toBe('refuse');
    if (v.outcome === 'refuse') expect(v.reason).toBe('root');
  });
});

describe('(5) — auditoria carrega a FLAG DE MODO `yolo` (forense, CLI-SEC-10)', () => {
  it('entrada bem-sucedida ⇒ evento `yolo-entered` com mode `yolo`', () => {
    const v = decideYoloEntry(ctx({ tty: true }));
    const e = yoloAuditEvent(v, 1700000000000);
    expect(e).toEqual({
      actorType: 'cli',
      kind: 'yolo-entered',
      mode: 'yolo',
      at: 1700000000000,
    });
  });

  it('entrada HEADLESS também audita `yolo-entered` (sem motivo de recusa)', () => {
    const v = decideYoloEntry(ctx({ tty: false, root: false }));
    const e = yoloAuditEvent(v, 1700000000002);
    expect(e.kind).toBe('yolo-entered');
    expect(e.mode).toBe('yolo');
    expect(e.reason).toBeUndefined();
  });

  it('recusa (root) ⇒ evento `yolo-refused` com mode `yolo` + motivo `root`', () => {
    const v = decideYoloEntry(ctx({ tty: true, root: true }));
    const e = yoloAuditEvent(v, 1700000000001);
    expect(e.actorType).toBe('cli');
    expect(e.kind).toBe('yolo-refused');
    expect(e.mode).toBe('yolo');
    expect(e.reason).toBe('root');
  });
});
