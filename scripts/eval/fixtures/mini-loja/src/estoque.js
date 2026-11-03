// Controle simples de estoque em memória.
const itens = new Map();

export function adicionar(sku, quantidade) {
  itens.set(sku, (itens.get(sku) ?? 0) + quantidade);
}

export function disponivel(sku) {
  return itens.get(sku) ?? 0;
}

export function baixar(sku, quantidade) {
  const atual = disponivel(sku);
  if (quantidade > atual) throw new Error('estoque insuficiente: ' + sku);
  itens.set(sku, atual - quantidade);
}

export function limpar() {
  itens.clear();
}
