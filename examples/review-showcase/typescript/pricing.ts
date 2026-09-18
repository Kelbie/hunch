interface Order { id: string; subtotal: number; discount: number; total: number }

// Applies a percentage discount and computes the total the customer pays.
export function applyDiscount(order: Order, percent: number): void {
  order.discount = order.subtotal * (percent / 100);
  order.total = order.subtotal - order.discount;
}

export function checkoutTotal(order: Order, percent: number): number {
  applyDiscount(order, percent);
  return order.total;
}
