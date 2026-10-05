-- Fase G: documentos PDF (comprobantes de transferencia y estados de cuenta), conciliación y alertas.

-- La configuración (alertas, mapa de tarjetas de los estados) es JSON: ya no cabe en 200 caracteres.
ALTER TABLE dbo.app_settings ALTER COLUMN value NVARCHAR(MAX) NOT NULL;

-- Origen "receipt": movimiento creado desde un comprobante de transferencia (PDF).
ALTER TABLE dbo.transactions DROP CONSTRAINT ck_tx_source;
ALTER TABLE dbo.transactions ADD CONSTRAINT ck_tx_source CHECK (source IN ('shortcut','email','statement','manual','receipt'));
-- Clave de rastreo (SPEI): identifica una transferencia de forma única, venga del PDF o del correo.
ALTER TABLE dbo.transactions ADD tracking_key VARCHAR(40) NULL;
EXEC('CREATE UNIQUE INDEX uq_tx_tracking ON dbo.transactions (tracking_key) WHERE tracking_key IS NOT NULL');

-- Cada PDF recibido (app o, más adelante, WhatsApp). NUNCA se guarda el archivo: solo su huella y lo extraído.
CREATE TABLE dbo.documents (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  sha256       CHAR(64)      NOT NULL CONSTRAINT uq_documents_sha UNIQUE, -- el mismo PDF no se procesa dos veces
  kind         VARCHAR(20)   NOT NULL CONSTRAINT ck_documents_kind CHECK (kind IN ('transfer_receipt','statement','unknown')),
  origin       VARCHAR(10)   NOT NULL CONSTRAINT ck_documents_origin CHECK (origin IN ('app','whatsapp')),
  status       VARCHAR(14)   NOT NULL CONSTRAINT ck_documents_status CHECK (status IN ('processed','needs_review','rejected','failed')),
  title        NVARCHAR(200) NULL,
  detail       NVARCHAR(500) NULL,                                         -- motivo legible del estado
  extracted    NVARCHAR(MAX) NULL,                                         -- JSON normalizado (sin números de cuenta completos)
  card_id      INT           NULL CONSTRAINT fk_documents_card REFERENCES dbo.cards(id) ON DELETE SET NULL,
  tx_id        BIGINT        NULL CONSTRAINT fk_documents_tx REFERENCES dbo.transactions(id) ON DELETE SET NULL,
  period_start DATE          NULL,
  period_end   DATE          NULL,
  size_bytes   INT           NOT NULL,
  pages        INT           NULL,
  created_at   DATETIME2(0)  NOT NULL CONSTRAINT df_documents_created DEFAULT SYSUTCDATETIME(),
  updated_at   DATETIME2(0)  NOT NULL CONSTRAINT df_documents_updated DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_documents_created ON dbo.documents (created_at DESC);

-- Una conciliación por documento y tarjeta (un estado de Amex con adicionales genera varias).
CREATE TABLE dbo.recon_runs (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  document_id     INT           NOT NULL CONSTRAINT fk_recon_doc REFERENCES dbo.documents(id) ON DELETE CASCADE,
  card_id         INT           NULL CONSTRAINT fk_recon_card REFERENCES dbo.cards(id) ON DELETE SET NULL,
  label           NVARCHAR(120) NOT NULL,
  period_start    DATE          NOT NULL,
  period_end      DATE          NOT NULL,
  statement_cents BIGINT        NOT NULL,   -- suma de lo que trae el estado (cargos)
  app_cents       BIGINT        NOT NULL,   -- suma de lo registrado en la app en el mismo periodo
  statement_count INT           NOT NULL,
  app_count       INT           NOT NULL,
  matched         INT           NOT NULL,
  created_at      DATETIME2(0)  NOT NULL CONSTRAINT df_recon_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_recon_doc ON dbo.recon_runs (document_id);

CREATE TABLE dbo.recon_findings (
  id                 BIGINT IDENTITY(1,1) PRIMARY KEY,
  run_id             INT           NOT NULL CONSTRAINT fk_finding_run REFERENCES dbo.recon_runs(id) ON DELETE CASCADE,
  fingerprint        VARCHAR(64)   NOT NULL,                 -- estable entre re-conciliaciones: conserva lo que ya descartaste
  kind               VARCHAR(24)   NOT NULL,                 -- missing_in_app | not_in_statement | duplicate_suspect | amount_mismatch | date_mismatch | total_mismatch | ...
  severity           VARCHAR(6)    NOT NULL CONSTRAINT ck_finding_sev CHECK (severity IN ('info','warn','high')),
  tx_id              BIGINT        NULL CONSTRAINT fk_finding_tx REFERENCES dbo.transactions(id) ON DELETE SET NULL,
  other_tx_id        BIGINT        NULL,
  stmt_date          DATE          NULL,
  stmt_amount_cents  BIGINT        NULL,
  stmt_merchant      NVARCHAR(200) NULL,
  stmt_type          VARCHAR(30)   NULL,
  message            NVARCHAR(500) NOT NULL,
  detail             NVARCHAR(MAX) NULL,                     -- JSON
  status             VARCHAR(10)   NOT NULL CONSTRAINT df_finding_status DEFAULT 'open' CONSTRAINT ck_finding_status CHECK (status IN ('open','resolved','dismissed')),
  resolved_at        DATETIME2(0)  NULL,
  created_at         DATETIME2(0)  NOT NULL CONSTRAINT df_finding_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_finding UNIQUE (run_id, fingerprint)
);
CREATE INDEX ix_finding_status ON dbo.recon_findings (status, severity);

-- Alertas (gasto fuerte, ritmo, duplicados, diferencias con el estado…). dedupe_key evita repetir la misma alerta.
CREATE TABLE dbo.alerts (
  id           BIGINT IDENTITY(1,1) PRIMARY KEY,
  [rule]       VARCHAR(30)   NOT NULL,
  severity     VARCHAR(6)    NOT NULL CONSTRAINT ck_alert_sev CHECK (severity IN ('info','warn','high')),
  title        NVARCHAR(120) NOT NULL,
  body         NVARCHAR(500) NOT NULL,
  dedupe_key   VARCHAR(120)  NOT NULL CONSTRAINT uq_alert_dedupe UNIQUE,
  tx_id        BIGINT        NULL CONSTRAINT fk_alert_tx REFERENCES dbo.transactions(id) ON DELETE SET NULL,
  document_id  INT           NULL CONSTRAINT fk_alert_doc REFERENCES dbo.documents(id) ON DELETE SET NULL,
  data         NVARCHAR(MAX) NULL,
  created_at   DATETIME2(0)  NOT NULL CONSTRAINT df_alert_created DEFAULT SYSUTCDATETIME(),
  read_at      DATETIME2(0)  NULL,
  dismissed_at DATETIME2(0)  NULL
);
CREATE INDEX ix_alert_open ON dbo.alerts (created_at DESC) WHERE dismissed_at IS NULL;

-- Cola de salida para avisos por WhatsApp. El envío real aún no existe: esta tabla solo deja listo el contrato.
CREATE TABLE dbo.alert_outbox (
  id          BIGINT IDENTITY(1,1) PRIMARY KEY,
  alert_id    BIGINT        NOT NULL CONSTRAINT fk_outbox_alert REFERENCES dbo.alerts(id) ON DELETE CASCADE,
  channel     VARCHAR(12)   NOT NULL CONSTRAINT ck_outbox_channel CHECK (channel IN ('whatsapp')),
  status      VARCHAR(10)   NOT NULL CONSTRAINT df_outbox_status DEFAULT 'pending' CONSTRAINT ck_outbox_status CHECK (status IN ('pending','sent','failed','skipped')),
  attempts    INT           NOT NULL CONSTRAINT df_outbox_attempts DEFAULT 0,
  last_error  NVARCHAR(300) NULL,
  created_at  DATETIME2(0)  NOT NULL CONSTRAINT df_outbox_created DEFAULT SYSUTCDATETIME(),
  sent_at     DATETIME2(0)  NULL,
  CONSTRAINT uq_outbox UNIQUE (alert_id, channel)
);
