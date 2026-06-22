-- QYRVIA Phase 2 - business-date awareness (adjustment #1).
--
-- A hotel's business date may differ from the calendar date (typical hotels
-- run the day from check-in time to next morning's Night Audit). Every request
-- that touches financial/operational records must bind to the property's
-- current business date so transactions land in the correct accounting day.
--
-- Phase 2 adds the column + the read path. Phase 3+ adds the Night Audit
-- command that advances current_business_date and emits 'property.day_closed'
-- / 'property.day_opened' events.

ALTER TABLE properties
  ADD COLUMN current_business_date     DATE,
  ADD COLUMN business_date_updated_at  TIMESTAMPTZ,
  ADD COLUMN business_date_locked      BOOLEAN NOT NULL DEFAULT false;

-- Initialise to today (calendar date) for any properties that already exist.
-- Brand-new properties (created post-0005) leave it NULL until the first
-- Night Audit, at which point Phase 3+ writes it.
UPDATE properties
  SET current_business_date    = CURRENT_DATE,
      business_date_updated_at = now()
  WHERE current_business_date IS NULL;

COMMENT ON COLUMN properties.current_business_date IS
  'Operational day this property is currently on. Advances on Night Audit.';
COMMENT ON COLUMN properties.business_date_locked IS
  'True while Night Audit is running. Mutations should refuse during a lock.';
