begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(30);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('9a000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.login(n integer,method text default 'password') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',pg_temp.uid(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object(
    'sub',pg_temp.uid(n),'role','authenticated','session_id',pg_temp.uid(n+500),
    'amr',jsonb_build_array(jsonb_build_object('method',method,'timestamp',extract(epoch from now())::bigint)))::text,true);
end $$;
create function pg_temp.error(statement text) returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end $$;
create function pg_temp.result_count(query_text text,status_text text default null) returns bigint language sql as $$
  select count(*) from public.admin_search_users(query_text,status_text,200)
$$;
create temporary table tap_output(line text);
grant all on pg_temp.tap_output to authenticated;

-- Allow rollback-only corrupt/historical fixtures; production keeps this index.
drop index account_private.account_identities_one_social_provider_per_account;

insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
values
  (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'821067891234',now(),false,now(),now()),
  (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-google@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(3),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821088887777',now(),false,now(),now()),
  (pg_temp.uid(4),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821033334444',now(),false,now(),now()),
  (pg_temp.uid(5),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','current-google@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(6),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','stale-google@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(7),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821055551111',now(),false,now(),now()),
  (pg_temp.uid(8),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821055552222',now(),false,now(),now()),
  (pg_temp.uid(9),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','first-google@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(10),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','second-google@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(90),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(91),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now());

insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
  (gen_random_uuid(),pg_temp.uid(2),'google','search-google','{"sub":"search-google","email":"User.Example@Gmail.com","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(5),'google','search-current','{"sub":"search-current","email":"current-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(6),'google','search-stale','{"sub":"search-stale","email":"stale-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(9),'google','search-first','{"sub":"search-first","email":"first-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(10),'google','search-second','{"sub":"search-second","email":"second-google@example.invalid","email_verified":true}');

insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(90),'reviewer',true);
insert into account_private.device_accounts(id,auth_user_id) values
  (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(2)),
  (pg_temp.uid(103),pg_temp.uid(4)),(pg_temp.uid(104),pg_temp.uid(5)),
  (pg_temp.uid(105),pg_temp.uid(7)),(pg_temp.uid(106),pg_temp.uid(9));
insert into public.profiles(id,nickname,birth_year,region_code,gender,status,created_at,updated_at) values
  (pg_temp.uid(101),'전화검색101',1990,'TEST','male','active',now()-interval '6 days',now()),
  (pg_temp.uid(102),'구글검색대상',1990,'TEST','female','active',now()-interval '5 days',now()),
  (pg_temp.uid(103),'번호교체대상',1990,'TEST','male','active',now()-interval '4 days',now()),
  (pg_temp.uid(104),'구글교체대상',1990,'TEST','female','suspended',now()-interval '3 days',now()),
  (pg_temp.uid(105),'복수번호대상',1990,'TEST','male','active',now()-interval '2 days',now()),
  (pg_temp.uid(106),'복수구글대상',1990,'TEST','female','active',now()-interval '1 day',now());

insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values
  (pg_temp.uid(101),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone')),
  (pg_temp.uid(102),pg_temp.uid(2),'google',account_private.identity_hash(pg_temp.uid(2),'google')),
  (pg_temp.uid(103),pg_temp.uid(3),'phone',account_private.hash_phone('+821099990000')),
  (pg_temp.uid(103),pg_temp.uid(4),'phone',account_private.identity_hash(pg_temp.uid(4),'phone')),
  (pg_temp.uid(104),pg_temp.uid(5),'google',account_private.identity_hash(pg_temp.uid(5),'google')),
  (pg_temp.uid(104),pg_temp.uid(6),'google',repeat('f',64)),
  (pg_temp.uid(105),pg_temp.uid(7),'phone',account_private.identity_hash(pg_temp.uid(7),'phone')),
  (pg_temp.uid(105),pg_temp.uid(8),'phone',account_private.identity_hash(pg_temp.uid(8),'phone')),
  (pg_temp.uid(106),pg_temp.uid(9),'google',account_private.identity_hash(pg_temp.uid(9),'google')),
  (pg_temp.uid(106),pg_temp.uid(10),'google',account_private.identity_hash(pg_temp.uid(10),'google'));

insert into tap_output select ok(not has_function_privilege('anon','public.admin_search_users(text,text,integer)','EXECUTE'),'anonymous cannot search users');
insert into tap_output select ok(not has_table_privilege('authenticated','auth.users','SELECT'),'authenticated cannot read Auth users');
insert into tap_output select ok(not has_table_privilege('authenticated','auth.identities','SELECT'),'authenticated cannot read Auth identities');

set local role authenticated;
select pg_temp.login(91,'otp');
insert into tap_output select is(pg_temp.error($$select * from public.admin_search_users('01012345678',null,200)$$),'account_unlock_required','ordinary authenticated user cannot search identities');
select pg_temp.login(90);

insert into tap_output select is(pg_temp.result_count('전화검색'),1::bigint,'existing nickname partial search remains available');
insert into tap_output select is(pg_temp.result_count(pg_temp.uid(101)::text),1::bigint,'existing account ID search remains available');
insert into tap_output select is(pg_temp.result_count('01067891234'),1::bigint,'compact Korean phone finds current account');
insert into tap_output select is(pg_temp.result_count('010-6789-1234'),1::bigint,'dashed Korean phone finds current account');
insert into tap_output select is(pg_temp.result_count('010 6789 1234'),1::bigint,'spaced Korean phone finds current account');
insert into tap_output select is(pg_temp.result_count('+821067891234'),1::bigint,'E.164 phone finds current account');
insert into tap_output select is(pg_temp.result_count('+82 10 6789 1234'),1::bigint,'spaced E.164 phone finds current account');
insert into tap_output select is(pg_temp.result_count('01099998888'),0::bigint,'unknown phone returns an empty result');
insert into tap_output select is((select user_id from public.admin_search_users('user.example@gmail.com',null,200)),pg_temp.uid(102),'Google email matching is case insensitive');
insert into tap_output select is((select user_id from public.admin_search_users('USER.EXAMPLE@GMAIL.COM',null,200)),pg_temp.uid(102),'uppercase Google email finds the same account');
insert into tap_output select is((select user_id from public.admin_search_users('  User.Example@Gmail.com  ',null,200)),pg_temp.uid(102),'Google email search trims surrounding whitespace');
insert into tap_output select is(pg_temp.result_count('user.example@'),0::bigint,'Google email requires an exact match');
insert into tap_output select is(pg_temp.result_count('phone-only@example.invalid'),0::bigint,'phone-only account is excluded from Google email search');
insert into tap_output select is(pg_temp.result_count('01077776666'),0::bigint,'Google-only account is excluded from phone search');
insert into tap_output select is(pg_temp.result_count('01099990000'),0::bigint,'stale phone does not find its historical account');
insert into tap_output select is((select user_id from public.admin_search_users('01033334444',null,200)),pg_temp.uid(103),'current replacement phone finds canonical account');
insert into tap_output select is(pg_temp.result_count('stale-google@example.invalid'),0::bigint,'stale Google email does not find historical mapping');
insert into tap_output select is((select user_id from public.admin_search_users('current-google@example.invalid',null,200)),pg_temp.uid(104),'current Google email finds canonical account');
insert into tap_output select is(pg_temp.result_count('01055551111'),0::bigint,'multiple active phone candidates are not selected');
insert into tap_output select is(pg_temp.result_count('first-google@example.invalid'),0::bigint,'multiple active Google candidates are not selected');
insert into tap_output select is(pg_temp.result_count('101'),1::bigint,'nickname and account ID match returns one canonical row');
insert into tap_output select is(pg_temp.result_count('current-google@example.invalid','active'),0::bigint,'existing status filter still excludes suspended match');
insert into tap_output select is(pg_temp.result_count('current-google@example.invalid','suspended'),1::bigint,'existing status filter includes matching suspended account');
insert into tap_output select is((select count(*) from public.admin_search_users('',null,1)),1::bigint,'existing result limit remains enforced');
insert into tap_output select is((select user_id from public.admin_search_users('복수',null,1)),pg_temp.uid(106),'existing created-at descending order remains unchanged');
insert into tap_output select ok((select row_to_json(found)::text not like '%821067891234%' and row_to_json(found)::text not like '%User.Example@Gmail.com%'
  from public.admin_search_users('01067891234',null,200) found),'search result shape does not expose phone or Google email columns');

insert into tap_output select * from finish();
select line from tap_output;
rollback;
