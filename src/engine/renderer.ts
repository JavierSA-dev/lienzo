import { TILE, type Rect, type ViewState } from './types';
import { tileKey, keyTx, keyTy, type EditorDocument, type PixelLayer } from './document';
import { RECT_VS, BLEND_FS, NORMAL_FS, VIEW_FS, CHECKER_FS, SOLID_FS, BLEND_INDEX } from './shaders';

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

interface CompTile { tex: WebGLTexture; fb: WebGLFramebuffer; mipsValid: boolean }

/** Textura de un tile de capa. Varias capas pueden compartirla (duplicados). */
interface GpuTile { tex: WebGLTexture; refs: number; opaque: boolean }

function isOpaque(data: Uint8ClampedArray): boolean {
  const u = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  for (let i = 0; i < u.length; i++) if (u[i] >>> 24 !== 255) return false;
  return true;
}

const MIP_LEVELS = Math.log2(TILE) + 1;

/**
 * Compositor WebGL2 que vive en el worker (OffscreenCanvas).
 * - Cada tile de capa es una textura; sólo se suben los tiles modificados.
 * - El documento se compone por tiles de 256×256; sólo se recomponen los sucios.
 * - La vista dibuja los tiles compuestos con zoom (mipmaps al alejar, píxeles nítidos al acercar).
 */
export class Renderer {
  gl: WebGL2RenderingContext;
  private canvas: OffscreenCanvas;
  private blendProg: Prog;
  private normalProg: Prog;
  private viewProg: Prog;
  private checkerProg: Prog;
  private solidProg: Prog;
  private vao: WebGLVertexArrayObject;
  private layerTex = new Map<number, Map<number, { data: Uint8ClampedArray; g: GpuTile }>>();
  private byData = new Map<Uint8ClampedArray, GpuTile>();
  get gpuTextures() { return this.byData.size; }
  /** Tiles subidos a la GPU en la última sincronización (para métricas). */
  lastUploads = 0;
  private comp = new Map<number, CompTile>();
  private scratch: { tex: WebGLTexture; fb: WebGLFramebuffer }[];
  private docDirty = new Set<number>();
  private allDirty = true;
  readonly info: string;
  readonly maxTexture: number;
  /** Tiempo de la última composición (ms). */
  lastComposeMs = 0;

  constructor(canvas: OffscreenCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false, desynchronized: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 no disponible en este navegador');
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.info = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL2';
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.blendProg = this.program(RECT_VS, BLEND_FS, ['uRect', 'uTarget', 'uFlipY', 'uBack', 'uSrc', 'uSrcOffset', 'uDocOrigin', 'uOpacity', 'uMode']);
    this.normalProg = this.program(RECT_VS, NORMAL_FS, ['uRect', 'uTarget', 'uFlipY', 'uSrc', 'uSrcOffset', 'uOpacity']);
    this.viewProg = this.program(RECT_VS, VIEW_FS, ['uRect', 'uTarget', 'uFlipY', 'uTex', 'uUV']);
    this.checkerProg = this.program(RECT_VS, CHECKER_FS, ['uRect', 'uTarget', 'uFlipY', 'uCell']);
    this.solidProg = this.program(RECT_VS, SOLID_FS, ['uRect', 'uTarget', 'uFlipY', 'uColor']);
    this.vao = gl.createVertexArray()!;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.scratch = [this.makeTarget(1), this.makeTarget(1)];
  }

  private program(vs: string, fs: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    const u: Prog['u'] = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  private makeTarget(levels: number) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, TILE, TILE);
    this.texParams(levels > 1);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  }

  private texParams(mips: boolean) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  resize(w: number, h: number) {
    this.canvas.width = Math.max(1, Math.round(w));
    this.canvas.height = Math.max(1, Math.round(h));
  }

  /** Marca como sucia una región del documento (se recompondrá en el próximo frame). */
  invalidate(r: Rect | null) {
    if (!r) { this.allDirty = true; return; }
    const tx0 = Math.max(0, Math.floor(r.x / TILE)), ty0 = Math.max(0, Math.floor(r.y / TILE));
    const tx1 = Math.floor((r.x + r.w - 1) / TILE), ty1 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.docDirty.add(tileKey(tx, ty));
  }

  /** Libera todo lo asociado a un documento (al cerrar o abrir otro). */
  reset() {
    const gl = this.gl;
    for (const g of this.byData.values()) gl.deleteTexture(g.tex);
    this.byData.clear();
    this.layerTex.clear();
    for (const c of this.comp.values()) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); }
    this.comp.clear();
    this.docDirty.clear();
    this.allDirty = true;
  }

  private acquire(data: Uint8ClampedArray): GpuTile {
    let g = this.byData.get(data);
    if (g) { g.refs++; return g; }
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, TILE, TILE);
    this.texParams(false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.lastUploads++;
    g = { tex, refs: 1, opaque: isOpaque(data) };
    this.byData.set(data, g);
    return g;
  }

  private release(data: Uint8ClampedArray) {
    const g = this.byData.get(data);
    if (!g || --g.refs > 0) return;
    this.gl.deleteTexture(g.tex);
    this.byData.delete(data);
  }

  dropLayer(id: number) {
    const m = this.layerTex.get(id);
    if (!m) return;
    for (const e of m.values()) this.release(e.data);
    this.layerTex.delete(id);
  }

  /**
   * Sube a la GPU los tiles modificados de cada capa. Los tiles compartidos
   * entre capas (duplicados) comparten también la textura: duplicar no sube nada.
   */
  private sync(doc: EditorDocument) {
    const gl = this.gl;
    this.lastUploads = 0;
    const alive = new Set(doc.layers.map((l) => l.id));
    for (const id of [...this.layerTex.keys()]) if (!alive.has(id)) this.dropLayer(id);
    for (const L of doc.layers) {
      let m = this.layerTex.get(L.id);
      if (!m) {
        m = new Map();
        this.layerTex.set(L.id, m);
        for (const k of L.tiles.keys()) L.gpuDirty.add(k);
      }
      for (const k of L.gpuRemoved) {
        const e = m.get(k);
        if (e) { this.release(e.data); m.delete(k); }
      }
      L.gpuRemoved.clear();
      for (const k of L.gpuDirty) {
        const data = L.tiles.get(k);
        const e = m.get(k);
        if (!data) {
          if (e) { this.release(e.data); m.delete(k); }
        } else if (e && e.data === data) {
          // Mismo objeto modificado en su sitio (nunca está compartido): se resube.
          gl.bindTexture(gl.TEXTURE_2D, e.g.tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, data);
          e.g.opaque = isOpaque(data);
          this.lastUploads++;
        } else {
          if (e) this.release(e.data);
          m.set(k, { data, g: this.acquire(data) });
        }
      }
      L.gpuDirty.clear();
    }
  }

  private setRect(prog: Prog, x0: number, y0: number, x1: number, y1: number, tw: number, th: number, flip: boolean) {
    const gl = this.gl;
    gl.uniform4f(prog.u.uRect, x0, y0, x1, y1);
    gl.uniform2f(prog.u.uTarget, tw, th);
    gl.uniform1i(prog.u.uFlipY, flip ? 1 : 0);
  }

  /**
   * Compone un tile del documento a partir de `layers` y deja el resultado en scratch[0].
   * Devuelve false si no hay nada (tile totalmente transparente).
   */
  private composeInto(layers: PixelLayer[], tx: number, ty: number, clearColor: [number, number, number, number]): boolean {
    const gl = this.gl;
    const P = this.blendProg, N = this.normalProg;
    let [A, B] = this.scratch;
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
    gl.viewport(0, 0, TILE, TILE);
    gl.clearColor(...clearColor);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    const dx0 = tx * TILE, dy0 = ty * TILE;
    let any = clearColor[3] > 0;

    // Oclusión: si una capa Normal al 100 % tapa por completo este tile,
    // las de debajo no se componen (caso típico: una foto de fondo).
    let start = 0;
    for (let i = layers.length - 1; i > 0; i--) {
      const L = layers[i];
      if (!L.visible || L.opacity <= 0) continue;
      if (L.blend !== 'normal' || L.opacity < 1 || (L.x % TILE) !== 0 || (L.y % TILE) !== 0) continue;
      const e = this.layerTex.get(L.id)?.get(tileKey((dx0 - L.x) / TILE, (dy0 - L.y) / TILE));
      if (e?.g.opaque) { start = i; break; }
    }

    for (let li = start; li < layers.length; li++) {
      const L = layers[li];
      if (!L.visible || L.opacity <= 0 || L.tiles.size === 0) continue;
      const m = this.layerTex.get(L.id);
      if (!m) continue;
      // Tiles de la capa que solapan este tile de documento.
      const lx0 = dx0 - L.x, ly0 = dy0 - L.y;
      const ltx0 = Math.floor(lx0 / TILE), lty0 = Math.floor(ly0 / TILE);
      const ltx1 = Math.floor((lx0 + TILE - 1) / TILE), lty1 = Math.floor((ly0 + TILE - 1) / TILE);
      const hits: [WebGLTexture, number, number][] = [];
      for (let lty = lty0; lty <= lty1; lty++) {
        for (let ltx = ltx0; ltx <= ltx1; ltx++) {
          const e = m.get(tileKey(ltx, lty));
          if (e) hits.push([e.g.tex, ltx, lty]);
        }
      }
      if (!hits.length) continue;
      any = true;
      const normal = L.blend === 'normal';
      if (normal) {
        // Mezcla fija de la GPU directamente sobre A: sin copia.
        gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(N.p);
        gl.uniform1i(N.u.uSrc, 1);
        gl.uniform1f(N.u.uOpacity, L.opacity);
      } else {
        // B = copia de A; luego se dibujan los tiles leyendo el fondo de A.
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, A.fb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, B.fb);
        gl.blitFramebuffer(0, 0, TILE, TILE, 0, 0, TILE, TILE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
        gl.useProgram(P.p);
        gl.uniform1i(P.u.uBack, 0);
        gl.uniform1i(P.u.uSrc, 1);
        gl.uniform2i(P.u.uDocOrigin, dx0, dy0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, A.tex);
        gl.uniform1f(P.u.uOpacity, L.opacity);
        gl.uniform1i(P.u.uMode, BLEND_INDEX[L.blend] ?? 0);
      }
      const prog = normal ? N : P;
      for (const [tex, ltx, lty] of hits) {
        // Origen del tile de capa en coordenadas del tile de documento.
        const ox = ltx * TILE + L.x - dx0, oy = lty * TILE + L.y - dy0;
        const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
        const x1 = Math.min(TILE, ox + TILE), y1 = Math.min(TILE, oy + TILE);
        if (x1 <= x0 || y1 <= y0) continue;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform2i(prog.u.uSrcOffset, ox, oy);
        this.setRect(prog, x0, y0, x1, y1, TILE, TILE, false);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      if (!normal) [A, B] = [B, A];
    }
    gl.disable(gl.BLEND);
    this.scratch = [A, B];
    return any;
  }

  private compTile(k: number): CompTile {
    let c = this.comp.get(k);
    if (!c) {
      const t = this.makeTarget(MIP_LEVELS);
      c = { tex: t.tex, fb: t.fb, mipsValid: false };
      this.comp.set(k, c);
    }
    return c;
  }

  /** Recompone los tiles sucios del documento. */
  compose(doc: EditorDocument) {
    const t0 = performance.now();
    const gl = this.gl;
    this.sync(doc);
    const keys: number[] = [];
    if (this.allDirty) {
      for (let ty = 0; ty < doc.tilesY; ty++) for (let tx = 0; tx < doc.tilesX; tx++) keys.push(tileKey(tx, ty));
      // Tiles compuestos fuera del documento (tras recortar/redimensionar).
      for (const [k, c] of this.comp) {
        if (keyTx(k) >= doc.tilesX || keyTy(k) >= doc.tilesY) {
          gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); this.comp.delete(k);
        }
      }
    } else {
      for (const k of this.docDirty) if (keyTx(k) < doc.tilesX && keyTy(k) < doc.tilesY) keys.push(k);
    }
    this.allDirty = false;
    this.docDirty.clear();
    for (const k of keys) {
      const tx = keyTx(k), ty = keyTy(k);
      const any = this.composeInto(doc.layers, tx, ty, [0, 0, 0, 0]);
      if (!any) {
        const c = this.comp.get(k);
        if (c) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); this.comp.delete(k); }
        continue;
      }
      const c = this.compTile(k);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scratch[0].fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, c.fb);
      gl.blitFramebuffer(0, 0, TILE, TILE, 0, 0, TILE, TILE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      c.mipsValid = false;
    }
    if (keys.length) this.lastComposeMs = performance.now() - t0;
    return keys.length;
  }

  /** Dibuja la vista: fondo, damero, tiles compuestos y borde del lienzo. */
  draw(doc: EditorDocument | null, view: ViewState) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.157, 0.157, 0.157, 1); // mesa de trabajo gris oscura
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    if (!doc) return;

    const s = view.zoom * view.dpr;
    const ox = view.panX * view.dpr, oy = view.panY * view.dpr;
    const X = (dx: number) => ox + dx * s, Y = (dy: number) => oy + dy * s;
    const dX0 = X(0), dY0 = Y(0), dX1 = X(doc.width), dY1 = Y(doc.height);

    // Damero de transparencia.
    gl.disable(gl.BLEND);
    gl.useProgram(this.checkerProg.p);
    gl.uniform1f(this.checkerProg.u.uCell, 8 * view.dpr);
    this.setRect(this.checkerProg, dX0, dY0, dX1, dY1, W, H, true);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Tiles compuestos (premultiplicados) sobre el damero.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const P = this.viewProg;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    const minify = s < 1;
    // Rango de tiles visibles.
    const vtx0 = Math.max(0, Math.floor(-ox / s / TILE)), vty0 = Math.max(0, Math.floor(-oy / s / TILE));
    const vtx1 = Math.min(doc.tilesX - 1, Math.floor((W - ox) / s / TILE));
    const vty1 = Math.min(doc.tilesY - 1, Math.floor((H - oy) / s / TILE));
    for (let ty = vty0; ty <= vty1; ty++) {
      for (let tx = vtx0; tx <= vtx1; tx++) {
        const c = this.comp.get(tileKey(tx, ty));
        if (!c) continue;
        gl.bindTexture(gl.TEXTURE_2D, c.tex);
        if (minify && !c.mipsValid) { gl.generateMipmap(gl.TEXTURE_2D); c.mipsValid = true; }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minify ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
        // Recorta el último tile al borde del documento.
        const pw = Math.min(TILE, doc.width - tx * TILE), ph = Math.min(TILE, doc.height - ty * TILE);
        gl.uniform4f(P.u.uUV, 0, 0, pw / TILE, ph / TILE);
        this.setRect(P, X(tx * TILE), Y(ty * TILE), X(tx * TILE + pw), Y(ty * TILE + ph), W, H, true);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.disable(gl.BLEND);

    // Borde fino alrededor del lienzo.
    const S = this.solidProg;
    gl.useProgram(S.p);
    gl.uniform4f(S.u.uColor, 0, 0, 0, 1);
    const bw = Math.max(1, view.dpr);
    for (const [a, b, c2, d] of [
      [dX0 - bw, dY0 - bw, dX1 + bw, dY0], [dX0 - bw, dY1, dX1 + bw, dY1 + bw],
      [dX0 - bw, dY0, dX0, dY1], [dX1, dY0, dX1 + bw, dY1],
    ]) {
      this.setRect(S, a, b, c2, d, W, H, true);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /** Lee un píxel del documento compuesto (alfa directo). */
  readCompositePixel(dx: number, dy: number): [number, number, number, number] {
    const gl = this.gl;
    const tx = Math.floor(dx / TILE), ty = Math.floor(dy / TILE);
    const c = this.comp.get(tileKey(tx, ty));
    if (!c) return [0, 0, 0, 0];
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fb);
    gl.readPixels(dx - tx * TILE, dy - ty * TILE, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const a = px[3];
    if (!a) return [0, 0, 0, 0];
    return [Math.round((px[0] * 255) / a), Math.round((px[1] * 255) / a), Math.round((px[2] * 255) / a), a];
  }

  /**
   * Compone un conjunto de capas en una región del documento y la devuelve en CPU
   * (RGBA, alfa directo). Sirve para combinar capas, acoplar y exportar.
   */
  flatten(doc: EditorDocument, layers: PixelLayer[], region: Rect, background?: [number, number, number, number]): Uint8ClampedArray {
    const gl = this.gl;
    this.sync(doc);
    const out = new Uint8ClampedArray(region.w * region.h * 4);
    const buf = new Uint8Array(TILE * TILE * 4);
    const bg: [number, number, number, number] = background
      ? [background[0] / 255 * background[3] / 255, background[1] / 255 * background[3] / 255, background[2] / 255 * background[3] / 255, background[3] / 255]
      : [0, 0, 0, 0];
    const tx0 = Math.floor(region.x / TILE), ty0 = Math.floor(region.y / TILE);
    const tx1 = Math.floor((region.x + region.w - 1) / TILE), ty1 = Math.floor((region.y + region.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.composeInto(layers, tx, ty, bg)) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratch[0].fb);
        gl.readPixels(0, 0, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const ox = tx * TILE, oy = ty * TILE;
        const x0 = Math.max(region.x, ox), x1 = Math.min(region.x + region.w, ox + TILE);
        const y0 = Math.max(region.y, oy), y1 = Math.min(region.y + region.h, oy + TILE);
        for (let y = y0; y < y1; y++) {
          let si = ((y - oy) * TILE + (x0 - ox)) * 4;
          let di = ((y - region.y) * region.w + (x0 - region.x)) * 4;
          for (let x = x0; x < x1; x++, si += 4, di += 4) {
            const a = buf[si + 3];
            if (!a) continue;
            if (a === 255) {
              out[di] = buf[si]; out[di + 1] = buf[si + 1]; out[di + 2] = buf[si + 2]; out[di + 3] = 255;
            } else {
              const f = 255 / a;
              out[di] = buf[si] * f; out[di + 1] = buf[si + 1] * f; out[di + 2] = buf[si + 2] * f; out[di + 3] = a;
            }
          }
        }
      }
    }
    // Deja las texturas compuestas intactas; sólo se usó el scratch.
    return out;
  }
}
