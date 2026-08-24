begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select plan(14);

select has_table('public', 'rewarded_ad_verifications', 'rewarded ad verification ledger exists');
select has_function('public', 'my_rewarded_ad_status', array[]::text[], 'rewarded ad availability RPC exists');
select has_function(
  'public', 'credit_verified_rewarded_ad', array['uuid', 'text', 'text', 'jsonb'],
  'verified rewarded ad credit function exists'
);
select ok(not has_table_privilege('authenticated', 'public.rewarded_ad_verifications', 'SELECT'), 'app cannot read verification payloads');
select ok(not has_table_privilege('authenticated', 'public.rewarded_ad_verifications', 'INSERT'), 'app cannot forge ad verifications');
select ok(has_function_privilege('authenticated', 'public.my_rewarded_ad_status()', 'EXECUTE'), 'app can read its own cooldown status');
select ok(not has_function_privilege('authenticated', 'public.credit_verified_rewarded_ad(uuid,text,text,jsonb)', 'EXECUTE'), 'app cannot self-credit rewarded ads');
select ok(has_function_privilege('service_role', 'public.credit_verified_rewarded_ad(uuid,text,text,jsonb)', 'EXECUTE'), 'verified callback service can credit rewarded ads');

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '10000000-0000-4000-8000-000000000004',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'rewarded-ad@ingtalk.invalid', '',
  '{"provider":"anonymous","providers":["anonymous"]}', '{}', now(), now()
);
insert into public.profiles(id, nickname, birth_year, region_code, gender)
values ('10000000-0000-4000-8000-000000000004', '광고테스트', 1990, 'TEST', 'other');

set local role service_role;
select results_eq(
  $$select awarded, balance from public.credit_verified_rewarded_ad(
    '10000000-0000-4000-8000-000000000004', 'test-provider', 'transaction-1', '{}')$$,
  $$values (true, 50::bigint)$$,
  'first verified ad grants exactly 50 points'
);
select results_eq(
  $$select awarded, balance from public.credit_verified_rewarded_ad(
    '10000000-0000-4000-8000-000000000004', 'test-provider', 'transaction-2', '{}')$$,
  $$values (false, 50::bigint)$$,
  'a second verified ad within 24 hours grants no points'
);
select results_eq(
  $$select awarded, balance from public.credit_verified_rewarded_ad(
    '10000000-0000-4000-8000-000000000004', 'test-provider', 'transaction-1', '{}')$$,
  $$values (false, 50::bigint)$$,
  'replaying a provider transaction grants no points'
);
select is(
  (select count(*) from public.rewarded_ad_verifications where user_id = '10000000-0000-4000-8000-000000000004'),
  2::bigint,
  'duplicate provider transactions are stored only once'
);
select is(
  (select count(*) from public.rewarded_ad_verifications where user_id = '10000000-0000-4000-8000-000000000004' and awarded),
  1::bigint,
  'only one verification is marked as awarded'
);
select is(
  (select count(*) from public.point_transactions where user_id = '10000000-0000-4000-8000-000000000004' and reason = 'reward_rewarded_ad'),
  1::bigint,
  'only one rewarded-ad point transaction is created'
);

select * from finish();
rollback;
