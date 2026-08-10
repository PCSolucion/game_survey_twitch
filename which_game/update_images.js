// ============================================================================
// SCRIPT DE DESCARGA DE IMÁGENES DESDE IGDB
// ============================================================================
// Ejecutar: npm run update-images
//
// Lee los títulos de data.js, busca las imágenes en IGDB y las descarga
// a la carpeta imagenes/. El overlay luego las usa como archivos locales.
// ============================================================================

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// Las credenciales se importan dinámicamente desde api.js

const apiContent = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf-8');
const clientIdMatch = apiContent.match(/clientId:\s*"([^"]+)"/);
const clientSecretMatch = apiContent.match(/clientSecret:\s*"([^"]+)"/);

const IGDB_CLIENT_ID = clientIdMatch ? clientIdMatch[1] : null;
const IGDB_CLIENT_SECRET = clientSecretMatch ? clientSecretMatch[1] : null;

if (!IGDB_CLIENT_ID || !IGDB_CLIENT_SECRET) {
  console.error("❌ Credenciales IGDB no encontradas en api.js. Asegúrate de configurar igdbConfig.");
  process.exit(1);
}

const IMAGES_DIR = path.join(__dirname, "imagenes");

// ── Token cache ──
let cachedToken = null;

/**
 * Obtiene un token OAuth2 de Twitch (Client Credentials Grant).
 */
async function getAccessToken() {
  if (cachedToken) return cachedToken;

  console.log("🔑 Solicitando token OAuth2 de Twitch...");

  const params = new URLSearchParams({
    client_id: IGDB_CLIENT_ID,
    client_secret: IGDB_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: params,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error obteniendo token: ${res.status} — ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  console.log(`✅ Token obtenido (expira en ${Math.round(data.expires_in / 3600)}h)\n`);
  return cachedToken;
}

/**
 * Fetch con reintentos automáticos para manejar rate limits (429).
 * Espera con backoff exponencial antes de reintentar.
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      const waitSecs = Math.pow(2, attempt + 1); // 2s, 4s, 8s
      console.warn(`  ⏳ Rate limit (429). Reintentando en ${waitSecs}s... (intento ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitSecs * 1000));
      continue;
    }

    return res;
  }

  throw new Error("Rate limit excedido tras múltiples reintentos");
}

/**
 * Busca un juego en IGDB por título y devuelve la URL de la imagen.
 * Prioridad: artworks > screenshots > cover
 */
async function searchGameImage(title) {
  const token = await getAccessToken();

  const body = `search "${title.replace(/"/g, '\\"')}";
fields name, artworks.image_id, screenshots.image_id, cover.image_id;
limit 1;`;

  const res = await fetchWithRetry("https://api.igdb.com/v4/games", {
    method: "POST",
    headers: {
      "Client-ID": IGDB_CLIENT_ID,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  ❌ Error buscando "${title}": ${res.status} — ${text}`);
    return null;
  }

  let results = await res.json();

  // Si no hay resultados, intentar búsqueda alternativa con where name ~
  if (!results || results.length === 0) {
    console.log(`  🔄 Reintentando con búsqueda alternativa...`);
    await new Promise((r) => setTimeout(r, 500));

    const altBody = `fields name, artworks.image_id, screenshots.image_id, cover.image_id;
where name ~ "${title.replace(/"/g, '\\"')}";
limit 1;`;

    const altRes = await fetchWithRetry("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": IGDB_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "text/plain",
      },
      body: altBody,
    });

    if (altRes.ok) {
      results = await altRes.json();
    }
  }

  if (!results || results.length === 0) {
    console.warn(`  ⚠️  No se encontró: "${title}"`);
    return null;
  }

  const game = results[0];
  let imageId = null;
  let source = "";

  // Prioridad: screenshots (gameplay) > cover > artworks (suelen ser logos/texto)
  if (game.screenshots && game.screenshots.length > 0) {
    imageId = game.screenshots[0].image_id;
    source = "screenshot";
  } else if (game.cover && game.cover.image_id) {
    imageId = game.cover.image_id;
    source = "cover";
  } else if (game.artworks && game.artworks.length > 0) {
    imageId = game.artworks[0].image_id;
    source = "artwork";
  }

  if (!imageId) {
    console.warn(`  ⚠️  "${title}" encontrado (${game.name}) pero sin imagen`);
    return null;
  }

  const imageUrl = `https://images.igdb.com/igdb/image/upload/t_720p/${imageId}.jpg`;
  console.log(`  ✅ ${game.name} → ${source} (${imageId})`);
  return imageUrl;
}

/**
 * Genera un nombre de archivo limpio a partir del título del juego
 */
function titleToFilename(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    + ".jpg";
}

/**
 * Descarga un archivo desde una URL HTTPS
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);

    client.get(url, (response) => {
      // Seguir redirecciones
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${response.statusCode}`));
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close(resolve);
      });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

/**
 * Extrae los títulos de juegos de data.js
 */
function extractTitles() {
  const dataPath = path.join(__dirname, "data.js");
  const content = fs.readFileSync(dataPath, "utf-8");

  const titles = [];
  const regex = /title:\s*["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    titles.push(match[1]);
  }

  return titles;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("  🎮 IGDB Image Downloader");
  console.log("══════════════════════════════════════════\n");

  // Crear carpeta imagenes si no existe
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  // Extraer títulos de data.js
  const titles = extractTitles();
  if (titles.length === 0) {
    console.error("❌ No se encontraron títulos en data.js");
    process.exit(1);
  }

  console.log(`📋 Juegos encontrados en data.js: ${titles.length}\n`);

  // Generar mapeo para data.js
  const imageMap = {};

  for (const title of titles) {
    const filename = titleToFilename(title);
    const destPath = path.join(IMAGES_DIR, filename);

    console.log(`🔍 Buscando: "${title}"...`);

    // Comprobar si ya existe
    if (fs.existsSync(destPath)) {
      const stats = fs.statSync(destPath);
      if (stats.size > 1000) {
        console.log(`  ⏩ Ya existe (${Math.round(stats.size / 1024)}KB), saltando\n`);
        imageMap[title.toLowerCase()] = `imagenes/${filename}`;
        continue;
      }
    }

    try {
      const imageUrl = await searchGameImage(title);
      if (imageUrl) {
        console.log(`  📥 Descargando...`);
        await downloadFile(imageUrl, destPath);
        const stats = fs.statSync(destPath);
        console.log(`  💾 Guardado: imagenes/${filename} (${Math.round(stats.size / 1024)}KB)\n`);
        imageMap[title.toLowerCase()] = `imagenes/${filename}`;
      } else {
        console.log(`  ⚠️  Sin imagen disponible\n`);
      }
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}\n`);
    }

    // Rate limit: IGDB permite 4 req/s, esperamos 500ms para margen de seguridad
    await new Promise((r) => setTimeout(r, 500));
  }

  // Guardar mapeo como JSON para referencia
  const cacheFile = path.join(IMAGES_DIR, "_igdb_cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify(imageMap, null, 2), "utf-8");

  console.log("══════════════════════════════════════════");
  console.log("  ✅ ¡Descarga completada!");
  console.log(`  📁 Imágenes en: ${IMAGES_DIR}`);
  console.log(`  📄 Cache: ${cacheFile}`);
  console.log("══════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("💥 Error fatal:", err);
  process.exit(1);
});
