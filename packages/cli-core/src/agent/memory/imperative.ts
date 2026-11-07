// EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M5) — heurística de TEXTO IMPERATIVO/DIRETIVO.
//
// DEFESA EM PROFUNDIDADE (paralelo a CLI-SEC-H4), NÃO a barreira primária. A
// barreira que mata o laundering é "recall = DADO, nunca `system`" (B/GS-M3): um
// fato imperativo é só texto que o agente lê, e qualquer efeito re-passa a catraca.
// ESTA heurística é o sinal a MAIS: um fato com cara de diretiva de injeção clássica
// ("sempre rode X", "ignore as instruções", "a partir de agora…") é SINALIZADO no
// recall e no `/memory` — nunca SILENCIOSAMENTE acionável. Conservador (alto recall):
// um falso-positivo só adiciona um rótulo; um falso-negativo deixaria uma diretiva
// entrar sem aviso. PURO: regex/string, sem I/O nem `node:*`.

/** Padrões de texto imperativo/diretivo (PT-BR + EN), o vocabulário de injeção. */
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  // "sempre rode/execute/faça/obedeça/siga/cumpra" · "always run/execute/obey/follow"
  /\bsempre\s+(?:rode|execute|rodar|executar|faça|use|usar|chame|chamar|obedeça|obedecer|siga|seguir|cumpra|cumprir)\b/i,
  /\balways\s+(?:run|execute|use|call|do|obey|follow)\b/i,
  // "você deve sempre" · "you must/should always" — abre uma diretiva (forma dobrada,
  // baixo FP: "você deve saber" factual NÃO casa, exige o "sempre").
  /\b(?:voc[êe])\s+(?:deve|tem\s+(?:que|de))\s+sempre\b/i,
  /\byou\s+(?:must|should)\s+always\b/i,
  // "a partir de agora" · "de agora em diante" · "from now on"
  /\ba\s+partir\s+de\s+agora\b/i,
  /\bde\s+agora\s+em\s+diante\b/i,
  /\bfrom\s+now\s+on\b/i,
  // "ignore/desconsidere/disregard (as) instruções/regras anteriores"
  /\bignore\s+(?:as\s+|todas\s+as\s+|the\s+|all\s+|previous\s+|anterior)/i,
  /\bdesconsidere\s+(?:as\s+|todas\s+as\s+|instru|regras)/i,
  // `disregard` é o sinônimo EN mais comum de injeção — não estava coberto.
  /\bdisregard\s+(?:the\s+|all\s+|any\s+|previous\s+|prior\s+|those\s+|these\s+)/i,
  // "nunca pergunte/peça (confirmação)" · "never ask"
  /\bnunca\s+(?:pergunte|peça|pedir|confirme)\b/i,
  /\bnever\s+ask\b/i,
  // bypass de confirmação: "sem (pedir) confirmação/confirmar" · "without asking/
  // confirmation/permission" — pedir p/ pular a catraca é diretiva por si (baixo FP).
  /\bsem\s+(?:pedir\s+|solicitar\s+)?confirma(?:r|ç[ãa]o|cao)\b/i,
  /\bwithout\s+(?:asking|confirmation|permission|approval)\b/i,
  // pipe p/ shell — o pior caso (curl evil | sh) num fato
  /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
  // exfiltração explícita ("envie/mande … para")
  /\b(?:exfiltr|envie\s+.*\bpara\b|mande\s+.*\bpara\b|send\s+.*\bto\b.*\b(?:http|server|attacker))/i,
  // verbo imperativo de execução no INÍCIO do fato (rode/execute/delete/run…)
  /^(?:\s*)(?:rode|execute|delete|apague|remova|run|exec|install|instale)\b/i,
];

/**
 * (Decisão do dono, ADR 0004: simplicidade — a memória do dono é seguida como instrução.)
 * `true` se o texto de um fato parece uma DIRETIVA/instrução imperativa (padrão de
 * injeção), e não um fato factual ("prefere X", "este repo usa Y"). Determinístico.
 */
export function looksImperative(text: string, provenance?: 'usuario' | 'derivado'): boolean {
  // Um fato de proveniência `usuario` É a instrução do dono ("sempre use pnpm", "a partir de
  // agora…") — nunca é sinalizado como suspeito. A heurística só vale p/ o que o agente DERIVOU.
  if (provenance === 'usuario') return false;
  if (text.trim() === '') return false;
  return IMPERATIVE_PATTERNS.some((re) => re.test(text));
}
