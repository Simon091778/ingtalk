begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(22);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('9c000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
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
create temporary table tap_output(line text);
grant all on pg_temp.tap_output to authenticated;

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at) values
  (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821066667777',now(),false,now(),now()),
  (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','821088889999',now(),false,now(),now()),
  (pg_temp.uid(90),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
  (pg_temp.uid(91),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now());
insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(90),'reviewer',true);
insert into account_private.device_accounts(id,auth_user_id) values
  (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(1)),
  (pg_temp.uid(103),pg_temp.uid(2)),(pg_temp.uid(104),pg_temp.uid(2));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values
  (pg_temp.uid(101),'과거번호계정',1990,'TEST','male'),
  (pg_temp.uid(102),'현재번호계정',1990,'TEST','female'),
  (pg_temp.uid(103),'번호이력없음',1990,'TEST','male'),
  (pg_temp.uid(104),'불명확번호',1990,'TEST','female');
update public.point_wallets set balance=700 where user_id=pg_temp.uid(101);
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash,linked_at)
values(pg_temp.uid(101),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'),'2026-08-28 05:32:00+00');

select account_private.retire_phone_identity(pg_temp.uid(101),account_private.identity_hash(pg_temp.uid(1),'phone'),'new_device_phone_reassignment');
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash,linked_at)
values(pg_temp.uid(102),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'),'2026-09-02 07:20:00+00');
insert into account_private.phone_identity_history(
  account_id,auth_user_id,identity_hash,retired_reason,retired_at,verified_at)
values(pg_temp.uid(104),pg_temp.uid(2),repeat('f',64),'identity_removed','2026-09-01 00:00:00+00','2026-08-01 00:00:00+00');

insert into tap_output select ok(not has_function_privilege('anon','public.admin_get_account_operations(uuid)','EXECUTE'),'anonymous cannot read phone history');
insert into tap_output select ok(not has_function_privilege('authenticated','account_private.admin_account_phone(uuid)','EXECUTE'),'authenticated cannot call private phone resolver');
insert into tap_output select ok(not has_function_privilege('authenticated','account_private.retire_phone_identity(uuid,text,text)','EXECUTE'),'ordinary user cannot mutate phone history');
insert into tap_output select ok(not has_table_privilege('authenticated','account_private.phone_identity_history','SELECT'),'ordinary user cannot read private phone history');
insert into tap_output select ok(not exists(select 1 from information_schema.columns where table_schema='account_private' and table_name='phone_identity_history' and column_name in ('phone','raw_phone')),'history stores no raw phone column');

set local role authenticated;
select pg_temp.login(91,'otp');
insert into tap_output select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(101))$$),'account_unlock_required','ordinary user cannot read detached phone');
select pg_temp.login(90);

insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,status}','detached','previous owner is reported as detached');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,phone}','821066667777','detached phone resolves only through exact Auth phone HMAC');
insert into tap_output select is((public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,verified_at}')::timestamptz,'2026-08-28 05:32:00+00'::timestamptz,'detached phone preserves original linked_at');
insert into tap_output select ok((public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,detached_at}')::timestamptz is not null,'detached phone includes retirement time');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,detach_reason}','new_device_phone_reassignment','detached phone includes exact reason');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(102))#>>'{phone,status}','active','new owner remains active');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(102))#>>'{phone,phone}','821066667777','new owner exposes the same current phone');
insert into tap_output select is((select user_id from public.admin_search_users('01066667777',null,200)),pg_temp.uid(102),'phone search returns only current active owner');
insert into tap_output select is((select count(*) from public.admin_search_users('01066667777',null,200)),1::bigint,'phone search does not include detached account');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(103))#>>'{phone,status}','none','account without phone history reports none');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{phone,status}','unavailable','mismatched historical hash is unavailable');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{phone,phone}',null,'unavailable history exposes no arbitrary phone');

reset role;
insert into tap_output select is((select count(*) from account_private.account_identities where provider='phone' and identity_hash=account_private.identity_hash(pg_temp.uid(1),'phone')),1::bigint,'phone has exactly one active owner');
insert into tap_output select is((select account_id from account_private.account_identities where provider='phone' and identity_hash=account_private.identity_hash(pg_temp.uid(1),'phone')),pg_temp.uid(102),'active owner is account B');
insert into tap_output select ok(not exists(select 1 from account_private.account_identities where account_id=pg_temp.uid(101) and provider='phone'),'historical row is not an active login identity');
insert into tap_output select is((select balance from public.point_wallets where user_id=pg_temp.uid(101)),700::bigint,'retiring phone leaves existing account assets unchanged');

insert into tap_output select * from finish();
select line from tap_output;
rollback;
