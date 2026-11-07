// ADR 0005 — o que o MODELO sabe dos segredos do `/secret`: só os NOMES, na cauda dinâmica
// do prompt (depois de todo o conteúdo estável — não invalida o cache de prefixo do
// provider). Sem segredos ⇒ nenhuma linha (prompt idêntico ao de antes).

import { secretVault } from './vault.js';

/** Linhas do bloco de segredos para o `system` (vazio quando o cofre está vazio). */
export function secretsPromptBlock(): string[] {
  const names = secretVault.names();
  if (names.length === 0) return [];
  const lista = names.map((n) => `$${n}`).join(', ');
  return [
    '',
    `SEGREDOS DO DONO (/secret): existem como variável de ambiente no shell do run_command: ${lista}.`,
    'Para usar, ponha `$NOME` no comando (ex.: `curl -H "Authorization: Bearer $API_KEY" …`).',
    'Você NÃO tem o valor e NUNCA deve pedi-lo ao usuário, nem tentar imprimi-lo ou transformá-lo',
    '(echo, env, base64, rev…): a saída é redigida e todo comando que cita o nome pede a aprovação',
    'do usuário. Se precisar de um segredo que não está na lista, peça para o usuário rodar `/secret NOME`.',
  ];
}
