-- Phase 46B: Track which user created each POS order.
-- Additive — pos_orders table exists from 0028; this adds a nullable column.

ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS created_by_user_id UUID;

CREATE INDEX IF NOT EXISTS pos_orders_created_by_idx
  ON pos_orders (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
