import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import ReplayPlayer from "./ReplayPlayer";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const controlUrl =
  process.env.GYMCAM_CONTROL_URL!;

const controlSecret =
  process.env.GYMCAM_CONTROL_SECRET!;

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

    const { data: access, error: accessError } =
      await supabase
        .from("user_gym_access")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .limit(1);

    if (
      accessError ||
      !access ||
      access.length === 0
    ) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const body = await request.json();

    const action = body.action;

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

    const data = await response.json();

    return NextResponse.json(
      data,
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