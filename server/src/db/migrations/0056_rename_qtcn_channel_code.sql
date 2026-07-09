-- Phase 51: Rename QYRVIA Connect canonical channel code from QTCN to QYRVIA_CONNECT.
-- QTCN remains as a legacy alias in application code for backward compatibility
-- with old queued jobs, env values, and inbound legacy payloads.
-- Idempotent: WHERE clause is a no-op if rows have already been renamed.
UPDATE channel_registry
  SET channel_code = 'QYRVIA_CONNECT',
      updated_at   = now()
  WHERE channel_code = 'QTCN';
