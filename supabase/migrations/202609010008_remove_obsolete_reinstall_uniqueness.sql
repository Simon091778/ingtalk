begin;

-- Exact phone ownership is now enforced by phone_device_bindings' primary key
-- (device_scope_hash, phone_identity_hash). A device_accounts row can outlive
-- its old identity/binding after a verified account merge. Keeping the legacy
-- transport tuple unique in that state prevents the same verified phone from
-- creating its policy-required independent account and surfaces as an opaque
-- PostgREST constraint error after OTP succeeds.
alter table account_private.device_accounts
  drop constraint if exists device_reinstall_unique;

commit;
