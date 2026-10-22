# GymCam Raspberry Pi camera control

This service replaces manual `/dev/videoN` and MediaMTX edits with the narrow API used by **Admin → Cameras**. It preserves existing MediaMTX paths, keeps timestamped backups, prefers `/dev/v4l/by-id`, validates the selected V4L2 mode, restarts MediaMTX, probes the resulting RTSP video, and rolls back on failure.

## Install or update on the Pi

Run these commands from a checkout of this repository on the Raspberry Pi. Replace the two placeholder values before enabling the service.

```bash
sudo install -d -m 0755 /opt/gymcam-control
sudo install -m 0755 pi/gymcam_control.py /opt/gymcam-control/gymcam_control.py
sudo install -m 0644 pi/requirements.txt /opt/gymcam-control/requirements.txt
sudo python3 -m venv /opt/gymcam-control/venv
sudo /opt/gymcam-control/venv/bin/pip install -r /opt/gymcam-control/requirements.txt
sudo install -d -m 0700 /var/lib/gymcam-control/backups
sudo install -m 0600 pi/gymcam-control.env.example /etc/gymcam-control.env
sudoedit /etc/gymcam-control.env
sudo install -m 0644 pi/gymcam-control.service /etc/systemd/system/gymcam-control.service
sudo systemctl daemon-reload
sudo systemctl enable --now gymcam-control
sudo systemctl status --no-pager gymcam-control
```

Set `GYMCAM_CONTROL_SECRET` to the same server-only value already configured as `GYMCAM_CONTROL_SECRET` in Vercel. Set `GYMCAM_GYM_ID` to the Supabase UUID for the gym attached to this Pi. Do not put either value in a `NEXT_PUBLIC_` variable.

The default service listens only on `127.0.0.1:8787`; keep the existing authenticated tunnel or reverse proxy pointed at that address. The website's server-side `GYMCAM_CONTROL_URL` should be the public base URL of that tunnel.

MediaMTX's API must be enabled on loopback so the admin page can distinguish a configured path from an active publisher:

```yaml
api: yes
apiAddress: 127.0.0.1:9997
```

If the MediaMTX service or config uses a different name/path, change `MEDIAMTX_SERVICE` and `MEDIAMTX_CONFIG` in `/etc/gymcam-control.env`, and update `ReadWritePaths` in the systemd unit for a non-default config path.

## One-time database step

Apply `supabase/migrations/202610220001_camera_physical_devices.sql` before using Scan Connected Cameras. It adds nullable physical-device metadata; existing cam1/cam2 rows continue to work unchanged.

## Safe verification

```bash
curl -fsS -H "X-GymCam-Secret: $GYMCAM_CONTROL_SECRET" \
  "http://127.0.0.1:8787/cameras?gymId=$GYMCAM_GYM_ID" | python3 -m json.tool
```

The API never accepts a command string. The only subprocesses are fixed `v4l2-ctl`, `systemctl`, and `ffprobe` calls. MediaMTX receives a generated FFmpeg command whose device and stream values were selected from detected devices and strictly validated.
