export class RefreshCoordinator<T> {
  #inFlight: Promise<T> | null = null;

  run(refresh: () => Promise<T>): Promise<T> {
    if (this.#inFlight !== null) return this.#inFlight;
    const pending = refresh().finally(() => {
      if (this.#inFlight === pending) this.#inFlight = null;
    });
    this.#inFlight = pending;
    return pending;
  }
}
