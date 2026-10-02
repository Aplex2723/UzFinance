-- Meta de ahorro (p. ej. pago del departamento): cuánto hay que juntar, para cuándo y cuánto llevas.
-- saved_cents se actualiza a mano (el dinero vive en otra cuenta/inversión); saved_as_of dice a qué fecha es esa cifra.
CREATE TABLE dbo.savings_goals (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  name         NVARCHAR(80)  NOT NULL,
  target_cents BIGINT        NOT NULL,
  target_date  DATE          NOT NULL,
  saved_cents  BIGINT        NOT NULL CONSTRAINT df_goal_saved DEFAULT 0,
  saved_as_of  DATE          NOT NULL,
  updated_at   DATETIME2(0)  NOT NULL CONSTRAINT df_goal_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT ck_goal_amounts CHECK (target_cents > 0 AND saved_cents >= 0)
);
