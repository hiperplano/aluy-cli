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

import type { LoginService, RegistryFetch, ConnectorSecretStore } from '@hiperplano/aluy-cli-core';
import {
  invalidCommandWarning,
  originLabel,
  redactTelegramToken,
  type McpListedServer,
} from '@hiperplano/aluy-cli-core';
import {
  UserConfigStore,
  telegramAllowlist,
  addTelegramAllow,
  removeTelegramAllow,
} from '../io/user-config.js';
import { runMcpSearch } from '../mcp/registry-search.js';
import type { SessionController } from '../session/controller.js';
import { NATIVE_COMMANDS, type NativeCommandId } from './commands.js';
import { THEMES, resolveThemeName, type ThemeName } from '../ui/theme/themes.js';
import { tableLines } from '../ui/table-lines.js';
import { LANGS, resolveLang, t as translate, type Lang } from '../i18n/index.js';
import { PROVIDERS, resolveProviderName } from '../model/providers.js';
import { PromptInterruptedError, type TerminalIO } from '../auth/io.js';
import type { StoreApiKeyResult } from '../model/local/credential-resolver.js';
import {
  parseJanelaDigitada,
  explicaRecusa,
  isPlausibleContextWindow,
} from '@hiperplano/aluy-cli-core';

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
  /**
   * F-PROV-LISTA-UNICA — os providers CONHECIDOS agora. Injetado porque a fonte da
   * verdade mudou de lugar e este módulo é PURO.
   *
   * O BUG que isto fecha (medido no TTY): `/provider <nome>` respondia "provider
   * desconhecido — disponíveis: openrouter, deepseek" para um provider que a PRÓPRIA
   * sessão estava usando. A causa é a mesma doença desta série — DUAS listas: o
   * `/provider` sem argumento abre o picker sobre o catálogo REAL (built-ins +
   * `providers[]` do config, 9+ entradas), enquanto o `/provider <nome>` casava contra
   * a `PROVIDERS` deste módulo: um SEED de DOIS itens herdado do broker. Provider custom
   * — que é justamente o caso de quem usa BYO — nunca era encontrado.
   *
   * Ausente ⇒ cai no seed antigo (não-regressão para os callers que ainda não injetam).
   */
  catalogo?: readonly { readonly name: string; readonly summary?: string }[],
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
          // Mesma estética das outras listagens (`tableLines`: cabeçalho + régua) — o
          // dono pediu "tudo na mesma estética". Em linha corrida o resumo empurrava o
          // nome para uma coluna diferente a cada linha e o `●` do ativo se perdia no
          // meio do texto; em coluna, o marcador fica na margem e o olho o acha.
          ...tableLines(
            (catalogo ?? PROVIDERS).map((p) => {
              const marca = p.name === currentProvider ? '●' : ' ';
              const padrao = 'isDefault' in p && p.isDefault === true ? ' (padrão)' : '';
              const desc = 'summary' in p && p.summary !== undefined ? p.summary : '';
              return [`${marca} ${p.name}${padrao}`, desc];
            }),
            { headers: ['  provider', 'o que é'], maxWidths: [28, 52] },
          ),
          '◍ só o NOME vai ao broker, que resolve provider/credencial (nunca exibido)',
          'pareia com o modelo Custom (`/model` → Custom). fora de Custom, é ignorado.',
        ],
      },
    };
  }
  // F-PROV-LISTA-UNICA — casa contra o catálogo INJETADO quando ele veio; só cai no
  // `resolveProviderName` (seed de dois) quando ninguém injetou nada.
  const doCatalogo = catalogo?.find((p) => p.name.toLowerCase() === arg.toLowerCase());
  // `label` é só apresentação: o catálogo injetado pode não trazer, e aí o NOME serve.
  const entry =
    doCatalogo !== undefined
      ? { name: doCatalogo.name, label: doCatalogo.name }
      : resolveProviderName(arg);
  if (!entry) {
    return {
      kind: 'provider',
      provider: undefined,
      note: {
        title: 'provider',
        lines: [
          `provider desconhecido: "${arg}".`,
          `disponíveis: ${(catalogo ?? PROVIDERS).map((p) => p.name).join(', ')}.`,
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
      // 3 métricas, cada uma com rótulo + valor — uma tabela de 2 colunas lê melhor
      // que 3 linhas soltas (o rótulo vira ponto de referência fixo à esquerda).
      return {
        kind: 'note',
        note: {
          title: 'usage',
          lines: tableLines(
            [
              ['tokens nesta sessão', abbrev(ctx.usage.tokens)],
              ['janela de contexto', `${ctx.usage.windowPct}% usada`],
              ['tier', ctx.usage.tier],
            ],
            { headers: ['métrica', 'valor'] },
          ),
        },
      };
    case 'permissions': {
      // categoria → política: o que a pessoa quer saber ao rodar /permissions é "o
      // que passa direto vs. o que me interrompe" — 2 colunas bastam (a mesma tabela
      // vale de referência sob YOLO, mesmo com a catraca desligada agora).
      const policyTable = tableLines(
        [
          ['leitura (read/grep)', 'allow'],
          ['escrita (edit) / bash (run_command)', 'ask — mostra o efeito exato'],
          ['sempre-ask', 'rede/destrutivo/escalada/exec-de-pacote/config — sempre pergunta'],
        ],
        { headers: ['categoria', 'política'] },
      );
      return {
        kind: 'note',
        note: {
          title: 'permissions',
          lines: ctx.unsafe
            ? [
                '⚠ MODO YOLO ativo — a catraca está DESLIGADA: tudo é auto-aprovado.',
                'sem --yolo seguem as regras abaixo (referência — não em vigor agora):',
                ...policyTable,
              ]
            : [...policyTable, '', 'regras por workspace = evolução pós-v1'],
        },
      };
    }
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
            'analiso o repo (stack, comandos, estrutura) e crio um ALUY.md na raiz',
            'com esse contexto — você confirma a escrita (diff) e edita à vontade.',
            'o agente lê o ALUY.md como contexto de projeto no boot de cada sessão.',
          ],
        },
      };
    case 'login':
      // Achado do dono ("o /login não funciona") — isto aqui SEMPRE citava o device-flow
      // do BROKER, mesmo quando a sessão está no backend LOCAL (BYO) — que é o único que
      // este `/login` executa DE VERDADE hoje (`runLoginSlash`, roteado ANTES em run.tsx,
      // espelha `/telegram`: precisa do provider ATIVO + I/O de prompt, fora do alcance
      // de `buildSlashEffect`). Cair AQUI só acontece sem esse roteamento (não-TTY/testes/
      // sem wiring) ⇒ nota HONESTA cobrindo os dois backends, sem fingir ter rodado nada:
      //   - local (BYO): o `/login` guarda a chave do provider ativo, e reusa a já
      //     guardada em vez de reexigir digitar — mas só quando roteado de verdade.
      //   - broker (conta): login de CONTA não roda dentro da sessão (decisão do dono —
      //     "ainda não temos os modelos do aluy"); `aluy login` no terminal é o caminho
      //     real (o MESMO que o aviso de boot já usa) — sem prometer uma versão futura.
      return {
        kind: 'note',
        note: {
          title: 'login',
          lines: [
            'sob backend local (BYO): grava a API key do provider ativo — se já houver uma',
            'guardada, oferece REUSAR em vez de pedir pra digitar de novo.',
            'sob backend broker (conta): ainda não roda dentro da sessão — rode `aluy login`',
            'num terminal (ou defina ALUY_TOKEN).',
          ],
        },
      };
    case 'whoami':
    case 'logout':
      return { kind: 'async', id };
    case 'window':
      // `/window` é roteado ANTES (run.tsx) p/ `runWindowSlash`, que precisa do modelo
      // ativo, do provider e do config. Cair AQUI só acontece sem esse roteamento (ex.:
      // teste linear) ⇒ nota honesta, mesmo padrão do `/telegram` logo abaixo.
      return {
        kind: 'note',
        note: {
          title: 'janela',
          lines: ['a janela de contexto só pode ser ajustada na sessão interativa.'],
        },
      };
    case 'telegram':
      // `/telegram` é roteado ANTES (run.tsx) p/ `runTelegramSlash` com os `args` (config +
      // keychain). Cair AQUI só acontece sem esse roteamento (ex.: teste linear) ⇒ nota honesta.
      return {
        kind: 'note',
        note: {
          title: 'telegram',
          lines: ['uso: /telegram [status | allow <chat-id> | deny <chat-id> | logout | login]'],
        },
      };
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
    case 'suggest':
      // F197 — o `/suggest [on|off]` (sugestão de próximo prompt) é UI PURA: a App o
      // intercepta no `runCommand` e alterna o ghost AO VIVO, SEM chegar aqui. Cair aqui
      // só sem TUI (não-TTY/linear): explica o comando, sem efeito.
      return {
        kind: 'note',
        note: {
          title: 'suggest',
          lines: [
            'liga/desliga a SUGESTÃO DE PRÓXIMO PROMPT: ao fim de um turno, com o composer',
            'vazio, aparece um ghost (dim) do que pedir a seguir; Tab o aceita no composer.',
            'a geração é heurística LOCAL (sem modelo/tokens — não gasta seu provider).',
            'default LIGADO. `/suggest on|off` força; a preferência PERSISTE (ui.suggestions).',
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
    case 'export':
      // F179 — o `/export` REAL grava o transcript REDIGIDO (CLI-SEC-6) em
      // ~/.aluy/exports/; é roteado ANTES em run.tsx/App via `onExportTranscript`
      // (precisa dos blocos vivos + store + catraca). Cair aqui só sem esse roteamento
      // (não-TTY/linear): explica o comando, sem gravar nada.
      return {
        kind: 'note',
        note: {
          title: 'export',
          lines: [
            'grava o transcript desta sessão num arquivo markdown em ~/.aluy/exports/',
            '(0600), JÁ REDIGIDO: segredos/tokens que apareceram na tela',
            'saem como ‹redigido› no arquivo. Útil p/ copiar/compartilhar a conversa.',
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
    case 'inventory':
      // LOTE-2 — o `/inventory` REAL (lista o que a sessão carregou da .aluy/, com os loaders +
      // o `state.governance`) é roteado ANTES em run.tsx. Cair aqui só sem esse roteamento
      // (não-TTY sem wiring): explica o comando, sem ler nada.
      return {
        kind: 'note',
        note: {
          title: 'inventory',
          lines: [
            'inventário do que a sessão carregou da .aluy/ (+ ~/.aluy/):',
            'ALUY.md, agentes, comandos, skills, workflows e memória de projeto —',
            'com as contagens (espelhadas na StatusBar como ⌁) e os nomes.',
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
    case 'service':
      // ADR-0158 (aceito, APR-0148) — o `/service` REAL (lista/status contra o
      // registry confinado de `~/.aluy/services/`) é roteado ANTES em run.tsx (espelha
      // `/agents`/`/workflows`). Cair aqui só sem esse roteamento (não-TTY sem wiring):
      // explica o comando, sem ler nada. `create`/`start`/`stop`/`attach` (fase 2) são
      // honestos mesmo NO roteamento real — aqui nem chegam a isso.
      return {
        kind: 'note',
        note: {
          title: 'service',
          lines: [
            'SERVIÇOS plugáveis — papéis contínuos (trader, pesquisador, …):',
            'um diretório-manifesto em ~/.aluy/services/<nome>/ com service.md (contrato',
            'duro + orquestrador) e as subpastas agents/workflows/skills/… já existentes.',
            'uso: /service [list | status <nome> | install <path|git-url> | uninstall <nome>]',
            'create/start/stop/attach chegam numa fase seguinte (o processo-por-serviço).',
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

/** Os 4 estados possíveis de um server na listagem — usados p/ AGRUPAR (§ abaixo). */
type McpGroupKey = 'ok' | 'error' | 'disabled' | 'unknown';

/** Em que grupo um server cai — mesma ordem em que os grupos aparecem na lista. */
function mcpGroupOf(s: McpListedServer): McpGroupKey {
  return s.state.kind;
}

/** Cabeçalho (PT-BR) de cada grupo, com a contagem — espelha `/agents`/`/skills`. */
function mcpGroupHeading(key: McpGroupKey, count: number): string {
  switch (key) {
    case 'ok':
      return `ativos (${count}) — conectados, com as tools descobertas:`;
    case 'error':
      return `com erro (${count}) — falharam a conexão:`;
    case 'disabled':
      return `desativados (${count}) — off na config, a descoberta pulou:`;
    case 'unknown':
      return `sem descoberta (${count}) — sem handshake nesta vista:`;
  }
}

/**
 * EST-0970 (reorg) — nota do `/mcp` AO VIVO: renderiza a listagem unificada de servers (já
 * resolvida por `buildMcpListing` com a config das fontes + o resultado da descoberta da
 * sessão). PURA: só formata o DADO listável em linhas. Mostra um resumo (N servers · quantos
 * ativos/erro/desativados/sem-descoberta), depois cada server AGRUPADO por estado — ativos
 * primeiro (o caso útil de ver rápido), erro (precisa de atenção), desativado (intencional) e
 * sem descoberta por último —, alfabético dentro do grupo (determinístico; não depende da
 * ordem de declaração das fontes). Por server: origem, estado (ok N tools / erro / desativado
 * / —), command, env (só CHAVES — nunca valores; CLI-SEC-7) e as tools prefixadas
 * (`mcp__<server>__<tool>`) numa tabela (nome + descrição — nunca um bloco de texto corrido).
 * Lista vazia ⇒ dica de `aluy mcp add`.
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

  // Resumo no topo: quantos servers, quantos em cada estado, quantas tools no total —
  // a visão panorâmica que faltava (a lista corrida não deixava ver de cara).
  const counts: Record<McpGroupKey, number> = { ok: 0, error: 0, disabled: 0, unknown: 0 };
  for (const s of servers) counts[mcpGroupOf(s)] += 1;
  const totalTools = servers.reduce((n, s) => n + s.tools.length, 0);
  const summary = (
    [
      [counts.ok, `✓ ${counts.ok} ativo${counts.ok === 1 ? '' : 's'}`],
      [counts.error, `✗ ${counts.error} erro`],
      [counts.disabled, `○ ${counts.disabled} desativado${counts.disabled === 1 ? '' : 's'}`],
      [counts.unknown, `? ${counts.unknown} sem descoberta`],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([, label]) => label);
  lines.push(
    `${servers.length} server${servers.length === 1 ? '' : 's'} MCP — ${summary.join(' · ')} · ` +
      `${totalTools} tool${totalTools === 1 ? '' : 's'} no total`,
  );

  // Agrupa por estado (ok < erro < desativado < desconhecido) e ordena alfabético
  // dentro do grupo — organizado, em vez da ordem arbitrária de declaração das fontes.
  const GROUP_ORDER: readonly McpGroupKey[] = ['ok', 'error', 'disabled', 'unknown'];
  const sorted = [...servers].sort((a, b) => {
    const g = GROUP_ORDER.indexOf(mcpGroupOf(a)) - GROUP_ORDER.indexOf(mcpGroupOf(b));
    return g !== 0 ? g : a.name.localeCompare(b.name);
  });

  let currentGroup: McpGroupKey | undefined;
  for (const s of sorted) {
    const group = mcpGroupOf(s);
    if (group !== currentGroup) {
      currentGroup = group;
      lines.push('');
      lines.push(mcpGroupHeading(group, counts[group]));
    } else {
      lines.push(''); // separa do server anterior do MESMO grupo — nada de texto corrido.
    }
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
    // Tools em TABELA (nome + descrição) — legível mesmo com várias; nunca um bloco
    // de bullets corridos sem alinhamento (o que o dono reclamou no `/mcp list`).
    if (s.tools.length > 0) {
      lines.push(
        ...tableLines(
          s.tools.map((t) => [t.qualifiedName, t.description ?? '']),
          { headers: ['tool', 'descrição'], maxWidths: [40, 52] },
        ),
      );
    }
  }

  lines.push('');
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
 * GS-MD7 (recarga viva dos agentes `.md`) — detecta `/agents refresh` (sinônimo:
 * `reload`, o MESMO verbo do `/mcp`). PURO (só parse do arg).
 *
 * Existe porque a descoberta de agentes rodava SÓ no boot. O relato do dono: o Aluy
 * criou `~/.aluy/agents/ux-frontend.md` com `write_file` (sucesso) e o
 * `spawn_agent({ agent: "ux-frontend" })` seguinte foi RECUSADO — "agente desconhecido
 * (GS-MD7)". Ele teve que sair e reabrir a sessão, perdendo o contexto do trabalho. O
 * `/mcp reload` já resolvia exatamente esta classe de problema para os servers MCP; o
 * `/agents refresh` é a mesma porta, para a mesma doença, na outra fonte de `.md`.
 *
 * Sem SCOPE (diferente do `parseMcpRefresh`): não há "server" a nomear — as duas pastas
 * confinadas são relidas juntas, e reler uma pasta que não mudou é inerte.
 */
export function parseAgentsRefresh(args: string): boolean {
  return /^(refresh|reload)$/i.test(args.trim());
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
  // Tabela (ferramenta · efeito · o que faz), desc truncada p/ não estourar. SEM bordas:
  // o dono pediu UMA estética para tudo que as barras listam, e as outras listagens já
  // usam `tableLines` (cabeçalho + régua, sem quadriculado).
  lines.push(
    ...tableLines(nativeRows, {
      headers: ['ferramenta', 'efeito', 'o que faz'],
      maxWidths: [14, 9, 48],
    }),
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
      // Tools do server ALINHADAS (nome · descrição) em vez de bullets soltos — o
      // nome (identifica a tool que o agente chama) nunca é truncado; sem descrição
      // ⇒ "—" (rule: célula vazia não é string vazia). Sem cabeçalho: é uma sub-lista
      // aninhada sob o server, não uma seção própria — leve, não uma grade.
      if (s.state.kind === 'ok' && s.tools.length > 0) {
        lines.push(
          ...tableLines(
            s.tools.map((t) => [t.qualifiedName, t.description ?? '—']),
            { indent: '    ' },
          ),
        );
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

/**
 * ADR-0120 (retomada) — a DECISÃO do `/login` da sessão, extraída PURA (sem I/O) do
 * runner assíncrono (`runLoginSlash`) — mesma disciplina de `mcpCatalog`: a mecânica de
 * terminal/keychain não se testa aqui, só o RAMO escolhido. Responde exatamente as três
 * perguntas do escopo: o backend é local? qual o provider ativo? já existe chave (ela
 * pode ser REUSADA) ou falta pedir uma nova?
 *
 * Escopo do dono (relato "o /login não funciona", "ainda não temos os modelos do aluy"):
 * SÓ o backend local (BYO — a chave do próprio provider do usuário) grava credencial
 * aqui. `broker-unsupported`/`no-active-provider` NUNCA chegam ao runner de verdade
 * (o caller — `runLoginSlash` — só é invocado sob backend local com provider já
 * resolvido por `resolveLocalProviderConfig`, que sempre resolve um); ficam só como
 * ramos DEFENSIVOS (fail-safe: nunca inventa provider, nunca assume backend).
 */
export interface LocalLoginDecisionInput {
  readonly backend: 'local' | 'broker';
  /** Provider LOCAL ativo AGORA (não o do boot — a sessão pode ter trocado via /model). */
  readonly localProvider: string | undefined;
  /** Já existe uma API key persistida (keychain OU cofre em arquivo) p/ este provider? */
  readonly hasExistingKey: boolean;
}

export type LocalLoginDecision =
  | { readonly kind: 'broker-unsupported' }
  | { readonly kind: 'no-active-provider' }
  | { readonly kind: 'ask-reuse'; readonly provider: string }
  | { readonly kind: 'prompt-new'; readonly provider: string };

export function decideLocalLogin(input: LocalLoginDecisionInput): LocalLoginDecision {
  if (input.backend !== 'local') return { kind: 'broker-unsupported' };
  if (input.localProvider === undefined || input.localProvider === '') {
    return { kind: 'no-active-provider' };
  }
  return input.hasExistingKey
    ? { kind: 'ask-reuse', provider: input.localProvider }
    : { kind: 'prompt-new', provider: input.localProvider };
}

/**
 * Interpreta a resposta do prompt "já existe uma chave — reusar? [S/n]". VAZIO/ENTER
 * (o caminho de MENOR esforço — literalmente "sem digitar de novo", o pedido do dono) e
 * s/sim/y/yes ⇒ reusa. Qualquer outra coisa (incl. lixo/começo de colagem por engano)
 * ⇒ NÃO reusa — cai no prompt de chave nova, que é sempre reversível (nunca sobrescreve
 * nem apaga a chave existente por engano; só troca se uma chave NOVA de fato for colada).
 */
export function parseReuseAnswer(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  return v === 's' || v === 'sim' || v === 'y' || v === 'yes';
}

/** Dependências de I/O do `/login` local — mesma fronteira de `runTelegramSlash`. */
export interface LoginSlashDeps {
  /** Provider LOCAL ativo AGORA (lido pelo caller na hora — não congelado no boot). */
  readonly provider: string;
  readonly io: TerminalIO;
  /** Presença JÁ resolvida (I/O) — tipicamente `hasStoredApiKey` do credential-resolver. */
  readonly hasExistingKey: () => boolean;
  /** Grava a chave — REUSA `storeApiKey` do credential-resolver (não duplica a escrita). */
  readonly storeKey: (provider: string, key: string) => StoreApiKeyResult;
}

/**
 * ADR-0120 (retomada) — runner ASSÍNCRONO do `/login` sob backend LOCAL (BYO). Roteado
 * ANTES em run.tsx (precisa do provider ativo AO VIVO + I/O de terminal — fora do
 * `buildSlashEffect` puro, mesmo padrão de `runTelegramSlash`). Fluxo:
 *   1. já existe chave p/ o provider? pergunta se REUSA (Enter = reusa, sem digitar de
 *      novo) — reusou ⇒ pronto, NADA mudou;
 *   2. senão (ou respondeu "não" ao reuso): prompt OCULTO (`secret:true`) pela chave
 *      nova e grava com `storeKey` (o MESMO `storeApiKey` do `aluy login --provider`:
 *      keychain → cofre em arquivo cifrado, nunca em claro — CLI-SEC-2).
 * CLI-SEC — a chave NUNCA aparece em `io.out`/`io.err`/na nota devolvida: só o BACKEND
 * que a guardou ("keychain do SO" / "cofre local cifrado") é reportado, nunca o valor.
 * Ctrl-C (`PromptInterruptedError`) durante qualquer prompt ⇒ nota de cancelado, sem
 * lançar — mesmo invariante de `runAsyncSlash`/`runTelegramSlash` (o `.then()` do
 * caller em run.tsx não tem `.catch()`; deixar rejeitar aqui derrubaria a sessão viva).
 */
export async function runLoginSlash(deps: LoginSlashDeps): Promise<SlashNote> {
  try {
    const decision = decideLocalLogin({
      backend: 'local',
      localProvider: deps.provider,
      hasExistingKey: deps.hasExistingKey(),
    });
    if (decision.kind === 'broker-unsupported' || decision.kind === 'no-active-provider') {
      // Defensivo — o caller só chama isto sob backend local com provider já resolvido
      // (`resolveLocalProviderConfig` sempre resolve um). Nunca deveria cair aqui.
      return {
        title: 'login',
        lines: ['login indisponível neste contexto (sem provider local ativo) — nada mudou.'],
      };
    }
    if (decision.kind === 'ask-reuse') {
      const answer = await deps.io.prompt(
        `já existe uma chave de ${decision.provider} guardada — reusar? [S/n] `,
      );
      if (parseReuseAnswer(answer)) {
        return {
          title: 'login',
          lines: [`✓ mantida a chave já guardada de ${decision.provider} — nada mudou.`],
        };
      }
    }
    const key = (
      await deps.io.prompt(`cole a API key de ${decision.provider}: `, { secret: true })
    ).trim();
    if (key === '') {
      return { title: 'login', lines: ['nenhuma chave informada — nada mudou.'] };
    }
    const result = deps.storeKey(decision.provider, key);
    return {
      title: 'login',
      lines: [
        result.backend === 'keychain'
          ? `✓ API key de ${decision.provider} guardada no keychain do SO.`
          : `✓ API key de ${decision.provider} guardada no cofre local cifrado (~/.aluy/credentials.enc).`,
      ],
    };
  } catch (err) {
    if (err instanceof PromptInterruptedError) {
      return { title: 'login', lines: ['login cancelado (Ctrl-C) — nada mudou.'] };
    }
    // Nem keychain nem cofre em arquivo funcionaram (ex.: sem Secret Service E
    // machine-id ilegível). NUNCA cai pra gravar em claro — mesma mensagem de
    // `runApiKeyLogin` (commands/local-login.ts): a causa vem do BACKEND, nunca da chave.
    return {
      title: 'login',
      lines: [
        `não foi possível gravar a chave (keychain do SO indisponível): ${err instanceof Error ? err.message : String(err)}`,
        '(a credencial nunca é gravada em texto em claro — use uma variável de ambiente como alternativa.)',
      ],
    };
  }
}

/**
 * ADR-0154 — runner do `/telegram` (setup do conector DENTRO da sessão). PURO de Ink:
 * recebe os `args` + as deps (config + secret-store) e devolve a nota a empurrar.
 *   /telegram | status        → token (redigido) + allowlist + estado (bridge inerte)
 *   /telegram allow <chat-id> → autoriza um chat-id (allowlist no config único)
 *   /telegram deny  <chat-id> → remove um chat-id
 *   /telegram logout          → apaga o token do bot do keychain
 *   /telegram login           → aponta p/ o terminal (o token é sensível — prompt sem eco lá)
 * O TOKEN nunca é digitado/exibido aqui (CLI-SEC-2): só a allowlist (DADO) é manipulada.
 */
/**
 * A linha de ESTADO do `/telegram status`. PURA.
 *
 * Distingue três coisas que antes saíam como uma só: (a) não há ponte; (b) a ponte foi
 * MONTADA mas não está recebendo; (c) está recebendo. O caso (b) é o que custou horas ao
 * dono em 01/09 — a tela dizia "ATIVA" e o processo não tinha uma conexão sequer aberta.
 */
export function estadoDaPonte(d: {
  bridgeAtiva?: boolean;
  pontePolling?: boolean;
  ponteReinicios?: number;
  ponteUltimaQueda?: string;
}): string {
  if (d.bridgeAtiva !== true) return 'estado:    ponte parada — inicie com `aluy --telegram`.';
  if (d.pontePolling === true) {
    const r = d.ponteReinicios ?? 0;
    return r > 0
      ? `estado:    ponte RECEBENDO (reerguida ${String(r)}× nesta sessão).`
      : 'estado:    ponte RECEBENDO mensagens.';
  }
  // Montada e MUDA — o caso que o status escondia.
  const motivo = d.ponteUltimaQueda;
  return motivo !== undefined
    ? `estado:    ponte MONTADA mas NÃO está recebendo (última queda: ${motivo}).`
    : 'estado:    ponte MONTADA mas ainda NÃO está recebendo.';
}

export async function runTelegramSlash(
  args: string,
  deps: {
    configStore: UserConfigStore;
    secretStore: ConnectorSecretStore;
    /** A ponte foi MONTADA nesta sessão? (o objeto existe) */
    bridgeAtiva?: boolean;
    /**
     * A ponte está DE FATO drenando o long-poll agora?
     *
     * `bridgeAtiva` sozinho MENTIA: em 01/09 o status anunciava "ponte ATIVA (1 chat
     * autorizado)" enquanto o processo da sessão segurava ZERO conexões TCP — o pump
     * tinha morrido e o objeto continuava lá. O dono descreveu o sintoma sem saber a
     * causa: "mandei uma msg, ele não viu; mandei outra, apareceu; a terceira e a quarta,
     * nada". Montada ≠ recebendo, e o status precisa dizer QUAL das duas.
     */
    pontePolling?: boolean;
    /** Quantas vezes o long-poll caiu e foi reerguido nesta sessão. */
    ponteReinicios?: number;
    /** Último motivo de queda, já redigido. */
    ponteUltimaQueda?: string;
  },
): Promise<SlashNote> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'status').toLowerCase();
  const cfg = deps.configStore.load();

  if (sub === 'status' || sub === '') {
    const token = await deps.secretStore.get().catch(() => null);
    const allow = telegramAllowlist(cfg);
    return {
      title: 'telegram',
      lines: [
        `token:     ${token ? `presente (${redactTelegramToken(token)})` : 'ausente — rode `aluy telegram login` no terminal'}`,
        `allowlist: ${allow.length > 0 ? `[${allow.join(', ')}]` : 'VAZIA (bridge fechada — /telegram allow <chat-id>)'}`,
        // `bridgeAtiva` era recebido (run.tsx passa) e NUNCA lido: a frase abaixo era
        // cravada, então o status dizia "não está ativa" mesmo com a ponte no ar. Como é
        // propriedade de interface e não variável local, o `noUnusedLocals` não reclamou e
        // a meia-correção passou pelo build.
        estadoDaPonte(deps),
      ],
    };
  }
  if (sub === 'allow' || sub === 'deny') {
    const raw = parts[1];
    const id = raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(id)) {
      return { title: 'telegram', lines: [`uso: /telegram ${sub} <chat-id>  (um inteiro)`] };
    }
    const next = sub === 'allow' ? addTelegramAllow(cfg, id) : removeTelegramAllow(cfg, id);
    deps.configStore.save({ connectors: { telegram: { allowlist: next } } });
    return {
      title: 'telegram',
      lines: [
        `chat-id ${id} ${sub === 'allow' ? 'autorizado' : 'removido'}. allowlist: [${next.join(', ')}]`,
      ],
    };
  }
  if (sub === 'logout') {
    await deps.secretStore.clear().catch(() => undefined);
    return {
      title: 'telegram',
      lines: ['token do bot removido do keychain (a bridge não autentica mais).'],
    };
  }
  if (sub === 'login') {
    return {
      title: 'telegram',
      lines: [
        'o token do bot é sensível — rode `aluy telegram login` no TERMINAL (prompt sem eco, vai p/ o keychain).',
        'aqui na sessão: /telegram status · /telegram allow <id> · /telegram deny <id> · /telegram logout',
      ],
    };
  }
  return {
    title: 'telegram',
    lines: ['uso: /telegram [status | allow <chat-id> | deny <chat-id> | logout | login]'],
  };
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

/**
 * F-WIN (emenda) — `/window [<tokens>]`: informa a JANELA DE CONTEXTO do modelo ativo
 * quando o provider não a anuncia.
 *
 * O buraco que fecha (dono, 01/09, `z-ai/glm-5.3-flash` no tokenrouter): a descoberta por
 * `GET /models` roda certo e não acha nada — verificado na conta dele, 131 modelos, e o
 * catálogo inteiro só traz `id`/`object`/`created`/`owned_by`/`supported_endpoint_types`/
 * `tags`. Sem janela, a auto-compactação fica INERTE e o `⛁ %` não sai de 0. O aviso
 * mandava editar `~/.aluy/config.json` à mão; ele pediu "dar a opção de digitar".
 *
 * Sem argumento: mostra o estado. Com argumento: valida (parser puro + o MESMO piso de
 * plausibilidade da descoberta), aplica NESTA sessão e persiste em
 * `providers[].contextByModel` — a escrita idempotente que já existia.
 */
export async function runWindowSlash(
  args: string,
  deps: {
    /** Slug do modelo ATIVO — é a chave do `contextByModel`. */
    readonly slug: string | undefined;
    /** Id do provider ativo — sem ele só dá p/ valer nesta sessão. */
    readonly providerId: string | undefined;
    /** Janela em vigor agora (0 ⇒ desconhecida). */
    readonly janelaAtual: number;
    /** Aplica na sessão em curso (efeito imediato no `⛁ %`). */
    readonly aplicar: (slug: string, tokens: number) => void;
    /** Persiste no config. `false` ⇒ vale só nesta sessão (ver o writer). */
    readonly persistir: (providerId: string, slug: string, tokens: number) => boolean;
  },
): Promise<SlashNote> {
  const slug = deps.slug?.trim() ?? '';
  const bruto = args.trim();

  if (bruto === '') {
    return {
      title: 'janela',
      lines:
        deps.janelaAtual > 0
          ? [
              `janela em vigor: ${deps.janelaAtual.toLocaleString('pt-BR')} tokens${slug !== '' ? ` (${slug})` : ''}.`,
              'p/ trocar: `/window <tokens>` — ex.: `/window 128k`.',
            ]
          : [
              `janela DESCONHECIDA${slug !== '' ? ` p/ "${slug}"` : ''} — a auto-compactação está inerte e o \`⛁ %\` fica em 0.`,
              'informe o número da doc do provider: `/window 128k` ou `/window 131072`.',
            ],
    };
  }

  const r = parseJanelaDigitada(bruto);
  if (r.tokens === undefined) {
    return { title: 'janela', lines: [explicaRecusa(r.recusa ?? 'nao-numero')] };
  }
  if (!isPlausibleContextWindow(r.tokens)) {
    // MESMO piso da descoberta (fonte única): um denominador absurdo ou vira loop de
    // compactação, ou a desliga em silêncio — e este número vai p/ o disco.
    return {
      title: 'janela',
      lines: [
        `${r.tokens.toLocaleString('pt-BR')} tokens está fora da faixa plausível p/ uma janela de contexto.`,
        'confira o número na doc do provider — ex.: `/window 128k`.',
      ],
    };
  }
  if (slug === '') {
    return {
      title: 'janela',
      lines: ['não sei qual é o modelo ativo agora — escolha um com `/model` e repita.'],
    };
  }

  deps.aplicar(slug, r.tokens);
  const gravou = deps.providerId !== undefined && deps.persistir(deps.providerId, slug, r.tokens);
  return {
    title: 'janela',
    lines: gravou
      ? [
          `janela de "${slug}" definida em ${r.tokens.toLocaleString('pt-BR')} tokens.`,
          'gravado em `~/.aluy/config.json` — as próximas sessões já abrem com ela.',
        ]
      : [
          `janela de "${slug}" definida em ${r.tokens.toLocaleString('pt-BR')} tokens NESTA sessão.`,
          'não deu p/ gravar no config (provider sem entrada própria) — na próxima sessão, repita.',
        ],
  };
}
