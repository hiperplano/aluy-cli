// Conectores (ADR-0135 TC-6 / CLI-SEC-8) — TETO ANTI-SPAM de egresso. Impede o agente (ou
// um loop) de FLOODAR o canal: no máximo N envios por janela deslizante. PURO — o tempo
// entra por parâmetro (`nowMs`), então é 100% testável sem relógio real.
//
// É o freio genérico do `<connector>_send`: a malha consulta antes de cada envio. Estourou
// ⇒ o envio é NEGADO (a tool devolve erro, não enfileira), evitando spam e custo descontrolado.

export class EgressRateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    /** Máximo de envios permitidos dentro da janela. */
    private readonly maxPerWindow: number,
    /** Tamanho da janela deslizante, em ms. */
    private readonly windowMs: number,
  ) {}

  /**
   * Tenta consumir 1 envio em `nowMs`. Retorna `true` (pode enviar, e registra) ou `false`
   * (estourou o teto na janela — NEGADO). Expira os timestamps fora da janela primeiro.
   */
  tryConsume(nowMs: number): boolean {
    const cutoff = nowMs - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
    if (this.stamps.length >= this.maxPerWindow) return false;
    this.stamps.push(nowMs);
    return true;
  }

  /** Quantos envios estão contados na janela corrente (após a última limpeza). */
  get used(): number {
    return this.stamps.length;
  }
}
