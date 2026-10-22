import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const controlUrl =
  process.env.GYMCAM_CONTROL_URL!;

const controlSecret =
  process.env.GYMCAM_CONTROL_SECRET!;

const statusAliases: Record<string, "running" | "stopped" | "starting" | "stopping" | "unknown" | "error"> = {
  active: "running", inactive: "stopped", online: "running", offline: "stopped",
  running: "running", stopped: "stopped", starting: "starting", stopping: "stopping", error: "error",
};

export async function POST(request: NextRequest) {
  try {
    const authorization =
      request.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Not signed in" },
        { status: 401 }
      );
    }

    const token = authorization.replace(
      "Bearer ",
      ""
    );

    const supabase = createClient(
      supabaseUrl,
      supabaseKey,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      }
    );

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid session" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const action = body.action;
    const gymId = typeof body.gymId === "string" ? body.gymId : "";

    if (
      action !== "start" &&
      action !== "stop" &&
      action !== "status"
    ) {
      return NextResponse.json(
        { error: "Invalid action" },
        { status: 400 }
      );
    }

    if (!gymId) {
      return NextResponse.json(
        { error: "Gym is required" },
        { status: 400 }
      );
    }

    // An administrator for one gym must never be able to control another gym.
    const { data: access, error: accessError } =
      await supabase
        .from("user_gym_access")
        .select("role")
        .eq("user_id", user.id)
        .eq("gym_id", gymId)
        .eq("role", "admin")
        .maybeSingle();

    if (
      accessError ||
      !access
    ) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const response = await fetch(
      `${controlUrl}/${action}`,
      {
        method:
          action === "status"
            ? "GET"
            : "POST",

        headers: {
          "X-GymCam-Secret":
            controlSecret,
        },

        cache: "no-store",
      }
    );

    const data = await response.json().catch(() => ({}));
    const receivedStatus = typeof data.status === "string" ? data.status.toLowerCase() : typeof data.state === "string" ? data.state.toLowerCase() : "";
    const status = statusAliases[receivedStatus] ?? (response.ok ? "unknown" : "error");

    return NextResponse.json(
      { ...data, status },
      {
        status: response.status,
      }
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          "Camera control failed",
      },
      { status: 500 }
    );
  }
}
