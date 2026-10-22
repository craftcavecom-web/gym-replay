import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CameraRow = {
  id: string;
  gym_id: string;
  name: string;
  stream_path: string;
  sort_order: number;
  device_id: string | null;
  device_path: string | null;
};

type ConfigureBody = {
  gymId?: unknown;
  cameraId?: unknown;
  deviceId?: unknown;
  name?: unknown;
  streamPath?: unknown;
};

function jsonError(message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { error: message, ...(details ? { details } : {}) },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function adminForGym(request: NextRequest, gymId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !publishableKey || !serviceRoleKey) {
    return { response: jsonError("Server configuration error.", 500) };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return { response: jsonError("Unauthorized.", 401) };

  const auth = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await auth.auth.getUser(token);
  if (userError || !user) return { response: jsonError("Unauthorized.", 401) };

  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: membership, error: membershipError } = await db
    .from("user_gym_access")
    .select("role")
    .eq("user_id", user.id)
    .eq("gym_id", gymId)
    .maybeSingle();

  if (membershipError || membership?.role !== "admin") {
    return { response: jsonError("Admin access required.", 403) };
  }
  return { db };
}

async function piRequest(path: string, init?: RequestInit) {
  const controlUrl = process.env.GYMCAM_CONTROL_URL;
  const controlSecret = process.env.GYMCAM_CONTROL_SECRET;
  if (!controlUrl || !controlSecret) throw new Error("Camera control is not configured.");

  const response = await fetch(`${controlUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "X-GymCam-Secret": controlSecret,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(45_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : "The Raspberry Pi rejected the camera operation.";
    throw new Error(message);
  }
  return data;
}

function parseConfigureBody(body: ConfigureBody):
  | { error: string }
  | { gymId: string; cameraId: string; deviceId: string; name: string; streamPath: string } {
  const gymId = typeof body.gymId === "string" ? body.gymId.trim() : "";
  const cameraId = typeof body.cameraId === "string" ? body.cameraId.trim() : "";
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const streamPath = typeof body.streamPath === "string" ? body.streamPath.trim() : "";
  if (!gymId || !deviceId || deviceId.length > 500) return { error: "A valid physical camera is required." };
  if (!name || name.length > 100) return { error: "Camera name must be between 1 and 100 characters." };
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(streamPath)) return { error: "Stream path may use only letters, numbers, underscores, and hyphens." };
  return { gymId, cameraId, deviceId, name, streamPath };
}

async function compensatePi(db: SupabaseClient, oldCamera: CameraRow | null, gymId: string, streamPath: string) {
  try {
    await piRequest("/cameras/remove", {
      method: "POST",
      body: JSON.stringify({ gymId, streamPath }),
    });
    if (oldCamera?.device_id) {
      await piRequest("/cameras/configure", {
        method: "POST",
        body: JSON.stringify({
          gymId,
          deviceId: oldCamera.device_id,
          streamPath: oldCamera.stream_path,
        }),
      });
    }
  } catch (error) {
    console.error("Camera setup rollback failed:", error);
    // Keep this parameter so callers can pass the same authenticated client while
    // rollback logging is expanded in the future.
    void db;
  }
}

export async function GET(request: NextRequest) {
  const gymId = request.nextUrl.searchParams.get("gym") ?? "";
  if (!gymId) return jsonError("Missing gym ID.", 400);
  const result = await adminForGym(request, gymId);
  if ("response" in result) return result.response;

  const { data: cameras, error } = await result.db
    .from("cameras")
    .select("id, gym_id, name, stream_path, sort_order, device_id, device_path")
    .eq("gym_id", gymId)
    .order("sort_order", { ascending: true });
  if (error) return jsonError("Could not load configured cameras.", 500);

  try {
    const scan = await piRequest(`/cameras?gymId=${encodeURIComponent(gymId)}`);
    return NextResponse.json(
      { cameras: cameras ?? [], devices: scan.devices ?? [], mediaMtx: scan.mediaMtx ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    console.error("Camera scan failed:", caught);
    return jsonError(caught instanceof Error ? caught.message : "Could not scan connected cameras.", 502);
  }
}

export async function POST(request: NextRequest) {
  let body: ConfigureBody;
  try { body = await request.json(); } catch { return jsonError("Invalid request body.", 400); }
  const parsed = parseConfigureBody(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);

  const result = await adminForGym(request, parsed.gymId);
  if ("response" in result) return result.response;

  let oldCamera: CameraRow | null = null;
  if (parsed.cameraId) {
    const { data, error } = await result.db
      .from("cameras")
      .select("id, gym_id, name, stream_path, sort_order, device_id, device_path")
      .eq("id", parsed.cameraId)
      .eq("gym_id", parsed.gymId)
      .maybeSingle();
    if (error) return jsonError("Could not verify the camera.", 500);
    if (!data) return jsonError("Camera not found in this gym.", 404);
    oldCamera = data as CameraRow;
  }

  let collisionQuery = result.db.from("cameras").select("id").eq("stream_path", parsed.streamPath);
  if (parsed.cameraId) collisionQuery = collisionQuery.neq("id", parsed.cameraId);
  const { data: collisions, error: collisionError } = await collisionQuery.limit(1);
  if (collisionError) return jsonError("Could not validate the stream path.", 500);
  if (collisions?.length) return jsonError("That stream path is already in use.", 409);

  let configured: Record<string, unknown>;
  try {
    configured = await piRequest("/cameras/configure", {
      method: "POST",
      body: JSON.stringify({
        gymId: parsed.gymId,
        deviceId: parsed.deviceId,
        streamPath: parsed.streamPath,
      }),
    });
  } catch (caught) {
    console.error("Pi camera configuration failed:", caught);
    return jsonError(caught instanceof Error ? caught.message : "Could not configure the physical camera.", 502);
  }

  const configuration = (configured.configuration ?? {}) as Record<string, unknown>;
  const devicePath = typeof configuration.devicePath === "string" ? configuration.devicePath : null;
  const values = {
    name: parsed.name,
    stream_path: parsed.streamPath,
    device_id: parsed.deviceId,
    device_path: devicePath,
  };

  if (oldCamera) {
    const { data, error } = await result.db
      .from("cameras")
      .update(values)
      .eq("id", oldCamera.id)
      .eq("gym_id", parsed.gymId)
      .select("id, gym_id, name, stream_path, sort_order, created_at, device_id, device_path")
      .single();
    if (error) {
      await compensatePi(result.db, oldCamera, parsed.gymId, parsed.streamPath);
      return jsonError("The database update failed; the Pi change was rolled back.", 500);
    }
    if (oldCamera.stream_path !== parsed.streamPath) {
      try {
        await piRequest("/cameras/remove", {
          method: "POST",
          body: JSON.stringify({ gymId: parsed.gymId, streamPath: oldCamera.stream_path }),
        });
      } catch (error) {
        console.error("Old camera path cleanup failed:", error);
      }
    }
    return NextResponse.json({ camera: data, configuration: configured.configuration }, { headers: { "Cache-Control": "no-store" } });
  }

  const { data: last } = await result.db
    .from("cameras")
    .select("sort_order")
    .eq("gym_id", parsed.gymId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const sortOrder = (last?.[0]?.sort_order ?? -1) + 1;
  const { data, error } = await result.db
    .from("cameras")
    .insert({ gym_id: parsed.gymId, sort_order: sortOrder, ...values })
    .select("id, gym_id, name, stream_path, sort_order, created_at, device_id, device_path")
    .single();
  if (error) {
    await compensatePi(result.db, null, parsed.gymId, parsed.streamPath);
    return jsonError("The database insert failed; the Pi change was rolled back.", 500);
  }
  return NextResponse.json(
    { camera: data, configuration: configured.configuration },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest) {
  let body: { gymId?: unknown; cameraId?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid request body.", 400); }
  const gymId = typeof body.gymId === "string" ? body.gymId : "";
  const cameraId = typeof body.cameraId === "string" ? body.cameraId : "";
  if (!gymId || !cameraId) return jsonError("Missing camera request fields.", 400);

  const result = await adminForGym(request, gymId);
  if ("response" in result) return result.response;
  const { data, error } = await result.db
    .from("cameras")
    .select("id, gym_id, name, stream_path, sort_order, device_id, device_path")
    .eq("id", cameraId)
    .eq("gym_id", gymId)
    .maybeSingle();
  if (error) return jsonError("Could not load the camera.", 500);
  if (!data) return jsonError("Camera not found in this gym.", 404);
  const camera = data as CameraRow;

  let linkedDeviceId = camera.device_id;
  if (!linkedDeviceId) {
    try {
      const scan = await piRequest(`/cameras?gymId=${encodeURIComponent(gymId)}`);
      const devices = Array.isArray(scan.devices) ? scan.devices as Array<Record<string, unknown>> : [];
      const match = devices.find((device) => {
        const assignment = device.assignment as Record<string, unknown> | null | undefined;
        return assignment?.streamPath === camera.stream_path;
      });
      if (match && typeof match.id === "string") linkedDeviceId = match.id;
    } catch (caught) {
      console.error("Could not inspect legacy camera link before removal:", caught);
    }
  }

  if (linkedDeviceId) {
    try {
      await piRequest("/cameras/remove", {
        method: "POST",
        body: JSON.stringify({ gymId, streamPath: camera.stream_path }),
      });
    } catch (caught) {
      return jsonError(caught instanceof Error ? caught.message : "Could not remove the Pi camera configuration.", 502);
    }
  }

  const { data: deleted, error: deleteError } = await result.db
    .from("cameras")
    .delete()
    .eq("id", cameraId)
    .eq("gym_id", gymId)
    .select("id")
    .maybeSingle();
  if (deleteError || !deleted) {
    if (linkedDeviceId) {
      try {
        await piRequest("/cameras/configure", {
          method: "POST",
          body: JSON.stringify({ gymId, deviceId: linkedDeviceId, streamPath: camera.stream_path }),
        });
      } catch (rollbackError) {
        console.error("Camera removal rollback failed:", rollbackError);
      }
    }
    return jsonError("Could not remove the camera row; the Pi configuration was restored where possible.", 500);
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
