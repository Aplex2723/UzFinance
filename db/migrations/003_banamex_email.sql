-- Fase D: ingesta de correos de Banamex.
-- kind: 'expense' cuenta como gasto; 'card_payment' (pago a tarjeta) queda fuera de todos los totales.
ALTER TABLE dbo.transactions ADD
  kind             VARCHAR(12)  NOT NULL CONSTRAINT df_tx_kind DEFAULT 'expense'
                   CONSTRAINT ck_tx_kind CHECK (kind IN ('expense','card_payment')),
  is_recurring     BIT          NOT NULL CONSTRAINT df_tx_recurring DEFAULT 0,
  sources          VARCHAR(40)  NOT NULL CONSTRAINT df_tx_sources DEFAULT '',   -- p. ej. 'shortcut,email'
  auth_code        VARCHAR(30)  NULL,                                           -- No. de autorización del banco
  email_message_id VARCHAR(200) NULL;                                           -- id de Gmail (idempotencia)

EXEC('UPDATE dbo.transactions SET sources = source');

-- (EXEC: las columnas nuevas no existen aún al compilar el lote)
EXEC('CREATE UNIQUE INDEX uq_tx_email_msg ON dbo.transactions (email_message_id) WHERE email_message_id IS NOT NULL');
CREATE INDEX ix_tx_merge ON dbo.transactions (card_id, amount_cents, occurred_at);
EXEC('CREATE INDEX ix_tx_auth ON dbo.transactions (auth_code, amount_cents) WHERE auth_code IS NOT NULL');

-- Hashes del Atajo ya fusionados con un correo: un reintento del Atajo no debe crear otra fila.
CREATE TABLE dbo.merged_hashes (
  hash   CHAR(64) NOT NULL PRIMARY KEY,
  tx_id  BIGINT   NOT NULL CONSTRAINT fk_merged_tx REFERENCES dbo.transactions(id) ON DELETE CASCADE
);

-- Tarjetas descubiertas por correo: bank_key = '<variante>:<dígitos>'; needs_name = pendiente de nombrar.
ALTER TABLE dbo.cards ALTER COLUMN last4 VARCHAR(4) NULL;
ALTER TABLE dbo.cards ADD
  needs_name BIT NOT NULL CONSTRAINT df_cards_needs_name DEFAULT 0,
  bank_key   VARCHAR(30) NULL;
EXEC('CREATE UNIQUE INDEX uq_cards_bank_key ON dbo.cards (bank_key) WHERE bank_key IS NOT NULL');

-- Correos que no se pudieron interpretar. NUNCA se guarda el cuerpo.
CREATE TABLE dbo.unparsed_emails (
  message_id  VARCHAR(200)  NOT NULL PRIMARY KEY,
  sender      VARCHAR(200)  NOT NULL,
  subject     NVARCHAR(200) NOT NULL,
  received_at DATETIME2(0)  NOT NULL,
  reason      VARCHAR(200)  NOT NULL,
  created_at  DATETIME2(0)  NOT NULL CONSTRAINT df_unparsed_created DEFAULT SYSUTCDATETIME()
);
