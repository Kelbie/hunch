interface Actor { tenantId: string }
interface Invoice { id: string; tenantId: string; amount: number }
interface InvoiceStore { find(tenantId: string, invoiceId: string): Promise<Invoice | null> }

// An actor may read invoices only within their own tenant.
export async function readInvoice(actor: Actor, requestedTenant: string, invoiceId: string, store: InvoiceStore) {
  if (!actor.tenantId) throw new Error("Access denied");
  return store.find(requestedTenant, invoiceId);
}
