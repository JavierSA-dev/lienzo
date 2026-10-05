declare module 'gifenc' {
  type Palette = number[][];
  interface FrameOpts { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; first?: boolean }
  interface Encoder { writeFrame(index: Uint8Array, w: number, h: number, opts?: FrameOpts): void; finish(): void; bytes(): Uint8Array; bytesView(): Uint8Array; reset(): void }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array;
  export function nearestColorIndex(palette: Palette, pixel: number[]): number;
}
