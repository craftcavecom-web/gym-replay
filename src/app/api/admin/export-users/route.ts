import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const token = authHeader.slice(7);
    const gymId = request.nextUrl.searchParams.get("gym");

    if (!gymId) {
      return NextResponse.json(
        { error: "Missing gym ID" },
        { status: 400 },
      );
    }

    const userClient = createClient(
      supabaseUrl,
      supabaseKey,
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
        auth: {
          persistSession: false,
        },
      },
    );

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { data: access, error: accessError } =
      await userClient
        .from("user_gym_access")
        .select("role")
        .eq("user_id", user.id)
        .eq("gym_id", gymId)
        .maybeSingle();

    if (
      accessError ||
      !access ||
      access.role !== "admin"
    ) {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    if (!serviceRoleKey) {
      console.error(
        "SUPABASE_SERVICE_ROLE_KEY is missing",
      );

      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 },
      );
    }

    const adminClient = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const { data: logs, error: logsError } =
      await adminClient
        .from("video_downloads")
        .select("user_id")
        .eq("gym_id", gymId)
        .not("user_id", "is", null);

    if (logsError) {
      console.error(logsError);

      return NextResponse.json(
        { error: "Could not load export users" },
        { status: 500 },
      );
    }

    const userIds = Array.from(
      new Set(
        (logs ?? [])
          .map((row) => row.user_id)
          .filter(
            (value): value is string =>
              typeof value === "string",
          ),
      ),
    );

    const users: Record<
      string,
      {
        email: string;
        name: string | null;
      }
    > = {};

    for (const userId of userIds) {
      const { data, error } =
        await adminClient.auth.admin.getUserById(userId);

      if (error || !data.user) {
        console.warn(
          `Could not load user ${userId}`,
          error,
        );
        continue;
      }

      users[userId] = {
        email: data.user.email ?? "Unknown email",
        name:
          data.user.user_metadata?.full_name ??
          data.user.user_metadata?.name ??
          null,
      };
    }

    return NextResponse.json({ users });
  } catch (error) {
    console.error("Export users API error:", error);

    return NextResponse.json(
      { error: "Server error" },
      { status: 500 },
    );
  }
}