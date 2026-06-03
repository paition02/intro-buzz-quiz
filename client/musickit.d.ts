declare namespace MusicKit {
  interface ConfigureOptions {
    developerToken: string;
    app: { name: string; build: string };
    storefrontId?: string;
  }

  interface MusicKitInstance {
    readonly api: {
      music<T = unknown>(
        path: string,
        params?: Record<string, string | number | string[]>,
        options?: { fetchOptions?: RequestInit }
      ): Promise<{ data: T }>;
    };
    readonly currentPlaybackDuration: number;
    readonly currentPlaybackProgress: number;
    readonly currentPlaybackTime: number;
    readonly currentPlaybackTimeRemaining: number;
    readonly isAuthorized: boolean;
    readonly isPlaying: boolean;
    readonly nowPlayingItem: MediaItem | undefined;
    readonly nowPlayingItemIndex: number;
    readonly playbackState: PlaybackStates;
    readonly queue: Queue;
    readonly queueIsEmpty: boolean;
    readonly storefrontCountryCode: string;
    readonly storefrontId: string;

    bitrate: PlaybackBitrate;
    playbackRate: number;
    previewOnly: boolean;
    repeatMode: PlayerRepeatMode;
    shuffleMode: PlayerShuffleMode;
    volume: number;

    authorize(): Promise<string | void>;
    unauthorize(): Promise<void>;
    play(): Promise<void>;
    pause(): void;
    stop(): Promise<void>;
    skipToNextItem(): Promise<void>;
    skipToPreviousItem(): Promise<void>;
    seekToTime(time: number): Promise<void>;
    mute(): void;
    unmute(): Promise<void>;
    setQueue(options: QueueOptions): Promise<Queue | void>;
    clearQueue(): Promise<Queue>;
    changeToMediaAtIndex(index: number): Promise<void>;

    addEventListener<K extends keyof Events>(
      name: K,
      callback: (event: Events[K]) => void
    ): void;
    removeEventListener<K extends keyof Events>(
      name: K,
      callback: (event: Events[K]) => void
    ): void;
  }

  interface Queue {
    readonly currentItem: MediaItem | undefined;
    readonly isEmpty: boolean;
    readonly items: MediaItem[];
    readonly length: number;
    readonly position: number;
  }

  interface QueueOptions {
    album?: string;
    playlist?: string;
    song?: string;
    station?: string;
    songs?: string[];
    startPlaying?: boolean;
    startWith?: number;
  }

  interface MediaItem {
    id: string;
    type: string;
    attributes: {
      name: string;
      artistName: string;
      albumName: string;
      artwork?: { url: string; width: number | null; height: number | null };
      durationInMillis: number;
    };
  }

  interface Events {
    authorizationStatusDidChange: { authorizationStatus: number };
    playbackStateWillChange: { oldState: PlaybackStates; state: PlaybackStates; nowPlayingItem: MediaItem | undefined };
    playbackStateDidChange: { oldState: PlaybackStates; state: PlaybackStates; nowPlayingItem: MediaItem | undefined };
    playbackTimeDidChange: { currentPlaybackTime: number };
    playbackDurationDidChange: { duration: number };
    playbackProgressDidChange: { progress: number };
    playbackVolumeDidChange: { volume: number };
    nowPlayingItemWillChange: { item: MediaItem | undefined };
    nowPlayingItemDidChange: { item: MediaItem | undefined };
    queueIsReady: { queue: Queue };
    queueItemsDidChange: { items: MediaItem[] };
    queuePositionDidChange: { position: number };
    mediaPlaybackError: { error: Error };
  }

  enum PlaybackStates {
    none = 0,
    loading = 1,
    playing = 2,
    paused = 3,
    stopped = 4,
    ended = 5,
    seeking = 6,
    waiting = 8,
    stalled = 9,
    completed = 10,
  }

  enum PlayerRepeatMode { none = 0, one = 1, all = 2 }
  enum PlayerShuffleMode { off = 0, songs = 1 }
  enum PlaybackBitrate { STANDARD = 64, HIGH = 256 }

  function configure(options: ConfigureOptions): Promise<MusicKitInstance>;
  function getInstance(): MusicKitInstance | undefined;
}

interface Window {
  MusicKit: typeof MusicKit;
}
