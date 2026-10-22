import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type CameraInput = { name?: unknown; streamPath?: unknown };

function reply(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function config() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function adminForGym(request: NextRequest, gymId: string) {
  const { url, key, serviceKey } = config();
  if (!url || !key || !serviceKey) return { response: reply("Server configuration error.", 500) };
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { response: reply("Unauthorized.", 401) };

  const auth = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: userError } = await auth.auth.getUser(token);
  if (userError || !user) return { response: reply("Unauthorized.", 401) };

  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: membership, error: membershipError } = await db
    .from("user_gym_access").select("role").eq("user_id", user.id).eq("gym_id", gymId).maybeSingle();
  if (membershipError || membership?.role !== "admin") return { response: reply("Admin access required.", 403) };
  return { db };
}

function cameraInput(input: CameraInput) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const streamPath = typeof input.streamPath === "string" ? input.streamPath.trim() : "";
  if (!name || name.length > 100) return { error: "Camera name must be between 1 and 100 characters." };
  // Stream paths become part of HLS/WebRTC URLs and replay signatures.
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(streamPath)) return { error: "Stream path may use only letters, numbers, underscores, and hyphens." };
  return { name, streamPath };
}

export async function GET(request: NextRequest) {
  const gymId = request.nextUrl.searchParams.get("gym") ?? "";
  if (!gymId) return reply("Missing gym ID.", 400);
  const result = await adminForGym(request, gymId);
  if ("response" in result) return result.response;
  const { data, error } = await result.db.from("cameras")
    .select("id, gym_id, name, stream_path, sort_order, created_at")
    .eq("gym_id", gymId).order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (error) return reply("Could not load cameras.", 500);
  return NextResponse.json({ cameras: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  let body: { gymId?: unknown } & CameraInput;
  try { body = await request.json(); } catch { return reply("Invalid request body.", 400); }
  const gymId = typeof body.gymId === "string" ? body.gymId : "";
  const input = cameraInput(body);
  if (!gymId || "error" in input) return reply(input.error ?? "Invalid camera request.", 400);
  const result = await adminForGym(request, gymId);
  if ("response" in result) return result.response;
  const { data: existing, error: countError } = await result.db.from("cameras").select("sort_order").eq("gym_id", gymId).order("sort_order", { ascending: false }).limit(1);
  if (countError) return reply("Could not prepare camera.", 500);
  const sortOrder = (existing?.[0]?.sort_order ?? -1) + 1;
  const { data, error } = await result.db.from("cameras").insert({ gym_id: gymId, name: input.name, stream_path: input.streamPath, sort_order: sortOrder }).select("id, gym_id, name, stream_path, sort_order, created_at").single();
  if (error) return reply("Could not add camera.", 500);
  return NextResponse.json({ camera: data }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  let body: { gymId?: unknown; cameraId?: unknown; cameraIds?: unknown } & CameraInput;
  try { body = await request.json(); } catch { return reply("Invalid request body.", 400); }
  const gymId = typeof body.gymId === "string" ? body.gymId : "";
  if (!gymId) return reply("Missing gym ID.", 400);
  const result = await adminForGym(request, gymId);
  if ("response" in result) return result.response;

  if (Array.isArray(body.cameraIds)) {
    const cameraIds = body.cameraIds.filter((id): id is string => typeof id === "string");
    if (cameraIds.length !== body.cameraIds.length || new Set(cameraIds).size !== cameraIds.length) return reply("Invalid camera order.", 400);
    const { data: current, error: readError } = await result.db.from("cameras").select("id").eq("gym_id", gymId);
    if (readError || current?.length !== cameraIds.length || current.some((camera) => !cameraIds.includes(camera.id))) return reply("Camera order does not match this gym.", 400);
    const updates = await Promise.all(cameraIds.map((id, sort_order) => result.db.from("cameras").update({ sort_order }).eq("id", id).eq("gym_id", gymId)));
    if (updates.some(({ error }) => error)) return reply("Could not save camera order.", 500);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const cameraId = typeof body.cameraId === "string" ? body.cameraId : "";
  const input = cameraInput(body);
  if (!cameraId || "error" in input) return reply(input.error ?? "Invalid camera request.", 400);
  const { data, error } = await result.db.from("cameras").update({ name: input.name, stream_path: input.streamPath }).eq("id", cameraId).eq("gym_id", gymId).select("id, gym_id, name, stream_path, sort_order, created_at").maybeSingle();
  if (error) return reply("Could not update camera.", 500);
  if (!data) return reply("Camera not found in this gym.", 404);
  return NextResponse.json({ camera: data }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const gymId = request.nextUrl.searchParams.get("gym") ?? "";
  const cameraId = request.nextUrl.searchParams.get("camera") ?? "";
  if (!gymId || !cameraId) return reply("Missing camera request fields.", 400);
  const result = await adminForGym(request, gymId);
  if ("response" in result) return result.response;
  const { data, error } = await result.db.from("cameras").delete().eq("id", cameraId).eq("gym_id", gymId).select("id").maybeSingle();
  if (error) return reply("Could not remove camera.", 500);
  if (!data) return reply("Camera not found in this gym.", 404);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
