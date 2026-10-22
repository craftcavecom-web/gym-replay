-- A camera row remains the GymCam source of truth. These optional fields link it
-- to a stable physical USB device managed by the Raspberry Pi.
alter table public.cameras
  add column if not exists device_id text,
  add column if not exists device_path text;

create unique index if not exists cameras_gym_device_id_idx
  on public.cameras (gym_id, device_id)
  where device_id is not null;

comment on column public.cameras.device_id is
  'Stable Raspberry Pi camera identifier, normally a /dev/v4l/by-id path.';

comment on column public.cameras.device_path is
  'Last observed /dev/videoN mapping for display and diagnostics only.';
