-- Fase F: categorización con Jev (descripciones por categoría, origen y confianza) y meses sin intereses (MSI).

-- La descripción es el "criterio" que se le manda a Jev: cuanto más vocabulario real del comercio, más precisa la categoría.
ALTER TABLE dbo.categories ADD description NVARCHAR(400) NULL;

-- category_source: quién puso la categoría ('manual' = tú; 'rule' = regla; 'history' = el mismo comercio ya categorizado; 'jev').
-- plan_id: la compra a MSI que dio origen al plan (para mostrar la etiqueta "MSI" y medir cuánto gastas a meses).
ALTER TABLE dbo.transactions ADD
  category_source     VARCHAR(8)   NULL,
  category_confidence DECIMAL(4,3) NULL,
  plan_id             INT          NULL;

-- Un plan de pagos diferidos (MSI o disposición a meses) tal como aparece en el último estado de cuenta.
-- Volver a importar un estado más nuevo actualiza la misma fila (dedupe_key) en vez de duplicarla.
CREATE TABLE dbo.installment_plans (
  id                  INT IDENTITY(1,1) PRIMARY KEY,
  card_id             INT           NOT NULL CONSTRAINT fk_plan_card REFERENCES dbo.cards(id),
  category_id         INT           NULL     CONSTRAINT fk_plan_category REFERENCES dbo.categories(id) ON DELETE SET NULL,
  merchant            NVARCHAR(200) NOT NULL,
  merchant_normalized NVARCHAR(200) NOT NULL,
  kind                VARCHAR(12)   NOT NULL CONSTRAINT df_plan_kind DEFAULT 'purchase'
                      CONSTRAINT ck_plan_kind CHECK (kind IN ('purchase','cash_advance')),
  with_interest       BIT           NOT NULL CONSTRAINT df_plan_interest DEFAULT 0,
  rate_pct            DECIMAL(6,2)  NULL,
  original_cents      BIGINT        NOT NULL,   -- monto original de la compra
  monthly_cents       BIGINT        NOT NULL,   -- mensualidad
  pending_cents       BIGINT        NOT NULL,   -- saldo pendiente a la fecha as_of
  n_total             SMALLINT      NOT NULL,   -- número de mensualidades
  n_current           SMALLINT      NOT NULL,   -- mensualidades ya cobradas a la fecha as_of
  as_of               DATE          NOT NULL,   -- fecha de corte del estado de donde salen los datos
  started_on          DATE          NOT NULL,   -- fecha de la compra
  started_estimated   BIT           NOT NULL CONSTRAINT df_plan_est DEFAULT 0,  -- 1 = deducida (Banamex no imprime la fecha original)
  source              VARCHAR(10)   NOT NULL CONSTRAINT df_plan_source DEFAULT 'statement'
                      CONSTRAINT ck_plan_source CHECK (source IN ('statement','manual')),
  dedupe_key          CHAR(64)      NOT NULL,
  updated_at          DATETIME2(0)  NOT NULL CONSTRAINT df_plan_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_plan_dedupe UNIQUE (dedupe_key),
  CONSTRAINT ck_plan_n CHECK (n_total >= 1 AND n_current >= 0 AND n_current <= n_total),
  CONSTRAINT ck_plan_amounts CHECK (original_cents > 0 AND monthly_cents >= 0 AND pending_cents >= 0)
);
CREATE INDEX ix_plan_card ON dbo.installment_plans (card_id);

-- (EXEC: las columnas nuevas de transactions no existen aún al compilar el lote)
EXEC('ALTER TABLE dbo.transactions ADD CONSTRAINT fk_tx_plan FOREIGN KEY (plan_id) REFERENCES dbo.installment_plans(id) ON DELETE SET NULL');
EXEC('ALTER TABLE dbo.transactions ADD CONSTRAINT ck_tx_catsrc CHECK (category_source IS NULL OR category_source IN (''manual'',''rule'',''history'',''jev''))');
EXEC('CREATE INDEX ix_tx_plan ON dbo.transactions (plan_id) WHERE plan_id IS NOT NULL');
-- Lo que ya estaba categorizado lo puso una persona o una regla; no se le atribuye a Jev.
EXEC('UPDATE dbo.transactions SET category_source = ''manual'' WHERE category_id IS NOT NULL');
