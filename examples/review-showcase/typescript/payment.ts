interface Gateway {
  // A timeout may occur after accepting the charge. Reusing the key returns that charge.
  charge(amount: number, idempotencyKey: string): Promise<string>;
}

export async function payWithRetry(gateway: Gateway, orderId: string, amount: number) {
  const idempotencyKey = `order:${orderId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await gateway.charge(amount, idempotencyKey);
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Payment failed");
}
