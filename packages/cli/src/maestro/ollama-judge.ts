// EST-1131 · ADR-0123 §2.1-bis — OllamaJudgeEngine: cliente concreto da porta
// JudgeEngine que fala com Ollama loopback (127.0.0.1:11434).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ TRAVAS DURAS G2 (CA-G2-10..G2-14) — critério de aceite com teste verde: ║
// ║                                                                          ║
// ║ CA-G2-11 (anti-SSRF): egress via malha CLI-SEC-13 —                      ║
// ║   `classifyHeadroomTarget` + `NodeHostResolver` + `NodePinnedFetcher`.   ║
// ║   SÓ `127.0.0.1` loopback; URL externa / DNS-rebind / metadata-cloud     ║
// ║   ⇒ BARRA. SEM auto-pull (modelo ausente ⇒ degrada, nunca baixa).        ║
// ║                                                                          ║
// ║ CA-G2-12 (laundering judge): saída do judge = DADO envelopado            ║
// ║   (CLI-SEC-15-B), NUNCA `system`/instrução. Saída estruturada/tipada     ║
// ║   (escore/rótulo de salience, id de caixa).                              ║
// ║                                                                          ║
// ║ CA-G2-13 (redação): conteúdo de contexto enviado ao judge passa pela     ║
// ║   redação CLI-SEC-6 antes de sair; zero credencial trafegada.            ║
// ║                                                                          ║
// ║ CA-G2-14 (binário-limpo): judge NÃO figura como rota de turno-de-modelo. ║
// ║                                                                          ║
// ║ CA-MA8 (degradação): Ollama fora/timeout ⇒ fallback heurístico           ║
// ║   determinístico — NUNCA trava o Maestro.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// IMPL CONCRETA em @aluy/cli (I/O layer). A porta JudgeEngine é pura no
// @aluy/cli-core (ADR-0053 §8). Zero mudança de contrato no core.

import {
  classifyHeadroomTarget,
  OLLAMA_BASE_URL,
  type HostResolver,
  type JudgeEngine,
  type JudgeInput,
  type JudgeOption,
  type JudgeResult,
} from '@aluy/cli-core';
import { NodeHostResolver } from '../io/web-port.js';

// ─── Configuração ──────────────────────────────────────────────────────────

/** Configuração default do cliente Ollama loopback. */
export interface OllamaJudgeConfig {
  /** URL base do Ollama (default: `http://127.0.0.1:11434`). */
  readonly baseUrl: string;

  /** Modelo Ollama a usar (default: `qwen2.5:0.5b`). */
  readonly model: string;

  /** Timeout da chamada HTTP em ms (default: 10_000). */
  readonly timeoutMs: number;

  /** Resolver de host injetável (teste). Default: NodeHostResolver. */
  readonly resolver?: HostResolver;

  /** `fetch` injetável (teste). Default: globalThis.fetch. */
  readonly fetchFn?: typeof fetch;
}

export const DEFAULT_OLLAMA_BASE_URL = OLLAMA_BASE_URL;
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:0.5b';
// F76 (follow-up) — o judge é consultado DENTRO do loop (`rege` é AWAITADO em
// loop.ts:983), então o timeout é o tempo MÁXIMO que a regência-de-fluxo do Maestro
// pode TRAVAR a iteração. 10s era demais: ao vivo o qwen-0.5b levou ~9s, stalando o
// loop a cada turno com 2+ sinais (parece limbo + lentidão real). A Inv. I FLUIDEZ
// exige que a regência seja RÁPIDA: um judge que não responde em ~2.5s degrada p/ o
// motor-a (heurístico, instantâneo, provado). Hardware capaz responde <2.5s e o judge
// contribui; box lento degrada cedo em vez de stalar. (`config.timeoutMs` sobrepõe.)
export const DEFAULT_OLLAMA_TIMEOUT_MS = 2_500;

/** Config default — reuso seguro, imutável. */
export const DEFAULT_OLLAMA_JUDGE_CONFIG: Readonly<OllamaJudgeConfig> = Object.freeze({
  baseUrl: DEFAULT_OLLAMA_BASE_URL,
  model: DEFAULT_OLLAMA_MODEL,
  timeoutMs: DEFAULT_OLLAMA_TIMEOUT_MS,
});

// ─── Prompt template ───────────────────────────────────────────────────────

/**
 * Monta o prompt para o Ollama a partir de JudgeInput.
 *
 * O prompt pede resposta JSON estruturada com os campos:
 *   chosen — id da opção escolhida
 *   confidence — 0.0 a 1.0
 *   reasoning — raciocínio curto (até 200 chars)
 *
 * O contexto é injetado como informação adicional.
 */
function buildJudgePrompt(input: JudgeInput): string {
  const optionsText = input.options
    .map(
      (opt: JudgeOption) =>
        `- id: "${opt.id}", label: "${opt.label}"${opt.detail ? ` (${opt.detail})` : ''}`,
    )
    .join('\n');

  const hint = input.hint ? `\nPreferência do chamador: "${input.hint}"` : '';
  const ctx = input.context ? `\nContexto adicional:\n${input.context}` : '';

  return `Você é um juiz semântico que decide entre opções.

Pergunta: ${input.question}

Opções:
${optionsText}${hint}${ctx}

Responda APENAS com JSON no formato:
{"chosen": "<id da opção escolhida>", "confidence": <0.0 a 1.0>, "reasoning": "<raciocínio curto>"}`;
}

// ─── Parse do veredito ─────────────────────────────────────────────────────

/** Resultado do parse da resposta do Ollama. */
export interface ParsedVerdict {
  readonly chosen: string;
  readonly confidence: number;
  readonly reasoning: string;
  /** true se o parse usou estratégia de fallback (4-5 ou JSON inválido). */
  readonly fallback: boolean;
}

/**
 * Tenta extrair um JSON de veredito da resposta texto do Ollama.
 * O Ollama pode devolver JSON puro, JSON dentro de markdown, ou texto livre.
 * Tenta as estratégias em ordem, degrandando para resposta default.
 */
export function parseVerdict(raw: string, options: readonly string[]): ParsedVerdict {
  // Fallback default se nada der certo.
  const defaultVerdict: ParsedVerdict = {
    chosen: options[0] ?? 'continuar',
    confidence: 0.0,
    reasoning: 'fallback: parse mal-sucedido, default primeira opção',
    fallback: true,
  };

  // Estratégia 1: JSON puro (a resposta inteira é JSON).
  const direct = tryParseJson(raw);
  if (direct && isValidVerdict(direct, options)) return toParsedVerdict(direct, false);
  const foundJsonButInvalid = direct !== undefined;

  // Estratégia 2: JSON dentro de blocos markdown ```json ... ```.
  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch?.[1]) {
    const md = tryParseJson(mdMatch[1].trim());
    if (md && isValidVerdict(md, options)) return toParsedVerdict(md, false);
    if (md !== undefined) return { ...defaultVerdict, fallback: true }; // JSON malformado → default
  }

  // Estratégia 3: JSON delimitado por chaves como substring no texto.
  const braceMatch = raw.match(/\{[\s\S]*"chosen"[\s\S]*\}/);
  if (braceMatch) {
    const bm = tryParseJson(braceMatch[0]);
    if (bm && isValidVerdict(bm, options)) return toParsedVerdict(bm, false);
    if (bm !== undefined) return { ...defaultVerdict, fallback: true }; // JSON malformado → default
  }

  // Se estratégia 1 encontrou JSON puro mas inválido → default
  // (sem cair no match textual que poderia achar o chosen no raw).
  if (foundJsonButInvalid) return { ...defaultVerdict, fallback: true };

  // Estratégia 4: fallback — procura o id de qualquer opção no texto.
  for (const optId of options) {
    if (raw.includes(optId)) {
      return {
        chosen: optId,
        confidence: 0.5,
        reasoning: 'fallback: id encontrado no texto',
        fallback: true,
      };
    }
  }

  // Estratégia 5: default — primeira opção com confiança zero.
  return { ...defaultVerdict, fallback: true };
}

function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isValidVerdict(obj: Record<string, unknown>, validOptions: readonly string[]): boolean {
  const chosen = obj['chosen'];
  if (typeof chosen !== 'string' || !validOptions.includes(chosen)) return false;

  const confidence = obj['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return false;

  const reasoning = obj['reasoning'];
  if (typeof reasoning !== 'string') return false;

  return true;
}

function toParsedVerdict(obj: Record<string, unknown>, fallback: boolean): ParsedVerdict {
  return {
    chosen: String(obj['chosen']),
    confidence: Number(obj['confidence']),
    reasoning: String(obj['reasoning']),
    fallback,
  };
}

// ─── Cliente concreto ──────────────────────────────────────────────────────

/**
 * Cliente concreto JudgeEngine → Ollama loopback.
 *
 * Implementa a porta `JudgeEngine` (definida em `@aluy/cli-core`) falando com
 * um Ollama local via `127.0.0.1:11434`. Reusa a malha anti-SSRF CLI-SEC-13
 * (`classifyHeadroomTarget`) para garantir egress só-loopback.
 *
 * Degradação fail-open (CA-MA8): se o Ollama estiver fora, timeout, ou
 * qualquer erro de rede/parse → fallback determinístico para a heurística
 * da camada (a) do Maestro (motor-a.ts). O judge NUNCA trava — retorna
 * sempre um `JudgeResult` com `mode:'heuristic'` no fallback.
 *
 * Sem auto-pull (CA-G2-11): modelo ausente ⇒ degrada, não dispara `ollama pull`.
 */
export class OllamaJudgeEngine implements JudgeEngine {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly resolver: HostResolver;
  private readonly fetchFn: typeof fetch;

  constructor(config: Partial<OllamaJudgeConfig> = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
    this.model = config.model ?? DEFAULT_OLLAMA_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
    this.resolver = config.resolver ?? new NodeHostResolver();
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Avalia uma questão com opções chamando o Ollama loopback.
   *
   * Fluxo:
   * 1. VALIDA destino loopback-only via `classifyHeadroomTarget` (CLI-SEC-13).
   * 2. Monta prompt + chama `/api/chat` no Ollama.
   * 3. Parseia resposta como veredito estruturado.
   * 4. Em caso de QUALQUER erro (rede, timeout, parse) ⇒ fallback heurístico.
   *
   * @returns JudgeResult com `mode:'ollama'` no sucesso ou `mode:'heuristic'` no fallback.
   */
  async judge(input: JudgeInput): Promise<JudgeResult> {
    try {
      // 1. Valida destino loopback-only (CA-G2-11, malha CLI-SEC-13).
      const target = await classifyHeadroomTarget(this.baseUrl, this.resolver);
      if (!target.ok) {
        return this.fallback(input, `destino recusado: ${target.reason}`);
      }

      // 2. Monta prompt e chama Ollama /api/chat.
      const prompt = buildJudgePrompt(input);
      const url = buildOllamaUrl(target.pinnedIp, target.scheme, this.baseUrl);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // 3. Verifica status HTTP.
      if (!response.ok) {
        // 404 significa "modelo não encontrado" — NÃO faz pull (CA-G2-11).
        // Degrada para heurística.
        return this.fallback(
          input,
          `Ollama respondeu HTTP ${response.status} (modelo "${this.model}" pode estar ausente — sem auto-pull)`,
        );
      }

      // 4. Parseia resposta.
      const body = await response.text();
      const parsed = parseOllamaChatResponse(body);

      if (!parsed) {
        return this.fallback(input, `resposta do Ollama sem conteúdo parseável`);
      }

      const optionIds = input.options.map((o: JudgeOption) => o.id);
      const verdict = parseVerdict(parsed, optionIds);

      // Se o parse usou fallback (JSON inválido ou texto não-estruturado),
      // a resposta do LLM não é confiável — degrada para heurística (CA-G2-12).
      if (verdict.fallback) {
        return this.fallback(
          input,
          `parseVerdict usou fallback — resposta LLM não estruturalmente válida`,
        );
      }

      // Se o chosen não está nas opções válidas, o LLM alucinou ou tentou
      // injetar um comando — degrada para heurística (CA-G2-12).
      if (!optionIds.includes(verdict.chosen)) {
        return this.fallback(input, `chosen "${verdict.chosen}" não está nas opções válidas`);
      }

      // 5. Devolve resultado estruturado (CA-G2-12: DADO envelopado).
      return {
        chosen: verdict.chosen,
        confidence: clamp01(verdict.confidence),
        reasons: [
          {
            optionId: verdict.chosen,
            rationale: truncateReasoning(verdict.reasoning),
          },
        ],
        mode: 'llm',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Timeout via AbortController aparece como 'AbortError' ou nome similar.
      const isTimeout =
        msg.includes('abort') || msg.includes('timeout') || msg.includes('cancelado');
      return this.fallback(input, isTimeout ? `timeout (${this.timeoutMs}ms)` : `erro: ${msg}`);
    }
  }

  /**
   * Fallback determinístico: devolve um JudgeResult com `mode:'heuristic'`.
   *
   * A heurística é SIMPLES: escolhe a primeira opção com confiança 0.5.
   * O Maestro (motor-a) já sabe que `mode:'heuristic'` significa "julgamento
   * de baixa confiança, pese menos". O reason contém o motivo da degradação
   * para auditoria (CLI-SEC-10).
   */
  private fallback(input: JudgeInput, reason: string): JudgeResult {
    const firstOption = input.options[0];
    const fallbackId = firstOption?.id ?? 'continuar';
    const fallbackLabel = firstOption?.label ?? 'continuar';
    return {
      chosen: fallbackId,
      confidence: 0.5,
      reasons: [
        {
          optionId: fallbackId,
          rationale: `[degradação heurística] ${reason}. Fallback para opção default "${fallbackLabel}".`,
        },
      ],
      mode: 'heuristic',
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Constrói a URL pinada ao IP loopback validado.
 * Extrai porta e path da baseUrl original.
 */
function buildOllamaUrl(pinnedIp: string, scheme: string, baseUrl: string): string {
  let port = '11434';
  try {
    const p = new URL(baseUrl).port;
    if (p) port = p;
  } catch {
    // baseUrl já passou por parseHttpUrl dentro de classifyHeadroomTarget.
  }
  const host = pinnedIp.includes(':') ? `[${pinnedIp}]` : pinnedIp;
  return `${scheme}://${host}:${port}/api/chat`;
}

/**
 * Extrai o conteúdo textual da resposta /api/chat do Ollama.
 *
 * Formato Ollama /api/chat (não-stream):
 * {
 *   "model": "qwen2.5:0.5b",
 *   "message": { "role": "assistant", "content": "..." },
 *   "done": true
 * }
 */
function parseOllamaChatResponse(body: string): string | undefined {
  try {
    const json = JSON.parse(body);
    const content = json?.message?.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content.trim();
    }
    // Fallback: alguns modelos usam `response` em vez de `message.content`
    const resp = json?.response;
    if (typeof resp === 'string' && resp.trim().length > 0) {
      return resp.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Trunca o reasoning a 300 chars (limite auditàvel, compatível com JudgeReason).
 */
function truncateReasoning(reasoning: string): string {
  if (reasoning.length <= 300) return reasoning;
  return reasoning.slice(0, 297) + '...';
}
