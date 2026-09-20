// Lê um bloco `run: |` DO PRÓPRIO workflow (não de uma cópia) para que o teste execute o
// script que o runner executa. Compartilhado por release-workflow-publish.test.ts (o passo
// de publish sob `bash -e`) e release-workflow-channel.test.ts (a escolha do canal).
//
// Nasceu duplicado nos dois testes; duplicar um PARSER de YAML é o começo da divergência —
// quem ajusta a indentação do workflow conserta um lado e deixa o outro lendo errado.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function readWorkflow(name: string): string {
  return readFileSync(join(repoRoot, '.github/workflows', name), 'utf8');
}

/** Extrai o bloco `run: |` do passo `name` (dedentado) de um workflow. */
export function extractRunScript(yml: string, name: string): string {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`passo não encontrado: ${name}`);
  const stepIndent = lines[start].indexOf('-');
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== 'run: |') i++;
  const body: string[] = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.search(/\S/) <= stepIndent) break; // próximo passo
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}
