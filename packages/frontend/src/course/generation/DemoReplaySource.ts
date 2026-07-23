import type {
  CourseGenerationEvent,
  GenerationTimeline,
} from "./types";

type DemoReplaySourceOptions = {
  timeline: GenerationTimeline;
  onEvent: (event: CourseGenerationEvent) => void;
  onProgress?: (ratio: number) => void;
  onPlaybackEnd?: () => void;
};

export class DemoReplaySource {
  private readonly timeline: GenerationTimeline;
  private readonly onEvent: (event: CourseGenerationEvent) => void;
  private readonly onProgress?: (ratio: number) => void;
  private readonly onPlaybackEnd?: () => void;
  private cursor = 0;
  private elapsed = 0;
  private lastFrame = 0;
  private animationFrame = 0;
  private speed = 1;
  private playing = false;

  constructor(options: DemoReplaySourceOptions) {
    this.timeline = options.timeline;
    this.onEvent = options.onEvent;
    this.onProgress = options.onProgress;
    this.onPlaybackEnd = options.onPlaybackEnd;
  }

  start() {
    this.cancelFrame();
    this.cursor = 0;
    this.elapsed = 0;
    this.playing = true;
    this.lastFrame = performance.now();
    this.flushEvents();
    this.onProgress?.(0);
    this.animationFrame = window.requestAnimationFrame(this.tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.cancelFrame();
  }

  resume() {
    if (this.playing || this.cursor >= this.timeline.items.length) return;
    this.playing = true;
    this.lastFrame = performance.now();
    this.animationFrame = window.requestAnimationFrame(this.tick);
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  restart() {
    this.start();
  }

  skipToNextPhase() {
    const nextIndex = this.timeline.items.findIndex(
      (item, index) =>
        index >= this.cursor &&
        (item.event.type === "phase_changed" ||
          item.event.type === "generation_completed")
    );
    if (nextIndex < 0) return;
    const nextItem = this.timeline.items[nextIndex];
    if (!nextItem) return;
    this.elapsed = nextItem.at;
    this.flushEvents();
    this.emitProgress();
  }

  dispose() {
    this.playing = false;
    this.cancelFrame();
  }

  private tick = (now: number) => {
    if (!this.playing) return;
    const delta = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.elapsed += delta * this.speed;
    this.flushEvents();
    this.emitProgress();

    if (this.cursor >= this.timeline.items.length) {
      this.playing = false;
      this.onProgress?.(1);
      this.onPlaybackEnd?.();
      return;
    }
    this.animationFrame = window.requestAnimationFrame(this.tick);
  };

  private flushEvents() {
    while (this.cursor < this.timeline.items.length) {
      const item = this.timeline.items[this.cursor];
      if (!item || item.at > this.elapsed) break;
      this.onEvent(item.event);
      this.cursor += 1;
    }
  }

  private emitProgress() {
    this.onProgress?.(
      Math.max(0, Math.min(1, this.elapsed / Math.max(1, this.timeline.duration)))
    );
  }

  private cancelFrame() {
    if (this.animationFrame) {
      window.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }
}

