// PAUSA POR COTA — persistência do trabalho pausado em `~/.aluy/pausas/<sessionId>.json`.
//
// Quando a cota do modelo acaba, os agentes pausam NA MEMÓRIA (ver
// `cli-core/src/agent/quota-pause.ts`). Para o trabalho sobreviver a um fechamento do
// processo (ou ao "parar salvando"), cada pausa grava aqui uma FOTO: o histórico íntegro de
// cada agente pausado + o perfil dos sub-agentes. O `--resume`/`--continue` da MESMA sessão
// encontra o arquivo e continua de onde parou; terminou a retomada, o arquivo é apagado.
//
// SEGURANÇA — mesmo regime do `SessionStore`: dir `0700`, arquivo `0600` atômico
// (temp `O_EXCL` + rename), FORA do workspace, nunca lido pelo agente (path-deny do core
// sobre `~/.aluy`). O histórico traz saída de tool (dado ingerido) que pode ter segredo, então
// o texto passa pela MESMA redação do journal (CLI-SEC-6) ANTES de tocar o disco. NUNCA grava
// credencial. Leitura FAIL-SAFE: ausente/corrompido ⇒ `null` (sessão retoma sem pausa).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  redactOutputSecrets,
  type HistoryItem,
  type PausedAgentSnapshot,
} from '@hiperplano/aluy-cli-core';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const PAUSAS_DIRNAME = 'pausas';
export const PAUSA_RECORD_VERSION = 1;
/** Teto de leitura (anti-DoS / arquivo adulterado). */
const MAX_PAUSA_BYTES = 64 * 1024 * 1024;
/** Pausas mais velhas que isto são varridas na próxima gravação (a cota já não é a mesma). */
export const PAUSA_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** O que fica no disco. */
export interface PausaRecord {
  readonly version: number;
  readonly sessionId: string;
  /** ms epoch da última gravação. */
  readonly savedAt: number;
  /** Sabor da cota (`janela`/`semanal`/…) e motivo curto — só para a nota ao retomar. */
  readonly scope: string;
  readonly reason: string;
  /** Horário de reset previsto (epoch ms), se o provider disse. */
  readonly resetAtMs?: number;
  /** Os agentes pausados (principal e/ou sub-agentes) com o histórico de cada um. */
  readonly agents: readonly PausedAgentSnapshot[];
}

/** Redige segredos do texto de um item de histórico. Imagens (base64) ficam de fora do disco. */
export function redactHistoryItem(item: HistoryItem): HistoryItem | null {
  if (item.role === 'attachment_image') return null;
  return { ...item, text: redactOutputSecrets(item.text) } as HistoryItem;
}

function redactSnapshot(s: PausedAgentSnapshot): PausedAgentSnapshot {
  const history = s.history.map(redactHistoryItem).filter((x): x is HistoryItem => x !== null);
  return { ...s, history };
}

export interface PausaStoreOptions {
  readonly baseDir?: string;
  readonly now?: () => number;
  /** `--anonymous`: não grava nada. */
  readonly disabled?: boolean;
}

export class PausaStore {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly disabled: boolean;

  constructor(opts: PausaStoreOptions = {}) {
    this.dir = join(opts.baseDir ?? join(homedir(), '.aluy'), PAUSAS_DIRNAME);
    this.now = opts.now ?? ((): number => Date.now());
    this.disabled = opts.disabled ?? false;
  }

  pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** Grava (atômico, 0600). Best-effort: `false` se falhou — nunca derruba a sessão. */
  save(input: Omit<PausaRecord, 'version' | 'savedAt'>): boolean {
    if (this.disabled || !SAFE_ID.test(input.sessionId)) return false;
    try {
      const record: PausaRecord = {
        ...input,
        version: PAUSA_RECORD_VERSION,
        savedAt: this.now(),
        agents: input.agents.map(redactSnapshot),
      };
      mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
      const file = this.pathFor(input.sessionId);
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(
          tmp,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          FILE_MODE,
        );
        writeSync(fd, JSON.stringify(record) + '\n');
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, file);
      } catch (err) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err;
      }
      this.sweep();
      return true;
    } catch {
      return false;
    }
  }

  /** Lê a pausa de uma sessão. FAIL-SAFE: qualquer problema ⇒ `null`. */
  load(sessionId: string): PausaRecord | null {
    if (!SAFE_ID.test(sessionId)) return null;
    try {
      const file = this.pathFor(sessionId);
      if (statSync(file).size > MAX_PAUSA_BYTES) return null;
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return sanitize(parsed, sessionId);
    } catch {
      return null;
    }
  }

  /** Apaga a pausa (retomada concluída / cancelada). No-op se não existe. */
  remove(sessionId: string): void {
    if (!SAFE_ID.test(sessionId)) return;
    try {
      unlinkSync(this.pathFor(sessionId));
    } catch {
      /* ausente: ok */
    }
  }

  /** Varre pausas velhas demais. Best-effort. */
  private sweep(): void {
    try {
      const limit = this.now() - PAUSA_MAX_AGE_MS;
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) continue;
        const file = join(this.dir, name);
        try {
          if (statSync(file).mtimeMs < limit) unlinkSync(file);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valida a forma mínima (o resto é tratado como dado). Descarta agentes sem histórico. */
function sanitize(raw: unknown, sessionId: string): PausaRecord | null {
  if (!isRecord(raw) || raw['sessionId'] !== sessionId || !Array.isArray(raw['agents'])) {
    return null;
  }
  const agents: PausedAgentSnapshot[] = [];
  for (const a of raw['agents']) {
    if (!isRecord(a) || typeof a['label'] !== 'string' || !Array.isArray(a['history'])) continue;
    const kind = a['kind'] === 'principal' ? 'principal' : 'subagente';
    const p = a['profile'];
    const profile =
      isRecord(p) && typeof p['label'] === 'string' && typeof p['goal'] === 'string'
        ? {
            label: p['label'],
            goal: p['goal'],
            ...(typeof p['agent'] === 'string' ? { agent: p['agent'] } : {}),
            ...(typeof p['context'] === 'string' ? { context: p['context'] } : {}),
            ...(typeof p['model'] === 'string' ? { model: p['model'] } : {}),
          }
        : undefined;
    if (kind === 'subagente' && profile === undefined) continue;
    agents.push({
      label: a['label'],
      kind,
      history: a['history'] as HistoryItem[],
      ...(profile ? { profile } : {}),
      pausedAt: typeof a['pausedAt'] === 'number' ? a['pausedAt'] : 0,
    });
  }
  if (agents.length === 0) return null;
  return {
    version: PAUSA_RECORD_VERSION,
    sessionId,
    savedAt: typeof raw['savedAt'] === 'number' ? raw['savedAt'] : 0,
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : 'desconhecido',
    reason: typeof raw['reason'] === 'string' ? raw['reason'] : '',
    ...(typeof raw['resetAtMs'] === 'number' ? { resetAtMs: raw['resetAtMs'] } : {}),
    agents,
  };
}
