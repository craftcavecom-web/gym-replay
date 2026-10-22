import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type MemberRole = "athlete" | "admin";

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function getConfig() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return { supabaseUrl, publishableKey, serviceRoleKey };
}

async function authenticatedAdmin(request: NextRequest, gymId: string) {
  const { supabaseUrl, publishableKey, serviceRoleKey } = getConfig();
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) return { response: error("Server configuration error.", 500) };

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return { response: error("Unauthorized.", 401) };

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await authClient.auth.getUser(token);
  if (userError || !user) return { response: error("Unauthorized.", 401) };

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: access, error: accessError } = await adminClient
    .from("user_gym_access")
    .select("role")
    .eq("user_id", user.id)
    .eq("gym_id", gymId)
    .maybeSingle();
  if (accessError || access?.role !== "admin") return { response: error("Admin access required.", 403) };

  return { adminClient, userId: user.id };
}

export async function GET(request: NextRequest) {
  const gymId = request.nextUrl.searchParams.get("gym") ?? "";
  if (!gymId) return error("Missing gym ID.", 400);

  try {
    const result = await authenticatedAdmin(request, gymId);
    if ("response" in result) return result.response;

    const { data: accessRows, error: accessError } = await result.adminClient
      .from("user_gym_access")
      .select("user_id, role, created_at")
      .eq("gym_id", gymId)
      .order("created_at", { ascending: true });
    if (accessError) return error("Could not load gym members.", 500);

    const members = await Promise.all((accessRows ?? []).map(async (member) => {
      const { data } = await result.adminClient.auth.admin.getUserById(member.user_id);
      return {
        userId: member.user_id,
        role: member.role as MemberRole,
        createdAt: member.created_at,
        email: data.user?.email ?? "Unknown email",
        name: data.user?.user_metadata?.full_name ?? data.user?.user_metadata?.name ?? null,
      };
    }));
    return NextResponse.json({ members }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    console.error("Member list failed:", caught);
    return error("Could not load gym members.", 500);
  }
}

export async function PATCH(request: NextRequest) {
  let body: { gymId?: unknown; userId?: unknown; role?: unknown };
  try { body = await request.json(); } catch { return error("Invalid request body.", 400); }

  const gymId = typeof body.gymId === "string" ? body.gymId : "";
  const targetUserId = typeof body.userId === "string" ? body.userId : "";
  const role = body.role === "admin" || body.role === "athlete" ? body.role : null;
  if (!gymId || !targetUserId || !role) return error("Invalid member role request.", 400);

  try {
    const result = await authenticatedAdmin(request, gymId);
    if ("response" in result) return result.response;
    if (targetUserId === result.userId) return error("You cannot change your own role.", 403);

    const { data: targetAccess, error: targetError } = await result.adminClient
      .from("user_gym_access")
      .select("id")
      .eq("user_id", targetUserId)
      .eq("gym_id", gymId)
      .maybeSingle();
    if (targetError) return error("Could not verify member access.", 500);
    if (!targetAccess) return error("Member not found in this gym.", 404);

    const { error: updateError } = await result.adminClient
      .from("user_gym_access")
      .update({ role })
      .eq("id", targetAccess.id)
      .eq("gym_id", gymId);
    if (updateError) return error("Could not update member role.", 500);

    return NextResponse.json({ ok: true, userId: targetUserId, role }, { headers: { "Cache-Control": "no-store" } });
  } catch (caught) {
    console.error("Member role update failed:", caught);
    return error("Could not update member role.", 500);
  }
}
