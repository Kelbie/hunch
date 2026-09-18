interface Order { id: string; total: number }
interface CheckoutBackend {
  reserve(order: Order): Promise<string>;
  charge(reservation: string, amount: number): Promise<string>;
  finalize(reservation: string, charge: string): Promise<string>;
}

export class Checkout {
  constructor(private backend: CheckoutBackend) {}

  async submit(order: Order): Promise<string> {
    const reservation = await this.backend.reserve(order);
    const charge = await this.backend.charge(reservation, order.total);
    return this.backend.finalize(reservation, charge);
  }
}

export function onBuy(checkout: Checkout, order: Order) {
  return checkout.submit(order);
}
