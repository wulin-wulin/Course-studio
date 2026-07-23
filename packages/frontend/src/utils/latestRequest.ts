export type LatestRequest = {
  generation: number;
  controller: AbortController;
};

export class LatestRequestGuard {
  private generation = 0;
  private controller: AbortController | null = null;

  start(): LatestRequest {
    this.controller?.abort();
    const request = {
      generation: this.generation + 1,
      controller: new AbortController(),
    };
    this.generation = request.generation;
    this.controller = request.controller;
    return request;
  }

  isCurrent(request: LatestRequest) {
    return (
      !request.controller.signal.aborted
      && request.generation === this.generation
      && request.controller === this.controller
    );
  }

  finish(request: LatestRequest) {
    if (!this.isCurrent(request)) return false;
    this.controller = null;
    return true;
  }

  cancel() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }
}
