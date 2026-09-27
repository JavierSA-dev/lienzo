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

/**
 * Composición de una capa sobre el fondo acumulado (premultiplicado).
 * Fórmula de composición W3C/PDF: co = as(1-ab)Cs + as·ab·B(Cb,Cs) + (1-as)·Cb·ab
 */
export const BLEND_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBack;   // fondo acumulado, premultiplicado
uniform sampler2D uSrc;    // tile de la capa, alfa directo
uniform ivec2 uSrcOffset;  // píxel destino - texel origen
uniform ivec2 uDocOrigin;  // píxel de documento del origen del tile (para Disolver)
uniform float uOpacity;
uniform int uMode;
out vec4 outColor;

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
float vividLight(float b, float s) {
  return s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * (s - 0.5));
}
float pinLight(float b, float s) {
  return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
}
float divideF(float b, float s) {
  if (s <= 0.0) return b <= 0.0 ? 0.0 : 1.0;
  return min(1.0, b / s);
}
float sep(int m, float b, float s) {
  switch (m) {
    case 2: return min(b, s);                          // Oscurecer
    case 3: return b * s;                              // Multiplicar
    case 4: return colorBurn(b, s);                    // Subexposición de color
    case 5: return max(0.0, b + s - 1.0);              // Subexposición lineal
    case 7: return max(b, s);                          // Aclarar
    case 8: return b + s - b * s;                      // Trama
    case 9: return colorDodge(b, s);                   // Sobreexposición de color
    case 10: return min(1.0, b + s);                   // Sobreexposición lineal
    case 12: return hardLight(s, b);                   // Superponer
    case 13: return softLight(b, s);                   // Luz suave
    case 14: return hardLight(b, s);                   // Luz fuerte
    case 15: return vividLight(b, s);                  // Luz intensa
    case 16: return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);// Luz lineal
    case 17: return pinLight(b, s);                    // Luz focal
    case 18: return b + s >= 1.0 ? 1.0 : 0.0;          // Mezcla definida
    case 19: return abs(b - s);                        // Diferencia
    case 20: return b + s - 2.0 * b * s;               // Exclusión
    case 21: return max(0.0, b - s);                   // Restar
    case 22: return divideF(b, s);                     // Dividir
  }
  return s;                                            // Normal / Disolver
}
vec3 blendColor(int m, vec3 b, vec3 s) {
  if (m == 6) return lum(s) < lum(b) ? s : b;                    // Color más oscuro
  if (m == 11) return lum(s) > lum(b) ? s : b;                   // Color más claro
  if (m == 23) return setLum(setSat(s, sat(b)), lum(b));         // Tono
  if (m == 24) return setLum(setSat(b, sat(s)), lum(b));         // Saturación
  if (m == 25) return setLum(s, lum(b));                         // Color
  if (m == 26) return setLum(b, lum(s));                         // Luminosidad
  return vec3(sep(m, b.r, s.r), sep(m, b.g, s.g), sep(m, b.b, s.b));
}
float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 back = texelFetch(uBack, p, 0);
  vec4 src = texelFetch(uSrc, p - uSrcOffset, 0);
  float as = src.a * uOpacity;
  if (uMode == 1) as = hash(vec2(p + uDocOrigin)) < as ? 1.0 : 0.0;
  float ab = back.a;
  vec3 cb = ab > 0.0 ? back.rgb / ab : vec3(0.0);
  vec3 cs = src.rgb;
  vec3 B = clamp(blendColor(uMode, cb, cs), 0.0, 1.0);
  vec3 co = as * (1.0 - ab) * cs + as * ab * B + (1.0 - as) * back.rgb;
  float ao = as + ab * (1.0 - as);
  outColor = vec4(co, ao);
}`;

/** Muestra un tile compuesto (premultiplicado) en pantalla. */
export const VIEW_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uUV; // u0, v0, u1, v1
in vec2 vUV;
out vec4 outColor;
void main() {
  outColor = texture(uTex, mix(uUV.xy, uUV.zw, vUV));
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

/**
 * Camino rápido para capas en modo Normal: la GPU hace el "source-over"
 * premultiplicado con su mezcla fija, sin copiar el fondo (ping-pong).
 */
export const NORMAL_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSrcOffset;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy) - uSrcOffset, 0);
  float a = s.a * uOpacity;
  outColor = vec4(s.rgb * a, a);
}`;
