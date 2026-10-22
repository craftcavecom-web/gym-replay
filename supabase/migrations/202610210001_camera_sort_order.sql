-- Camera order is gym-local. Existing cameras retain their creation order.
alter table public.cameras
  add column if not exists sort_order integer;

with ordered_cameras as (
  select id, row_number() over (partition by gym_id order by created_at, id) - 1 as position
  from public.cameras
)
update public.cameras
set sort_order = ordered_cameras.position
from ordered_cameras
where public.cameras.id = ordered_cameras.id
  and public.cameras.sort_order is null;

alter table public.cameras
  alter column sort_order set default 0;

create index if not exists cameras_gym_sort_order_idx
  on public.cameras (gym_id, sort_order, created_at);
