// EST-SEC-HARDEN (F23) · AG-0008 — REDAÇÃO at-rest do CONTEÚDO-DE-ARQUIVO no SINK
// do journal de sessão (`~/.aluy/sessions/<id>.json`, `0600`).
//
// CONTEXTO (dogfood real). `run_command` e `web` JÁ redigem a saída na ORIGEM
// (CLI-SEC-6, via `redactOutputSecrets` no core). Mas `read_file`/`grep`/`@attach`
// entregam o conteúdo CRU — by-design p/ o MODELO (o usuário mandou ler o arquivo;
// precisa do conteúdo p/ editar). O GAP é AT-REST: esse conteúdo (que pode ter um
// segredo: `.env`, uma key num arquivo de config, um hit de grep numa credencial)
// é PERSISTIDO em PLAINTEXT na transcrição da sessão — e o `--resume` o relê.
//
// VEREDITO DA SEGURANÇA (AG-0008): redigir o conteúdo desses 3 paths SÓ no CAMINHO
// DE PERSISTÊNCIA (este filtro roda no `save()` do store, ANTES de tocar o disco),
// passando pela MESMA `redactOutputSecrets` (mesmas RULES — a fonte única de
// CLI-SEC-6). NÃO redige o que vai ao MODELO nem o in-memory/in-session (a fidelidade
// do ciclo read→write_file é preservada: o `edit_file` re-lê o REAL). Efeito
// colateral aceitável/desejável: o `--resume` passará a ver o conteúdo REDIGIDO.
//
// CIRÚRGICO — só as ENTRADAS DE CONTEÚDO-DE-ARQUIVO. Mexer cegamente em toda entrada
// corromperia edits/metadados; aqui tocamos APENAS os blocos `tool` cujo verbo é de
// LEITURA (`read`/`grep`/`attach`) e SÓ os campos que carregam o conteúdo bruto
// (`result`/`output`/`liveOutput`). `edit`/`bash`/`you`/`aluy`/`note`/… ficam
// INTACTOS. Idempotente (o marcador `REDACTED` não re-casa nenhuma RULE), portável.
//
// PURO: sem I/O. Testável sem fs. (O concreto `SessionStore` o chama no sink.)

import { redactOutputSecrets, redactCommandSecrets } from '@aluy/cli-core';
import type { SessionBlock } from '../session/model.js';

/**
 * F107 — verbos de tool cujo `target` É A LINHA DE COMANDO (não um path). O `target`
 * de um `bash`/`run_command` pode conter um segredo LITERAL (ex.: o modelo emite
 * `curl -H "Authorization: Bearer sk-…"`). Redigido at-rest via `redactCommandSecrets`.
 */
const COMMAND_VERBS: ReadonlySet<string> = new Set(['bash', 'run_command']);

/**
 * Verbos de tool que carregam CONTEÚDO-DE-ARQUIVO CRU (não redigido na origem):
 *  - `read`   ⇒ `read_file` (conteúdo do arquivo);
 *  - `grep`   ⇒ `grep` (linhas casadas — podem conter o segredo);
 *  - `attach` ⇒ `@attach` (conteúdo anexado), se algum dia virar um bloco `tool`.
 *
 * `bash` (`run_command`) e o caminho `web` NÃO entram: já são redigidos na ORIGEM
 * (CLI-SEC-6). `edit` NÃO entra: seu `output`/`result` é diffstat/erro, não conteúdo
 * de leitura — e redigir um diff corromperia a transcrição do edit. Os verbos batem
 * `verbOfTool`/`tool-reporter.verbOf` (fonte única dos rótulos curtos).
 */
// EST-1075 · HR-SEC-5 (ADR-0108) — `headroom_retrieve` (verbo = o próprio nome, via
// `verbOf` default) entrega ao MODELO o `original_content` RE-materializado do cache
// CCR do headroom — que pode conter o segredo que estava num trecho dedupado (ex.: a
// saída de um `run_command` com uma key, comprimida e depois recuperada). O modelo
// PRECISA do conteúdo real (é o ponto do retrieve), mas AT-REST no transcript ele tem
// de ser redigido igual a `read`/`grep` (mesmo gap: conteúdo cru persistido em plaintext
// que o `--resume` relê). Por isso entra aqui — reusa a MESMA `redactOutputSecrets`.
const FILE_CONTENT_VERBS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'attach',
  'headroom_retrieve',
]);

/**
 * `true` se o bloco é uma linha de tool de LEITURA-DE-ARQUIVO (conteúdo cru). Só
 * esses são redigidos no sink. PURO.
 */
function isFileContentToolBlock(b: SessionBlock): boolean {
  return b.kind === 'tool' && FILE_CONTENT_VERBS.has(b.verb);
}

/**
 * Redige (at-rest) os SEGREDOS de uma transcrição ANTES de tocar o disco (CLI-SEC-6):
 *  - CONTEÚDO-DE-ARQUIVO dos blocos `read`/`grep`/`@attach`/`headroom_retrieve`
 *    (`result`/`output`/`liveOutput`) — cru, não redigido na origem — via `redactOutputSecrets`;
 *  - F107 — o COMANDO dos blocos `bang` (`command` digitado pelo usuário, CLI-SEC-9) e o
 *    `target` dos blocos de tool `bash`/`run_command` (a linha de comando) — via
 *    `redactCommandSecrets`. Um segredo LITERAL na linha de comando (ex.: `! curl -H
 *    "Authorization: Bearer sk-…"`, `! psql "postgres://u:senha@…"`) persistia CRU no
 *    journal at-rest, embora o EXPORT (`export-transcript`) e o `undo` já o redijam — a
 *    inconsistência que o F107 fecha. (A SAÍDA do bang/bash já é redigida na ORIGEM.)
 *
 * Preserva a ORDEM e devolve um array NOVO só se algo mudou (não muta a entrada — o
 * in-memory/in-session segue íntegro; preserva a referência quando não há segredo).
 * Idempotente. PURO — sem I/O. NÃO toca `edit` (diffstat) nem `verb`/`status` (metadados).
 */
export function redactFileContentForJournal(
  blocks: readonly SessionBlock[],
): readonly SessionBlock[] {
  let changed = false;
  const out = blocks.map((b) => {
    // (1) Conteúdo de leitura de arquivo — redação de OUTPUT.
    if (b.kind === 'tool' && isFileContentToolBlock(b)) {
      const redResult = redactOutputSecrets(b.result);
      const redOutput = b.output !== undefined ? redactOutputSecrets(b.output) : undefined;
      const redLive = b.liveOutput !== undefined ? redactOutputSecrets(b.liveOutput) : undefined;
      if (redResult === b.result && redOutput === b.output && redLive === b.liveOutput) {
        return b;
      }
      changed = true;
      return {
        ...b,
        result: redResult,
        ...(redOutput !== undefined ? { output: redOutput } : {}),
        ...(redLive !== undefined ? { liveOutput: redLive } : {}),
      };
    }
    // (2) F107 — comando digitado do `! bang`.
    if (b.kind === 'bang') {
      const red = redactCommandSecrets(b.command);
      if (red === b.command) return b;
      changed = true;
      return { ...b, command: red };
    }
    // (3) F107 — linha de comando no `target` de um tool `bash`/`run_command`.
    if (b.kind === 'tool' && COMMAND_VERBS.has(b.verb)) {
      const red = redactCommandSecrets(b.target);
      if (red === b.target) return b;
      changed = true;
      return { ...b, target: red };
    }
    return b;
  });
  // Sem nenhuma mudança ⇒ devolve o array ORIGINAL (sem alocação nova desnecessária).
  return changed ? out : blocks;
}
