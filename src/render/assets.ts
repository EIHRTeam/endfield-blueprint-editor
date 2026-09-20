/**
 * Asset loading and caching for the canvas renderer.
 *
 * Assets are ordinary HTTP resources: the baking layer emits one file per composited sprite and the
 * worker hands over raw RGBA pixel buffers for the images it just baked. Nothing is ever a data URL,
 * so the browser can cache, decompress and stream each image independently.
 */
import type { AssetIndex } from '../core/types';

/**
 * An image the renderer can draw: either an `HTMLImageElement` loaded from an asset URL, or an
 * `ImageBitmap` decoded from pixels the baking worker transferred.
 */
export type DrawableImage = HTMLImageElement | ImageBitmap;

export interface AssetEntry {
  image: DrawableImage | null;
  loaded: boolean;
  ready: Promise<DrawableImage>;
}

/**
 * Loads and caches every image the scene can draw.
 *
 * `urls` is the asset manifest produced by baking. `put` installs already-decoded bitmaps so images
 * baked at runtime never round-trip through the network or through a PNG re-encode.
 */
export class AssetStore {
  private readonly urls: AssetIndex;
  /** Object URLs for decoded bitmaps, so `<img>` tags can show runtime-baked artwork. */
  private readonly objectUrls = new Map<string, string>();
  private readonly entries = new Map<string, AssetEntry>();
  private readonly customBodies = new Map<string, HTMLCanvasElement>();
  private readonly statusColors = new Map<string, HTMLCanvasElement>();
  private readonly onError: (message: string) => void;
  private readonly onLoad: () => void;

  constructor(urls: AssetIndex, options: { onError?: (message: string) => void; onLoad?: () => void } = {}) {
    this.urls = urls;
    this.onError = options.onError ?? (() => {});
    this.onLoad = options.onLoad ?? (() => {});
  }

  /** Registers a URL discovered after construction (e.g. a lazily baked product badge). */
  setUrl(key: string, url: string): void {
    this.urls[key] = url;
  }

  /** True when the asset is already decoded and drawable. */
  has(key: string | null | undefined): boolean {
    return Boolean(key && this.entries.get(key)?.loaded);
  }

  /** The decoded image, or null while it is still loading. */
  get(key: string | null | undefined): DrawableImage | null {
    if (!key) return null;
    const entry = this.entries.get(key);
    return entry?.loaded ? entry.image : null;
  }

  /**
   * The URL an asset key resolves to, for plain `<img>` elements.
   *
   * Assets baked at runtime have no file on disk, so they are exposed through an object URL created
   * from the decoded bitmap. Falling back to the manifest URL keeps static assets (and any asset that
   * has not been decoded yet) loading normally.
   */
  urlsFor(key: string | null | undefined): string {
    if (!key) return '';
    return this.objectUrls.get(key) ?? this.urls[key] ?? '';
  }

  /** Releases every object URL. The store owns them for its lifetime. */
  dispose(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  /** Installs an already-decoded image, replacing any pending network load for that key. */
  put(key: string, image: DrawableImage): void {
    const entry: AssetEntry = { image, loaded: true, ready: Promise.resolve(image) };
    this.entries.set(key, entry);
    this.registerObjectUrl(key, image);
    this.onLoad();
  }

  /** Creates a blob URL for a bitmap so `<img>` tags can render it. */
  private registerObjectUrl(key: string, image: DrawableImage): void {
    if (this.objectUrls.has(key) || typeof URL.createObjectURL !== 'function') return;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      canvas.toBlob(blob => {
        if (blob) this.objectUrls.set(key, URL.createObjectURL(blob));
      }, 'image/png');
      return;
    }
    this.objectUrls.set(key, URL.createObjectURL(image as unknown as Blob));
  }

  /** Starts loading an asset and returns a promise that settles when it can be drawn. */
  load(key: string | null | undefined): Promise<DrawableImage> {
    if (!key) return Promise.resolve(undefined as unknown as DrawableImage);
    const existing = this.entries.get(key);
    if (existing) return existing.ready;

    const entry: AssetEntry = { image: null, loaded: false, ready: undefined as unknown as Promise<DrawableImage> };
    entry.ready = new Promise<DrawableImage>((resolve, reject) => {
      const url = this.urls[key];
      if (!url) {
        reject(Error(`缺少图片资源：${key}`));
        return;
      }
      const image = new Image();
      image.onload = () => {
        entry.image = image;
        entry.loaded = true;
        this.onLoad();
        resolve(image);
      };
      image.onerror = () => reject(Error('图片加载失败，请重新生成编辑器'));
      image.src = url;
    });
    entry.ready.catch(error => this.onError((error as Error).message));
    this.entries.set(key, entry);
    return entry.ready;
  }

  /** Loads every key and resolves once all of them are drawable. */
  async preload(keys: Iterable<string | null | undefined>): Promise<void> {
    await Promise.all(
      [...keys].filter((key): key is string => Boolean(key)).map(key => this.load(key).catch(() => undefined)),
    );
  }

  /**
   * Caches composed device bodies (devices with hidden ports) in a bounded LRU, keyed by the exact
   * portrait that was requested.
   */
  bodyCache(key: string): HTMLCanvasElement | undefined {
    return this.customBodies.get(key);
  }

  cacheBody(key: string, canvas: HTMLCanvasElement): void {
    if (this.customBodies.size >= 128) {
      const oldest = this.customBodies.keys().next().value;
      if (oldest !== undefined) this.customBodies.delete(oldest);
    }
    this.customBodies.set(key, canvas);
  }

  /** Tints a status badge with a flat colour, cached per colour. */
  tintedStatus(image: DrawableImage, color: string): HTMLCanvasElement {
    const cached = this.statusColors.get(color);
    if (cached) return cached;
    const out = document.createElement('canvas');
    out.width = image.width;
    out.height = image.height;
    const context = out.getContext('2d')!;
    context.drawImage(image, 0, 0);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = color;
    context.fillRect(0, 0, out.width, out.height);
    if (this.statusColors.size >= 64) {
      const oldest = this.statusColors.keys().next().value;
      if (oldest !== undefined) this.statusColors.delete(oldest);
    }
    this.statusColors.set(color, out);
    return out;
  }
}
