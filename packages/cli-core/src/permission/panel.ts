// EST-0968 · CLI-SEC-3 — a API SEGURA de mutacao de estado da catraca, p/ o painel
// interativo `/permissions` do `@aluy/cli`. ESTE arquivo e a FRONTEIRA: o painel
// (UI no `@aluy/cli`) so altera a catraca PELO QUE ESTA EXPOSTO AQUI. Nada que
// passe por aqui pode setar uma categoria sempre-ask (destrutivo/rede/sudo/escrita-
// fora/segredo) p/ `allow` — essa e a proteca anti-injecao do menu (a estoria diz:
// o painel NAO e bypass do CLI-SEC-3; o UNICO bypass total continua sendo `--unsafe`,
// com o banner vermelho).
//
// O painel pode mudar TRES coisas (todas estado de SESSAO, nunca persistido):
//   1. MODO (plan/normal/unsafe) — via `engine.setMode` (ja existente, EST-0959).
//   2. GRANTS de sessao — listar e REVOGAR (so restritivo) via `SessionGrants`.
//   3. DEFAULT de tools SEGURAS — ajustar uma tool de LEITURA p/ sempre-allow, ou
//      voltar a ask. So tools no `SAFE_TOGGLEABLE_TOOLS` (read-only, sem efeito
//      mutante) podem ir p/ `allow`. run_command/edit_file NUNCA aparecem como
//      "allow-avel" no painel (o piso de CLI-SEC-3 ja impediria, mas o painel nem
//      OFERECE — defesa em profundidade).
//
// As categorias TRAVADAS sao DADO (so-leitura) que o painel renderiza p/ explicar
// "por que isso nao pode virar allow aqui". NAO ha setter p/ elas — by design.
//
// PORTAVEL: tipos + dado + uma funcao pura de guarda. Sem I/O, sem Ink.

import type { PermissionCategory } from './gate.js';

/**
 * Tools de LEITURA pura cujo default a sessao PODE deixar `allow` pelo painel
 * (sem efeito mutante — read_file/grep ja sao allow por padrao, mas o painel
 * deixa o usuario re-afirmar/voltar a ask). Esta lista e FECHADA: e a unica porta
 * por onde o painel pode emitir um `allow`. Qualquer tool fora dela so pode ir
 * p/ `ask`/`deny` pelo painel — jamais `allow`.
 *
 * ⚠ CLI-SEC-3: run_command e edit_file NAO estao aqui — eles tem efeito e o painel
 * nunca os oferece como sempre-allow (alem do piso da engine que ja os trava).
 */
export const SAFE_TOGGLEABLE_TOOLS: readonly string[] = ['read_file', 'grep'];

/** Decisoes que o painel pode setar p/ uma tool segura (nunca relaxa categoria). */
export type SafeToolDecision = 'allow' | 'ask';

/**
 * Uma categoria TRAVADA (sempre-ask / deny nao-relaxavel) — DADO so-leitura que o
 * painel mostra como "TRAVADA" com a explicacao. NAO ha caminho que a sete p/
 * `allow` (CLI-SEC-3). `lock: 'always-ask'` ⇒ pergunta sempre; `lock: 'deny'` ⇒
 * negada acima ate do `--unsafe` (o journal `~/.aluy/`).
 */
export interface LockedCategory {
  readonly category: PermissionCategory;
  /** Rotulo curto p/ a UI (PT-BR). */
  readonly label: string;
  /** Explicacao do PORQUE esta travada (a UI mostra ao expandir). */
  readonly why: string;
  /** `always-ask` (pergunta sempre) ou `deny` (negado, nem `--unsafe` libera). */
  readonly lock: 'always-ask' | 'deny';
}

/**
 * O CATALOGO das categorias TRAVADAS (CLI-SEC-3). E a fonte unica que o painel
 * `/permissions` renderiza p/ deixar claro o que NAO e relaxavel pelo menu — e
 * por que. Espelha as categorias `always-ask:*` + o `journal-read-deny` da engine.
 * Ordem = ordem de exibicao. Puramente DESCRITIVO: mudar este array NAO muda a
 * catraca (a engine decide pelas categorias reais em categories.ts); ele so
 * DOCUMENTA p/ o humano. Por isso e seguro — nao ha setter associado.
 */
export const LOCKED_CATEGORIES: readonly LockedCategory[] = [
  {
    category: 'always-ask:destructive',
    label: 'destrutivo (rm -rf, git push --force, dd)',
    why: 'apaga/sobrescreve dados de forma irreversivel — pergunta sempre, mostrando o efeito exato. So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:network',
    label: 'rede (curl | sh, wget, ssh, scp)',
    why: 'sai da maquina / baixa-e-executa codigo remoto — o pior caso de injecao. So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:escalation',
    label: 'escalada (sudo, su, doas, setuid)',
    why: 'eleva privilegio alem do usuario — pergunta sempre. So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:package-exec',
    label: 'exec de pacote (npm i, npx, pip install)',
    why: 'instala/executa codigo de terceiros — pergunta sempre. So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:config-startup',
    label: 'config/startup (.bashrc, .git/hooks, package.json)',
    why: 'muda o que roda no proximo start do shell/projeto — pergunta sempre. So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:outside-workspace',
    label: 'escrita FORA do workspace',
    why: 'escreve fora do diretorio do projeto (home/system) — pergunta sempre. So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:sensitive-read',
    label: 'leitura de segredos (~/.ssh, ~/.aws, .env, *.key)',
    why: 'le credenciais/chaves privadas — pergunta sempre (ou nega os mais criticos). So via --yolo (com o aviso vermelho).',
    lock: 'always-ask',
  },
  {
    category: 'always-ask:journal-read-deny',
    label: 'leitura do journal ~/.aluy/ (undo)',
    why: 'o journal guarda o conteudo-ANTES de cada edicao (possivel segredo): NEGADO por qualquer canal, ACIMA ate do --yolo. Nem o bypass total libera.',
    lock: 'deny',
  },
  {
    // EST-0974 — escrita na config local do Aluy (hooks.json/commands/config).
    category: 'always-ask:aluy-config-write-deny',
    label: 'escrita na config ~/.aluy/ (hooks.json, commands/)',
    why: 'editar a config de HOOK e ato do USUARIO, nao do agente: senao um README malicioso plantaria um hook que roda sempre. NEGADO por qualquer canal, ACIMA ate do --yolo.',
    lock: 'deny',
  },
];

/**
 * GUARDA anti-injecao (o coracao do CLI-SEC-3 no painel): so e `true` se a dupla
 * `(tool, decision)` e SEGURA p/ o painel aplicar. `allow` SO e seguro p/ uma tool
 * da `SAFE_TOGGLEABLE_TOOLS` (read-only). Qualquer outra tool com `allow` ⇒ `false`
 * (o painel NAO oferece e, se forcado, e rejeitado). `ask` e sempre seguro (mais
 * restritivo). Esta funcao e o ponto unico de decisao do que o painel pode mexer —
 * o gate FORTE do `seguranca` confere AQUI que nao ha caminho p/ allow de categoria.
 */
export function isSafeToolDefaultChange(tool: string, decision: SafeToolDecision): boolean {
  if (decision === 'ask') return true;
  // decision === 'allow': so p/ tools read-only da lista fechada.
  return SAFE_TOGGLEABLE_TOOLS.includes(tool);
}
