"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";

type ExportLog = {
  id: string;
  gym_id: string;
  camera_id: string | null;
  user_id: string | null;
  clip_seconds: number;
  watermark_id: string | null;
  status: string;
  created_at: string;
};

type ExportUser = {
  email: string;
  name: string | null;
};

type Camera = {
  id: string;
  name: string;
};

function BrandMark() {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 shadow-lg shadow-blue-500/20">
      <span className="text-xl font-black text-white">↻</span>
    </div>
  );
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;

  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function formatDate(value: string) {
  const date = new Date(value);

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortUserId(userId: string | null) {
  if (!userId) return "Unknown";
  return `${userId.slice(0, 8)}…`;
}

function statusLabel(status: string) {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusClasses(status: string) {
  if (
    status === "delivery_started" ||
    status === "shared" ||
    status === "saved"
  ) {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-300";
  }

  if (status === "failed") {
    return "border-red-500/20 bg-red-500/10 text-red-300";
  }

  if (status === "prepared") {
    return "border-blue-500/20 bg-blue-500/10 text-blue-300";
  }

  return "border-white/10 bg-white/[0.05] text-zinc-300";
}

function accountLabel(
  userId: string | null,
  exportUsers: Record<string, ExportUser>,
) {
  if (!userId) return "Unknown";

  return (
    exportUsers[userId]?.name ||
    exportUsers[userId]?.email ||
    shortUserId(userId)
  );
}

export default function ClipHistoryPage() {
  const [gymId, setGymId] = useState("");
  const [gymName, setGymName] = useState("Gym");
  const [userEmail, setUserEmail] = useState("");

  const [exportUsers, setExportUsers] = useState<
    Record<string, ExportUser>
  >({});

  const [logs, setLogs] = useState<ExportLog[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);

  const [cameraFilter, setCameraFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [userLookupWarning, setUserLookupWarning] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedGymId = params.get("gym") ?? "";

    if (!requestedGymId) {
      setError("No gym was selected.");
      setLoading(false);
      return;
    }

    setGymId(requestedGymId);
    void loadHistory(requestedGymId, false);
  }, []);

  async function loadExportUsers(currentGymId: string) {
    try {
      setUserLookupWarning("");

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setExportUsers({});
        return;
      }

      const response = await fetch(
        `/api/admin/export-users?gym=${encodeURIComponent(currentGymId)}`,
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        },
      );

      if (!response.ok) {
        console.warn(
          "Could not load export user names:",
          response.status,
        );

        setExportUsers({});
        setUserLookupWarning(
          "Account names could not be loaded. User IDs are shown instead.",
        );
        return;
      }

      const data = await response.json();

      setExportUsers(
        (data.users ?? {}) as Record<string, ExportUser>,
      );
    } catch (lookupError) {
      console.warn("Export user lookup failed:", lookupError);

      setExportUsers({});
      setUserLookupWarning(
        "Account names could not be loaded. User IDs are shown instead.",
      );
    }
  }

  async function loadHistory(
    currentGymId: string,
    isRefresh: boolean,
  ) {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    setError("");

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        window.location.href = "/";
        return;
      }

      setUserEmail(user.email ?? "");

      const { data: access, error: accessError } =
        await supabase
          .from("user_gym_access")
          .select("role")
          .eq("user_id", user.id)
          .eq("gym_id", currentGymId)
          .maybeSingle();

      if (accessError) {
        throw accessError;
      }

      if (!access || access.role !== "admin") {
        setError("You do not have admin access to this gym.");
        return;
      }

      const [gymResult, cameraResult, logResult] =
        await Promise.all([
          supabase
            .from("gyms")
            .select("name")
            .eq("id", currentGymId)
            .maybeSingle(),

          supabase
            .from("cameras")
            .select("id, name")
            .eq("gym_id", currentGymId)
            .order("name", { ascending: true }),

          supabase
            .from("video_downloads")
            .select(
              "id, gym_id, camera_id, user_id, clip_seconds, watermark_id, status, created_at",
            )
            .eq("gym_id", currentGymId)
            .order("created_at", { ascending: false })
            .limit(500),
        ]);

      if (gymResult.error) throw gymResult.error;
      if (cameraResult.error) throw cameraResult.error;
      if (logResult.error) throw logResult.error;

      setGymName(gymResult.data?.name ?? "Gym");
      setCameras((cameraResult.data ?? []) as Camera[]);
      setLogs((logResult.data ?? []) as ExportLog[]);

      // Important: account/email lookup is optional.
      // If it fails, the page still loads and falls back to user IDs.
      void loadExportUsers(currentGymId);
    } catch (caughtError) {
      console.error("Could not load clip history:", caughtError);
      setError("Could not load clip history.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const cameraNameMap = useMemo(
    () => new Map(cameras.map((camera) => [camera.id, camera.name])),
    [cameras],
  );

  const statuses = useMemo(
    () => Array.from(new Set(logs.map((log) => log.status))).sort(),
    [logs],
  );

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchesCamera =
        cameraFilter === "all" || log.camera_id === cameraFilter;

      const matchesStatus =
        statusFilter === "all" || log.status === statusFilter;

      return matchesCamera && matchesStatus;
    });
  }, [logs, cameraFilter, statusFilter]);

  const todayCount = useMemo(() => {
    const today = new Date().toDateString();

    return logs.filter(
      (log) =>
        new Date(log.created_at).toDateString() === today,
    ).length;
  }, [logs]);

  const totalClipSeconds = useMemo(
    () =>
      logs.reduce(
        (total, log) =>
          total + (Number(log.clip_seconds) || 0),
        0,
      ),
    [logs],
  );

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#070707] text-white">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-white" />
          <p className="mt-4 text-sm text-zinc-500">
            Loading clip history…
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#070707] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.08),_transparent_30%)]" />

      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#070707]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => {
                window.location.href = "/";
              }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-lg text-zinc-300 transition hover:bg-white/[0.08] hover:text-white"
              aria-label="Back to GymCam"
            >
              ←
            </button>

            <BrandMark />

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-bold sm:text-lg">
                  Clip History
                </h1>

                <span className="hidden rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-300 sm:inline-flex">
                  Admin
                </span>
              </div>

              <p className="truncate text-xs text-zinc-500">
                {gymName}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={refreshing || !gymId}
            onClick={() => void loadHistory(gymId, true)}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:text-sm"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="relative mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.07] p-5 text-sm text-red-300">
            <p className="font-semibold">{error}</p>

            <button
              type="button"
              onClick={() => {
                window.location.href = "/";
              }}
              className="mt-4 rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 font-semibold text-white"
            >
              Back to GymCam
            </button>
          </div>
        ) : (
          <>
            <section>
              <p className="text-sm font-medium text-zinc-500">
                Admin
              </p>

              <h2 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
                Export activity
              </h2>

              <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
                See when clips from {gymName} were shared or saved.
              </p>
            </section>

            {userLookupWarning && (
              <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-200">
                {userLookupWarning}
              </div>
            )}

            <section className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
                  Total exports
                </p>

                <p className="mt-2 text-3xl font-bold">
                  {logs.length}
                </p>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
                  Today
                </p>

                <p className="mt-2 text-3xl font-bold">
                  {todayCount}
                </p>
              </div>

              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
                  Clip time
                </p>

                <p className="mt-2 text-3xl font-bold">
                  {formatDuration(totalClipSeconds)}
                </p>
              </div>
            </section>

            <section className="mt-5 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-600">
                    Camera
                  </span>

                  <select
                    value={cameraFilter}
                    onChange={(event) =>
                      setCameraFilter(event.target.value)
                    }
                    className="w-full rounded-xl border border-white/10 bg-[#111] px-4 py-3 text-sm text-white outline-none"
                  >
                    <option value="all">All cameras</option>

                    {cameras.map((camera) => (
                      <option
                        key={camera.id}
                        value={camera.id}
                      >
                        {camera.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-600">
                    Status
                  </span>

                  <select
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value)
                    }
                    className="w-full rounded-xl border border-white/10 bg-[#111] px-4 py-3 text-sm text-white outline-none"
                  >
                    <option value="all">All statuses</option>

                    {statuses.map((status) => (
                      <option
                        key={status}
                        value={status}
                      >
                        {statusLabel(status)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="mt-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="font-bold">Activity</h3>

                <p className="text-xs text-zinc-600">
                  {filteredLogs.length}{" "}
                  {filteredLogs.length === 1
                    ? "clip"
                    : "clips"}
                </p>
              </div>

              {filteredLogs.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] px-6 py-14 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-xl">
                    ↗
                  </div>

                  <h4 className="mt-4 font-bold">
                    No clip activity yet
                  </h4>

                  <p className="mt-2 text-sm text-zinc-500">
                    Shared and saved clips will appear here.
                  </p>
                </div>
              ) : (
                <>
                  <div className="space-y-3 md:hidden">
                    {filteredLogs.map((log) => (
                      <article
                        key={log.id}
                        className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold">
                              {log.camera_id
                                ? cameraNameMap.get(
                                    log.camera_id,
                                  ) ?? "Camera"
                                : "Unknown camera"}
                            </p>

                            <p className="mt-1 text-xs text-zinc-500">
                              {formatDate(log.created_at)}
                            </p>
                          </div>

                          <span
                            className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusClasses(
                              log.status,
                            )}`}
                          >
                            {statusLabel(log.status)}
                          </span>
                        </div>

                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <div className="rounded-xl bg-black/30 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Clip
                            </p>

                            <p className="mt-1 text-sm font-semibold">
                              {formatDuration(
                                log.clip_seconds,
                              )}
                            </p>
                          </div>

                          <div className="rounded-xl bg-black/30 p-3">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                              Account
                            </p>

                            <p
                              className="mt-1 truncate text-xs text-zinc-300"
                              title={
                                log.user_id
                                  ? exportUsers[log.user_id]
                                      ?.email ??
                                    log.user_id
                                  : ""
                              }
                            >
                              {accountLabel(
                                log.user_id,
                                exportUsers,
                              )}
                            </p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>

                  <div className="hidden overflow-hidden rounded-2xl border border-white/[0.08] md:block">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[760px] text-left">
                        <thead className="border-b border-white/[0.08] bg-white/[0.035] text-[11px] uppercase tracking-wider text-zinc-600">
                          <tr>
                            <th className="px-5 py-4 font-semibold">
                              Time
                            </th>
                            <th className="px-5 py-4 font-semibold">
                              Camera
                            </th>
                            <th className="px-5 py-4 font-semibold">
                              Clip
                            </th>
                            <th className="px-5 py-4 font-semibold">
                              Account
                            </th>
                            <th className="px-5 py-4 font-semibold">
                              Status
                            </th>
                          </tr>
                        </thead>

                        <tbody className="divide-y divide-white/[0.06]">
                          {filteredLogs.map((log) => (
                            <tr
                              key={log.id}
                              className="bg-white/[0.02] transition hover:bg-white/[0.04]"
                            >
                              <td className="whitespace-nowrap px-5 py-4 text-sm text-zinc-400">
                                {formatDate(
                                  log.created_at,
                                )}
                              </td>

                              <td className="px-5 py-4 text-sm font-semibold text-white">
                                {log.camera_id
                                  ? cameraNameMap.get(
                                      log.camera_id,
                                    ) ?? "Camera"
                                  : "Unknown camera"}
                              </td>

                              <td className="px-5 py-4 text-sm text-zinc-300">
                                {formatDuration(
                                  log.clip_seconds,
                                )}
                              </td>

                              <td
                                className="px-5 py-4 text-xs text-zinc-400"
                                title={
                                  log.user_id
                                    ? exportUsers[
                                        log.user_id
                                      ]?.email ??
                                      log.user_id
                                    : ""
                                }
                              >
                                {accountLabel(
                                  log.user_id,
                                  exportUsers,
                                )}
                              </td>

                              <td className="px-5 py-4">
                                <span
                                  className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold ${statusClasses(
                                    log.status,
                                  )}`}
                                >
                                  {statusLabel(
                                    log.status,
                                  )}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </section>

            <p className="mt-6 text-xs text-zinc-700">
              Signed in as {userEmail}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
