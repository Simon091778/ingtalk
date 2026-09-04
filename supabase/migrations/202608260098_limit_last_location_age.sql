-- Only expose a recent server-verified location for conversation-card publishing.

create or replace function public.my_last_location()
returns table (
  latitude double precision,
  longitude double precision,
  accuracy_meters real,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    extensions.st_y(location.position::extensions.geometry) as latitude,
    extensions.st_x(location.position::extensions.geometry) as longitude,
    location.accuracy_meters,
    location.updated_at
  from public.user_locations location
  where location.user_id = auth.uid()
    and location.updated_at >= now() - interval '1 hour'
  limit 1;
$$;

revoke all on function public.my_last_location() from public, anon;
grant execute on function public.my_last_location() to authenticated;

notify pgrst, 'reload schema';
