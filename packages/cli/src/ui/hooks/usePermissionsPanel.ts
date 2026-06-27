// EST-0968 — usePermissionsPanel: maquina de estado do painel interativo
// `/permissions`. Mesma MECANICA dos demais pickers (useModelPicker/useFilePicker):
// abrir/navegar(↑↓)/agir(enter)/fechar(esc); apresentacao pura (a App captura as
// teclas e chama os metodos). A DIFERENCA e que aqui ha SECOES e cada linha tem uma
// ACAO propria (ciclar modo / revogar grant / alternar default de tool segura). As
// categorias TRAVADAS sao linhas NAO-acionaveis (enter nao faz nada nelas) — e a
// proteca visivel do CLI-SEC-3 (o painel nao oferece caminho p/ relaxa-las).
//
// FRONTEIRA (DoD): toda mudanca de estado vai pela API SEGURA da engine (cli-core)
// — setMode, sessionGrants.revoke, setSafeToolDefault. O hook NAO reimplementa a
// catraca; so chama o que e seguro mudar. Setar uma categoria sempre-ask p/ allow
// NEM EXISTE como acao aqui.

import { useCallback, useState } from 'react';
import {
  LOCKED_CATEGORIES,
  SAFE_TOGGLEABLE_TOOLS,
  type LockedCategory,
  type SafeToolDecision,
  type SessionMode,
} from '@aluy/cli-core';
import { nextMode } from '../../session/controller.js';

/**
 * Porta MINIMA que o painel precisa da engine (cli-core), sem depender da classe
 * concreta. A `PolicyPermissionEngine` a satisfaz; em teste injeta-se um stub.
 * So expoe o que e SEGURO mudar (CLI-SEC-3): modo, grants (revogar), defaults de
 * tools seguras. NAO ha porta p/ relaxar categoria — by design.
 */
export interface PermissionEngineControl {
  readonly mode: SessionMode;
  setMode(mode: SessionMode): void;
  readonly sessionGrants: { list(): readonly string[]; revoke(key: string): boolean };
  effectiveSafeDefault(tool: string): SafeToolDecision;
  setSafeToolDefault(tool: string, decision: SafeToolDecision): boolean;
}

/** Tipo de uma linha navegavel do painel (p/ a App agir no enter). */
export type PanelRowKind = 'mode' | 'grant' | 'safe-tool' | 'locked';

/** Uma linha do painel (achatada de todas as secoes p/ a navegacao ↑↓). */
export type PanelRow =
  | { readonly kind: 'mode'; readonly mode: SessionMode; readonly actionable: true }
  | { readonly kind: 'grant'; readonly grantKey: string; readonly actionable: true }
  | {
      readonly kind: 'safe-tool';
      readonly tool: string;
      readonly decision: SafeToolDecision;
      readonly actionable: true;
    }
  | {
      readonly kind: 'locked';
      readonly category: LockedCategory;
      readonly actionable: false;
    };

export interface PermissionsPanelController {
  readonly open: boolean;
  readonly selected: number;
  /** As linhas correntes (re-derivadas a cada acao p/ refletir o estado da engine). */
  readonly rows: readonly PanelRow[];
  /** Modo de sessao corrente (p/ a UI marcar). */
  readonly mode: SessionMode;
  openPanel(): void;
  closePanel(): void;
  /** Move a selecao (+1/-1), clampeada ao numero de linhas. */
  move(delta: number): void;
  /**
   * AGE na linha selecionada (enter): cicla o modo, revoga o grant, ou alterna o
   * default da tool segura. Em linha TRAVADA (locked) e NO-OP — o painel nunca
   * oferece caminho p/ relaxar uma categoria sempre-ask (CLI-SEC-3). Re-deriva as
   * linhas a partir da engine apos agir.
   */
  act(): void;
}

/** Constroi a lista achatada de linhas a partir do estado corrente da engine. */
function buildRows(engine: PermissionEngineControl): readonly PanelRow[] {
  const rows: PanelRow[] = [];
  // 1) MODO (uma linha; enter cicla plan→normal→unsafe).
  rows.push({ kind: 'mode', mode: engine.mode, actionable: true });
  // 2) DEFAULTS de tools SEGURAS (read-only): enter alterna allow⇄ask.
  for (const tool of SAFE_TOGGLEABLE_TOOLS) {
    rows.push({
      kind: 'safe-tool',
      tool,
      decision: engine.effectiveSafeDefault(tool),
      actionable: true,
    });
  }
  // 3) GRANTS de sessao (enter revoga). Lista dinamica.
  for (const grantKey of engine.sessionGrants.list()) {
    rows.push({ kind: 'grant', grantKey, actionable: true });
  }
  // 4) Categorias TRAVADAS (CLI-SEC-3) — so-leitura, NAO acionaveis.
  for (const category of LOCKED_CATEGORIES) {
    rows.push({ kind: 'locked', category, actionable: false });
  }
  return rows;
}

export function usePermissionsPanel(engine: PermissionEngineControl): PermissionsPanelController {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  // `version` so existe p/ forcar a re-derivacao das linhas apos uma acao mutar a
  // engine (a engine e estado externo; bumpar isto re-renderiza com o novo estado).
  const [version, setVersion] = useState(0);

  // Re-deriva a cada render (barato — listas pequenas). Depende de `version` p/
  // refletir mutacoes da engine feitas por `act`.
  const rows = buildRows(engine);
  void version;

  const openPanel = useCallback(() => {
    setOpen(true);
    setSelected(0);
    setVersion((v) => v + 1);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
  }, []);

  const move = useCallback(
    (delta: number) => {
      setSelected((s) => {
        const max = Math.max(0, rows.length - 1);
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [rows.length],
  );

  const act = useCallback(() => {
    const row = rows[selected];
    if (!row || !row.actionable) return; // linha travada ⇒ no-op (CLI-SEC-3).
    switch (row.kind) {
      case 'mode':
        engine.setMode(nextMode(engine.mode));
        break;
      case 'grant':
        engine.sessionGrants.revoke(row.grantKey);
        break;
      case 'safe-tool': {
        // alterna allow⇄ask. A engine RE-VALIDA (guarda anti-injecao): allow so
        // entra p/ tool read-only — aqui ja sao, mas a 2a barreira fica na engine.
        const next: SafeToolDecision = row.decision === 'allow' ? 'ask' : 'allow';
        engine.setSafeToolDefault(row.tool, next);
        break;
      }
    }
    // re-deriva as linhas e mantem a selecao em uma posicao valida (revogar grant
    // encurta a lista). Sem corrida: o clamp roda no proximo render via buildRows.
    setVersion((v) => v + 1);
    setSelected((s) => Math.min(s, Math.max(0, buildRows(engine).length - 1)));
  }, [rows, selected, engine]);

  return { open, selected, rows, mode: engine.mode, openPanel, closePanel, move, act };
}
