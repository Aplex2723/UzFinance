-- Agrega Nu como emisor soportado (compatible hacia atrás: no cambia datos existentes).
ALTER TABLE dbo.cards DROP CONSTRAINT ck_cards_issuer;
ALTER TABLE dbo.cards ADD CONSTRAINT ck_cards_issuer CHECK (issuer IN ('amex','banamex','nu','other'));
