-- QYRVIA Phase 6 / Step 5 - AI conversation/message append-only hardening.
--
-- WHY: ai_conversations + ai_messages are the system of record for AI
-- interactions on guest / staff data. Tenant compliance requires they be
-- append-only - no after-the-fact UPDATE or DELETE. Phase 5.5 enforced
-- this for audit_events + event_store; this migration extends it to the
-- AI subsystem. The application role retains INSERT via its standard
-- grants (NOT affected by REVOKE FROM PUBLIC).

REVOKE UPDATE, DELETE ON ai_conversations FROM PUBLIC;
REVOKE UPDATE, DELETE ON ai_messages      FROM PUBLIC;
