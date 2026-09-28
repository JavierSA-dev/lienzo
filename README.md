# Lienzo — editor de imágenes web

Editor tipo Photoshop que corre entero en el navegador. Nombre provisional: se cambia en `src/app/brand.ts`, `index.html` y `public/manifest.webmanifest`.

## Arrancar

```bash
npm install
npm run dev          # http://localhost:5173
```

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo con recarga en caliente |
| `npm run build` | Comprueba tipos y genera `dist/` para producción |
| `npm test` | Tests unitarios del motor (Vitest) |
| `npm run e2e` | Prueba de la fase 1 en Chromium (pincel, historial, capas, PSD de 50 capas, rendimiento) |
| `node tests/e2e-full.mjs` | Prueba completa de las fases 2–6: 163 comprobaciones con ratón y teclado reales |
| `node tests/shots.mjs` | Capturas de la interfaz para revisión visual |
| `npm run bench` | Compara Lienzo con Photopea en **tu** Chrome y **tu** GPU (`bench/resultados.md`) |

La primera vez que uses Playwright: `npx playwright install chromium`.

## Arquitectura

```
Hilo principal (React)          Worker del motor                      GPU (WebGL2)
─────────────────────           ─────────────────────                 ─────────────────
Menús, paneles, atajos   ──►    Documento y capas (tiles 256×256)  ──► Compositor por tiles
Entrada del lápiz               Historial por deltas de tiles          27 modos de fusión
(eventos agrupados)      ◄──    Pincel, selección, texto, formas       Capas de ajuste, máscaras
                                Pool de workers (filtros, resample)    Vista con zoom/mipmaps
                                IA local (ONNX, WebAssembly)
```

- **La interfaz nunca procesa píxeles.** Todo el trabajo pesado vive en `src/engine/` dentro de un worker; la tarea más larga del hilo principal en todas las pruebas es 0 ms.
- **Capas dispersas por tiles** con copia en escritura: duplicar es instantáneo y el historial guarda sólo los tiles que cambian (50 pasos o 1 GB).
- **Compositor GPU**: Normal con mezcla fija, el resto con un shader de 27 modos; capas de ajuste (LUT, HSL, B/N, equilibrio de color…), máscaras R8, estilos de capa y descarte de capas tapadas. Combinar capas en modo Normal usa una ruta CPU sin esperar a la GPU.
- **Pool de workers** (`pool.ts`) con `SharedArrayBuffer`: filtros, redimensionado, transformaciones y licuar por bandas en paralelo.
- **Registro de comandos** (`src/app/commands.ts`): menús, atajos, acciones grabadas y la lista de atajos (Ctrl+Alt+Mayús+K) salen de la misma tabla.
- COOP/COEP obligatorios (`crossOriginIsolated`). En hosting estático sin cabeceras, el service worker (`public/sw.js`) las añade.

## Qué incluye

**Herramientas**: Mover (selección automática), Marco rectangular/elíptico, Lazo, Lazo poligonal, Varita mágica, Recortar, Cuentagotas, Pincel corrector puntual, Pincel corrector, Parche, Pincel, Lápiz, Tampón de clonar, Borrador, Degradado (lineal, radial, angular, reflejado, rombo), Bote de pintura, Desenfocar/Enfocar/Dedo, Sobreexponer/Subexponer, Pluma y Selección directa, Texto, Formas (rectángulo, redondeado, elipse, línea, polígono), Mano y Zoom.

**Selección**: añadir/restar/intersecar con Mayús/Alt, calar, expandir/contraer, invertir, volver a seleccionar, mover con flechas, cargar desde capa (Ctrl+clic en la miniatura), seleccionar sujeto con IA.

**Capas**: selección de varias capas (Ctrl+clic, Mayús+clic, Ctrl+Alt+A) para mover, transformar, agrupar, combinar, duplicar, eliminar, cambiar opacidad/modo, alinear y distribuir; grupos anidados (Pasar a través o aislados, con opacidad, modo y máscara; plegar, arrastrar dentro y fuera, mover y transformar el grupo entero), máscaras de recorte, máscaras (pintar, desactivar, aplicar, invertir), capas de ajuste no destructivas (Niveles, Curvas, Tono/Saturación, Equilibrio de color, Blanco y negro, Brillo/Contraste, Exposición, Intensidad, Invertir, Posterizar, Umbral, Mapa de degradado, Color sólido), estilos (sombra paralela, resplandor exterior, trazo, superposición de color), texto y formas editables, bloquear transparencia, combinar, estampar, acoplar.

**Imagen y edición**: tamaño de imagen y de lienzo, recortar, rotar/voltear, transformación libre (Ctrl+T con escala, rotación y numérico), copiar/pegar con el portapapeles del sistema, rellenar, ajustes destructivos con vista previa.

**Retoque**: pincel corrector puntual y relleno según contenido (síntesis de textura con PatchMatch y fusión de Poisson, en local), pincel corrector con Alt+clic de origen.

**Trazados**: panel Trazados (trazado de trabajo, guardar, renombrar, duplicar, eliminar, hacer trazado desde la selección), cada edición en el historial (Ctrl+Z), pluma con curvas Bézier (esquinas, curvas, romper manejadores con Alt, cerrar), mover anclas y manejadores (A o Ctrl), convertir en selección (Ctrl+Intro), en capa de forma, rellenar o contornear con el pincel.

**Filtros** (con vista previa): desenfoque gaussiano, de cuadro y de movimiento, máscara de enfoque, enfocar, ruido, mosaico, paso alto, hallar bordes, relieve, nubes, mediana y Licuar (deformar, reconstruir, fruncir, inflar).

**IA**: quitar fondo y seleccionar sujeto en local (u2netp, Apache-2.0, 4,5 MB, sin servidor). Relleno generativo con proveedor configurable; `server/generative-proxy.mjs` es un proxy de referencia con créditos diarios por usuario (base del modelo freemium).

**Archivos**: PSD/PSB (grupos, máscaras de recorte, máscaras y capas de ajuste de ida y vuelta), PNG, JPEG, WebP, GIF, BMP, AVIF. PWA instalable que abre imágenes desde el sistema operativo.

**Acciones**: grabar, reproducir, renombrar (doble clic) y borrar secuencias de comandos.

## Atajos (idénticos a Photoshop en Windows)

- Herramientas: V M L W C I J B S E G O P T A U H Z; Mayús+letra alterna dentro del grupo y cada letra recuerda la última del grupo.
- Temporales: Espacio (mano), Ctrl+Espacio (zoom), Alt (cuentagotas al pintar), Ctrl (mover). Mantener una letra más de 300 ms la usa temporalmente y al soltar vuelve a la anterior.
- 1–0 opacidad (dos cifras rápidas = valor exacto), Mayús+1–0 flujo; con herramientas que no pintan cambian la opacidad de la capa.
- Mayús+Alt+letra = modo de fusión (M multiplicar, S trama, O superponer…); Mayús++ / Mayús+- recorren los modos.
- Pincel: `[` `]` tamaño, Mayús+`[` `]` dureza, Alt+clic derecho arrastrando = tamaño/dureza en vivo, Bloq Mayús = cursor de precisión.
- Grupos y recortes: Ctrl+G agrupa, Ctrl+Mayús+G desagrupa, Ctrl+Alt+G (o Alt+clic en la capa) crea/libera la máscara de recorte, Ctrl+E con un grupo lo combina.
- Pluma: Ctrl+Intro = selección, Intro/Esc terminan, Retroceso borra el ancla o el trazado.
- Menús: Ctrl+Z/Ctrl+Mayús+Z/Ctrl+Alt+Z, Ctrl+J, Ctrl+Mayús+J, Ctrl+E, Ctrl+Mayús+E, Ctrl+Alt+Mayús+E, Ctrl+[ ], Alt+[ ], Ctrl+L/M/U/B/I, Ctrl+Mayús+U/L/B, Ctrl+Alt+I/C, Ctrl+T, Ctrl+D, Ctrl+Mayús+D, Ctrl+Mayús+I, Mayús+F5/F6/F7, Ctrl+Alt+F, Ctrl+Mayús+X, Ctrl+0/1, Ctrl+H, Tab, F…
- Chrome reserva Ctrl+N/T/W y Ctrl+Mayús+N/T/W en una pestaña normal: funcionan en pantalla completa (F) y tienen alternativa (Ctrl+Alt+N, Ctrl+F4, Ctrl+Alt+Mayús+N…), indicada en los menús.

## Resultados verificados (entorno de pruebas, GPU emulada por CPU)

- 21/21 tests unitarios, 24/24 de la fase 1 y 163/163 de las fases 2–6 en Chromium.
- Composición GPU igual que la referencia en CPU (diferencia máxima 1/255, PSD de 50 capas).
- Desenfoque gaussiano de 20 px en 24 MP: la interfaz no se bloquea (tarea larga máxima 0 ms).
- Quitar fondo con IA local: ~2,5 s en CPU emulada. Relleno según contenido de un hueco de 150 px: ~1–3 s en un hilo.

Los tiempos absolutos no son representativos en ese entorno; ejecuta `npm run bench` en tu PC.

## Pendiente

Ver el plan completo por fases en el documento del proyecto: varios documentos, guías, canales, modo móvil, objetos inteligentes, fuentes, IA (selección de objeto, Quitar, escalado), Camera Raw, RAW, CMYK y 16 bits, relleno según contenido local, colaboración en tiempo real y app de escritorio (Tauri).
