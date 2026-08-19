// EST-1015-bis (auditoria "clareza p/ o MODELO") — o fix do `update_plan` (plan.ts,
// `extrairLista`/`descreveRecebido`) achou DOIS defeitos que se repetiam em quase toda
// tool nativa: (1) a validação rejeitava formas em que um modelo BARATO erra — array
// aninhado stringificado, objeto com chaves numéricas no lugar de array, booleano como
// texto ("true"), número onde se espera string; (2) o erro NÃO dizia o que CHEGOU, então
// o modelo não tinha o que corrigir e repetia a MESMA chamada até desistir.
//
// Este módulo CENTRALIZA os dois consertos p/ reuso (DRY) — cada tool escolhe QUAIS
// formas aceitar (sinônimo de campo, coerção de tipo). A REGRA que governa (documentada
// no fix original, vale aqui igual): recuperar SÓ quando a intenção é INEQUÍVOCA; nunca
// "inventar" quando é ambígua. Por isso os helpers são PEQUENOS e EXPLÍCITOS — cada tool
// passa a lista de chaves-sinônimo que faz sentido PARA ELA (ex.: `content` NÃO é
// sinônimo aceitável de `new_string` no edit_file: historicamente `content` significava
// "arquivo INTEIRO" na API antiga — perigosa e removida por perda de dados — então
// aceitar esse nome aqui reviveria a AMBIGUIDADE que o bug-fix original matou).
//
// PURO — sem I/O, sem porta. Input do modelo = NÃO-confiável (boundary).

/**
 * Lê uma string OBRIGATÓRIA testando várias chaves-sinônimo em ordem (a 1ª que bater
 * vence). Tolera um NÚMERO (coage p/ string via `String()` — determinístico, sem
 * ambiguidade) mas não objeto/array/boolean (esses não têm forma textual óbvia).
 * Devolve `undefined` só quando NENHUMA chave bateu (string vazia inclusive).
 */
export function strOpt(
  input: Readonly<Record<string, unknown>>,
  chaves: readonly string[],
): string | undefined {
  for (const c of chaves) {
    const v = input[c];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** Como `strOpt`, mas exige NÃO-VAZIO (uso: campos onde "" não faz sentido, ex. path). */
export function strReq(
  input: Readonly<Record<string, unknown>>,
  chaves: readonly string[],
): string | undefined {
  const v = strOpt(input, chaves);
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * Lê um BOOLEANO tolerando o texto "true"/"false" (qualquer caixa) — o modelo que
 * serializa o objeto todo como texto costuma stringificar os booleanos junto. Só os
 * DOIS literais exatos contam; qualquer outra coisa cai no `default_` (nunca inventa
 * um valor a partir de texto ambíguo).
 */
export function boolDeChave(
  input: Readonly<Record<string, unknown>>,
  chave: string,
  default_ = false,
): boolean {
  const v = input[chave];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return default_;
}

/**
 * Extrai uma LISTA de um valor cru isolado, tolerando as duas formas MEDIDAS como erro
 * comum de modelo barato (mesma classe do `extrairLista` do update_plan, ver plan.ts):
 *   - array de verdade                    → devolve como está
 *   - TEXTO "[...]"                       → o modelo stringificou o array aninhado
 *   - objeto com chaves numéricas "0","1" → array perdido na serialização
 * `undefined` quando a forma não é reconhecível (não inventa lista a partir de texto
 * solto — ver a mesma discussão em plan.ts sobre `steps: "nope"`).
 */
export function listaDeValor(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try {
        const v: unknown = JSON.parse(s);
        if (Array.isArray(v)) return v;
      } catch {
        /* não era JSON — não é lista reconhecível */
      }
    }
    return undefined;
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const chaves = Object.keys(o);
    if (chaves.length > 0 && chaves.every((k) => /^\d+$/.test(k))) {
      return chaves.sort((a, b) => Number(a) - Number(b)).map((k) => o[k]);
    }
  }
  return undefined;
}

/** Como `listaDeValor`, testando várias chaves-sinônimo em ordem (a 1ª que bater vence). */
export function listaDeChaves(
  input: Readonly<Record<string, unknown>>,
  chaves: readonly string[],
): unknown[] | undefined {
  for (const c of chaves) {
    const v = listaDeValor(input[c]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Descreve o que CHEGOU no input, sem vazar conteúdo longo — para o erro de validação
 * ser ACIONÁVEL. Sem isso o modelo não sabe o que corrigir e repete a MESMA chamada
 * (foi exatamente o bug medido no update_plan: 4 tentativas idênticas até desistir).
 */
export function descreveRecebido(input: Readonly<Record<string, unknown>>): string {
  const chaves = Object.keys(input);
  if (chaves.length === 0) return 'nenhum argumento';
  const partes = chaves.slice(0, 4).map((k) => {
    const v = input[k];
    const tipo = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    const amostra = typeof v === 'string' ? ` ${JSON.stringify(v.slice(0, 40))}` : '';
    return `${k}=${tipo}${amostra}`;
  });
  return partes.join(', ');
}
