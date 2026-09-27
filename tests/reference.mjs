// Composición de referencia en CPU (fórmulas W3C), independiente del compositor GPU.
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clip = (c) => {
  const l = lum(c), n = Math.min(...c), x = Math.max(...c);
  let r = c;
  if (n < 0) r = r.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return r;
};
const setLum = (c, l) => { const d = l - lum(c); return clip(c.map((v) => v + d)); };
const sat = (c) => Math.max(...c) - Math.min(...c);
const setSat = (c, s) => { const mx = Math.max(...c), mn = Math.min(...c); return mx > mn ? c.map((v) => ((v - mn) * s) / (mx - mn)) : [0, 0, 0]; };
const burn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const dodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const hard = (b, s) => (s <= 0.5 ? b * 2 * s : 1 - (1 - b) * (1 - (2 * s - 1)));
const soft = (b, s) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};
const SEP = {
  normal: (b, s) => s, multiply: (b, s) => b * s, screen: (b, s) => b + s - b * s, overlay: (b, s) => hard(s, b),
  'soft light': soft, difference: (b, s) => Math.abs(b - s), 'color dodge': dodge, 'color burn': burn,
};
function blend(mode, b, s) {
  if (mode === 'luminosity') return setLum(b, lum(s));
  if (mode === 'color') return setLum(s, lum(b));
  if (mode === 'hue') return setLum(setSat(s, sat(b)), lum(b));
  if (mode === 'saturation') return setLum(setSat(b, sat(s)), lum(b));
  const f = SEP[mode];
  return b.map((v, i) => f(v, s[i]));
}

/** Devuelve el color compuesto (0..255, alfa directo) del píxel (x, y). */
export function compositePixel(children, x, y) {
  let cb = [0, 0, 0], ab = 0; // fondo sin premultiplicar
  for (const L of children) {
    const lx = x - (L.left ?? 0), ly = y - (L.top ?? 0);
    const img = L.imageData;
    if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) continue;
    const o = (ly * img.width + lx) * 4;
    const cs = [img.data[o] / 255, img.data[o + 1] / 255, img.data[o + 2] / 255];
    const as = (img.data[o + 3] / 255) * (L.opacity ?? 1);
    const B = blend(L.blendMode ?? 'normal', cb, cs).map((v) => Math.min(1, Math.max(0, v)));
    const co = cs.map((c, i) => as * (1 - ab) * c + as * ab * B[i] + (1 - as) * ab * cb[i]);
    const ao = as + ab * (1 - as);
    cb = ao > 0 ? co.map((v) => v / ao) : [0, 0, 0];
    ab = ao;
  }
  return [...cb.map((v) => Math.round(v * 255)), Math.round(ab * 255)];
}
