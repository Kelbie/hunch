interface Order { id: string; total: number }
interface CheckoutBackend {
  reserve(order: Order): Promise<string>;
  charge(reservation: string, amount: number): Promise<string>;
  finalize(reservation: string, charge: string): Promise<string>;
}

export class Checkout {
  constructor(private backend: CheckoutBackend) {}

  reserve(order: Order): Promise<string> {
    return this.backend.reserve(order);
  }

  charge(reservation: string, amount: number): Promise<string> {
    return this.backend.charge(reservation, amount);
  }

  finalize(reservation: string, charge: string): Promise<string> {
    return this.backend.finalize(reservation, charge);
  }
}

export async function onBuy(checkout: Checkout, order: Order) {
  const reservation = await checkout.reserve(order);
  const charge = await checkout.charge(reservation, order.total);
  return checkout.finalize(reservation, charge);
}
