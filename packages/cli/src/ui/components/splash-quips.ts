// EST-1015 (pedido do dono) — FRASES DIVERTIDAS de carregamento do splash. Em vez do verbo
// seco "carregando" / "descobrindo MCP", o boot rotaciona estas linhas LEVES e NÃO-relacionadas
// ao produto (estilo dos loaders divertidos do Claude Code/GitHub). PURO/testável.
//
// REGRAS: PT-BR, curtas (cabem na linha do splash), inofensivas (sem piada que envelhece mal),
// sem cor/estilo cru (o SplashScreen pinta em `fgDim`). A cauda de pontinhos (`…`) é adicionada
// pelo render — as frases NÃO levam reticências.

/** O pool de frases (a ordem é a de exibição; rotaciona em ciclo). */
export const SPLASH_QUIPS: readonly string[] = [
  'aquecendo os neurônios',
  'convencendo os elétrons',
  'alinhando os pixels',
  'domando os bits',
  'fazendo um cafezinho',
  'acordando os hamsters',
  'consultando os astros',
  'embaralhando as ideias',
  'afiando os lápis',
  'respirando fundo',
  'contando até dez',
  'calibrando o bom humor',
  'procurando as chaves',
  'desenrolando o fio',
  'ajeitando as almofadas',
  'apertando os parafusos',
];

/**
 * A frase a mostrar para um `frame` do tick central. Rotaciona LENTO: troca a cada
 * `framesPerQuip` frames (o tick é ~320ms; default 6 ⇒ ~2s por frase, calmo). PURO. `frame`
 * negativo/não-finito ⇒ a 1ª frase (fail-safe). Lista vazia (impossível) ⇒ string vazia.
 */
export function splashQuipAt(frame: number, framesPerQuip = 6): number {
  if (SPLASH_QUIPS.length === 0) return 0;
  const f = Number.isFinite(frame) && frame > 0 ? Math.floor(frame) : 0;
  const per = framesPerQuip >= 1 ? Math.floor(framesPerQuip) : 1;
  return Math.floor(f / per) % SPLASH_QUIPS.length;
}

/** A frase divertida para o `frame` (conveniência sobre `splashQuipAt`). PURO. */
export function splashQuip(frame: number, framesPerQuip = 6): string {
  return SPLASH_QUIPS[splashQuipAt(frame, framesPerQuip)] ?? '';
}
