// F-MEM (emenda) — QUE turno merece virar memória permanente.
//
// O `storeMemory` do loop grava `Objetivo: <mensagem do usuário>\nResultado: <resposta>`
// a CADA turno que termina com resposta final. A única condição era `kind === 'final'`:
// sem filtro de trivialidade, sem deduplicação.
//
// O que isso produziu na máquina do dono, medido em 31/08: o scope deste projeto tinha
// ~100 memórias, e CINCO consultas sem nenhuma relação entre si — "telegram", "mcp
// picker", "flicker", "publicar versao", "ollama" — devolviam 10 resultados cada com UM
// único valor distinto:
//
//     "Objetivo: segue\nResultado: feito."
//
// Ele digitou "segue", o agente respondeu "feito.", e isso virou fato permanente dezenas
// de vezes. Como o `add` usa `infer=False`, o mem0 nem deduplica — registros com o MESMO
// hash entram assim mesmo. O efeito composto é o pior: os clones AFOGAM os fatos reais no
// ranking, então consertar a leitura não bastava; o recall voltava, e voltava ruído.
//
// A regra: o valor de uma memória está no OBJETIVO — é ele que a torna localizável depois.
// "segue" não identifica nada, e nenhum recall futuro vai querer justamente esse turno.
// Um objetivo que é só continuação ("ok", "pode seguir", "vamos") é um ponteiro para o
// turno ANTERIOR, não um fato; guardá-lo é guardar o dedo, não a lua.
//
// Conservador de propósito: na dúvida, MEMORIZA. Perder um fato real é pior que guardar
// um fato morno — o custo do ruído já está capado pelo piso de relevância do recall (F91),
// enquanto um fato descartado não volta nunca.
//
// PURO: (objetivo, resposta) → boolean. Sem I/O, sem estado.

/**
 * NÚCLEO — palavras que, sozinhas, JÁ SÃO um "pode seguir". Cada uma é um ato completo
 * de aprovação/continuação e não descreve nada do que foi feito.
 */
const NUCLEO: ReadonlySet<string> = new Set([
  'ok',
  'okay',
  'okey',
  'blz',
  'beleza',
  'segue',
  'seguir',
  'continua',
  'continuar',
  'continue',
  'vai',
  'vamos',
  'manda',
  'mande',
  'pode',
  'sim',
  'nao',
  'não',
  'isso',
  'certo',
  'boa',
  'perfeito',
  'aprovado',
  'confirmo',
  'confirmado',
  'proximo',
  'próximo',
  'next',
  'go',
  'yes',
  'yep',
  'sure',
  'segue.',
  'bora',
]);

/**
 * PREENCHIMENTO — conectivos e advérbios que ACOMPANHAM uma continuação ("pode seguir
 * agora") mas NÃO são uma por si sós.
 *
 * A separação existe por um defeito que o teste pegou: com "e" e "agora" no mesmo balde
 * do núcleo, a pergunta legítima **"e agora?"** era classificada como continuação pura e
 * o turno inteiro deixava de virar memória. Conectivo não aprova nada; exigir ao menos
 * uma palavra do NÚCLEO é o que impede o filtro de comer pergunta de verdade.
 */
const PREENCHIMENTO: ReadonlySet<string> = new Set([
  'e',
  'ai',
  'aí',
  'agora',
  'entao',
  'então',
  'tb',
  'tbm',
  'tambem',
  'também',
  'ja',
  'já',
  'so',
  'só',
  'favor',
  'por',
  'pfv',
  'pls',
  'please',
  'obrigado',
  'valeu',
]);

/** Máximo de palavras que ainda pode ser "só uma continuação" ("pode seguir agora"). */
const MAX_PALAVRAS_CONTINUACAO = 4;

export function ehContinuacaoPura(texto: string): boolean {
  const limpo = texto
    .trim()
    .toLowerCase()
    // pontuação de borda não muda o sentido ("ok." e "ok!" são o mesmo "ok")
    .replace(/[.!?,;:…\s]+$/u, '')
    .replace(/^[.!?,;:…\s]+/u, '');
  if (limpo === '') return true;
  const palavras = limpo.split(/[\s,]+/u).filter((p) => p !== '');
  if (palavras.length === 0) return true;
  if (palavras.length > MAX_PALAVRAS_CONTINUACAO) return false;
  // TODAS conhecidas, e ao menos UMA do núcleo — ver o comentário de PREENCHIMENTO.
  if (!palavras.every((p) => NUCLEO.has(p) || PREENCHIMENTO.has(p))) return false;
  return palavras.some((p) => NUCLEO.has(p));
}

/**
 * Este turno merece virar memória permanente?
 *
 * `false` SÓ quando o objetivo é continuação pura — ver o cabeçalho para o porquê de o
 * critério ser o OBJETIVO e não a resposta. Todo o resto memoriza (conservador).
 */
export function valeMemorizar(objetivo: string, resposta: string): boolean {
  // Turno sem objetivo legível não produz memória localizável.
  if (objetivo.trim() === '') return false;
  // Resposta vazia: não houve resultado a registrar.
  if (resposta.trim() === '') return false;
  return !ehContinuacaoPura(objetivo);
}
