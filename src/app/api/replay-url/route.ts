import { createHmac } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_REPLAY_BASE = "https://mobile-replay.gymcam.stream";
const MAX_DURATION = 300;

type Endpoint = "latest" | "export";
type ExportFormat = "landscape" | "vertical";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDuration(value: unknown) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return null;

  return Math.trunc(clamp(parsed, 1, MAX_DURATION));
}

function normalizeCropX(value: unknown) {
  const parsed = Number(value ?? 0.5);
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed, 0, 1).toFixed(3);
}

function normalizeZoom(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed, 1, 2).toFixed(2);
}

function canonicalLatest(path: string, duration: number, exp: number) {
  return [
    "endpoint=/latest",
    `path=${path}`,
    `duration=${duration}`,
    `exp=${exp}`,
  ].join("\n");
}

function canonicalExport(
  path: string,
  duration: number,
  format: ExportFormat,
  cropX: string,
  zoom: string,
  exp: number,
) {
  return [
    "endpoint=/export",
    `path=${path}`,
    `duration=${duration}`,
    `format=${format}`,
    `cropX=${cropX}`,
    `zoom=${zoom}`,
    `exp=${exp}`,
  ].join("\n");
}

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const replaySecret = process.env.GYMCAM_REPLAY_SECRET;
  const replayBase = process.env.GYMCAM_REPLAY_BASE ?? DEFAULT_REPLAY_BASE;

  if (
    !supabaseUrl ||
    !publishableKey ||
    !serviceRoleKey ||
    !replaySecret
  ) {
    return jsonError("Replay signing is not configured.", 500);
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const accessToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (!accessToken) {
    return jsonError("Unauthorized.", 401);
  }

  let body: {
    gymId?: string;
    cameraId?: string;
    endpoint?: Endpoint;
    duration?: number;
    format?: ExportFormat;
    cropX?: number;
    zoom?: number;
  };

  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  const { gymId, cameraId, endpoint } = body;
  const duration = normalizeDuration(body.duration);

  if (!gymId || !cameraId || (endpoint !== "latest" && endpoint !== "export")) {
    return jsonError("Missing replay request fields.", 400);
  }

  if (duration === null) {
    return jsonError("Invalid duration.", 400);
  }

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser(accessToken);

  if (userError || !user) {
    return jsonError("Unauthorized.", 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: membership, error: membershipError } = await adminClient
    .from("user_gym_access")
    .select("id")
    .eq("user_id", user.id)
    .eq("gym_id", gymId)
    .maybeSingle();

  if (membershipError) {
    console.error("Replay membership lookup failed:", membershipError);
    return jsonError("Could not verify gym access.", 500);
  }

  if (!membership) {
    return jsonError("Forbidden.", 403);
  }

  const { data: camera, error: cameraError } = await adminClient
    .from("cameras")
    .select("id, gym_id, stream_path")
    .eq("id", cameraId)
    .eq("gym_id", gymId)
    .maybeSingle();

  if (cameraError) {
    console.error("Replay camera lookup failed:", cameraError);
    return jsonError("Could not verify camera.", 500);
  }

  if (!camera) {
    return jsonError("Camera not found for this gym.", 404);
  }

  if (!/^[A-Za-z0-9_-]+$/.test(camera.stream_path)) {
    return jsonError("Camera stream path is invalid.", 500);
  }

  // Replay URLs stay valid long enough for a 5-minute MP4 to make range requests.
  // Export URLs only need enough time to start one export request.
  const ttlSeconds = endpoint === "latest" ? 420 : 120;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;

  const target = new URL(
    endpoint === "latest" ? "/latest" : "/export",
    replayBase,
  );

  target.searchParams.set("path", camera.stream_path);
  target.searchParams.set("duration", String(duration));
  target.searchParams.set("exp", String(exp));

  let canonical: string;

  if (endpoint === "latest") {
    canonical = canonicalLatest(camera.stream_path, duration, exp);
  } else {
    const format: ExportFormat =
      body.format === "vertical" ? "vertical" : "landscape";
    const cropX = normalizeCropX(body.cropX);
    const zoom = normalizeZoom(body.zoom);

    if (cropX === null || zoom === null) {
      return jsonError("Invalid crop settings.", 400);
    }

    target.searchParams.set("format", format);
    target.searchParams.set("cropX", cropX);
    target.searchParams.set("zoom", zoom);

    canonical = canonicalExport(
      camera.stream_path,
      duration,
      format,
      cropX,
      zoom,
      exp,
    );
  }

  const sig = createHmac("sha256", replaySecret)
    .update(canonical, "utf8")
    .digest("hex");

  target.searchParams.set("sig", sig);

  return NextResponse.json(
    {
      url: target.toString(),
      expiresAt: new Date(exp * 1000).toISOString(),
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
