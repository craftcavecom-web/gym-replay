#!/usr/bin/env python3
"""Narrow, authenticated GymCam Raspberry Pi control API.

This service intentionally has no arbitrary command endpoint. It detects external
V4L2 cameras, chooses a supported format, updates one MediaMTX path atomically,
and rolls back if MediaMTX or the resulting RTSP stream is unhealthy.
"""

from __future__ import annotations

import glob
import hmac
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import yaml


SECRET = os.environ.get("GYMCAM_CONTROL_SECRET", "")
GYM_ID = os.environ.get("GYMCAM_GYM_ID", "")
LISTEN_HOST = os.environ.get("GYMCAM_CONTROL_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("GYMCAM_CONTROL_PORT", "8787"))
MEDIAMTX_CONFIG = Path(os.environ.get("MEDIAMTX_CONFIG", "/etc/mediamtx.yml"))
MEDIAMTX_SERVICE = os.environ.get("MEDIAMTX_SERVICE", "mediamtx")
STREAM_SERVICE = os.environ.get("GYMCAM_STREAM_SERVICE", MEDIAMTX_SERVICE)
MEDIAMTX_API = os.environ.get("MEDIAMTX_API", "http://127.0.0.1:9997").rstrip("/")
RTSP_BASE = os.environ.get("MEDIAMTX_RTSP_BASE", "rtsp://127.0.0.1:8554").rstrip("/")
ASSIGNMENTS_FILE = Path(os.environ.get("GYMCAM_CAMERA_ASSIGNMENTS", "/var/lib/gymcam-control/cameras.json"))
BACKUP_DIR = Path(os.environ.get("GYMCAM_MEDIAMTX_BACKUPS", "/var/lib/gymcam-control/backups"))
STREAM_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
INTERNAL_NAMES = ("pisp", "rpi-hevc", "bcm2835-codec", "unicam", "rpivid")


class CameraError(RuntimeError):
    pass


def run(args: list[str], timeout: int = 15, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run one allow-listed executable without a shell."""
    allowed = {"v4l2-ctl", "systemctl", "ffprobe"}
    if not args or Path(args[0]).name not in allowed:
        raise CameraError("Internal command is not allowed")
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=check)


def device_name(device_path: str) -> str:
    sys_name = Path("/sys/class/video4linux") / Path(device_path).name / "name"
    try:
        return sys_name.read_text(encoding="utf-8").strip()
    except OSError:
        return Path(device_path).name


def is_external_camera(device_path: str) -> bool:
    match = re.fullmatch(r"/dev/video(\d+)", device_path)
    if not match or int(match.group(1)) >= 20:
        return False
    name = device_name(device_path).lower()
    return not any(internal in name for internal in INTERNAL_NAMES)


def symlink_index(pattern: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for link_name in sorted(glob.glob(pattern)):
        try:
            resolved = str(Path(link_name).resolve(strict=True))
        except OSError:
            continue
        if is_external_camera(resolved):
            result.setdefault(resolved, link_name)
    return result


def parse_capabilities(device_id: str) -> list[dict[str, Any]]:
    try:
        output = run(["v4l2-ctl", "--list-formats-ext", "-d", device_id], timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    formats: list[dict[str, Any]] = []
    current_format: dict[str, Any] | None = None
    current_resolution: dict[str, Any] | None = None
    for raw_line in output.splitlines():
        line = raw_line.strip()
        format_match = re.match(r"\[\d+\]:\s+'([^']+)'\s+\((.+)\)", line)
        if format_match:
            current_format = {
                "pixelFormat": format_match.group(1).upper(),
                "description": format_match.group(2),
                "resolutions": [],
            }
            formats.append(current_format)
            current_resolution = None
            continue
        size_match = re.match(r"Size:\s+Discrete\s+(\d+)x(\d+)", line)
        if size_match and current_format:
            current_resolution = {
                "width": int(size_match.group(1)),
                "height": int(size_match.group(2)),
                "fps": [],
            }
            current_format["resolutions"].append(current_resolution)
            continue
        fps_match = re.search(r"\(([0-9.]+)\s+fps\)", line)
        if fps_match and current_resolution:
            fps = round(float(fps_match.group(1)), 3)
            if fps not in current_resolution["fps"]:
                current_resolution["fps"].append(fps)
    return formats


def choose_format(formats: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    codec_score = {"H264": 35, "MJPG": 25, "MJPEG": 25, "YUYV": 5, "YUY2": 5}
    for item in formats:
        pixel_format = str(item.get("pixelFormat", "")).upper()
        for resolution in item.get("resolutions", []):
            width = int(resolution.get("width", 0))
            height = int(resolution.get("height", 0))
            for fps_value in resolution.get("fps", []) or [30]:
                fps = float(fps_value)
                exact_hd = 100 if (width, height) == (1920, 1080) else 0
                usable_fps = 40 if fps >= 30 else fps
                size_score = min(width * height / (1920 * 1080), 1) * 30
                score = exact_hd + usable_fps + size_score + codec_score.get(pixel_format, 0)
                candidates.append({
                    "pixelFormat": pixel_format,
                    "width": width,
                    "height": height,
                    "fps": int(fps) if fps.is_integer() else fps,
                    "_score": score,
                })
    if not candidates:
        return None
    selected = max(candidates, key=lambda item: item["_score"])
    selected.pop("_score", None)
    return selected


def load_assignments() -> dict[str, dict[str, Any]]:
    try:
        raw = json.loads(ASSIGNMENTS_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_assignments(assignments: dict[str, dict[str, Any]]) -> None:
    ASSIGNMENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=ASSIGNMENTS_FILE.parent, delete=False) as handle:
        json.dump(assignments, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    os.chmod(temporary, 0o600)
    os.replace(temporary, ASSIGNMENTS_FILE)


def read_config() -> tuple[bytes, dict[str, Any]]:
    raw = MEDIAMTX_CONFIG.read_bytes()
    parsed = yaml.safe_load(raw) or {}
    if not isinstance(parsed, dict):
        raise CameraError("MediaMTX configuration root is invalid")
    paths = parsed.setdefault("paths", {})
    if not isinstance(paths, dict):
        raise CameraError("MediaMTX paths configuration is invalid")
    return raw, parsed


def backup_config(raw: bytes) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_DIR / f"mediamtx-{stamp}.yml"
    suffix = 1
    while backup.exists():
        backup = BACKUP_DIR / f"mediamtx-{stamp}-{suffix}.yml"
        suffix += 1
    backup.write_bytes(raw)
    os.chmod(backup, 0o600)
    return backup


def write_config(config: dict[str, Any]) -> None:
    rendered = yaml.safe_dump(config, sort_keys=False, default_flow_style=False).encode("utf-8")
    # Parse our output before it can replace the working file.
    validated = yaml.safe_load(rendered)
    if not isinstance(validated, dict) or not isinstance(validated.get("paths"), dict):
        raise CameraError("Generated MediaMTX configuration did not validate")
    with tempfile.NamedTemporaryFile("wb", dir=MEDIAMTX_CONFIG.parent, delete=False) as handle:
        handle.write(rendered)
        handle.flush()
        os.fsync(handle.fileno())
        temporary = Path(handle.name)
    shutil.copymode(MEDIAMTX_CONFIG, temporary)
    os.replace(temporary, MEDIAMTX_CONFIG)


def restart_mediamtx() -> None:
    try:
        run(["systemctl", "restart", MEDIAMTX_SERVICE], timeout=30)
        run(["systemctl", "is-active", "--quiet", MEDIAMTX_SERVICE], timeout=10)
    except (OSError, subprocess.SubprocessError) as error:
        raise CameraError("MediaMTX did not restart cleanly") from error


def path_status(stream_path: str) -> dict[str, Any]:
    configured = False
    try:
        _, config = read_config()
        configured = stream_path in config["paths"]
    except (OSError, CameraError, yaml.YAMLError):
        pass
    try:
        encoded = urllib.parse.quote(stream_path, safe="")
        with urllib.request.urlopen(f"{MEDIAMTX_API}/v3/paths/get/{encoded}", timeout=3) as response:
            payload = json.load(response)
        ready = bool(payload.get("ready"))
        readers = payload.get("readers") or []
        return {"configured": True, "streaming": ready, "healthy": ready, "readers": len(readers)}
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        return {"configured": configured, "streaming": False, "healthy": False, "readers": 0}


def verify_stream(stream_path: str) -> dict[str, Any]:
    target = f"{RTSP_BASE}/{stream_path}"
    try:
        result = run([
            "ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,avg_frame_rate", "-of", "json", target,
        ], timeout=35)
        payload = json.loads(result.stdout)
        streams = payload.get("streams") or []
        if not streams:
            raise CameraError("No video stream was detected")
        return streams[0]
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise CameraError("The configured camera did not produce a healthy stream") from error


def build_run_on_demand(device_id: str, stream_path: str, selected: dict[str, Any]) -> str:
    pixel_format = str(selected["pixelFormat"]).upper()
    ffmpeg_format = {"MJPG": "mjpeg", "MJPEG": "mjpeg", "YUYV": "yuyv422", "YUY2": "yuyv422"}.get(pixel_format, pixel_format.lower())
    width = int(selected["width"])
    height = int(selected["height"])
    fps = selected["fps"]
    args = [
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-f", "v4l2",
        "-input_format", ffmpeg_format, "-framerate", str(fps),
        "-video_size", f"{width}x{height}", "-i", device_id, "-an",
    ]
    if pixel_format == "H264":
        args += ["-c:v", "copy"]
    else:
        args += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"]
    args += ["-f", "rtsp", "-rtsp_transport", "tcp", f"{RTSP_BASE}/{stream_path}"]
    return " ".join(shlex.quote(value) for value in args)


def detect_cameras() -> list[dict[str, Any]]:
    by_id = symlink_index("/dev/v4l/by-id/*-video-index0")
    by_path = symlink_index("/dev/v4l/by-path/*-video-index0")
    assignments = load_assignments()
    assignment_by_device = {str(value.get("deviceId")): value for value in assignments.values()}
    try:
        _, media_config = read_config()
        configured_paths = media_config["paths"]
    except (OSError, CameraError, yaml.YAMLError):
        configured_paths = {}
    devices: list[dict[str, Any]] = []

    candidates = sorted(set(by_id) | set(by_path))
    for fallback in sorted(glob.glob("/dev/video[0-9]*")):
        try:
            resolved = str(Path(fallback).resolve(strict=True))
        except OSError:
            continue
        if is_external_camera(resolved) and resolved not in candidates:
            candidates.append(resolved)

    for resolved in candidates:
        stable = by_id.get(resolved) or by_path.get(resolved)
        camera_id = stable or f"unstable:{resolved}"
        formats = parse_capabilities(camera_id if stable else resolved)
        assignment = assignment_by_device.get(camera_id)
        if not assignment:
            for path_name, path_config in configured_paths.items():
                command = path_config.get("runOnDemand", "") if isinstance(path_config, dict) else ""
                if isinstance(command, str) and (camera_id in command or resolved in command):
                    assignment = {"gymId": GYM_ID, "streamPath": str(path_name), "deviceId": camera_id}
                    break
        status = path_status(str(assignment.get("streamPath"))) if assignment else {
            "configured": False, "streaming": False, "healthy": False, "readers": 0,
        }
        devices.append({
            "id": camera_id,
            "name": device_name(resolved),
            "stablePath": stable,
            "devicePath": resolved,
            "connected": True,
            "ambiguous": not bool(by_id.get(resolved)),
            "formats": formats,
            "preferred": choose_format(formats),
            "assignment": ({"gymId": assignment.get("gymId"), "streamPath": assignment.get("streamPath")} if assignment else None),
            "mediaMtxConfigured": status["configured"],
            "streaming": status["streaming"],
            "healthy": status["healthy"],
            "healthMessage": "Publisher active" if status["healthy"] else "Idle or not currently publishing",
        })
    return devices


def require_gym(value: Any) -> str:
    gym_id = value if isinstance(value, str) else ""
    if not gym_id or gym_id != GYM_ID:
        raise CameraError("This Raspberry Pi is not assigned to that gym")
    return gym_id


def configure_camera(body: dict[str, Any]) -> dict[str, Any]:
    gym_id = require_gym(body.get("gymId"))
    raw_device_id = body.get("deviceId")
    raw_stream_path = body.get("streamPath")
    device_id = raw_device_id if isinstance(raw_device_id, str) else ""
    stream_path = raw_stream_path if isinstance(raw_stream_path, str) else ""
    if not STREAM_RE.fullmatch(stream_path):
        raise CameraError("Invalid stream path")

    devices = {device["id"]: device for device in detect_cameras()}
    device = devices.get(device_id)
    if not device or not device["connected"]:
        raise CameraError("The selected USB camera is not connected")
    if device["ambiguous"] and device["stablePath"] is None:
        raise CameraError("This camera has no stable device path; create a udev link before configuring it")
    selected = device.get("preferred")
    if not selected:
        raise CameraError("No supported V4L2 streaming format was detected")

    raw, config = read_config()
    backup = backup_config(raw)
    assignments = load_assignments()
    old_assignments = json.loads(json.dumps(assignments))
    old_for_path = assignments.get(stream_path)

    for existing_path, path_config in config["paths"].items():
        if existing_path == stream_path or not isinstance(path_config, dict):
            continue
        command = path_config.get("runOnDemand", "")
        if isinstance(command, str) and (device_id in command or device["devicePath"] in command):
            raise CameraError(f"That physical camera is already used by {existing_path}")

    for existing_path, assignment in assignments.items():
        if existing_path != stream_path and assignment.get("deviceId") == device_id:
            raise CameraError(f"That physical camera is already assigned to {existing_path}")

    config["paths"][stream_path] = {
        "runOnDemand": build_run_on_demand(device_id, stream_path, selected),
        "runOnDemandRestart": True,
        "runOnDemandCloseAfter": "10s",
    }
    assignments[stream_path] = {
        "gymId": gym_id,
        "deviceId": device_id,
        "devicePath": device["devicePath"],
        "streamPath": stream_path,
        "format": selected,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    try:
        write_config(config)
        restart_mediamtx()
        stream = verify_stream(stream_path)
        save_assignments(assignments)
    except Exception:
        MEDIAMTX_CONFIG.write_bytes(raw)
        save_assignments(old_assignments)
        try:
            restart_mediamtx()
        except CameraError:
            pass
        raise

    return {
        "configuration": {
            **assignments[stream_path],
            "healthy": True,
            "stream": stream,
            "backup": str(backup),
            "replaced": bool(old_for_path),
        }
    }


def remove_camera(body: dict[str, Any]) -> dict[str, Any]:
    gym_id = require_gym(body.get("gymId"))
    raw_stream_path = body.get("streamPath")
    stream_path = raw_stream_path if isinstance(raw_stream_path, str) else ""
    if not STREAM_RE.fullmatch(stream_path):
        raise CameraError("Invalid stream path")
    raw, config = read_config()
    assignments = load_assignments()
    assignment = assignments.get(stream_path)
    if assignment and assignment.get("gymId") != gym_id:
        raise CameraError("That camera belongs to another gym")
    if stream_path not in config["paths"] and not assignment:
        return {"ok": True, "removed": False}

    backup = backup_config(raw)
    config["paths"].pop(stream_path, None)
    assignments.pop(stream_path, None)
    try:
        write_config(config)
        restart_mediamtx()
        save_assignments(assignments)
    except Exception:
        MEDIAMTX_CONFIG.write_bytes(raw)
        try:
            restart_mediamtx()
        except CameraError:
            pass
        raise
    return {"ok": True, "removed": True, "backup": str(backup)}


def service_action(action: str) -> dict[str, str]:
    if action not in {"start", "stop", "status"}:
        raise CameraError("Invalid service action")
    if action != "status":
        run(["systemctl", action, STREAM_SERVICE], timeout=30)
    result = run(["systemctl", "is-active", STREAM_SERVICE], timeout=10, check=False)
    state = result.stdout.strip().lower()
    status_by_state = {
        "active": "running",
        "inactive": "stopped",
        "activating": "starting",
        "deactivating": "stopping",
        "failed": "error",
    }
    status = status_by_state.get(state, "unknown")
    return {"status": status, "state": state}


class Handler(BaseHTTPRequestHandler):
    server_version = "GymCamControl/2"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def authenticated(self) -> bool:
        supplied = self.headers.get("X-GymCam-Secret", "")
        if SECRET and hmac.compare_digest(supplied, SECRET):
            return True
        self.send_json(401, {"error": "Unauthorized"})
        return False

    def read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 65_536:
            raise CameraError("Request body is too large")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError as error:
            raise CameraError("Invalid JSON") from error
        if not isinstance(data, dict):
            raise CameraError("Invalid request body")
        return data

    def do_GET(self) -> None:
        if not self.authenticated():
            return
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/status":
                self.send_json(200, service_action("status"))
            elif parsed.path == "/cameras":
                require_gym((query.get("gymId") or [""])[0])
                self.send_json(200, {"devices": detect_cameras(), "mediaMtx": service_action("status")})
            elif parsed.path == "/cameras/health":
                require_gym((query.get("gymId") or [""])[0])
                stream_path = (query.get("streamPath") or [""])[0]
                if not STREAM_RE.fullmatch(stream_path):
                    raise CameraError("Invalid stream path")
                self.send_json(200, path_status(stream_path))
            else:
                self.send_json(404, {"error": "Not found"})
        except CameraError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            print(f"GET {parsed.path} failed: {error}")
            self.send_json(500, {"error": "Camera control failed"})

    def do_POST(self) -> None:
        if not self.authenticated():
            return
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path in {"/start", "/stop"}:
                self.send_json(200, service_action(parsed.path[1:]))
                return
            body = self.read_body()
            if parsed.path == "/cameras/configure":
                self.send_json(200, configure_camera(body))
            elif parsed.path == "/cameras/remove":
                self.send_json(200, remove_camera(body))
            else:
                self.send_json(404, {"error": "Not found"})
        except CameraError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            print(f"POST {parsed.path} failed: {error}")
            self.send_json(500, {"error": "Camera control failed"})


def main() -> None:
    if not SECRET:
        raise SystemExit("GYMCAM_CONTROL_SECRET is required")
    if not GYM_ID:
        raise SystemExit("GYMCAM_GYM_ID is required")
    if not MEDIAMTX_CONFIG.is_file():
        raise SystemExit(f"MediaMTX config not found: {MEDIAMTX_CONFIG}")
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"GymCam control listening on {LISTEN_HOST}:{LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
