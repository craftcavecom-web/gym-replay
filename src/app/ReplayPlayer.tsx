"use client";

import { useEffect, useState } from "react";

type ReplayPlayerProps = {
  url: string;
};

// Fetch a complete short replay before playback. This avoids depending on
// byte-range support at MediaMTX's dynamically generated /get endpoint.
// This does NOT re-encode, watermark, or audit the video.
export default function ReplayPlayer({ url }: ReplayPlayerProps) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let objectUrl: string | null = null;
    let timedOut = false;

    setSource("");
    setError("");

    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60000);

    async function prepareReplay() {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("This recording is unavailable or expired. Load a fresh replay.");
          }
          throw new Error(`Replay server returned HTTP ${response.status}. Check that the cameras are started, then load a fresh replay.`);
        }

        const contentType = (response.headers.get("content-type") ?? "")
          .split(";")[0].trim().toLowerCase();

        if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
          throw new Error(`The replay server returned ${contentType}, not an MP4 video.`);
        }

        const downloaded = await response.blob();
        if (downloaded.size === 0) {
          throw new Error("The replay server returned an empty file.");
        }
        if (disposed) return;

        const videoBlob = downloaded.type === "video/mp4"
          ? downloaded
          : new Blob([downloaded], { type: "video/mp4" });

        objectUrl = URL.createObjectURL(videoBlob);
        setSource(objectUrl);
      } catch (caught) {
        if (disposed) return;
        if (timedOut) {
          setError("Replay preparation timed out. Try a fresh 10-second clip.");
        } else if (caught instanceof TypeError) {
          setError("The browser could not fetch the replay. Check the replay server, connection, and playback CORS settings.");
        } else {
          setError(caught instanceof Error ? caught.message : "Replay could not be prepared.");
        }
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void prepareReplay();

    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timeout);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-900 bg-zinc-900 p-5 text-red-300">
        <p className="font-semibold">Replay could not play</p>
        <p className="mt-2 text-sm">{error}</p>
        <p className="mt-2 text-sm">Keep the cameras running and try Load Replay again.</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div role="status" className="flex aspect-video items-center justify-center rounded-xl bg-black p-5 text-zinc-300">
        Preparing replay... A longer clip takes longer to load.
      </div>
    );
  }

  return (
    <div>
      <video
        key={source}
        src={source}
        controls
        playsInline
        preload="auto"
        className="aspect-video w-full rounded-xl bg-black"
        onError={(event) => {
          const mediaError = event.currentTarget.error;
          const code = mediaError?.code ?? "unknown";
          const detail = mediaError?.message ? ` ${mediaError.message}` : "";
          setError(`The clip downloaded, but the browser could not play it. Media error ${code}.${detail}`);
        }}
      />
      <p className="mt-3 text-sm text-zinc-400">Tap Play. This replay is prepared in your browser; it is not automatically saved to Photos.</p>
    </div>
  );
}