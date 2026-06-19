-- WhatsApp groups identify participants by @lid (linked-id), not phone. Store the lid so the
-- engine can map an inbound sender / @mention (which arrive as lids) back to the phone/profile.
ALTER TABLE sofia_group_members ADD COLUMN IF NOT EXISTS lid TEXT;
CREATE INDEX IF NOT EXISTS idx_sofia_group_members_lid ON sofia_group_members(lid);
