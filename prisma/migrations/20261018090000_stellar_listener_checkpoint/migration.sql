CREATE TABLE IF NOT EXISTS stellar_listener_checkpoint (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  ledger_sequence BIGINT NOT NULL CHECK (ledger_sequence >= 0),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
