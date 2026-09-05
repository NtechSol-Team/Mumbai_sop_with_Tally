-- Scrub the previous client's partner names out of the Tally ledger map.
--
-- The rename in the previous migration moved the keys but left the ledger
-- NAMES, which were seeded from the old enum: "Kalpeshbhai Current A/c" and
-- "Mayurbhai Current A/c". Those are two real people from a different business
-- and must not appear in this client's books.
--
-- Only rows still holding exactly the seeded default are touched, and only
-- where the ledger has never been confirmed to exist in Tally (validated_at IS
-- NULL). A ledger someone has already validated is left alone and flagged
-- instead: silently repointing a map row whose ledger exists in Tally would
-- strand every voucher already posted against it. The owner renames those two
-- in Settings -> Tally, and in Tally itself.
UPDATE "tally_ledger_map"
   SET "tally_ledger_name" = 'Partner 1 Current A/c',
       "slot_label"        = 'Partner 1 — current account'
 WHERE "slot" = 'SPECIAL' AND "slot_key" = 'PARTNER_PARTNER_1'
   AND "tally_ledger_name" = 'Kalpeshbhai Current A/c'
   AND "validated_at" IS NULL;

UPDATE "tally_ledger_map"
   SET "tally_ledger_name" = 'Partner 2 Current A/c',
       "slot_label"        = 'Partner 2 — current account'
 WHERE "slot" = 'SPECIAL' AND "slot_key" = 'PARTNER_PARTNER_2'
   AND "tally_ledger_name" = 'Mayurbhai Current A/c'
   AND "validated_at" IS NULL;

UPDATE "tally_ledger_map"
   SET "notes" = COALESCE("notes" || ' | ', '')
       || 'Carries a partner name from the source project. Rename this ledger here and in Tally.'
 WHERE "slot" = 'SPECIAL'
   AND "slot_key" IN ('PARTNER_PARTNER_1', 'PARTNER_PARTNER_2')
   AND "tally_ledger_name" IN ('Kalpeshbhai Current A/c', 'Mayurbhai Current A/c');
