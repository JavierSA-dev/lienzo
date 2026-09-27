# Lienzo — editor de imágenes web (fase 1)

Editor tipo Photoshop que corre entero en el navegador. Nombre provisional: se cambia en `src/app/brand.ts` e `index.html`.

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
| `npm run e2e` | Prueba completa en Chromium: pincel, historial, capas, modos de fusión, PSD de 50 capas, rendimiento (requiere `npx playwright install chromium` la primera vez) |
| `npm run bench` | Compara Lienzo con Photopea en **tu** Chrome y **tu** GPU y deja el resultado en `bench/resultados.md` |

## Arquitectura

```
Hilo principal (React)          Worker del motor                      GPU (WebGL2)
─────────────────────           ─────────────────────                 ─────────────────
Menús, paneles, atajos   ──►    Documento y capas (tiles 256×256)  ──► Compositor por tiles
Entrada del lápiz               Historial por deltas de tiles          27 modos de fusión
(eventos agrupados)      ◄──    Pincel, selección, E/S (PSD, PNG…)     Vista con zoom/mipmaps
                                Pool de workers (redimensionar)        OffscreenCanvas
```

- **La interfaz nunca procesa píxeles.** Todo el trabajo pesado vive en `src/engine/` dentro de un worker, así que la interfaz no se congela (en Photopea, redimensionar un documento de 24 MP la bloquea ~25 s).
- **Capas dispersas por tiles** (`document.ts`): sólo existen los tiles con contenido; pintar, deshacer y recomponer tocan sólo la zona afectada.
- **Duplicar es instantáneo**: las copias comparten tiles en CPU y texturas en GPU hasta que se modifican (copia en escritura).
- **Compositor GPU** (`renderer.ts`, `shaders.ts`): las capas Normal usan la mezcla fija de la GPU y el resto un shader con los 27 modos de Photoshop. Las capas tapadas por una capa opaca no se componen.
- **Historial** (`history.ts`): cada paso guarda sólo los tiles que cambiaron; límite de 50 pasos o 1 GB.
- **Registro de comandos** (`src/app/commands.ts`): menús y atajos usan la misma lista. Servirá para la paleta de comandos, las acciones grabadas y el asistente de IA.
- La página se sirve con COOP/COEP (`crossOriginIsolated`), lo que permite `SharedArrayBuffer` y WebAssembly con hilos. Mantén esas cabeceras en producción (ver `vite.config.ts`).

## Qué incluye la fase 1

- Herramientas: Mover, Marco rectangular, Pincel (tamaño, dureza, opacidad, flujo, presión), Borrador, Cuentagotas, Mano, Zoom. El resto aparece atenuado en la barra.
- Capas: nueva, duplicar, eliminar, reordenar arrastrando, visibilidad, opacidad, 27 modos de fusión, renombrar, combinar hacia abajo y acoplar.
- Imagen: tamaño de imagen, brillo/contraste, invertir y desaturar.
- Archivos: abrir PSD/PSB, PNG, JPEG, WebP, GIF, BMP y AVIF (también arrastrando); guardar PSD; exportar PNG, JPEG y WebP.
- Atajos de Photoshop: V M I B E H Z, `[` `]`, Mayús+`[` `]`, 1–0, D, X, Espacio (mano), Ctrl+Z / Ctrl+Mayús+Z, Ctrl+J, Ctrl+E, Ctrl+Mayús+N, Ctrl+A, Ctrl+D, Supr, Alt+Retroceso, Ctrl+0, Ctrl+1, Tab…

**Limitaciones conocidas** (se avisa al abrir un PSD): los grupos se aplanan, y las máscaras, las capas de ajuste y los estilos de capa aún no se editan. El texto y los objetos inteligentes se importan rasterizados.

## Resultados verificados (entorno de pruebas, GPU emulada por CPU)

- Composición GPU igual que la referencia en CPU: diferencia máxima de 1/255 en un PSD de 50 capas con 8 modos de fusión.
- Tarea más larga del hilo principal durante todas las pruebas: 0 ms.
- Trazo de 1000 puntos con un pincel de 100 px sobre 24 MP: ~0,6 ms por punto.

Los tiempos absolutos de composición no son representativos en ese entorno; ejecuta `npm run bench` en tu PC para ver los reales.

## Siguientes pasos (fase 2)

Texto, pluma y formas vectoriales, máscaras de capa, capas de ajuste no destructivas, estilos de capa, filtros principales (desenfoque gaussiano en GPU), transformación libre, tampón de clonar y selección con IA en local.
