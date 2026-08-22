// `aluy onboard` — o INSTALADOR de verdade (Node + Ink), pra onde o bootstrap mínimo
// (shell/ps1/cmd) entrega o controle. Substitui o setup porco em script: splash + idioma
// + backend + provider (incl. custom OpenAI-compat) + chave + modelo + CHECK DE
// CONECTIVIDADE + sidecars (turbo/leve). Encoding-safe (Node controla o UTF-8), i18n.
//
// O check de conectividade (decisão do dono: "lisa do início ao fim") roda DEPOIS da
// chave/modelo e ANTES dos sidecars: faz uma chamada REAL ao provider; só prossegue se
// o modelo responder. Se falhar, mostra o motivo EXATO (chave/baseURL/modelo) e deixa
// corrigir — nunca entrega uma sessão quebrada nem provisiona o "restante" no escuro.
//
// F-ONB-LIVE (relato do dono: "ao selecionar o provedor, não deveria vir a lista de
// modelos pra eu escolher? isso é um pau no instalador") — MEDIDO antes do conserto:
// o passo `model` era um campo de TEXTO pré-preenchido com o `defaultModel` ESTÁTICO do
// catálogo embutido, zero chamada de rede. Agora, DEPOIS da chave (ou direto, pro
// provider `auth:['none']`), o onboarding CONSULTA `GET {baseUrl}/models` ao vivo
// (`fetchModelsSlugs`, fetch PINADO anti-SSRF) e mostra um PICKER com filtro por
// digitação + janela com rolagem. DEGRADAÇÃO HONESTA: qualquer forma de "não veio nada"
// (rede/401/timeout/lista vazia) cai no MESMO campo de texto de sempre, com o motivo
// explícito na tela — ver `decideOnboardModelListMode` logo abaixo.

import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, useApp, useInput } from 'ink';
import { MIN_WORDMARK_COLS, Wordmark } from '../ui/components/Wordmark.js';
import { ShadowedWordmark } from '../ui/components/ShadowedWordmark.js';
import { Role, ThemeProvider, resolveTheme } from '../ui/theme/index.js';
import { CLI_VERSION } from '../version.js';
import { LANGS, resolveLang, type Lang } from '../i18n/lang.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UserConfigStore } from '../io/user-config.js';
import { loadLocalProviderCatalog, addLocalProviderOverride } from '../io/providers-config.js';
import { storeApiKey } from '../model/local/credential-resolver.js';
import { checkModelConnectivity } from '../model/local/connectivity-check.js';
import { fetchModelsSlugs } from '../model/local/context-window-discovery.js';
import { createPinnedStreamFetch } from '../model/local/pinned-stream-fetch.js';
import { McpConfigWriter } from '../mcp/mcp-config-writer.js';
import { EMBEDDER_CATALOG, DEFAULT_EMBEDDER_MODEL } from '@hiperplano/aluy-cli-core';

type Step =
  | 'lang'
  | 'backend'
  | 'provider'
  | 'custom-id'
  | 'custom-url'
  | 'custom-model'
  | 'key'
  | 'model-loading'
  | 'model'
  | 'validating'
  | 'validate-failed'
  | 'mcp'
  | 'sidecars'
  | 'embedder'
  | 'done';

/**
 * Catálogo CURADO de MCPs oferecidos no onboarding (OPCIONAL, antes dos sidecars). Todos
 * rodam via `npx` sob demanda — não há instalação pesada (o `npx` baixa na 1ª vez), então
 * "instalar" aqui é só REGISTRAR no `~/.aluy/mcp.json`. (O RPA — server Python privado —
 * fica de fora até a decisão de distribuição; entra depois.)
 */
export interface McpEntry {
  readonly id: string;
  readonly label: string;
  readonly hintPt: string;
  readonly hintEn: string;
  readonly command: string;
  readonly args: readonly string[];
}
/**
 * BUG (relato do dono: "instalei setando outro modelo e ele forçou o mesmo") — decide o
 * que o onboarding grava em `config.localModel`. PURO, e exportado porque é a decisão
 * que precisa de teste: a UI/Ink em si é verificada no TTY (mesma disciplina do
 * `mcpCatalog`).
 *
 * A REGRA: o onboarding DECLARA a configuração. Ele nunca deixa o campo por conta do
 * valor anterior — ou grava o modelo escolhido, ou LIMPA (`undefined`).
 *
 * Por que limpar em vez de não escrever: `store.save` é MERGE. Não escrever fazia o
 * `localModel` de uma instalação ANTERIOR sobreviver intacto — e a resolução
 * (`model/local/config.ts`) dá precedência a `config.localModel` sobre o `defaultModel`
 * do provider, então o modelo VELHO vencia o provider NOVO que o dono acabara de
 * escolher. Em máquina limpa não havia valor velho e o sintoma não aparecia: só em
 * reinstalação, que é exatamente como ele o descreveu. Com `undefined` o campo some e a
 * resolução cai no default do provider ESCOLHIDO — a resposta certa para "não pedi
 * modelo nenhum".
 */
/**
 * BUG (relato do dono: "troquei o modelo no onboard e ele não fixou o novo") — decide o
 * texto do campo ao digitar UMA tecla. PURO, exportado para ter teste (mesma disciplina
 * do `mcpCatalog`/`resolveOnboardLocalModel`: a UI/Ink se verifica no TTY).
 *
 * O campo do modelo vem PRÉ-PREENCHIDO com o default do provider e a digitação era
 * APENDADA: quem digitava `meu/modelo` gravava `anthropic/claude-3.5-sonnetmeu/modelo`
 * no config. Não era "não fixa" — fixava um slug COLADO, que provider nenhum conhece.
 *
 * A regra: prefill é SUGESTÃO, não texto do usuário. A primeira tecla o SUBSTITUI (é o
 * comportamento de campo com valor selecionado); daí em diante concatena normal. Enter
 * direto continua aceitando a sugestão inteira — o caminho comum não muda.
 */
export function digitarNoCampo(
  estado: { readonly buf: string; readonly ehSugestao: boolean },
  tecla: string,
): { readonly buf: string; readonly ehSugestao: boolean } {
  if (estado.ehSugestao) return { buf: tecla, ehSugestao: false };
  return { buf: estado.buf + tecla, ehSugestao: false };
}

// ── F-ONB-PASTE — o que a COLAGEM deposita num campo de UMA linha ────────────────────
//
// MEDIDO no TTY (build rc.140, passo da API key, colagem simulada com `tmux send-keys -l`,
// que entrega a rajada como o terminal entrega um paste):
//   · 63 chars num chunk só ......... ENTRA INTEIRA — o `useInput` do Ink entrega o chunk
//     COMPLETO como `input` (não é caractere-a-caractere), e o campo já concatenava tudo;
//   · 300 chars num chunk só ........ ENTRA INTEIRA (chave longa não trunca);
//   · `AAA\rBBB` num chunk só ........ entrava com SETE caracteres: o `\r` virava caractere
//     LITERAL no meio do valor;
//   · rajada de DEL (backspaces rápidos que o terminal junta num chunk) ⇒ os DELs eram
//     INSERIDOS no campo em vez de apagar;
//   · com bracketed paste ligado no terminal (`?2004` — a SESSÃO liga, e um encerramento
//     abrupto pode deixar ligado), o Ink entrega o chunk MANGLED (`[200~…\x1b[201~`) e os
//     11 bytes dos MARCADORES entravam no campo como se fossem parte da chave.
//
// Ou seja: colar TEXTO SIMPLES já funcionava; o que quebrava era todo chunk que trouxesse
// algo além de imprimíveis. E como o campo da chave é MASCARADO (só `•`), o estrago é
// INVISÍVEL: a chave gravada sai com lixo, a autenticação falha depois e não há na tela
// nada que denuncie o motivo. Por isso a limpeza mora no caminho de entrada de TODOS os
// campos (chave, provider custom e filtro do modelo), e não num remendo por campo.
//
// DECISÃO sobre quebra de linha (documentada porque é escolha, não detalhe): num campo de
// uma linha, `\r`/`\n` NUNCA vira caractere do valor e NUNCA confirma o passo sozinho. O
// texto colado termina na 1ª quebra e o resto é DESCARTADO — a 2ª linha de um clipboard
// multi-linha não pode entrar escondida num campo que mostra uma só. Confirmar continua
// sendo ato do dono: ele vê os `•` e aperta ENTER. (Um `\r` que chegue SOZINHO, em chunk
// próprio — o caminho da digitação normal —, continua sendo Enter: é o `key.return` do
// Ink, que este conserto não toca.)
//
// SEGURANÇA: transformação de STRING em memória, nada mais. O valor segue só no estado do
// React, desenhado por `<TextRow mask>` (só `•`) — nunca é logado, nunca é impresso em
// claro e só sai do processo pelo `storeApiKey` de sempre.

/** Marcadores de bracketed paste, CRUS e MANGLED (o Ink corta o 1º `\x1b` do chunk). */
const MARCADORES_DE_COLAGEM = ['\x1b[200~', '\x1b[201~', '[200~', '[201~'] as const;

/**
 * Deixa um chunk de entrada PRONTO pra entrar num campo de uma linha. PURA, exportada
 * para ter teste (mesma disciplina do `digitarNoCampo`: a UI/Ink se verifica no TTY).
 *
 * Ordem: (1) tira os marcadores de bracketed paste; (2) fica com o 1º pedaço NÃO-VAZIO
 * entre quebras de linha (clipboard que começa com `\n` não vira campo vazio); (3) remove
 * o que restou de control chars C0 (`\t`, ESC, DEL, …) — bytes que não são texto e que,
 * mascarados, ninguém veria.
 *
 * Caractere DIGITADO passa intacto (o caminho comum não muda): imprimível ⇒ volta ele
 * mesmo. Chunk que só tinha lixo ⇒ `''` (o chamador não insere nada).
 */
export function sanitizarColagemDeCampo(bruto: string): string {
  let s = bruto;
  for (const m of MARCADORES_DE_COLAGEM) s = s.split(m).join('');
  for (const linha of s.split(/\r\n|\r|\n/)) {
    const limpa = removerControles(linha);
    if (limpa !== '') return limpa;
  }
  return '';
}

/** Tira C0 (0x00–0x1f) e DEL (0x7f) — sobra só o texto imprimível do campo. */
function removerControles(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) continue;
    out += s[i];
  }
  return out;
}

/**
 * Quantos APAGAMENTOS um chunk representa. O Ink só reconhece `key.backspace`/`key.delete`
 * quando o chunk traz UM byte; segurar a tecla (ou latência de SSH) faz o terminal juntar
 * vários DEL/BS num chunk só, que o Ink entrega pelo caminho de "texto". MEDIDO no TTY:
 * antes do conserto esses bytes eram INSERIDOS (o campo CRESCIA ao apagar); com a limpeza
 * eles somem — mas apagar tem de APAGAR, e por isso contamos.
 *
 * Só conta chunk HOMOGÊNEO (nada além de DEL/BS): chunk misto é colagem, e quem cuida
 * dela é `sanitizarColagemDeCampo`. PURA, exportada para ter teste.
 */
export function contarApagamentos(chunk: string): number {
  if (chunk.length < 2) return 0; // 1 byte é o caminho normal do Ink (`key.backspace`).
  for (const ch of chunk) if (ch !== '\x7f' && ch !== '\b') return 0;
  return chunk.length;
}

export function resolveOnboardLocalModel(args: {
  readonly providerId: string;
  /** O que o dono digitou/confirmou no passo `model` (built-ins vêm pré-preenchidos). */
  readonly model: string;
  /** O que ele digitou no passo `custom-model` (caminho `__custom__`, aceita vazio). */
  readonly customModel: string;
}): string | undefined {
  const escolhido = args.providerId === '__custom__' ? args.customModel : args.model;
  const limpo = escolhido.trim();
  return limpo !== '' ? limpo : undefined;
}

// ── F-ONB-LIVE — decisões PURAS do picker de modelos ao vivo (mesma disciplina de
// `digitarNoCampo`/`resolveOnboardLocalModel`: a UI/Ink em si se verifica no TTY) ──────
//
// `fetchModelsSlugs` (`context-window-discovery.ts`) devolve `[]` p/ TODO motivo de
// falha — rede fora, 401, timeout, corpo grande demais, wireFormat sem `/models` útil
// (`anthropic`/`gemini`), ou o provider genuinamente sem modelo nenhum — fail-open
// UNIFORME por decisão do próprio módulo (ver o comentário de topo daquele arquivo). Não
// há como distinguir estes casos a partir do array puro devolvido; por isso a decisão
// abaixo nunca finge saber QUAL foi o motivo, só que a consulta não trouxe nada — e cai
// no MESMO campo de texto de sempre. O slug ESCOLHIDO (picker ou texto) sempre termina
// em `model`/`resolveOnboardLocalModel` — nenhum 2º caminho de escrita pro config.

/** Quantas linhas o picker de modelos mostra por vez. OpenRouter sozinho passa de 400
 * slugs — despejar tudo estoura qualquer terminal (pedido explícito do dono). */
export const MODEL_PICKER_WINDOW = 10;

/**
 * A lista ao vivo veio (não-vazia) ⇒ `'picker'`; qualquer forma de "não veio nada"
 * (erro/401/timeout/lista genuinamente vazia) ⇒ `'text'` (o campo de hoje).
 */
/**
 * ONBOARD-LANG-2X — o onboarding deve ABRIR no passo de idioma, ou já sabe a resposta?
 *
 * O instalador do site abre com "idioma / language?" e chama `aluy onboard` em seguida.
 * Como o onboarding começava em `'lang'` incondicionalmente, a MESMA pergunta aparecia
 * duas vezes seguidas (relato do dono: "ta perguntando duas vezes o idioma") — e duas
 * perguntas idênticas em sequência fazem quem instala duvidar se a primeira funcionou.
 *
 * Só pula com sinal EXPLÍCITO (`ALUY_LANG`). O `cfg.lang` NÃO pula de propósito: rodar
 * `aluy onboard` de novo para TROCAR o idioma é uso legítimo, e um config antigo não
 * pode sequestrar essa intenção — seria trocar uma pergunta a mais por uma tela
 * INALCANÇÁVEL, que é pior.
 *
 * PURO: (env) → idioma explícito ou `undefined`.
 */
export function idiomaExplicitoDoAmbiente(env: NodeJS.ProcessEnv): Lang | undefined {
  return resolveLang(env.ALUY_LANG ?? '')?.code;
}

/**
 * ONBOARD-PERSIST — os campos de MODELO que o onboarding grava sob backend LOCAL.
 *
 * Existem DOIS no config, escritos por fluxos diferentes e lidos por caminhos diferentes:
 *   · `localModel`   — lido por `resolveLocalProviderConfig` (monta o cliente BYO);
 *   · `model`+`tier` — lidos no boot por `resolvePreferredModel`, que sob `tier:'custom'`
 *                      resolve o SLUG ATIVO da sessão.
 *
 * O onboarding gravava só o primeiro. Numa REINSTALAÇÃO o `model` velho sobrevivia
 * (`save` é MERGE) e o boot voltava ao slug ANTIGO — o dono escolhia um modelo no
 * instalador e a sessão abria no anterior ("já falei 300x sobre isso"). Em máquina limpa
 * não havia valor velho, e por isso o sintoma só aparecia reinstalando.
 *
 * PURO: (provider, modelo escolhido) → os três campos, sempre COERENTES entre si.
 */
export function onboardLocalModelPatch(args: {
  readonly providerId: string;
  readonly model: string;
  readonly customModel: string;
}): {
  readonly localModel: string | undefined;
  readonly model: string | undefined;
  readonly tier: string;
} {
  const escolhido = resolveOnboardLocalModel({
    providerId: args.providerId,
    model: args.model,
    customModel: args.customModel,
  });
  // BYO é sempre `custom` — é o tier que o boot espera para LER o slug do `model`.
  return { localModel: escolhido, model: escolhido, tier: 'custom' };
}

export function decideOnboardModelListMode(slugs: readonly string[]): 'picker' | 'text' {
  return slugs.length > 0 ? 'picker' : 'text';
}

/** Filtro do picker de modelos — substring, case-insensitive (o dono digita um
 * fragmento do slug, não regex). Filtro vazio devolve a lista inteira. */
export function filterModelSlugs(slugs: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return slugs;
  return slugs.filter((s) => s.toLowerCase().includes(q));
}

/** Cursor sempre dentro de `[0, total)`. `total === 0` (filtro sem nenhum match) ⇒ `0`
 * — não há o que selecionar; o ENTER vira no-op no handler (nunca escolhe `undefined`). */
export function clampModelCursor(cursor: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(cursor, 0), total - 1);
}

/**
 * Janela de rolagem do picker de modelos: no máx. `size` linhas visíveis, deslizando p/
 * manter o `cursor` sempre dentro da janela. `total <= size` ⇒ mostra tudo (sem
 * deslizar) — é o caso comum de provider pequeno/custom.
 */
export function modelPickerWindow(
  total: number,
  cursor: number,
  size: number,
): { readonly start: number; readonly end: number } {
  if (total <= size) return { start: 0, end: total };
  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(cursor - half, 0), total - size);
  return { start, end: start + size };
}

export function mcpCatalog(): McpEntry[] {
  return [
    {
      id: 'playwright',
      label: 'Playwright',
      hintPt: 'automação de navegador (oficial)',
      hintEn: 'browser automation (official)',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    },
    {
      id: 'sequential-thinking',
      label: 'Sequential Thinking',
      hintPt: 'raciocínio passo-a-passo',
      hintEn: 'step-by-step reasoning',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    {
      id: 'memory',
      label: 'Memory',
      hintPt: 'grafo de conhecimento persistente',
      hintEn: 'persistent knowledge graph',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    {
      id: 'filesystem',
      label: 'Filesystem',
      hintPt: 'arquivos (escopo: sua home)',
      hintEn: 'files (scope: your home)',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', homedir()],
    },
    {
      id: 'rpa',
      label: 'RPA (Aluy)',
      hintPt: 'automação visual de desktop — OCR/clica/digita · via uvx',
      hintEn: 'visual desktop automation — OCR/click/type · via uvx',
      command: 'uvx',
      args: ['aluy-mcp-rpa'],
    },
  ];
}

type Backend = 'broker' | 'local';
type Profile = 'turbo' | 'leve';

interface Opt {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * F-ONB (fix) — o que o onboard PEDE ao encerrar. A tela final promete `enter p/ entrar
 * no aluy`, mas o handler só fechava o Ink e o processo morria: o `aluy` nunca abria.
 * Agora o Enter EXPRESSA a intenção e o `bin/aluy.ts` a cumpre (mesmo caminho do
 * `case 'launch'`), fechando a cadeia `aluy onboard → aluy bootstrap → aluy` que o
 * comentário do `case 'bootstrap'` já descrevia.
 *
 * `bootstrap` é `true` quando o usuário escolheu o perfil **turbo** no passo `sidecars`:
 * optar pelo turbo É o consentimento da instalação (`docs/turbo.md`), então a cadeia
 * completa roda sem pedir o comando de novo. O `runInit` decide sozinho o que falta
 * (perfil leve e "nada a instalar" já são no-op lá) — não duplicamos essa lógica aqui.
 */
export interface OnboardOutcome {
  readonly code: number;
  /** Enter na tela final ⇒ abre a sessão. Esc ⇒ só sai. */
  readonly launch: boolean;
  /** Perfil turbo ⇒ roda o bootstrap ANTES de abrir. */
  readonly bootstrap: boolean;
}

function OnboardApp(props: {
  readonly store: UserConfigStore;
  /** Chamado UMA vez, no encerramento, com a intenção do usuário. */
  readonly onOutcome?: (o: { launch: boolean; bootstrap: boolean }) => void;
}): React.ReactElement {
  const app = useApp();
  const cfg = props.store.load();
  const providers = useMemo(() => loadLocalProviderCatalog().entries, []);

  // ONBOARD-LANG-2X — o idioma JÁ foi dito? Então não perguntamos de novo.
  //
  // O instalador do site abre com "idioma / language?" e, logo depois, chama o
  // `aluy onboard` — que abria no passo 'lang' incondicionalmente e perguntava a MESMA
  // coisa. Relato do dono: "ta perguntando duas vezes o idioma". Duas perguntas
  // idênticas em sequência fazem quem instala duvidar se a primeira funcionou.
  //
  // Só pula com sinal EXPLÍCITO (`ALUY_LANG` do instalador, ou `--lang`). O `cfg.lang`
  // NÃO pula de propósito: rodar `aluy onboard` de novo para TROCAR o idioma é um uso
  // legítimo, e um config antigo não pode sequestrar essa intenção.
  const langExplicito = idiomaExplicitoDoAmbiente(process.env);
  const [step, setStep] = useState<Step>(langExplicito === undefined ? 'lang' : 'backend');
  const [lang, setLang] = useState<Lang>(langExplicito ?? cfg.lang ?? 'pt-BR');
  const [backend, setBackend] = useState<Backend>('local');
  const [providerId, setProviderId] = useState<string>('anthropic');
  const [custom, setCustom] = useState<{ id: string; url: string; model: string }>({
    id: '',
    url: '',
    model: '',
  });
  const [apiKey, setApiKey] = useState<string>('');
  const [model, setModel] = useState<string>('');
  // F-ONB-LIVE — resultado da consulta ao vivo do passo `model` (ver `decideOnboardModelListMode`
  // acima). `modelLive` só é lido quando `modelListMode === 'picker'`; no modo `'text'` o passo
  // se comporta EXATAMENTE como hoje (campo pré-preenchido + `digitarNoCampo`).
  const [modelLive, setModelLive] = useState<readonly string[]>([]);
  const [modelListMode, setModelListMode] = useState<'text' | 'picker'>('text');
  const [modelFallbackReason, setModelFallbackReason] = useState<string>(''); // motivo da queda pro texto ('' fora do fallback)
  const [modelFilter, setModelFilter] = useState<string>(''); // filtro digitado no picker
  const [modelCursor, setModelCursor] = useState<number>(0); // cursor DENTRO da lista filtrada
  const [profile, setProfile] = useState<Profile>('leve'); // default LEVE (decisão do dono)
  const [embedder, setEmbedder] = useState<string>(DEFAULT_EMBEDDER_MODEL); // embedder do mem0 (turbo)
  const [vError, setVError] = useState<string>(''); // detalhe do check de conectividade falho

  const MCPS = useMemo(() => mcpCatalog(), []);
  const [mcpSel, setMcpSel] = useState<ReadonlySet<number>>(new Set()); // MCPs marcados (multi-select, opcional)
  const [mcpCursor, setMcpCursor] = useState<number>(0);

  const [cursor, setCursor] = useState<number>(
    Math.max(
      0,
      LANGS.findIndex((l) => l.code === lang),
    ),
  );
  const [buf, setBuf] = useState<string>('');
  /**
   * O `buf` atual é uma SUGESTÃO pré-preenchida (default do provider), não algo que o
   * usuário escreveu ⇒ a primeira tecla o substitui em vez de concatenar. Ver `gotoText`.
   */
  const [bufEhSugestao, setBufEhSugestao] = useState<boolean>(false);
  const [savedMsg, setSavedMsg] = useState<string[]>([]);

  const pt = lang === 'pt-BR';
  const T = (p: string, e: string): string => (pt ? p : e);

  const backendOpts: Opt[] = [
    {
      value: 'local',
      label: T('Local (sua chave / BYO)', 'Local (your key / BYO)'),
      hint: T('direto no provider', 'direct to provider'),
    },
    {
      value: 'broker',
      label: T('Broker (conta Aluy)', 'Broker (Aluy account)'),
      hint: T('autentica depois com aluy login', 'authenticate later with aluy login'),
    },
  ];
  // Espelha o `wants3d` do <SplashScreen>: terminal estreito ⇒ marca plana.
  const temMarcaLarga = (process.stdout.columns ?? 80) >= MIN_WORDMARK_COLS;
  const providerOpts: Opt[] = [
    // F-ONBOARD-SEM-DEFAULT (relato do dono: "em vez de aparecer os modelos padrões,
    // aparecer os modelos carregados de cada provider") — a dica ao lado de cada provider
    // era o `defaultModel` do catálogo EMBUTIDO. Catálogo envelhece: o do OpenRouter
    // anunciava `anthropic/claude-3.5-sonnet`, aposentado — a primeira tela da instalação
    // prometia um modelo que devolve 404.
    //
    // Buscar a lista real aqui não é opção: são nove providers e ainda não há credencial
    // nenhuma. Mas o modelo NEM PRECISA aparecer neste passo — o passo seguinte já mostra a
    // lista AO VIVO do provider escolhido (422 modelos, com filtro).
    //
    // Sem dica nenhuma: `wireFormat` seria verdade, mas sete dos nove dizem `openai-compat` —
    // repetir isso em cada linha é ruído com aparência de informação. O que se escolhe aqui é
    // o PROVIDER; o modelo é a próxima pergunta.
    ...providers.map((e) => ({ value: e.id, label: e.label })),
    {
      value: '__custom__',
      label: T('+ custom (OpenAI-compatível)', '+ custom (OpenAI-compatible)'),
      // Defeito 2 (relato do dono) — "TokenRouter" aqui era EXEMPLO, mas junto de itens
      // REAIS da lista (deepseek/openai/…) lia como se fosse mais um provider suportado
      // (reforçado pelo card do site apontando pra tokenrouter.com). `vLLM` some porque
      // era o MESMO tipo de exemplo, com o mesmo risco — trocados por termos que não são
      // nome de produto nenhum.
      hint: T('ex.: seu endpoint OpenAI-compat', 'e.g. your OpenAI-compat endpoint'),
    },
  ];
  const sidecarOpts: Opt[] = [
    {
      value: 'turbo',
      label: T('Turbo — instala tudo', 'Turbo — install all'),
      hint: T(
        'ollama + mem0 + headroom · pede máquina razoável',
        'ollama + mem0 + headroom · needs a decent machine',
      ),
    },
    {
      value: 'leve',
      label: T('Leve — nada agora', 'Lite — nothing now'),
      hint: T('liga depois com aluy bootstrap', 'enable later with aluy bootstrap'),
    },
  ];

  // Embedder do mem0 (turbo): catálogo do core, hints i18n. O 1º é o default (bge-m3, forte).
  const embedderOpts: Opt[] = EMBEDDER_CATALOG.map((e) => ({
    value: e.model,
    label: e.model,
    hint: T(e.hintPt, e.hintEn),
  }));

  const pickerLen = (s: Step): number =>
    s === 'lang'
      ? LANGS.length
      : s === 'backend'
        ? backendOpts.length
        : s === 'provider'
          ? providerOpts.length
          : s === 'sidecars'
            ? sidecarOpts.length
            : s === 'embedder'
              ? embedderOpts.length
              : 0;

  function gotoText(next: Step, prefill = ''): void {
    setBuf(prefill);
    // BUG (relato do dono: "troquei o modelo no onboard e ele não fixou o novo") — o campo
    // do modelo vem PRÉ-PREENCHIDO com o default do provider, e a digitação era APENDADA:
    // quem digitava `meu/modelo` acabava gravando
    // `anthropic/claude-3.5-sonnetmeu/modelo` no config. Não era "não fixa" — fixava um
    // slug COLADO, que provider nenhum conhece; o dono via o modelo errado e nenhuma
    // pista do porquê.
    //
    // O prefill é SUGESTÃO, não texto que o usuário escreveu: a primeira tecla o
    // SUBSTITUI (comportamento de valor selecionado, igual a um campo de formulário com
    // o texto já marcado). Backspace/edição seguem funcionando normalmente depois disso —
    // e Enter direto continua aceitando a sugestão inteira, que é o caminho comum.
    setBufEhSugestao(prefill !== '');
    setStep(next);
  }

  // Abre o passo de sidecars com LEVE pré-selecionado (decisão do dono): o cursor
  // ancora no índice de 'leve', não no topo. Usado em TODAS as entradas em 'sidecars'.
  function enterSidecars(): void {
    setCursor(
      Math.max(
        0,
        sidecarOpts.findIndex((o) => o.value === 'leve'),
      ),
    );
    setStep('sidecars');
  }

  // Passo de MCPs (OPCIONAL, multi-select) — vem ANTES da escolha light/turbo dos sidecars
  // (pedido do dono). Nenhum marcado por default; o usuário escolhe e ENTER segue.
  function enterMcp(): void {
    setMcpCursor(0);
    setStep('mcp');
  }

  // Alvo do check de conectividade (resolvido do estado atual). --------------
  function resolveTarget(): { wireFormat: string; baseUrl: string; model: string; key: string } {
    const isCustom = providerId === '__custom__';
    const entry = providers.find((p) => p.id === providerId);
    return {
      wireFormat: isCustom ? 'openai-compat' : (entry?.wireFormat ?? 'openai-compat'),
      baseUrl: isCustom ? custom.url.trim() : (entry?.baseUrl ?? ''),
      model: (isCustom ? custom.model : model.trim() || entry?.defaultModel || '').trim(),
      key: apiKey.trim(),
    };
  }

  // Roda o check quando entra em 'validating' (estado já assentado neste ponto).
  useEffect(() => {
    if (step !== 'validating') return;
    const tgt = resolveTarget();
    if (backend !== 'local' || tgt.key === '' || tgt.baseUrl === '' || tgt.model === '') {
      // Sem como validar (broker, ou faltou chave/url/modelo) ⇒ segue sem gate.
      enterMcp();
      return;
    }
    let cancelled = false;
    void checkModelConnectivity(tgt).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setVError('');
        enterMcp();
      } else {
        setVError(r.detail);
        setStep('validate-failed');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // F-ONB-LIVE — roda a consulta AO VIVO quando entra em 'model-loading' (DEPOIS da
  // chave, ou direto pro provider `auth:['none']`). Fetch PINADO anti-SSRF
  // (`createPinnedStreamFetch`, EST-1115 — MESMO caminho que `run.tsx` usa pro
  // `discoverContextWindow`/`listRemoteModelNames` da sessão já rodando), timeout e teto
  // de corpo já embutidos em `fetchModelsSlugs`. NUNCA trava: `fetchModelsSlugs` nunca
  // lança, e o próprio timeout (8s, default do módulo) resolve a promise mesmo se o
  // provider nunca responder.
  useEffect(() => {
    if (step !== 'model-loading') return;
    const entry = providers.find((p) => p.id === providerId);
    const wireFormat = entry?.wireFormat ?? 'openai-compat';
    const baseUrl = entry?.baseUrl ?? '';
    const key = apiKey.trim();
    const def = entry?.defaultModel ?? '';
    let cancelled = false;
    void fetchModelsSlugs({
      wireFormat,
      baseUrl,
      key,
      fetchImpl: createPinnedStreamFetch({}),
    }).then((slugs) => {
      if (cancelled) return;
      if (decideOnboardModelListMode(slugs) === 'picker') {
        setModelLive(slugs);
        setModelListMode('picker');
        setModelFallbackReason('');
        setModelFilter('');
        // Cursor começa no `defaultModel` do provider quando ele está na lista (é a
        // sugestão óbvia); senão no topo — nunca `-1` (`findIndex` sem match).
        const idx = slugs.findIndex((s) => s.toLowerCase() === def.toLowerCase());
        setModelCursor(Math.max(0, idx));
        setStep('model');
      } else {
        // DEGRADAÇÃO HONESTA (obrigatória): cai no MESMO campo de texto de hoje, com o
        // motivo na tela — nunca finge que a lista veio, nunca trava a instalação.
        setModelListMode('text');
        setModelFallbackReason(
          T(
            'não consegui listar os modelos do provider (rede, chave, timeout, endpoint sem suporte ou lista vazia) — digite manualmente',
            "couldn't list the provider's models (network, key, timeout, unsupported endpoint or empty list) — type it manually",
          ),
        );
        gotoText('model', def);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Recebe o profile ESCOLHIDO direto (não lê o estado `profile`): o setProfile do
  // handler é assíncrono, então ler `profile` aqui pegaria o valor VELHO (leve) — era o
  // bug "escolhi turbo e foi pra leve". `prof` é a fonte da verdade.
  function finish(prof: Profile, embedderChoice?: string): void {
    const msg: string[] = [];
    const patch: Record<string, unknown> = { lang, backend };
    if (backend === 'local') {
      patch.localProvider = providerId === '__custom__' ? custom.id.trim() : providerId;
      // BUG (relato do dono: "instalei setando outro modelo e ele forçou o mesmo") — o
      // `localModel` SEMPRE é resolvido, nunca deixado por conta do valor anterior.
      //
      // Antes, campo vazio significava "não escreve", e `store.save` é MERGE: numa
      // máquina que JÁ tinha instalação, o `localModel` velho sobrevivia intacto — e a
      // resolução (`model/local/config.ts`) dá precedência a `config.localModel` sobre o
      // `defaultModel` do provider, então o modelo ANTIGO vencia o provider NOVO que o
      // dono acabara de escolher. Em máquina limpa não havia valor velho, então o
      // sintoma só aparecia em reinstalação — que é exatamente como ele o descreveu.
      //
      // Vazio agora cai no default do PROVIDER ESCOLHIDO (a mesma fonte que a resolução
      // usaria se o campo não existisse) — o passo `model` já vem pré-preenchido com ele
      // nos built-ins, então isto só muda o caminho em que o passo não foi percorrido
      // (custom sem modelo digitado). O onboarding DECLARA a configuração: sair dele com
      // provider novo e modelo velho não é um estado que alguém pediu.
      // `undefined` no patch SOBRESCREVE o valor do disco (mecanismo documentado em
      // `user-config.ts:1095`) — ver `resolveOnboardLocalModel` para o porquê.
      const mp = onboardLocalModelPatch({ providerId, model, customModel: custom.model });
      patch.localModel = mp.localModel;
      // BUG ANTIGO (dono: "mesmo instalando por cima e selecionando outro modelo, a
      // informação do instalador não é persistida — já falei 300x").
      //
      // Existem DOIS campos de modelo no config, escritos por fluxos diferentes e lidos
      // por caminhos diferentes:
      //   · `localModel`  — escrito AQUI; lido por `resolveLocalProviderConfig`, que monta
      //                     o cliente BYO. Este já estava certo.
      //   · `model`+`tier`— escritos pelo `/model` da TUI; lidos no boot por
      //                     `resolvePreferredModel`, que sob `tier:'custom'` resolve o
      //                     SLUG ATIVO da sessão.
      //
      // O onboarding gravava só o primeiro. Numa REINSTALAÇÃO o `model` velho sobrevivia
      // (`save` é MERGE) e o boot voltava a resolver o slug ANTIGO — o dono escolhia um
      // modelo no instalador e a sessão abria no anterior. Em máquina limpa não havia
      // valor velho, então o sintoma só aparecia reinstalando: exatamente como ele
      // descreveu, e exatamente por que o conserto anterior (que só tratou `localModel`)
      // não bastou.
      //
      // O onboarding DECLARA a configuração: sair dele com um modelo escolhido e outro
      // valendo não é um estado que alguém pediu. Os dois campos passam a concordar.
      patch.model = mp.model;
      patch.tier = mp.tier;
    }
    patch.profile = prof;
    // Embedder do mem0 escolhido no turbo (slug do catálogo) → config.embedder. O provisioner/
    // boot puxam/usam este (default bge-m3 se ausente). `embedderChoice` vem direto (estado async).
    if (prof === 'turbo' && embedderChoice !== undefined && embedderChoice !== '') {
      patch.embedder = embedderChoice;
    }
    // F-GRAVACAO-HONESTA — o retorno de `save()` era descartado, e esta é a gravação que
    // mais custa perder: é a configuração da INSTALAÇÃO. A escrita é atômica (temp +
    // `rename`), e no Windows o `rename` bate em `EPERM/EBUSY` quando algo segura o arquivo
    // — antivírus ou OneDrive sobre o perfil. Sem checar, o onboarding terminava com `✓` e a
    // primeira sessão abria sem nada configurado, pedindo credencial de um provider que o
    // dono nem escolheu.
    const gravou = props.store.save(patch as never);
    if (gravou) {
      msg.push(`✓ ${T('config', 'config')}: backend ${backend}`);
    } else {
      msg.push(
        `✗ NÃO consegui gravar ${T('config', 'config')} em \`~/.aluy/config.json\` — ` +
          'a configuração NÃO foi salva.',
      );
      msg.push(
        '  Feche outras janelas do aluy e rode `aluy onboard` de novo. No Windows, ' +
          'antivírus ou OneDrive sobre o perfil costumam travar o arquivo.',
      );
    }

    if (
      backend === 'local' &&
      providerId === '__custom__' &&
      custom.id.trim() !== '' &&
      custom.url.trim() !== ''
    ) {
      try {
        addLocalProviderOverride({
          id: custom.id.trim(),
          wireFormat: 'openai-compat',
          baseUrl: custom.url.trim(),
          defaultModel: custom.model.trim() || custom.id.trim(),
        });
        msg.push(
          T(
            `✓ provider custom "${custom.id.trim()}" registrado`,
            `✓ custom provider "${custom.id.trim()}" registered`,
          ),
        );
      } catch (e) {
        msg.push(`⚠ providers.json: ${String(e)}`);
      }
    }
    if (backend === 'local' && apiKey.trim() !== '') {
      const pid = providerId === '__custom__' ? custom.id.trim() : providerId;
      try {
        storeApiKey(pid, apiKey.trim());
        msg.push(T(`✓ chave de "${pid}" no keychain`, `✓ "${pid}" key in keychain`));
      } catch {
        msg.push(
          T(
            `⚠ keychain indisponível — rode: aluy login --provider ${pid}`,
            `⚠ keychain unavailable — run: aluy login --provider ${pid}`,
          ),
        );
      }
    }
    // MCPs escolhidos (opcional) → registra no ~/.aluy/mcp.json. "Instalar" é registrar:
    // todos rodam via `npx` sob demanda (baixa na 1ª vez). Best-effort: falha não derruba
    // o onboard (a sessão funciona sem MCP); reporta o que entrou.
    const chosenMcps = MCPS.filter((_, i) => mcpSel.has(i));
    if (chosenMcps.length > 0) {
      try {
        const writer = new McpConfigWriter({ file: join(homedir(), '.aluy', 'mcp.json') });
        for (const m of chosenMcps) {
          writer.add(
            { name: m.id, command: m.command, args: [...m.args], env: {} },
            { force: true },
          );
        }
        msg.push(
          T(
            `✓ ${chosenMcps.length} MCP(s) registrado(s): ${chosenMcps.map((m) => m.id).join(', ')}`,
            `✓ ${chosenMcps.length} MCP(s) registered: ${chosenMcps.map((m) => m.id).join(', ')}`,
          ),
        );
      } catch (e) {
        msg.push(`⚠ mcp.json: ${String(e)}`);
      }
    }
    msg.push(`✓ sidecars: ${prof}`);
    if (prof === 'turbo' && embedderChoice !== undefined && embedderChoice !== '') {
      msg.push(`  → embedder: ${embedderChoice}`);
    }
    if (prof === 'turbo')
      msg.push(T('  → instale agora: aluy bootstrap', '  → install now: aluy bootstrap'));
    if (vError !== '')
      msg.push(
        T('⚠ modelo NÃO validado — pode não funcionar', '⚠ model NOT validated — may not work'),
      );
    if (backend === 'broker')
      msg.push(
        T('→ broker: autentique com `aluy login`', '→ broker: authenticate with `aluy login`'),
      );
    setSavedMsg(msg);
    setStep('done');
  }

  useInput((input, key) => {
    if (step === 'done') {
      // F-ONB (fix) — ANTES: `key.return || key.escape || input` ⇒ Enter, Esc e QUALQUER
      // tecla faziam a MESMA coisa (só `app.exit()`), então (a) o `enter p/ entrar no aluy`
      // que a tela promete nunca acontecia e (b) não havia como RECUSAR (nem toque
      // acidental era inofensivo). Agora as três intenções são distintas:
      //   Enter ⇒ abre a sessão (e, no perfil turbo, roda o bootstrap antes);
      //   Esc   ⇒ sai pro shell sem abrir nada;
      //   outra ⇒ IGNORA (não encerra por tecla solta).
      if (key.return) {
        props.onOutcome?.({ launch: true, bootstrap: profile === 'turbo' });
        app.exit();
      } else if (key.escape) {
        props.onOutcome?.({ launch: false, bootstrap: false });
        app.exit();
      }
      return;
    }
    // sem input durante os dois checks ASSÍNCRONOS: conectividade e lista ao vivo (F-ONB-LIVE).
    if (step === 'validating' || step === 'model-loading') return;

    if (step === 'validate-failed') {
      if (key.escape) {
        app.exit();
        return;
      }
      const ch = (input || '').toLowerCase();
      if (key.return || ch === 'r')
        setStep('validating'); // tenta de novo
      else if (ch === 'k')
        gotoText('key', ''); // troca a chave
      else if (ch === 'u' && providerId === '__custom__')
        gotoText('custom-url', custom.url); // troca a baseURL
      else if (ch === 'c') enterMcp(); // segue mesmo assim
      return;
    }

    if (key.escape) {
      app.exit();
      return;
    }

    // MCPs — MULTI-select (opcional): ↑↓ navega · ESPAÇO marca/desmarca · ENTER segue.
    if (step === 'mcp') {
      if (key.upArrow) setMcpCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setMcpCursor((c) => Math.min(MCPS.length - 1, c + 1));
      else if (input === ' ')
        setMcpSel((s) => {
          const n = new Set(s);
          if (n.has(mcpCursor)) n.delete(mcpCursor);
          else n.add(mcpCursor);
          return n;
        });
      else if (key.return) enterSidecars(); // confirma a seleção (mesmo vazia) e segue
      return;
    }

    // Passo `model` em modo PICKER (lista ao vivo, F-ONB-LIVE) — cada tecla IMPRIMÍVEL
    // entra no FILTRO (em vez de navegar), ↑↓ navega dentro da lista JÁ FILTRADA, enter
    // escolhe. Diferente do `isPicker` genérico abaixo (que não filtra nada) — por isso
    // tem o próprio branch, ANTES dele.
    if (step === 'model' && modelListMode === 'picker') {
      const filtered = filterModelSlugs(modelLive, modelFilter);
      if (key.upArrow) setModelCursor((c) => clampModelCursor(c - 1, filtered.length));
      else if (key.downArrow) setModelCursor((c) => clampModelCursor(c + 1, filtered.length));
      else if (key.return) {
        const chosen = filtered[clampModelCursor(modelCursor, filtered.length)];
        // Filtro sem NENHUM match ⇒ `chosen` é `undefined`: ENTER vira no-op (nada pra
        // confirmar) em vez de gravar `undefined` no config — o dono apaga o filtro.
        if (chosen !== undefined) {
          setModel(chosen);
          setStep('validating');
        }
      } else if (key.backspace || key.delete) {
        setModelFilter((f) => f.slice(0, -1));
        setModelCursor(0);
      } else if (contarApagamentos(input) > 0) {
        // Rajada de backspaces que o terminal juntou num chunk (ver `contarApagamentos`).
        const n = contarApagamentos(input);
        setModelFilter((f) => f.slice(0, Math.max(0, f.length - n)));
        setModelCursor(0);
      } else if (
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      ) {
        // Chunk COLADO (slug inteiro) ou tecla solta — a MESMA limpeza para os dois: o
        // `\r` que vem junto de um slug copiado não pode virar caractere do filtro.
        const texto = sanitizarColagemDeCampo(input);
        if (texto !== '') {
          setModelFilter((f) => f + texto);
          setModelCursor(0);
        }
      }
      return;
    }

    const isPicker =
      step === 'lang' ||
      step === 'backend' ||
      step === 'provider' ||
      step === 'sidecars' ||
      step === 'embedder';
    if (isPicker) {
      const len = pickerLen(step);
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(len - 1, c + 1));
      else if (key.return) advancePicker();
      return;
    }

    // passos de TEXTO
    if (key.return) {
      advanceText();
      return;
    }
    if (key.backspace || key.delete) {
      // Editar a sugestão é ACEITÁ-LA como ponto de partida: apaga UM caractere (não o
      // campo todo) e ela deixa de ser sugestão — a partir daí digitar concatena normal.
      setBuf((b) => b.slice(0, -1));
      setBufEhSugestao(false);
      return;
    }
    const apagamentos = contarApagamentos(input);
    if (apagamentos > 0) {
      // Rajada de backspaces JUNTADA num chunk (ver `contarApagamentos`): o Ink não a
      // reconhece como `key.backspace`, então ela caía no campo como texto.
      setBuf((b) => b.slice(0, Math.max(0, b.length - apagamentos)));
      setBufEhSugestao(false);
      return;
    }
    if (
      input &&
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow
    ) {
      // Uma COLAGEM chega como UM chunk de vários caracteres (ou como vários chunks
      // seguidos, se o terminal fatiar) — os dois casos caem aqui e são aceitos inteiros.
      // A limpeza é obrigatória ANTES de entrar no campo: ver `sanitizarColagemDeCampo`.
      const texto = sanitizarColagemDeCampo(input);
      if (texto !== '') {
        // Primeira tecla (ou primeiro chunk colado) sobre uma SUGESTÃO pré-preenchida:
        // SUBSTITUI (ver `gotoText`); daí em diante concatena.
        const proximo = digitarNoCampo({ buf, ehSugestao: bufEhSugestao }, texto);
        setBuf(proximo.buf);
        setBufEhSugestao(proximo.ehSugestao);
      }
    }
  });

  function advancePicker(): void {
    if (step === 'lang') {
      const chosen = LANGS[cursor]!.code;
      props.store.saveLang(chosen);
      setLang(chosen);
      setCursor(0);
      setStep('backend');
    } else if (step === 'backend') {
      const b = backendOpts[cursor]!.value as Backend;
      setBackend(b);
      if (b === 'broker') {
        enterMcp();
      } else {
        setCursor(0);
        setStep('provider');
      }
    } else if (step === 'provider') {
      const v = providerOpts[cursor]!.value;
      setProviderId(v);
      if (v === '__custom__') {
        gotoText('custom-id', '');
      } else {
        // Provider SEM credencial (`auth:['none']`, ex.: Ollama local): PULA o passo da chave
        // — não faz sentido pedir uma chave que não existe — e vai direto p/ o modelo.
        const entry = providers.find((p) => p.id === v);
        const keyless = entry?.auth?.length === 1 && entry.auth[0] === 'none';
        if (keyless) {
          // Ollama e afins não têm chave — mas RESPONDEM `/models` sem uma (ponto 5 do
          // pedido do dono): a consulta ao vivo roda igual, só pula o passo da CHAVE.
          setApiKey('');
          setStep('model-loading');
        } else {
          gotoText('key', '');
        }
      }
    } else if (step === 'sidecars') {
      const chosen = sidecarOpts[cursor]!.value as Profile;
      setProfile(chosen);
      // TURBO ⇒ pergunta o embedder do mem0 antes de fechar; LEVE ⇒ fecha direto.
      if (chosen === 'turbo') {
        setCursor(0); // 1º do catálogo = default (bge-m3)
        setStep('embedder');
      } else {
        finish(chosen);
      }
    } else if (step === 'embedder') {
      const m = embedderOpts[cursor]!.value;
      setEmbedder(m);
      finish('turbo', m); // passa o embedder direto (estado é assíncrono)
    }
  }

  function advanceText(): void {
    const val = buf.trim();
    if (step === 'custom-id') {
      setCustom((c) => ({ ...c, id: val }));
      gotoText('custom-url', '');
    } else if (step === 'custom-url') {
      setCustom((c) => ({ ...c, url: val }));
      gotoText('custom-model', '');
    } else if (step === 'custom-model') {
      setCustom((c) => ({ ...c, model: val }));
      gotoText('key', '');
    } else if (step === 'key') {
      setApiKey(buf);
      // builtin → consulta o provider AO VIVO antes de perguntar o modelo (F-ONB-LIVE);
      // custom já tem modelo (passo `custom-model`, ANTES da chave) → direto pro check.
      if (providerId === '__custom__') setStep('validating');
      else setStep('model-loading');
    } else if (step === 'model') {
      setModel(val);
      setStep('validating');
    }
  }

  const stepNo = (): string => {
    const map: Record<string, string> = {
      lang: '1/8',
      backend: '2/8',
      provider: '3/8',
      'custom-id': '3/8',
      'custom-url': '3/8',
      'custom-model': '3/8',
      key: '4/8',
      'model-loading': '5/8',
      model: '5/8',
      validating: '6/8',
      'validate-failed': '6/8',
      mcp: '7/8',
      sidecars: '8/8',
    };
    return map[step] ?? '';
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* MESMA MARCA DO CLI — o onboarding desenhava a <Wordmark> PLANA enquanto o terminal
          abre com a SOMBREADA. Instalar e abrir acontecem no mesmo minuto, e a marca mudava
          de cara entre os dois. Espelha a decisão do <SplashScreen>: 3D só quando o terminal
          comporta (Unicode + largura); senão a plana, que é o fallback fiel.
          `animate={false}` de propósito — aqui a marca é IDENTIDADE, não animação: o brilho
          varrendo competiria com a lista de escolha logo abaixo. */}
      {temMarcaLarga ? <ShadowedWordmark frame={0} animate={false} /> : <Wordmark columns={80} />}
      <Box paddingTop={1}>
        {/* Mostra a VERSÃO que está sendo instalada/configurada na tela do logo (pedido do
            dono): tira a dúvida de "qual versão estou rodando" logo no 1º passo. */}
        <Role name="fgDim">
          aluy v{CLI_VERSION} · {T('configuração inicial', 'first-run setup')}
          {step !== 'done' ? `  ·  ${stepNo()}` : ''}
        </Role>
      </Box>
      <Box paddingTop={1} flexDirection="column">
        {step === 'lang' && (
          <Picker
            title={T('Idioma', 'Language')}
            opts={LANGS.map((l) => ({ value: l.code, label: l.label }))}
            cursor={cursor}
            active={lang}
          />
        )}
        {step === 'backend' && (
          <Picker
            title={T('Backend do modelo', 'Model backend')}
            opts={backendOpts}
            cursor={cursor}
          />
        )}
        {step === 'provider' && (
          <Picker
            title={T('Provider', 'Provider')}
            opts={providerOpts}
            cursor={cursor}
            active={providerId}
          />
        )}
        {step === 'mcp' && (
          <McpPicker
            title={T('MCPs (opcional) — quais instalar?', 'MCPs (optional) — which to install?')}
            entries={MCPS}
            cursor={mcpCursor}
            selected={mcpSel}
            pt={pt}
          />
        )}
        {step === 'sidecars' && (
          <Box flexDirection="column">
            <Picker
              title={T('Complementos (modo turbo)', 'Complements (turbo mode)')}
              opts={sidecarOpts}
              cursor={cursor}
              active={profile}
            />
            <Box paddingTop={1} flexDirection="column">
              <Role name="fgDim">
                {T(
                  'Turbo roda modelos locais (Ollama) + memória — pede uma máquina razoável:',
                  'Turbo runs local models (Ollama) + memory — needs a decent machine:',
                )}
              </Role>
              <Role name="fgDim">
                {T(
                  '  ~8GB+ de RAM, alguns GB de disco e uma boa conexão (baixa o Ollama + modelos).',
                  '  ~8GB+ RAM, a few GB of disk and a good connection (downloads Ollama + models).',
                )}
              </Role>
              <Role name="fgDim">
                {T(
                  '  Em máquina fraca, escolha Leve — o aluy funciona normal e você liga o turbo depois.',
                  '  On a weak machine, pick Lite — aluy works fine and you can enable turbo later.',
                )}
              </Role>
            </Box>
          </Box>
        )}
        {step === 'embedder' && (
          <Box flexDirection="column">
            <Picker
              title={T('Modelo de embedding (memória)', 'Embedding model (memory)')}
              opts={embedderOpts}
              cursor={cursor}
              active={embedder}
            />
            <Box paddingTop={1} flexDirection="column">
              <Role name="fgDim">
                {T(
                  'O embedder transforma suas memórias em vetores p/ o recall semântico do mem0.',
                  'The embedder turns your memories into vectors for mem0’s semantic recall.',
                )}
              </Role>
              <Role name="fgDim">
                {T(
                  '  bge-m3 é o mais forte (multilíngue, melhor em PT) — porém o maior download.',
                  '  bge-m3 is the strongest (multilingual) — but the biggest download.',
                )}
              </Role>
            </Box>
          </Box>
        )}

        {step === 'custom-id' && (
          // Defeito 2 (relato do dono) — "tokenrouter" aqui era só EXEMPLO deste campo
          // livre, mas por ser nome de produto REAL (e ecoado por um card do site
          // apontando pra tokenrouter.com) lia como se fosse opção suportada no /provider.
          // Trocado por um placeholder obviamente genérico — sem mudar a lista real
          // (que já vem, sem dessincronia, de `loadLocalProviderCatalog().entries`).
          <TextRow
            label={T('id do provider (ex.: meu-provider)', 'provider id (e.g. my-provider)')}
            value={buf}
          />
        )}
        {step === 'custom-url' && (
          <TextRow label={T('base URL (https, .../v1)', 'base URL (https, .../v1)')} value={buf} />
        )}
        {step === 'custom-model' && (
          <TextRow label={T('modelo default', 'default model')} value={buf} />
        )}
        {step === 'key' && (
          <TextRow
            label={T(
              `API key de ${providerId === '__custom__' ? custom.id : providerId} (oculta)`,
              `${providerId === '__custom__' ? custom.id : providerId} API key (hidden)`,
            )}
            value={buf}
            mask
          />
        )}
        {step === 'model-loading' && (
          <Box flexDirection="column">
            <Role name="fg">
              {T('Buscando os modelos do provider…', 'Fetching the provider’s models…')}
            </Role>
            <Box paddingTop={1}>
              <Role name="fgDim">
                {T(
                  'consulta ao vivo (GET /models) — sem lista, cai no campo de texto',
                  'live query (GET /models) — falls back to the text field with no list',
                )}
              </Role>
            </Box>
          </Box>
        )}
        {step === 'model' && modelListMode === 'picker' && (
          <ModelListPicker
            title={T('Modelo (lista ao vivo)', 'Model (live list)')}
            slugs={modelLive}
            filter={modelFilter}
            cursor={modelCursor}
            pt={pt}
          />
        )}
        {step === 'model' && modelListMode === 'text' && (
          <Box flexDirection="column">
            {modelFallbackReason !== '' && (
              <Box paddingBottom={1}>
                <Role name="fgDim">{`⚠ ${modelFallbackReason}`}</Role>
              </Box>
            )}
            <TextRow label={T('modelo (enter = default)', 'model (enter = default)')} value={buf} />
            {(() => {
              const sugg = providers.find((p) => p.id === providerId)?.models ?? [];
              return sugg.length > 0 ? (
                <Box paddingTop={1}>
                  <Role name="fgDim">{T('sugestões: ', 'suggestions: ') + sugg.join(' · ')}</Role>
                </Box>
              ) : null;
            })()}
          </Box>
        )}

        {step === 'validating' && (
          <Box flexDirection="column">
            <Role name="fg">{T('Testando o modelo…', 'Testing the model…')}</Role>
            <Box paddingTop={1}>
              <Role name="fgDim">
                {T(
                  'chamada real ao provider (não prossigo se falhar)',
                  "real call to the provider (won't proceed if it fails)",
                )}
              </Role>
            </Box>
          </Box>
        )}

        {step === 'validate-failed' && (
          <Box flexDirection="column">
            <Role name="fg">{T('✗ o modelo NÃO respondeu', '✗ the model did NOT respond')}</Role>
            <Box paddingTop={1}>
              <Role name="fgDim">{vError}</Role>
            </Box>
            <Box paddingTop={1}>
              <Role name="fgDim">
                {T('enter/r tentar de novo · k trocar chave', 'enter/r retry · k change key')}
                {providerId === '__custom__' ? T(' · u trocar baseURL', ' · u change baseURL') : ''}
                {T(' · c seguir mesmo assim · esc sair', ' · c continue anyway · esc quit')}
              </Role>
            </Box>
          </Box>
        )}

        {step === 'done' && (
          <Box flexDirection="column">
            {savedMsg.map((m, i) => (
              <Role key={i} name={m.startsWith('⚠') ? 'fg' : 'accent'}>
                {m}
              </Role>
            ))}
            <Box paddingTop={1}>
              <Role name="fgDim">{T('enter p/ entrar no aluy', 'enter to launch aluy')}</Role>
            </Box>
          </Box>
        )}
      </Box>
      {step !== 'done' &&
        step !== 'validating' &&
        step !== 'validate-failed' &&
        step !== 'model-loading' && (
          <Box paddingTop={1}>
            <Role name="fgDim">
              {step === 'model' && modelListMode === 'picker'
                ? `${T('digite p/ filtrar', 'type to filter')} · ↑↓ ${T('navegar', 'move')} · enter ${T('escolher', 'select')} · esc ${T('sair', 'quit')}`
                : step === 'lang' ||
                    step === 'backend' ||
                    step === 'provider' ||
                    step === 'sidecars' ||
                    step === 'embedder'
                  ? `↑↓ ${T('navegar', 'move')} · enter ${T('escolher', 'select')} · esc ${T('sair', 'quit')}`
                  : `${T('digite', 'type')} · enter ${T('confirmar', 'confirm')} · esc ${T('sair', 'quit')}`}
            </Role>
          </Box>
        )}
    </Box>
  );
}

function Picker(props: {
  readonly title: string;
  readonly opts: readonly Opt[];
  readonly cursor: number;
  readonly active?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Role name="fg">{props.title}</Role>
      <Box flexDirection="column" paddingTop={1}>
        {props.opts.map((o, i) => (
          <Box key={o.value}>
            <Role name={i === props.cursor ? 'accent' : 'fgDim'}>
              {i === props.cursor ? '❯ ' : '  '}
            </Role>
            <Role name={i === props.cursor ? 'accent' : 'fg'}>{o.label}</Role>
            {o.hint ? <Role name="fgDim"> · {o.hint}</Role> : null}
            {props.active !== undefined && o.value === props.active ? (
              <Role name="fgDim"> ●</Role>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/**
 * F-ONB-LIVE — picker do passo `model` quando a consulta ao vivo trouxe lista
 * (`modelListMode === 'picker'`): FILTRO por digitação + janela com rolagem. OpenRouter
 * sozinho passa de 400 slugs — despejar tudo estoura qualquer terminal (pedido explícito
 * do dono); `modelPickerWindow` mantém só `MODEL_PICKER_WINDOW` linhas visíveis,
 * deslizando pra acompanhar o cursor.
 */
function ModelListPicker(props: {
  readonly title: string;
  readonly slugs: readonly string[];
  readonly filter: string;
  readonly cursor: number;
  readonly pt: boolean;
}): React.ReactElement {
  const filtered = filterModelSlugs(props.slugs, props.filter);
  const cursor = clampModelCursor(props.cursor, filtered.length);
  const { start, end } = modelPickerWindow(filtered.length, cursor, MODEL_PICKER_WINDOW);
  const visible = filtered.slice(start, end);
  return (
    <Box flexDirection="column">
      <Role name="fg">{props.title}</Role>
      <Box paddingTop={1}>
        <Role name="fgDim">{props.pt ? 'filtro: ' : 'filter: '}</Role>
        <Role name="accent">{props.filter}</Role>
        <Role name="accent">▏</Role>
      </Box>
      <Box flexDirection="column" paddingTop={1}>
        {visible.length === 0 ? (
          <Role name="fgDim">
            {props.pt ? '(nenhum modelo bate com o filtro)' : '(no model matches the filter)'}
          </Role>
        ) : (
          visible.map((s, i) => {
            const idx = start + i;
            return (
              <Box key={s}>
                <Role name={idx === cursor ? 'accent' : 'fgDim'}>
                  {idx === cursor ? '❯ ' : '  '}
                </Role>
                <Role name={idx === cursor ? 'accent' : 'fg'}>{s}</Role>
              </Box>
            );
          })
        )}
      </Box>
      <Box paddingTop={1}>
        <Role name="fgDim">
          {filtered.length}
          {props.pt ? ' modelo(s)' : ' model(s)'}
          {filtered.length > MODEL_PICKER_WINDOW
            ? ` · ${start + 1}–${end}${props.pt ? ' na tela' : ' shown'}`
            : ''}
        </Role>
      </Box>
    </Box>
  );
}

/** MULTI-select dos MCPs (opcional): checkbox por item + dica de controles. */
function McpPicker(props: {
  readonly title: string;
  readonly entries: readonly McpEntry[];
  readonly cursor: number;
  readonly selected: ReadonlySet<number>;
  readonly pt: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Role name="fg">{props.title}</Role>
      <Box flexDirection="column" paddingTop={1}>
        {props.entries.map((m, i) => {
          const on = props.selected.has(i);
          const cur = i === props.cursor;
          return (
            <Box key={m.id}>
              <Role name={cur ? 'accent' : 'fgDim'}>{cur ? '❯ ' : '  '}</Role>
              <Role name={on ? 'accent' : 'fgDim'}>{on ? '[x] ' : '[ ] '}</Role>
              <Role name={cur ? 'accent' : 'fg'}>{m.label}</Role>
              <Role name="fgDim"> · {props.pt ? m.hintPt : m.hintEn}</Role>
            </Box>
          );
        })}
      </Box>
      <Box paddingTop={1}>
        <Role name="fgDim">
          {props.pt
            ? 'ESPAÇO marca/desmarca · ENTER segue (pode seguir sem nenhum) · baixam na 1ª vez (npx/uvx)'
            : 'SPACE toggles · ENTER continues (none is fine) · fetched on first use (npx/uvx)'}
        </Role>
      </Box>
    </Box>
  );
}

function TextRow(props: {
  readonly label: string;
  readonly value: string;
  readonly mask?: boolean;
}): React.ReactElement {
  const shown = props.mask ? '•'.repeat(props.value.length) : props.value;
  return (
    <Box>
      <Role name="fg">{props.label}: </Role>
      <Role name="accent">{shown}</Role>
      <Role name="accent">▏</Role>
    </Box>
  );
}

/** Lança o onboard (Ink) e resolve quando o usuário sai. Retorna o exit code. */
export async function runOnboard(): Promise<OnboardOutcome> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      'aluy onboard precisa de um terminal interativo.\n' +
        'Abra um terminal e rode:  aluy onboard\n',
    );
    return { code: 0, launch: false, bootstrap: false };
  }
  const store = new UserConfigStore();
  const theme = resolveTheme({});
  // Default RECUSA: se o Ink sair por qualquer via que não seja o Enter da tela final
  // (ctrl-c, erro de render, `unmount` externo), NÃO abrimos nada — abrir sessão é ato
  // pedido, nunca consequência de um encerramento qualquer.
  let outcome = { launch: false, bootstrap: false };
  const instance = render(
    <ThemeProvider theme={theme}>
      <OnboardApp
        store={store}
        onOutcome={(o) => {
          outcome = o;
        }}
      />
    </ThemeProvider>,
  );
  await instance.waitUntilExit();
  return { code: 0, ...outcome };
}
