"use client";

import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

const LIVE_BASE = "https://live.gymcam.stream";
const REPLAY_BASE = "https://replay.gymcam.stream";

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const [gymOpen, setGymOpen] = useState(false);

  const [camera, setCamera] = useState("cam1");
  const [cameraName, setCameraName] = useState("Floor");

  const [replaySeconds, setReplaySeconds] = useState(30);
  const [replayUrl, setReplayUrl] = useState("");
  const [isReplay, setIsReplay] = useState(false);
  const [status, setStatus] = useState("● LIVE");
  const [replayMessage, setReplayMessage] = useState("");

  useEffect(() => {
    checkUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function checkUser() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    setUserEmail(user?.email ?? null);
  }

  async function signUp() {
    setMessage("Creating account...");

    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      setMessage(error.message);
    } else {
      setMessage(
        "Account created. Check your email if confirmation is required."
      );
    }
  }

  async function signIn() {
    setMessage("Signing in...");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setMessage(error.message);
    } else {
      setMessage("");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();

    setGymOpen(false);
    setIsReplay(false);
    setReplayUrl("");
    setStatus("● LIVE");
  }

  function selectCamera(stream: string, name: string) {
    setCamera(stream);
    setCameraName(name);

    setIsReplay(false);
    setReplayUrl("");
    setReplayMessage("");
    setStatus("● LIVE");
  }

  function formatReplayTime(seconds: number) {
    if (seconds < 60) {
      return `${seconds} seconds`;
    }

    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;

    if (remaining === 0) {
      return `${minutes} min`;
    }

    return `${minutes} min ${remaining} sec`;
  }

  async function loadReplay() {
    try {
      setReplayMessage("");
      setStatus("Loading replay...");

      const response = await fetch(
        `${REPLAY_BASE}/list?path=${camera}`
      );

      if (!response.ok) {
        throw new Error("Could not load replay list.");
      }

      const recordings = await response.json();

      if (!recordings || recordings.length === 0) {
        setReplayMessage("No replay available yet.");
        setStatus("● LIVE");
        return;
      }

      const latest = recordings[recordings.length - 1];

      const recordingStart = new Date(latest.start).getTime();

      const recordingEnd =
        recordingStart + latest.duration * 1000;

      const amount = Math.min(
        replaySeconds,
        latest.duration
      );

      const replayStart = new Date(
        recordingEnd - amount * 1000
      ).toISOString();

      const url =
        `${REPLAY_BASE}/get` +
        `?path=${camera}` +
        `&start=${encodeURIComponent(replayStart)}` +
        `&duration=${amount}` +
        `&format=mp4`;

      setReplayUrl(url);
      setIsReplay(true);
      setStatus(`⏪ REPLAY`);
    } catch (error) {
      console.error(error);

      setReplayMessage(
        error instanceof Error
          ? error.message
          : "Replay failed."
      );

      setStatus("Replay Error");
    }
  }

  function goLive() {
    setIsReplay(false);
    setReplayUrl("");
    setReplayMessage("");
    setStatus("● LIVE");
  }

  if (userEmail && gymOpen) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="mx-auto max-w-6xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
            <div>
              <h1 className="text-3xl font-bold">
                Test Gym
              </h1>

              <p className="text-sm text-zinc-400">
                {userEmail}
              </p>
            </div>

            <button
              onClick={() => {
                setGymOpen(false);
                goLive();
              }}
              className="rounded-xl bg-zinc-800 px-4 py-3"
            >
              Back
            </button>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() =>
                selectCamera("cam1", "Floor")
              }
              className={`rounded-xl px-5 py-3 font-medium ${
                camera === "cam1"
                  ? "bg-white text-black"
                  : "bg-zinc-800 text-white"
              }`}
            >
              Floor
            </button>

            <button
              onClick={() =>
                selectCamera("cam2", "High Bar")
              }
              className={`rounded-xl px-5 py-3 font-medium ${
                camera === "cam2"
                  ? "bg-white text-black"
                  : "bg-zinc-800 text-white"
              }`}
            >
              High Bar
            </button>
          </div>

          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold">
                {cameraName}
              </h2>

              <span
                className={`font-semibold ${
                  isReplay
                    ? "text-yellow-400"
                    : "text-red-500"
                }`}
              >
                {status}
              </span>
            </div>

            {!isReplay ? (
              <iframe
                key={camera}
                src={`${LIVE_BASE}/${camera}`}
                className="h-[500px] w-full rounded-xl border-0 bg-black"
                allow="autoplay; fullscreen"
              />
            ) : (
              <video
                key={replayUrl}
                src={replayUrl}
                controls
                autoPlay
                playsInline
                className="h-[500px] w-full rounded-xl bg-black"
              />
            )}
          </section>

          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h3 className="text-xl font-semibold">
              Replay
            </h3>

            <p className="mt-2 text-zinc-400">
              Choose how far back you want to replay.
            </p>

            <div className="mt-5 text-2xl font-semibold">
              {formatReplayTime(replaySeconds)}
            </div>

            <input
              type="range"
              min="10"
              max="120"
              step="5"
              value={replaySeconds}
              onChange={(e) =>
                setReplaySeconds(
                  Number(e.target.value)
                )
              }
              className="mt-5 w-full"
            />

            <div className="mt-1 flex justify-between text-sm text-zinc-500">
              <span>10 sec</span>
              <span>2 min</span>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={loadReplay}
                className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
              >
                ⏪ Load Replay
              </button>

              <button
                onClick={goLive}
                className="rounded-xl bg-zinc-800 px-5 py-3 font-semibold"
              >
                🔴 Back to Live
              </button>
            </div>

            {replayMessage && (
              <p className="mt-4 text-sm text-red-400">
                {replayMessage}
              </p>
            )}
          </section>
        </div>
      </main>
    );
  }

  if (userEmail) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="mx-auto max-w-5xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
            <div>
              <h1 className="text-3xl font-bold">
                Gym Replay
              </h1>

              <p className="text-sm text-zinc-400">
                {userEmail}
              </p>
            </div>

            <button
              onClick={signOut}
              className="rounded-xl bg-zinc-800 px-4 py-3"
            >
              Sign Out
            </button>
          </div>

          <section className="mt-8">
            <h2 className="text-2xl font-semibold">
              Your Gyms
            </h2>

            <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
              <h3 className="text-xl font-semibold">
                Test Gym
              </h3>

              <p className="mt-2 text-zinc-400">
                Floor · High Bar
              </p>

              <button
                onClick={() => setGymOpen(true)}
                className="mt-5 rounded-xl bg-white px-5 py-3 font-semibold text-black"
              >
                Open Gym
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-md p-6 pt-20">
        <h1 className="text-4xl font-bold">
          Gym Replay
        </h1>

        <p className="mt-2 text-zinc-400">
          Sign in to access your gym cameras.
        </p>

        <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) =>
              setEmail(e.target.value)
            }
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-4"
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) =>
              setPassword(e.target.value)
            }
            className="mt-3 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-4"
          />

          <button
            onClick={signIn}
            className="mt-4 w-full rounded-xl bg-white p-4 font-semibold text-black"
          >
            Sign In
          </button>

          <button
            onClick={signUp}
            className="mt-3 w-full rounded-xl bg-zinc-800 p-4 font-semibold"
          >
            Create Account
          </button>

          <p className="mt-4 text-sm text-zinc-400">
            {message}
          </p>
        </div>
      </div>
    </main>
  );
}