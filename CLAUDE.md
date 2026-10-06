# Lienzo: contexto para Claude

Editor de imágenes profesional (tipo Photoshop) que corre entero en el navegador. Lo dirige Javier (JavierSA-dev).
Si eres una sesión nueva de Claude, lee esto entero antes de tocar nada.

## Cómo quiere trabajar Javier

- **Idioma:** español, directo y conciso.
- **Autonomía:** trabaja sin pedir confirmación. "Permito todo, no preguntes más."
- **Calidad profesional.** Los atajos de teclado son los de Photoshop.
- **Pruebas:** todo se prueba con Playwright, en escritorio y en móvil, antes de dar algo por hecho.
- **Marcas:** no uses marcas de Adobe en nombres de funciones. Di "Relleno generativo" o "Edición con IA", nunca el nombre comercial de Adobe.
- **Ordenador de Javier:** no toques su escritorio con control remoto mientras lo usa.
- **Commits:** puede firmarlos Claude. Javier hace `git push` (o pulsa "Push origin" en GitHub Desktop).

## Producción

| Qué | Dónde |
| --- | --- |
| Presentación (landing) | https://lienzo-editor.vercel.app/ |
| Editor | https://lienzo-editor.vercel.app/app/ |

- **Hosting:** Vercel, proyecto `lienzo`, equipo `team_XHQilR9iYHCmrWv5r7KzqNUu`, id `prj_TSeM4VWUkRebIsNlE8ggxTSbQo1f`.
- **Despliegue:** cada push a `main` despliega solo.
- **Variables de entorno en Vercel:**
  - `ANTHROPIC_API_KEY`: no la pidas ni la muestres nunca.
  - Upstash Redis con prefijo `STORAGE_` (`STORAGE_KV_REST_API_URL` y `STORAGE_KV_REST_API_TOKEN`), para la cuota.
  - Opcionales: `ASSISTANT_MODEL` (por defecto `claude-sonnet-4-5`), `ASSISTANT_MAX_TOKENS` (12000), `AI_DAILY_LIMIT` (10), `AI_DAILY_IP_LIMIT` (30), `AI_DAILY_RAW_LIMIT` (120), `AI_DAILY_RAW_IP_LIMIT` (300), `AI_GLOBAL_DAILY_LIMIT` (600), `PREMIUM_TOKENS`.
- **Límite de gasto:** Javier debe tener un tope mensual en la consola de Anthropic (Settings → Limits).
- **LinkedIn:** Javier va a anunciarlo con el mensaje "lo he hecho con Claude en 2 días, probadlo gratis". La imagen para compartir es `public/landing/og.jpg` (1200×630).

## Estructura

- **Páginas** (Vite multipágina, ver `vite.config.ts`):
  - `index.html`: la landing. Bilingüe es/en con atributos `data-en`.
  - `app/index.html`: el editor.
  - `vercel.json` redirige `/landing` → `/` y `/app` → `/app/`.
- **Motor** (`src/engine/`):
  - Se ejecuta en un Web Worker (`worker.ts`) con WebGL2 (`renderer.ts`, `shaders.ts`), teselas, un pool de workers e historial.
  - **Al añadir un método nuevo al motor, inclúyelo en la lista `ALLOWED` de `worker.ts`.** Si no, la llamada se rechaza.
  - Otros módulos: color (CMYK, prueba de color) `color.ts`, codificadores TIFF/PDF/GIF `encoders.ts`, SVG `svgexport.ts`, PSD `psd.ts`.
- **Interfaz** (`src/app/`, React + zustand en `store.ts`):
  - Comandos y atajos: `commands.ts`. Los menús, los atajos, las acciones grabables y la lista de atajos salen de esa tabla.
  - Móvil: `Mobile.tsx`.
  - Inglés: `src/app/i18n/`. Un MutationObserver traduce el DOM. Los textos nuevos van en `en.ts` y los que llevan números en `PATTERNS` de `index.ts`. `npm run i18n:scan` lista lo que falta.
- **Asistente de IA** (`src/app/assistant/`):
  - Intérprete local gratuito: `local.ts`. Resuelve órdenes habituales (mejorar, recortar, quitar fondo…) y órdenes sobre la selección (elimínalo, ponlo rojo, más claro, desenfócalo).
  - Si el intérprete local no lo resuelve, se usa un bucle de herramientas con el modelo vía `/api/assistant` (`api/assistant.js`, que contiene el mensaje de sistema). Las herramientas están en `tools.ts`.
  - Tras cada ronda, el modelo recibe una imagen del resultado. Con selección activa, recibe además la zona ampliada.
- **Barra contextual de la selección:** `src/app/SelectionBar.tsx`. Aparece bajo la selección con un campo para pedir cambios a la IA solo ahí. En móvil es "✨ Editar con IA" en la barra inferior.
- **Cuota de pruebas:** `api/_quota.js`.
  - Límites por día: 10 peticiones por navegador (cabecera `X-Lienzo-Device`) y 30 por IP; llamadas al modelo: 120 por navegador, 300 por IP y 600 en toda la web (techo de gasto, `AI_GLOBAL_DAILY_LIMIT`).
  - La API solo acepta bloques de texto, imagen en base64 y herramientas (máx. 4 imágenes por mensaje), para que no se use como proxy genérico.
  - Solo se cobra si el turno ejecuta herramientas.
  - `GET /api/assistant` devuelve la cuota.

## Comandos

```bash
npm install
npm run dev            # http://localhost:5173 (landing) y /app/ (editor)
npm run build          # tsc + vite build → dist/
npm test               # unitarios (vitest)
npm run e2e            # todas las baterías Playwright (Chromium con SwiftShader)
node tests/e2e-assistant.mjs   # asistente, IA sobre la selección y landing
```

Los tests e2e levantan `vite preview` sobre `dist/`, así que primero hay que ejecutar `npm run build`.

Resultados de la última vez que se pasaron:

| Batería | Resultado |
| --- | --- |
| Unitarios | 55 |
| e2e | 24 |
| full | 244 |
| select | 53 |
| photo | 34 |
| art | 25 |
| output | 66 |
| assistant | 46 |
| mobile | 72 |

## Pendiente o ideas

- **Calidad del asistente en vivo:**
  - Probar "dibuja un perro" (`draw_svg`).
  - Probar la sustitución de logos (MINECRAFT → TERRARIA, receta en el mensaje de sistema con `textLength`).
  - Comprobar que la cuota solo baja cuando se ejecutan herramientas.
- **Edición generativa real** (rellenar con contenido nuevo): necesitaría un modelo de imagen. Hay un diálogo "Relleno generativo" (`src/app/Generative.tsx`) que habla con un proveedor configurable.
- **Funciones de Photoshop que faltan:** paneles Navegador, Histograma e Info; Seleccionar cielo; convertir texto en forma; 16 bits; perfiles ICC; Punto de fuga.
