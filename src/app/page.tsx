"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { supabase } from "./lib/supabase";

const LIVE_BASE = "https://live.gymcam.stream";
const REPLAY_BASE = "https://replay.gymcam.stream";

type VideoMode = "live" | "delay" | "replay";

function LivePlayer({ camera }: { camera: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    setLoading(true);

    const src = `${LIVE_BASE}/${camera}/index.m3u8`;

    let hls: Hls | null = null;

    const jumpToLive = () => {
      const video = videoRef.current;

      if (!video) return;
      if (!video.seekable.length) return;

      const liveEdge = video.seekable.end(
        video.seekable.length - 1
      );

      const earliest = video.seekable.start(0);

      const distanceFromLive =
        liveEdge - video.currentTime;

      // Only jump forward if we fall too far behind.
      if (distanceFromLive > 4) {
        video.currentTime = Math.max(
          earliest,
          liveEdge - 2
        );
      }
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        maxLiveSyncPlaybackRate: 1.25,
      });

      hls.loadSource(src);
      hls.attachMedia(videoEl);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        window.setTimeout(() => {
          jumpToLive();

          videoRef.current
            ?.play()
            .catch(() => {});
        }, 500);
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Ignore normal recoverable HLS stalls.
        // Only log errors that actually stop playback.
        if (data.fatal) {
          console.warn(
            "Fatal Live HLS error:",
            data.type,
            data.details
          );
        }
      });
    } else if (
      videoEl.canPlayType(
        "application/vnd.apple.mpegurl"
      )
    ) {
      videoEl.src = src;

      const handleLoaded = () => {
        jumpToLive();

        videoRef.current
          ?.play()
          .catch(() => {});
      };

      videoEl.addEventListener(
        "loadedmetadata",
        handleLoaded,
        { once: true }
      );
    }

    const timer = window.setInterval(
      jumpToLive,
      1500
    );

    return () => {
      window.clearInterval(timer);

      if (hls) {
        hls.destroy();
      }

      const currentVideo =
        videoRef.current;

      if (currentVideo) {
        currentVideo.pause();
        currentVideo.removeAttribute("src");
        currentVideo.load();
      }
    };
  }, [camera]);

  return (
    <div className="relative">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black text-zinc-400">
          Starting camera...
        </div>
      )}

      <video
        ref={videoRef}
        controls
        autoPlay
        muted
        playsInline
        onPlaying={() => setLoading(false)}
        onWaiting={() => setLoading(true)}
        className="h-[500px] w-full rounded-xl bg-black"
      />
    </div>
  );
}

function DelayedPlayer({
  camera,
  delaySeconds,
}: {
  camera: string;
  delaySeconds: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const delayRef = useRef(delaySeconds);

  const [loading, setLoading] = useState(true);
  const [availableDelay, setAvailableDelay] =
    useState(0);

  const seekToDelay = (seconds: number) => {
    const video = videoRef.current;

    if (!video) return;
    if (!video.seekable.length) return;

    const start =
      video.seekable.start(0);

    const end =
      video.seekable.end(
        video.seekable.length - 1
      );

    const available =
      Math.max(0, end - start);

    setAvailableDelay(available);

    const wantedDelay =
      Math.min(seconds, available);

    video.currentTime =
      end - wantedDelay;
  };

  useEffect(() => {
    delayRef.current =
      delaySeconds;

    seekToDelay(delaySeconds);
  }, [delaySeconds]);

  useEffect(() => {
    const videoEl = videoRef.current;

    if (!videoEl) return;

    setLoading(true);

    const src =
      `${LIVE_BASE}/${camera}/index.m3u8`;

    let hls: Hls | null = null;

    const keepDelay = () => {
      const video =
        videoRef.current;

      if (!video) return;
      if (!video.seekable.length) return;

      const start =
        video.seekable.start(0);

      const end =
        video.seekable.end(
          video.seekable.length - 1
        );

      const available =
        Math.max(
          0,
          end - start
        );

      setAvailableDelay(
        available
      );

      const wantedDelay =
        Math.min(
          delayRef.current,
          available
        );

      const target =
        end - wantedDelay;

      const difference =
        Math.abs(
          video.currentTime -
            target
        );

      if (difference > 2) {
        video.currentTime =
          target;
      }
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
      });

      hls.loadSource(src);
      hls.attachMedia(videoEl);

      hls.on(
        Hls.Events.MANIFEST_PARSED,
        () => {
          window.setTimeout(() => {
            seekToDelay(
              delayRef.current
            );

            videoRef.current
              ?.play()
              .catch(() => {});
          }, 500);
        }
      );

      hls.on(
        Hls.Events.ERROR,
        (_event, data) => {
          if (data.fatal) {
            console.warn(
              "Fatal delayed HLS error:",
              data.type,
              data.details
            );
          }
        }
      );
    } else if (
      videoEl.canPlayType(
        "application/vnd.apple.mpegurl"
      )
    ) {
      videoEl.src = src;

      videoEl.addEventListener(
        "loadedmetadata",
        () => {
          seekToDelay(
            delayRef.current
          );

          videoRef.current
            ?.play()
            .catch(() => {});
        },
        { once: true }
      );
    }

    const timer =
      window.setInterval(
        keepDelay,
        1000
      );

    return () => {
      window.clearInterval(
        timer
      );

      if (hls) {
        hls.destroy();
      }

      const video =
        videoRef.current;

      if (video) {
        video.pause();
        video.removeAttribute(
          "src"
        );
        video.load();
      }
    };
  }, [camera]);

  return (
    <div>
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black text-zinc-400">
            Starting delayed stream...
          </div>
        )}

        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          playsInline
          onPlaying={() =>
            setLoading(false)
          }
          onWaiting={() =>
            setLoading(true)
          }
          className="h-[500px] w-full rounded-xl bg-black"
        />
      </div>

      <p className="mt-3 text-sm text-zinc-400">
        Available history:{" "}
        {Math.floor(
          availableDelay
        )}{" "}
        sec
      </p>
    </div>
  );
}

export default function Home() {
  const [email, setEmail] =
    useState("");

  const [password, setPassword] =
    useState("");

  const [message, setMessage] =
    useState("");

  const [userEmail, setUserEmail] =
    useState<string | null>(
      null
    );

  const [gymOpen, setGymOpen] =
    useState(false);

  const [camera, setCamera] =
    useState("cam1");

  const [
    cameraName,
    setCameraName,
  ] = useState("Floor");

  const [mode, setMode] =
    useState<VideoMode>("live");

  const [
    delaySeconds,
    setDelaySeconds,
  ] = useState(30);

  const [
    replaySeconds,
    setReplaySeconds,
  ] = useState(30);

  const [
    replayUrl,
    setReplayUrl,
  ] = useState("");

  const [
    replayMessage,
    setReplayMessage,
  ] = useState("");

  useEffect(() => {
    checkUser();

    const {
      data: { subscription },
    } =
      supabase.auth.onAuthStateChange(
        (_event, session) => {
          setUserEmail(
            session?.user
              ?.email ?? null
          );
        }
      );

    return () =>
      subscription.unsubscribe();
  }, []);

  async function checkUser() {
    const {
      data: { user },
    } =
      await supabase.auth.getUser();

    setUserEmail(
      user?.email ?? null
    );
  }

  async function signUp() {
    setMessage(
      "Creating account..."
    );

    const { error } =
      await supabase.auth.signUp(
        {
          email,
          password,
        }
      );

    if (error) {
      setMessage(
        error.message
      );
    } else {
      setMessage(
        "Account created. Check your email if confirmation is required."
      );
    }
  }

  async function forgotPassword() {
    if (!email) {
      setMessage(
        "Enter your email first."
      );

      return;
    }

    const { error } =
      await supabase.auth.resetPasswordForEmail(
        email,
        {
          redirectTo:
            "https://gymcam.stream/reset-password",
        }
      );

    if (error) {
      setMessage(
        error.message
      );
    } else {
      setMessage(
        "Password reset email sent."
      );
    }
  }

  async function signIn() {
    setMessage(
      "Signing in..."
    );

    const { error } =
      await supabase.auth.signInWithPassword(
        {
          email,
          password,
        }
      );

    if (error) {
      setMessage(
        error.message
      );
    } else {
      setMessage("");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();

    setGymOpen(false);
    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
  }

  function selectCamera(
    stream: string,
    name: string
  ) {
    setCamera(stream);
    setCameraName(name);

    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
  }

  function formatTime(
    seconds: number
  ) {
    if (seconds < 60) {
      return `${seconds} sec`;
    }

    const minutes =
      Math.floor(
        seconds / 60
      );

    const remaining =
      seconds % 60;

    if (
      remaining === 0
    ) {
      return `${minutes} min`;
    }

    return `${minutes} min ${remaining} sec`;
  }

  async function loadReplay() {
    try {
      setReplayMessage("");

      const response =
        await fetch(
          `${REPLAY_BASE}/list?path=${camera}`
        );

      if (!response.ok) {
        throw new Error(
          "Could not load replay list."
        );
      }

      const recordings =
        await response.json();

      if (
        !recordings ||
        recordings.length ===
          0
      ) {
        setReplayMessage(
          "No replay available yet."
        );

        return;
      }

      const latest =
        recordings[
          recordings.length - 1
        ];

      const recordingStart =
        new Date(
          latest.start
        ).getTime();

      const recordingEnd =
        recordingStart +
        latest.duration *
          1000;

      const amount =
        Math.min(
          replaySeconds,
          latest.duration
        );

      const replayStart =
        new Date(
          recordingEnd -
            amount * 1000
        ).toISOString();

      const url =
        `${REPLAY_BASE}/get` +
        `?path=${camera}` +
        `&start=${encodeURIComponent(
          replayStart
        )}` +
        `&duration=${amount}` +
        `&format=mp4`;

      setReplayUrl(url);
      setMode("replay");
    } catch (error) {
      setReplayMessage(
        error instanceof Error
          ? error.message
          : "Replay failed."
      );
    }
  }

  function goLive() {
    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
  }

  if (
    userEmail &&
    gymOpen
  ) {
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
                setGymOpen(
                  false
                );

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
                selectCamera(
                  "cam1",
                  "Floor"
                )
              }
              className={`rounded-xl px-5 py-3 font-medium ${
                camera ===
                "cam1"
                  ? "bg-white text-black"
                  : "bg-zinc-800 text-white"
              }`}
            >
              Floor
            </button>

            <button
              onClick={() =>
                selectCamera(
                  "cam2",
                  "High Bar"
                )
              }
              className={`rounded-xl px-5 py-3 font-medium ${
                camera ===
                "cam2"
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
                  mode === "live"
                    ? "text-red-500"
                    : mode === "delay"
                    ? "text-blue-400"
                    : "text-yellow-400"
                }`}
              >
                {mode ===
                  "live" &&
                  "● LIVE"}

                {mode ===
                  "delay" &&
                  `◷ ${formatTime(
                    delaySeconds
                  )} DELAY`}

                {mode ===
                  "replay" &&
                  "⏪ REPLAY"}
              </span>
            </div>

            {mode ===
              "live" && (
              <LivePlayer
                camera={
                  camera
                }
              />
            )}

            {mode ===
              "delay" && (
              <DelayedPlayer
                camera={
                  camera
                }
                delaySeconds={
                  delaySeconds
                }
              />
            )}

            {mode ===
              "replay" &&
              replayUrl && (
                <video
                  key={
                    replayUrl
                  }
                  src={
                    replayUrl
                  }
                  controls
                  autoPlay
                  playsInline
                  className="h-[500px] w-full rounded-xl bg-black"
                />
              )}
          </section>

          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">

            <h3 className="text-xl font-semibold">
              Delayed Live
            </h3>

            <p className="mt-2 text-zinc-400">
              Continuously watch
              the camera this far
              behind real time.
            </p>

            <div className="mt-5 text-2xl font-semibold">
              {formatTime(
                delaySeconds
              )}{" "}
              behind
            </div>

            <input
              type="range"
              min="5"
              max="300"
              step="5"
              value={
                delaySeconds
              }
              onChange={(e) =>
                setDelaySeconds(
                  Number(
                    e.target
                      .value
                  )
                )
              }
              className="mt-5 w-full"
            />

            <div className="mt-1 flex justify-between text-sm text-zinc-500">
              <span>
                5 sec
              </span>

              <span>
                5 min
              </span>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">

              <button
                onClick={() =>
                  setMode(
                    "delay"
                  )
                }
                className="rounded-xl bg-blue-500 px-5 py-3 font-semibold text-white"
              >
                ▶ Start
                Delayed Live
              </button>

              <button
                onClick={
                  goLive
                }
                className="rounded-xl bg-zinc-800 px-5 py-3 font-semibold"
              >
                🔴 Back to
                Live
              </button>
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">

            <h3 className="text-xl font-semibold">
              Replay
            </h3>

            <p className="mt-2 text-zinc-400">
              Choose how far
              back you want to
              replay.
            </p>

            <div className="mt-5 text-2xl font-semibold">
              {formatTime(
                replaySeconds
              )}
            </div>

            <input
              type="range"
              min="10"
              max="300"
              step="5"
              value={
                replaySeconds
              }
              onChange={(e) =>
                setReplaySeconds(
                  Number(
                    e.target
                      .value
                  )
                )
              }
              className="mt-5 w-full"
            />

            <div className="mt-1 flex justify-between text-sm text-zinc-500">
              <span>
                10 sec
              </span>

              <span>
                5 min
              </span>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">

              <button
                onClick={
                  loadReplay
                }
                className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
              >
                ⏪ Load Replay
              </button>

              <button
                onClick={
                  goLive
                }
                className="rounded-xl bg-zinc-800 px-5 py-3 font-semibold"
              >
                🔴 Back to
                Live
              </button>
            </div>

            {replayMessage && (
              <p className="mt-4 text-sm text-red-400">
                {
                  replayMessage
                }
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
              onClick={
                signOut
              }
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
                onClick={() =>
                  setGymOpen(
                    true
                  )
                }
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
          Sign in to access
          your gym cameras.
        </p>

        <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) =>
              setEmail(
                e.target.value
              )
            }
            className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-4"
          />

          <input
            type="password"
            placeholder="Password"
            value={
              password
            }
            onChange={(e) =>
              setPassword(
                e.target.value
              )
            }
            className="mt-3 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-4"
          />

          <button
            onClick={
              signIn
            }
            className="mt-4 w-full rounded-xl bg-white p-4 font-semibold text-black"
          >
            Sign In
          </button>

          <button
            onClick={
              forgotPassword
            }
            className="mt-3 w-full text-sm text-zinc-400 underline"
          >
            Forgot password?
          </button>

          <button
            onClick={
              signUp
            }
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