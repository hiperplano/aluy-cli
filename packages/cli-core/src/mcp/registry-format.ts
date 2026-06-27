// EST-0970 (search) — FORMATAÇÃO (pura) do resultado de `aluy mcp search`.
//
// Texto legível p/ a CLI/TUI: por server, nome/versão, descrição, como rodar e a
// LIGAÇÃO com `aluy mcp add` (o comando pronto p/ o usuário copiar/colar). PURO (só
// string) — o I/O (stdout) mora no @aluy/cli. NÃO executa nada: o comando é TEXTO.

import type { RegistrySearchResult, RegistrySearchOutcome } from './registry.js';

/** Monta o comando `aluy mcp add <nome> -- <command> <args...>` p/ um resultado. */
export function addCommandFor(result: RegistrySearchResult): string | undefined {
  const { command, args } = result.run;
  if (command === undefined) return undefined; // só-remoto ⇒ sem comando local p/ `add`.
  const localName = suggestServerName(result.name);
  const parts = [
    'aluy',
    'mcp',
    'add',
    shellQuote(localName),
    '--',
    command,
    ...args.map(shellQuote),
  ];
  return parts.join(' ');
}

/**
 * Sugere um NOME LÓGICO local p/ o server (chave do `mcp.json`) a partir do nome
 * canônico do registro (`io.github.foo/bar-server` ⇒ `bar-server`). Conservador:
 * só `[A-Za-z0-9_-]`; cai p/ "server" se sobrar vazio.
 */
export function suggestServerName(registryName: string): string {
  const tail = registryName.split('/').pop() ?? registryName;
  const cleaned = tail.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'server';
}

/** Aspas simples shell-safe (o token é DADO do registro — nunca interpolado cru). */
function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_./@:+=-]+$/.test(token)) return token; // simples ⇒ sem aspas.
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Renderiza o resultado COMPLETO da busca em texto p/ stdout (CLI). */
export function formatSearchOutcome(outcome: RegistrySearchOutcome): string {
  if (!outcome.ok) {
    // Degradação graciosa: erro legível, sem stack, sem derrubar a CLI.
    return `⚠ ${outcome.reason}\n  Tente de novo em instantes; a busca no registro não bloqueia o resto do aluy.`;
  }
  if (outcome.results.length === 0) {
    return `nenhum server encontrado para "${outcome.query}" no registro oficial MCP.`;
  }

  const lines: string[] = [];
  const n = outcome.results.length;
  lines.push(`${n} server${n === 1 ? '' : 's'} para "${outcome.query}" (registro oficial MCP):`);
  lines.push('');
  for (const r of outcome.results) {
    lines.push(formatOne(r));
    lines.push('');
  }
  lines.push('Para instalar, copie a linha "→ aluy mcp add …" do server desejado.');
  lines.push('A saída do registro é apenas informativa — nada é executado pela busca.');
  return lines.join('\n');
}

/** Formata UM server (bloco). */
function formatOne(r: RegistrySearchResult): string {
  const head = r.version !== undefined ? `${r.name}  (v${r.version})` : r.name;
  const lines: string[] = [`• ${head}`];
  const titleLine = r.title !== undefined && r.title !== r.name ? r.title : undefined;
  if (titleLine !== undefined) lines.push(`    ${titleLine}`);
  if (r.description.length > 0) lines.push(`    ${truncate(r.description, 200)}`);

  const add = addCommandFor(r);
  if (add !== undefined) {
    lines.push(`    → ${add}`);
    if (r.run.transport !== undefined && r.run.transport !== 'stdio') {
      lines.push(
        `      (transporte "${r.run.transport}" — v1 do aluy só pluga servers stdio LOCAIS)`,
      );
    }
    const required = r.run.env.filter((e) => e.required).map((e) => e.name);
    if (required.length > 0) {
      lines.push(`      requer env: ${required.join(', ')} (defina por-server no mcp.json)`);
    }
  } else if (r.run.remoteUrls.length > 0) {
    lines.push(
      `    (server REMOTO: ${r.run.remoteUrls.join(', ')} — fora do v1 de \`aluy mcp add\`)`,
    );
  } else {
    lines.push('    (sem pacote local conhecido — nada a instalar pelo aluy)');
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}
