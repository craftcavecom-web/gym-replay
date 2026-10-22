"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabase";

type Member = { userId: string; email: string; name: string | null; role: "athlete" | "admin"; createdAt: string };

export default function MembersPage() {
  const router = useRouter();
  const [gymId] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("gym") ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busyUserId, setBusyUserId] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");

  async function authHeaders() {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? { Authorization: `Bearer ${session.access_token}` } : null;
  }

  async function loadMembers(currentGymId: string) {
    setLoading(true); setMessage("");
    const headers = await authHeaders();
    if (!headers) { router.replace("/"); return; }
    const response = await fetch(`/api/admin/members?gym=${encodeURIComponent(currentGymId)}`, { headers });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Could not load gym members."); setLoading(false); return; }
    setMembers(data.members ?? []); setLoading(false);
  }

  useEffect(() => {
    if (!gymId) return;
    const timer = window.setTimeout(() => { void loadMembers(gymId); }, 0);
    return () => window.clearTimeout(timer);
  }, [gymId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id ?? ""));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function changeRole(member: Member, role: Member["role"]) {
    setBusyUserId(member.userId); setMessage("");
    const headers = await authHeaders();
    if (!headers) { router.replace("/"); return; }
    const response = await fetch("/api/admin/members", {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ gymId, userId: member.userId, role }),
    });
    const data = await response.json();
    if (!response.ok) setMessage(data.error ?? "Could not update role.");
    else setMembers((current) => current.map((item) => item.userId === member.userId ? { ...item, role } : item));
    setBusyUserId("");
  }

  return <main className="min-h-screen bg-[#070707] px-4 py-6 text-white sm:px-6 sm:py-8">
    <div className="mx-auto max-w-4xl">
      <button type="button" onClick={() => router.push("/")} className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-zinc-300">← Back to GymCam</button>
      <p className="mt-8 text-sm font-medium text-zinc-500">Admin</p><h1 className="mt-1 text-3xl font-bold">Gym members</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">Only an existing administrator of this gym can change a member’s role. Your own role cannot be changed here.</p>
      {message && <p className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-3 text-sm text-amber-200">{message}</p>}
      {!gymId ? <p className="mt-8 text-sm text-amber-200">No gym was selected.</p> : loading ? <p className="mt-8 text-sm text-zinc-500">Loading members…</p> : <section className="mt-6 overflow-hidden rounded-2xl border border-white/[0.08]">
        {members.map((member) => { const isSelf = member.userId === currentUserId; return <article key={member.userId} className="flex flex-col gap-4 border-b border-white/[0.08] p-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="truncate font-semibold">{member.name || member.email}</p><p className="truncate text-sm text-zinc-500">{member.name ? member.email : ""}</p></div>
          <div className="flex items-center gap-3"><span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold uppercase text-zinc-300">{member.role}</span>
            {isSelf ? <span className="text-xs font-medium text-zinc-500">Your account</span> : <><button type="button" disabled={busyUserId === member.userId || member.role === "admin"} onClick={() => void changeRole(member, "admin")} className="rounded-xl bg-blue-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">Make admin</button>
            <button type="button" disabled={busyUserId === member.userId || member.role === "athlete"} onClick={() => void changeRole(member, "athlete")} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm font-semibold text-zinc-200 disabled:opacity-40">Make athlete</button></>}
          </div>
        </article>; })}
      </section>}
    </div>
  </main>;
}
