const CACHE_NAME = 'impostore-v30';
// Cachear todos los recursos necesarios para funcionar offline
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './sw.js',
  './icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon.png?v=0.23.1',
  './icon-192.png?v=0.23.1',
  './icon-512.png?v=0.23.1',
  // Recursos externos críticos (se cachearán si están disponibles)
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js',
  'https://fonts.googleapis.com/css2?family=Russo+One&display=swap'
];

self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker (offline first)...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching essential files for offline use...');
        // Cachear recursos locales primero (siempre deben funcionar)
        const localUrls = urlsToCache.filter(url => url.startsWith('./'));
        return cache.addAll(localUrls)
          .then(() => {
            console.log('[SW] Local files cached, now caching external resources...');
            // Cachear recursos externos uno por uno (pueden fallar si no hay conexión)
            const externalUrls = urlsToCache.filter(url => !url.startsWith('./'));
            return Promise.allSettled(
              externalUrls.map(url => {
                // Verificar que la URL sea cacheable
                try {
                  const urlObj = new URL(url);
                  if (urlObj.protocol === 'chrome-extension:' || urlObj.protocol === 'chrome:' || urlObj.protocol === 'moz-extension:') {
                    console.warn(`[SW] Skipping unsupported scheme: ${url}`);
                    return Promise.resolve();
                  }
                } catch (e) {
                  // Si no es una URL válida, intentar cachear de todas formas
                }
                return fetch(url, { mode: 'no-cors' })
                  .then(response => {
                    if (response.ok || response.type === 'opaque') {
                      return cache.put(url, response).catch((err) => {
                        console.warn(`[SW] Failed to cache ${url}:`, err);
                      });
                    }
                  })
                  .catch(e => {
                    console.warn(`[SW] Failed to cache ${url}:`, e);
                    // No es crítico, se intentará cachear cuando se use
                  });
              })
            );
          })
          .catch((err) => {
            console.error('[SW] Cache failed:', err);
            // Continuar aunque falle
          });
      })
      .then(() => {
        console.log('[SW] Service worker installed, skipping waiting');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      console.log('[SW] Cleaning old caches...');
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated, claiming clients');
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const pathname = url.pathname;
  const isSameOrigin = url.origin === location.origin;
  
  // Ignorar esquemas no soportados (chrome-extension, chrome, etc.)
  if (url.protocol === 'chrome-extension:' || url.protocol === 'chrome:' || url.protocol === 'moz-extension:') {
    return; // No procesar estas peticiones
  }

  // No interceptar APIs externas de contador (evita problemas de CORS/cache en GH Pages/Vercel)
  // También excluir React y ReactDOM para evitar problemas de CORS
  if (
    url.hostname === 'api.countapi.xyz' ||
    url.hostname === 'api.counterapi.dev' ||
    url.hostname.endsWith('firebaseio.com') ||
    url.hostname.endsWith('firebasedatabase.app') ||
    url.hostname === 'firebasedatabase.googleapis.com' ||
    url.hostname === 'unpkg.com' && (url.pathname.includes('react') || url.pathname.includes('react-dom'))
  ) {
    // Importante: si fetch falla, respondWith NO debe rechazar la promesa (evita "promise was rejected")
    // Para React, dejar que se cargue directamente sin pasar por el SW
    if (url.hostname === 'unpkg.com' && (url.pathname.includes('react') || url.pathname.includes('react-dom'))) {
      return; // No interceptar, dejar que se cargue directamente
    }
    event.respondWith(
      fetch(event.request).catch(() => new Response('', { status: 502 }))
    );
    return;
  }

  if (isSameOrigin && event.request.mode === 'navigate') {
    event.respondWith(
      fetch('./index.html', { cache: 'no-cache' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('./index.html', responseToCache).catch(() => {});
            });
          }
          return networkResponse;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  
  // ESTRATEGIA OFFLINE FIRST: Cache First para todos los recursos locales
  // Esto permite que la app funcione completamente sin internet
  
  // Para recursos del mismo origen (index.html, iconos, manifest, etc)
  if (isSameOrigin) {
    // Estrategia especial para manifest.json: SIEMPRE obtener de la red, nunca cachear
    if (pathname.includes('manifest.json')) {
      event.respondWith(
        fetch(event.request, { 
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
          }
        })
          .then((networkResponse) => {
            // NO cachear el manifest.json para asegurar que siempre se obtenga la versión más reciente
            return networkResponse;
          })
          .catch(() => {
            // Si falla la red, intentar obtener del cache como último recurso
            return caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              return caches.match('./manifest.json', { ignoreSearch: true }).then((fallbackManifest) => {
                if (fallbackManifest) return fallbackManifest;
                return new Response('Manifest unavailable offline', { 
                  status: 503,
                  headers: { 'Content-Type': 'text/plain' }
                });
              });
            });
          })
      );
      return;
    }
    
    // Estrategia Network First para index.html: obtener de la red primero
    if (pathname.includes('index.html') || pathname === '/' || pathname.endsWith('/') || pathname === '') {
      event.respondWith(
        fetch(event.request, { cache: 'no-cache' })
          .then((networkResponse) => {
            if (networkResponse.status === 200) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                // Verificar que la URL sea cacheable antes de intentar cachear
                const requestUrl = new URL(event.request.url);
                if (requestUrl.protocol === 'chrome-extension:' || requestUrl.protocol === 'chrome:' || requestUrl.protocol === 'moz-extension:') {
                  return; // No cachear esquemas no soportados
                }
                cache.put(event.request, responseToCache).catch((err) => {
                  console.warn('[SW] Failed to cache resource:', err);
                });
              });
            }
            return networkResponse;
          })
          .catch(() => {
            // Si falla la red, usar cache como fallback
            return caches.match('./index.html').then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              return new Response('App unavailable offline', { 
                status: 503,
                headers: { 'Content-Type': 'text/html' }
              });
            });
          })
      );
      return;
    }
    
    event.respondWith(
      caches.match(event.request)
        .then((cachedResponse) => {
          // Si está en cache, devolverlo inmediatamente (offline first)
          if (cachedResponse) {
            // En segundo plano, intentar actualizar el cache si hay conexión
            // NO bloquear la respuesta, usar cache inmediatamente
            event.waitUntil(
              fetch(event.request)
                .then((networkResponse) => {
                  if (networkResponse.status === 200 || networkResponse.type === 'opaque') {
                    const responseToCache = networkResponse.clone();
                    return caches.open(CACHE_NAME).then((cache) => {
                      // Verificar que la URL sea cacheable antes de intentar cachear
                      const requestUrl = new URL(event.request.url);
                      if (requestUrl.protocol === 'chrome-extension:' || requestUrl.protocol === 'chrome:' || requestUrl.protocol === 'moz-extension:') {
                        return; // No cachear esquemas no soportados
                      }
                      return cache.put(event.request, responseToCache).catch((err) => {
                        console.warn('[SW] Failed to cache resource:', err);
                      });
                    });
                  }
                })
                .catch(() => {
                  // Sin conexión, no hacer nada, ya tenemos la versión cacheada
                })
            );
            return cachedResponse;
          }
          
          // Si no está en cache, intentar obtenerlo de la red
          return fetch(event.request)
            .then((networkResponse) => {
              // Solo cachear respuestas exitosas
              if (networkResponse.status === 200 || networkResponse.type === 'opaque') {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  // Verificar que la URL sea cacheable antes de intentar cachear
                  const requestUrl = new URL(event.request.url);
                  if (requestUrl.protocol === 'chrome-extension:' || requestUrl.protocol === 'chrome:' || requestUrl.protocol === 'moz-extension:') {
                    return; // No cachear esquemas no soportados
                  }
                  cache.put(event.request, responseToCache).catch((err) => {
                    console.warn('[SW] Failed to cache resource:', err);
                  });
                });
              }
              return networkResponse;
            })
            .catch(() => {
              // Si falla la red y no hay cache, devolver una respuesta básica
              if (pathname.includes('index.html') || pathname === '/' || pathname.endsWith('/') || pathname === '') {
                return caches.match('./index.html');
              }
              return new Response('Offline', { 
                status: 503,
                headers: { 'Content-Type': 'text/plain' }
              });
            });
        })
    );
  }
  // Para recursos externos (CDNs como React, Tailwind, etc)
  else {
    // Cache First también para recursos externos (si ya están cacheados)
    event.respondWith(
      caches.match(event.request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            // Intentar actualizar en segundo plano (no bloquear)
            event.waitUntil(
              fetch(event.request)
                .then((networkResponse) => {
                  if (networkResponse.status === 200 || networkResponse.type === 'opaque') {
                    const responseToCache = networkResponse.clone();
                    return caches.open(CACHE_NAME).then((cache) => {
                      // Verificar que la URL sea cacheable antes de intentar cachear
                      const requestUrl = new URL(event.request.url);
                      if (requestUrl.protocol === 'chrome-extension:' || requestUrl.protocol === 'chrome:' || requestUrl.protocol === 'moz-extension:') {
                        return; // No cachear esquemas no soportados
                      }
                      return cache.put(event.request, responseToCache).catch((err) => {
                        console.warn('[SW] Failed to cache resource:', err);
                      });
                    });
                  }
                })
                .catch(() => {
                  // Sin conexión, usar cache
                })
            );
            return cachedResponse;
          }
          
          // Si no está cacheado, intentar obtenerlo de la red
          return fetch(event.request)
            .then((networkResponse) => {
              // Cachear recursos externos exitosos para uso offline
              if (networkResponse.status === 200 || networkResponse.type === 'opaque') {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  // Verificar que la URL sea cacheable antes de intentar cachear
                  const requestUrl = new URL(event.request.url);
                  if (requestUrl.protocol === 'chrome-extension:' || requestUrl.protocol === 'chrome:' || requestUrl.protocol === 'moz-extension:') {
                    return; // No cachear esquemas no soportados
                  }
                  cache.put(event.request, responseToCache).catch((err) => {
                    console.warn('[SW] Failed to cache resource:', err);
                  });
                });
              }
              return networkResponse;
            })
            .catch(() => {
              // Si falla y no hay cache, devolver error
              return new Response('Resource unavailable offline', { 
                status: 503,
                headers: { 'Content-Type': 'text/plain' }
              });
            });
        })
    );
  }
});

// Escuchar mensajes para actualización
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
