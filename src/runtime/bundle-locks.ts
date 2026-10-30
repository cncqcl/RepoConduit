/** Serializes filesystem mutations per bundle within one coordinator process. */
export class BundleLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async withBundleLock<T>(bundleId: string, action: () => Promise<T>): Promise<T> {
    if (!bundleId) throw new TypeError('Bundle ID required');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tails.get(bundleId) ?? Promise.resolve();
    const tail = previous.then(() => gate);
    this.tails.set(bundleId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(bundleId) === tail) this.tails.delete(bundleId);
    }
  }
}
