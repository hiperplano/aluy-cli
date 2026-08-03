// ADR-0158 §9/§10 — FORMATADOR PURO do "MANIFESTO VISÍVEL": o que um serviço
// DECLARA, mostrado ANTES de qualquer confirmação de `install` — análogo ao "efeito
// exato mostrado na confirmação" da catraca (CLI-SEC-9). Instalar de um repo git é
// instalar CÓDIGO QUE RODA (§9); o dono vê daemons (comando/porta), skills COM
// script próprio, presença de `mcp.json`, canal e autonomia antes de aceitar.
//
// O ESCANEAMENTO do diretório (ler `daemons/*/daemon.md`, listar `skills/`, checar
// `mcp.json`) é I/O — fica no locus concreto (@hiperplano/aluy-cli, `io/services-store.ts`
// ou o runner de `aluy service install`). Este módulo só FORMATA o que já foi lido.
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O).

import type { ServiceManifest } from './service-parse.js';

/** Um daemon PRÓPRIO do usuário declarado em `daemons/<nome>/daemon.md` (ADR-0158 §6). */
export interface ServiceDaemonDeclared {
  readonly name: string;
  /** `command:` do `daemon.md`, se legível. */
  readonly command?: string;
  /** `port:` do `daemon.md`, se legível. */
  readonly port?: string;
}

/** Uma skill declarada em `skills/<nome>/` — o que importa aqui é SE tem script próprio. */
export interface ServiceSkillDeclared {
  readonly name: string;
  /** `true` quando há algum arquivo além do `SKILL.md` (script do dono, ADR-0158 §1). */
  readonly hasScript: boolean;
}

/** O DADO já escaneado do diretório-candidato a serviço (por `install`, antes de ativar). */
export interface ServiceManifestVisibleInput {
  readonly manifest: ServiceManifest;
  readonly daemons: readonly ServiceDaemonDeclared[];
  readonly skills: readonly ServiceSkillDeclared[];
  /** `true` se `mcp.json` existe no diretório do serviço (servers ESCOPADOS ao serviço, §2). */
  readonly hasMcp: boolean;
}

/** Uma nota (título + linhas) — espelha o `SlashNote` do @hiperplano/aluy-cli, sem acoplar a ele. */
export interface ServiceManifestVisibleNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * FORMATA o manifesto visível: canal, autonomia, agenda, tunáveis/circuit-breakers,
 * daemons (comando+porta — processos FORA da catraca, §6/§Consequências), skills
 * COM script próprio, e presença de `mcp.json`. PURO/determinístico — a ORDEM das
 * linhas é estável (útil p/ teste e p/ o dono comparar duas instalações).
 */
export function buildServiceManifestVisibleNote(
  input: ServiceManifestVisibleInput,
): ServiceManifestVisibleNote {
  const { manifest: m } = input;
  const lines: string[] = [];

  lines.push(`nome: ${m.name}`);
  if (m.description !== undefined) lines.push(`descrição: ${m.description}`);
  lines.push(`schedule: ${m.schedule ?? '(não declarado)'}`);
  lines.push(`until: ${m.until ?? '(não declarado)'}`);
  lines.push(`workflow do turno: ${m.workflow ?? '(não declarado)'}`);
  lines.push(`canal: ${m.channel ?? '(NENHUM — sem canal, sem onde reportar/perguntar)'}`);
  lines.push(`autonomia: ${m.autonomy ?? '(não declarada)'}`);
  lines.push(`budget: ${m.budget ?? '(não declarado)'}`);
  lines.push(`teto por atividade: ${m.activityTimeout ?? '30min (default)'}`);

  if (m.tunables.length > 0) {
    lines.push(`tunáveis/circuit-breakers (${m.tunables.length}):`);
    for (const t of m.tunables) {
      const faixa =
        t.min !== undefined && t.max !== undefined ? ` [${t.min}..${t.max}]` : ' (fixo, sem faixa)';
      lines.push(`  · ${t.key}: ${t.value}${faixa}`);
    }
  }

  lines.push('');
  if (input.daemons.length > 0) {
    lines.push(
      `⚠ daemons PRÓPRIOS do usuário (${input.daemons.length}) — rodam como processo do ` +
        `usuário, FORA da catraca:`,
    );
    for (const d of input.daemons) {
      const cmd = d.command ?? '(command: não declarado)';
      const port = d.port !== undefined ? ` · porta ${d.port}` : '';
      lines.push(`  · ${d.name}: ${cmd}${port}`);
    }
  } else {
    lines.push('daemons próprios: nenhum');
  }

  const withScript = input.skills.filter((s) => s.hasScript);
  if (withScript.length > 0) {
    lines.push(`⚠ skills COM SCRIPT PRÓPRIO (${withScript.length}) — código que o agente invoca:`);
    for (const s of withScript) lines.push(`  · ${s.name}`);
  } else {
    lines.push('skills com script próprio: nenhuma');
  }

  lines.push(
    `mcp.json (servers MCP escopados a este serviço): ${input.hasMcp ? 'presente' : 'ausente'}`,
  );

  lines.push('');
  lines.push('instalar é ato de CONFIANÇA explícito: scripts de skill');
  lines.push('passam pela catraca quando invocados; os daemons acima NÃO — rodam como qualquer');
  lines.push('software instalado na máquina. Revise antes de confirmar.');

  return { title: `manifesto visível — ${m.name}`, lines };
}
