// ADR-0158 §5 pt.4 (emenda) — RUNNER (fase 2): `activity-timeout:` do `service.md`
// (ex.: "45m", "2h", "sem-teto") vira o TETO anti-runaway POR ATIVIDADE que
// `resolveActivityTimeout` (runner.ts) usa no lugar do default `MAX_ACTIVITY_MS`.
// Achado em dogfooding: o dono quer o fundo rodando 24/7, sem corte de 30min por
// atividade — `sem-teto` é a saída EXPLÍCITA (nunca um número gigante simulando
// infinito, evitando o mesmo overflow de 32-bit do `setTimeout` já corrigido
// alhures pro sleep entre ciclos).
//
// PORTÁVEL (ADR-0053 §8): parser de string puro (sem `node:*`, sem I/O).

import { parseDuration } from '../cycle/cycle-parse.js';

/**
 * Parseia o `activity-timeout:` cru do `service.md` num teto de ms, `'unlimited'`,
 * ou `undefined`. `undefined` (campo ausente OU malformado) ⇒ o CALLER cai no
 * default `MAX_ACTIVITY_MS` — mesma tolerância semântica de `parseServiceBudget`
 * (RES-MD-3 já validou a FORMA estrutural no parser do manifesto; aqui é
 * semântica, nunca lança). `"sem-teto"` (case-insensitive) ⇒ `'unlimited'` —
 * literal, nunca um número gigante simulando infinito. Reusa `parseDuration`
 * (`5m`/`30s`/`1h`/`90`) — mesma gramática de duração do `/cycle`.
 */
export function parseServiceActivityTimeout(
  raw: string | undefined,
): number | 'unlimited' | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (SEM_TETO.has(trimmed.toLowerCase())) return 'unlimited';
  return parseDuration(trimmed);
}

/**
 * SEM-TETO-EM-INGLÊS (dogfooding real, custou um pregão) — a CHAVE é inglês
 * (`activity-timeout`) e o único valor aceito era PORTUGUÊS (`sem-teto`). O dono
 * escreveu `activity-timeout: unlimited`, que é o que a chave induz a escrever, e o
 * valor caiu no `parseDuration` → `undefined` → default de 30min, EM SILÊNCIO.
 *
 * O efeito não foi cosmético: a vigília do serviço de execução bloqueia até um horário
 * do relógio (~40min), estourou o teto de 1800s que não deveria existir, o turno
 * encerrou em `limit` e o runner DERRUBOU os 10 daemons. A mesa fechou às 14:21 num
 * pregão que ia até 17:40, e ninguém percebeu por 25 minutos.
 *
 * Aceitar as duas grafias é o mínimo. O conserto que importa é o `warnUnrecognized`
 * abaixo: valor não reconhecido tem que FALAR, não cair no default calado.
 */
const SEM_TETO: ReadonlySet<string> = new Set(['sem-teto', 'unlimited', 'none', 'off']);

/**
 * SEM-TETO-EM-INGLÊS — devolve o AVISO quando o valor existe mas não foi entendido
 * (portanto o caller vai usar o default de 30min sem o dono saber). `undefined` quando
 * não há o que avisar: campo ausente, ou valor legítimo.
 *
 * Existe separado do parser porque o parser é PURO e sem canal de saída — quem tem log
 * é o runner. Assim o aviso aparece no `runner.log`, que é onde o dono procura.
 */
export function avisoActivityTimeout(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (parseServiceActivityTimeout(raw) !== undefined) return undefined;
  return (
    `"activity-timeout: ${trimmed}" NÃO foi entendido — usando o teto padrão de 30min. ` +
    `Use uma duração (\`45m\`, \`2h\`, \`90\`) ou ${[...SEM_TETO].map((s) => `\`${s}\``).join(' / ')}.`
  );
}
