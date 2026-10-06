/**
 * Cuadrícula con coordenadas del DOCUMENTO sobre las imágenes que ve el modelo.
 * Los modelos leen mal una escala escrita en el texto (tienden a usar los píxeles de la miniatura);
 * con las coordenadas dibujadas en la propia imagen localizan logos, caras o textos con precisión.
 */

const NICE = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

/** Paso de la cuadrícula (en px de documento) para que haya unas 6-12 líneas en el lado mayor. */
export function gridStep(docSpan: number): number {
  return NICE.find((n) => docSpan / n <= 12) ?? 20000;
}

/**
 * Dibuja la cuadrícula sobre un JPEG (base64). `scale` = px de imagen por px de documento y
 * (x0, y0) = esquina superior izquierda de la imagen en el documento. Devuelve otro JPEG en base64.
 */
export async function gridify(b64: string, scale: number, x0 = 0, y0 = 0): Promise<string> {
  try {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const img = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const docW = img.width / scale, docH = img.height / scale;
    const step = gridStep(Math.max(docW, docH));
    const fs = Math.max(10, Math.round(Math.min(img.width, img.height) / 45));
    g.font = `600 ${fs}px sans-serif`;
    g.textBaseline = 'top';
    const label = (t: string, x: number, y: number) => {
      const w = g.measureText(t).width + 4;
      g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x, y, w, fs + 3);
      g.fillStyle = '#ffeb3b'; g.fillText(t, x + 2, y + 1.5);
    };
    g.lineWidth = 1;
    const xs: number[] = [], ys: number[] = [];
    for (let v = Math.ceil(x0 / step) * step; v <= x0 + docW; v += step) xs.push(v);
    for (let v = Math.ceil(y0 / step) * step; v <= y0 + docH; v += step) ys.push(v);
    g.strokeStyle = 'rgba(255,0,200,.45)';
    for (const v of xs) { const x = Math.round((v - x0) * scale) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, img.height); g.stroke(); }
    for (const v of ys) { const y = Math.round((v - y0) * scale) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(img.width, y); g.stroke(); }
    for (const v of xs) label(String(v), Math.round((v - x0) * scale) + 2, 2);
    for (const v of ys) if (v !== ys[0] || (v - y0) * scale > fs + 6) label(String(v), 2, Math.round((v - y0) * scale) + 2);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  } catch {
    return b64;
  }
}

export const GRID_NOTE = 'La cuadrícula rosa rotula en amarillo las coordenadas de la vista (x arriba, y a la izquierda).';
