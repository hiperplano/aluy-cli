// EST-0960a · ADR-0056 · #1 (a TRAVA REAL) — CIFRA dos blobs do journal em repouso.
//
// O gate FORTE do `seguranca` provou que blindar a LEITURA de `~/.aluy/` por regex
// é estruturalmente furável. A trava de verdade é cifrar: mesmo que o matcher fure
// e o agente leia o blob, o que volta é LIXO CIFRADO. Esta bateria prova:
//   (a) o que o STORE recebe (vai p/ o disco) é CIPHERTEXT — a string-segredo em
//       claro NÃO aparece no blob;
//   (b) `restore` DECIFRA corretamente na sessão viva (round-trip exato);
//   (c) a CHAVE não vive em nenhum artefato da sessão (não aparece no blob nem na
//       pilha; o objeto cipher não serializa a chave);
//   (d) IV ÚNICO por blob — dois `seal` do MESMO plaintext dão ciphertext
//       diferente (nonce nunca reusado sob a mesma chave).

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JournalCipher,
  SnapshotJournal,
  writeFileTool,
  type BlobRef,
  type JournalEntry,
  type JournalStorePort,
  type RestoreWriterPort,
} from '../../src/agent/index.js';
import type { WorkspacePort } from '../../src/agent/journal/workspace-port.js';
import { MemoryFs, makePorts } from './helpers.js';

/** Store em memória que guarda EXATAMENTE os bytes que recebe (o que iria p/ o disco). */
class MemoryStore implements JournalStorePort {
  readonly blobs = new Map<BlobRef, string>();
  readonly entries: JournalEntry[] = [];
  private seq = 0;
  hash(content: string): string {
    let h = 0;
    for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
    return `h${h}:${content.length}`;
  }
  async putBlob(content: string): Promise<BlobRef> {
    const ref = `b${this.seq++}`;
    this.blobs.set(ref, content);
    return ref;
  }
  async getBlob(ref: BlobRef): Promise<string> {
    const v = this.blobs.get(ref);
    if (v === undefined) throw new Error(`blob ausente: ${ref}`);
    return v;
  }
  async appendEntry(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
  }
  async deleteBlob(ref: BlobRef): Promise<void> {
    this.blobs.delete(ref);
  }
  async cleanup(): Promise<void> {
    this.blobs.clear();
  }
  async loadEntries(): Promise<readonly JournalEntry[]> {
    return this.entries;
  }
  async gcOrphans(): Promise<void> {}
}

function fakeWorkspace(root = '/ws'): WorkspacePort {
  return {
    root,
    resolveInside(requested: string): string {
      if (requested.includes('..') || requested.startsWith('/etc')) {
        throw new Error(`escape: ${requested}`);
      }
      return requested.startsWith('/') ? requested : `${root}/${requested}`;
    },
    contains(requested: string): boolean {
      try {
        this.resolveInside(requested);
        return true;
      } catch {
        return false;
      }
    },
  };
}

class CapturingRestoreWriter implements RestoreWriterPort {
  readonly writes: { path: string; content: string }[] = [];
  readonly removes: string[] = [];
  constructor(private readonly ws: WorkspacePort) {}
  async writeConfined(requested: string, content: string): Promise<string> {
    const safe = this.ws.resolveInside(requested);
    this.writes.push({ path: safe, content });
    return safe;
  }
  async removeConfined(requested: string): Promise<string> {
    const safe = this.ws.resolveInside(requested);
    this.removes.push(safe);
    return safe;
  }
}

const SECRET = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('EST-0960a · #1 — cifra dos blobs do journal (a trava real)', () => {
  it('(a) o blob que VAI P/ O STORE (disco) é ciphertext — o segredo em claro NÃO aparece', async () => {
    const store = new MemoryStore();
    const journal = new SnapshotJournal({ store, workspace: fakeWorkspace() });
    const fs = new MemoryFs(new Map([['.env', SECRET]]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };

    await writeFileTool.run({ path: '.env', content: 'REDACTED', overwrite: true }, ports);

    // o que o store guardou (= o que um `cat` do blob no disco devolveria).
    const entry = journal.top()!;
    if (entry.kind !== 'edit') throw new Error('esperava edit');
    const onDisk = store.blobs.get(entry.targets[0]!.beforeRef)!;

    // NÃO é o plaintext — nem o segredo inteiro, nem o pedaço discriminante.
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain('wJalrXUtnFEMI');
    expect(onDisk).not.toContain('AWS_SECRET');
    // é base64 opaco (ciphertext), não-vazio.
    expect(onDisk.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9+/=]+$/.test(onDisk)).toBe(true);
  });

  it('(b) restore DECIFRA corretamente na sessão viva (round-trip exato)', async () => {
    const store = new MemoryStore();
    const ws = fakeWorkspace();
    const writer = new CapturingRestoreWriter(ws);
    const journal = new SnapshotJournal({ store, workspace: ws, restoreWriter: writer });
    const fs = new MemoryFs(new Map([['.env', SECRET]]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };

    await writeFileTool.run({ path: '.env', content: 'REDACTED', overwrite: true }, ports);
    const out = await journal.restore(journal.top()!);

    expect(out.action).toBe('written');
    // o conteúdo restaurado é EXATAMENTE o antes (decifrado), não o ciphertext.
    expect(writer.writes).toEqual([{ path: '/ws/.env', content: SECRET }]);
  });

  it('(c) a CHAVE não vive em nenhum artefato da sessão (blob/pilha/objeto)', async () => {
    // chave conhecida (injetada) p/ poder PROCURAR seus bytes nos artefatos.
    const key = randomBytes(32);
    const cipher = new JournalCipher(key);
    const store = new MemoryStore();
    const journal = new SnapshotJournal({ store, workspace: fakeWorkspace(), cipher });
    const fs = new MemoryFs(new Map([['.env', SECRET]]));
    const ports = { ...makePorts({ fs }).ports, journal: journal.toolPort };
    await writeFileTool.run({ path: '.env', content: 'REDACTED', overwrite: true }, ports);

    const keyHex = key.toString('hex');
    const keyB64 = key.toString('base64');
    // nenhum blob nem registro da pilha contém os bytes da chave (hex/base64/latin1).
    for (const blob of store.blobs.values()) {
      expect(blob).not.toContain(keyB64);
      expect(Buffer.from(blob, 'base64').toString('hex')).not.toContain(keyHex);
    }
    const stackText = JSON.stringify(store.entries);
    expect(stackText).not.toContain(keyHex);
    expect(stackText).not.toContain(keyB64);
    // o próprio objeto cipher não serializa a chave (defesa contra log acidental).
    expect(String(cipher)).toBe('[JournalCipher]');
    expect(JSON.stringify(cipher)).toBe('"[JournalCipher]"');
    expect(JSON.stringify(cipher)).not.toContain(keyHex);
  });

  it('(d) IV ÚNICO por blob: selar o MESMO plaintext 2× dá ciphertext diferente', () => {
    const cipher = new JournalCipher(randomBytes(32));
    const a = cipher.seal(SECRET);
    const b = cipher.seal(SECRET);
    expect(a).not.toBe(b); // nonce não reusado
    // ambos decifram p/ o mesmo plaintext (round-trip), apesar do ciphertext diferir.
    expect(cipher.open(a)).toBe(SECRET);
    expect(cipher.open(b)).toBe(SECRET);
    // e os 12 bytes de IV (cabeçalho) são de fato distintos.
    const ivA = Buffer.from(a, 'base64').subarray(0, 12).toString('hex');
    const ivB = Buffer.from(b, 'base64').subarray(0, 12).toString('hex');
    expect(ivA).not.toBe(ivB);
  });

  it('GCM autentica: um blob ADULTERADO no disco falha o open (não decifra lixo)', () => {
    const cipher = new JournalCipher(randomBytes(32));
    const sealed = cipher.seal(SECRET);
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 0xff; // mexe 1 byte do ciphertext
    const tampered = raw.toString('base64');
    expect(() => cipher.open(tampered)).toThrow();
  });

  it('chave de OUTRA sessão não abre o blob (isolamento por sessão)', () => {
    const sealed = new JournalCipher(randomBytes(32)).seal(SECRET);
    const other = new JournalCipher(randomBytes(32));
    expect(() => other.open(sealed)).toThrow();
  });

  it('rejeita chave de tamanho errado (fail-safe na construção)', () => {
    expect(() => new JournalCipher(randomBytes(16))).toThrow(/32 bytes/);
  });
});
