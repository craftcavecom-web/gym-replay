"use client";

import { useEffect, useRef, useState } from "react";
import Hls, { ErrorTypes } from "hls.js";
import { supabase } from "./lib/supabase";

const WEBRTC_BASE = "https://webrtc.gymcam.stream";
const HLS_BASE = "https://live.gymcam.stream";

type VideoMode = "live" | "delay" | "replay";
type ExportFormat = "landscape" | "vertical";

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

type CameraSystemStatus = "running" | "stopped" | "starting" | "stopping" | "unknown" | "error";

type AccessRow = {
  gym_id: string;
  role: string;
};

const TIME_PRESETS = [10, 30, 60, 120, 300];

function formatTime(seconds: number) {
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;

  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function isMobileShareDevice() {
  if (typeof navigator === "undefined") return false;

  const mobileUserAgent = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const iPadDesktopMode = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

  return mobileUserAgent || iPadDesktopMode;
}

function BrandMark() {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500 shadow-lg shadow-blue-500/20">
      <span className="text-xl font-black text-white">↻</span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const labels: Record<CameraSystemStatus, string> = {
    running: "Running", stopped: "Stopped", starting: "Starting", stopping: "Stopping", unknown: "Unknown", error: "Error",
  };
  const normalized = (status in labels ? status : "unknown") as CameraSystemStatus;
  const active = normalized === "running";
  const transitional = normalized === "starting" || normalized === "stopping";
  const failed = normalized === "error";

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-zinc-300">
      <span
        className={`h-2 w-2 rounded-full ${
          active
            ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,.65)]"
            : failed
              ? "bg-red-400"
              : transitional
                ? "animate-pulse bg-blue-400"
                : normalized === "stopped"
                  ? "bg-zinc-600"
                  : "bg-amber-400"
        }`}
      />
      {labels[normalized]}
    </span>
  );
}

function LivePlayer({ camera, cameraName }: { camera: string; cameraName: string }) {
  const [state, setState] = useState<"connecting" | "connected" | "error">("connecting");

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-black/30">
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 text-xs font-semibold text-zinc-200 backdrop-blur">
        {state === "connected" ? `${cameraName} · Connected` : state === "error" ? `${cameraName} · Unable to connect` : `${cameraName} · Connecting…`}
      </div>
      {state !== "connected" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 px-6 text-center text-sm font-medium text-zinc-400">
          {state === "error" ? "The live player could not connect. Check the camera system and try another view." : "Connecting to live camera…"}
        </div>
      )}
      <iframe
        key={camera}
        src={`${WEBRTC_BASE}/${camera}`}
        title={`Live feed for ${camera}`}
        onLoad={() => setState("connected")}
        onError={() => setState("error")}
        className="aspect-video w-full border-0 bg-black"
        allow="autoplay; fullscreen; picture-in-picture"
        allowFullScreen
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
  const hlsRef = useRef<Hls | null>(null);
  const delayRef = useRef(delaySeconds);
  const initialSeekDoneRef = useRef(false);
  const lastHardCorrectionRef = useRef(0);
  const resyncRequestedRef = useRef(false);
  const recoveryAttemptsRef = useRef(0);
  const [status, setStatus] = useState<"preparing" | "connecting" | "playing" | "buffering" | "reconnecting" | "error">("preparing");
  const [error, setError] = useState("");
  const [availableDelay, setAvailableDelay] = useState(0);
  const [actualDelay, setActualDelay] = useState<number | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  function seekToDelay(seconds: number) {
    const video = videoRef.current;
    if (!video || !hasEnoughHistory(video, seconds)) return false;

    const start = video.seekable.start(0);
    const end = video.seekable.end(video.seekable.length - 1);
    const available = Math.max(0, end - start);

    setAvailableDelay(available);

    // Do not sit exactly on the first frame of the sliding HLS window. That
    // frame can disappear on the next playlist refresh and cause a stall.
    const windowSafetyMargin = Math.min(2, available / 4);
    const wantedDelay = Math.min(seconds, Math.max(0, available - windowSafetyMargin));
    const target = Math.max(start, end - wantedDelay);
    video.currentTime = target;
    video.playbackRate = 1;
    setActualDelay(Math.max(0, end - target));
    return true;
  }

  function hasEnoughHistory(video: HTMLVideoElement, seconds: number) {
    if (!video.seekable.length) return false;
    const start = video.seekable.start(0);
    const end = video.seekable.end(video.seekable.length - 1);
    const available = Math.max(0, end - start);
    const safetyMargin = Math.min(2, available / 4);
    return available - safetyMargin >= seconds - 1;
  }

  useEffect(() => {
    delayRef.current = delaySeconds;
    // HLS uses this only as a guardrail. Keep it beyond the requested offset
    // so a user selecting a longer delay does not trigger a live-edge catch-up.
    if (hlsRef.current) hlsRef.current.config.liveMaxLatencyDuration = delaySeconds + 30;

    // A user-selected delay change is an intentional reposition, but it must
    // not tear down the HLS connection and show a false reconnect.
    if (initialSeekDoneRef.current && seekToDelay(delaySeconds)) {
      lastHardCorrectionRef.current = Date.now();
    } else if (!videoRef.current || !hasEnoughHistory(videoRef.current, delaySeconds)) {
      // Keep the existing stream attached while the HLS window grows, but do
      // not say the newly requested offset is active before it can be reached.
      initialSeekDoneRef.current = false;
      setStatus("preparing");
    }
  }, [delaySeconds]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    setStatus("preparing");
    setError("");
    setActualDelay(null);
    initialSeekDoneRef.current = false;
    lastHardCorrectionRef.current = 0;
    resyncRequestedRef.current = false;
    recoveryAttemptsRef.current = 0;
    const src = `${HLS_BASE}/${camera}/index.m3u8`;
    let hls: Hls | null = null;

    const updateDelayStatus = () => {
      const video = videoRef.current;
      if (!video || !video.seekable.length) return;

      const start = video.seekable.start(0);
      const end = video.seekable.end(video.seekable.length - 1);
      const available = Math.max(0, end - start);

      setAvailableDelay(available);
      setActualDelay(Math.max(0, end - video.currentTime));
    };

    const startDelayedPlayback = () => {
      const video = videoRef.current;
      if (!video || !hasEnoughHistory(video, delayRef.current)) {
        setStatus("preparing");
        return;
      }

      if (!initialSeekDoneRef.current && !seekToDelay(delayRef.current)) return;
      initialSeekDoneRef.current = true;
      resyncRequestedRef.current = false;
      video.playbackRate = 1;
      video.play().catch(() => {});
    };

    const updateDelayedPlayback = () => {
      const video = videoRef.current;
      if (!video || !video.seekable.length) return;

      const end = video.seekable.end(video.seekable.length - 1);
      const available = Math.max(0, end - video.seekable.start(0));
      const measuredDelay = Math.max(0, end - video.currentTime);
      const now = Date.now();

      setAvailableDelay(available);
      setActualDelay(measuredDelay);

      if (!hasEnoughHistory(video, delayRef.current)) {
        video.playbackRate = 1;
        setStatus("preparing");
        return;
      }

      if (!initialSeekDoneRef.current) {
        startDelayedPlayback();
        return;
      }

      if (video.paused || video.seeking) {
        video.playbackRate = 1;
        return;
      }

      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        setStatus((current) => current === "error" || current === "reconnecting" ? current : "playing");
      }

      // Playback normally runs untouched at 1x. A single seek is reserved for
      // a genuine stall/reconnect or an offset that is clearly unusable.
      const hardTolerance = Math.max(20, delayRef.current * 0.35);
      if (
        (resyncRequestedRef.current || Math.abs(measuredDelay - delayRef.current) > hardTolerance) &&
        now - lastHardCorrectionRef.current >= 20_000
      ) {
        if (seekToDelay(delayRef.current)) {
          lastHardCorrectionRef.current = now;
          resyncRequestedRef.current = false;
          video.play().catch(() => {});
        }
      }
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
        // Leave room for the selected offset so hls.js does not catch up to
        // live on its own. The component performs the one deliberate seek.
        liveSyncDuration: 10,
        liveMaxLatencyDuration: delayRef.current + 30,
        maxLiveSyncPlaybackRate: 1,
        backBufferLength: Math.max(600, delayRef.current + 60),
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => setStatus("connecting"));

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        window.setTimeout(startDelayedPlayback, 250);
      });
      hls.on(Hls.Events.LEVEL_UPDATED, startDelayedPlayback);

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn("Fatal delayed HLS error:", data.type, data.details);
          if (recoveryAttemptsRef.current < 3 && data.type === ErrorTypes.NETWORK_ERROR) {
            recoveryAttemptsRef.current += 1;
            setStatus("reconnecting");
            setError("");
            // Reload the master manifest so an expired MediaMTX HLS session
            // receives a fresh session URL instead of retrying the same 401.
            initialSeekDoneRef.current = false;
            lastHardCorrectionRef.current = 0;
            resyncRequestedRef.current = true;
            hls?.stopLoad();
            hls?.loadSource(src);
          } else if (recoveryAttemptsRef.current < 3 && data.type === ErrorTypes.MEDIA_ERROR) {
            recoveryAttemptsRef.current += 1;
            setStatus("reconnecting");
            setError("");
            hls?.recoverMediaError();
          } else {
            setStatus("error");
            setError("The delayed stream could not be loaded. Check the camera connection and try again.");
          }
        }
      });
    } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = src;
      setStatus("connecting");
      videoEl.addEventListener(
        "loadedmetadata",
        startDelayedPlayback,
        { once: true },
      );
    } else {
      setStatus("error");
      setError("This browser cannot play the delayed stream.");
    }

    const statusTimer = window.setInterval(updateDelayStatus, 5_000);
    const playbackTimer = window.setInterval(updateDelayedPlayback, 5_000);

    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(playbackTimer);
      if (hlsRef.current === hls) hlsRef.current = null;
      hls?.destroy();

      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
    };
  }, [camera, retryKey]);

  const statusText = status === "preparing"
    ? "Preparing delayed stream…"
    : status === "connecting"
      ? "Connecting…"
      : status === "reconnecting"
        ? "Reconnecting…"
        : status === "buffering"
          ? "Buffering delayed stream…"
        : status === "playing"
          ? `Playing ~${formatTime(Math.round(actualDelay ?? delaySeconds))} behind live`
          : "Unable to load delayed stream";

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-black/30">
        {status !== "playing" && status !== "error" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 text-sm font-medium text-zinc-400 backdrop-blur-sm">
            {statusText}
          </div>
        )}

        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          playsInline
          onPlaying={() => {
            recoveryAttemptsRef.current = 0;
            setError("");
            const video = videoRef.current;
            setStatus(video && initialSeekDoneRef.current && hasEnoughHistory(video, delayRef.current) ? "playing" : "preparing");
          }}
          onError={() => {
            setStatus("error");
            setError("The delayed stream could not be loaded. Try again in a few seconds.");
          }}
          onWaiting={() => {
            resyncRequestedRef.current = true;
            setStatus((current) => current === "error" || current === "reconnecting" ? current : "buffering");
          }}
          onStalled={() => {
            resyncRequestedRef.current = true;
            setStatus((current) => current === "error" || current === "reconnecting" ? current : "buffering");
          }}
          className="aspect-video w-full bg-black object-contain"
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-sm">
        <p className={error ? "text-amber-300" : "text-zinc-400"}>{error || statusText}</p>
        {status === "error" && (
          <button
            type="button"
            onClick={() => setRetryKey((value) => value + 1)}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-semibold text-zinc-200"
          >
            Retry
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span>Available history</span>
        <span className="rounded-full bg-white/[0.05] px-2.5 py-1 font-medium text-zinc-300">
          {formatTime(Math.floor(availableDelay))}
        </span>
      </div>
    </div>
  );
}

function TimeControls({
  value,
  min,
  onChange,
}: {
  value: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-5 gap-2">
        {TIME_PRESETS.map((seconds) => {
          const disabled = seconds < min;
          const selected = value === seconds;

          return (
            <button
              key={seconds}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(seconds)}
              className={`rounded-xl border px-2 py-2.5 text-xs font-semibold transition sm:text-sm ${
                selected
                  ? "border-white bg-white text-black"
                  : "border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]"
              } disabled:cursor-not-allowed disabled:opacity-30`}
            >
              {formatTime(seconds)}
            </button>
          );
        })}
      </div>

      <input
        type="range"
        min={min}
        max="300"
        step="5"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-white"
      />

      <div className="flex justify-between text-[11px] font-medium uppercase tracking-wider text-zinc-600">
        <span>{formatTime(min)}</span>
        <span>5m</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [gyms, setGyms] = useState<Gym[]>([]);
  const [gymsLoading, setGymsLoading] = useState(false);
  const [selectedGym, setSelectedGym] = useState<Gym | null>(null);

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [camerasLoading, setCamerasLoading] = useState(false);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);

  const [mode, setMode] = useState<VideoMode>("live");
  const [delaySeconds, setDelaySeconds] = useState(30);
  const [replaySeconds, setReplaySeconds] = useState(30);
  const [replayUrl, setReplayUrl] = useState("");
  const [replayMessage, setReplayMessage] = useState("");
  const [replayLoading, setReplayLoading] = useState(false);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [sharePreparing, setSharePreparing] = useState(false);
  const [nativeShareAvailable, setNativeShareAvailable] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("landscape");
  const [cropX, setCropX] = useState(0.5);
  const [cropZoom, setCropZoom] = useState(1);

  const [joinCode, setJoinCode] = useState("");
  const [joinMessage, setJoinMessage] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);

  const [cameraControlStatus, setCameraControlStatus] = useState<CameraSystemStatus>("unknown");
  const [cameraControlMessage, setCameraControlMessage] = useState("");
  const [cameraControlBusy, setCameraControlBusy] = useState(false);
  const [streamReloadKey, setStreamReloadKey] = useState(0);

  async function checkUser() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    setUserEmail(user?.email ?? null);
    setUserId(user?.id ?? null);
  }

  async function loadGyms(currentUserId: string) {
    setGymsLoading(true);
    setMessage("");

    const { data: accessRows, error: accessError } = await supabase
      .from("user_gym_access")
      .select("gym_id, role")
      .eq("user_id", currentUserId);

    if (accessError) {
      console.warn(accessError);
      setMessage("Could not load your gyms.");
      setGymsLoading(false);
      return;
    }

    const access = (accessRows ?? []) as AccessRow[];

    if (access.length === 0) {
      setGyms([]);
      setGymsLoading(false);
      return;
    }

    const gymIds = access.map((row) => row.gym_id);

    const { data: gymRows, error: gymError } = await supabase
      .from("gyms")
      .select("id, name, slug")
      .in("id", gymIds);

    if (gymError) {
      console.warn(gymError);
      setMessage("Could not load your gyms.");
      setGymsLoading(false);
      return;
    }

    const roleMap = new Map(access.map((row) => [row.gym_id, row.role]));

    const finalGyms: Gym[] = (gymRows ?? []).map((gym) => ({
      id: gym.id,
      name: gym.name,
      slug: gym.slug,
      role: roleMap.get(gym.id) ?? "athlete",
    }));

    setGyms(finalGyms);
    const savedView = window.sessionStorage.getItem("gymcam:view");
    if (savedView && !selectedGym) {
      try {
        const saved = JSON.parse(savedView) as { gymId?: string };
        const gym = finalGyms.find((item) => item.id === saved.gymId);
        if (gym) void openGym(gym);
      } catch {
        window.sessionStorage.removeItem("gymcam:view");
      }
    }
    setGymsLoading(false);
  }

  async function joinGym() {
    if (!joinCode.trim()) {
      setJoinMessage("Enter your gym code first.");
      return;
    }

    if (!userId) {
      setJoinMessage("You must be signed in.");
      return;
    }

    setJoinBusy(true);
    setJoinMessage("Joining gym…");

    const { error } = await supabase.rpc("join_gym_with_code", {
      p_code: joinCode.trim(),
    });

    if (error) {
      console.warn(error);
      setJoinMessage("That gym code isn't valid.");
      setJoinBusy(false);
      return;
    }

    setJoinCode("");
    setJoinMessage("Gym added to your account.");
    await loadGyms(userId);
    setJoinBusy(false);
  }

  async function openGym(gym: Gym) {
    setSelectedGym(gym);
    setCameras([]);
    setSelectedCamera(null);
    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
    setCamerasLoading(true);

    if (gym.role === "admin") {
      void controlCameras("status", true, gym.id);
    }

    const { data, error } = await supabase
      .from("cameras")
      .select("id, gym_id, name, stream_path, sort_order")
      .eq("gym_id", gym.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) {
      console.warn(error);
      setCamerasLoading(false);
      return;
    }

    const cameraRows = (data ?? []) as Camera[];
    setCameras(cameraRows);

    const savedView = window.sessionStorage.getItem("gymcam:view");
    let savedCameraId: string | undefined;
    let savedMode: VideoMode | undefined;
    try {
      const saved = savedView ? JSON.parse(savedView) : null;
      savedCameraId = saved?.cameraId;
      savedMode = ["live", "delay", "replay"].includes(saved?.mode)
        ? saved.mode
        : undefined;
    } catch {}
    if (cameraRows.length > 0) {
      setSelectedCamera(cameraRows.find((camera) => camera.id === savedCameraId) ?? cameraRows[0]);
      if (savedMode) setMode(savedMode);
    }
    setCamerasLoading(false);
  }

  function closeGym() {
    setSelectedGym(null);
    setSelectedCamera(null);
    setCameras([]);
    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
  }

  function chooseCamera(camera: Camera) {
    setSelectedCamera(camera);
    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
  }

  async function signUp() {
    if (!email || !password) {
      setMessage("Enter an email and password.");
      return;
    }

    setAuthBusy(true);
    setMessage("Creating account…");

    const { error } = await supabase.auth.signUp({ email, password });

    setMessage(error ? error.message : "Account created. Check your email if confirmation is required.");
    setAuthBusy(false);
  }

  async function signIn() {
    if (!email || !password) {
      setMessage("Enter your email and password.");
      return;
    }

    setAuthBusy(true);
    setMessage("Signing in…");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setMessage(error ? error.message : "");
    setAuthBusy(false);
  }

  async function forgotPassword() {
    if (!email) {
      setMessage("Enter your email first.");
      return;
    }

    setAuthBusy(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "https://gymcam.stream/reset-password",
    });

    setMessage(error ? error.message : "Password reset email sent.");
    setAuthBusy(false);
  }

  async function signOut() {
    await supabase.auth.signOut();

    setUserEmail(null);
    setUserId(null);
    setSelectedGym(null);
    setSelectedCamera(null);
    setGyms([]);
    setCameras([]);
    setReplayUrl("");
    setJoinCode("");
    setJoinMessage("");
    window.sessionStorage.removeItem("gymcam:view");
  }
  async function requestSignedMediaUrl(
    endpoint: "latest" | "export",
  ) {
    if (!selectedGym || !selectedCamera) {
      throw new Error("Select a gym and camera first.");
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      throw new Error("Not signed in.");
    }

    const response = await fetch("/api/replay-url", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        gymId: selectedGym.id,
        cameraId: selectedCamera.id,
        endpoint,
        duration: replaySeconds,
        ...(endpoint === "export"
          ? {
              format: exportFormat,
              cropX,
              zoom: cropZoom,
            }
          : {}),
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.url) {
      throw new Error(data.error ?? "Could not authorize replay request.");
    }

    return data.url as string;
  }

  useEffect(() => {
    if (!replayUrl || !selectedGym || !selectedCamera) {
      const resetTimer = window.setTimeout(() => {
        setShareFile(null);
        setSharePreparing(false);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }

    let cancelled = false;

    // Do not start a costly Pi export while the user is still moving a crop slider.
    const timer = window.setTimeout(() => {
      async function prepareShareFile() {
        try {
          setSharePreparing(true);
          setShareFile(null);

          const exportUrl = await requestSignedMediaUrl("export");

          if (cancelled) return;

          const response = await fetch(exportUrl);

          if (!response.ok) {
            throw new Error(`Replay fetch failed with ${response.status}`);
          }

          const blob = await response.blob();

          if (!blob.size) {
            throw new Error("Replay file was empty.");
          }

          const safeCameraName = (selectedCamera?.name ?? "clip")
            .replace(/[^a-z0-9-_]+/gi, "-")
            .replace(/^-+|-+$/g, "") || "clip";

          const formatSuffix = exportFormat === "vertical" ? "-vertical" : "";

          const file = new File(
            [blob],
            `gymcam-${safeCameraName}${formatSuffix}.mp4`,
            { type: "video/mp4" },
          );

          if (!cancelled) {
            setShareFile(file);
          }
        } catch (error) {
          console.error("Share preparation error:", error);

          if (!cancelled) {
            setShareFile(null);
            setReplayMessage(
              "Replay works, but the clip could not be prepared for sharing yet.",
            );
          }
        } finally {
          if (!cancelled) {
            setSharePreparing(false);
          }
        }
      }

      void prepareShareFile();
    }, 800);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    replayUrl,
    selectedGym?.id,
    selectedCamera?.id,
    selectedCamera?.name,
    exportFormat,
    cropX,
    cropZoom,
    replaySeconds,
  ]);

  async function loadReplay() {
    if (!selectedGym || !selectedCamera) return;

    setReplayMessage("");
    setReplayLoading(true);
    setShareFile(null);

    try {
      const url = await requestSignedMediaUrl("latest");
      setReplayUrl(url);
      setMode("replay");
    } catch (error) {
      console.error("Replay authorization error:", error);
      setReplayLoading(false);
      setReplayUrl("");
      setReplayMessage(
        error instanceof Error ? error.message : "Could not authorize replay.",
      );
    }
  }

  function downloadClip(file: File) {
    const downloadUrl = URL.createObjectURL(file);
    const link = document.createElement("a");

    link.href = downloadUrl;
    link.download = file.name;
    link.style.display = "none";

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  }

  async function logExport(status: "shared" | "saved") {
    if (!selectedGym || !selectedCamera) return;

    const { error } = await supabase.rpc("log_video_export", {
      p_gym_id: selectedGym.id,
      p_camera_id: selectedCamera.id,
      p_clip_seconds: replaySeconds,
      p_status: status,
    });

    if (error) {
      console.warn("Could not log export:", error);
      setReplayMessage(
        "Clip was delivered, but GymCam could not add it to Clip History.",
      );
    }
  }

  async function shareReplay() {
    if (!shareFile) {
      setReplayMessage("Clip is still preparing. Try again in a moment.");
      return;
    }

    setReplayMessage("");

    const canShareFile =
      nativeShareAvailable &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ files: [shareFile] });

    if (!canShareFile) {
      downloadClip(shareFile);
      await logExport("saved");
      return;
    }

    try {
      await navigator.share({
        files: [shareFile],
        title: "GymCam Clip",
      });

      await logExport("shared");
    } catch (error) {
      const shareError = error as Error;

      if (shareError.name === "AbortError") {
        return;
      }

      console.error("Native share failed, saving clip instead:", error);
      downloadClip(shareFile);
      await logExport("saved");
    }
  }

  async function controlCameras(
    action: "start" | "stop" | "status",
    quiet = false,
    gymId = selectedGym?.id,
  ) {
    try {
      setCameraControlBusy(true);

      if (action === "start") setCameraControlStatus("starting");
      if (action === "stop") setCameraControlStatus("stopping");

      if (!quiet) {
        setCameraControlMessage(
          action === "start"
            ? "Starting camera system…"
            : action === "stop"
              ? "Stopping camera system…"
              : "Checking status…",
        );
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setCameraControlStatus("error");
        setCameraControlMessage("Not signed in.");
        return;
      }

      if (!gymId) {
        setCameraControlStatus("error");
        setCameraControlMessage("Choose a gym first.");
        return;
      }

      const requestControl = async (requestedAction: "start" | "stop" | "status") => {
        const isStatus = requestedAction === "status";
        const response = await fetch(
          isStatus ? `/api/camera-control?gymId=${encodeURIComponent(gymId)}` : "/api/camera-control",
          {
            method: isStatus ? "GET" : "POST",
            headers: {
              ...(isStatus ? {} : { "Content-Type": "application/json" }),
              Authorization: `Bearer ${session.access_token}`,
            },
            ...(isStatus ? {} : { body: JSON.stringify({ action: requestedAction, gymId }) }),
            cache: "no-store",
          },
        );
        const data = await response.json().catch(() => ({}));
        return { response, data };
      };

      const normalizeStatus = (data: { status?: unknown; state?: unknown }): CameraSystemStatus => {
        const rawStatus = data.status ?? data.state;
        const aliases: Record<string, CameraSystemStatus> = {
          active: "running", inactive: "stopped", online: "running", offline: "stopped",
          activating: "starting", deactivating: "stopping", running: "running", stopped: "stopped",
          starting: "starting", stopping: "stopping", failed: "error", error: "error",
        };
        return typeof rawStatus === "string" ? aliases[rawStatus.toLowerCase()] ?? "unknown" : "unknown";
      };

      let { response, data } = await requestControl(action);

      if (!response.ok) {
        setCameraControlStatus("error");
        setCameraControlMessage(data.error ?? "Camera control failed.");
        return;
      }

      let status = normalizeStatus(data);
      const targetStatus = action === "start" ? "running" : action === "stop" ? "stopped" : null;
      if (targetStatus) {
        setCameraControlStatus(action === "start" ? "starting" : "stopping");
        for (let attempt = 0; status !== targetStatus && attempt < 30; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          ({ response, data } = await requestControl("status"));
          if (!response.ok) {
            setCameraControlStatus("error");
            setCameraControlMessage(data.error ?? "Camera control failed while confirming status.");
            return;
          }
          status = normalizeStatus(data);
          if (status === "error") break;
        }
        if (status !== targetStatus) {
          setCameraControlStatus(status === "error" ? "error" : "unknown");
          setCameraControlMessage(`Camera system did not confirm it was ${targetStatus}.`);
          return;
        }
      }

      setCameraControlStatus(status);
      if (action === "start" && status === "running") {
        setStreamReloadKey((value) => value + 1);
      }

      if (!quiet) {
        setCameraControlMessage(
          data.message ?? (status === "starting" ? "Camera system is starting…" : status === "stopping" ? "Camera system is stopping…" : status === "running" ? "Camera system is running." : status === "stopped" ? "Camera system is stopped." : status === "error" ? "Camera system reported an error." : "Status could not be confirmed."),
        );
      }
    } catch (error) {
      console.error(error);
      setCameraControlStatus("error");
      setCameraControlMessage("Could not contact the camera system.");
    } finally {
      setCameraControlBusy(false);
    }
  }

  function goLive() {
    setMode("live");
    setReplayUrl("");
    setReplayMessage("");
  }

  useEffect(() => {
    const checkTimer = window.setTimeout(() => void checkUser(), 0);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      setUserEmail(user?.email ?? null);
      setUserId(user?.id ?? null);
    });

    return () => {
      window.clearTimeout(checkTimer);
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setNativeShareAvailable(
        isMobileShareDevice() && typeof navigator.share === "function",
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (userId) void loadGyms(userId);
      else setGyms([]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [userId]);

  useEffect(() => {
    if (!selectedGym || !selectedCamera) return;
    window.sessionStorage.setItem(
      "gymcam:view",
      JSON.stringify({ gymId: selectedGym.id, cameraId: selectedCamera.id, mode }),
    );
  }, [selectedGym, selectedCamera, mode]);

  if (userEmail && selectedGym) {
    const isAdmin = selectedGym.role === "admin";

    return (
      <main className="min-h-screen bg-[#070707] text-white">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.06),_transparent_28%)]" />

        <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#070707]/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={closeGym}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-lg text-zinc-300 transition hover:bg-white/[0.08] hover:text-white"
                aria-label="Back to gyms"
              >
                ←
              </button>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-base font-bold sm:text-lg">{selectedGym.name}</h1>
                  <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 sm:inline-flex">
                    {selectedGym.role}
                  </span>
                </div>
                <p className="truncate text-xs text-zinc-500">GymCam</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {isAdmin && <StatusDot status={cameraControlStatus} />}
            </div>
          </div>
        </header>

        <div className="relative mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-7">
          {isAdmin && (
            <section className="mb-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.035]">
              <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">Camera system</p>
                    <StatusDot status={cameraControlStatus} />
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">
                    Turn the system on outside scheduled hours. Individual cameras wake when viewed.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <button
                    type="button"
                    disabled={cameraControlBusy || cameraControlStatus !== "stopped"}
                    onClick={() => controlCameras("start")}
                    className="rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Start system
                  </button>
                  <button
                    type="button"
                    disabled={cameraControlBusy || cameraControlStatus !== "running"}
                    onClick={() => controlCameras("stop")}
                    className="rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Stop system
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = `/admin/clip-history?gym=${selectedGym.id}`;
                    }}
                    className="col-span-2 rounded-xl border border-blue-400/20 bg-blue-500/10 px-4 py-2.5 text-sm font-semibold text-blue-200 transition hover:bg-blue-500/15 sm:col-auto"
                  >
                    Clip History
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = `/admin/members?gym=${selectedGym.id}`;
                    }}
                    className="col-span-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.09] sm:col-auto"
                  >
                    Members
                  </button>
                  <button
                    type="button"
                    onClick={() => { window.location.href = `/admin/cameras?gym=${selectedGym.id}`; }}
                    className="col-span-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.09] sm:col-auto"
                  >
                    Cameras
                  </button>
                </div>
              </div>

              {cameraControlMessage && (
                <div className="border-t border-white/[0.07] px-4 py-3 text-xs text-zinc-400 sm:px-5">
                  {cameraControlMessage}
                </div>
              )}
            </section>
          )}

          {camerasLoading ? (
            <div className="flex min-h-[55vh] items-center justify-center">
              <div className="text-center">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-white" />
                <p className="mt-4 text-sm text-zinc-500">Loading cameras…</p>
              </div>
            </div>
          ) : cameras.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.025] px-6 py-16 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-xl">⌁</div>
              <h2 className="mt-4 text-lg font-bold">No cameras yet</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
                This gym doesn&apos;t have any cameras configured yet.
              </p>
            </div>
          ) : (
            <>
              <div className="-mx-4 mb-5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
                <div className="flex min-w-max gap-2">
                  {cameras.map((camera) => {
                    const active = selectedCamera?.id === camera.id;

                    return (
                      <button
                        key={camera.id}
                        type="button"
                        onClick={() => chooseCamera(camera)}
                        className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
                          active
                            ? "bg-white text-black shadow-lg shadow-white/10"
                            : "border border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-white"
                        }`}
                      >
                        {camera.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedCamera && (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                  <section className="min-w-0">
                    <div className="mb-3 flex items-end justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-600">
                          Camera
                        </p>
                        <h2 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
                          {selectedCamera.name}
                        </h2>
                      </div>

                      <span
                        className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                          mode === "live"
                            ? "bg-red-500/10 text-red-400"
                            : mode === "delay"
                              ? "bg-blue-500/10 text-blue-400"
                              : "bg-amber-500/10 text-amber-300"
                        }`}
                      >
                        {mode === "live"
                          ? "● LIVE"
                          : mode === "delay"
                            ? `${formatTime(delaySeconds)} DELAY`
                            : "REPLAY"}
                      </span>
                    </div>

                    {mode === "live" && <LivePlayer key={`${selectedCamera.id}:${streamReloadKey}`} camera={selectedCamera.stream_path} cameraName={selectedCamera.name} />}

                    {mode === "delay" && (
                      <DelayedPlayer
                        key={`${selectedCamera.id}:${streamReloadKey}`}
                        camera={selectedCamera.stream_path}
                        delaySeconds={delaySeconds}
                      />
                    )}

                    {mode === "replay" && (
                      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl shadow-black/30">
                        {replayUrl ? (
                          exportFormat === "vertical" ? (
                            <div className="flex justify-center bg-black p-3 sm:p-5">
                              <div className="relative aspect-[9/16] max-h-[72vh] w-auto overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
                                <video
                                  key={`${replayUrl}-vertical-preview`}
                                  src={replayUrl}
                                  controls
                                  autoPlay
                                  playsInline
                                  preload="metadata"
                                  onLoadedData={() => setReplayLoading(false)}
                                  onCanPlay={() => setReplayLoading(false)}
                                  onError={() => {
                                    setReplayLoading(false);
                                    setReplayMessage(
                                      "Replay could not be loaded. Try a shorter clip or try again in a few seconds."
                                    );
                                  }}
                                  className="h-full w-full bg-black object-cover transition-transform duration-75"
                                  style={{
                                    objectPosition: `${cropX * 100}% 50%`,
                                    transform: `scale(${cropZoom})`,
                                    transformOrigin: `${cropX * 100}% 50%`,
                                  }}
                                />
                                <div className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/15" />
                              </div>
                            </div>
                          ) : (
                            <video
                              key={replayUrl}
                              src={replayUrl}
                              controls
                              autoPlay
                              playsInline
                              preload="metadata"
                              onLoadedData={() => setReplayLoading(false)}
                              onCanPlay={() => setReplayLoading(false)}
                              onError={() => {
                                setReplayLoading(false);
                                setReplayMessage(
                                  "Replay could not be loaded. Try a shorter clip or try again in a few seconds."
                                );
                              }}
                              className="aspect-video w-full bg-black object-contain"
                            />
                          )
                        ) : (
                          <div className="flex aspect-video items-center justify-center px-6 text-center">
                            <div>
                              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-xl">
                                ↶
                              </div>

                              <p className="mt-4 font-semibold">
                                Ready for replay
                              </p>

                              <p className="mt-1 text-sm text-zinc-500">
                                Choose a replay length and load the latest clip.
                              </p>
                            </div>
                          </div>
                        )}

                        {replayLoading && replayUrl && (
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                            <div className="rounded-full border border-white/10 bg-zinc-900/90 px-5 py-3 text-sm font-medium text-zinc-200">
                              Preparing replay…
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {replayMessage && (
                      <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300">
                        {replayMessage}
                      </div>
                    )}
                  </section>

                  <aside className="lg:sticky lg:top-24 lg:self-start">
                    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-2">
                      <div className="grid grid-cols-3 gap-1">
                        {([
                          ["live", "Live"],
                          ["delay", "Delay"],
                          ["replay", "Replay"],
                        ] as [VideoMode, string][]).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => {
                              if (value === "live") goLive();
                              else {
                                setMode(value);
                                if (value !== "replay") setReplayMessage("");
                              }
                            }}
                            className={`rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                              mode === value
                                ? "bg-white text-black"
                                : "text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                            }`}
                            aria-pressed={mode === value}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5">
                      {mode === "live" && (
                        <div>
                          <p className="text-sm font-bold">Live view</p>
                          <p className="mt-2 text-sm leading-6 text-zinc-500">
                            Lowest-latency view for coaching and immediate feedback.
                          </p>
                          <div className="mt-5 flex items-center gap-2 rounded-xl border border-red-500/10 bg-red-500/[0.06] px-3 py-3 text-xs text-red-300">
                            <span className="h-2 w-2 rounded-full bg-red-400" />
                            Streaming live
                          </div>
                        </div>
                      )}

                      {mode === "delay" && (
                        <div>
                          <div className="mb-5 flex items-start justify-between gap-4">
                            <div>
                              <p className="text-sm font-bold">Delayed live</p>
                              <p className="mt-1 text-xs leading-5 text-zinc-500">
                                Watch continuously behind real time.
                              </p>
                            </div>
                            <span className="rounded-lg bg-blue-500/10 px-2.5 py-1.5 text-sm font-bold text-blue-300">
                              {formatTime(delaySeconds)}
                            </span>
                          </div>

                          <TimeControls value={delaySeconds} min={5} onChange={setDelaySeconds} />

                          <button
                            type="button"
                            onClick={goLive}
                            className="mt-5 w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.09]"
                          >
                            Return to live
                          </button>
                        </div>
                      )}

                      {mode === "replay" && (
                        <div>
                          <div className="mb-5 flex items-start justify-between gap-4">
                            <div>
                              <p className="text-sm font-bold">Instant replay</p>
                              <p className="mt-1 text-xs leading-5 text-zinc-500">
                                Replay the most recent footage.
                              </p>
                            </div>
                            <span className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-sm font-bold text-amber-300">
                              {formatTime(replaySeconds)}
                            </span>
                          </div>

                          <TimeControls value={replaySeconds} min={10} onChange={setReplaySeconds} />

                          <div className="mt-5">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-600">
                                Export format
                              </p>
                              <span className="text-[11px] text-zinc-600">
                                {exportFormat === "vertical" ? "9:16" : "16:9"}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/[0.08] bg-black/20 p-1.5">
                              <button
                                type="button"
                                onClick={() => setExportFormat("landscape")}
                                aria-pressed={exportFormat === "landscape"}
                                className={`rounded-lg px-3 py-2.5 text-xs font-semibold transition ${
                                  exportFormat === "landscape"
                                    ? "bg-white text-black"
                                    : "text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                                }`}
                              >
                                Landscape 16:9
                              </button>

                              <button
                                type="button"
                                onClick={() => setExportFormat("vertical")}
                                aria-pressed={exportFormat === "vertical"}
                                className={`rounded-lg px-3 py-2.5 text-xs font-semibold transition ${
                                  exportFormat === "vertical"
                                    ? "bg-white text-black"
                                    : "text-zinc-400 hover:bg-white/[0.06] hover:text-white"
                                }`}
                              >
                                Vertical 9:16
                              </button>
                            </div>

                            <p className="mt-2 text-[11px] leading-5 text-zinc-600">
                              Vertical keeps the camera recording landscape and crops the export for Reels, TikTok, and Shorts.
                            </p>

                            {exportFormat === "vertical" && (
                              <div className="mt-4 rounded-xl border border-white/[0.08] bg-black/20 p-4">
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-xs font-semibold text-zinc-300">Crop position</p>
                                    <p className="mt-1 text-[11px] leading-5 text-zinc-600">
                                      Move the crop left or right and zoom. The replay preview updates instantly.
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setCropX(0.5);
                                      setCropZoom(1);
                                    }}
                                  className="min-h-10 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-semibold text-zinc-400 transition hover:bg-white/[0.08] hover:text-white"
                                  >
                                    Reset
                                  </button>
                                </div>

                                <label className="mt-4 block">
                                  <div className="mb-2 flex items-center justify-between text-[11px]">
                                    <span className="text-zinc-500">Left ↔ Right</span>
                                    <span className="font-semibold text-zinc-300">{Math.round(cropX * 100)}%</span>
                                  </div>
                                  <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    step="1"
                                    value={Math.round(cropX * 100)}
                                    onChange={(event) => setCropX(Number(event.target.value) / 100)}
                                    className="w-full accent-blue-500"
                                  />
                                </label>

                                <label className="mt-4 block">
                                  <div className="mb-2 flex items-center justify-between text-[11px]">
                                    <span className="text-zinc-500">Zoom</span>
                                    <span className="font-semibold text-zinc-300">{cropZoom.toFixed(2)}×</span>
                                  </div>
                                  <input
                                    type="range"
                                    min="1"
                                    max="2"
                                    step="0.05"
                                    value={cropZoom}
                                    onChange={(event) => setCropZoom(Number(event.target.value))}
                                    className="w-full accent-blue-500"
                                  />
                                </label>
                              </div>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={loadReplay}
                            className="mt-5 w-full rounded-xl bg-white px-4 py-3 text-sm font-bold text-black transition hover:bg-zinc-200"
                          >
                            Load latest replay
                          </button>

                          <button
                            type="button"
                            onClick={shareReplay}
                            disabled={!shareFile || sharePreparing}
                            className="mt-2 w-full rounded-xl bg-blue-500 px-5 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {sharePreparing
                              ? "Preparing clip…"
                              : nativeShareAvailable
                                ? "Share Clip"
                                : "Save Clip"}
                          </button>

                          <button
                            type="button"
                            onClick={goLive}
                            className="mt-2 w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-white/[0.09]"
                          >
                            Return to live
                          </button>
                        </div>
                      )}
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    );
  }

  if (userEmail) {
    return (
      <main className="min-h-screen bg-[#070707] text-white">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.07),_transparent_30%)]" />

        <header className="border-b border-white/[0.07] bg-[#070707]/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
            <div className="flex items-center gap-3">
              <BrandMark />
              <div>
                <p className="font-bold tracking-tight">GymCam</p>
                <p className="text-xs text-zinc-500">Instant training replay</p>
              </div>
            </div>

            <button
              type="button"
              onClick={signOut}
              className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.08] hover:text-white"
            >
              Sign out
            </button>
          </div>
        </header>

        <div className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
          <section className="mb-8">
            <p className="text-sm font-medium text-zinc-500">Welcome back</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">Your gyms</h1>
            <p className="mt-2 text-sm text-zinc-500">Choose a gym to start watching or replaying training.</p>
          </section>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section>
              {gymsLoading ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {[0, 1].map((item) => (
                    <div key={item} className="h-40 animate-pulse rounded-2xl border border-white/[0.07] bg-white/[0.035]" />
                  ))}
                </div>
              ) : gyms.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.025] px-6 py-14 text-center">
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-xl">+</div>
                  <h2 className="mt-4 text-lg font-bold">No gyms yet</h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-zinc-500">
                    Use the gym code you received from your coach or gym administrator.
                  </p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {gyms.map((gym) => (
                    <button
                      key={gym.id}
                      type="button"
                      onClick={() => openGym(gym)}
                      className="group min-h-44 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 text-left transition hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.06]"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-lg font-black text-black">
                          {gym.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                          {gym.role}
                        </span>
                      </div>

                      <h2 className="mt-6 text-xl font-bold tracking-tight">{gym.name}</h2>
                      <div className="mt-3 flex items-center justify-between text-sm">
                        <span className="text-zinc-500">Open cameras</span>
                        <span className="text-zinc-500 transition group-hover:translate-x-1 group-hover:text-white">→</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {message && (
                <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/[0.07] px-4 py-3 text-sm text-red-300">
                  {message}
                </div>
              )}
            </section>

            <aside className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 lg:self-start">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.07] text-xl">⌁</div>
              <h2 className="mt-4 text-lg font-bold">Join a gym</h2>
              <p className="mt-1 text-sm leading-6 text-zinc-500">Enter the access code provided by your gym.</p>

              <div className="mt-5 space-y-3">
                <input
                  type="text"
                  placeholder="Gym code"
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void joinGym();
                  }}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3.5 font-mono text-sm uppercase tracking-widest text-white outline-none transition placeholder:font-sans placeholder:tracking-normal placeholder:text-zinc-600 focus:border-white/25"
                />

                <button
                  type="button"
                  disabled={joinBusy}
                  onClick={joinGym}
                  className="w-full rounded-xl bg-white px-4 py-3.5 text-sm font-bold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {joinBusy ? "Joining…" : "Join gym"}
                </button>
              </div>

              {joinMessage && <p className="mt-3 text-xs leading-5 text-zinc-400">{joinMessage}</p>}

              <div className="mt-6 border-t border-white/[0.07] pt-4">
                <p className="truncate text-xs text-zinc-600">Signed in as {userEmail}</p>
              </div>
            </aside>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#070707] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,_rgba(255,255,255,0.10),_transparent_28%),radial-gradient(circle_at_80%_100%,_rgba(59,130,246,0.08),_transparent_24%)]" />

      <div className="relative mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-5 py-10 sm:px-8 lg:grid-cols-2 lg:px-6">
        <section className="hidden lg:block">
          <BrandMark />
          <h1 className="mt-8 max-w-xl text-5xl font-bold leading-[1.05] tracking-[-0.04em]">
            See the rep.
            <br />
            Fix it instantly.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-8 text-zinc-500">
            Live camera feeds, delayed playback, and instant replay built for training floors.
          </p>

          <div className="mt-10 grid max-w-lg grid-cols-3 gap-3">
            {["Live", "Delay", "Replay"].map((label) => (
              <div key={label} className="rounded-2xl border border-white/[0.07] bg-white/[0.035] px-4 py-4">
                <div className="h-1.5 w-1.5 rounded-full bg-white" />
                <p className="mt-4 text-sm font-semibold">{label}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-3">
              <BrandMark />
              <div>
                <p className="font-bold">GymCam</p>
                <p className="text-xs text-zinc-500">Instant training replay</p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-white/[0.09] bg-white/[0.04] p-6 shadow-2xl shadow-black/30 backdrop-blur-xl sm:p-8">
            <div>
              <p className="text-sm font-medium text-zinc-500">Welcome back</p>
              <h2 className="mt-1 text-3xl font-bold tracking-tight">Sign in to GymCam</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-500">Access your gym&apos;s live feeds and replays.</p>
            </div>

            <div className="mt-7 space-y-3">
              <div>
                <label htmlFor="email" className="mb-2 block text-xs font-semibold uppercase tracking-wider text-zinc-500">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-zinc-700 focus:border-white/25"
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Password</label>
                  <button
                    type="button"
                    onClick={forgotPassword}
                    className="min-h-10 px-2 text-xs font-medium text-zinc-500 transition hover:text-white"
                  >
                    Forgot password?
                  </button>
                </div>

                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void signIn();
                  }}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-zinc-700 focus:border-white/25"
                />
              </div>
            </div>

            <button
              type="button"
              disabled={authBusy}
              onClick={signIn}
              className="mt-5 w-full rounded-xl bg-white px-4 py-3.5 text-sm font-bold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {authBusy ? "Please wait…" : "Sign in"}
            </button>

            <button
              type="button"
              disabled={authBusy}
              onClick={signUp}
              className="mt-3 w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3.5 text-sm font-semibold text-zinc-300 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create account
            </button>

            {message && (
              <div className="mt-4 rounded-xl border border-white/[0.08] bg-black/30 px-4 py-3 text-sm leading-6 text-zinc-400">
                {message}
              </div>
            )}
          </div>

          <p className="mt-5 text-center text-xs text-zinc-700">gymcam.stream</p>
        </section>
      </div>
    </main>
  );
}
