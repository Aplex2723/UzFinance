-- Varias metas de ahorro (departamento, auto, viaje…): la tabla savings_goals ya admitía varias filas;
-- se agregan el tipo (icono), la prioridad (quién se financia primero), si la fecha es solo "mes" y cuándo se creó.
ALTER TABLE dbo.savings_goals ADD
  kind       NVARCHAR(16) NOT NULL CONSTRAINT df_goal_kind    DEFAULT N'otro' CONSTRAINT ck_goal_kind CHECK (kind IN (N'casa', N'auto', N'viaje', N'emergencia', N'educacion', N'otro')),
  priority   TINYINT      NOT NULL CONSTRAINT df_goal_prio    DEFAULT 2       CONSTRAINT ck_goal_prio CHECK (priority BETWEEN 1 AND 3),
  month_only BIT          NOT NULL CONSTRAINT df_goal_month   DEFAULT 0,
  created_at DATETIME2(0) NOT NULL CONSTRAINT df_goal_created DEFAULT SYSUTCDATETIME();
