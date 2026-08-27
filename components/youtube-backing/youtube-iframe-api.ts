type YouTubePlayerEvent = {
  target: YouTubeIframePlayer;
};

type YouTubePlayerErrorEvent = YouTubePlayerEvent & {
  data: number;
};

type YouTubePlayerStateEvent = YouTubePlayerEvent & {
  data: number;
};

export type YouTubeIframePlayer = {
  destroy: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getIframe: () => HTMLIFrameElement;
  getPlayerState: () => number;
  getVolume: () => number;
  pauseVideo: () => void;
  playVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void;
  stopVideo: () => void;
};

type YouTubePlayerOptions = {
  width: string;
  height: string;
  host?: string;
  videoId: string;
  playerVars: {
    autoplay: 0 | 1;
    controls: 0 | 1;
    enablejsapi: 1;
    origin: string;
    playsinline: 1;
    rel: 0;
    start?: number;
  };
  events: {
    onReady: (event: YouTubePlayerEvent) => void;
    onStateChange: (event: YouTubePlayerStateEvent) => void;
    onError: (event: YouTubePlayerErrorEvent) => void;
  };
};

export type YouTubeIframeApi = {
  Player: new (
    target: HTMLElement | string,
    options: YouTubePlayerOptions,
  ) => YouTubeIframePlayer;
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
};

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_SCRIPT_ID = "riff-sketchbook-youtube-iframe-api";
const API_SCRIPT_URL = "https://www.youtube.com/iframe_api";
const API_TIMEOUT_MS = 15_000;

let apiPromise: Promise<YouTubeIframeApi> | null = null;

/** Loads Google's official iframe API once, even with multiple players. */
export function loadYouTubeIframeApi(): Promise<YouTubeIframeApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("YouTube 플레이어는 브라우저에서만 열 수 있어요."));
  }

  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YouTubeIframeApi>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    let script: HTMLScriptElement | null = null;

    const readyCallback = () => {
      try {
        previousReady?.();
      } finally {
        finish();
      }
    };

    const restoreReadyCallback = () => {
      if (window.onYouTubeIframeAPIReady !== readyCallback) return;
      if (previousReady) window.onYouTubeIframeAPIReady = previousReady;
      else delete window.onYouTubeIframeAPIReady;
    };

    const cleanup = () => {
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      script?.removeEventListener("error", fail);
      restoreReadyCallback();
    };

    const finish = () => {
      if (settled || !window.YT?.Player) return;
      settled = true;
      cleanup();
      resolve(window.YT);
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!window.YT?.Player) script?.remove();
      apiPromise = null;
      reject(new Error("YouTube 플레이어를 불러오지 못했어요. 연결을 확인해 주세요."));
    };

    window.onYouTubeIframeAPIReady = readyCallback;

    script = document.getElementById(API_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = API_SCRIPT_ID;
      script.src = API_SCRIPT_URL;
      script.async = true;
      script.referrerPolicy = "strict-origin-when-cross-origin";
      document.head.append(script);
    }
    script.addEventListener("error", fail, { once: true });

    // Polling also handles a script inserted by another feature whose global
    // ready callback was installed before this component mounted.
    pollTimer = window.setInterval(finish, 50);
    timeoutTimer = window.setTimeout(fail, API_TIMEOUT_MS);
    finish();
  });

  return apiPromise;
}
