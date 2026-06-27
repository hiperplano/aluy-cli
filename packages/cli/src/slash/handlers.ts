// EST-0948 · CA-3 / spec §2.15 — EXECUÇÃO dos slash-commands nativos.
//
// O bug do Tiago: em run.tsx o `onCommand` só tratava `/quit` e `/clear`; o resto
// caía em `default: break` (no-op silencioso — Enter não fazia nada). Aqui cada
// comando nativo ganha um EFEITO REAL, isolado e testável (sem Ink):
//   /help        → nota com a lista de comandos
//   /model       → nota com o TIER atual (NUNCA provider — HG-2) + ◍ via broker
//   /usage       → nota com tokens/janela da sessão (consome o controller)
//   /whoami      → nota com user/org/escopos (consome EST-0942 via LoginService)
//   /login       → orienta o device-flow (`aluy login`); I/O de login é EST-0942
//   /logout      → revoga+apaga a credencial (EST-0942) e confirma
//   /clear       → limpa a conversa (controller.clear)
//   /init        → cria/aponta o AGENT.md do projeto
//   /quit        → encerra a TUI
//
// `buildSlashEffect` é PURO p/ os comandos síncronos (retorna a ação a aplicar);
// os assíncronos (whoami/logout) expõem um runner próprio. Assim o teste verifica
// a SAÍDA sem montar Ink nem tocar rede.

import type { LoginService, RegistryFetch } from '@hiperplano/aluy-cli-core';
import { invalidCommandWarning, originLabel, type McpListedServer } from '@hiperplano/aluy-cli-core';
import { runMcpSearch } from '../mcp/registry-search.js';
import type { SessionController } from '../session/controller.js';
import { NATIVE_COMMANDS, type NativeCommandId } from './commands.js';
import { THEMES, resolveThemeName, type ThemeName } from '../ui/theme/themes.js';
import { boxTable } from '../ui/table-lines.js';
import { LANGS, resolveLang, t as translate, type Lang } from '../i18n/index.js';
import { PROVIDERS, resolveProviderName } from '../model/providers.js';

/** Uma nota a empurrar na conversa (título + linhas). */
export interface SlashNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** O que um slash-command síncrono produz. */
export type SlashEffect =
  | { readonly kind: 'note'; readonly note: SlashNote }
  | { readonly kind: 'clear' }
  | { readonly kind: 'quit' }
  // EST-0963 — `/notify on|off|toggle`: liga/desliga o sino. O run.tsx aplica o
  // `enable` na NotificationPort e empurra a `note`. Mantido como efeito (não
  // `note` direto) p/ o run.tsx ter o booleano a aplicar sem re-parsear o arg.
  | { readonly kind: 'notify'; readonly enable: boolean; readonly note: SlashNote }
  // EST-0966 — `/theme <nome>` LITERAL: troca o tema da sessão (o run.tsx re-resolve
  // o Theme e re-renderiza). `theme` undefined ⇒ nome inválido: a `note` explica e
  // o tema NÃO muda. Sem arg, a App abre o PICKER (não chega aqui com TTY+picker).
  | { readonly kind: 'theme'; readonly theme: ThemeName | undefined; readonly note: SlashNote }
  // EST-0989 (i18n) — `/lang <code>` LITERAL: troca o idioma da TUI (o run.tsx re-injeta
  // o I18n e re-renderiza). `lang` undefined ⇒ código inválido / só-listar: a `note`
  // explica e o idioma NÃO muda. Sem arg, a App abre o PICKER (não chega aqui com
  // TTY+picker). Espelha exatamente o `kind:'theme'`.
  | { readonly kind: 'lang'; readonly lang: Lang | undefined; readonly note: SlashNote }
  // EST-0962 — `/provider <name>` LITERAL: seta o provider do modo Custom da sessão (o
  // run.tsx aplica via controller.setProvider). `provider` undefined ⇒ nome inválido /
  // só-listar: a `note` explica e o provider NÃO muda. Sem arg, a App abre o PICKER (não
  // chega aqui com TTY+picker). Espelha exatamente o `kind:'theme'`/`kind:'lang'`.
  | {
      readonly kind: 'provider';
      readonly provider: string | undefined;
      readonly note: SlashNote;
    }
  | { readonly kind: 'async'; readonly id: NativeCommandId }; // resolvido por runner async

export interface SlashContext {
  /** Uso corrente da sessão (tokens/janela/tier) — do controller. */
  readonly usage: { tokens: number; windowPct: number; tier: string };
  /** Sessão em `--unsafe`? (p/ /model deixar explícito o bypass). */
  readonly unsafe?: boolean;
}

/** Estado do sino p/ o `/notify` decidir o novo valor + a nota. */
export interface NotifyState {
  /** Sino habilitado AGORA (toggle + TTY). */
  readonly enabled: boolean;
  /** Há TTY? Sem TTY o sino é inerte e o `/notify on` é um no-op honesto. */
  readonly tty: boolean;
}

/**
 * EST-0963 — decide o EFEITO do `/notify`. `args`: `on` | `off` | (vazio = toggle).
 * PURO: recebe o estado atual do sino e devolve o novo `enable` + a nota NEUTRA a
 * exibir. Sem TTY, deixa explícito que o sino não soa naquele contexto (mas ainda
 * registra a preferência — ao voltar p/ um TTY ela vale). Nunca vaza conteúdo.
 */
export function buildNotifyEffect(args: string, state: NotifyState): SlashEffect {
  const arg = args.trim().toLowerCase();
  let enable: boolean;
  if (arg === 'on' || arg === 'ligar') enable = true;
  else if (arg === 'off' || arg === 'desligar') enable = false;
  else enable = !state.enabled; // toggle (sem arg ou arg desconhecido)

  const status = enable ? 'ligado' : 'desligado';
  const lines = [
    `sino de atenção: ${status}`,
    'avisa quando o Aluy pede aprovação ou conclui um turno longo (BEL + notificação',
    'de desktop best-effort). texto neutro — nunca o conteúdo da conversa.',
    ...(state.tty
      ? []
      : ['⚠ sem TTY (saída piped/CI) — o sino não soa aqui; a preferência vale num terminal.']),
  ];
  return { kind: 'notify', enable, note: { title: 'notify', lines } };
}

/**
 * EST-0966 — decide o EFEITO do `/theme <nome>` LITERAL (a forma do não-TTY e o
 * atalho `/theme light`). `arg` vazio NÃO chega aqui no TTY (a App abre o picker);
 * cai aqui no não-TTY p/ LISTAR os temas. PURO: recebe o tema ativo, devolve o novo
 * tema a aplicar (ou `undefined` se inválido / só-listar) + a nota a exibir.
 */
export function buildThemeEffect(args: string, currentTheme: ThemeName): SlashEffect {
  const arg = args.trim();
  if (arg === '') {
    // Sem arg (não-TTY / sem picker): LISTA os temas, marca o ativo. Não troca.
    return {
      kind: 'theme',
      theme: undefined,
      note: {
        title: 'theme',
        lines: [
          'temas disponíveis (use `/theme <nome>`):',
          ...THEMES.map((t) => `${t.name === currentTheme ? '● ' : '  '}${t.name} — ${t.summary}`),
        ],
      },
    };
  }
  const entry = resolveThemeName(arg);
  if (!entry) {
    return {
      kind: 'theme',
      theme: undefined,
      note: {
        title: 'theme',
        lines: [
          `tema desconhecido: "${arg}".`,
          `disponíveis: ${THEMES.map((t) => t.name).join(', ')}.`,
        ],
      },
    };
  }
  if (entry.name === currentTheme) {
    return {
      kind: 'theme',
      theme: undefined, // já é o ativo — não re-renderiza à toa.
      note: { title: 'theme', lines: [`o tema já é ${entry.label} (${entry.name}).`] },
    };
  }
  return {
    kind: 'theme',
    theme: entry.name,
    note: { title: 'theme', lines: [`tema trocado para: ${entry.label} (${entry.name})`] },
  };
}

/**
 * EST-0989 (i18n) — decide o EFEITO do `/lang <code>` LITERAL (forma do não-TTY e o
 * atalho `/lang en`). `arg` vazio NÃO chega aqui no TTY (a App abre o picker); cai aqui
 * no não-TTY p/ LISTAR os idiomas. PURO: recebe o idioma ATIVO, devolve o novo idioma a
 * aplicar (ou `undefined` se inválido / só-listar) + a nota a exibir. Espelha exatamente
 * o `buildThemeEffect`. As mensagens da nota saem do CATÁLOGO no idioma ATIVO (`t()`):
 * trocar p/ en já fala en na confirmação.
 */
export function buildLangEffect(args: string, currentLang: Lang): SlashEffect {
  const arg = args.trim();
  if (arg === '') {
    // Sem arg (não-TTY / sem picker): LISTA os idiomas, marca o ativo. Não troca.
    return {
      kind: 'lang',
      lang: undefined,
      note: {
        title: 'lang',
        lines: [
          translate(currentLang, 'lang.listTitle'),
          ...LANGS.map((l) => `${l.code === currentLang ? '● ' : '  '}${l.code} — ${l.label}`),
        ],
      },
    };
  }
  const entry = resolveLang(arg);
  if (!entry) {
    return {
      kind: 'lang',
      lang: undefined,
      note: {
        title: 'lang',
        lines: [
          translate(currentLang, 'lang.unknown', { input: arg }),
          `${translate(currentLang, 'lang.listTitle')}: ${LANGS.map((l) => l.code).join(', ')}.`,
        ],
      },
    };
  }
  if (entry.code === currentLang) {
    return {
      kind: 'lang',
      lang: undefined, // já é o ativo — não re-renderiza à toa.
      note: {
        title: 'lang',
        lines: [translate(currentLang, 'lang.current', { label: entry.label })],
      },
    };
  }
  // troca: a confirmação já sai no idioma NOVO (`entry.code`) — feedback imediato.
  return {
    kind: 'lang',
    lang: entry.code,
    note: {
      title: 'lang',
      lines: [translate(entry.code, 'lang.changed', { label: entry.label })],
    },
  };
}

/**
 * EST-0962 — decide o EFEITO do `/provider <name>` LITERAL (a forma do não-TTY e o
 * atalho `/provider deepseek`). `arg` vazio NÃO chega aqui no TTY (a App abre o picker);
 * cai aqui no não-TTY p/ LISTAR os providers. PURO: recebe o provider ATIVO (ou
 * `undefined` = nenhum setado ⇒ o broker escolhe o default), devolve o novo provider a
 * aplicar (ou `undefined` se inválido / só-listar) + a nota a exibir. Espelha o
 * `buildThemeEffect`/`buildLangEffect`. HG-2: o NOME é DADO de catálogo, nunca credencial.
 */
export function buildProviderEffect(
  args: string,
  currentProvider: string | undefined,
): SlashEffect {
  const arg = args.trim();
  if (arg === '') {
    // Sem arg (não-TTY / sem picker): LISTA os providers, marca o ativo. Não troca.
    return {
      kind: 'provider',
      provider: undefined,
      note: {
        title: 'provider',
        lines: [
          'providers do modo Custom (use `/provider <nome>`):',
          ...PROVIDERS.map(
            (p) =>
              `${p.name === currentProvider ? '● ' : '  '}${p.name} — ${p.summary}${p.isDefault ? ' (padrão)' : ''}`,
          ),
          '◍ só o NOME vai ao broker, que resolve provider/credencial (nunca exibido)',
          'pareia com o modelo Custom (`/model` → Custom). fora de Custom, é ignorado.',
        ],
      },
    };
  }
  const entry = resolveProviderName(arg);
  if (!entry) {
    return {
      kind: 'provider',
      provider: undefined,
      note: {
        title: 'provider',
        lines: [
          `provider desconhecido: "${arg}".`,
          `disponíveis: ${PROVIDERS.map((p) => p.name).join(', ')}.`,
        ],
      },
    };
  }
  if (entry.name === currentProvider) {
    return {
      kind: 'provider',
      provider: undefined, // já é o ativo — não re-aplica à toa.
      note: { title: 'provider', lines: [`o provider já é ${entry.label} (${entry.name}).`] },
    };
  }
  return {
    kind: 'provider',
    provider: entry.name,
    note: {
      title: 'provider',
      lines: [
        `provider do modo Custom: ${entry.label} (${entry.name})`,
        '◍ enviado ao broker em par com o modelo Custom — ele resolve a credencial (nunca exibida)',
        'vale só nesta sessão (não persiste). pareie com `/model` → Custom.',
      ],
    },
  };
}

/** Abrevia uma contagem de tokens (`12.4k`, `1.2M`). Duplica a regra do model. */
function abbrev(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Constrói o EFEITO de um slash-command nativo SÍNCRONO. Os comandos que exigem
 * I/O assíncrono (`whoami`/`logout`) devolvem `{kind:'async'}` p/ o runner.
 */
export function buildSlashEffect(id: NativeCommandId, ctx: SlashContext): SlashEffect {
  switch (id) {
    case 'help':
      return {
        kind: 'note',
        note: {
          title: 'comandos',
          lines: NATIVE_COMMANDS.map((c) => `/${c.name.padEnd(12)} ${c.summary}`),
        },
      };
    case 'model':
      // HG-2: SÓ o tier + ◍ via broker. NUNCA provider/modelo real.
      return {
        kind: 'note',
        note: {
          title: 'model',
          lines: [
            `tier: ${ctx.usage.tier}`,
            ...(ctx.unsafe ? ['⚠ sessão em modo yolo (aprovação desligada)'] : []),
          ],
        },
      };
    case 'provider':
      // EST-0962 — o `/provider` é roteado ANTES (run.tsx/App) via `buildProviderEffect`
      // (precisa do provider ativo + arg). Cair aqui só sem esse roteamento: lista os
      // providers sem setar (default seguro, provider ativo desconhecido).
      return buildProviderEffect('', undefined);
    case 'effort':
      // EST-0962 — o `/effort` é roteado ANTES (run.tsx/App). Cair aqui é fallback
      // (sem arg / sem handler): mostra o valor atual.
      return {
        kind: 'note',
        note: {
          title: 'effort',
          lines: ['use /effort <valor> para setar (low/medium/high/custom)'],
        },
      };
    case 'usage':
      return {
        kind: 'note',
        note: {
          title: 'usage',
          lines: [
            `tokens nesta sessão: ${abbrev(ctx.usage.tokens)}`,
            `janela de contexto: ${ctx.usage.windowPct}% usada`,
            `tier: ${ctx.usage.tier}`,
          ],
        },
      };
    case 'permissions':
      return {
        kind: 'note',
        note: {
          title: 'permissions',
          lines: ctx.unsafe
            ? [
                '⚠ MODO YOLO ativo — a catraca está DESLIGADA: tudo é auto-aprovado.',
                'sem --yolo: leitura = allow · escrita/bash = ask · sempre-ask (rede/',
                'destrutivo/escalada/exec-de-pacote/config) sempre pergunta.',
              ]
            : [
                'leitura (read/grep) = allow',
                'escrita (edit) e bash (run_command) = ask com o efeito exato',
                'sempre-ask (rede/destrutivo/escalada/exec-de-pacote/config): sempre pergunta',
                'regras por workspace = evolução pós-v1',
              ],
        },
      };
    case 'tools':
      // F59 — /tools: inventário unificado. PURO: as 8 nativas + permissão.
      // MCP tools e spawn_agent/room são enriquecidos em run.tsx com discovery real;
      // aqui mostramos o direcionamento base.
      return {
        kind: 'note',
        note: buildToolsNote(undefined, ctx.unsafe ?? false),
      };
    case 'init':
      // EST-0964 — o `/init` REAL (analisa o repo + escreve o AGENT.md pela catraca)
      // é roteado ANTES em run.tsx via `runInit` (precisa das portas + catraca +
      // ask-resolver). Cair aqui só sem esse roteamento (ex.: não-TTY sem wiring):
      // explica o que o comando faz, sem escrever nada.
      return {
        kind: 'note',
        note: {
          title: 'init',
          lines: [
            'analiso o repo (stack, comandos, estrutura) e crio um AGENT.md na raiz',
            'com esse contexto — você confirma a escrita (diff) e edita à vontade.',
            'o agente lê o AGENT.md como contexto de projeto no boot de cada sessão.',
          ],
        },
      };
    case 'login':
      return {
        kind: 'note',
        note: {
          title: 'login',
          lines: [
            'para entrar, rode `aluy login` num terminal (device-flow RFC 8628)',
            'ou `aluy login --token <PAT>` em CI/headless.',
            'o fluxo device-flow dentro da TUI é a evolução natural.',
          ],
        },
      };
    case 'whoami':
    case 'logout':
      return { kind: 'async', id };
    case 'doctor':
      // EST-0970 — `/doctor` é roteado ANTES (run.tsx) p/ o probe com o contexto da
      // sessão (token/memória/workspace/modo). Cair AQUI só acontece sem esse
      // roteamento (ex.: teste linear) ⇒ nota honesta apontando o `aluy doctor` shell.
      return {
        kind: 'note',
        note: {
          title: 'doctor',
          lines: ['health-check indisponível neste contexto — rode `aluy doctor` no shell.'],
        },
      };
    case 'undo':
    case 'redo':
      // EST-0960b — `/undo`/`/redo` são roteados ANTES (run.tsx/linear) p/ o
      // UndoController (assíncrono + confirmação de concorrência). Cair aqui só
      // acontece sem esse roteamento (sem journal) ⇒ nota honesta de indisponível.
      return {
        kind: 'note',
        note: {
          title: `/${id}`,
          lines: ['desfazer/refazer indisponível neste contexto (sem journal de sessão).'],
        },
      };
    case 'rewind':
      // EST-XXXX — `/rewind` (· Esc Esc) é roteado ANTES (App) p/ o seletor de
      // checkpoints (interativo, precisa de TTY + registry). Cair aqui só acontece sem
      // esse roteamento (não-TTY/linear ou sem fonte de checkpoints) ⇒ nota honesta.
      return {
        kind: 'note',
        note: {
          title: '/rewind',
          lines: ['rewind indisponível neste contexto (precisa da TUI interativa).'],
        },
      };
    case 'memory':
      // EST-0983 — o `/memory` REAL (lista/edita/esquece/fixa pela mecânica interna
      // + Plan-deny nas mutações) é roteado ANTES em run.tsx (precisa da AgentMemory
      // + o modo da sessão). Cair aqui só sem esse roteamento (não-TTY sem wiring):
      // explica o comando sem tocar a memória.
      return {
        kind: 'note',
        note: {
          title: 'memory',
          lines: [
            'vejo/edito/esqueço/fixo os fatos que o agente lembra entre sessões',
            '(global + projeto), pela mecânica interna — nunca por `cat` (read-deny).',
            'a memória é relembrada como DADO, nunca instrução.',
            'uso: /memory [forget|edit|pin|unpin <id>]',
          ],
        },
      };
    case 'todo':
      // EST-1108 — o `/todo` REAL (lista/done/clear pela mecânica interna +
      // Plan-deny nas mutações) é roteado ANTES em run.tsx (precisa do TodoStore
      // + o modo da sessão). Cair aqui só sem esse roteamento (não-TTY sem wiring):
      // explica o comando sem tocar o backlog.
      return {
        kind: 'note',
        note: {
          title: 'todo',
          lines: [
            'vejo/gerencio o backlog de tarefas anotadas pelo agente (persistente).',
            'o agente anota pedidos com a tool add_todo; você gerencia com /todo.',
            'uso: /todo [done <id>|clear]',
          ],
        },
      };
    case 'history':
      // EST-0972 — o `/history` REAL (lista as sessões salvas + retoma a escolhida AO
      // VIVO, reusando o restoreBlocks/seedHistory do boot) é roteado ANTES: no TTY a
      // App abre o PICKER; no não-TTY o `runHistoryLinear` lista + aceita um id. Cair
      // aqui só sem esse roteamento (sem store de sessões): explica o comando.
      return {
        kind: 'note',
        note: {
          title: 'history',
          lines: [
            'lista as sessões anteriores (data · diretório · 1ª mensagem) e RETOMA a',
            'escolhida sem sair do aluy — a conversa antiga reaparece e você continua.',
            'no TTY: ↑↓ navega · enter retoma · esc cancela. no não-TTY: `/history <id>`.',
          ],
        },
      };
    case 'ask':
      // EST-ASK · ADR-0080 — o `/ask` REAL (pergunta PARALELA read-only via
      // `controller.askParallel`, caller dedicado sem tools) é roteado ANTES em run.tsx
      // (precisa do controller + do caller paralelo). Cair aqui = sem esse wiring
      // (headless/não-TTY): explica o comando, sem executar.
      return {
        kind: 'note',
        note: {
          title: '/ask',
          lines: [
            '`/ask <pergunta>` responde em PARALELO, sem parar o trabalho em curso —',
            'read-only (não toca arquivos nem o histórico). Disponível no modo interativo.',
          ],
        },
      };
    case 'rooms':
      // EST-ROOMS-3 · ADR-0081 — o `/rooms` REAL (cria/lista/observa salas via o controller)
      // é roteado ANTES em run.tsx. Cair aqui = sem wiring (headless): explica o comando.
      return {
        kind: 'note',
        note: {
          title: '/rooms',
          lines: [
            '`/rooms` (ou `list`) lista as salas (código · msgs · atividade · quem);',
            '`/rooms new` cria; `/rooms read [código]` snapshot — SEM código abre um PICKER',
            'pra escolher a sala; `/rooms watch <código>` observa AO VIVO. Modo interativo.',
          ],
        },
      };
    case 'subagent':
      // ADR-0126(A) — o `/subagent` REAL (abre o foco 1:1) é roteado em run.tsx. Aqui só explica.
      return {
        kind: 'note',
        note: {
          title: '/subagent',
          lines: [
            '`/subagent <nome>` abre uma conversa 1:1 FOCADA e contínua com um perfil `.md`;',
            'sua entrada vai SÓ p/ ele (escopo ⊆ você). `/back` volta ao principal. Modo interativo.',
          ],
        },
      };
    case 'back':
      return {
        kind: 'note',
        note: {
          title: '/back',
          lines: ['`/back` sai do foco de `/subagent` e volta ao agente principal.'],
        },
      };
    case 'rename':
      // EST-0972 — o `/rename` REAL (define nome+cor da sessão, persiste no record e
      // re-renderiza o ●+nome no composer) é roteado ANTES em run.tsx/App via
      // `routeRename` (precisa do controller + auto-save). Cair aqui só sem esse
      // roteamento (não-TTY sem wiring): explica o comando, sem mudar nada.
      return {
        kind: 'note',
        note: {
          title: 'rename',
          lines: [
            'dou um NOME amigável + uma COR de identificação à sessão corrente:',
            '  /rename <nome>            → nome + cor automática (estável pelo nome)',
            '  /rename <nome> --cor <cor> → nome + cor escolhida (paleta do DS)',
            '  /rename                   → mostra o nome/cor atuais',
            '  /rename --limpar          → remove o rótulo (volta ao default)',
            'o ●+nome aparece no composer e no /history. é só identificação local',
            '(dado de UI) — nunca sai da sua máquina.',
          ],
        },
      };
    case 'clear':
      return { kind: 'clear' };
    case 'compact':
      // EST-0973 — o `/compact` REAL (resume a conversa via broker e continua) é
      // roteado ANTES em run.tsx/App (precisa do controller + chamada de modelo).
      // Cair aqui só sem esse roteamento (não-TTY sem wiring): explica o que faz.
      return {
        kind: 'note',
        note: {
          title: 'compact',
          lines: [
            'resumo a conversa até aqui num sumário denso (decisões, estado, arquivos',
            'tocados) e continuo a sessão com o contexto reduzido — libera a janela.',
            'o resumo é gerado pelo modelo via broker; nada sai do dado para instrução.',
          ],
        },
      };
    case 'theme':
      // EST-0966 — o `/theme` é roteado ANTES (run.tsx/App) via `buildThemeEffect`
      // (precisa do tema ativo + arg). Cair aqui só sem esse roteamento: lista os
      // temas sem trocar (default seguro).
      return buildThemeEffect('', THEMES[0]!.name);
    case 'lang':
      // EST-0989 (i18n) — o `/lang` é roteado ANTES (run.tsx/App) via `buildLangEffect`
      // (precisa do idioma ativo + arg). Cair aqui só sem esse roteamento: lista os
      // idiomas sem trocar (default seguro, no idioma default pt-BR).
      return buildLangEffect('', LANGS[0]!.code);
    case 'cycle':
      // EST-0981 · ADR-0062 · CLI-SEC-14 — o `/cycle` REAL (re-dispara o loop em ciclos
      // pela MESMA catraca, cercado por paradas DURAS, parável) é roteado ANTES em
      // run.tsx (precisa do controller + loop + freio). Cair aqui só sem esse
      // roteamento (não-TTY sem wiring): explica o que faz, sem rodar nada.
      return {
        kind: 'note',
        note: {
          title: 'cycle',
          lines: [
            'rodo uma tarefa em CICLOS: `/cycle <intervalo|--por dur> "tarefa"`.',
            'cada ciclo passa pela MESMA catraca (não é bypass); cercado por PARADAS',
            'DURAS (duração · iterações · budget agregado · conclusão) e parável a',
            'qualquer hora. sem teto ⇒ NÃO inicia (proteção contra loop infinito).',
            'dois ritmos: fixo (intervalo/--por) e --auto (o agente decide o ritmo).',
          ],
        },
      };
    case 'cron':
      // EST-1158 — `/cron` (gerência dos jobs PERSISTENTES) é roteado ANTES em run.tsx
      // (reusa o `runCron`, async, com a saída em nota). Cair aqui só sem esse roteamento
      // (não-TTY sem wiring): explica o uso, sem rodar nada.
      return {
        kind: 'note',
        note: {
          title: 'cron',
          lines: [
            'agendamento PERSISTENTE (mesmo motor do `aluy cron`):',
            '`/cron list` · `/cron add <quando> "<tarefa>" [--yolo]` · `/cron edit <id> …`',
            '`/cron enable|disable <id>` · `/cron rm <id>`. <quando> = cron de 5 campos.',
          ],
        },
      };
    case 'notify':
      // EST-0963 — o `/notify` é roteado ANTES (run.tsx) via `buildNotifyEffect`,
      // que precisa do estado do sino + arg. Cair aqui só acontece sem esse
      // roteamento (ex.: toggle puro sem estado): aplica o toggle default (sem
      // saber o estado, presume ligar — o run.tsx nunca chega aqui).
      return buildNotifyEffect('', { enabled: false, tty: true });
    case 'split':
      // EST-0990 — o `/split` (modo view avançado) é UI PURA: a App o intercepta no
      // `runCommand` e alterna o split AO VIVO (mesmo efeito do Ctrl+L), SEM chegar
      // aqui. Cair aqui só sem TUI (não-TTY/linear): explica o comando, sem efeito.
      return {
        kind: 'note',
        note: {
          title: 'split',
          lines: [
            'liga/desliga o MODO VIEW AVANÇADO (split CHAT | LOG) — o painel de LOG de',
            'atividade (agrupado por agente) ao lado da conversa. Também via Ctrl+L.',
            '≥100 col: lado-a-lado · 60–99 col: abas (Tab alterna) · <60 col: desabilita.',
            'a preferência PERSISTE entre sessões (ui.splitView).',
          ],
        },
      };
    case 'fullscreen':
      // EST-1000 · ADR-0076 — o `/fullscreen` (alias `/cockpit`) é UI PURA: a App o
      // intercepta no `runCommand` e alterna o MODO COCKPIT AO VIVO, SEM chegar aqui.
      // Cair aqui só sem TUI (não-TTY/linear): explica o comando, sem efeito (o cockpit
      // exige TTY interativo — em pipe/CI segue inline, ADR §2).
      return {
        kind: 'note',
        note: {
          title: 'fullscreen',
          lines: [
            'liga/desliga o MODO COCKPIT (tela cheia, alt-screen): 6 regiões fixas',
            '(header/conversa/log/status/composer/hints), cada uma com scroll próprio.',
            'perde o scrollback/copy-paste NATIVOS — use /export ou ctrl+s p/ o transcript',
            'redigido. INLINE é o DEFAULT — /fullscreen sai e volta a ele. <80 col cai pro',
            'inline com aviso. a preferência PERSISTE (ui.fullscreen). só vale em TTY.',
          ],
        },
      };
    case 'mcp':
      // EST-0970 — o `/mcp` REAL (lista os servers + tools + estado da descoberta AO
      // VIVO) é roteado ANTES em run.tsx via `buildMcpNote(listing)` (precisa da config
      // lida + do resultado da descoberta da sessão). Cair aqui só sem esse roteamento
      // (não-TTY sem wiring de MCP): explica o comando, sem tocar config nem rede.
      return {
        kind: 'note',
        note: {
          title: 'mcp',
          lines: [
            'lista os servers MCP (de ~/.aluy/mcp.json, do .mcp.json do projeto e do',
            'Codex), com origem, command, estado (✓ ativo / ○ desativado) e as tools.',
            'gerencie sem editar o JSON à mão, direto na sessão:',
            '  /mcp add <nome> -- <command> [args...] · /mcp remove <nome>',
            '  /mcp disable <nome> (desliga sem desinstalar) · /mcp enable <nome>',
            'as tools MCP passam pela catraca (efeito ⇒ confirmação); nunca auto-allow.',
            'descubra novos no registro oficial: `/mcp search <termo>`.',
          ],
        },
      };
    case 'agents':
      // EST-0977 — o `/agents` REAL (lista os perfis .md MAPEADOS — válidos + rejeitados
      // com o motivo RES-MD-3) é roteado ANTES em run.tsx via `buildAgentsNote`, que
      // precisa do resultado dos loaders do boot (globalAgents/projectAgents). Cair aqui
      // só sem esse roteamento (não-TTY sem wiring): explica o comando, sem ler nada.
      return {
        kind: 'note',
        note: {
          title: 'agents',
          lines: [
            'lista os perfis de sub-agente .md que o aluy mapeou — GLOBAIS',
            '(~/.aluy/agents/*.md, config do dono) e de PROJETO (.claude/agents/*.md, dado',
            'do repo), com nome, escopo, tools (⊆ pai) e a persona. Mostra também os',
            'rejeitados (.md malformado / `tools:` ilegível) com o motivo.',
            'são os perfis que o spawn_agent (sub-agentes) invoca por nome.',
          ],
        },
      };
    case 'skills':
      // EST-1112 · ADR-0116 — o `/skills` REAL (lista as SKILLS SKILL.md MAPEADAS —
      // válidas + rejeitadas com o motivo RES-MD-3) é roteado ANTES em run.tsx via
      // `buildSkillsNote`. Cair aqui só sem esse roteamento (não-TTY sem wiring): explica
      // o comando, sem ler nada.
      return {
        kind: 'note',
        note: {
          title: 'skills',
          lines: [
            'lista as skills (SKILL.md) que o aluy mapeou — GLOBAIS',
            '(~/.aluy/skills/<nome>/SKILL.md, config do dono) e de PROJETO',
            '(.claude/skills/<nome>/SKILL.md, dado do repo), com nome, escopo e descrição.',
            'Mostra também as rejeitadas (sem name / corpo vazio) com o motivo.',
            'uma skill é uma capacidade empacotada cujas instruções são injetadas sob demanda.',
          ],
        },
      };
    case 'workflows':
      // EST-1105 — o `/workflows` REAL (lista os workflows .md MAPEADOS — válidos +
      // rejeitados com o motivo RES-MD-3) é roteado ANTES em run.tsx. Cair aqui só sem
      // esse roteamento (não-TTY sem wiring): explica o comando, sem ler nada.
      return {
        kind: 'note',
        note: {
          title: 'workflows',
          lines: [
            'lista os workflows .md que o aluy mapeou — GLOBAIS',
            '(~/.aluy/workflows/*.md, config do dono) e de PROJETO (.aluy/workflows/*.md,',
            'dado do repo), com nome, descrição e N atividades. Mostra também os rejeitados',
            '(.md malformado / sem name / sem atividades) com o motivo.',
            'workflows são fluxos de atividades que coordenam o agente (fatia 2: run).',
          ],
        },
      };
    case 'add-dir':
      // EST-0982 — o `/add-dir` REAL (lista/autoriza raízes extras via o workspace
      // da sessão) é roteado ANTES em run.tsx via `runAddDir` (precisa do
      // `built.workspace`). Cair aqui só sem esse roteamento (não-TTY sem wiring):
      // explica o comando sem mudar nada.
      return {
        kind: 'note',
        note: {
          title: 'add-dir',
          lines: [
            'autoriza um diretório EXTRA além da raiz do workspace — o agente passa a',
            'ler/editar/navegar nele (a contenção dura continua valendo em cada raiz).',
            'ATO DO USUÁRIO: o agente não tem ferramenta p/ se auto-ampliar.',
            'uso: /add-dir <path> · sem args lista as raízes · vale só nesta sessão.',
          ],
        },
      };
    case 'quit':
      return { kind: 'quit' };
  }
}

/**
 * EST-0982 · /add-dir — a face ESTREITA do workspace que o slash consome: ver as
 * raízes e ADICIONAR uma (ato do USUÁRIO). É o `WorkspacePort` concreto da sessão
 * (`built.workspace`) — a MESMA fonte de verdade do confinamento; não há um 2º
 * registro de raízes a divergir.
 */
export interface AddDirWorkspace {
  /** As raízes autorizadas (primária primeiro), canonicalizadas. */
  readonly roots: readonly string[];
  /** Autoriza uma raiz extra. Lança (com `message` legível) se inválida. */
  addRoot(requested: string): string;
}

/** Abrevia a home p/ `~` na exibição de uma raiz (legibilidade; sem mudar o dado). */
function tildify(path: string, home: string | undefined): string {
  if (!home || home === '') return path;
  if (path === home) return '~';
  return path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path;
}

/**
 * EST-0982 · /add-dir — executa o slash `/add-dir [path]` (ATO DO USUÁRIO; o
 * agente NÃO tem tool equivalente — sem auto-ampliação, nem em `--unsafe`):
 *  - SEM args ⇒ LISTA as raízes autorizadas da sessão (a primária + extras);
 *  - COM path ⇒ valida+canonicaliza+autoriza via `workspace.addRoot`. Sucesso ⇒
 *    "✓ <path> adicionado — o agente pode ler/editar/navegar nele." Já autorizado
 *    ⇒ nota idempotente. Inválido (não existe / não é dir) ⇒ erro CLARO, nada muda.
 *
 * Escopo = SESSÃO (não persiste; cada sessão nasce só com a raiz original — FU da
 * estória: `--persist` opt-in). O path-deny (journal/`~/.aluy/`) continua valendo
 * DENTRO das raízes extras: a catraca classifica pelo path e não consulta raízes.
 */
export function runAddDir(
  args: string,
  workspace: AddDirWorkspace,
  home: string | undefined = process.env.HOME,
): SlashNote {
  const arg = args.trim();
  if (arg === '') {
    const lines = workspace.roots.map(
      (r, i) =>
        `${i === 0 ? '● ' : '+ '}${tildify(r, home)}${i === 0 ? ' (raiz do workspace)' : ''}`,
    );
    return {
      title: 'add-dir',
      lines: [
        'raízes autorizadas desta sessão (o agente lê/edita/navega só dentro delas):',
        ...lines,
        'adicione outra com `/add-dir <path>` — vale só nesta sessão.',
      ],
    };
  }
  const before = workspace.roots;
  let canonical: string;
  try {
    canonical = workspace.addRoot(arg);
  } catch (e) {
    return {
      title: 'add-dir',
      lines: [
        e instanceof Error ? e.message : `não foi possível autorizar "${arg}".`,
        'uso: /add-dir <path> — o diretório precisa existir. nada mudou.',
      ],
    };
  }
  // Idempotente: o `addRoot` não duplica raiz já contida — se o conjunto não
  // cresceu, o path já estava autorizado (compara TAMANHOS, não texto de path).
  if (workspace.roots.length === before.length) {
    return {
      title: 'add-dir',
      lines: [`${tildify(canonical, home)} já está autorizado — nada a fazer.`],
    };
  }
  return {
    title: 'add-dir',
    lines: [
      `✓ ${tildify(canonical, home)} adicionado — o agente pode ler/editar/navegar nele.`,
      'vale só nesta SESSÃO (não persiste). `/add-dir` sem args lista as raízes.',
    ],
  };
}

/**
 * EST-0970 — nota do `/mcp` AO VIVO: renderiza a listagem unificada de servers (já
 * resolvida por `buildMcpListing` com a config das fontes + o resultado da descoberta da
 * sessão). PURA: só formata o DADO listável em linhas. Mostra, por server: origem, estado
 * (ok N tools / erro / —), command, env (só CHAVES — nunca valores; CLI-SEC-7) e as tools
 * prefixadas (`mcp__<server>__<tool>`). Lista vazia ⇒ dica de `aluy mcp add`.
 *
 * @param configError  erro agregado de leitura das configs (UX avisa), se houver.
 */
export function buildMcpNote(servers: readonly McpListedServer[], configError?: string): SlashNote {
  const lines: string[] = [];
  if (configError) lines.push(`⚠ config: ${configError}`);
  if (servers.length === 0) {
    lines.push('nenhum server MCP configurado.');
    lines.push('adicione sem sair daqui: /mcp add <nome> -- <command> [args...]');
    return { title: 'mcp', lines };
  }
  for (const s of servers) {
    // EST-0970 — estado do interruptor na lista: `✓ ativo` (conectado, N tools) /
    // `○ desativado` (disabled na config — a descoberta pulou) / erro / `—` (sem
    // descoberta nesta vista).
    const state =
      s.state.kind === 'ok'
        ? `✓ ativo · ${s.state.toolCount} tool${s.state.toolCount === 1 ? '' : 's'}`
        : s.state.kind === 'disabled'
          ? '○ desativado'
          : s.state.kind === 'error'
            ? `erro · ${s.state.error}`
            : '—';
    const managed = s.managed ? '' : ' [não-gerenciado pelo aluy]';
    lines.push(`${s.name} — ${originLabel(s.origin)} · ${state}${managed}`);
    lines.push(`  ${s.command}${s.args.length ? ' ' + s.args.join(' ') : ''}`);
    if (s.envKeys.length) lines.push(`  env: ${s.envKeys.join(', ')}`);
    // EST-0970 — config legada quebrada (`command:"--"`): avisa em vez de falhar mudo.
    const warning = invalidCommandWarning(s);
    if (warning !== undefined) lines.push(`  ⚠ ${warning}`);
    for (const t of s.tools) {
      lines.push(`  • ${t.qualifiedName}${t.description ? ` — ${t.description}` : ''}`);
    }
  }
  lines.push(
    'gerencie daqui: /mcp add <nome> -- <command> [args...] · /mcp remove|disable|enable <nome>.',
  );
  lines.push('tools MCP passam pela catraca (efeito ⇒ confirmação).');
  lines.push('busca no registro oficial aberto: `/mcp search <termo>`.');
  return { title: 'mcp', lines };
}

/**
 * EST-0970 (search na sessão) — interpreta o ARG do `/mcp` p/ decidir se é a
 * SUB-busca (`search <termo>`) ou a listagem padrão (`/mcp` sem args, inalterada).
 *
 * PURO (sem rede): só faz o parse do arg do slash. `null` ⇒ NÃO é busca (o run.tsx
 * segue listando os servers configurados — `/mcp` #81 intacto). `{ query }` ⇒ é
 * `search`; query vazia (`/mcp search` sem termo) ⇒ o chamador mostra o uso (sem
 * rede). A rede é do `runMcpSearchSlash` (egress fixo, reusa o #80). NÃO instala
 * nada: só LÊ e MOSTRA (instalar é `aluy mcp add`, atrás da catraca).
 */
export function parseMcpSlash(args: string): { readonly query: string } | null {
  const trimmed = args.trim();
  if (trimmed === '') return null; // `/mcp` puro ⇒ listagem (inalterado).
  const m = /^search(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!m) return null; // arg desconhecido ⇒ deixa a listagem (não inventa subcomando).
  // Colapsa espaços internos p/ a query casar com a do `aluy mcp search` (argv join).
  return { query: (m[1] ?? '').trim().replace(/\s+/g, ' ') };
}

/**
 * EST-0970 (UX) — detecta `/mcp reload`. PURO (só parse do arg). Mantido p/
 * back-compat; o novo `parseMcpRefresh` também cobre `reconnect`.
 */
export function isMcpReload(args: string): boolean {
  return /^reload$/i.test(args.trim());
}

/**
 * EST-0970 — resultado do parse de `/mcp reload|reconnect [all|<nome>]`.
 */
export interface McpRefresh {
  readonly kind: 'reconnect' | 'reload';
  readonly scope: string; // 'all' ou nome do server
}

/**
 * EST-0970 — parseia `/mcp reload|reconnect [all|<nome>]`. Devolve `null` se
 * não casar com nenhum dos dois subcomandos.
 */
export function parseMcpRefresh(args: string): McpRefresh | null {
  const trimmed = args.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(/\s+/);
  const kindStr = parts[0]!.toLowerCase();
  if (kindStr !== 'reconnect' && kindStr !== 'reload') return null;

  const scope = parts.slice(1).join(' ') || 'all';
  return { kind: kindStr, scope };
}

/**
 * EST-0970 (UX) — STUB HONESTO do `/mcp reload` (FU-VAU-002). Substituído pelo
 * reload AO VIVO (parseMcpRefresh + refreshMcp em run.tsx). Mantido p/ back-compat
 * de testes antigos.
 */
export function mcpReloadStubNote(): SlashNote {
  return {
    title: 'mcp',
    lines: [
      '/mcp reload ainda não recarrega ao vivo: a DESCOBERTA de servers MCP roda no',
      'BOOT da sessão (handshake + toolset fixados no início).',
      'reinicie a sessão para carregar os novos servers — a config gravada por',
      '`aluy mcp add` é lida no próximo boot. (follow-up: FU-VAU-002, reload ao vivo',
      'atrás da catraca.)',
    ],
  };
}

/** Nota de USO do `/mcp search` sem termo (sem rede). */
export function mcpSearchUsageNote(): SlashNote {
  return {
    title: 'mcp',
    lines: [
      'uso: /mcp search <termo>',
      'busca servers MCP no registro oficial aberto (sem login) e mostra a linha',
      '`→ aluy mcp add …` pronta p/ copiar. ex.: /mcp search github',
    ],
  };
}

/** Nota INTERINA "buscando…" enquanto a rede do `/mcp search` não volta. */
export function mcpSearchPendingNote(query: string): SlashNote {
  return { title: 'mcp', lines: [`buscando "${query}" no registro oficial…`] };
}

/**
 * F59 — inventário unificado das ferramentas do agente.
 *
 * PURO (sem I/O): as 8 nativas são fixas; MCP é opcional (passado pelo caller).
 * Em run.tsx, o `/tools` é enriquecido com a listagem MCP real (discovery);
 * aqui o fallback mostra o direcionamento base.
 */
export function buildToolsNote(
  servers: readonly McpListedServer[] | undefined,
  unsafe: boolean,
): SlashNote {
  const lines: string[] = [];

  // ── Nativas (8 fixas) ────────────────────────────────────────────────────
  const NATIVE_DESCRIPTIONS: Record<string, string> = {
    read_file: 'lê o conteúdo de um arquivo',
    write_file: 'cria um arquivo novo (ou reescreve com overwrite:true)',
    edit_file: 'edita um arquivo existente substituindo um trecho exato',
    glob: 'acha arquivos por padrão de caminho (ex.: **/*.ts)',
    grep: 'busca uma substring literal em arquivos (não regex)',
    run_command: 'executa um comando de shell',
    run_tests: 'roda testes (vitest/jest/pytest/go test) e mostra resultado',
    change_dir: 'muda o diretório de trabalho da sessão (cd)',
  };

  const EFFECT_LABEL: Record<string, string> = {
    read: 'leitura',
    write: 'escrita',
    exec: 'execução',
  };

  lines.push('ferramentas nativas (8):');
  const nativeRows = Object.entries(NATIVE_DESCRIPTIONS).map(([name, desc]) => {
    const effect =
      name === 'run_command' || name === 'run_tests'
        ? 'exec'
        : name === 'write_file' || name === 'edit_file'
          ? 'write'
          : 'read';
    return [name, EFFECT_LABEL[effect] ?? effect, desc];
  });
  // tabela COM BORDAS (ferramenta · efeito · o que faz) — desc truncada p/ não estourar.
  lines.push(
    ...boxTable(['ferramenta', 'efeito', 'o que faz'], nativeRows, { maxWidths: [14, 9, 48] }),
  );

  // ── MCP — por server ─────────────────────────────────────────────────────
  if (servers && servers.length > 0) {
    lines.push('');
    lines.push(`ferramentas MCP (${servers.length} server(s)):`);
    for (const s of servers) {
      const stateIcon =
        s.state.kind === 'ok'
          ? `✓ ${s.state.toolCount}`
          : s.state.kind === 'error'
            ? '✗ erro'
            : s.state.kind === 'disabled'
              ? '⚠ desabilitado'
              : '? desconhecido';
      lines.push(`  mcp__${s.name} (${s.command}) — ${stateIcon}`);
      if (s.state.kind === 'ok') {
        for (const t of s.tools) {
          const desc = t.description ? ` — ${t.description}` : '';
          lines.push(`    ${t.qualifiedName}${desc}`);
        }
      }
    }
  } else {
    lines.push('');
    lines.push('MCP: use /mcp para ver os servers e suas ferramentas.');
  }

  // ── spawn_agent / room ───────────────────────────────────────────────────
  lines.push('');
  lines.push('delegação:');
  lines.push('  spawn_agent — delega subtarefas a sub-agentes locais paralelos');
  lines.push('  room_post / room_read — conversa entre agentes em sala');

  // ── Estado de permissão ─────────────────────────────────────────────────
  lines.push('');
  lines.push('permissão (catraca):');
  if (unsafe) {
    lines.push('  ⚠ MODO YOLO — catraca DESLIGADA: tudo é auto-aprovado.');
  } else {
    lines.push('  leitura = allow · escrita/bash = ask · rede/destrutivo = sempre-ask');
  }

  return { title: 'tools', lines };
}

/**
 * EST-0970 (search na sessão) — runner ASSÍNCRONO do `/mcp search <termo>`.
 * REUSA o MESMO `runMcpSearch` do `aluy mcp search` (#80): egress FIXO no registro
 * oficial aberto, sem key, DADO (só lê). Devolve a nota a empurrar na sessão — a
 * lista de servers + a linha `→ aluy mcp add …`. Degradação: registro fora ⇒ a
 * própria `runMcpSearch` formata o aviso gracioso (não lança; a sessão segue viva).
 * NÃO executa/instala nada.
 */
export async function runMcpSearchSlash(query: string, fetch: RegistryFetch): Promise<SlashNote> {
  const { text } = await runMcpSearch(query, fetch);
  return { title: 'mcp', lines: text.split('\n') };
}

/**
 * Runner ASSÍNCRONO p/ `whoami`/`logout` (consomem EST-0942 via LoginService).
 * Devolve a nota a empurrar. Mensagens NEUTRAS em falha (CLI-SEC-1): nunca expõe
 * segredo nem distingue causas de auth.
 */
export async function runAsyncSlash(
  id: 'whoami' | 'logout',
  login: LoginService,
): Promise<SlashNote> {
  if (id === 'whoami') {
    try {
      const cred = await login.whoami();
      if (!cred) {
        return { title: 'whoami', lines: ['não autenticado — rode `aluy login`.'] };
      }
      return {
        title: 'whoami',
        lines: [
          `user: ${cred.user ?? '— (PAT — use device-flow p/ ver o usuário)'}`,
          `org: ${cred.organization_id}`,
          `escopos: ${cred.scopes.join(', ')}`,
          `tipo: ${cred.kind === 'pat' ? 'PAT' : 'sessão device-flow'}`,
          // NUNCA o segredo: só o hint redigido (CLI-SEC-2).
          `token: ${cred.token_hint} (redigido — o segredo vive só no keychain)`,
        ],
      };
    } catch {
      return { title: 'whoami', lines: ['não foi possível ler a credencial.'] };
    }
  }
  // logout
  try {
    const { revoked } = await login.logout();
    return {
      title: 'logout',
      lines: [
        revoked
          ? 'sessão revogada no servidor e credencial apagada do keychain.'
          : 'credencial apagada do keychain (nada a revogar no servidor).',
      ],
    };
  } catch {
    return { title: 'logout', lines: ['não foi possível concluir o logout — tente de novo.'] };
  }
}

/** Aplica um `SlashEffect` síncrono ao controller (note/clear). */
export function applySlashEffect(effect: SlashEffect, controller: SessionController): void {
  if (effect.kind === 'note') {
    controller.pushNote(effect.note.title, effect.note.lines);
  } else if (effect.kind === 'clear') {
    controller.clear();
  }
  // 'quit'/'async' são tratados pelo chamador (precisam do instance.unmount / login).
}
