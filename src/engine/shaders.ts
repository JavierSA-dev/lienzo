import { BLEND_MODES } from './types';

/** Índice numérico de cada modo de fusión para el shader. */
export const BLEND_INDEX: Record<string, number> = Object.fromEntries(BLEND_MODES.map((m, i) => [m, i]));

/** Vértices de un rectángulo en píxeles del destino, sin atributos (gl_VertexID). */
export const RECT_VS = `#version 300 es
uniform vec4 uRect;     // x0, y0, x1, y1 en píxeles del destino
uniform vec2 uTarget;   // tamaño del destino en píxeles
uniform bool uFlipY;    // true al dibujar en pantalla (y hacia abajo)
out vec2 vUV;
const vec2 C[4] = vec2[4](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 1.0));
void main() {
  vec2 c = C[gl_VertexID];
  vec2 px = mix(uRect.xy, uRect.zw, c);
  vUV = c;
  vec2 ndc = px / uTarget * 2.0 - 1.0;
  if (uFlipY) ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

/** Cuadrilátero arbitrario (4 esquinas en píxeles de pantalla): vista previa de transformar. */
export const QUAD_VS = `#version 300 es
uniform vec2 uP[4];     // esquinas: sup-izq, sup-der, inf-izq, inf-der
uniform vec2 uTarget;
out vec2 vUV;
const vec2 C[4] = vec2[4](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 1.0));
void main() {
  vUV = C[gl_VertexID];
  vec2 px = uP[gl_VertexID];
  vec2 ndc = px / uTarget * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

/** Malla deformada (perspectiva, deformar, posición libre): posición en píxeles de pantalla + UV. */
export const MESH_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUV;
uniform vec2 uTarget;
out vec2 vUV;
void main() {
  vUV = aUV;
  vec2 ndc = aPos / uTarget * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}`;

/** Funciones de fusión compartidas (fórmulas W3C/PDF, las mismas que usa Photoshop). */
const BLEND_LIB = `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float colorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}
float colorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float hardLight(float b, float s) {
  return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0));
}
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float vividLight(float b, float s) { return s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * (s - 0.5)); }
float pinLight(float b, float s) { return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0); }
float divideF(float b, float s) { if (s <= 0.0) return b <= 0.0 ? 0.0 : 1.0; return min(1.0, b / s); }
float sep(int m, float b, float s) {
  switch (m) {
    case 2: return min(b, s);
    case 3: return b * s;
    case 4: return colorBurn(b, s);
    case 5: return max(0.0, b + s - 1.0);
    case 7: return max(b, s);
    case 8: return b + s - b * s;
    case 9: return colorDodge(b, s);
    case 10: return min(1.0, b + s);
    case 12: return hardLight(s, b);
    case 13: return softLight(b, s);
    case 14: return hardLight(b, s);
    case 15: return vividLight(b, s);
    case 16: return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
    case 17: return pinLight(b, s);
    case 18: return b + s >= 1.0 ? 1.0 : 0.0;
    case 19: return abs(b - s);
    case 20: return b + s - 2.0 * b * s;
    case 21: return max(0.0, b - s);
    case 22: return divideF(b, s);
  }
  return s;
}
vec3 blendColor(int m, vec3 b, vec3 s) {
  if (m == 6) return lum(s) < lum(b) ? s : b;
  if (m == 11) return lum(s) > lum(b) ? s : b;
  if (m == 23) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 24) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 25) return setLum(s, lum(b));
  if (m == 26) return setLum(b, lum(s));
  return vec3(sep(m, b.r, s.r), sep(m, b.g, s.g), sep(m, b.b, s.b));
}
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
`;

/** Máscara de capa: textura R8 alineada con el tile de la capa, o un valor fijo. */
const MASK_LIB = `
uniform sampler2D uMask;
uniform bool uHasMask;
uniform float uMaskFill;
float maskAt(ivec2 p) { return uHasMask ? texelFetch(uMask, p, 0).r : uMaskFill; }
`;

/**
 * Composición de una capa sobre el fondo acumulado (premultiplicado).
 * co = as(1-ab)Cs + as·ab·B(Cb,Cs) + (1-as)·Cb·ab
 */
export const BLEND_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBack;
uniform sampler2D uSrc;
uniform ivec2 uSrcOffset;
uniform ivec2 uDocOrigin;
uniform float uOpacity;
uniform int uMode;
uniform bool uPremul;  // la fuente es un grupo ya compuesto (premultiplicado)
uniform bool uAtop;    // máscara de recorte: conserva el alfa del fondo
uniform int uBif;      // "Fusionar si": 0 no, 1 gris, 2 rojo, 3 verde, 4 azul
uniform vec4 uBifSelf; // negro inicio, negro fin, blanco inicio, blanco fin (0..1)
uniform vec4 uBifUnder;
out vec4 outColor;
${BLEND_LIB}
${MASK_LIB}
float bifRamp(float v, vec4 r) {
  float e = 0.5 / 255.0;
  float lo = r.y > r.x ? clamp((v - r.x) / (r.y - r.x), 0.0, 1.0) : (v >= r.x - e ? 1.0 : 0.0);
  float hi = r.w > r.z ? clamp((r.w - v) / (r.w - r.z), 0.0, 1.0) : (v <= r.z + e ? 1.0 : 0.0);
  return lo * hi;
}
float bifValue(vec3 c) { return uBif == 1 ? lum(c) : (uBif == 2 ? c.r : (uBif == 3 ? c.g : c.b)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 back = texelFetch(uBack, p, 0);
  vec4 src = texelFetch(uSrc, p - uSrcOffset, 0);
  float as = src.a * uOpacity * maskAt(p - uSrcOffset);
  if (uMode == 1) as = hash(vec2(p + uDocOrigin)) < as ? 1.0 : 0.0;
  float ab = back.a;
  vec3 cb = ab > 0.0 ? back.rgb / ab : vec3(0.0);
  vec3 cs = uPremul ? (src.a > 0.0 ? src.rgb / src.a : vec3(0.0)) : src.rgb;
  if (uBif > 0) as *= bifRamp(bifValue(cs), uBifSelf) * bifRamp(bifValue(cb), uBifUnder);
  vec3 B = clamp(blendColor(uMode, cb, cs), 0.0, 1.0);
  if (uAtop) { outColor = vec4(as * ab * B + (1.0 - as) * back.rgb, ab); return; }
  vec3 co = as * (1.0 - ab) * cs + as * ab * B + (1.0 - as) * back.rgb;
  float ao = as + ab * (1.0 - as);
  outColor = vec4(co, ao);
}`;

/** Camino rápido para capas Normal: la GPU hace el source-over con su mezcla fija. */
export const NORMAL_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSrcOffset;
uniform float uOpacity;
uniform bool uPremul;
out vec4 outColor;
${MASK_LIB}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) - uSrcOffset;
  vec4 s = texelFetch(uSrc, q, 0);
  float k = uOpacity * maskAt(q);
  if (uPremul) { outColor = s * k; return; }
  float a = s.a * k;
  outColor = vec4(s.rgb * a, a);
}`;

/**
 * Capas de ajuste (no destructivas) y capas de relleno.
 * uKind: 0 LUT por canal · 1 mapa de degradado · 2 tono/saturación · 3 blanco y negro
 *        4 equilibrio de color · 5 intensidad · 6 color sólido · 7 umbral
 */
export const ADJ_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBack;
uniform sampler2D uLut;
uniform highp sampler3D uLut3;
uniform int uKind;
uniform vec4 uP0;
uniform vec4 uP1;
uniform vec4 uP2;
uniform vec4 uSel[9];
uniform float uOpacity;
uniform int uMode;
uniform bool uAtop;
out vec4 outColor;
${BLEND_LIB}
${MASK_LIB}
vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5, h = 0.0, s = 0.0;
  float d = mx - mn;
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 h) {
  if (h.y <= 0.0) return vec3(h.z);
  float q = h.z < 0.5 ? h.z * (1.0 + h.y) : h.z + h.y - h.z * h.y;
  float p = 2.0 * h.z - q;
  return vec3(hue2rgb(p, q, h.x + 1.0 / 3.0), hue2rgb(p, q, h.x), hue2rgb(p, q, h.x - 1.0 / 3.0));
}
vec3 lut3(vec3 c) {
  ivec3 i = ivec3(clamp(c, 0.0, 1.0) * 255.0 + 0.5);
  return vec3(texelFetch(uLut, ivec2(i.r, 0), 0).r, texelFetch(uLut, ivec2(i.g, 0), 0).g, texelFetch(uLut, ivec2(i.b, 0), 0).b);
}
vec3 adjust(vec3 c) {
  if (uKind == 0) return lut3(c);
  if (uKind == 1) return texelFetch(uLut, ivec2(int(clamp(lum(c), 0.0, 1.0) * 255.0 + 0.5), 0), 0).rgb;
  if (uKind == 2) {
    vec3 h = rgb2hsl(c);
    if (uP0.w > 0.5) { h.x = uP0.x; h.y = uP0.y * 0.5 + 0.5; }
    else { h.x = fract(h.x + uP0.x); h.y = clamp(h.y * (1.0 + uP0.y), 0.0, 1.0); }
    vec3 r = hsl2rgb(h);
    return uP0.z >= 0.0 ? r + (1.0 - r) * uP0.z : r * (1.0 + uP0.z);
  }
  if (uKind == 3) {
    float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
    float mid = c.r + c.g + c.b - mx - mn;
    // Peso del primario (canal máximo) y del secundario (dos canales más altos).
    float wp = mx == c.r ? uP0.x : (mx == c.g ? uP0.z : uP1.x);
    float ws;
    if (mn == c.b) ws = uP0.y;        // amarillos (R+G)
    else if (mn == c.r) ws = uP0.w;   // cianes (G+B)
    else ws = uP1.y;                  // magentas (R+B)
    return vec3(clamp(mn + (mid - mn) * ws + (mx - mid) * wp, 0.0, 1.0));
  }
  if (uKind == 4) {
    float l = lum(c);
    float ws = 1.0 - smoothstep(0.0, 0.5, l), wh = smoothstep(0.5, 1.0, l), wm = 1.0 - ws - wh;
    vec3 r = clamp(c + uP0.rgb * ws + uP1.rgb * wm + uP2.rgb * wh, 0.0, 1.0);
    return setLum(r, l);
  }
  if (uKind == 5) {
    float l = lum(c);
    float s = sat(c);
    vec3 r = mix(vec3(l), c, 1.0 + uP0.x * (1.0 - s));
    return clamp(mix(vec3(lum(r)), r, 1.0 + uP0.y), 0.0, 1.0);
  }
  if (uKind == 7) return vec3(lum(c) >= uP0.x ? 1.0 : 0.0);
  if (uKind == 8) {
    // Corrección selectiva: cada gama pesa según su pureza y añade/quita tinta CMYK.
    float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
    float mid = c.r + c.g + c.b - mx - mn;
    float w[9];
    w[0] = mx == c.r && mx > mn ? mx - mid : 0.0;
    w[1] = mn == c.b && mx > mn ? mid - mn : 0.0;
    w[2] = mx == c.g && mx > mn && mx != c.r ? mx - mid : 0.0;
    w[3] = mn == c.r && mx > mn && mn != c.b ? mid - mn : 0.0;
    w[4] = mx == c.b && mx > mn && mx != c.r && mx != c.g ? mx - mid : 0.0;
    w[5] = mn == c.g && mx > mn && mn != c.b && mn != c.r ? mid - mn : 0.0;
    w[6] = max(0.0, mn - 0.5) * 2.0;
    w[8] = max(0.0, 0.5 - mx) * 2.0;
    w[7] = max(0.0, 1.0 - abs(mx - 0.5) - abs(mn - 0.5));
    vec3 ink = 1.0 - c;
    vec3 d = vec3(0.0);
    for (int i = 0; i < 9; i++) {
      if (w[i] <= 0.0) continue;
      vec4 a = uSel[i];
      vec3 k1 = uP0.x > 0.5 ? ink + a.rgb * ink : ink + a.rgb;
      k1 = clamp(k1, 0.0, 1.0);
      k1 = a.a >= 0.0 ? k1 + (1.0 - k1) * a.a * (uP0.x > 0.5 ? (1.0 - mx * 0.5) : 1.0) : k1 * (1.0 + a.a);
      d += (clamp(k1, 0.0, 1.0) - ink) * w[i];
    }
    return clamp(c - d, 0.0, 1.0);
  }
  if (uKind == 9) {
    vec3 r = mix(c, c * uP0.rgb, uP0.a);
    return uP1.x > 0.5 ? setLum(r, lum(c)) : r;
  }
  if (uKind == 11) return texture(uLut3, clamp(c, 0.0, 1.0) * uP0.x + uP0.y).rgb;
  if (uKind == 10) {
    return clamp(vec3(dot(c, uP0.rgb) + uP0.a, dot(c, uP1.rgb) + uP1.a, dot(c, uP2.rgb) + uP2.a), 0.0, 1.0);
  }
  return c;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 back = texelFetch(uBack, p, 0);
  float ab = back.a;
  vec3 cb = ab > 0.0 ? back.rgb / ab : vec3(0.0);
  float k = uOpacity * maskAt(p);
  if (uKind == 6) {
    vec3 cs = uP0.rgb;
    vec3 B = clamp(blendColor(uMode, cb, cs), 0.0, 1.0);
    if (uAtop) { outColor = vec4(k * ab * B + (1.0 - k) * back.rgb, ab); return; }
    outColor = vec4(k * (1.0 - ab) * cs + k * ab * B + (1.0 - k) * back.rgb, k + ab * (1.0 - k));
    return;
  }
  if (ab <= 0.0 || k <= 0.0) { outColor = back; return; }
  vec3 B = clamp(blendColor(uMode, cb, clamp(adjust(cb), 0.0, 1.0)), 0.0, 1.0);
  outColor = vec4(mix(cb, B, k) * ab, ab);
}`;

/** Grupo "Pasar a través" con opacidad o máscara: mezcla el fondo con el resultado del grupo. */
export const MIX_FS = `#version 300 es
precision highp float;
uniform sampler2D uBack;
uniform sampler2D uSrc;
uniform float uOpacity;
out vec4 outColor;
${MASK_LIB}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = mix(texelFetch(uBack, p, 0), texelFetch(uSrc, p, 0), uOpacity * maskAt(p));
}`;

/** Muestra una textura (premultiplicada) en pantalla. */
export const VIEW_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uUV;
uniform float uAlpha;
uniform int uChannel; // 0 = RGB; 1..3 = ver un solo canal en grises (panel Canales)
in vec2 vUV;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, mix(uUV.xy, uUV.zw, vUV)) * uAlpha;
  if (uChannel > 0) { float g = c.a > 0.0 ? c[uChannel - 1] / c.a : 0.0; c = vec4(vec3(g) * c.a, c.a); }
  outColor = c;
}`;

/** Damero de transparencia, de tamaño fijo en pantalla como en Photoshop. */
export const CHECKER_FS = `#version 300 es
precision highp float;
uniform float uCell;
out vec4 outColor;
void main() {
  vec2 c = floor(gl_FragCoord.xy / uCell);
  float k = mod(c.x + c.y, 2.0);
  outColor = vec4(vec3(k > 0.5 ? 0.8 : 1.0), 1.0);
}`;

/** Color plano (bordes, fondos). */
export const SOLID_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

/** Máscara en rojo translúcido (Alt+clic en la máscara o máscara rápida). */
export const MASKVIEW_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uUV;
in vec2 vUV;
out vec4 outColor;
uniform float uFill;   // sin textura: valor fijo de la máscara
uniform bool uHasTex;
void main() {
  float m = uHasTex ? texture(uTex, mix(uUV.xy, uUV.zw, vUV)).r : uFill;
  float a = (1.0 - m) * 0.5;
  outColor = vec4(1.0 * a, 0.0, 0.0, a);
}`;
