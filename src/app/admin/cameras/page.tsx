"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";

type Camera = {
  id: string;
  name: string;
  stream_path: string;
  device_id?: string | null;
  device_path?: string | null;
};

type CameraFormat = {
  pixelFormat: string;
  description: string;
  resolutions: Array<{ width: number; height: number; fps: number[] }>;
};

type PhysicalCamera = {
  id: string;
  name: string;
  stablePath: string | null;
  devicePath: string;
  connected: boolean;
  ambiguous: boolean;
  formats: CameraFormat[];
  preferred?: { pixelFormat: string; width: number; height: number; fps: number } | null;
  assignment?: { gymId: string; streamPath: string } | null;
  mediaMtxConfigured: boolean;
  streaming: boolean;
  healthy: boolean;
  healthMessage?: string;
};

type ApiData = {
  error?: string;
  cameras?: Camera[];
  devices?: PhysicalCamera[];
  camera?: Camera;
};

const emptyForm = { name: "", streamPath: "" };

function StatusPill({ active, activeText, inactiveText }: { active: boolean; activeText: string; inactiveText: string }) {
  return (
    <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : "border-white/10 bg-white/[0.03] text-zinc-500"}`}>
      {active ? activeText : inactiveText}
    </span>
  );
}

function formatCapabilities(device: PhysicalCamera) {
  if (device.preferred) {
    const value = device.preferred;
    return `${value.width}×${value.height} · ${value.fps} fps · ${value.pixelFormat}`;
  }
  const first = device.formats[0];
  return first ? `${first.pixelFormat}${first.description ? ` · ${first.description}` : ""}` : "Capabilities unavailable";
}

export default function CamerasPage() {
  const router = useRouter();
  const [gymId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("gym") ?? "");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [devices, setDevices] = useState<PhysicalCamera[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Camera | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<PhysicalCamera | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const nextStreamPath = useMemo(() => {
    const used = new Set(cameras.map((camera) => camera.stream_path.toLowerCase()));
    let index = 1;
    while (used.has(`cam${index}`)) index += 1;
    return `cam${index}`;
  }, [cameras]);

  async function authHeaders() {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" } : null;
  }

  async function request(url: string, init?: RequestInit): Promise<ApiData | null> {
    const auth = await authHeaders();
    if (!auth) { router.replace("/"); return null; }
    const response = await fetch(url, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
    const data = await response.json().catch(() => ({})) as ApiData;
    if (!response.ok) throw new Error(data.error ?? "Camera request failed.");
    return data;
  }

  async function load() {
    if (!gymId) { setLoading(false); return; }
    setLoading(true);
    setMessage("");
    try {
      const data = await request(`/api/admin/cameras?gym=${encodeURIComponent(gymId)}`);
      if (data) setCameras(data.cameras ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load cameras.");
    } finally {
      setLoading(false);
    }
  }

  async function scan(showSuccess = true) {
    if (!gymId) return;
    setScanning(true);
    setMessage("");
    try {
      const data = await request(`/api/admin/camera-setup?gym=${encodeURIComponent(gymId)}`);
      if (data) {
        setCameras(data.cameras ?? cameras);
        setDevices(data.devices ?? []);
        if (showSuccess) setMessage(`Found ${(data.devices ?? []).length} connected USB camera${(data.devices ?? []).length === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not scan connected cameras.");
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [gymId]);

  function beginManualAdd() {
    setEditing(null);
    setSelectedDevice(null);
    setForm({ name: "", streamPath: nextStreamPath });
    setMessage("");
  }

  function edit(camera: Camera) {
    setEditing(camera);
    setSelectedDevice(null);
    setForm({ name: camera.name, streamPath: camera.stream_path });
    setMessage("");
  }

  function configure(device: PhysicalCamera) {
    const assigned = cameras.find((camera) => camera.device_id === device.id || camera.stream_path === device.assignment?.streamPath) ?? null;
    setSelectedDevice(device);
    setEditing(assigned);
    setForm({ name: assigned?.name ?? device.name, streamPath: assigned?.stream_path ?? nextStreamPath });
    setMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelForm() {
    setEditing(null);
    setSelectedDevice(null);
    setForm(emptyForm);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const detectedLink = editing ? devices.find((item) => item.id === editing.device_id || item.assignment?.streamPath === editing.stream_path) : undefined;
      const physicalChange = selectedDevice || (detectedLink && form.streamPath !== editing?.stream_path);
      if (physicalChange) {
        const device = selectedDevice ?? detectedLink;
        if (!device) throw new Error("Scan and select the physical camera before changing its stream path.");
        const data = await request("/api/admin/camera-setup", {
          method: "POST",
          body: JSON.stringify({ gymId, cameraId: editing?.id, deviceId: device.id, ...form }),
        });
        if (data?.camera) {
          setCameras((items) => editing ? items.map((camera) => camera.id === editing.id ? data.camera! : camera) : [...items, data.camera!]);
        }
        setMessage(`${form.name} is configured and streaming as ${form.streamPath}.`);
        await scan(false);
      } else {
        const data = await request("/api/admin/cameras", {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({ gymId, cameraId: editing?.id, ...form }),
        });
        if (data?.camera) {
          setCameras((items) => editing ? items.map((camera) => camera.id === editing.id ? data.camera! : camera) : [...items, data.camera!]);
        }
        setMessage(editing ? "Camera saved." : "Database camera added. Scan a physical camera to link and configure it.");
      }
      setEditing(null);
      setSelectedDevice(null);
      setForm(emptyForm);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save camera.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(camera: Camera) {
    const detectedLink = devices.find((item) => item.id === camera.device_id || item.assignment?.streamPath === camera.stream_path);
    const warning = camera.device_id || detectedLink
      ? `Remove ${camera.name}? Its MediaMTX path and GymCam camera row will both be removed.`
      : `Remove ${camera.name} from GymCam?`;
    if (!window.confirm(warning)) return;
    setBusy(true);
    setMessage("");
    try {
      if (camera.device_id || detectedLink) {
        await request("/api/admin/camera-setup", { method: "DELETE", body: JSON.stringify({ gymId, cameraId: camera.id }) });
      } else {
        await request(`/api/admin/cameras?gym=${encodeURIComponent(gymId)}&camera=${encodeURIComponent(camera.id)}`, { method: "DELETE" });
      }
      setCameras((items) => items.filter((item) => item.id !== camera.id));
      setMessage(`${camera.name} removed.`);
      if (devices.length) await scan(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove camera.");
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const next = [...cameras];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setCameras(next);
    setBusy(true);
    setMessage("");
    try {
      await request("/api/admin/cameras", { method: "PATCH", body: JSON.stringify({ gymId, cameraIds: next.map((camera) => camera.id) }) });
      setMessage("Camera order saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save camera order.");
      void load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#070707] px-4 py-6 text-white sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl">
        <button type="button" onClick={() => router.push("/")} className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-zinc-300">← Back to GymCam</button>
        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-500">Admin</p>
            <h1 className="mt-1 text-3xl font-bold">Cameras</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">Manage GymCam names and order, or scan the Raspberry Pi to add and configure a connected USB camera without SSH.</p>
          </div>
          <button type="button" disabled={scanning || busy || !gymId} onClick={() => void scan()} className="rounded-xl bg-blue-500 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{scanning ? "Scanning…" : "Scan Connected Cameras"}</button>
        </div>

        {message && <p className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-200">{message}</p>}
        {!gymId ? <p className="mt-8 text-amber-200">No gym was selected.</p> : (
          <>
            {(editing || selectedDevice || form.streamPath) && (
              <form onSubmit={save} className="mt-6 rounded-2xl border border-blue-500/20 bg-blue-500/[0.05] p-5">
                <h2 className="font-bold">{selectedDevice ? `${editing ? "Reconfigure" : "Add"} ${selectedDevice.name}` : editing ? `Edit ${editing.name}` : "Add database camera"}</h2>
                {selectedDevice && <p className="mt-1 break-all text-xs text-zinc-500">{selectedDevice.stablePath ?? selectedDevice.devicePath}</p>}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Camera name<input required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Floor" className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm normal-case tracking-normal text-white outline-none" /></label>
                  <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Stream path<input required maxLength={100} pattern="[A-Za-z0-9_-]+" value={form.streamPath} onChange={(event) => setForm({ ...form, streamPath: event.target.value })} placeholder="cam3" className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm normal-case tracking-normal text-white outline-none" /></label>
                </div>
                <div className="mt-4 flex gap-2"><button disabled={busy} className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50">{busy ? "Saving…" : selectedDevice ? "Configure camera" : "Save camera"}</button><button type="button" onClick={cancelForm} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-zinc-300">Cancel</button></div>
              </form>
            )}

            <section className="mt-8">
              <div className="flex items-center justify-between"><div><h2 className="text-lg font-bold">Configured Cameras</h2><p className="mt-1 text-sm text-zinc-500">This order controls the camera selector.</p></div><button type="button" onClick={beginManualAdd} className="rounded-lg border border-white/10 px-3 py-2 text-sm font-semibold text-zinc-300">Add manually</button></div>
              <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.08]">
                {loading ? <p className="p-5 text-sm text-zinc-500">Loading cameras…</p> : cameras.length === 0 ? <p className="p-5 text-sm text-zinc-500">No cameras configured.</p> : cameras.map((camera, index) => {
                  const device = devices.find((item) => item.id === camera.device_id || item.assignment?.streamPath === camera.stream_path);
                  return <article key={camera.id} className="flex flex-col gap-4 border-b border-white/[0.08] p-4 last:border-0 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="font-semibold">{camera.name}</p><p className="mt-1 text-sm text-zinc-500">{camera.stream_path}{camera.device_path ? ` · ${camera.device_path}` : ""}</p><div className="mt-2 flex flex-wrap gap-2"><StatusPill active={Boolean(camera.device_id)} activeText="Physical camera linked" inactiveText="Database row only" /><StatusPill active={Boolean(device?.connected)} activeText="Connected" inactiveText={devices.length ? "Disconnected" : "Not scanned"} /><StatusPill active={Boolean(device?.mediaMtxConfigured)} activeText="MediaMTX configured" inactiveText="MediaMTX unknown" /><StatusPill active={Boolean(device?.healthy)} activeText="Stream healthy" inactiveText={device?.streaming ? "Stream unhealthy" : "Not streaming"} /></div></div><div className="flex shrink-0 flex-wrap gap-2"><button disabled={busy || index === 0} onClick={() => void move(index, -1)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40" aria-label={`Move ${camera.name} up`}>↑</button><button disabled={busy || index === cameras.length - 1} onClick={() => void move(index, 1)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40" aria-label={`Move ${camera.name} down`}>↓</button><button disabled={busy} onClick={() => edit(camera)} className="rounded-lg border border-white/10 px-3 py-2 text-sm">Edit</button>{device && <button disabled={busy} onClick={() => configure(device)} className="rounded-lg border border-blue-500/30 px-3 py-2 text-sm text-blue-300">Reconfigure</button>}<button disabled={busy} onClick={() => void remove(camera)} className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300">Remove</button></div></article>;
                })}
              </div>
            </section>

            <section className="mt-8 pb-12">
              <h2 className="text-lg font-bold">Detected Physical Cameras</h2>
              <p className="mt-1 text-sm text-zinc-500">Only external USB cameras are shown. Raspberry Pi codec and pisp devices are excluded.</p>
              <div className="mt-4 overflow-hidden rounded-2xl border border-white/[0.08]">
                {!devices.length ? <p className="p-5 text-sm text-zinc-500">{scanning ? "Inspecting USB cameras and supported formats…" : "Scan to see cameras connected to the Raspberry Pi."}</p> : devices.map((device) => {
                  const assigned = cameras.find((camera) => camera.device_id === device.id || camera.stream_path === device.assignment?.streamPath);
                  return <article key={device.id} className="border-b border-white/[0.08] p-5 last:border-0"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-semibold">{device.name}</p><StatusPill active={device.connected} activeText="Connected" inactiveText="Disconnected" /></div><p className="mt-1 break-all text-xs text-zinc-500">{device.stablePath ?? device.devicePath} · currently {device.devicePath}</p><p className="mt-2 text-sm text-zinc-400">{formatCapabilities(device)}</p><p className="mt-2 text-sm text-zinc-500">{assigned ? `Configured as ${assigned.name} (${assigned.stream_path})` : "Not configured in GymCam"}</p>{device.ambiguous && <p className="mt-2 text-xs text-amber-300">No unique by-id link was found. This uses the USB-port-based by-path link when available; identical cameras should stay on the same USB ports.</p>}<div className="mt-3 flex flex-wrap gap-2"><StatusPill active={device.mediaMtxConfigured} activeText="MediaMTX configured" inactiveText="Not in MediaMTX" /><StatusPill active={device.streaming} activeText="Publisher active" inactiveText="Publisher idle" /><StatusPill active={device.healthy} activeText="Stream healthy" inactiveText="Health not verified" /></div></div><button type="button" disabled={busy || !device.stablePath} onClick={() => configure(device)} className="shrink-0 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black disabled:opacity-40">{assigned ? "Configure" : "Add to GymCam"}</button></div></article>;
                })}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
