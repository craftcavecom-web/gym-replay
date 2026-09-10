"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { supabase } from "./lib/supabase";

const WEBRTC_BASE = "https://webrtc.gymcam.stream";
const HLS_BASE = "https://live.gymcam.stream";
const REPLAY_BASE = "https://replay.gymcam.stream";

type VideoMode = "live" | "delay" | "replay";

type Gym = {
  id: string;
  name: string;
  slug: string;
  role?: string;
};

type Camera = {
  id: string;
  gym_id: string;
  name: string;
  stream_path: string;
};

type AccessRow = {
  gym_id: string;
  role: string;
};

function LivePlayer({
  camera,
}: {
  camera: string;
}) {
  return (
    <iframe
      key={camera}
      src={`${WEBRTC_BASE}/${camera}`}
      className="h-[500px] w-full rounded-xl border-0 bg-black"
      allow="autoplay; fullscreen"
    />
  );
}

function DelayedPlayer({
  camera,
  delaySeconds,
}: {
  camera: string;
  delaySeconds: number;
}) {
  const videoRef =
    useRef<HTMLVideoElement | null>(null);

  const delayRef =
    useRef(delaySeconds);

  const [loading, setLoading] =
    useState(true);

  const [
    availableDelay,
    setAvailableDelay,
  ] = useState(0);

  function seekToDelay(
    seconds: number
  ) {
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
        seconds,
        available
      );

    video.currentTime =
      end - wantedDelay;
  }

  useEffect(() => {
    delayRef.current =
      delaySeconds;

    seekToDelay(
      delaySeconds
    );
  }, [delaySeconds]);

  useEffect(() => {
    const videoEl =
      videoRef.current;

    if (!videoEl) return;

    setLoading(true);

    const src =
      `${HLS_BASE}/${camera}/index.m3u8`;

    let hls: Hls | null =
      null;

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

      if (
        difference > 2
      ) {
        video.currentTime =
          target;
      }
    };

    if (
      Hls.isSupported()
    ) {
      hls = new Hls({
        lowLatencyMode: false,
      });

      hls.loadSource(src);

      hls.attachMedia(
        videoEl
      );

      hls.on(
        Hls.Events.MANIFEST_PARSED,
        () => {
          window.setTimeout(
            () => {
              seekToDelay(
                delayRef.current
              );

              videoRef.current
                ?.play()
                .catch(
                  () => {}
                );
            },
            500
          );
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
      videoEl.src =
        src;

      videoEl.addEventListener(
        "loadedmetadata",
        () => {
          seekToDelay(
            delayRef.current
          );

          videoRef.current
            ?.play()
            .catch(
              () => {}
            );
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

  const [
    userEmail,
    setUserEmail,
  ] =
    useState<string | null>(
      null
    );

  const [
    userId,
    setUserId,
  ] =
    useState<string | null>(
      null
    );

  const [gyms, setGyms] =
    useState<Gym[]>([]);

  const [
    gymsLoading,
    setGymsLoading,
  ] =
    useState(false);

  const [
    selectedGym,
    setSelectedGym,
  ] =
    useState<Gym | null>(
      null
    );

  const [
    cameras,
    setCameras,
  ] =
    useState<Camera[]>([]);

  const [
    camerasLoading,
    setCamerasLoading,
  ] =
    useState(false);

  const [
    selectedCamera,
    setSelectedCamera,
  ] =
    useState<Camera | null>(
      null
    );

  const [mode, setMode] =
    useState<VideoMode>(
      "live"
    );

  const [
    delaySeconds,
    setDelaySeconds,
  ] =
    useState(30);

  const [
    replaySeconds,
    setReplaySeconds,
  ] =
    useState(30);

  const [
    replayUrl,
    setReplayUrl,
  ] =
    useState("");

  const [
    replayMessage,
    setReplayMessage,
  ] =
    useState("");

  useEffect(() => {
    checkUser();

    const {
      data: {
        subscription,
      },
    } =
      supabase.auth.onAuthStateChange(
        (_event, session) => {
          const user =
            session?.user;

          setUserEmail(
            user?.email ??
              null
          );

          setUserId(
            user?.id ??
              null
          );
        }
      );

    return () =>
      subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (userId) {
      loadGyms(
        userId
      );
    } else {
      setGyms([]);
    }
  }, [userId]);

  async function checkUser() {
    const {
      data: { user },
    } =
      await supabase.auth.getUser();

    setUserEmail(
      user?.email ??
        null
    );

    setUserId(
      user?.id ??
        null
    );
  }

  async function loadGyms(
    currentUserId: string
  ) {
    setGymsLoading(true);

    const {
      data: accessRows,
      error: accessError,
    } =
      await supabase
        .from(
          "user_gym_access"
        )
        .select(
          "gym_id, role"
        )
        .eq(
          "user_id",
          currentUserId
        );

    if (accessError) {
      console.warn(
        accessError
      );

      setMessage(
        "Could not load gym access."
      );

      setGymsLoading(
        false
      );

      return;
    }

    const access =
      (accessRows ??
        []) as AccessRow[];

    if (
      access.length === 0
    ) {
      setGyms([]);
      setGymsLoading(
        false
      );

      return;
    }

    const gymIds =
      access.map(
        (row) =>
          row.gym_id
      );

    const {
      data: gymRows,
      error: gymError,
    } =
      await supabase
        .from("gyms")
        .select(
          "id, name, slug"
        )
        .in(
          "id",
          gymIds
        );

    if (gymError) {
      console.warn(
        gymError
      );

      setMessage(
        "Could not load gyms."
      );

      setGymsLoading(
        false
      );

      return;
    }

    const roleMap =
      new Map(
        access.map(
          (row) => [
            row.gym_id,
            row.role,
          ]
        )
      );

    const finalGyms: Gym[] =
      (
        gymRows ?? []
      ).map((gym) => ({
        id: gym.id,
        name: gym.name,
        slug: gym.slug,
        role:
          roleMap.get(
            gym.id
          ) ??
          "athlete",
      }));

    setGyms(
      finalGyms
    );

    setGymsLoading(
      false
    );
  }

  async function openGym(
    gym: Gym
  ) {
    setSelectedGym(
      gym
    );

    setCameras([]);
    setSelectedCamera(
      null
    );

    setMode("live");

    setReplayUrl("");

    setReplayMessage("");

    setCamerasLoading(
      true
    );

    const {
      data,
      error,
    } =
      await supabase
        .from("cameras")
        .select(
          "id, gym_id, name, stream_path"
        )
        .eq(
          "gym_id",
          gym.id
        )
        .order(
          "created_at",
          {
            ascending:
              true,
          }
        );

    if (error) {
      console.warn(
        error
      );

      setReplayMessage(
        "Could not load cameras."
      );

      setCamerasLoading(
        false
      );

      return;
    }

    const cameraRows =
      (data ??
        []) as Camera[];

    setCameras(
      cameraRows
    );

    if (
      cameraRows.length >
      0
    ) {
      setSelectedCamera(
        cameraRows[0]
      );
    }

    setCamerasLoading(
      false
    );
  }

  function closeGym() {
    setSelectedGym(
      null
    );

    setSelectedCamera(
      null
    );

    setCameras([]);

    setMode("live");

    setReplayUrl("");

    setReplayMessage("");
  }

  function chooseCamera(
    camera: Camera
  ) {
    setSelectedCamera(
      camera
    );

    setMode("live");

    setReplayUrl("");

    setReplayMessage("");
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
        "Account created."
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

  async function signOut() {
    await supabase.auth.signOut();

    setUserEmail(
      null
    );

    setUserId(null);

    setSelectedGym(
      null
    );

    setSelectedCamera(
      null
    );

    setGyms([]);
    setCameras([]);

    setReplayUrl("");
  }

  function formatTime(
    seconds: number
  ) {
    if (
      seconds < 60
    ) {
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
    if (
      !selectedCamera
    ) {
      return;
    }

    try {
      setReplayMessage(
        ""
      );

      const path =
        selectedCamera.stream_path;

      const response =
        await fetch(
          `${REPLAY_BASE}/list?path=${path}`
        );

      if (
        !response.ok
      ) {
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
          recordings.length -
            1
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
            amount *
              1000
        ).toISOString();

      const url =
        `${REPLAY_BASE}/get` +
        `?path=${path}` +
        `&start=${encodeURIComponent(
          replayStart
        )}` +
        `&duration=${amount}` +
        `&format=mp4`;

      setReplayUrl(
        url
      );

      setMode(
        "replay"
      );
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
    selectedGym
  ) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="mx-auto max-w-6xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
            <div>
              <h1 className="text-3xl font-bold">
                {
                  selectedGym.name
                }
              </h1>

              <p className="text-sm text-zinc-400">
                {userEmail}
                {" · "}
                {
                  selectedGym.role
                }
              </p>
            </div>

            <button
              onClick={
                closeGym
              }
              className="rounded-xl bg-zinc-800 px-4 py-3"
            >
              Back
            </button>
          </div>

          {camerasLoading ? (
            <p className="mt-8 text-zinc-400">
              Loading
              cameras...
            </p>
          ) : cameras.length ===
            0 ? (
            <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
              No cameras
              are configured
              for this gym.
            </div>
          ) : (
            <>
              <div className="mt-6 flex flex-wrap gap-3">
                {cameras.map(
                  (
                    camera
                  ) => (
                    <button
                      key={
                        camera.id
                      }
                      onClick={() =>
                        chooseCamera(
                          camera
                        )
                      }
                      className={`rounded-xl px-5 py-3 font-medium ${
                        selectedCamera?.id ===
                        camera.id
                          ? "bg-white text-black"
                          : "bg-zinc-800 text-white"
                      }`}
                    >
                      {
                        camera.name
                      }
                    </button>
                  )
                )}
              </div>

              {selectedCamera && (
                <>
                  <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-2xl font-semibold">
                        {
                          selectedCamera.name
                        }
                      </h2>

                      <span
                        className={`font-semibold ${
                          mode ===
                          "live"
                            ? "text-red-500"
                            : mode ===
                              "delay"
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
                          selectedCamera.stream_path
                        }
                      />
                    )}

                    {mode ===
                      "delay" && (
                      <DelayedPlayer
                        camera={
                          selectedCamera.stream_path
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
                      Delayed
                      Live
                    </h3>

                    <p className="mt-2 text-zinc-400">
                      Continuously
                      watch the
                      camera this
                      far behind
                      real time.
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
                      onChange={(
                        e
                      ) =>
                        setDelaySeconds(
                          Number(
                            e
                              .target
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
                        Delayed
                        Live
                      </button>

                      <button
                        onClick={
                          goLive
                        }
                        className="rounded-xl bg-zinc-800 px-5 py-3 font-semibold"
                      >
                        🔴 Back
                        to Live
                      </button>
                    </div>
                  </section>

                  <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
                    <h3 className="text-xl font-semibold">
                      Replay
                    </h3>

                    <p className="mt-2 text-zinc-400">
                      Choose how
                      far back
                      you want
                      to replay.
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
                      onChange={(
                        e
                      ) =>
                        setReplaySeconds(
                          Number(
                            e
                              .target
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
                        ⏪ Load
                        Replay
                      </button>

                      <button
                        onClick={
                          goLive
                        }
                        className="rounded-xl bg-zinc-800 px-5 py-3 font-semibold"
                      >
                        🔴 Back
                        to Live
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
                </>
              )}
            </>
          )}
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

            {gymsLoading ? (
              <p className="mt-5 text-zinc-400">
                Loading
                gyms...
              </p>
            ) : gyms.length ===
              0 ? (
              <div className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
                <h3 className="text-xl font-semibold">
                  No gyms
                  assigned
                </h3>

                <p className="mt-2 text-zinc-400">
                  Your account
                  does not
                  currently
                  have access
                  to a gym.
                </p>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {gyms.map(
                  (gym) => (
                    <div
                      key={
                        gym.id
                      }
                      className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
                    >
                      <h3 className="text-xl font-semibold">
                        {
                          gym.name
                        }
                      </h3>

                      <p className="mt-2 capitalize text-zinc-400">
                        Role:{" "}
                        {
                          gym.role
                        }
                      </p>

                      <button
                        onClick={() =>
                          openGym(
                            gym
                          )
                        }
                        className="mt-5 rounded-xl bg-white px-5 py-3 font-semibold text-black"
                      >
                        Open
                        Gym
                      </button>
                    </div>
                  )
                )}
              </div>
            )}

            {message && (
              <p className="mt-5 text-sm text-red-400">
                {message}
              </p>
            )}
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
          Sign in to
          access your gym
          cameras.
        </p>

        <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) =>
              setEmail(
                e.target
                  .value
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
                e.target
                  .value
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
            Forgot
            password?
          </button>

          <button
            onClick={
              signUp
            }
            className="mt-3 w-full rounded-xl bg-zinc-800 p-4 font-semibold"
          >
            Create
            Account
          </button>

          <p className="mt-4 text-sm text-zinc-400">
            {message}
          </p>
        </div>
      </div>
    </main>
  );
}