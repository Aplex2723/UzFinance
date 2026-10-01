CREATE TABLE dbo.cards (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  name         NVARCHAR(60)  NOT NULL,
  issuer       VARCHAR(10)   NOT NULL CONSTRAINT ck_cards_issuer CHECK (issuer IN ('amex','banamex','other')),
  last4        CHAR(4)       NULL,
  aliases      NVARCHAR(300) NULL,          -- nombres alternativos separados por coma (como los manda Wallet)
  color        VARCHAR(9)    NOT NULL CONSTRAINT df_cards_color DEFAULT '#ff4d1c',
  active       BIT           NOT NULL CONSTRAINT df_cards_active DEFAULT 1,
  created_at   DATETIME2(0)  NOT NULL CONSTRAINT df_cards_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_cards_name UNIQUE (name)
);

CREATE TABLE dbo.categories (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  name         NVARCHAR(60) NOT NULL,
  color        VARCHAR(9)   NOT NULL CONSTRAINT df_categories_color DEFAULT '#9ca3af',
  created_at   DATETIME2(0) NOT NULL CONSTRAINT df_categories_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_categories_name UNIQUE (name)
);

CREATE TABLE dbo.category_rules (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  pattern      NVARCHAR(120) NOT NULL,      -- se compara contra el comercio normalizado (MAYÚSCULAS, sin acentos)
  match_type   VARCHAR(10)   NOT NULL CONSTRAINT df_rules_match DEFAULT 'contains'
               CONSTRAINT ck_rules_match CHECK (match_type IN ('contains','exact','startswith')),
  category_id  INT NOT NULL CONSTRAINT fk_rules_category REFERENCES dbo.categories(id) ON DELETE CASCADE,
  priority     INT NOT NULL CONSTRAINT df_rules_priority DEFAULT 0,
  created_at   DATETIME2(0) NOT NULL CONSTRAINT df_rules_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_rules_pattern UNIQUE (pattern, match_type)
);

CREATE TABLE dbo.transactions (
  id                  BIGINT IDENTITY(1,1) PRIMARY KEY,
  occurred_at         DATETIME2(0)  NOT NULL,   -- UTC
  occurred_date       DATE          NOT NULL,   -- fecha local America/Mexico_City (para agregaciones)
  amount_cents        BIGINT        NOT NULL,   -- reembolsos = negativo
  currency            CHAR(3)       NOT NULL CONSTRAINT df_tx_currency DEFAULT 'MXN',
  merchant_raw        NVARCHAR(200) NOT NULL,
  merchant_normalized NVARCHAR(200) NOT NULL,
  card_id             INT NOT NULL CONSTRAINT fk_tx_card REFERENCES dbo.cards(id),
  category_id         INT NULL CONSTRAINT fk_tx_category REFERENCES dbo.categories(id) ON DELETE SET NULL,
  source              VARCHAR(10)   NOT NULL CONSTRAINT ck_tx_source CHECK (source IN ('shortcut','email','statement','manual')),
  dedupe_hash         CHAR(64)      NOT NULL,
  notes               NVARCHAR(500) NULL,
  created_at          DATETIME2(0)  NOT NULL CONSTRAINT df_tx_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_tx_dedupe UNIQUE (dedupe_hash),
  CONSTRAINT ck_tx_nonzero CHECK (amount_cents <> 0)
);

CREATE INDEX ix_tx_date     ON dbo.transactions (occurred_date) INCLUDE (amount_cents, card_id, category_id);
CREATE INDEX ix_tx_card     ON dbo.transactions (card_id, occurred_date);
CREATE INDEX ix_tx_merchant ON dbo.transactions (merchant_normalized);
