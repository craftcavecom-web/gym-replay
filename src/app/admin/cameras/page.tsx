"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";

type Camera = { id: string; name: string; stream_path: string };
const emptyForm = { name: "", streamPath: "" };

export default function CamerasPage() {
  const router = useRouter();
  const [gymId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("gym") ?? "");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Camera | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function headers() {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" } : null;
  }
  async function request(url: string, init?: RequestInit) {
    const auth = await headers();
    if (!auth) { router.replace("/"); return null; }
    const response = await fetch(url, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? "Camera request failed.");
    return data;
  }
  async function load() {
    if (!gymId) return;
    setLoading(true); setMessage("");
    try { const data = await request(`/api/admin/cameras?gym=${encodeURIComponent(gymId)}`); if (data) setCameras(data.cameras ?? []); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load cameras."); }
    finally { setLoading(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [gymId]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const data = await request("/api/admin/cameras", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ gymId, cameraId: editing?.id, ...form }) });
      if (editing) setCameras((items) => items.map((camera) => camera.id === editing.id ? data.camera : camera));
      else setCameras((items) => [...items, data.camera]);
      setEditing(null); setForm(emptyForm);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save camera."); }
    finally { setBusy(false); }
  }
  function edit(camera: Camera) { setEditing(camera); setForm({ name: camera.name, streamPath: camera.stream_path }); setMessage(""); }
  async function remove(camera: Camera) {
    if (!window.confirm(`Remove ${camera.name}? This does not stop its physical camera.`)) return;
    setBusy(true); setMessage("");
    try { await request(`/api/admin/cameras?gym=${encodeURIComponent(gymId)}&camera=${encodeURIComponent(camera.id)}`, { method: "DELETE" }); setCameras((items) => items.filter((item) => item.id !== camera.id)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove camera."); }
    finally { setBusy(false); }
  }
  async function move(index: number, direction: -1 | 1) {
    const next = [...cameras]; const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; setCameras(next); setBusy(true); setMessage("");
    try { await request("/api/admin/cameras", { method: "PATCH", body: JSON.stringify({ gymId, cameraIds: next.map((camera) => camera.id) }) }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save camera order."); void load(); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-[#070707] px-4 py-6 text-white sm:px-6 sm:py-8"><div className="mx-auto max-w-3xl">
    <button type="button" onClick={() => router.push("/")} className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-zinc-300">← Back to GymCam</button>
    <p className="mt-8 text-sm font-medium text-zinc-500">Admin</p><h1 className="mt-1 text-3xl font-bold">Cameras</h1><p className="mt-2 text-sm leading-6 text-zinc-500">Add cameras now or later. The order here controls the player&apos;s camera selector.</p>
    {message && <p className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-200">{message}</p>}
    {!gymId ? <p className="mt-8 text-amber-200">No gym was selected.</p> : <><form onSubmit={save} className="mt-6 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5"><h2 className="font-bold">{editing ? `Edit ${editing.name}` : "Add camera"}</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><input required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Camera name" className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm outline-none" /><input required maxLength={100} pattern="[A-Za-z0-9_-]+" value={form.streamPath} onChange={(event) => setForm({ ...form, streamPath: event.target.value })} placeholder="Stream path, e.g. cam3" className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm outline-none" /></div><div className="mt-3 flex gap-2"><button disabled={busy} className="rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50">{editing ? "Save camera" : "Add camera"}</button>{editing && <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); }} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-zinc-300">Cancel</button>}</div></form>
    <section className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08]">{loading ? <p className="p-5 text-sm text-zinc-500">Loading cameras…</p> : cameras.length === 0 ? <p className="p-5 text-sm text-zinc-500">No cameras configured.</p> : cameras.map((camera, index) => <article key={camera.id} className="flex flex-col gap-3 border-b border-white/[0.08] p-4 last:border-0 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{camera.name}</p><p className="text-sm text-zinc-500">{camera.stream_path}</p></div><div className="flex flex-wrap gap-2"><button disabled={busy || index === 0} onClick={() => void move(index, -1)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40">↑</button><button disabled={busy || index === cameras.length - 1} onClick={() => void move(index, 1)} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-40">↓</button><button disabled={busy} onClick={() => edit(camera)} className="rounded-lg border border-white/10 px-3 py-2 text-sm">Edit</button><button disabled={busy} onClick={() => void remove(camera)} className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300">Remove</button></div></article>)}</section></>}</div></main>;
}
