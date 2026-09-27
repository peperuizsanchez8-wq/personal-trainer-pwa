// Sube este número en CADA despliegue (aunque solo cambies una coma).
// Es lo único que fuerza a los móviles que ya tienen la app instalada
// a descargar la versión nueva en vez de quedarse con la de caché.
const CACHE_VERSION = "v11";
const CACHE_NAME = `entreno-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./favicon.svg",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  // No esperar a que se cierren las pestañas viejas: tomar el control ya.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith("entreno-shell-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Nunca interceptar llamadas a la API (Supabase): siempre red, siempre en vivo.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Para el propio código de la app: red primero, caché solo como respaldo offline.
  // Así una actualización llega en cuanto hay conexión, en vez de quedarse pegada.
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
