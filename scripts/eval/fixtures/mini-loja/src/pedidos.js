import { baixar } from './estoque.js';

const pedidos = [];

export function criarPedido(carrinho, cliente) {
  for (const l of carrinho.linhas) baixar(l.sku, l.quantidade);
  const pedido = {
    id: pedidos.length + 1,
    cliente,
    linhas: carrinho.linhas,
    total: carrinho.total(),
  };
  pedidos.push(pedido);
  return pedido;
}

export function listarPedidos() {
  return pedidos;
}
