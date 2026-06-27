// EST-0960a · ADR-0056 · #1 (a TRAVA REAL) — CIFRA dos blobs do journal em repouso.
//
// O gate FORTE do `seguranca` cravou: blindar a LEITURA de `~/.aluy/` por regex de
// shell é estruturalmente furável (família "barra final", montagem em runtime). A
// trava de VERDADE não é o matcher — é cifrar o conteúdo-antes. Mesmo que o regex
// fure e o agente leia `~/.aluy/undo/.../blobs/b0`, o que volta é LIXO CIFRADO; o
// segredo capturado não é exfiltrável por NENHUM canal de leitura.
//
// MECÂNICA (toda no core portável — a chave e o selar/abrir vivem AQUI; o store
// concreto em @hiperplano/aluy-cli só grava/lê BYTES OPACOS, §6 do ADR / fronteira modular):
//   - CHAVE DE SESSÃO: 32 bytes de `crypto.randomBytes` gerados na construção do
//     `SnapshotJournal`. Vive SÓ na memória do processo — NUNCA escrita no disco,
//     NUNCA logada, NUNCA no `stack.jsonl`. Morre com o processo (o journal já é
//     per-sessão/efêmero — é exatamente o escopo da chave).
//   - AES-256-GCM (Node `crypto` built-in — sem dep nova, Q9 limpo). Cada blob
//     usa um IV ÚNICO (12 bytes aleatórios — nonce nunca reusado sob a mesma
//     chave, condição de segurança do GCM). O auth tag (16 bytes) detecta
//     adulteração: um blob mexido no disco falha o `open` (não decifra lixo).
//
// FORMATO opaco do blob selado (o store grava/lê esta string como bytes opacos):
//     base64( IV[12] ‖ TAG[16] ‖ CIPHERTEXT )
// O store NÃO conhece este layout — só vê uma string e a persiste 0600 atômico.
//
// PORTÁVEL? Usa `node:crypto` (built-in, permitido pela fronteira — só Ink/React/
// readline/tty são proibidos no core; o store concreto de I/O é que mora no cli).

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/** Algoritmo AEAD: AES-256 em modo GCM (cifra + autenticação num passo). */
const ALGORITHM = 'aes-256-gcm';
/** Tamanho da chave de sessão (256 bits). */
const KEY_BYTES = 32;
/** Tamanho do IV/nonce do GCM (96 bits — recomendado p/ AES-GCM). */
const IV_BYTES = 12;
/** Tamanho do auth tag do GCM (128 bits). */
const TAG_BYTES = 16;

/**
 * Cifra de sessão dos blobs do journal. Detém a CHAVE EFÊMERA (só em memória) e
 * sela/abre conteúdo com AES-256-GCM. O `SnapshotJournal` instancia uma por
 * sessão; ela NUNCA expõe a chave (sem getter, sem serialização — `toString`/
 * `toJSON` neutralizados p/ a chave jamais vazar por log/telemetria acidental).
 */
export class JournalCipher {
  /** A chave de sessão (32 bytes). PRIVADA — nunca exposta, nunca serializada. */
  readonly #key: Buffer;

  /**
   * @param key chave de 32 bytes. Default: 32 bytes de `crypto.randomBytes`
   *   (CSPRNG). Injetável SÓ p/ teste determinístico (round-trip/IV-único); em
   *   produção o default aleatório é o caminho — a chave nasce e morre na sessão.
   */
  constructor(key?: Buffer) {
    if (key !== undefined) {
      if (key.length !== KEY_BYTES) {
        throw new Error(`chave do journal deve ter ${KEY_BYTES} bytes (recebeu ${key.length}).`);
      }
      // Cópia defensiva: o chamador não retém referência mutável à chave interna.
      this.#key = Buffer.from(key);
    } else {
      this.#key = randomBytes(KEY_BYTES);
    }
  }

  /**
   * SELA o `plaintext`: cifra com AES-256-GCM sob um IV NOVO e aleatório (nonce
   * único por blob — nunca reusado). Devolve uma string opaca base64 com o layout
   * `IV ‖ TAG ‖ CIPHERTEXT` — é o que o store grava como bytes opacos. Um `cat`
   * desse blob no disco devolve esta string cifrada, não o segredo.
   */
  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
  }

  /**
   * ABRE um blob selado por `seal` (decifra NA SESSÃO VIVA — a chave em memória).
   * Verifica o auth tag do GCM: um blob adulterado/truncado, ou selado por outra
   * chave (outra sessão), LANÇA em vez de devolver lixo. Round-trip exato de
   * `seal`.
   */
  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new Error('blob do journal corrompido ou truncado (cabeçalho cifrado inválido).');
    }
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /**
   * Neutraliza serialização acidental da chave (defesa-em-profundidade contra
   * log/telemetria): `String(cipher)`/`JSON.stringify(cipher)` NUNCA revelam a
   * chave. Sem isto, um `console.log(journal)` poderia despejar bytes da chave.
   */
  toString(): string {
    return '[JournalCipher]';
  }
  toJSON(): string {
    return '[JournalCipher]';
  }
}
