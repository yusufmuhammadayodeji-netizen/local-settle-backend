CREATE TABLE order_creation_reservation (
  idempotency_key UUID PRIMARY KEY,
  order_id UUID NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  buyer_id UUID NOT NULL,
  seller_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'deployed', 'completed')),
  contract_id TEXT,
  unsigned_fund_transaction TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'pending' AND contract_id IS NULL AND unsigned_fund_transaction IS NULL)
    OR (status IN ('deployed', 'completed') AND contract_id IS NOT NULL AND unsigned_fund_transaction IS NOT NULL)
  )
);
