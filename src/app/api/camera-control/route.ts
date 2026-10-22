import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

type CameraAction = "start" | "stop" | "status";
type CameraStatus = "running" | "stopped" | "starting" | "stopping" | "unknown" | "error";

const statusAliases: Record<string, CameraStatus> = {
  active: "running",
  inactive: "stopped",
  online: "running",
  offline: "stopped",
  activating: "starting",
  deactivating: "stopping",
  running: "running",
  stopped: "stopped",
  starting: "starting",
  stopping: "stopping",
  failed: "error",
  error: "error",
};

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function authorizeAdmin(request: NextRequest, gymId: string) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json({ error: "Not signed in" }, 401);
  }

  if (!gymId) {
    return json({ error: "Gym is required" }, 400);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("Camera control is missing Supabase server configuration");
    return json({ error: "Camera control is not configured" }, 503);
  }

  const token = authorization.slice("Bearer ".length);
  const supabase = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(token);

  if (userError || !user) {
    return json({ error: "Invalid session" }, 401);
  }

  // An administrator for one gym must never be able to control another gym.
  const { data: access, error: accessError } = await supabase
    .from("user_gym_access")
    .select("role")
    .eq("user_id", user.id)
    .eq("gym_id", gymId)
    .eq("role", "admin")
    .maybeSingle();

  if (accessError || !access) {
    return json({ error: "Admin access required" }, 403);
  }

  return null;
}

async function callCameraControl(action: CameraAction) {
  const configuredUrl = process.env.GYMCAM_CONTROL_URL;
  const controlSecret = process.env.GYMCAM_CONTROL_SECRET;
  if (!configuredUrl || !controlSecret) {
    console.error("Camera control URL or secret is missing");
    return json({ error: "Camera control is not configured", status: "error" }, 503);
  }

  let controlUrl: URL;
  try {
    controlUrl = new URL(configuredUrl);
  } catch {
    console.error("Camera control URL is invalid");
    return json({ error: "Camera control is not configured", status: "error" }, 503);
  }

  if (
    process.env.NODE_ENV === "production" &&
    ["localhost", "127.0.0.1", "::1"].includes(controlUrl.hostname)
  ) {
    console.error("Production camera control URL must not use loopback");
    return json({ error: "Camera control is not configured", status: "error" }, 503);
  }

  controlUrl.pathname = `${controlUrl.pathname.replace(/\/$/, "")}/${action}`;
  controlUrl.search = "";

  try {
    const response = await fetch(controlUrl, {
      method: action === "status" ? "GET" : "POST",
      headers: { "X-GymCam-Secret": controlSecret },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const receivedStatus = typeof data.status === "string"
      ? data.status.toLowerCase()
      : typeof data.state === "string"
        ? data.state.toLowerCase()
        : "";
    const status = statusAliases[receivedStatus] ?? (response.ok ? "unknown" : "error");

    return json({ ...data, status }, response.status);
  } catch (error) {
    console.error("Camera control upstream request failed", error);
    return json({ error: "Camera control service is unavailable", status: "error" }, 502);
  }
}

export async function GET(request: NextRequest) {
  try {
    const gymId = request.nextUrl.searchParams.get("gymId") ?? "";
    const authorizationError = await authorizeAdmin(request, gymId);
    if (authorizationError) return authorizationError;
    return callCameraControl("status");
  } catch (error) {
    console.error("Camera control status failed", error);
    return json({ error: "Camera control failed", status: "error" }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { action?: unknown; gymId?: unknown } | null;
    const action = body?.action;
    const gymId = typeof body?.gymId === "string" ? body.gymId : "";

    if (action !== "start" && action !== "stop" && action !== "status") {
      return json({ error: "Invalid action" }, 400);
    }

    const authorizationError = await authorizeAdmin(request, gymId);
    if (authorizationError) return authorizationError;
    return callCameraControl(action);
  } catch (error) {
    console.error("Camera control action failed", error);
    return json({ error: "Camera control failed", status: "error" }, 500);
  }
}
