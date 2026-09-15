import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabasePublishableKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function GET(request: NextRequest) {
  try {
    const authorization =
      request.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const token = authorization.substring(7);

    const gymId =
      request.nextUrl.searchParams.get("gym");

    if (!gymId) {
      return NextResponse.json(
        { error: "Missing gym ID" },
        { status: 400 },
      );
    }

    // Normal Supabase client:
    // used to identify the signed-in user.
    const supabase = createClient(
      supabaseUrl,
      supabasePublishableKey,
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
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Make sure this person is an admin
    // of THIS specific gym.
    const { data: access, error: accessError } =
      await supabase
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

    // PRIVILEGED SERVER-ONLY CLIENT.
    const adminSupabase = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    // Find accounts that actually appear in
    // this gym's export history.
    const { data: logs, error: logsError } =
      await adminSupabase
        .from("video_downloads")
        .select("user_id")
        .eq("gym_id", gymId)
        .not("user_id", "is", null);

    if (logsError) {
      console.error(logsError);

      return NextResponse.json(
        { error: "Could not load export accounts" },
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

    // Only return information for users
    // appearing in this gym's logs.
    for (const userId of userIds) {
      const {
        data,
        error,
      } =
        await adminSupabase.auth.admin.getUserById(
          userId,
        );

      if (error || !data.user) {
        console.warn(
          `Could not load user ${userId}`,
          error,
        );

        continue;
      }

      users[userId] = {
        email:
          data.user.email ??
          "Unknown email",

        name:
          data.user.user_metadata?.full_name ??
          data.user.user_metadata?.name ??
          null,
      };
    }

    return NextResponse.json({
      users,
    });
  } catch (error) {
    console.error(
      "Export-user API error:",
      error,
    );

    return NextResponse.json(
      { error: "Server error" },
      { status: 500 },
    );
  }
}