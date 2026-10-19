# Idempotent order creation

Clients creating an order must send a UUID `idempotencyKey` in the request
body. Reuse that UUID for retries of the same request. The server binds the
key to a hash of the order fields and rejects reuse with different values.

The server reserves the key before deploying the escrow and uses the key as
the order and on-chain engagement ID. A second concurrent request cannot
start another deployment. Once the deployment is recorded, retries reuse its
contract and unsigned funding transaction. If the process stops in the narrow
window between chain deployment and saving its result, the reservation stays
`pending` with the stable order ID so operators can find and reconcile the
deployment instead of creating a second one.

The authenticated buyer or seller can inspect recovery state with
`GET /orders/creation/:idempotencyKey`. The response contains the stable
`orderId`, `status`, and (when known) `contractId`; it does not expose the
unsigned transaction.
