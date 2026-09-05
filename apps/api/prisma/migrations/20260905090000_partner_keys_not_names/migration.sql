-- Partner identity is display data, not a schema constant.
--
-- The enum previously carried two real people's names, inherited from the
-- project this codebase was cloned from. Encoding a person in an enum means a
-- migration every time a business changes partners, and it carried one client's
-- proprietors into another's books. The values become opaque keys; the names
-- now live on the company profile (partner1Name / partner2Name) and are edited
-- in Settings -> Business Profile.
--
-- RENAME VALUE (not drop-and-recreate) so existing expense rows keep pointing
-- at the same partner. Postgres 10+; the column is rewritten in place.
ALTER TYPE "PaidBy" RENAME VALUE 'KALPESHBHAI' TO 'PARTNER_1';
ALTER TYPE "PaidBy" RENAME VALUE 'MAYURBHAI'  TO 'PARTNER_2';

-- Ledger mappings keyed off the old enum values follow the rename, so the
-- partner's Tally current account stays attached to the same partner.
UPDATE "tally_ledger_map"
   SET "slot_key" = 'PARTNER_PARTNER_1'
 WHERE "slot" = 'SPECIAL' AND "slot_key" = 'PARTNER_KALPESHBHAI';
UPDATE "tally_ledger_map"
   SET "slot_key" = 'PARTNER_PARTNER_2'
 WHERE "slot" = 'SPECIAL' AND "slot_key" = 'PARTNER_MAYURBHAI';
