// EST-0944 — as 4 tools nativas: read_file, edit_file, run_command (bash), grep.
//
// Cada uma é código no pacote, com contrato (ToolEffect + validação de input +
// ToolResult). NÃO consultam o gate (o LOOP faz isso, ponto único — CLI-SEC-H1)
// e usam só as PORTAS injetáveis (portável, §8). O conteúdo que produzem volta
// ao modelo como OBSERVAÇÃO = dado (CLI-SEC-4) — a envelopagem é do context.ts.

import type {
  FileSystemPort,
  GlobTruncation,
  NativeTool,
  SearchTruncation,
  ShellChunk,
  ToolPorts,
  ToolResult,
} from './types.js';
import { redactOutputSecrets } from '../journal/redact.js';
import { GlobSyntaxError } from './glob-match.js';
import { PLAN_TOOL } from './plan.js';
import { QUESTION_TOOL } from './question.js';
import { addTodoTool, listTodosTool, doneTodoTool } from '../todo/todo-tools.js';
// ADR-0145 (frente d) — tool `capabilities` (+ sinônimo `list_tools`): o MENU VIVO
// de auto-descoberta. Ver capabilities.ts (formatação pura + segurança anti-vazamento).
import { capabilitiesTool, listToolsTool } from './capabilities.js';

// EST-1108 — re-exportadas p/ o barrel tools/index.ts.
export { addTodoTool, listTodosTool, doneTodoTool };

// ── helpers de validação de input (boundary; input do modelo = não-confiável) ─
function reqString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function optString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}
function optBool(input: Readonly<Record<string, unknown>>, key: string): boolean {
  return input[key] === true;
}
function err(observation: string): ToolResult {
  return { ok: false, observation };
}

/**
 * EST-0944 (anti-data-loss) — leitura PARA EDIÇÃO. Um editor (edit_file/write_file)
 * NUNCA pode reescrever sobre uma leitura PARCIAL: o locus concreto (NodeFileSystemPort)
 * trunca um arquivo > teto de bytes e devolve só um PREFIXO (+ um marcador textual), ou
 * substitui um binário por uma nota — se isso virar o `before` e for reescrito, o arquivo
 * é TRUNCADO no disco (e o marcador `[arquivo truncado: …]` é injetado no fonte). Esta é
 * a MESMA classe de perda de dados que o str_replace cirúrgico nasceu p/ matar.
 *
 * Usa `readFileMeta` (aditivo) quando a porta a tem: `complete=false` ⇒ devolvemos
 * `partial:true` e o caller RECUSA o efeito (nada escrito). Sem `readFileMeta`, degrada
 * p/ `readFile` (portas/testes antigos) — `complete` assumido `true`.
 */
async function readForEdit(
  fs: FileSystemPort,
  path: string,
): Promise<{ content: string; complete: boolean }> {
  if (fs.readFileMeta) {
    const m = await fs.readFileMeta(path);
    return { content: m.content, complete: m.complete };
  }
  return { content: await fs.readFile(path), complete: true };
}

/** Erro acionável quando a leitura-para-edição veio truncada/binária (anti-data-loss). */
function partialReadError(tool: string, path: string): ToolResult {
  return err(
    `${tool}: "${path}" é grande demais (lido só parcialmente) ou binário — reescrevê-lo ` +
      `AGORA TRUNCARIA o arquivo no disco. Nenhuma edição feita. Edite por outro meio (ex.: ` +
      `run_command com sed/python) ou abra um trecho menor.`,
  );
}

/** Trunca conteúdo grande p/ não estourar o contexto (CLI-SEC-8, fail-safe). */
const MAX_OBSERVATION_CHARS = 20_000;
function clip(text: string): string {
  if (text.length <= MAX_OBSERVATION_CHARS) return text;
  return `${text.slice(0, MAX_OBSERVATION_CHARS)}\n…[truncado: ${text.length - MAX_OBSERVATION_CHARS} chars omitidos]`;
}

// EST-0996 — JSONSchemas de input p/ o function-calling NATIVO (provider). São o
// MESMO contrato que a `description` já ensina em texto (o input `{path}`, `{command}`
// etc.), só estruturado. Não validam runtime (cada `run` revalida — boundary
// não-confiável); guiam o modelo a emitir o input certo no nativo. PUROS (congelados).
const READ_FILE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Caminho do arquivo (relativo ao cwd ou absoluto confinado).',
    },
  },
  required: ['path'],
  additionalProperties: false,
});
// EST-0944 — `edit_file` é EDITOR CIRÚRGICO (str_replace), NÃO sobrescreve-tudo. O
// modelo dá o TRECHO EXATO a trocar (`old_string`) e o novo (`new_string`); o resto
// do arquivo é preservado POR CONSTRUÇÃO. Espelha o Edit do Claude Code: é IMPOSSÍVEL
// truncar (só o trecho casado muda). O sobrescreve-tudo legítimo (criar arquivo novo)
// foi separado para a tool `write_file`. Bug-fix de PERDA DE DADOS: o antigo edit_file
// `{path, content}` exigia re-emitir o arquivo INTEIRO — modelo barato (Granito) parava
// cedo / mandava "… resto igual …" ⇒ o arquivo virava o conteúdo truncado.
const EDIT_FILE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Caminho do arquivo EXISTENTE a editar.' },
    old_string: {
      type: 'string',
      description:
        'O trecho EXATO a substituir (copie do arquivo, com indentação). NÃO re-emita o ' +
        'arquivo inteiro. Deve ser ÚNICO no arquivo (dê contexto suficiente em volta) — ' +
        'ou use replace_all.',
    },
    new_string: {
      type: 'string',
      description: 'O texto que substitui old_string (pode ser "" para remover o trecho).',
    },
    replace_all: {
      type: 'boolean',
      description: 'Se true, substitui TODAS as ocorrências de old_string. Default false.',
    },
  },
  required: ['path', 'old_string', 'new_string'],
  additionalProperties: false,
});
const WRITE_FILE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Caminho do arquivo a CRIAR (conteúdo completo).' },
    content: { type: 'string', description: 'Conteúdo COMPLETO do arquivo novo.' },
    overwrite: {
      type: 'boolean',
      description:
        'Só p/ REESCREVER um arquivo já existente de propósito (rewrite total). Default false. ' +
        'Por padrão, se o arquivo JÁ EXISTE, write_file RECUSA — use edit_file (old_string/' +
        'new_string) p/ editar (preserva o resto). Só passe overwrite:true p/ reescrever o ' +
        'arquivo inteiro de propósito.',
    },
  },
  required: ['path', 'content'],
  additionalProperties: false,
});
const RUN_COMMAND_SCHEMA = Object.freeze({
  type: 'object',
  properties: { command: { type: 'string', description: 'Comando de shell a executar.' } },
  required: ['command'],
  additionalProperties: false,
});
const CHANGE_DIR_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Diretório-alvo (relativo ao cwd ou absoluto confinado).',
    },
  },
  required: ['path'],
  additionalProperties: false,
});
const GREP_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    pattern: { type: 'string', description: 'Padrão a buscar.' },
    path: { type: 'string', description: 'Diretório/arquivo onde buscar (default ".").' },
  },
  required: ['pattern'],
  additionalProperties: false,
});
const GLOB_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Padrão de caminho. * (um segmento), ** (cruza /), ?, [abc], {a,b}. Ex.: "**/*.ts", "src/**/test_*.py".',
    },
    path: { type: 'string', description: 'Diretório-base da busca (default ".").' },
  },
  required: ['pattern'],
  additionalProperties: false,
});

// ADR-0145 (frente b) — FONTE ÚNICA do "quando usar" de `read_file`: alimenta a
// `description` (abaixo) E o menu do `capabilities` (mesmo campo `when`, sem duplicar
// verdade). Encadeamento: localizado por grep/glob ⇒ read_file ⇒ (se for editar)
// copie o old_string EXATO do que leu ⇒ edit_file ⇒ run_tests p/ validar.
const WHEN_READ_FILE =
  'depois de localizar um arquivo (grep/glob) e ANTES de editar — copie o old_string ' +
  'EXATO do que você ler; depois de editar, RODE run_tests/run_command p/ validar';

/** read_file — lê um arquivo. Efeito `read` (não passa por confirmação de efeito). */
export const readFileTool: NativeTool<ToolPorts> = {
  name: 'read_file',
  effect: 'read',
  group: 'arquivo',
  when: WHEN_READ_FILE,
  description: `Lê o conteúdo de um arquivo. Use QUANDO: ${WHEN_READ_FILE}. Input: { "path": string }.`,
  parameters: READ_FILE_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    const path = reqString(input, 'path');
    if (!path) return err('read_file requer "path" (string não-vazia).');
    try {
      const content = await ports.fs.readFile(path);
      return { ok: true, observation: clip(content), display: `read_file ${path}` };
    } catch (e) {
      return err(`falha ao ler "${path}": ${errMsg(e)}`);
    }
  },
};

/**
 * edit_file — EDITOR CIRÚRGICO (str_replace). Efeito `write` ⇒ PASSA pelo gate (o
 * loop garante). Lê o arquivo, acha o `old_string` (match EXATO) e o substitui por
 * `new_string`, PRESERVANDO TODO O RESTO POR CONSTRUÇÃO (`before.replace(old, new)`).
 * Computa um DIFF e o expõe em `display` (CLI-SEC-9: a confirmação mostra o diff
 * EXATO). Input: { path, old_string, new_string, replace_all? }.
 *
 * Bug-fix de PERDA DE DADOS (EST-0944): NÃO aceita mais `content` (full rewrite). Um
 * modelo barato que mandasse só um trecho como "content" TRUNCAVA o arquivo; agora
 * isso é IMPOSSÍVEL — só o trecho casado muda. ERRA (sem escrever) se `old_string`
 * não for encontrado, se for ambíguo (>1× sem `replace_all`), ou se `old===new`.
 */
export const editFileTool: NativeTool<ToolPorts> = {
  name: 'edit_file',
  effect: 'write',
  // ADR-0145 (frente d) — só o AGRUPAMENTO (menu do capabilities); a description já
  // tinha gatilho/encadeamento claro na auditoria (buraco #2 não a citou como fraca).
  group: 'arquivo',
  description:
    'Edita um arquivo EXISTENTE substituindo um trecho EXATO. NÃO re-emita o arquivo ' +
    'inteiro: dê o trecho a trocar (old_string) e o novo (new_string) — o resto é ' +
    'preservado. Input: { "path": string, "old_string": string, "new_string": string, ' +
    '"replace_all"?: boolean }. Para CRIAR um arquivo novo, use write_file.',
  parameters: EDIT_FILE_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    const path = reqString(input, 'path');
    const oldString = optString(input, 'old_string');
    const newString = optString(input, 'new_string');
    const replaceAll = optBool(input, 'replace_all');
    if (!path) return err('edit_file requer "path" (string não-vazia).');
    if (oldString === undefined || oldString === '') {
      return err('edit_file requer "old_string" (o trecho EXATO a substituir, não-vazio).');
    }
    if (newString === undefined) return err('edit_file requer "new_string" (string).');
    if (oldString === newString) {
      return err('edit_file: old_string === new_string — nada a fazer (nenhuma mudança).');
    }
    try {
      const existed = await ports.fs.exists(path);
      if (!existed) {
        return err(
          `edit_file: "${path}" não existe. Para CRIAR um arquivo novo use write_file (conteúdo completo).`,
        );
      }
      const read = await readForEdit(ports.fs, path);
      if (!read.complete) return partialReadError('edit_file', path);
      const before = read.content;
      const occurrences = countOccurrences(before, oldString);
      if (occurrences === 0) {
        return err(
          `edit_file: old_string não encontrado em "${path}" (match exato, incl. indentação). ` +
            `Copie o trecho EXATO do arquivo. Nada foi escrito.`,
        );
      }
      if (occurrences > 1 && !replaceAll) {
        return err(
          `edit_file: old_string aparece ${occurrences}× em "${path}" — ambíguo. Dê MAIS ` +
            `contexto em volta p/ torná-lo único, ou passe replace_all:true. Nada foi escrito.`,
        );
      }
      // Substituição PRESERVANDO o resto, 100% LITERAL nos DOIS lados: `old_string` e
      // `new_string` são TEXTO do arquivo (não regex/template). NÃO usamos
      // `String.replace(str, str)` porque ele interpreta `$&`/`$1`/`$$` no replacement
      // (um `$VAR`/`$1` no código novo seria corrompido). `replaceFirstLiteral`/
      // `replaceAllLiteral` cortam por índice e concatenam — sem interpretação.
      const after = replaceAll
        ? replaceAllLiteral(before, oldString, newString)
        : replaceFirstLiteral(before, oldString, newString);
      const diff = unifiedDiff(path, before, after, true);
      // EST-0960a · CA-1 — captura o `antes` ANTES de escrever, REUSANDO o `before` já
      // lido p/ o diff (CLI-SEC-9): não relê o arquivo. Best-effort, NUNCA bloqueia o
      // efeito (já aprovado pela catraca; o journal é estado local). Sem journal, no-op.
      if (ports.journal) {
        await ports.journal.captureEdit({ path, before, after, createdByEdit: false });
      }
      await ports.fs.writeFile(path, after);
      const n = replaceAll ? occurrences : 1;
      return {
        ok: true,
        observation: `arquivo editado: ${path} (${n} trecho${n > 1 ? 's' : ''} substituído${n > 1 ? 's' : ''}).`,
        display: diff,
      };
    } catch (e) {
      return err(`falha ao editar "${path}": ${errMsg(e)}`);
    }
  },
};

// EST-0944 — heurística de TRUNCAMENTO p/ o guard do write_file. Estes marcadores são
// o que um modelo barato escreve quando "encurta" um rewrite ("… resto igual …",
// "rest unchanged", "// ...", "<!-- restante do arquivo -->"). Sinal forte de perda.
const TRUNCATION_MARKERS: readonly RegExp[] = [
  /\.\.\.\s*(resto|restante|rest|remaining|unchanged|igual|omitido|same as|previous|mantenha|mant[eé]m|manter|keep|kept|preserve[ds]?)/i,
  /(rest|remainder)\s+of\s+(the\s+)?file\s+(unchanged|omitted|kept|preserved)/i,
  /(restante|resto|demais)\s+(do\s+|das\s+|dos\s+)?(arquivo|linhas|conte[uú]do|configura)\w*\s+(igual|inalterad[oa]s?|omitid[oa]s?|mantid[oa]s?)/i,
  // F17 (dogfooding) — modelo barato trunca com "mantenha o resto / mantenha as outras /
  // keep the rest". É marcador de truncamento (perda), não conteúdo legítimo.
  /(mantenha|mant[eé]m|manter|keep|preserve)\s+(o\s+|os\s+|as\s+|the\s+)?(resto|restante|demais|outras?|rest|same)/i,
  /(\/\/|#|<!--|\/\*)\s*\.\.\.\s*(\(?\s*(resto|rest|unchanged|igual|etc|mantenha|manter|keep|preserve|demais|outras?)|$)/im,
  // F19 (dogfooding) — `[...]` ANCORADO à linha-própria (só espaços/tabs em volta). O
  // `[...]` de truncamento vem numa linha sozinha; o bare /\[\s*\.\.\.\s*\]/ casava
  // ELISÃO LEGÍTIMA inline (numpy `arr[...]`, py `x[...]`, "[...]" de citação) ⇒ recusa
  // falsa. Ancorar mata o FP sem perder o catch da truncação em linha própria.
  /^[ \t]*\[[ \t]*\.\.\.[ \t]*\][ \t]*$/m,
];
function looksTruncated(content: string): boolean {
  return TRUNCATION_MARKERS.some((re) => re.test(content));
}

// F18 (dogfooding) — o padrão PARECE regex (alternação, âncora, classe, quantificador)?
// O grep é SUBSTRING LITERAL; se parece regex e deu 0 acertos, avisamos (anti-silêncio).
function looksLikeRegex(pattern: string): boolean {
  return /[|^$]|\\[dwsbDWSB]|\.\*|\.\+|\.\?/.test(pattern);
}

/**
 * write_file — CRIA um arquivo novo (ou reescreve um existente DE PROPÓSITO com
 * `overwrite:true`). Efeito `write` ⇒ PASSA pelo gate (o loop garante). É o
 * sobrescreve-tudo LEGÍTIMO, separado do `edit_file` cirúrgico.
 *
 * GUARD ANTI-DATA-LOSS (EST-0944, INTEGRIDADE — vale ATÉ em --yolo): se o arquivo JÁ
 * EXISTE e NÃO veio `overwrite:true`, write_file RECUSA SEMPRE — não só nos sub-casos
 * de truncamento. O caso REAL (dogfood): o modelo, mandado "criar CHANGELOG.md" (que
 * existia, 100 linhas curadas), escrevia 50 linhas NOVAS não-truncadas; os checks de
 * shrink/bytes/marcador NÃO disparavam (50 não é <50% de 100; bytes comparáveis) ⇒ o
 * write PROSSEGUIA e o conteúdo curado SUMIA. A doc do tool sempre disse que reescrever
 * um existente exige o gesto EXPLÍCITO `overwrite:true`; agora a impl ENFORÇA isso.
 *
 * Para EDITAR use `edit_file` (old/new — preserva o resto POR CONSTRUÇÃO); p/ REESCREVER
 * por completo de propósito, `overwrite:true`. Os checks de truncamento (shrink por
 * linhas/bytes, marcador, leitura parcial) viram a justificativa MAIS específica quando
 * aplicáveis. É integridade de dados, NÃO permissão — não é relaxado pelo gate; só o
 * `overwrite:true` (o "eu quero mesmo") pula o guard e reescreve.
 */
export const writeFileTool: NativeTool<ToolPorts> = {
  name: 'write_file',
  effect: 'write',
  group: 'arquivo',
  description:
    'Cria um arquivo NOVO com o conteúdo completo (ou, com overwrite:true, reescreve um ' +
    'existente DE PROPÓSITO). Para EDITAR um arquivo existente, use edit_file (old_string/' +
    'new_string) — não re-emita o arquivo inteiro. Input: { "path": string, "content": string, ' +
    '"overwrite"?: boolean }.',
  parameters: WRITE_FILE_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    const path = reqString(input, 'path');
    const content = optString(input, 'content');
    const overwrite = optBool(input, 'overwrite');
    if (!path) return err('write_file requer "path" (string não-vazia).');
    if (content === undefined) return err('write_file requer "content" (string).');
    try {
      const existed = await ports.fs.exists(path);
      const read = existed ? await readForEdit(ports.fs, path) : { content: '', complete: true };
      const before = read.content;

      // GUARD ANTI-DATA-LOSS — arquivo EXISTENTE sem override explícito ⇒ RECUSA SEMPRE
      // (não só nos sub-casos de truncamento). A doc do tool sempre exigiu o gesto
      // EXPLÍCITO `overwrite:true` p/ reescrever um existente; aqui a impl ENFORÇA isso.
      // O bug REAL (dogfood): "criar CHANGELOG.md" sobre um existente de 100 linhas
      // curadas com 50 linhas NOVAS não-truncadas passava SILENCIOSO (50 não é <50% de
      // 100; bytes comparáveis) ⇒ conteúdo curado SUMIA. Os checks de truncamento abaixo
      // só refinam a MENSAGEM (justificativa mais específica) — a recusa é incondicional.
      if (existed && !overwrite) {
        // Anti-data-loss (EST-0944): se o arquivo atual NÃO pôde ser lido por inteiro
        // (grande demais/binário), o `before` é só um prefixo — diz isso explícito.
        if (!read.complete) return partialReadError('write_file', path);
        const beforeLines = before.split('\n').length;
        const afterLines = content.split('\n').length;
        const dramaticShrink = beforeLines >= 8 && afterLines < beforeLines * 0.5;
        // O encolhimento por LINHAS é CEGO a arquivos de POUCAS linhas mas MUITOS bytes
        // (minificado/bundle, JSON/SVG numa linha, lock files). Capturamos também o
        // encolhimento por BYTES: arquivo ≥ 1 KiB que cai a <50% do tamanho.
        const BYTE_SHRINK_FLOOR = 1024;
        const dramaticByteShrink =
          before.length >= BYTE_SHRINK_FLOOR && content.length < before.length * 0.5;
        const marker = looksTruncated(content);
        // Justificativa MAIS específica quando há sinal de truncamento; senão, a recusa
        // genérica de "já existe". Em todos os casos: NADA é escrito (preserva o curado).
        const why = marker
          ? 'o conteúdo novo contém marcadores de "resto igual/omitido" (truncamento)'
          : dramaticShrink
            ? `isto reduziria o arquivo de ${beforeLines} p/ ${afterLines} linhas (>50% menor)`
            : dramaticByteShrink
              ? `isto reduziria o arquivo de ${before.length} p/ ${content.length} bytes (>50% menor)`
              : 'o arquivo JÁ EXISTE (sobrescrever apagaria o conteúdo atual)';
        return err(
          `write_file RECUSOU sobrescrever "${path}": ${why}. Para EDITAR, use edit_file ` +
            `(old_string→new_string) — preserva o resto. Se a reescrita TOTAL for intencional, ` +
            `passe overwrite:true. Nada foi escrito.`,
        );
      }

      const diff = unifiedDiff(path, before, content, existed);
      if (ports.journal) {
        await ports.journal.captureEdit({ path, before, after: content, createdByEdit: !existed });
      }
      await ports.fs.writeFile(path, content);
      return {
        ok: true,
        observation: `arquivo ${existed ? 'reescrito' : 'criado'}: ${path}`,
        display: diff,
      };
    } catch (e) {
      return err(`falha ao escrever "${path}": ${errMsg(e)}`);
    }
  },
};

/**
 * run_command (bash) — executa um comando de shell. Efeito `exec` ⇒ a tool de
 * MAIOR risco. PASSA pelo gate (o loop garante; default deny até EST-0945, e
 * `bash=ask` na política concreta — CLI-SEC-3). `display` é o comando EXATO
 * (CLI-SEC-9). Input: { "command": string }.
 *
 * EST-0982 — ABORTÁVEL + STREAMING. O `ctx` (opcional) traz:
 *  - `signal` — o MESMO abort do loop/root-flow (EST-0944/0969). Repassado a
 *    `ShellPort.exec`, que MATA o processo (grupo) ao abortar — não espera o timeout.
 *  - `onShellChunk` — a saída ao vivo (stdout/stderr). A porta entrega o chunk BRUTO;
 *    AQUI (ponto único PORTÁVEL) ele passa por `redactOutputSecrets` (CLI-SEC-6) ANTES
 *    de ir ao render/observação — o stream NUNCA mostra segredo em claro. O mesmo vale
 *    p/ o corpo agregado final (redigido de novo; idempotente).
 *
 * Backward-compatible: sem `ctx`, roda igual (sem cancelamento dirigido nem stream).
 */
// ADR-0145 (frente b) — fonte única do "quando" de `run_command` (description + menu).
const WHEN_RUN_COMMAND =
  'para RODAR/instalar/validar algo no shell (build, install, script, git) — depois de ' +
  'edit_file/write_file, RODE aqui (ou run_tests) p/ confirmar o efeito; não pare no arquivo editado';

export const runCommandTool: NativeTool<ToolPorts> = {
  name: 'run_command',
  effect: 'exec',
  group: 'execucao',
  when: WHEN_RUN_COMMAND,
  description: `Executa um comando de shell. Use QUANDO: ${WHEN_RUN_COMMAND}. Input: { "command": string }.`,
  parameters: RUN_COMMAND_SCHEMA,
  async run(input, ports, ctx): Promise<ToolResult> {
    const command = reqString(input, 'command');
    if (!command) return err('run_command requer "command" (string não-vazia).');
    try {
      // EST-0960a · CA-3 — marca a BARREIRA não-reversível ANTES de executar:
      // o efeito de shell é arbitrário; o journal NÃO captura snapshot e NÃO
      // finge desfazer — só registra a posição p/ a 0960b avisar. Best-effort,
      // nunca bloqueia o efeito. Sem journal injetado, no-op.
      if (ports.journal) {
        await ports.journal.markBarrier(command);
      }
      // EST-0982 — STREAMING: cada chunk da porta é REDIGIDO (CLI-SEC-6) AQUI, no
      // core portável (ponto único), e só então repassado ao render ao vivo. A porta
      // entrega bruto; a redação não depende de a porta ser confiável.
      const onChunk = ctx?.onShellChunk
        ? (chunk: ShellChunk): void => {
            ctx.onShellChunk?.({ stream: chunk.stream, text: redactOutputSecrets(chunk.text) });
          }
        : undefined;
      const r = await ports.shell.exec(command, {
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
        ...(onChunk ? { onChunk } : {}),
      });
      // CLI-SEC-6 — redige o corpo agregado ANTES de virar observação (DADO ao
      // modelo) E antes de exibir. Idempotente com a redação por-chunk do stream.
      const stdout = redactOutputSecrets(r.stdout);
      const stderr = redactOutputSecrets(r.stderr);
      const body = [
        `exit=${r.exitCode}`,
        // EST-0982 — abort cooperativo deixa explícito p/ o modelo (DADO): foi o
        // USUÁRIO que parou, não erro técnico — não re-tentar em laço (CLI-SEC-4).
        ...(r.aborted ? ['[comando interrompido pelo usuário (esc/Ctrl-C) — processo morto]'] : []),
        stdout ? `stdout:\n${stdout}` : 'stdout: (vazio)',
        stderr ? `stderr:\n${stderr}` : 'stderr: (vazio)',
      ].join('\n');
      return { ok: r.exitCode === 0, observation: clip(body), display: `$ ${command}` };
    } catch (e) {
      return err(`falha ao executar "${command}": ${errMsg(e)}`);
    }
  },
};

/**
 * change_dir (cd) — EST-0982 — move o DIRETÓRIO DE TRABALHO DE SESSÃO (`sessionCwd`).
 * Daí em diante, `run_command` roda NESTE dir e `read_file`/`edit_file`/`grep`/`@arquivo`
 * resolvem caminhos RELATIVOS contra ELE. Resolve o problema do `cd subdir && ...` que
 * NÃO persistia (cada exec era um shell novo) — agora o cwd é estado de SESSÃO.
 *
 * Efeito `read`: NÃO toca o filesystem (não cria/escreve/executa) — só move o ponteiro
 * de navegação. Mas é AUDITÁVEL (linha `⏺`) e CONFINADO: o alvo é SEMPRE clampado na
 * raiz canonicalizada do workspace (`cd ..`/`cd /etc` além da raiz ⇒ NEGADO/clampado —
 * o `sessionCwd` NUNCA escapa). Input: { "path": string } (relativo ao cwd ou absoluto).
 */
// ADR-0145 (frente b) — fonte única do "quando" de `change_dir` (description + menu).
const WHEN_CHANGE_DIR =
  'para ENTRAR numa subpasta do projeto ANTES de rodar comandos/ler-editar arquivos ' +
  'relativos nela — use no lugar de "cd x && ..." dentro de run_command (não persiste)';

export const changeDirTool: NativeTool<ToolPorts> = {
  name: 'change_dir',
  effect: 'read',
  group: 'arquivo',
  when: WHEN_CHANGE_DIR,
  description:
    'Muda o diretório de trabalho da SESSÃO (cd). A partir daí run_command roda nele e ' +
    'os caminhos relativos (read_file/edit_file/grep/@arquivo) resolvem nele. Sempre ' +
    'confinado às raízes AUTORIZADAS do workspace (não escapa; pode navegar entre elas). ' +
    `Use QUANDO: ${WHEN_CHANGE_DIR}. Input: { "path": string }.`,
  parameters: CHANGE_DIR_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    const path = reqString(input, 'path');
    if (!path) return err('change_dir requer "path" (string não-vazia).');
    if (!ports.cwd) {
      return err('navegação de diretório indisponível nesta sessão (sem porta de cwd).');
    }
    try {
      const next = ports.cwd.setCwd(path);
      // Mostra o cwd RELATIVO à raiz primária (legível) — a raiz vira "." (o topo do
      // projeto). EST-0982 · /add-dir: cwd numa raiz EXTRA ⇒ mostra o ABSOLUTO (deixa
      // explícito que saiu da árvore primária, auditável).
      const rel = relCwd(ports.cwd.root, next);
      return {
        ok: true,
        observation: `diretório de trabalho da sessão agora: ${rel} (confinado às raízes autorizadas do workspace).`,
        display: `cd ${rel}`,
      };
    } catch (e) {
      return err(`falha ao mudar de diretório para "${path}": ${errMsg(e)}`);
    }
  },
};

/**
 * Caminho do `cwd` RELATIVO à raiz primária, p/ exibição legível (raiz ⇒ ".").
 * Fora da raiz primária (cwd numa raiz EXTRA autorizada — EST-0982 /add-dir) ⇒
 * devolve o ABSOLUTO (explícito e auditável; não inventa relativo enganoso).
 */
function relCwd(root: string, cwd: string): string {
  if (cwd === root) return '.';
  // EST-1015 (fix borda) — `startsWith(root)` CRU casa um IRMÃO prefixo-STRING: com a raiz
  // `/p/proj`, um `/p/proj-lib/src` (raiz EXTRA do /add-dir) "casava" e virava o relativo
  // ENGANOSO `-lib/src` (o agente lê esse display). Exigimos a BORDA de SEPARADOR após a
  // raiz (`/p/proj/…`); cwd numa raiz extra/fora ⇒ devolve o ABSOLUTO (auditável, como o
  // doc da função já promete). Cobre `/` e `\` (POSIX/Windows).
  const isSub = cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
  if (!isSub) return cwd;
  const rel = cwd.slice(root.length).replace(/^[/\\]/, '');
  return rel === '' ? '.' : rel;
}

/** grep — busca um padrão. Efeito `read`. Input: { "pattern": string, "path"?: string }. */
// ADR-0145 (frente b) — fonte única do "quando" de `grep` (description + menu).
const WHEN_GREP =
  'para LOCALIZAR onde um termo/símbolo aparece no código ANTES de editar — encadeie: ' +
  'grep (localizar) → read_file (inspecionar) → edit_file (mudar)';

export const grepTool: NativeTool<ToolPorts> = {
  name: 'grep',
  effect: 'read',
  group: 'busca',
  when: WHEN_GREP,
  description:
    'Busca uma SUBSTRING LITERAL (NÃO regex) em arquivos — caracteres como ^ $ | \\ . * são ' +
    `TEXTO, não metacaracteres. Use QUANDO: ${WHEN_GREP}. Input: { "pattern": string, "path"?: ` +
    'string (default ".") }.',
  parameters: GREP_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    const pattern = reqString(input, 'pattern');
    if (!pattern) return err('grep requer "pattern" (string não-vazia).');
    const path = optString(input, 'path') ?? '.';
    try {
      const { matches, truncated } = await ports.search.search(pattern, path);
      // EST-1016 — nota HONESTA de scan parcial: SÓ quando algum ramo do truncamento
      // disparou (zero ruído quando a varredura foi completa). Anexada DEPOIS dos
      // acertos (ou da linha "nenhum acerto") p/ o usuário/agente nunca tratar um
      // resultado cortado como definitivo (bug F6).
      const note = truncationNote(truncated);
      if (matches.length === 0) {
        const base = `nenhum acerto para "${pattern}" em ${path}.`;
        // F18 (dogfooding) — a busca é SUBSTRING literal. Se o padrão PARECE regex, o
        // "0 acertos" pode ser falso (o modelo esperava regex). Torna o silencioso
        // HONESTO (igual ao F6): avisa p/ não tratar "nada encontrado" como definitivo.
        const regexHint = looksLikeRegex(pattern)
          ? '\nnota: a busca é SUBSTRING LITERAL (não regex) — "^", "|", "\\d", ".*" são texto. ' +
            'Para alternativas, faça uma busca por termo (ex.: "TODO" e depois "FIXME"), não "TODO|FIXME".'
          : '';
        return {
          ok: true,
          observation: note ? `${base}${regexHint}\n${note}` : `${base}${regexHint}`,
        };
      }
      const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
      const body = note ? `${clip(lines)}\n${note}` : clip(lines);
      return { ok: true, observation: body, display: `grep "${pattern}" ${path}` };
    } catch (e) {
      return err(`falha ao buscar "${pattern}": ${errMsg(e)}`);
    }
  },
};

/**
 * EST-1016 — monta a nota de scan PARCIAL a partir do sinal de truncamento. Lista SÓ
 * os ramos que dispararam; devolve `undefined` quando NADA truncou (zero ruído — a
 * observation segue idêntica à de antes). É honesta: deixa explícito que o resultado
 * pode estar INCOMPLETO, p/ o usuário/agente não afirmar uma contagem cortada como
 * definitiva (REPRO 1/2 do dogfood F6).
 */
function truncationNote(truncated: SearchTruncation): string | undefined {
  const reasons: string[] = [];
  const big = truncated.byScanBytes;
  if (big && big.length > 0) {
    reasons.push(`${big.length} arquivo(s) > 5 MiB lido(s) só até o teto de bytes`);
  }
  if (truncated.byMaxMatches) {
    reasons.push('atingiu o teto de 200 acertos — pode haver mais ocorrências');
  }
  if (truncated.byMaxFiles) {
    reasons.push('atingiu o teto de 5000 arquivos varridos — arquivos restantes não foram vistos');
  }
  if (reasons.length === 0) return undefined;
  return `⚠ scan parcial — resultados podem estar INCOMPLETOS: ${reasons.join(' · ')}.`;
}

/**
 * glob — acha ARQUIVOS por PADRÃO de caminho (ex.: todos os .ts em qualquer
 * profundidade, ou os test_*.py sob src). Efeito `read`
 * (lista NOMES, não conteúdo ⇒ classe de baixo privilégio, igual grep/read_file — sem
 * confirmação por default). O matcher é PURO (`compileGlob`, anti-ReDoS); a varredura
 * confinada/gitignore-aware/capada mora na PORTA (`SearchPort.glob`, locus concreto).
 *
 * Espelha o `grepTool`: 0 acertos ⇒ observação CLARA (não silêncio); truncamento ⇒
 * nota HONESTA (F6/F18); padrão inválido ⇒ erro VISÍVEL. Input: { pattern, path? }.
 */
// ADR-0145 (frente b) — fonte única do "quando" de `glob` (description + menu).
const WHEN_GLOB =
  'para ACHAR arquivos por NOME/padrão (não conteúdo) ANTES de editar — encadeie: glob ' +
  '(achar o arquivo) → read_file → edit_file; p/ buscar CONTEÚDO use grep, não glob';

export const globTool: NativeTool<ToolPorts> = {
  name: 'glob',
  effect: 'read',
  group: 'busca',
  when: WHEN_GLOB,
  description:
    'Acha ARQUIVOS por padrão de caminho (NÃO busca conteúdo — use grep p/ isso). Sintaxe: ' +
    '* (um segmento), ** (cruza /), ?, [abc], {a,b}. Ex.: "**/*.ts", "src/**/test_*.py". ' +
    `Use QUANDO: ${WHEN_GLOB}. Input: { "pattern": string, "path"?: string (default ".") }.`,
  parameters: GLOB_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    const pattern = reqString(input, 'pattern');
    if (!pattern) return err('glob requer "pattern" (string não-vazia).');
    const path = optString(input, 'path') ?? '.';
    // `glob` é OPCIONAL na porta (aditivo). Sem ela ⇒ erro CLARO, nunca quebra.
    if (!ports.search.glob) {
      return err('busca de arquivos (glob) indisponível nesta sessão (sem porta de glob).');
    }
    try {
      const { paths, truncated } = await ports.search.glob(pattern, path);
      const note = globTruncationNote(truncated);
      if (paths.length === 0) {
        // Degradação HONESTA (espelha grep): nada casou ⇒ diz EXPLÍCITO, não silêncio.
        const base = `nenhum arquivo casou "${pattern}" em ${path}.`;
        return { ok: true, observation: note ? `${base}\n${note}` : base };
      }
      const lines = paths.join('\n');
      const body = note ? `${clip(lines)}\n${note}` : clip(lines);
      return { ok: true, observation: body, display: `glob "${pattern}" ${path}` };
    } catch (e) {
      // Padrão sintaticamente inválido ⇒ erro CLARO (não trata como "0 acertos").
      if (e instanceof GlobSyntaxError) {
        return err(`glob: padrão inválido "${pattern}": ${e.message}`);
      }
      return err(`falha ao buscar arquivos "${pattern}": ${errMsg(e)}`);
    }
  },
};

/**
 * EST-0944 — nota de scan PARCIAL do `glob` (espelha `truncationNote` do grep). Lista
 * SÓ os ramos que dispararam; `undefined` quando nada truncou (zero ruído). HONESTA: o
 * agente/usuário nunca trata uma lista CORTADA como o conjunto COMPLETO de arquivos.
 */
function globTruncationNote(truncated: GlobTruncation): string | undefined {
  const reasons: string[] = [];
  if (truncated.byMaxResults) {
    reasons.push('atingiu o teto de resultados — pode haver mais arquivos que casam');
  }
  if (truncated.byMaxScanned) {
    reasons.push('atingiu o teto de arquivos varridos — arquivos restantes não foram testados');
  }
  if (reasons.length === 0) return undefined;
  return `⚠ scan parcial — a lista pode estar INCOMPLETA: ${reasons.join(' · ')}.`;
}

/** As tools nativas, prontas p/ registrar (EST-0982 +`change_dir`; EST-0944 +`write_file`/`glob`). */
// ── ADR-0112 · EST-RT-2 — tool `run_tests` ──────────────────────────────────

const RUN_TESTS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Comando que roda os testes (ex.: "npx vitest run").' },
    label: { type: 'string', description: 'Rótulo opcional (ex.: "unit", "e2e").' },
  },
  required: ['command'],
  additionalProperties: false,
});

/**
 * `run_tests` — executa testes com visualização AO VIVO (placar, barra, falhas).
 * Efeito `exec` (gateada IDÊNTICA ao `run_command`, CLI-SEC-9). Roda o comando
 * via `ShellPort` com STREAMING, parseia a saída com `TestRunAccumulator` (4
 * dialetos: vitest/jest/pytest/go-test) e emite progresso estruturado pelo canal
 * `onTestProgress`. A OBSERVAÇÃO ao modelo é o summary ENXUTO (CLI-SEC-6 redigido),
 * NÃO o stream inteiro. Formato desconhecido ⇒ degradação honesta (braille + stream).
 */
export const runTestsTool: NativeTool<ToolPorts> = {
  name: 'run_tests',
  effect: 'exec',
  group: 'execucao',
  description:
    'Roda testes (vitest/jest/pytest/go test) e mostra resultado ao vivo: ✓/✗ passou/falhou, ' +
    'placar, barra de progresso. Input: { "command": string (req), "label"?: string }. ' +
    'O comando é executado com streaming; o parser detecta o dialeto automaticamente. ' +
    'Formato desconhecido ⇒ stream cru + braille (degradação honesta).',
  parameters: RUN_TESTS_SCHEMA,
  async run(input, ports, ctx): Promise<ToolResult> {
    const command =
      typeof input.command === 'string' && input.command.length > 0 ? input.command : undefined;
    if (!command) return err('run_tests requer "command" (string não-vazia).');
    const label = typeof input.label === 'string' ? input.label : undefined;

    const { TestRunAccumulator, renderTestSummary } = await import('../testing/test-parse.js');

    const accumulator = new TestRunAccumulator();
    let stdout = '';

    try {
      const signal = ctx?.signal;
      const execOpts: Record<string, unknown> = {
        onChunk: (chunk: { stream: string; text: string }) => {
          // Redige o chunk ANTES de repassar (CLI-SEC-6).
          const redacted = redactOutputSecrets(chunk.text);
          ctx?.onShellChunk?.({ stream: chunk.stream as 'stdout' | 'stderr', text: redacted });
          // Acumula stdout p/ o corpo agregado final (redigido também).
          if (chunk.stream === 'stdout') stdout += chunk.text + '\n';
          // Alimenta o acumulador de testes com cada LINHA.
          for (const line of chunk.text.split('\n')) {
            const event = accumulator.feed(line);
            if (event && ctx?.onTestProgress) {
              ctx.onTestProgress(event, accumulator.snapshot());
            }
          }
        },
      };
      if (signal) execOpts.signal = signal;

      const result = await ports.shell.exec(
        command,
        execOpts as Parameters<typeof ports.shell.exec>[1],
      );
      const score = accumulator.snapshot();

      // Redige o corpo agregado (CLI-SEC-6).
      const redactedStdout = redactOutputSecrets(stdout);

      if (score.unknownFormat) {
        // Degradação honesta: formato desconhecido — stream cru como observação.
        return {
          ok: result.exitCode === 0,
          observation:
            `run_tests${label ? ` (${label})` : ''}: ${result.exitCode === 0 ? 'ok' : `exit=${result.exitCode}`} (formato não reconhecido).\n\n` +
            clip(redactedStdout),
          display: `$ ${command}`,
        };
      }

      const summary = renderTestSummary(score);
      const obs =
        `run_tests${label ? ` (${label})` : ''}: ${result.exitCode === 0 ? 'ok' : `exit=${result.exitCode}`}\n` +
        summary;

      return {
        ok: result.exitCode === 0,
        observation: obs,
        display: `$ ${command}`,
      };
    } catch (e) {
      return err(`run_tests falhou: ${errMsg(e)}`);
    }
  },
};

export const NATIVE_TOOLS: readonly NativeTool<ToolPorts>[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  runTestsTool,
  grepTool,
  globTool,
  changeDirTool,
  // EST-1015 (pedido do dono) — checklist/plano vivo (effect:'read', sem efeito externo).
  PLAN_TOOL,
  // EST-1110 · ADR-0114 — `perguntar`: o agente pergunta ao usuário (effect:'read',
  // sem efeito externo; porta `question` injetada pelo @hiperplano/aluy-cli; fail-safe não-pendura).
  QUESTION_TOOL,
  // EST-1108 — backlog/TODO persistente: add_todo, list_todos, done_todo
  // (porta de I/O PRÓPRIA confinada a `todos.json`, efeito `memory` p/ add/done).
  addTodoTool,
  listTodosTool,
  doneTodoTool,
  // ADR-0145 (frente d) — `capabilities` (+ sinônimo `list_tools`): menu vivo de
  // auto-descoberta (effect:'read' puro; inerte sem a porta `capabilities`).
  capabilitiesTool,
  listToolsTool,
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Conta ocorrências NÃO-sobrepostas de `needle` (texto literal) em `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    count += 1;
    from = i + needle.length; // não-sobreposto
  }
  return count;
}

/** Substitui TODAS as ocorrências de `needle` (texto LITERAL, sem regex) por `repl`. */
function replaceAllLiteral(haystack: string, needle: string, repl: string): string {
  return haystack.split(needle).join(repl);
}

/**
 * Substitui a PRIMEIRA ocorrência de `needle` por `repl`, ambos LITERAIS — sem
 * interpretar `$&`/`$1`/`$$` no replacement (o que `String.replace(str, str)` faria,
 * corrompendo um `$VAR`/`$1` legítimo do código novo). Corta por índice e concatena.
 */
function replaceFirstLiteral(haystack: string, needle: string, repl: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + repl + haystack.slice(i + needle.length);
}

// EST-0944 (hunt #277, classe "recurso sem teto") — TETOS do diff EXIBIDO. O
// `display` do edit_file/write_file materializa `before`/`after` (arquivo inteiro,
// até ~5 MiB) ⇒ um arquivo grande LEGÍTIMO gera um diff do tamanho do arquivo que
// estoura o render da TUI e infla a observação que vai ao modelo. Capamos o corpo
// do diff de forma HONESTA (trunca com nota, nunca corta silencioso) e CENTRADO na
// mudança (não no topo inalterado). Tetos defensáveis: um edit normal são poucas
// linhas; centenas/milhares de linhas de diff não ajudam usuário nem modelo.
const MAX_DIFF_LINES = 200;
const MAX_DIFF_BYTES = 16_000;
// Linhas de contexto inalterado em volta da janela de mudança (estilo `diff -U`).
const DIFF_CONTEXT_LINES = 3;

/** Aplica o teto de BYTES por último, sobre o corpo já capado por linhas. */
function clipDiffBytes(header: string[], body: string[]): string {
  let text = [...header, ...body].join('\n');
  if (text.length <= MAX_DIFF_BYTES) return text;
  // Corta no limite de linha ≤ teto e anexa nota honesta.
  const cut = text.lastIndexOf('\n', MAX_DIFF_BYTES);
  text = text.slice(0, cut > 0 ? cut : MAX_DIFF_BYTES);
  return `${text}\n… (diff truncado: excede ${MAX_DIFF_BYTES} bytes)`;
}

/**
 * Diff unificado mínimo (linha-a-linha) p/ a confirmação de efeito (CLI-SEC-9).
 * Não é um algoritmo de diff ótimo — é honesto e legível: marca removidas (`-`)
 * e adicionadas (`+`). Suficiente p/ o usuário ver o efeito EXATO antes de aprovar.
 *
 * TETO (EST-0944): o corpo é CAPADO por linhas/bytes. Quando estoura, mostramos a
 * VIZINHANÇA da mudança (não as primeiras N linhas cruas) — um edit no fim de um
 * arquivo grande não pode exibir só o topo inalterado — e anexamos uma nota honesta.
 * Edit pequeno (≤ teto) ⇒ diff COMPLETO, inalterado.
 */
export function unifiedDiff(path: string, before: string, after: string, existed: boolean): string {
  if (!existed) {
    const lines = after.split('\n');
    const header = [`--- /dev/null`, `+++ ${path}`];
    if (lines.length <= MAX_DIFF_LINES) {
      return clipDiffBytes(
        header,
        lines.map((l) => `+${l}`),
      );
    }
    // Arquivo novo grande: não há "mudança" a centrar (é tudo adição) ⇒ topo + nota.
    const shown = lines.slice(0, MAX_DIFF_LINES).map((l) => `+${l}`);
    shown.push(`… (diff truncado: ${MAX_DIFF_LINES} de ${lines.length} linhas)`);
    return clipDiffBytes(header, shown);
  }
  const a = before.split('\n');
  const b = after.split('\n');
  const header = [`--- ${path}`, `+++ ${path}`];
  const max = Math.max(a.length, b.length);

  // Linhas alinhadas por índice: localiza a JANELA de mudança (primeiro..último
  // índice com `a[i] !== b[i]`). Tudo fora dela é contexto inalterado a elidir.
  let firstChange = -1;
  let lastChange = -1;
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      if (firstChange === -1) firstChange = i;
      lastChange = i;
    }
  }

  const emit = (lo: number, hi: number): string[] => {
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const la = a[i];
      const lb = b[i];
      if (la === lb) {
        out.push(` ${la ?? ''}`);
      } else {
        if (la !== undefined) out.push(`-${la}`);
        if (lb !== undefined) out.push(`+${lb}`);
      }
    }
    return out;
  };

  // Sem mudança detectada (ex.: chamada degenerada) ⇒ corpo cru capado pelo topo.
  if (firstChange === -1) {
    const body = emit(0, max - 1);
    if (body.length <= MAX_DIFF_LINES) return clipDiffBytes(header, body);
    const shown = body.slice(0, MAX_DIFF_LINES);
    shown.push(`… (diff truncado: ${MAX_DIFF_LINES} de ${body.length} linhas)`);
    return clipDiffBytes(header, shown);
  }

  // Janela = mudança + contexto. Se ela cabe no teto, mostramos só a vizinhança
  // (elidindo o topo/rodapé inalterados com nota), CENTRADA na mudança.
  const winLo = Math.max(0, firstChange - DIFF_CONTEXT_LINES);
  const winHi = Math.min(max - 1, lastChange + DIFF_CONTEXT_LINES);
  const full = emit(0, max - 1);

  // Caso comum: diff inteiro cabe ⇒ COMPLETO, inalterado (sem nota).
  if (full.length <= MAX_DIFF_LINES) return clipDiffBytes(header, full);

  const window = emit(winLo, winHi);
  const body: string[] = [];
  if (winLo > 0)
    body.push(`… (${winLo} linha${winLo > 1 ? 's' : ''} inalterada${winLo > 1 ? 's' : ''} acima)`);
  // A própria janela ainda pode ser maior que o teto (mudança gigante) ⇒ capa-a.
  if (window.length > MAX_DIFF_LINES) {
    body.push(...window.slice(0, MAX_DIFF_LINES));
    body.push(`… (diff truncado: ${MAX_DIFF_LINES} de ${full.length} linhas alteradas/contexto)`);
  } else {
    body.push(...window);
    const belowStart = winHi + 1;
    if (belowStart < max) {
      const below = max - belowStart;
      body.push(
        `… (${below} linha${below > 1 ? 's' : ''} inalterada${below > 1 ? 's' : ''} abaixo)`,
      );
    }
  }
  return clipDiffBytes(header, body);
}
