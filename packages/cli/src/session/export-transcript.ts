// EST-1000 · ADR-0076 §4 / Sinal de segurança · CLI-SEC-6 / RES-C-1 — `/export` REDIGIDO.
//
// No cockpit a conversa NÃO vive mais no scrollback NATIVO do terminal (perde-se o
// copy-paste nativo, ADR-0076 §4). O `/export` (+ ctrl+s) é a compensação: grava o
// TRANSCRIPT LIMPO num arquivo, p/ o usuário copiar de lá.
//
// GATE DO `seguranca` (ADR-0076 §Sinal de segurança, RES-C-1): o transcript exportado
// PASSA PELA REDAÇÃO CLI-SEC-6 ANTES de ser gravado — nenhum segredo/token/`.env` que
// foi redigido na tela aparece EM CLARO no arquivo. Reusamos a MESMA fonte de verdade
// (`redactCommandSecrets`/`redactOutputSecrets` do `@aluy/cli-core`, a redação canônica
// da EST-0960b/0982) — NÃO há regra de redação divergente aqui. Caso de teste
// obrigatório: exportar uma sessão que conteve um segredo ⇒ o arquivo NÃO contém o
// segredo cru (`export-redaction.test.ts`).
//
// PURO: este módulo só TRANSFORMA blocos → texto markdown redigido (sem I/O). A escrita
// do arquivo (que passa pela CATRACA — efeito `decide()`) e o caminho default
// (`~/.aluy/exports/<sessão>-<ts>.md`) moram no wiring/IO. Separar a transformação pura
// torna o GATE de redação testável sem disco.

import { cleanAluyForDisplay, redactOutputSecrets } from '@aluy/cli-core';
import type { SessionBlock } from './model.js';

/** Metadados de cabeçalho do export (sessão/data) — só DADO DE UI, nunca credencial (HG-2). */
export interface ExportHeader {
  /** Id da sessão (chave do `~/.aluy/sessions/<id>.json`) — não é segredo. */
  readonly sessionId?: string;
  /** Rótulo de identificação (`/rename`) — dado de UI. */
  readonly label?: string;
  /** Tier em uso (HG-2: só o tier, nunca o provider/modelo de roteamento). */
  readonly tier?: string;
  /** Timestamp ISO do export (injetável p/ teste determinístico). */
  readonly exportedAt?: string;
}

/**
 * Redige UM trecho livre de texto pela redação canônica CLI-SEC-6. `redactOutputSecrets`
 * é a MESMA `redactCommandSecrets` (cobre tokens nus, Authorization, env-inline, URLs
 * com segredo, etc.) — defesa-em-profundidade idêntica à da TUI/journal. Idempotente.
 */
function redact(text: string): string {
  return redactOutputSecrets(text);
}

/** Converte UM bloco da sessão em linhas markdown REDIGIDAS (texto limpo, sem ANSI). */
function blockToLines(block: SessionBlock): string[] {
  switch (block.kind) {
    case 'testrun': {
      // EST-RT-3 — o bloco de testes vira UMA linha de placar no transcript exportado
      // (o detalhe das falhas mora na observação ao modelo, já redigida). Placar exato.
      const s = block.score;
      if (s.unknownFormat)
        return [`## testes`, '', 'placar indisponível (formato não reconhecido)', ''];
      return [`## testes`, '', `${s.passed} ✓ · ${s.failed} ✗ · ${s.total} total`, ''];
    }
    case 'you':
      return [`## você`, '', redact(block.text), ''];
    case 'aluy':
      // turnos de auto-verificação interna (selfCheck) não são resposta ao usuário —
      // fora do transcript visível (espelha o controller, que os remove).
      if (block.selfCheck) return [];
      // `cleanAluyForDisplay` ANTES do redact: remove o RACIOCÍNIO `<think>` e o bloco
      // CRU de tool-call (modelos de raciocínio — granito/MiMo) p/ o transcript exportado
      // bater com o que o usuário VIU na tela (#358). Fortalece a redação de quebra (um
      // segredo dentro do `<think>` já some no clean, antes do redact). Strict-aditivo.
      return [`## aluy`, '', redact(cleanAluyForDisplay(block.text)), ''];
    case 'tool': {
      const head = `- \`${redact(block.verb)} ${redact(block.target)}\` → ${redact(block.result)} (${block.status})`;
      // EST-1000 (hunt) — quando a tool ainda está `running` (ex.: ctrl+s no cockpit COM
      // um `run_command` em voo), o `output` final ainda não existe: a saída visível na
      // tela mora em `liveOutput` (a cauda ao vivo, JÁ redigida pelo core). Sem isto o
      // export DESCARTAVA SILENCIOSO o que o usuário tinha na frente — transcript infiel.
      // `output` e `liveOutput` são MUTUAMENTE EXCLUSIVOS (ao resolver, o `liveOutput` é
      // descartado e o `output` final entra), então o fallback não duplica. Passa por
      // `redact()` no SINK (defesa-em-profundidade, igual ao `output` e ao journal-redact):
      // mesmo um segredo partido entre chunks (que escapou da redação POR-CHUNK do core)
      // é re-redigido antes de ir ao arquivo.
      const content = block.output ?? block.liveOutput;
      const out = content ? ['', '```', redact(content), '```'] : [];
      return [head, ...out, ''];
    }
    case 'bang': {
      // o comando EXATO do `!atalho` pode ter segredo na linha (CLI-SEC-6/RES-C-1).
      const head = `- \`! ${redact(block.command)}\` (${block.status})`;
      // EST-1000 (hunt) — idem ao `tool`: um `!comando` em voo (ctrl+s durante a execução)
      // só tem `liveOutput` (saída ao vivo redigida pelo core); sem o fallback o export
      // perdia a saída visível. Mutuamente exclusivo com `output`; re-redigido no sink.
      const content = block.output ?? block.liveOutput;
      const out = content ? ['', '```', redact(content), '```'] : [];
      return [head, ...out, ''];
    }
    case 'deny':
      return [`- (negado) \`${redact(block.verb)} ${redact(block.exact)}\``, ''];
    case 'subagents':
      return [
        `- sub-agentes: ${block.children
          .map((c) => `${redact(c.label)} (${c.status})`)
          .join(', ')}`,
        '',
      ];
    case 'broker-error':
      return [`> erro de broker: ${redact(block.headline ?? block.message)}`, ''];
    case 'note':
      return [`> ${redact(block.title)}`, ...block.lines.map((l) => `> ${redact(l)}`), ''];
    case 'inject':
      return [`> (encaixado) ${redact(block.text)}`, ''];
    case 'doctor':
      return [
        `> doctor: ${block.checks.map((c) => `${redact(c.label)} ${c.status}`).join(' · ')}`,
        '',
      ];
  }
}

/**
 * Monta o transcript MARKDOWN REDIGIDO de uma sessão a partir dos seus blocos. Cada
 * trecho passa pela redação CLI-SEC-6 (RES-C-1) ANTES de entrar — o resultado é seguro
 * p/ gravar em arquivo. PURO/determinístico (com `exportedAt` injetado).
 *
 * Cabeçalho leve: marca + sessão/tier/data (só dado de UI; HG-2 — nunca provider). O
 * corpo é a conversa em ordem cronológica.
 */
export function buildTranscript(
  blocks: readonly SessionBlock[],
  header: ExportHeader = {},
): string {
  const when = header.exportedAt ?? new Date().toISOString();
  const lines: string[] = ['# Aluy Cli — transcript', ''];
  const metaParts: string[] = [];
  if (header.label !== undefined && header.label !== '')
    metaParts.push(`sessão: ${redact(header.label)}`);
  if (header.sessionId !== undefined && header.sessionId !== '')
    metaParts.push(`id: ${header.sessionId}`);
  if (header.tier !== undefined && header.tier !== '')
    metaParts.push(`tier: ${redact(header.tier)}`);
  metaParts.push(`exportado: ${when}`);
  lines.push(`> ${metaParts.join(' · ')}`, '');
  lines.push(
    '> por segurança, eventuais segredos foram substituídos por ‹redigido›.',
    '',
    '---',
    '',
  );
  for (const block of blocks) {
    for (const line of blockToLines(block)) lines.push(line);
  }
  // Garante terminação em uma única quebra de linha (arquivo limpo).
  let body = lines.join('\n');
  body = body.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n';
  return body;
}
