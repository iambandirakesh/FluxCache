/** Error thrown synchronously for invalid query keys. */
export class FluxCacheKeyError extends Error {
  override readonly name = 'FluxCacheKeyError';
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.path = path;
  }
}
