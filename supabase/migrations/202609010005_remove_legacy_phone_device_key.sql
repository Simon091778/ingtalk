begin;

-- Recovery is keyed by (device_scope_hash, phone_identity_hash). The original
-- transport-key uniqueness incorrectly rejected a valid native pair when the
-- same random secret had once been used by the legacy web-compatible RPC.
alter table account_private.device_accounts
  drop constraint if exists device_accounts_auth_user_id_phone_hash_device_hash_key;

commit;
