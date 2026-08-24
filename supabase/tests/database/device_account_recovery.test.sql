begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select plan(4);

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'recovery-old@ingtalk.invalid', '', '{"provider":"anonymous","providers":["anonymous"]}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000022', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'recovery-new@ingtalk.invalid', '', '{"provider":"anonymous","providers":["anonymous"]}', '{}', now(), now());

insert into public.profiles(id, nickname, birth_year, region_code, gender, interests, welcome_points_claimed, language_code, country_code)
values
  ('10000000-0000-4000-8000-000000000021', '복구기존', 1990, 'KR', 'male', '{}', true, 'ko', 'KR'),
  ('10000000-0000-4000-8000-000000000022', '임시프로필', 1991, 'US', 'female', '{}', false, 'en', 'US');

update public.point_wallets set balance = 432 where user_id = '10000000-0000-4000-8000-000000000021';
insert into public.device_point_wallets(id, device_hash, balance, welcome_granted_at)
values ('20000000-0000-4000-8000-000000000021', repeat('d', 64), 432, now());
insert into public.device_wallet_bindings(wallet_id, user_id)
values ('20000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000021');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000022', true);
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000022","role":"authenticated"}', true);

select is((public.restore_device_account(repeat('d', 64))->>'recovered')::boolean, true, 'reinstall recovery succeeds when the target profile trigger already created a wallet');
select is((select balance from public.point_wallets where user_id = auth.uid()), 432::bigint, 'the restored user receives the device-backed balance');
select is((select count(*) from public.point_wallets where user_id = '10000000-0000-4000-8000-000000000021'), 0::bigint, 'the previous point wallet is removed after the balance merge');
select is((select count(*) from public.device_wallet_bindings where wallet_id = '20000000-0000-4000-8000-000000000021' and user_id = auth.uid() and released_at is null), 1::bigint, 'the device wallet is actively rebound to the restored user');

select * from finish();
rollback;
