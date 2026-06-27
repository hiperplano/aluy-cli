// EST-0996 — CAPACIDADE de tool-calling NATIVO de um caller de modelo.
//
// Encapsula a decisão "mandar `tools` ou não" + o DEGRADE GRACIOSO no
// `422 TOOLS_UNSUPPORTED`. Compartilhado pelos DOIS callers (core `BrokerModelCaller`
// e TUI `StreamingModelCaller`) p/ não duplicar a negociação de capacidade. PORTÁVEL:
// só dado + lógica pura, sem rede/Ink.
//
// SEGURANÇA: esta classe NÃO toca a catraca. Ela só decide o FORMATO do request
// (texto vs nativo). A execução de QUALQUER tool extraída — nativa ou de texto —
// passa pela MESMA `decide()` no loop (CLI-SEC-H1). O `tools` enviado é o CATÁLOGO
// LOCAL de ferramentas (HG-2: não é credencial — ok mandar).

import { BrokerError } from '../model/errors.js';
import type { ToolFunctionSchema } from '../model/types.js';

export interface NativeToolsCapabilityOptions {
  /** Catálogo de funções (já convertido de `NativeTool[]`). Vazio ⇒ nunca manda tools. */
  readonly tools?: readonly ToolFunctionSchema[];
  /**
   * Sinal A PRIORI de suporte (de `/v1/models/custom.supports_tools`). `false` ⇒ NEM
   * TENTA o nativo (vai direto p/ texto, sem custo de um 422). `undefined`/`true` ⇒
   * tenta (o 422 em runtime é a rede de segurança quando o sinal a priori falta).
   */
  readonly supportsTools?: boolean;
  /**
   * Permitir MÚLTIPLAS tool-calls por turno no provider. O CLI SEMPRE serializa a
   * execução (cada uma pela catraca, em ordem — seguro p/ v1); este flag só diz ao
   * provider se pode PROPOR várias de uma vez. Default `false` (uma por turno).
   */
  readonly parallelToolCalls?: boolean;
}

/** Os campos de tool-calling a espalhar no request quando o nativo está ativo. */
export interface NativeToolsRequestFields {
  readonly tools: readonly ToolFunctionSchema[];
  readonly tool_choice: 'auto';
  readonly parallel_tool_calls: boolean;
}

export class NativeToolsCapability {
  private readonly tools: readonly ToolFunctionSchema[];
  private readonly aPrioriSupported: boolean;
  private readonly parallel: boolean;
  // Runtime: vira `true` após um `422 TOOLS_UNSUPPORTED` — daí a sessão não re-manda
  // tools (não re-bate no mesmo 422 a cada turno). Estado de sessão, não persiste.
  private disabled = false;

  constructor(opts: NativeToolsCapabilityOptions = {}) {
    this.tools = opts.tools ?? [];
    this.aPrioriSupported = opts.supportsTools !== false;
    this.parallel = opts.parallelToolCalls ?? false;
  }

  /** Há catálogo, suportado a priori e NÃO desligado em runtime? ⇒ manda `tools`. */
  shouldSendTools(): boolean {
    return this.tools.length > 0 && this.aPrioriSupported && !this.disabled;
  }

  /** O nativo foi DESLIGADO em runtime (após um 422)? (p/ status/teste). */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Os campos a espalhar no request quando `shouldSendTools()`. */
  requestFields(): NativeToolsRequestFields {
    return { tools: this.tools, tool_choice: 'auto', parallel_tool_calls: this.parallel };
  }

  /**
   * O erro é `422 TOOLS_UNSUPPORTED`? Se SIM, DESLIGA o nativo na sessão (não re-bate)
   * e devolve `true` — o caller deve REPETIR a MESMA chamada lógica SEM tools (1 retry,
   * degrade gracioso p/ o protocolo de texto, #99). Qualquer outro erro ⇒ `false` (sobe).
   */
  degradeOnUnsupported(err: unknown): boolean {
    if (err instanceof BrokerError && err.isToolsUnsupported) {
      this.disabled = true;
      return true;
    }
    return false;
  }
}
