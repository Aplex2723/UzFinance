-- Domiciliaciones: la "Cuenta de cargo" es una referencia de la transacción, no una tarjeta.
ALTER TABLE dbo.transactions ADD account_ref VARCHAR(10) NULL;

-- Clave de tarjeta = producto + bandera de adicional + dígitos (más larga que la de 003).
DROP INDEX uq_cards_bank_key ON dbo.cards;
ALTER TABLE dbo.cards ALTER COLUMN bank_key VARCHAR(80) NULL;
UPDATE dbo.cards SET bank_key = NULL;   -- 003 nunca llegó a producción: las claves viejas se regeneran solas
CREATE UNIQUE INDEX uq_cards_bank_key ON dbo.cards (bank_key) WHERE bank_key IS NOT NULL;

-- Comercios de domiciliación que son tarjetas mías (pago de tarjeta, no gasto). Se edita en Configuración.
CREATE TABLE dbo.own_payees (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  pattern    NVARCHAR(80) NOT NULL,   -- se compara contra el comercio normalizado, por palabras completas
  created_at DATETIME2(0) NOT NULL CONSTRAINT df_payees_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_payees_pattern UNIQUE (pattern)
);
INSERT dbo.own_payees (pattern) VALUES (N'AMERICAN EXPRESS'), (N'AMEX');
