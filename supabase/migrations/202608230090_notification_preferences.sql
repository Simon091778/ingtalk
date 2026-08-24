create table if not exists public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  message_enabled boolean not null default true,
  request_enabled boolean not null default true,
  preview_enabled boolean not null default true,
  sound_enabled boolean not null default true,
  vibration_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
grant select, insert, update on public.notification_preferences to authenticated;

drop policy if exists "users manage own notification preferences" on public.notification_preferences;
create policy "users manage own notification preferences"
on public.notification_preferences for all to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

