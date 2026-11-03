import { aplicarDesconto } from './precos.js';

export class Carrinho {
  constructor() {
    this.linhas = [];
  }

  adicionar(sku, preco, quantidade = 1) {
    this.linhas.push({ sku, preco, quantidade });
  }

  subtotal() {
    return this.linhas.reduce((soma, l) => soma + l.preco * l.quantidade, 0);
  }

  total(percentualDesconto = 0) {
    return aplicarDesconto(this.subtotal(), percentualDesconto);
  }
}
