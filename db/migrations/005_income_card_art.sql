-- Ingreso mensual (configurable desde la app) y diseño visual de cada tarjeta.
CREATE TABLE dbo.app_settings (
  [key]      VARCHAR(40)   NOT NULL PRIMARY KEY,
  value      NVARCHAR(200) NOT NULL,
  updated_at DATETIME2(0)  NOT NULL CONSTRAINT df_settings_updated DEFAULT SYSUTCDATETIME()
);
-- Valor inicial: $350,000.00 MXN al mes (en centavos). Se cambia en Configuración.
INSERT dbo.app_settings ([key], value) VALUES ('monthly_income_cents', '35000000');

-- NULL = diseño automático según emisor y nombre (ver src/lib/card-art.ts).
ALTER TABLE dbo.cards ADD art VARCHAR(20) NULL;
