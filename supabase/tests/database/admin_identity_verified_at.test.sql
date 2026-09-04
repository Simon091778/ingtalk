begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pgtap;
select plan(17);

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('99000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
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

drop index account_private.account_identities_one_social_provider_per_account;

insert into auth.users(id,instance_id,aud,role,email,email_confirmed_at,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
values
  (pg_temp.uid(1),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821077770001',now(),false,now(),now()),
  (pg_temp.uid(2),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','google-time@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(3),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(4),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','current-time@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(5),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','stale-time@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(6),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','first-time@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(7),'00000000-0000-0000-0000-000000000000','authenticated','authenticated','second-time@example.invalid',now(),null,null,false,now(),now()),
  (pg_temp.uid(8),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821077770008',now(),false,now(),now()),
  (pg_temp.uid(9),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,'+821077770009',now(),false,now(),now()),
  (pg_temp.uid(10),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(90),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now()),
  (pg_temp.uid(91),'00000000-0000-0000-0000-000000000000','authenticated','authenticated',null,null,null,null,false,now(),now());

insert into auth.identities(id,user_id,provider,provider_id,identity_data) values
  (gen_random_uuid(),pg_temp.uid(2),'google','time-google','{"sub":"time-google","email":"google-time@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(3),'kakao','99000003','{"sub":"99000003","provider_id":"99000003"}'),
  (gen_random_uuid(),pg_temp.uid(4),'google','time-current','{"sub":"time-current","email":"current-time@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(5),'google','time-stale','{"sub":"time-stale","email":"stale-time@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(6),'google','time-first','{"sub":"time-first","email":"first-time@example.invalid","email_verified":true}'),
  (gen_random_uuid(),pg_temp.uid(7),'google','time-second','{"sub":"time-second","email":"second-time@example.invalid","email_verified":true}');

insert into public.admin_users(user_id,role,is_active) values(pg_temp.uid(90),'reviewer',true);
insert into account_private.device_accounts(id,auth_user_id) values
  (pg_temp.uid(101),pg_temp.uid(1)),(pg_temp.uid(102),pg_temp.uid(2)),
  (pg_temp.uid(103),pg_temp.uid(3)),(pg_temp.uid(104),pg_temp.uid(4)),
  (pg_temp.uid(105),pg_temp.uid(6)),(pg_temp.uid(106),pg_temp.uid(8)),
  (pg_temp.uid(107),pg_temp.uid(10));
insert into public.profiles(id,nickname,birth_year,region_code,gender)
select pg_temp.uid(n),'인증시각'||n,1990,'TEST','male' from generate_series(101,107) n;

insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash,linked_at) values
  (pg_temp.uid(101),pg_temp.uid(1),'phone',account_private.identity_hash(pg_temp.uid(1),'phone'),'2026-09-02 05:32:10+00'),
  (pg_temp.uid(102),pg_temp.uid(2),'google',account_private.identity_hash(pg_temp.uid(2),'google'),'2026-09-01 11:15:22+00'),
  (pg_temp.uid(103),pg_temp.uid(3),'kakao',account_private.identity_hash(pg_temp.uid(3),'kakao'),'2026-08-31 09:47:03+00'),
  (pg_temp.uid(104),pg_temp.uid(4),'google',account_private.identity_hash(pg_temp.uid(4),'google'),'2026-08-30 01:02:03+00'),
  (pg_temp.uid(104),pg_temp.uid(5),'google',repeat('f',64),'2025-01-01 00:00:00+00'),
  (pg_temp.uid(105),pg_temp.uid(6),'google',account_private.identity_hash(pg_temp.uid(6),'google'),'2026-08-29 01:00:00+00'),
  (pg_temp.uid(105),pg_temp.uid(7),'google',account_private.identity_hash(pg_temp.uid(7),'google'),'2026-08-29 02:00:00+00'),
  (pg_temp.uid(106),pg_temp.uid(8),'phone',account_private.identity_hash(pg_temp.uid(8),'phone'),'2026-08-28 01:00:00+00'),
  (pg_temp.uid(106),pg_temp.uid(9),'phone',account_private.identity_hash(pg_temp.uid(9),'phone'),'2026-08-28 02:00:00+00');

insert into tap_output select ok(not has_function_privilege('authenticated','account_private.admin_account_kakao(uuid)','EXECUTE'),'authenticated cannot execute private Kakao resolver');
set local role authenticated;
select pg_temp.login(91,'otp');
insert into tap_output select is(pg_temp.error($$select public.admin_get_account_operations(pg_temp.uid(101))$$),'account_unlock_required','ordinary user cannot read provider timestamps');
select pg_temp.login(90);
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,phone}','+821077770001','phone identifier remains available');
insert into tap_output select is((public.admin_get_account_operations(pg_temp.uid(101))#>>'{phone,verified_at}')::timestamptz,'2026-09-02 05:32:10+00'::timestamptz,'phone uses active identity linked_at');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(102))#>>'{google,email}','google-time@example.invalid','Google email remains available');
insert into tap_output select is((public.admin_get_account_operations(pg_temp.uid(102))#>>'{google,verified_at}')::timestamptz,'2026-09-01 11:15:22+00'::timestamptz,'Google uses the same active identity linked_at');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(103))#>>'{kakao,status}','active','Kakao connection remains active');
insert into tap_output select is((public.admin_get_account_operations(pg_temp.uid(103))#>>'{kakao,verified_at}')::timestamptz,'2026-08-31 09:47:03+00'::timestamptz,'Kakao uses active identity linked_at');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(104))#>>'{google,email}','current-time@example.invalid','historical Google identity does not replace current identity');
insert into tap_output select is((public.admin_get_account_operations(pg_temp.uid(104))#>>'{google,verified_at}')::timestamptz,'2026-08-30 01:02:03+00'::timestamptz,'historical Google timestamp is not selected');
insert into tap_output select ok((public.admin_get_account_operations(pg_temp.uid(104))->'google')::text not like '%2025-01-01%','stale Google timestamp is not exposed by the Google resolver');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(105))#>>'{google,status}','unavailable','multiple active Google identities are unavailable');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(105))#>>'{google,verified_at}',null,'multiple Google timestamps are not selected');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(106))#>>'{phone,status}','unavailable','multiple active phone identities are unavailable');
insert into tap_output select is(public.admin_get_account_operations(pg_temp.uid(106))#>>'{phone,verified_at}',null,'multiple phone timestamps are not selected');
insert into tap_output select ok(public.admin_get_account_operations(pg_temp.uid(107))#>>'{phone,status}'='none'
  and public.admin_get_account_operations(pg_temp.uid(107))#>>'{google,status}'='none'
  and public.admin_get_account_operations(pg_temp.uid(107))#>>'{kakao,status}'='none','account without providers reports none');
insert into tap_output select ok(public.admin_get_account_operations(pg_temp.uid(107))#>>'{phone,verified_at}' is null
  and public.admin_get_account_operations(pg_temp.uid(107))#>>'{google,verified_at}' is null
  and public.admin_get_account_operations(pg_temp.uid(107))#>>'{kakao,verified_at}' is null,'account without providers exposes no timestamps');

insert into tap_output select * from finish();
select line from tap_output;
rollback;
