// A PERGUNTA do agente quando o turno chegou por um canal externo (Telegram).
//
// O DEFEITO (dono, 02/09): "quando ele quer tirar uma dúvida, se a pergunta é do telegram
// ele não pode enviar no console pois o usuário não vai ver".
//
// A tool `perguntar` (ADR-0114) abre o `<QuestionDialog>` no TERMINAL e BLOQUEIA o loop
// até alguém teclar ali. Num turno que chegou pelo Telegram não há ninguém no terminal: o
// dono está no celular. O que ele via era a ponte engolir a pergunta — e, pior, a própria
// tentativa de responder NÃO chegava à pergunta: o `perguntar` deixa o turno VIVO, então a
// mensagem dele entrava por `injectInput` como texto solto do turno seguinte e a promessa
// da pergunta seguia pendurada. Sem resposta, sem erro, sem prazo (o resolver NÃO tem
// timeout por tempo, de propósito — uma pergunta pode esperar o usuário pensar).
//
// Este módulo é a metade PURA das duas pontas do conserto: o TEXTO que vai para o canal e
// a LEITURA da resposta que volta. O efeito (enviar/resolver) fica no controller.
//
// A "Outro" da TUI vira `{kind:'text'}` (App.tsx: a digitação livre resolve `text` tanto
// no campo `text` quanto na entrada "Outro"). Espelhamos isso — a resposta escrita à mão
// pelo Telegram é o MESMO caso.

import type {
  AskRequest,
  QuestionAnswer,
  QuestionOption,
  QuestionSpec,
} from '@hiperplano/aluy-cli-core';

/**
 * A saída para o dono desistir da pergunta pelo celular.
 *
 * No terminal o `esc` resolve `unavailable` e o agente segue com a melhor suposição. Sem um
 * equivalente aqui, uma pergunta de `single` com `allowOther:false` e opções que não servem
 * seria uma armadilha: nada que ele escrevesse casaria, e ele não tem o `esc` à mão.
 */
export const PALAVRAS_DE_DESISTENCIA: readonly string[] = ['cancelar', 'cancela', 'cancel'];

/** Normaliza p/ comparar: minúsculas, sem acento, sem espaço nas pontas. */
function chave(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** `true` quando a pergunta admite resposta escrita à mão (o "Outro" da TUI). */
function aceitaTextoLivre(spec: QuestionSpec): boolean {
  return spec.kind === 'text' || spec.allowOther !== false;
}

/** Uma linha de opção numerada, com a descrição quando houver. */
function linhaDaOpcao(opt: QuestionOption, i: number): string {
  const numero = `${String(i + 1)}. ${opt.label}`;
  return opt.description !== undefined && opt.description !== ''
    ? `${numero} — ${opt.description}`
    : numero;
}

/**
 * O texto da pergunta como ela chega no celular. PURO.
 *
 * A instrução de COMO responder é obrigatória e explícita: a caixa do terminal ensina o
 * formato pelo desenho (setas, espaço, enter), e aqui não há desenho nenhum — sobra o texto.
 */
export function textoDaPergunta(spec: QuestionSpec): string {
  const partes: string[] = [];
  partes.push(
    spec.header !== undefined && spec.header !== '' ? `❓ ${spec.header}` : '❓ Pergunta',
  );
  partes.push(spec.question);

  const opcoes = spec.options ?? [];
  if (spec.kind !== 'text' && opcoes.length > 0) {
    partes.push(opcoes.map((o, i) => linhaDaOpcao(o, i)).join('\n'));
    partes.push(
      spec.kind === 'multi'
        ? 'Responda com os NÚMEROS separados por vírgula (ex.: 1,3).'
        : 'Responda com o NÚMERO da opção.',
    );
  }
  if (aceitaTextoLivre(spec)) {
    partes.push(
      spec.kind === 'text'
        ? 'Responda por aqui, com as suas palavras.'
        : 'Ou escreva a sua própria resposta.',
    );
  }
  partes.push(`Para eu seguir sem responder, mande: ${PALAVRAS_DE_DESISTENCIA[0] ?? 'cancelar'}`);
  return partes.join('\n\n');
}

/** O texto de quando a resposta não pôde ser lida — a pergunta CONTINUA pendente. */
export function textoDeNaoEntendi(spec: QuestionSpec): string {
  const total = (spec.options ?? []).length;
  const como =
    spec.kind === 'multi'
      ? `Responda com os números de 1 a ${String(total)}, separados por vírgula.`
      : `Responda com um número de 1 a ${String(total)}.`;
  return `Não consegui ler a sua resposta. ${como}\n\n${textoDaPergunta(spec)}`;
}

/**
 * A leitura NUMÉRICA da resposta, em três desfechos DISTINTOS — e a distinção é o ponto.
 *
 * "não é número" e "é número, mas não existe essa opção" precisam terminar diferente: a
 * primeira ainda pode ser uma resposta escrita à mão ("prefiro MySQL"); a segunda NUNCA é.
 * Quem manda "5" numa lista de 3 quis a quinta opção — entregar ao agente a string "5"
 * como resposta livre seria pôr na boca do dono algo que ele não disse.
 */
type LeituraNumerica =
  | { readonly tipo: 'nao-numerico' }
  | { readonly tipo: 'fora-da-faixa' }
  | { readonly tipo: 'ok'; readonly indices: readonly number[] };

/** Lê "1", "2,3", "1 3" ⇒ índices 0-based. Ver `LeituraNumerica` para os três desfechos. */
function indicesDe(texto: string, total: number): LeituraNumerica {
  const pedacos = texto
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (pedacos.length === 0) return { tipo: 'nao-numerico' };
  const out: number[] = [];
  for (const p of pedacos) {
    if (!/^\d+$/.test(p)) return { tipo: 'nao-numerico' };
    const n = Number(p);
    if (n < 1 || n > total) return { tipo: 'fora-da-faixa' };
    if (!out.includes(n - 1)) out.push(n - 1);
  }
  return { tipo: 'ok', indices: out };
}

/** Casa a resposta com o RÓTULO de uma opção (o dono escreveu a opção em vez do número). */
function porRotulo(opcoes: readonly QuestionOption[], texto: string): number | undefined {
  const alvo = chave(texto);
  if (alvo === '') return undefined;
  const i = opcoes.findIndex((o) => chave(o.label) === alvo);
  return i >= 0 ? i : undefined;
}

/**
 * Interpreta a mensagem que voltou pelo canal como a resposta da pergunta pendente. PURO.
 *
 * `undefined` ⇒ NÃO deu para ler (o chamador reapresenta a pergunta e a mantém pendente).
 * Nunca inventa: uma resposta ilegível vira nova pergunta, não uma escolha ao acaso.
 */
export function interpretarResposta(spec: QuestionSpec, bruto: string): QuestionAnswer | undefined {
  const texto = bruto.trim();
  if (texto === '') return undefined;
  if (PALAVRAS_DE_DESISTENCIA.includes(chave(texto))) {
    return { kind: 'unavailable', reason: 'o dono desistiu da pergunta pelo canal' };
  }
  if (spec.kind === 'text') return { kind: 'text', text: texto };

  const opcoes = spec.options ?? [];
  if (opcoes.length === 0) {
    // `single`/`multi` sem opção não deveria existir (a tool valida), mas se chegar aqui a
    // única leitura possível é texto — nunca pendurar por causa de uma spec malformada.
    return { kind: 'text', text: texto };
  }

  const numeros = indicesDe(texto, opcoes.length);
  // Número que não existe na lista NÃO cai em texto livre — ver `LeituraNumerica`.
  if (numeros.tipo === 'fora-da-faixa') return undefined;
  if (numeros.tipo === 'ok') {
    if (spec.kind === 'multi') {
      const indices = [...numeros.indices].sort((a, b) => a - b);
      return {
        kind: 'choices',
        indices,
        labels: indices.map((i) => opcoes[i]?.label ?? '').filter((l) => l !== ''),
      };
    }
    // `single` com vários números é ambíguo — pede de novo em vez de escolher o primeiro.
    if (numeros.indices.length !== 1) return undefined;
    const i = numeros.indices[0] ?? 0;
    return { kind: 'choice', index: i, label: opcoes[i]?.label ?? '' };
  }

  const porNome = porRotulo(opcoes, texto);
  if (porNome !== undefined) {
    return spec.kind === 'multi'
      ? { kind: 'choices', indices: [porNome], labels: [opcoes[porNome]?.label ?? ''] }
      : { kind: 'choice', index: porNome, label: opcoes[porNome]?.label ?? '' };
  }

  // Sobrou texto que não é número nem rótulo: só vale se a pergunta admite o "Outro".
  return aceitaTextoLivre(spec) ? { kind: 'text', text: texto } : undefined;
}

/**
 * Teto do trecho do efeito no aviso de aprovação. Um diff grande não cabe numa mensagem de
 * Telegram (o limite é ~4096 caracteres) e, cortado pelo servidor, chegaria mutilado sem
 * aviso — o dono aprovaria de memória o que não leu. Cortamos NÓS, dizendo que cortamos.
 */
export const MAX_EFEITO_NO_CANAL = 1_200;

/**
 * O aviso de que o turno PAROU numa APROVAÇÃO — o gate de permissão (CLI-SEC), não a tool
 * `perguntar`.
 *
 * É a mesma família do defeito de 02/09 e a mais cara delas: a catraca abre o diálogo no
 * terminal e o loop fica parado sem prazo. Vindo o turno do celular, o dono não vê nada e
 * nada acontece — o silêncio ambíguo de sempre.
 *
 * O que este texto NÃO faz é oferecer aprovação remota. APROVAR continua sendo só no
 * terminal (o dono aprova o efeito EXATO que vê — CLI-SEC-9; uma mensagem de chat não é
 * esse lugar). NEGAR, sim: negar é o default fail-safe e só pode diminuir o que acontece.
 */
export function textoDeAprovacaoPendente(pedido: AskRequest): string {
  const exato = pedido.effect.exact;
  const trecho =
    exato.length > MAX_EFEITO_NO_CANAL
      ? `${exato.slice(0, MAX_EFEITO_NO_CANAL)}\n… (cortado — o texto completo está no terminal)`
      : exato;
  return [
    '⛔ Parei esperando a sua APROVAÇÃO.',
    `${pedido.effect.tool} — ${pedido.reason}`,
    trecho,
    `Aprovar só no terminal (é lá que dá para ver o efeito inteiro). ` +
      `Para eu NÃO fazer isto e seguir, mande: ${PALAVRAS_DE_DESISTENCIA[0] ?? 'cancelar'}`,
  ].join('\n\n');
}

/** `true` quando a mensagem é uma desistência ("cancelar"). PURO. */
export function ehDesistencia(bruto: string): boolean {
  return PALAVRAS_DE_DESISTENCIA.includes(chave(bruto));
}

/** O lembrete de que aprovar não se faz por aqui — a aprovação CONTINUA pendente. */
export function textoDeAprovacaoSoNoTerminal(): string {
  return (
    'Isto eu não consigo aprovar por aqui — a aprovação vale no terminal, onde dá para ver ' +
    `o efeito exato. Para eu desistir do passo e seguir, mande: ` +
    `${PALAVRAS_DE_DESISTENCIA[0] ?? 'cancelar'}`
  );
}
