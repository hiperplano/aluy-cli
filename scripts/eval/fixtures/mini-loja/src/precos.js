// Cálculo de preços e descontos.
export function aplicarDesconto(valor, percentual) {
  // BUG: desconto de 10% deveria resultar em 90% do valor.
  return valor - valor * percentual;
}

export function formatarMoeda(valor) {
  return 'R$ ' + valor.toFixed(2).replace('.', ',');
}
