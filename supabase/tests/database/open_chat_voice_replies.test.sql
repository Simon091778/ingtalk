begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pgtap;
select plan(31);

insert into auth.users(id,instance_id,aud,role,phone,phone_confirmed_at,is_anonymous,created_at,updated_at)
select ('95000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  '82109500000'||n,now(),false,now(),now() from generate_series(1,3) n;
insert into account_private.device_accounts(id,auth_user_id,phone_hash,device_hash)
select ('15000000-0000-4000-8000-00000000000'||n)::uuid,('95000000-0000-4000-8000-00000000000'||n)::uuid,
  account_private.hash_phone('82109500000'||n),repeat((n+5)::text,64) from generate_series(1,3) n;
update account_private.device_accounts set device_scope_hash=device_hash where id::text like '15000000-0000-4000-8000-%';
insert into account_private.account_identities(account_id,auth_user_id,provider,identity_hash)
select id,auth_user_id,auth_provider,phone_hash from account_private.device_accounts where id::text like '15000000-0000-4000-8000-%';
insert into public.profiles(id,nickname,birth_year,region_code,gender,interests)
select ('15000000-0000-4000-8000-00000000000'||n)::uuid,'음성톡'||n,1990,'TEST','male',array['대화'] from generate_series(1,3) n;
insert into auth.sessions(id,user_id)
select ('25000000-0000-4000-8000-00000000000'||n)::uuid,('95000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.sessions(session_id,user_id,account_id)
select ('25000000-0000-4000-8000-00000000000'||n)::uuid,('95000000-0000-4000-8000-00000000000'||n)::uuid,
 ('15000000-0000-4000-8000-00000000000'||n)::uuid from generate_series(1,3) n;
insert into account_private.account_devices(account_id,device_hash,device_scope_hash,platform,is_primary)
select id,device_hash,device_scope_hash,'web',true from account_private.device_accounts where id::text like '15000000-0000-4000-8000-%';
update account_private.sessions session set device_id=device.id
from account_private.account_devices device where device.account_id=session.account_id and device.is_primary
  and session.account_id::text like '15000000-0000-4000-8000-%';
update public.point_wallets set balance=1000 where user_id::text like '15000000-0000-4000-8000-%';

create temporary table open_chat_voice_state(name text primary key, value text);
grant all on table open_chat_voice_state to authenticated;
create or replace function pg_temp.run_error(statement text)
returns text language plpgsql as $$
begin execute statement; return null; exception when others then return sqlerrm; end;
$$;

select ok(not public, 'open-chat audio bucket is private')
from storage.buckets where id = 'open-chat-audio';
select is(file_size_limit, 1048576::bigint, 'open-chat audio bucket has a one MiB server limit')
from storage.buckets where id = 'open-chat-audio';
select ok(not public, 'open-chat image bucket is private')
from storage.buckets where id = 'open-chat-images';
select is(file_size_limit, 8388608::bigint, 'open-chat image bucket has an eight MiB server limit')
from storage.buckets where id = 'open-chat-images';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}', true);
insert into open_chat_voice_state values (
  'room1', public.create_open_chat_room('음성 답장방','보안 테스트','수다',5,null,'{}')::text
);
select lives_ok($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room1'),'text',' 첫 메시지 ',null,null,null
)$$, 'member sends text through the authoritative RPC');
insert into open_chat_voice_state
select 'text1', max(id)::text from public.open_chat_messages
where room_id=(select value::uuid from open_chat_voice_state where name='room1') and message_type='text';
select is((select content from public.open_chat_messages where id=(select value::bigint from open_chat_voice_state where name='text1')),
  '첫 메시지', 'text RPC trims content');
select lives_ok($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room1'),'text','답장',null,null,
  (select value::bigint from open_chat_voice_state where name='text1')
)$$, 'member creates a reply');
select is((select reply_to_room_id from public.open_chat_messages where content='답장'),
  (select value::uuid from open_chat_voice_state where name='room1'), 'reply stores its authoritative room identity');

select is(pg_temp.run_error($$select public.create_open_chat_image_message(
  (select value::uuid from open_chat_voice_state where name='room1'),
  (select value from open_chat_voice_state where name='room1')||'/15000000-0000-4000-8000-000000000001/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg',
  1200,900,'사진 설명',null
)$$), 'image_not_uploaded', 'image metadata cannot be inserted before its object exists');
insert into storage.objects(bucket_id,name) select 'open-chat-images',
  value||'/15000000-0000-4000-8000-000000000001/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg'
from open_chat_voice_state where name='room1';
select is((select count(*) from storage.objects where bucket_id='open-chat-images'), 1::bigint,
  'member uploads an image only into their account path');
select lives_ok($$select public.create_open_chat_image_message(
  (select value::uuid from open_chat_voice_state where name='room1'),
  (select value from open_chat_voice_state where name='room1')||'/15000000-0000-4000-8000-000000000001/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg',
  1200,900,'사진 설명',
  (select value::bigint from open_chat_voice_state where name='text1')
)$$, 'member sends a private image with a caption and reply');
select results_eq(
  $$select message_type,content,image_width,image_height from public.open_chat_messages where message_type='image'$$,
  $$values ('image'::text,'사진 설명'::text,1200,900)$$,
  'image message stores typed metadata and caption');
select is((select reply_to_room_id from public.open_chat_messages where message_type='image'),
  (select value::uuid from open_chat_voice_state where name='room1'), 'image reply retains its room identity');

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000003"}', true);
insert into open_chat_voice_state values (
  'room2', public.create_open_chat_room('다른 답장방','교차 방 테스트','취미',5,null,'{}')::text
);
select is(pg_temp.run_error($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room2'),'text','교차 답장',null,null,
  (select value::bigint from open_chat_voice_state where name='text1')
)$$), 'invalid_reply_target', 'reply target must belong to the same room');

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000001"}', true);
select is(pg_temp.run_error($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room1'),'audio',null,
  (select value from open_chat_voice_state where name='room1')||'/15000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.m4a',1000,null
)$$), 'audio_not_uploaded', 'audio metadata cannot be inserted before its object exists');

insert into storage.objects(bucket_id,name) select 'open-chat-audio',
  value||'/15000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.m4a'
from open_chat_voice_state where name='room1';
select is((select count(*) from storage.objects where bucket_id='open-chat-audio'), 1::bigint,
  'member uploads only into their account path');
select alike(pg_temp.run_error($$insert into storage.objects(bucket_id,name) select 'open-chat-audio',
  value||'/15000000-0000-4000-8000-000000000002/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.m4a'
  from open_chat_voice_state where name='room1'$$), '%row-level security%', 'member cannot spoof another account path');
select lives_ok($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room1'),'audio',null,
  (select value from open_chat_voice_state where name='room1')||'/15000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.m4a',30000,
  (select value::bigint from open_chat_voice_state where name='text1')
)$$, 'uploaded 30 second audio is accepted with a reply');
select is((select audio_duration_ms from public.open_chat_messages where message_type='audio'), 30000,
  'audio duration is stored as typed metadata');
select is(pg_temp.run_error($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room1'),'audio',null,
  (select value from open_chat_voice_state where name='room1')||'/15000000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.m4a',30001,null
)$$), 'invalid_audio_metadata', 'server rejects audio over 30 seconds');
select alike(pg_temp.run_error($$insert into public.open_chat_messages(
  room_id,sender_user_id,message_type,content,audio_storage_path,audio_duration_ms
) values (
  (select value::uuid from open_chat_voice_state where name='room1'),'15000000-0000-4000-8000-000000000001','audio',null,
  (select value from open_chat_voice_state where name='room1')||'/15000000-0000-4000-8000-000000000001/cccccccc-cccc-4ccc-8ccc-cccccccccccc.m4a',1000
)$$), '%row-level security%', 'clients cannot bypass the audio RPC with a direct insert');

select set_config('request.jwt.claims', '{"sub":"95000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"25000000-0000-4000-8000-000000000002"}', true);
select is(pg_temp.run_error($$select public.create_open_chat_message(
  (select value::uuid from open_chat_voice_state where name='room1'),'text','침입',null,null,null
)$$), 'room_access_required', 'non-member cannot send through the RPC');
select is((select count(*) from storage.objects where bucket_id='open-chat-audio'), 0::bigint,
  'non-member cannot read room audio');
select is((select count(*) from storage.objects where bucket_id='open-chat-images'), 0::bigint,
  'non-member cannot read room images');
select alike(pg_temp.run_error($$insert into storage.objects(bucket_id,name) select 'open-chat-audio',
  value||'/15000000-0000-4000-8000-000000000002/dddddddd-dddd-4ddd-8ddd-dddddddddddd.m4a'
  from open_chat_voice_state where name='room1'$$), '%row-level security%', 'non-member cannot upload room audio');
select alike(pg_temp.run_error($$insert into storage.objects(bucket_id,name) select 'open-chat-images',
  value||'/15000000-0000-4000-8000-000000000002/ffffffff-ffff-4fff-8fff-ffffffffffff.jpg'
  from open_chat_voice_state where name='room1'$$), '%row-level security%', 'non-member cannot upload room images');
select lives_ok($$select public.join_open_chat_room((select value::uuid from open_chat_voice_state where name='room1'))$$,
  'second account joins the room');
select is((select count(*) from storage.objects where bucket_id='open-chat-audio'), 1::bigint,
  'active member can read existing private audio');
select is((select count(*) from storage.objects where bucket_id='open-chat-images'), 1::bigint,
  'active member can read existing private images');
select lives_ok($$select public.report_open_chat(
  'open_chat_message',(select value::uuid from open_chat_voice_state where name='room1'),null,
  (select id from public.open_chat_messages where message_type='audio'),'abuse','음성 신고 테스트'
)$$, 'active member can report an audio message');
reset role;
select is((select (content_snapshot->>'audio_duration_ms')::integer from public.reports where target_type='open_chat_message'),
  30000, 'audio report snapshot retains typed attachment metadata');

select * from finish();
rollback;
