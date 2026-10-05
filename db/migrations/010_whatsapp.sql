-- Bots de chat (WhatsApp y Telegram): idempotencia de mensajes del webhook, conversación pendiente y "deshacer";
-- además, Telegram como origen de documentos y como canal de avisos de alertas.

-- Cada mensaje entrante (wamid de Meta) se procesa UNA vez aunque el webhook reintente. Nunca se guarda el texto.
CREATE TABLE dbo.whatsapp_messages (
  msg_id      VARCHAR(120) NOT NULL PRIMARY KEY,
  wa_id       VARCHAR(20)  NOT NULL,                       -- número del remitente (solo dígitos)
  kind        VARCHAR(12)  NOT NULL,                       -- text | document | image | audio | other
  status      VARCHAR(10)  NOT NULL CONSTRAINT df_wamsg_status DEFAULT 'received'
              CONSTRAINT ck_wamsg_status CHECK (status IN ('received','done','failed','ignored')),
  tx_id       BIGINT       NULL CONSTRAINT fk_wamsg_tx REFERENCES dbo.transactions(id) ON DELETE SET NULL,
  document_id INT          NULL CONSTRAINT fk_wamsg_doc REFERENCES dbo.documents(id) ON DELETE SET NULL,
  -- 1 = el registro que hizo este mensaje ya se deshizo. Borrar el movimiento deja tx_id en NULL (FK SET NULL) y, sin esta marca,
  -- el registro ANTERIOR del remitente pasaría a ser "el último".
  undone      BIT          NOT NULL CONSTRAINT df_wamsg_undone DEFAULT 0,
  -- Orden de llegada (created_at solo tiene precisión de segundos): desempata dos mensajes del mismo segundo.
  seq         BIGINT       IDENTITY(1,1) NOT NULL,
  created_at  DATETIME2(0) NOT NULL CONSTRAINT df_wamsg_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_wamsg_sender ON dbo.whatsapp_messages (wa_id, created_at DESC);

-- Un gasto a medias ("350 starbucks" sin tarjeta) espera la respuesta del usuario. Uno por remitente; caduca solo.
CREATE TABLE dbo.whatsapp_pending (
  wa_id      VARCHAR(20)   NOT NULL PRIMARY KEY,
  step       VARCHAR(16)   NOT NULL CONSTRAINT ck_wapend_step CHECK (step IN ('card','merchant','confirm','duplicate')),
  payload    NVARCHAR(MAX) NOT NULL,                       -- JSON con lo ya entendido (monto, comercio, tarjetas candidatas…)
  expires_at DATETIME2(0)  NOT NULL,
  created_at DATETIME2(0)  NOT NULL CONSTRAINT df_wapend_created DEFAULT SYSUTCDATETIME()
);

-- Telegram como origen de un PDF recibido por el chat (antes solo 'app' y 'whatsapp'). Solo cambia un CHECK: sin reescribir filas.
ALTER TABLE dbo.documents DROP CONSTRAINT ck_documents_origin;
ALTER TABLE dbo.documents ADD CONSTRAINT ck_documents_origin CHECK (origin IN ('app','whatsapp','telegram'));

-- Telegram como canal de la cola de avisos (UNIQUE (alert_id, channel) ya permite un envío por canal).
ALTER TABLE dbo.alert_outbox DROP CONSTRAINT ck_outbox_channel;
ALTER TABLE dbo.alert_outbox ADD CONSTRAINT ck_outbox_channel CHECK (channel IN ('whatsapp','telegram'));
-- Datos del emisor (columnas nulas: ALTER de solo metadatos, sin reescribir filas).
--   claimed_at: último intento reclamado (reserva atómica y espera entre reintentos).
--   sent_to:    ids de chat que YA recibieron el aviso (coma): un reintento no lo repite a quien sí lo recibió.
ALTER TABLE dbo.alert_outbox ADD claimed_at DATETIME2(0) NULL, sent_to VARCHAR(120) NULL;
-- El emisor busca lo pendiente por canal y estado.
CREATE INDEX ix_outbox_channel_status ON dbo.alert_outbox (channel, status, created_at);
