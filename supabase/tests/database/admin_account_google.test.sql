begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(18);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('98000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
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

-- Drop only inside this rolled-back test so historical/corrupt duplicate rows
-- can prove that the resolver never chooses an arbitrary Google identity.
drop index account_private.account_identities_one_social_provider_per_account;

insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
values
  (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-google-1@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821066660002',now(),false,now(),now()),
  (pg_temp.uid(3),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-google-3@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(4),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(5),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-google-5@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(6),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821066660006',now(),false,now(),now()),
  (pg_temp.uid(7),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-current@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(8),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-stale@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(9),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-first@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(10),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','auth-second@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(90),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(91),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now());

insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
  (gen_random_uuid(),pg_temp.uid(1),'google','admin-google-1','{"sub":"admin-google-1","email":"google-only@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(3),'google','admin-google-3','{"sub":"admin-google-3","email":"phone-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(4),'kakao','88000004','{"sub":"88000004","provider_id":"88000004"}'),
  (gen_random_uuid(),pg_temp.uid(5),'google','admin-google-5','{"sub":"admin-google-5","email":"kakao-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(7),'google','admin-google-current','{"sub":"admin-google-current","email":"current-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(8),'google','admin-google-stale','{"sub":"admin-google-stale","email":"stale-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(9),'google','admin-google-first','{"sub":"admin-google-first","email":"first-google@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(10),'google','admin-google-second','{"sub":"admin-google-second","email":"second-google@example.invalid","email_verified":true}');

insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(90),'reviewer',true);
insert into account_private.device_accounts(id,auth_user_id) values
  (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(2)),
  (pg_temp.uid(103),pg_temp.uid(4)),(pg_temp.uid(104),pg_temp.uid(6)),
  (pg_temp.uid(105),pg_temp.uid(7)),(pg_temp.uid(106),pg_temp.uid(9));
insert into public.profiles(id,nickname,birth_year,region_code,gender)
select pg_temp.uid(n),'구글관리'||n,1990,'TEST','male' from generate_series(101,106) n;

insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash) values
  (pg_temp.uid(101),pg_temp.uid(1),'google',account_private.identity_hash(pg_temp.uid(1),'google')),
  (pg_temp.uid(102),pg_temp.uid(2),'phone',account_private.identity_hash(pg_temp.uid(2),'phone')),
  (pg_temp.uid(102),pg_temp.uid(3),'google',account_private.identity_hash(pg_temp.uid(3),'google')),
  (pg_temp.uid(103),pg_temp.uid(4),'kakao',account_private.identity_hash(pg_temp.uid(4),'kakao')),
  (pg_temp.uid(103),pg_temp.uid(5),'google',account_private.identity_hash(pg_temp.uid(5),'google')),
  (pg_temp.uid(104),pg_temp.uid(6),'phone',account_private.identity_hash(pg_temp.uid(6),'phone')),
  (pg_temp.uid(105),pg_temp.uid(7),'google',account_private.identity_hash(pg_temp.uid(7),'google')),
  (pg_temp.uid(105),pg_temp.uid(8),'google',repeat('f',64)),
  (pg_temp.uid(106),pg_temp.uid(9),'google',account_private.identity_hash(pg_temp.uid(9),'google')),
  (pg_temp.uid(106),pg_temp.uid(10),'google',account_private.identity_hash(pg_temp.uid(10),'google'));

insert into tap_output select ok(not has_function_privilege('anon','public.admin_get_account_operations(uuid)','EXECUTE'),'anonymous cannot execute admin account lookup');
insert into tap_output select ok(not has_function_privilege('authenticated','account_private.admin_account_google(uuid)','EXECUTE'),'authenticated cannot execute private Google resolver');
insert into tap_output select ok(not has_table_privilege('authenticated','auth.users','SELECT'),'authenticated cannot read Auth users');
insert into tap_output select ok(not has_table_privilege('authenticated','auth.identities','SELECT'),'authenticated cannot read Auth identities');

set local role authenticated;
select pg_temp.login(91,'otp');
insert into tap_output select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(101))$$),'account_unlock_required','ordinary user denied by the existing admin account gate');
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
insert into tap_output select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(101))$$),'account_unlock_required','logged out caller denied by the existing admin account gate');

select pg_temp.login(90);
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{google,status}','active','Google-only account reports active Google');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{google,email}','google-only@example.invalid','Google-only account returns provider identity email, not Auth user fallback');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(102))#>>'{phone,phone}','+821066660002','phone plus Google retains authoritative phone');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(102))#>>'{google,email}','phone-google@example.invalid','phone plus Google returns Google email');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(103))#>>'{google,email}','kakao-google@example.invalid','Kakao plus Google returns Google email');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{google,status}','none','account without Google reports none');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{google,email}',null,'account without Google returns no email');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(105))#>>'{google,email}','current-google@example.invalid','current active Google wins over stale historical mapping');
insert into tap_output select ok(public.admin_get_account_operations(pg_temp.uid(105))::text not like '%stale-google@example.invalid%','stale Google email is not exposed');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(106))#>>'{google,status}','unavailable','multiple active Google candidates are not selected arbitrarily');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(106))#>>'{google,email}',null,'ambiguous Google account exposes no email');
insert into tap_output select ok(public.admin_get_account_operations(pg_temp.uid(101))::text not like '%auth-google-1@example.invalid%','Auth user fallback email is not exposed');

insert into tap_output select * from finish();
select line from tap_output;
rollback;
