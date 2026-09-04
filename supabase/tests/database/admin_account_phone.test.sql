begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(15);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
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

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
values
  (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055550001',now(),false,now(),now()),
  (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055550002',now(),false,now(),now()),
  (pg_temp.uid(3),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
  (pg_temp.uid(4),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055550003',now(),false,now(),now()),
  (pg_temp.uid(5),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
  (pg_temp.uid(6),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
  (pg_temp.uid(7),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055559997',now(),false,now(),now()),
  (pg_temp.uid(8),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055559998',now(),false,now(),now()),
  (pg_temp.uid(9),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055550004',now(),false,now(),now()),
  (pg_temp.uid(10),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055550005',now(),false,now(),now()),
  (pg_temp.uid(11),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','+821055550006',now(),false,now(),now()),
  (pg_temp.uid(90),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now()),
  (pg_temp.uid(91),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,false,now(),now());

insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(90),'reviewer',true);
insert into account_private.device_accounts(id,auth_user_id) values
  (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(2)),
  (pg_temp.uid(103),pg_temp.uid(4)),(pg_temp.uid(104),pg_temp.uid(6)),
  (pg_temp.uid(105),pg_temp.uid(9)),(pg_temp.uid(106),pg_temp.uid(8)),
  (pg_temp.uid(107),pg_temp.uid(10));
insert into public.profiles(id,nickname,birth_year,region_code,gender) values
  (pg_temp.uid(101),'번호전용',1990,'TEST','male'),
  (pg_temp.uid(102),'구글번호',1990,'TEST','female'),
  (pg_temp.uid(103),'카카오번호',1990,'TEST','female'),
  (pg_temp.uid(104),'소셜전용',1990,'TEST','male'),
  (pg_temp.uid(105),'번호교체',1990,'TEST','male'),
  (pg_temp.uid(106),'연결오류',1990,'TEST','male'),
  (pg_temp.uid(107),'복수후보',1990,'TEST','female');

insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values
  (pg_temp.uid(101),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone')),
  (pg_temp.uid(102),pg_temp.uid(2),'phone',account_private.identity_hash(pg_temp.uid(2),'phone')),
  (pg_temp.uid(102),pg_temp.uid(3),'google',repeat('a',64)),
  (pg_temp.uid(103),pg_temp.uid(4),'phone',account_private.identity_hash(pg_temp.uid(4),'phone')),
  (pg_temp.uid(103),pg_temp.uid(5),'kakao',repeat('b',64)),
  (pg_temp.uid(104),pg_temp.uid(6),'google',repeat('c',64)),
  (pg_temp.uid(105),pg_temp.uid(9),'phone',account_private.identity_hash(pg_temp.uid(9),'phone')),
  (pg_temp.uid(106),pg_temp.uid(8),'phone',account_private.hash_phone('+821055559000')),
  (pg_temp.uid(107),pg_temp.uid(10),'phone',account_private.identity_hash(pg_temp.uid(10),'phone')),
  (pg_temp.uid(107),pg_temp.uid(11),'phone',account_private.identity_hash(pg_temp.uid(11),'phone'));
insert into account_private.phone_identity_history(account_id,auth_user_id,identity_hash,retired_reason)
values(pg_temp.uid(105),pg_temp.uid(7),account_private.identity_hash(pg_temp.uid(7),'phone'),'test_rotation');

insert into tap_output select ok(not has_function_privilege('anon','public.admin_get_account_operations(uuid)','EXECUTE'),'anonymous cannot execute admin account lookup');
insert into tap_output select ok(not has_function_privilege('authenticated','account_private.admin_account_phone(uuid)','EXECUTE'),'authenticated cannot execute private phone resolver');

set local role authenticated;
select pg_temp.login(91,'otp');
insert into tap_output select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(101))$$),'account_unlock_required','ordinary user denied by the existing admin account gate');
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
insert into tap_output select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(101))$$),'account_unlock_required','logged out caller denied by the existing admin account gate');

select pg_temp.login(90);
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,status}','active','phone-only account has active phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,phone}','+821055550001','phone-only account returns authoritative raw phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(102))#>>'{phone,phone}','+821055550002','Google plus phone returns current phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(103))#>>'{phone,phone}','+821055550003','Kakao plus phone returns current phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{phone,status}','none','social-only account reports no phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{phone,phone}',null,'social-only account returns no raw phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(105))#>>'{phone,phone}','+821055550004','current phone wins over retired history');
insert into tap_output select ok(public.admin_get_account_operations(pg_temp.uid(105))::text not like '%+821055559997%','retired phone is not exposed');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(106))#>>'{phone,status}','unavailable','stale identity is not treated as current');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(107))#>>'{phone,status}','unavailable','multiple active candidates are not selected arbitrarily');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(107))#>>'{phone,phone}',null,'ambiguous account exposes no raw phone');

insert into tap_output select * from finish();
select line from tap_output;
rollback;
