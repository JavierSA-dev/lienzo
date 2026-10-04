// Fuentes: las del sistema, las del equipo (Local Font Access) y Google Fonts cargadas bajo demanda.
// Se usa igual en el worker (self.fonts) y en la página (document.fonts).

/** Fuentes del sistema que casi todos los equipos tienen. */
export const SYSTEM_FONTS = [
  'Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Georgia', 'Times New Roman', 'Garamond',
  'Courier New', 'Consolas', 'Impact', 'Comic Sans MS', 'system-ui',
];

/** Selección de Google Fonts (licencia abierta) muy usadas en diseño y redes sociales. */
export const GOOGLE_FONTS = [
  'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins', 'Inter', 'Oswald', 'Raleway', 'Nunito', 'Rubik', 'Work Sans', 'DM Sans',
  'Manrope', 'Outfit', 'Sora', 'Plus Jakarta Sans', 'Karla', 'Mulish', 'Quicksand', 'Josefin Sans', 'Kanit', 'Barlow', 'Barlow Condensed',
  'Titillium Web', 'Fira Sans', 'Source Sans 3', 'Noto Sans', 'PT Sans', 'Ubuntu', 'IBM Plex Sans', 'Archivo', 'Cabin', 'Exo 2', 'Hind',
  'Libre Franklin', 'Roboto Condensed', 'Space Grotesk', 'Fredoka', 'Comfortaa',
  'Playfair Display', 'Merriweather', 'Lora', 'Noto Serif', 'PT Serif', 'Libre Baskerville', 'Crimson Text', 'DM Serif Display',
  'Roboto Slab', 'Zilla Slab', 'Bitter', 'IBM Plex Serif', 'Cinzel', 'Abril Fatface', 'Alfa Slab One',
  'Bebas Neue', 'Anton', 'Archivo Black', 'Russo One', 'Staatliches', 'Teko', 'Black Ops One', 'Orbitron', 'Righteous', 'Bangers',
  'Lobster', 'Pacifico', 'Dancing Script', 'Great Vibes', 'Satisfy', 'Sacramento', 'Kaushan Script', 'Yellowtail', 'Caveat',
  'Shadows Into Light', 'Permanent Marker', 'Indie Flower', 'Amatic SC',
  'Roboto Mono', 'Space Mono', 'JetBrains Mono', 'Press Start 2P',
];

type FontSet = FontFaceSet & { add(f: FontFace): FontFaceSet };
const loaded = new Map<string, Promise<boolean>>();

const fontSet = (): FontSet | null =>
  ((globalThis as unknown as { fonts?: FontSet }).fonts ?? (typeof document !== 'undefined' ? (document.fonts as FontSet) : null));

export const isGoogleFont = (family: string) => GOOGLE_FONTS.includes(family);

/** ¿Está ya disponible? (una fuente del sistema o una ya cargada). */
export function fontReady(family: string): boolean {
  if (!isGoogleFont(family)) return true;
  const p = loaded.get(family);
  return !!p && (p as Promise<boolean> & { done?: boolean }).done === true;
}

/** Descarga una Google Font (latín y latín extendido; normal, negrita y cursivas si existen). */
export function loadGoogleFont(family: string): Promise<boolean> {
  if (!isGoogleFont(family)) return Promise.resolve(true);
  let p = loaded.get(family);
  if (p) return p;
  p = (async () => {
    const set = fontSet();
    if (!set) return false;
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    let css = '';
    for (const q of [`${fam}:ital,wght@0,400;0,700;1,400;1,700`, `${fam}:wght@400;700`, fam]) {
      try {
        const r = await fetch(`https://fonts.googleapis.com/css2?family=${q}&display=swap`, { mode: 'cors' });
        if (r.ok) { css = await r.text(); break; }
      } catch { /* sin conexión */ }
    }
    if (!css) return false;
    const faces: Promise<FontFace>[] = [];
    const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      if (m[1] !== 'latin' && m[1] !== 'latin-ext') continue;
      const body = m[2];
      const url = /url\(([^)]+)\)/.exec(body)?.[1];
      if (!url) continue;
      // Se descarga el archivo y se crea la fuente desde los bytes: en el worker, las fuentes
      // creadas con url() no llegan a usarse en OffscreenCanvas.
      const bytes = await fetch(url.replace(/^['"]|['"]$/g, ''), { mode: 'cors' }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      if (!bytes) continue;
      const face = new FontFace(family, bytes, {
        style: /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal',
        weight: /font-weight:\s*([\d ]+)/.exec(body)?.[1]?.trim() ?? '400',
        unicodeRange: /unicode-range:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? 'U+0-10FFFF',
      });
      faces.push(face.load().then((f) => { set.add(f); return f; }));
    }
    const res = await Promise.allSettled(faces);
    return res.some((r) => r.status === 'fulfilled');
  })();
  p.then((ok) => { if (ok) (p as Promise<boolean> & { done?: boolean }).done = true; else loaded.delete(family); });
  loaded.set(family, p);
  return p;
}
