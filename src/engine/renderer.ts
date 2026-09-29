import { TILE, type Matrix, type Rect, type ViewState } from './types';
import { tileKey, keyTx, keyTy, type EditorDocument, type PixelLayer, type MaskChannel } from './document';
import { RECT_VS, QUAD_VS, BLEND_FS, NORMAL_FS, ADJ_FS, VIEW_FS, CHECKER_FS, SOLID_FS, MIX_FS, MASKVIEW_FS, BLEND_INDEX } from './shaders';
import { adjustmentUniforms } from './adjust';
import { apply } from './vector';
import { cpuFlatten } from './ops';

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

interface CompTile { tex: WebGLTexture; fb: WebGLFramebuffer; mipsValid: boolean }

/** Textura de un tile de capa. Varias capas pueden compartirla (duplicados). */
interface GpuTile { tex: WebGLTexture; refs: number; opaque: boolean }

/** Elemento de la pila de composición (capa, estilos auxiliares o ajuste). */
interface Item { L: PixelLayer; blend: string; opacity: number; useMask: boolean; adjust: boolean }

/** Nodo del árbol de composición. */
type Node =
  | { t: 'layer'; L: PixelLayer; items: Item[] }
  | { t: 'group'; L: PixelLayer; children: Node[] }
  | { t: 'clip'; L: PixelLayer; base: Node; clipped: Node[] };

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer };
type Frame = [Target, Target];

interface Preview { layerIds: Set<number>; tex: WebGLTexture; src: Rect; matrix: Matrix }

const MIP_LEVELS = Math.log2(TILE) + 1;
const UNIFORMS_BASE = ['uRect', 'uTarget', 'uFlipY'];
const MASK_UNIFORMS = ['uMask', 'uHasMask', 'uMaskFill'];

function isOpaque(data: Uint8ClampedArray): boolean {
  const u = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  for (let i = 0; i < u.length; i++) if (u[i] >>> 24 !== 255) return false;
  return true;
}

/**
 * Compositor WebGL2 que vive en el worker (OffscreenCanvas).
 * - Cada tile de capa es una textura; sólo se suben los tiles modificados.
 * - El documento se compone por tiles de 256×256; sólo se recomponen los sucios.
 * - Máscaras (R8), capas de ajuste (shader sobre el fondo) y estilos de capa.
 * - La vista dibuja los tiles compuestos con zoom (mipmaps al alejar).
 */
export class Renderer {
  gl: WebGL2RenderingContext;
  private canvas: OffscreenCanvas;
  private blendProg: Prog;
  private normalProg: Prog;
  private adjProg: Prog;
  private viewProg: Prog;
  private quadProg: Prog;
  private checkerProg: Prog;
  private solidProg: Prog;
  private vao: WebGLVertexArrayObject;
  private layerTex = new Map<number, Map<number, { data: Uint8ClampedArray; g: GpuTile }>>();
  private byData = new Map<Uint8ClampedArray, GpuTile>();
  private maskTex = new Map<number, Map<number, WebGLTexture>>();
  private lutTex = new Map<number, { key: string; tex: WebGLTexture | null; u: ReturnType<typeof adjustmentUniforms> }>();
  private comp = new Map<number, CompTile>();
  private frames: Frame[] = [];
  private maskViewProg: Prog;
  private maskQuadProg: Prog;
  private checkerQuadProg: Prog;
  /** Superposición roja de una máscara (Máscara rápida). */
  private overlay: { mask: MaskChannel; tex: Map<number, WebGLTexture> } | null = null;
  /** Canal visible (panel Canales): 0 = RGB, 1 R, 2 G, 3 B. */
  viewChannel = 0;
  private mixProg: Prog;
  private docDirty = new Set<number>();
  private allDirty = true;
  private preview: Preview | null = null;
  readonly info: string;
  readonly maxTexture: number;
  lastComposeMs = 0;
  lastUploads = 0;
  get gpuTextures() { return this.byData.size; }

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
    this.blendProg = this.program(RECT_VS, BLEND_FS, [...UNIFORMS_BASE, ...MASK_UNIFORMS, 'uBack', 'uSrc', 'uSrcOffset', 'uDocOrigin', 'uOpacity', 'uMode', 'uPremul', 'uAtop']);
    this.normalProg = this.program(RECT_VS, NORMAL_FS, [...UNIFORMS_BASE, ...MASK_UNIFORMS, 'uSrc', 'uSrcOffset', 'uOpacity', 'uPremul']);
    this.adjProg = this.program(RECT_VS, ADJ_FS, [...UNIFORMS_BASE, ...MASK_UNIFORMS, 'uBack', 'uLut', 'uKind', 'uP0', 'uP1', 'uP2', 'uSel', 'uOpacity', 'uMode', 'uAtop']);
    this.viewProg = this.program(RECT_VS, VIEW_FS, [...UNIFORMS_BASE, 'uTex', 'uUV', 'uAlpha', 'uChannel']);
    this.quadProg = this.program(QUAD_VS, VIEW_FS, ['uP', 'uTarget', 'uTex', 'uUV', 'uAlpha', 'uChannel']);
    this.maskViewProg = this.program(RECT_VS, MASKVIEW_FS, [...UNIFORMS_BASE, 'uTex', 'uUV', 'uFill', 'uHasTex']);
    this.maskQuadProg = this.program(QUAD_VS, MASKVIEW_FS, ['uP', 'uTarget', 'uTex', 'uUV', 'uFill', 'uHasTex']);
    this.checkerQuadProg = this.program(QUAD_VS, CHECKER_FS, ['uP', 'uTarget', 'uCell']);
    this.checkerProg = this.program(RECT_VS, CHECKER_FS, [...UNIFORMS_BASE, 'uCell']);
    this.solidProg = this.program(RECT_VS, SOLID_FS, [...UNIFORMS_BASE, 'uColor']);
    this.vao = gl.createVertexArray()!;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.mixProg = this.program(RECT_VS, MIX_FS, [...UNIFORMS_BASE, ...MASK_UNIFORMS, 'uBack', 'uSrc', 'uOpacity']);
    this.frame(0);
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

  private texParams(mips: boolean, linear = false) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  resize(w: number, h: number) {
    this.canvas.width = Math.max(1, Math.round(w));
    this.canvas.height = Math.max(1, Math.round(h));
  }

  invalidate(r: Rect | null) {
    if (!r) { this.allDirty = true; return; }
    const tx0 = Math.max(0, Math.floor(r.x / TILE)), ty0 = Math.max(0, Math.floor(r.y / TILE));
    const tx1 = Math.floor((r.x + r.w - 1) / TILE), ty1 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.docDirty.add(tileKey(tx, ty));
  }

  reset() {
    const gl = this.gl;
    for (const g of this.byData.values()) gl.deleteTexture(g.tex);
    this.byData.clear();
    this.layerTex.clear();
    for (const m of this.maskTex.values()) for (const t of m.values()) gl.deleteTexture(t);
    this.maskTex.clear();
    for (const l of this.lutTex.values()) if (l.tex) gl.deleteTexture(l.tex);
    this.lutTex.clear();
    for (const c of this.comp.values()) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); }
    this.comp.clear();
    this.clearPreview();
    this.docDirty.clear();
    this.allDirty = true;
  }

  // ------------------------------------------------------------ texturas

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

  private dropLayer(id: number) {
    const m = this.layerTex.get(id);
    if (m) { for (const e of m.values()) this.release(e.data); this.layerTex.delete(id); }
    const mm = this.maskTex.get(id);
    if (mm) { for (const t of mm.values()) this.gl.deleteTexture(t); this.maskTex.delete(id); }
    const l = this.lutTex.get(id);
    if (l) { if (l.tex) this.gl.deleteTexture(l.tex); this.lutTex.delete(id); }
  }

  /** Todas las capas que se dibujan, incluidas las auxiliares de estilos. */
  private allLayers(doc: EditorDocument): PixelLayer[] {
    const out: PixelLayer[] = [];
    for (const L of doc.layers) {
      if (L.fxUnder) out.push(L.fxUnder);
      out.push(L);
      if (L.fxOver) out.push(L.fxOver);
    }
    return out;
  }

  private syncLayer(L: PixelLayer) {
    const gl = this.gl;
    let m = this.layerTex.get(L.id);
    if (!m) {
      m = new Map();
      this.layerTex.set(L.id, m);
      for (const k of L.tiles.keys()) L.gpuDirty.add(k);
      if (L.mask) for (const k of L.mask.tiles.keys()) L.mask.gpuDirty.add(k);
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

    // Máscara (R8).
    let mm = this.maskTex.get(L.id);
    if (!L.mask) {
      if (mm) { for (const t of mm.values()) gl.deleteTexture(t); this.maskTex.delete(L.id); }
    } else {
      if (!mm) { mm = new Map(); this.maskTex.set(L.id, mm); for (const k of L.mask.tiles.keys()) L.mask.gpuDirty.add(k); }
      for (const k of L.mask.gpuRemoved) { const t = mm.get(k); if (t) { gl.deleteTexture(t); mm.delete(k); } }
      L.mask.gpuRemoved.clear();
      for (const k of L.mask.gpuDirty) {
        const data = L.mask.tiles.get(k);
        if (!data) continue;
        let t = mm.get(k);
        if (!t) {
          t = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, TILE, TILE);
          this.texParams(false);
          mm.set(k, t);
        } else gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE, TILE, gl.RED, gl.UNSIGNED_BYTE, data);
      }
      L.mask.gpuDirty.clear();
    }

    // LUT de la capa de ajuste.
    if (L.kind === 'adjustment' && L.adjustment) {
      const key = JSON.stringify(L.adjustment);
      const cur = this.lutTex.get(L.id);
      if (!cur || cur.key !== key) {
        const u = adjustmentUniforms(L.adjustment);
        let tex = cur?.tex ?? null;
        if (u.lut) {
          if (!tex) {
            tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1);
            this.texParams(false);
          }
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, u.lut);
        }
        this.lutTex.set(L.id, { key, tex, u });
      }
    }
  }

  private sync(doc: EditorDocument) {
    this.lastUploads = 0;
    const all = this.allLayers(doc);
    const alive = new Set(all.map((l) => l.id));
    for (const id of [...this.layerTex.keys()]) if (!alive.has(id)) this.dropLayer(id);
    for (const id of [...this.lutTex.keys()]) if (!alive.has(id)) this.dropLayer(id);
    for (const L of all) this.syncLayer(L);
  }

  // ------------------------------------------------------------ composición

  private setRect(prog: Prog, x0: number, y0: number, x1: number, y1: number, tw: number, th: number, flip: boolean) {
    const gl = this.gl;
    gl.uniform4f(prog.u.uRect, x0, y0, x1, y1);
    gl.uniform2f(prog.u.uTarget, tw, th);
    gl.uniform1i(prog.u.uFlipY, flip ? 1 : 0);
  }

  /**
   * Árbol de composición a partir de una lista de capas (de abajo a arriba):
   * grupos anidados y grupos de recorte (capa base + capas recortadas).
   * Las capas cuyo grupo no está en la lista se tratan como raíz.
   */
  private tree(layers: PixelLayer[]): Node[] {
    const ids = new Set(layers.map((l) => l.id));
    const byParent = new Map<number | null, PixelLayer[]>();
    for (const L of layers) {
      const p = L.parent != null && ids.has(L.parent) ? L.parent : null;
      let arr = byParent.get(p);
      if (!arr) byParent.set(p, (arr = []));
      arr.push(L);
    }
    const skip = this.preview?.layerIds;
    const nodeOf = (L: PixelLayer): Node => {
      if (L.kind === 'group') return { t: 'group', L, children: build(L.id) };
      const items: Item[] = [];
      if (L.fxUnder) items.push({ L: L.fxUnder, blend: 'normal', opacity: L.opacity, useMask: false, adjust: false });
      items.push({ L, blend: L.blend, opacity: L.opacity, useMask: !!L.mask && L.maskEnabled, adjust: L.kind === 'adjustment' });
      if (L.fxOver) items.push({ L: L.fxOver, blend: 'normal', opacity: L.opacity, useMask: false, adjust: false });
      return { t: 'layer', L, items };
    };
    const build = (pid: number | null): Node[] => {
      const out: Node[] = [];
      let base: number | null | undefined; // índice de la base actual; null = base oculta; undefined = ninguna
      for (const L of byParent.get(pid) ?? []) {
        const hidden = !L.visible || L.opacity <= 0 || !!skip?.has(L.id);
        if (L.clipped && base !== undefined) {
          if (base === null || hidden) continue; // base oculta: sus capas recortadas tampoco se ven
          let b = out[base];
          if (b.t !== 'clip') { b = { t: 'clip', L: b.L, base: b, clipped: [] }; out[base] = b; }
          b.clipped.push(nodeOf(L));
          continue;
        }
        if (hidden) { base = null; continue; }
        out.push(nodeOf(L));
        base = out.length - 1;
      }
      return out;
    };
    return build(null);
  }

  /** Pareja de búferes de trabajo de un nivel de anidamiento (grupos). */
  private frame(level: number): Frame {
    while (this.frames.length <= level) this.frames.push([this.makeTarget(1), this.makeTarget(1)]);
    return this.frames[level];
  }

  private bindMask(prog: Prog, it: Item, key: number) {
    const gl = this.gl;
    gl.uniform1i(prog.u.uMask, 2);
    if (!it.useMask) {
      gl.uniform1i(prog.u.uHasMask, 0);
      gl.uniform1f(prog.u.uMaskFill, 1);
      return;
    }
    const t = this.maskTex.get(it.L.id)?.get(key);
    gl.uniform1i(prog.u.uHasMask, t ? 1 : 0);
    gl.uniform1f(prog.u.uMaskFill, it.L.mask!.fill / 255);
    if (t) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, t); }
  }

  /** Copia F[0] en F[1], deja F[1] como destino y F[0] en la unidad 0 (fondo). */
  private backdrop(F: Frame) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, F[0].fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, F[1].fb);
    gl.blitFramebuffer(0, 0, TILE, TILE, 0, 0, TILE, TILE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, F[1].fb);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, F[0].tex);
  }

  private clearFrame(F: Frame, color: [number, number, number, number] = [0, 0, 0, 0]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, F[0].fb);
    gl.viewport(0, 0, TILE, TILE);
    gl.clearColor(...color);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Compone un tile del documento a partir del árbol `nodes` y deja el resultado en frame(0)[0].
   * Devuelve false si el tile queda totalmente vacío.
   */
  private composeInto(nodes: Node[], tx: number, ty: number, clearColor: [number, number, number, number]): boolean {
    const gl = this.gl;
    this.clearFrame(this.frame(0), clearColor);
    gl.bindVertexArray(this.vao);
    const any = this.composeNodes(nodes, 0, tx, ty, false, clearColor[3] > 0);
    gl.disable(gl.BLEND);
    return any;
  }

  private composeNodes(nodes: Node[], lvl: number, tx: number, ty: number, atop: boolean, any: boolean): boolean {
    // Oclusión: una capa Normal opaca al 100 % sin máscara tapa todo lo de debajo.
    let start = 0;
    if (!atop) {
      const dx0 = tx * TILE, dy0 = ty * TILE;
      for (let i = nodes.length - 1; i > 0; i--) {
        const n = nodes[i];
        if (n.t !== 'layer' || n.items.length !== 1) continue;
        const it = n.items[0];
        if (it.adjust || it.useMask || it.blend !== 'normal' || it.opacity < 1) continue;
        const L = it.L;
        if ((L.x % TILE) !== 0 || (L.y % TILE) !== 0) continue;
        const e = this.layerTex.get(L.id)?.get(tileKey((dx0 - L.x) / TILE, (dy0 - L.y) / TILE));
        if (e?.g.opaque) { start = i; break; }
      }
    }
    for (let i = start; i < nodes.length; i++) any = this.composeNode(nodes[i], lvl, tx, ty, atop, any);
    return any;
  }

  /** `ov`: fuerza modo y opacidad (la base de un grupo de recorte se dibuja aislada, en Normal al 100 %). */
  private composeNode(n: Node, lvl: number, tx: number, ty: number, atop: boolean, any: boolean, ov?: { blend: string; opacity: number }): boolean {
    const gl = this.gl;
    if (n.t === 'layer') {
      for (const it of n.items) {
        const item = ov ? { ...it, opacity: 1, blend: it.L === n.L ? ov.blend : it.blend } : it;
        any = this.drawItem(item, lvl, tx, ty, atop, any);
      }
      return any;
    }
    if (n.t === 'group') {
      const G = n.L;
      const blend = ov?.blend ?? G.blend, opacity = ov?.opacity ?? G.opacity;
      const gi: Item = { L: G, blend: blend === 'pass-through' ? 'normal' : blend, opacity, useMask: !!G.mask && G.maskEnabled, adjust: false };
      if (blend === 'pass-through' && !atop) {
        if (opacity >= 1 && !gi.useMask) return this.composeNodes(n.children, lvl, tx, ty, false, any);
        // Con opacidad o máscara: se compone sobre una copia del fondo y se mezcla con él.
        const P = this.frame(lvl), C = this.frame(lvl + 1);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, P[0].fb);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, C[0].fb);
        gl.blitFramebuffer(0, 0, TILE, TILE, 0, 0, TILE, TILE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        const cany = this.composeNodes(n.children, lvl + 1, tx, ty, false, any);
        if (!cany) return any;
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, P[1].fb);
        gl.viewport(0, 0, TILE, TILE);
        const M = this.mixProg;
        gl.useProgram(M.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, P[0].tex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, C[0].tex);
        gl.uniform1i(M.u.uBack, 0);
        gl.uniform1i(M.u.uSrc, 1);
        gl.uniform1f(M.u.uOpacity, opacity);
        this.bindMask(M, gi, tileKey(tx - G.x / TILE, ty - G.y / TILE));
        this.setRect(M, 0, 0, TILE, TILE, TILE, TILE, false);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        [P[0], P[1]] = [P[1], P[0]];
        return true;
      }
      const C = this.frame(lvl + 1);
      this.clearFrame(C);
      const cany = this.composeNodes(n.children, lvl + 1, tx, ty, false, false);
      if (!cany) return any;
      return this.drawFrame(C[0].tex, gi, lvl, tx, ty, atop, any);
    }
    // Grupo de recorte: base aislada + capas recortadas (conservan el alfa de la base);
    // el resultado se funde con el modo y la opacidad de la base.
    const bL = n.base.L;
    const C = this.frame(lvl + 1);
    this.clearFrame(C);
    let cany = this.composeNode(n.base, lvl + 1, tx, ty, false, false, { blend: bL.kind === 'group' ? 'pass-through' : 'normal', opacity: 1 });
    if (!cany) return any;
    for (const c of n.clipped) cany = this.composeNode(c, lvl + 1, tx, ty, true, cany);
    const blend = ov?.blend ?? bL.blend, opacity = ov?.opacity ?? bL.opacity;
    return this.drawFrame(C[0].tex, { L: bL, blend: blend === 'pass-through' ? 'normal' : blend, opacity, useMask: false, adjust: false }, lvl, tx, ty, atop, any);
  }

  /** Funde un búfer ya compuesto (premultiplicado, alineado con el tile) en el nivel `lvl`. */
  private drawFrame(tex: WebGLTexture, it: Item, lvl: number, tx: number, ty: number, atop: boolean, any: boolean): boolean {
    const gl = this.gl;
    if (atop && !any) return any;
    const F = this.frame(lvl);
    const normal = it.blend === 'normal';
    const prog = normal ? this.normalProg : this.blendProg;
    if (normal) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, F[0].fb);
      gl.enable(gl.BLEND);
      if (atop) gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog.p);
    } else {
      this.backdrop(F);
      gl.useProgram(prog.p);
      gl.uniform1i(prog.u.uBack, 0);
      gl.uniform2i(prog.u.uDocOrigin, tx * TILE, ty * TILE);
      gl.uniform1i(prog.u.uMode, BLEND_INDEX[it.blend] ?? 0);
      gl.uniform1i(prog.u.uAtop, atop ? 1 : 0);
    }
    gl.viewport(0, 0, TILE, TILE);
    gl.uniform1i(prog.u.uPremul, 1);
    gl.uniform1i(prog.u.uSrc, 1);
    gl.uniform1f(prog.u.uOpacity, it.opacity);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.bindMask(prog, it, tileKey(tx - Math.floor(it.L.x / TILE), ty - Math.floor(it.L.y / TILE)));
    gl.uniform2i(prog.u.uSrcOffset, 0, 0);
    this.setRect(prog, 0, 0, TILE, TILE, TILE, TILE, false);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    if (!normal) [F[0], F[1]] = [F[1], F[0]];
    return true;
  }

  /** Dibuja una capa (píxeles, estilo auxiliar o ajuste) sobre el nivel `lvl`. */
  private drawItem(it: Item, lvl: number, tx: number, ty: number, atop: boolean, any: boolean): boolean {
    const gl = this.gl;
    const P = this.blendProg, N = this.normalProg, J = this.adjProg;
    const F = this.frame(lvl);
    const L = it.L;
    const dx0 = tx * TILE, dy0 = ty * TILE;
    gl.viewport(0, 0, TILE, TILE);

    if (it.adjust) {
      if (!any && (atop || L.adjustment?.type !== 'solidColor')) return any; // nada que ajustar
      const lut = this.lutTex.get(L.id);
      if (!lut) return any;
      this.backdrop(F);
      gl.useProgram(J.p);
      gl.uniform1i(J.u.uBack, 0);
      gl.uniform1i(J.u.uLut, 3);
      if (lut.tex) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, lut.tex); }
      gl.uniform1i(J.u.uKind, lut.u.kind);
      gl.uniform4fv(J.u.uP0, lut.u.p0);
      gl.uniform4fv(J.u.uP1, lut.u.p1);
      gl.uniform4fv(J.u.uP2, lut.u.p2);
      if (lut.u.sel) gl.uniform4fv(J.u.uSel, lut.u.sel);
      gl.uniform1f(J.u.uOpacity, it.opacity);
      gl.uniform1i(J.u.uMode, BLEND_INDEX[it.blend] ?? 0);
      gl.uniform1i(J.u.uAtop, atop ? 1 : 0);
      this.bindMask(J, it, tileKey(tx, ty));
      this.setRect(J, 0, 0, TILE, TILE, TILE, TILE, false);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      [F[0], F[1]] = [F[1], F[0]];
      return true;
    }

    if (atop && !any) return any;
    const m = this.layerTex.get(L.id);
    if (!m || L.tiles.size === 0) return any;
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
    if (!hits.length) return any;
    const normal = it.blend === 'normal';
    const prog = normal ? N : P;
    if (normal) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, F[0].fb);
      gl.enable(gl.BLEND);
      if (atop) gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(N.p);
    } else {
      this.backdrop(F);
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uBack, 0);
      gl.uniform2i(P.u.uDocOrigin, dx0, dy0);
      gl.uniform1i(P.u.uMode, BLEND_INDEX[it.blend] ?? 0);
      gl.uniform1i(P.u.uAtop, atop ? 1 : 0);
    }
    gl.uniform1i(prog.u.uPremul, 0);
    gl.uniform1i(prog.u.uSrc, 1);
    gl.uniform1f(prog.u.uOpacity, it.opacity);
    for (const [tex, ltx, lty] of hits) {
      const ox = ltx * TILE + L.x - dx0, oy = lty * TILE + L.y - dy0;
      const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
      const x1 = Math.min(TILE, ox + TILE), y1 = Math.min(TILE, oy + TILE);
      if (x1 <= x0 || y1 <= y0) continue;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      this.bindMask(prog, it, tileKey(ltx, lty));
      gl.uniform2i(prog.u.uSrcOffset, ox, oy);
      this.setRect(prog, x0, y0, x1, y1, TILE, TILE, false);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    if (!normal) [F[0], F[1]] = [F[1], F[0]];
    return true;
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

  compose(doc: EditorDocument) {
    const t0 = performance.now();
    const gl = this.gl;
    this.sync(doc);
    const keys: number[] = [];
    if (this.allDirty) {
      for (let ty = 0; ty < doc.tilesY; ty++) for (let tx = 0; tx < doc.tilesX; tx++) keys.push(tileKey(tx, ty));
      for (const [k, c] of this.comp) {
        if (keyTx(k) >= doc.tilesX || keyTy(k) >= doc.tilesY) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); this.comp.delete(k); }
      }
    } else {
      for (const k of this.docDirty) if (keyTx(k) < doc.tilesX && keyTy(k) < doc.tilesY) keys.push(k);
    }
    this.allDirty = false;
    this.docDirty.clear();
    const nodes = keys.length ? this.tree(doc.layers) : [];
    for (const k of keys) {
      const any = this.composeInto(nodes, keyTx(k), keyTy(k), [0, 0, 0, 0]);
      if (!any) {
        const c = this.comp.get(k);
        if (c) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); this.comp.delete(k); }
        continue;
      }
      const c = this.compTile(k);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.frame(0)[0].fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, c.fb);
      gl.blitFramebuffer(0, 0, TILE, TILE, 0, 0, TILE, TILE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      c.mipsValid = false;
    }
    if (keys.length) this.lastComposeMs = performance.now() - t0;
    return keys.length;
  }

  // ------------------------------------------------------------ transformación libre

  /** Vista previa: la capa se sustituye por una textura reducida dibujada con la matriz. */
  setPreview(layerIds: number[], bitmap: ImageBitmap, src: Rect, matrix: Matrix) {
    const gl = this.gl;
    this.clearPreview();
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.texParams(true, true);
    this.preview = { layerIds: new Set(layerIds), tex, src, matrix };
    this.allDirty = true;
  }

  setPreviewMatrix(m: Matrix) { if (this.preview) this.preview.matrix = m; }

  clearPreview() {
    if (!this.preview) return;
    this.gl.deleteTexture(this.preview.tex);
    this.preview = null;
    this.allDirty = true;
  }

  // ------------------------------------------------------------ máscara rápida

  setMaskOverlay(mask: MaskChannel | null) {
    const gl = this.gl;
    if (this.overlay) for (const t of this.overlay.tex.values()) gl.deleteTexture(t);
    this.overlay = mask ? { mask, tex: new Map() } : null;
    if (mask) for (const k of mask.tiles.keys()) mask.gpuDirty.add(k);
  }

  private syncOverlay() {
    const o = this.overlay;
    if (!o) return;
    const gl = this.gl, m = o.mask;
    for (const k of m.gpuRemoved) { const t = o.tex.get(k); if (t) { gl.deleteTexture(t); o.tex.delete(k); } }
    m.gpuRemoved.clear();
    for (const k of m.gpuDirty) {
      const data = m.tiles.get(k);
      if (!data) continue;
      let t = o.tex.get(k);
      if (!t) { t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, TILE, TILE); this.texParams(false, true); o.tex.set(k, t); }
      else gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE, TILE, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    m.gpuDirty.clear();
  }

  // ------------------------------------------------------------ vista

  draw(doc: EditorDocument | null, view: ViewState) {
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.157, 0.157, 0.157, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    if (!doc) return;

    const s = view.zoom * view.dpr;
    const ox = view.panX * view.dpr, oy = view.panY * view.dpr;
    const X = (dx: number) => ox + dx * s, Y = (dy: number) => oy + dy * s;
    const dX0 = X(0), dY0 = Y(0), dX1 = X(doc.width), dY1 = Y(doc.height);
    // Vista girada (Rotar vista): cada rectángulo se dibuja como un cuadrilátero rotado.
    const rot = view.rot ?? 0, rc = Math.cos(rot), rs = Math.sin(rot), rcx = W / 2, rcy = H / 2;
    const R = (x: number, y: number) => [rcx + (x - rcx) * rc - (y - rcy) * rs, rcy + (x - rcx) * rs + (y - rcy) * rc];
    const quad = (prog: Prog, x0: number, y0: number, x1: number, y1: number) => {
      gl.uniform2fv(prog.u.uP, [...R(x0, y0), ...R(x1, y0), ...R(x0, y1), ...R(x1, y1)]);
      gl.uniform2f(prog.u.uTarget, W, H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    gl.disable(gl.BLEND);
    if (rot) {
      gl.useProgram(this.checkerQuadProg.p);
      gl.uniform1f(this.checkerQuadProg.u.uCell, 8 * view.dpr);
      quad(this.checkerQuadProg, dX0, dY0, dX1, dY1);
    } else {
      gl.useProgram(this.checkerProg.p);
      gl.uniform1f(this.checkerProg.u.uCell, 8 * view.dpr);
      this.setRect(this.checkerProg, dX0, dY0, dX1, dY1, W, H, true);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const P = rot ? this.quadProg : this.viewProg;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uTex, 0);
    gl.uniform1f(P.u.uAlpha, 1);
    gl.uniform1i(P.u.uChannel, this.viewChannel);
    gl.activeTexture(gl.TEXTURE0);
    const minify = s < 1;
    // Con la vista girada se dibujan todos los tiles (el recorte a pantalla es rectangular).
    const vtx0 = rot ? 0 : Math.max(0, Math.floor(-ox / s / TILE)), vty0 = rot ? 0 : Math.max(0, Math.floor(-oy / s / TILE));
    const vtx1 = rot ? doc.tilesX - 1 : Math.min(doc.tilesX - 1, Math.floor((W - ox) / s / TILE));
    const vty1 = rot ? doc.tilesY - 1 : Math.min(doc.tilesY - 1, Math.floor((H - oy) / s / TILE));
    for (let ty = vty0; ty <= vty1; ty++) {
      for (let tx = vtx0; tx <= vtx1; tx++) {
        const c = this.comp.get(tileKey(tx, ty));
        if (!c) continue;
        gl.bindTexture(gl.TEXTURE_2D, c.tex);
        if (minify && !c.mipsValid) { gl.generateMipmap(gl.TEXTURE_2D); c.mipsValid = true; }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minify ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
        const pw = Math.min(TILE, doc.width - tx * TILE), ph = Math.min(TILE, doc.height - ty * TILE);
        gl.uniform4f(P.u.uUV, 0, 0, pw / TILE, ph / TILE);
        if (rot) quad(P, X(tx * TILE), Y(ty * TILE), X(tx * TILE + pw), Y(ty * TILE + ph));
        else {
          this.setRect(P, X(tx * TILE), Y(ty * TILE), X(tx * TILE + pw), Y(ty * TILE + ph), W, H, true);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
      }
    }

    // Máscara rápida: rojo translúcido donde no hay selección.
    if (this.overlay) {
      this.syncOverlay();
      const M = rot ? this.maskQuadProg : this.maskViewProg, o = this.overlay;
      gl.useProgram(M.p);
      gl.uniform1i(M.u.uTex, 0);
      gl.uniform1f(M.u.uFill, o.mask.fill / 255);
      for (let ty = vty0; ty <= vty1; ty++) {
        for (let tx = vtx0; tx <= vtx1; tx++) {
          const t = o.tex.get(tileKey(tx, ty));
          if (!t && o.mask.fill >= 255) continue;
          gl.uniform1i(M.u.uHasTex, t ? 1 : 0);
          if (t) gl.bindTexture(gl.TEXTURE_2D, t);
          const pw = Math.min(TILE, doc.width - tx * TILE), ph = Math.min(TILE, doc.height - ty * TILE);
          gl.uniform4f(M.u.uUV, 0, 0, pw / TILE, ph / TILE);
          if (rot) quad(M, X(tx * TILE), Y(ty * TILE), X(tx * TILE + pw), Y(ty * TILE + ph));
          else {
            this.setRect(M, X(tx * TILE), Y(ty * TILE), X(tx * TILE + pw), Y(ty * TILE + ph), W, H, true);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        }
      }
    }

    // Vista previa de la transformación libre (encima de todo).
    if (this.preview) {
      const pv = this.preview, Q = this.quadProg, r = pv.src;
      const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].map(([x, y]) => {
        const [px, py] = apply(pv.matrix, x, y);
        return R(X(px), Y(py));
      });
      gl.useProgram(Q.p);
      gl.uniform2fv(Q.u.uP, corners.flat());
      gl.uniform2f(Q.u.uTarget, W, H);
      gl.uniform1i(Q.u.uTex, 0);
      gl.uniform1i(Q.u.uChannel, this.viewChannel);
      gl.uniform4f(Q.u.uUV, 0, 0, 1, 1);
      gl.uniform1f(Q.u.uAlpha, 1);
      gl.bindTexture(gl.TEXTURE_2D, pv.tex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);

    if (rot) return; // el borde fino sólo se dibuja con la vista recta
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

  // ------------------------------------------------------------ lectura

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
   * (RGBA, alfa directo). Sirve para combinar, acoplar, exportar y "muestrear todas las capas".
   */
  flatten(doc: EditorDocument, layers: PixelLayer[], region: Rect, background?: [number, number, number, number]): Uint8ClampedArray {
    // Caso común (Normal, sin estilos ni ajustes) y tamaño moderado: CPU, sin esperar a la GPU.
    if (region.w * region.h * layers.length <= 8e6) {
      const fast = cpuFlatten(layers, region, background);
      if (fast) return fast;
    }
    const gl = this.gl;
    const saved = this.preview;
    this.preview = null; // la exportación ignora la vista previa
    this.sync(doc);
    for (const L of layers) if (!doc.layers.includes(L)) this.syncLayer(L);
    const out = new Uint8ClampedArray(region.w * region.h * 4);
    const buf = new Uint8Array(TILE * TILE * 4);
    const bg: [number, number, number, number] = background
      ? [background[0] / 255 * background[3] / 255, background[1] / 255 * background[3] / 255, background[2] / 255 * background[3] / 255, background[3] / 255]
      : [0, 0, 0, 0];
    const tx0 = Math.floor(region.x / TILE), ty0 = Math.floor(region.y / TILE);
    const tx1 = Math.floor((region.x + region.w - 1) / TILE), ty1 = Math.floor((region.y + region.h - 1) / TILE);
    const nodes = this.tree(layers);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.composeInto(nodes, tx, ty, bg)) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.frame(0)[0].fb);
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
    this.preview = saved;
    return out;
  }
}
