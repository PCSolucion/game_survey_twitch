import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseConfig, igdbConfig } from "./api.js";
import { blacklist } from "./blacklist.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ============================================================================
// CONFIGURACIÓN DEL OVERLAY
// ============================================================================
const config = {
  channelName: "liiukiin",
  commandAliases: ["!vota", "!votar", "!vote"],
  oneVotePerUser: true,
  carouselInterval: 10000, // Rotación del carrusel en ms (10 segundos)
  // Video Backgrounds
  backgrounds: [
    'fondos/isabela.mp4', 'fondos/bloodborne.mp4', 'fondos/ciri.mp4', 'fondos/claire.mp4',
    'fondos/geral.mp4', 'fondos/grace.mp4', 'fondos/gustave.mp4', 'fondos/jill.mp4',
    'fondos/karlach.mp4', 'fondos/laezel.mp4', 'fondos/leon.mp4', 'fondos/lune.mp4',
    'fondos/maelle.mp4', 'fondos/senua.mp4', 'fondos/shadow.mp4', 'fondos/triss.mp4', 'fondos/yenn.mp4'
  ].sort(() => Math.random() - 0.5),
  bgInterval: 15000
};

// ============================================================================
// CONSTANTES — Determinadas por data.js
// ============================================================================
const FIXED_COUNT = 6; // Slots fijos (!1 a !6)

function getCarouselData() {
  return Array.isArray(window.CAROUSEL_DATA) ? window.CAROUSEL_DATA : [];
}
function getFixedData() {
  return Array.isArray(window.OPTIONS_DATA) ? window.OPTIONS_DATA : [];
}
function getTotalOptions() {
  return FIXED_COUNT + getCarouselData().length;
}

// ============================================================================
// CLAVES DE ALMACENAMIENTO
// ============================================================================
const storageKeys = {
  games: `wg_${config.channelName}_games`,
  votes: `wg_${config.channelName}_votes`,
  voters: `wg_${config.channelName}_voters`,
  voterNames: `wg_${config.channelName}_voter_names`,
  levels: `wg_${config.channelName}_levels`,
  extraVotes: `wg_${config.channelName}_extra_votes`,
  igdbImages: `wg_${config.channelName}_igdb_images`,
};

// ============================================================================
// ESTADO GLOBAL
// ============================================================================
let websocket = null;
let currentGames = [];          // Títulos de TODOS los juegos (10)
let votesByIndex = [];           // Puntos por opción (10 elementos)

// Carousel state
let carouselDisplayIndex = 0;    // 0-based index within carousel games (0 = first carousel game = global index 2)
let carouselTimerId = null;
let carouselElements = null;     // DOM refs for the carousel card

// ── Voting state ──
let votingActive = true;           // false cuando hay un ganador
let winnerOptionIndex = -1;        // índice de la opción ganadora (-1 = ninguna)
const WINNER_THRESHOLD = 100;      // puntos necesarios para ganar
const MAX_USER_WEIGHT = 500;       // cap máximo de votos por usuario

// Mapas de estado de usuarios
const userVotes = new Map();          // userKey -> { choice: number, level: number, extraBonus: number }
const userDisplayNames = new Map();   // userKey -> displayName
const processingLock = new Set();     // Prevents concurrent processing for the same user
const clearedWinnerVoters = new Set(); // Users purged from a winning option — must restart fresh (extraBonus=0)

// Seguimiento de aumentos de votos para estadísticas de "en racha"
const recentIncreases = [];
let lastVotedGameIndex = -1;

// ============================================================================
// ELEMENTOS DEL DOM
// ============================================================================
const overlayEl = document.getElementById("overlay");
const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const resetBtnEl = document.getElementById("resetBtn");

// Elementos del DOM para Estadísticas
const statsPtsNeededEl = document.getElementById("stats-pts-needed");
const statsPtsNeededSubEl = document.getElementById("stats-pts-needed-sub");
const statsTopVoterEl = document.getElementById("stats-top-voter");
const statsTopVoterSubEl = document.getElementById("stats-top-voter-sub");
const statsFastestGameEl = document.getElementById("stats-fastest-game");
const statsFastestGameSubEl = document.getElementById("stats-fastest-game-sub");

// ============================================================================
// UTILIDADES
// ============================================================================

function calculateBaseWeight(level) {
  if (typeof level !== 'number' || level < 10) return 1;
  return Math.floor(level / 10);
}

function calculateTotalWeight(level, extraBonus) {
  const raw = calculateBaseWeight(level) + (extraBonus || 0);
  return Math.min(raw, MAX_USER_WEIGHT);
}

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD en la zona horaria de España
 */
function getSpanishDate() {
  return new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'Europe/Madrid', 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit' 
  }).format(new Date());
}

/**
 * Comprueba si el canal está en directo usando decapi.me
 */
async function isChannelLive() {
  try {
    const response = await fetch(`https://decapi.me/twitch/uptime/${config.channelName.toLowerCase()}`);
    const text = await response.text();
    // Si no está en directo, devuelve algo como "Channel is offline" o similar
    return !text.toLowerCase().includes("offline");
  } catch (e) {
    console.error('[LiveCheck] Error checking status:', e);
    return true; // En caso de error, permitimos para no bloquear por fallo de API externa
  }
}

/**
 * Recalcula votesByIndex desde cero basándose en userVotes.
 */
function recalculateAllVotes() {
  const total = getTotalOptions();
  votesByIndex = new Array(total).fill(0);
  
  for (const [userKey, data] of userVotes.entries()) {
    const { choice, level, extraBonus, fixedPoints } = data;
    const weight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    
    if (choice >= 0 && choice < total) {
      votesByIndex[choice] += weight;
    }
  }
  
  console.log('[Recalculate] Votes recalculated:', votesByIndex);
}

// ============================================================================
// LÓGICA DE ESTADÍSTICAS DINÁMICAS
// ============================================================================

function recordVoteIncrease(gameIndex, pointsDiff) {
  if (pointsDiff <= 0 || gameIndex < 0 || gameIndex >= getTotalOptions()) return;
  recentIncreases.push({
    gameIndex,
    points: pointsDiff,
    timestamp: Date.now()
  });
  lastVotedGameIndex = gameIndex;
  console.log(`[Stats] Recorded increase for game ${gameIndex + 1}: +${pointsDiff} pts`);
}

function updateStatsPanel() {
  const total = getTotalOptions();
  
  // --- 1. PUNTOS PARA ELEGIR ---
  let leaderIdx = -1;
  let maxVotes = 0;
  for (let i = 0; i < total; i++) {
    const v = votesByIndex[i] || 0;
    if (v > maxVotes) {
      maxVotes = v;
      leaderIdx = i;
    }
  }
  
  if (leaderIdx !== -1 && maxVotes > 0) {
    const needed = Math.max(0, Math.round((WINNER_THRESHOLD - maxVotes) * 10) / 10);
    const gameName = currentGames[leaderIdx] || `Opción ${leaderIdx + 1}`;
    
    if (statsPtsNeededEl) statsPtsNeededEl.textContent = `${needed} pts`;
    if (statsPtsNeededSubEl) statsPtsNeededSubEl.textContent = `para ${gameName}`;
  } else {
    if (statsPtsNeededEl) statsPtsNeededEl.textContent = `${WINNER_THRESHOLD} pts`;
    if (statsPtsNeededSubEl) statsPtsNeededSubEl.textContent = "Ningún voto registrado";
  }
  
  // --- 2. TOP VOTANTE ---
  let topVoterName = "-";
  let maxWeight = 0;
  
  for (const [userKey, data] of userVotes.entries()) {
    const { level, extraBonus, fixedPoints } = data;
    const weight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    if (weight > maxWeight) {
      maxWeight = weight;
      topVoterName = userDisplayNames.get(userKey) || userKey;
    }
  }
  
  if (maxWeight > 0) {
    const pts = Math.round(maxWeight * 10) / 10;
    if (statsTopVoterEl) statsTopVoterEl.textContent = topVoterName;
    if (statsTopVoterSubEl) statsTopVoterSubEl.textContent = `Aportó +${pts} pts a la encuesta`;
  } else {
    if (statsTopVoterEl) statsTopVoterEl.textContent = "-";
    if (statsTopVoterSubEl) statsTopVoterSubEl.textContent = "Nadie ha votado aún";
  }
  
  // --- 3. EN RACHA ---
  const now = Date.now();
  const windowMs = 60000; // 60 segundos
  
  // Limpiar registros antiguos
  while (recentIncreases.length > 0 && now - recentIncreases[0].timestamp > windowMs) {
    recentIncreases.shift();
  }
  
  // Calcular acumulados de aumentos
  const totals = {};
  for (const entry of recentIncreases) {
    totals[entry.gameIndex] = (totals[entry.gameIndex] || 0) + entry.points;
  }
  
  let fastestIdx = -1;
  let maxDiff = 0;
  for (const [idxStr, sum] of Object.entries(totals)) {
    const idx = parseInt(idxStr, 10);
    if (sum > maxDiff) {
      maxDiff = sum;
      fastestIdx = idx;
    }
  }
  
  if (fastestIdx !== -1 && maxDiff > 0) {
    const gameName = currentGames[fastestIdx] || `Opción ${fastestIdx + 1}`;
    const diffVal = Math.round(maxDiff * 10) / 10;
    if (statsFastestGameEl) statsFastestGameEl.textContent = gameName;
    if (statsFastestGameSubEl) statsFastestGameSubEl.textContent = `+${diffVal} pts en el último minuto`;
  } else if (lastVotedGameIndex !== -1 && lastVotedGameIndex < total) {
    const gameName = currentGames[lastVotedGameIndex] || `Opción ${lastVotedGameIndex + 1}`;
    if (statsFastestGameEl) statsFastestGameEl.textContent = gameName;
    if (statsFastestGameSubEl) statsFastestGameSubEl.textContent = "Último juego votado en el chat";
  } else {
    if (statsFastestGameEl) statsFastestGameEl.textContent = "-";
    if (statsFastestGameSubEl) statsFastestGameSubEl.textContent = "Sin actividad reciente";
  }
}

function getOptionByTitle(title) {
  try {
    const fixed = getFixedData();
    const carousel = getCarouselData();
    const all = [...fixed, ...carousel];
    return all.find(it => it && it.title === title) || null;
  } catch { return null; }
}

function getOptionDataByIndex(globalIndex) {
  const fixed = getFixedData();
  const carousel = getCarouselData();
  if (globalIndex < FIXED_COUNT) {
    return fixed[globalIndex] || null;
  }
  return carousel[globalIndex - FIXED_COUNT] || null;
}

// ============================================================================
// IGDB — Búsqueda de imágenes directa desde el navegador
// ============================================================================
const IGDB_CLIENT_ID = igdbConfig.clientId;
const IGDB_CLIENT_SECRET = igdbConfig.clientSecret;

let igdbToken = null;
let igdbTokenExpires = 0;

/**
 * Obtiene un token OAuth2 de Twitch (Client Credentials Grant).
 */
async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpires) return igdbToken;

  const params = new URLSearchParams({
    client_id: IGDB_CLIENT_ID,
    client_secret: IGDB_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: params,
  });

  if (!res.ok) throw new Error(`Token error: ${res.status}`);
  const data = await res.json();
  igdbToken = data.access_token;
  igdbTokenExpires = Date.now() + (data.expires_in - 60) * 1000;
  console.log("[IGDB] Token obtenido");
  return igdbToken;
}

/**
 * Busca un juego en IGDB y devuelve la URL de la imagen.
 * Prioridad: screenshots > cover > artworks
 */
async function fetchIgdbImage(title) {
  try {
    const token = await getIgdbToken();

    const body = `search "${title.replace(/"/g, '\\"')}";
fields name, screenshots.image_id, cover.image_id, artworks.image_id;
limit 1;`;

    const res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": IGDB_CLIENT_ID,
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      body,
    });

    if (!res.ok) {
      console.warn(`[IGDB] Error ${res.status} buscando "${title}"`);
      return null;
    }

    let results = await res.json();

    // Si no hay resultados, reintento con búsqueda por nombre exacto (case-insensitive)
    if (!results || results.length === 0) {
      const altBody = `fields name, screenshots.image_id, cover.image_id, artworks.image_id;
where name ~ "${title.replace(/"/g, '\\"')}";
limit 1;`;

      const altRes = await fetch("https://api.igdb.com/v4/games", {
        method: "POST",
        headers: {
          "Client-ID": IGDB_CLIENT_ID,
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        body: altBody,
      });

      if (altRes.ok) results = await altRes.json();
    }

    if (!results || results.length === 0) return null;

    const game = results[0];
    let imageId = null;

    if (game.screenshots?.length > 0) {
      imageId = game.screenshots[0].image_id;
    } else if (game.cover?.image_id) {
      imageId = game.cover.image_id;
    } else if (game.artworks?.length > 0) {
      imageId = game.artworks[0].image_id;
    }

    if (!imageId) return null;

    const url = `https://images.igdb.com/igdb/image/upload/t_720p/${imageId}.jpg`;
    console.log(`[IGDB] "${title}" → ${url}`);
    return url;
  } catch (e) {
    console.error(`[IGDB] Error buscando "${title}":`, e);
    return null;
  }
}

// Cache de imágenes en localStorage
const imageCache = new Map();

function loadImageCache() {
  try {
    const raw = localStorage.getItem(storageKeys.igdbImages);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        if (k && v) imageCache.set(k, v);
      }
    }
  } catch (e) {
    console.error('[IGDB] Error cargando cache:', e);
  }
}

function saveImageCache() {
  try {
    const obj = Object.fromEntries(imageCache.entries());
    localStorage.setItem(storageKeys.igdbImages, JSON.stringify(obj));
  } catch (e) {
    console.error('[IGDB] Error guardando cache:', e);
  }
}

// Cargar cache al inicio
loadImageCache();

/**
 * Genera nombre de archivo local (fallback si IGDB falla)
 */
function titleToFilename(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    + ".jpg";
}

/**
 * Resuelve la imagen de un juego.
 * 1. Imagen manual en data.js
 * 2. Cache de IGDB (localStorage)
 * 3. Búsqueda en IGDB en tiempo real
 * 4. Fallback a archivo local en imagenes/
 */
async function resolveGameImage(title, optionData) {
  if (!title) return null;

  // 1. Imagen específica (no "auto")
  if (optionData && optionData.image && optionData.image !== "auto") {
    return optionData.image;
  }

  const cacheKey = title.trim().toLowerCase();

  // 2. Cache
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  // 3. Buscar en IGDB
  const igdbUrl = await fetchIgdbImage(title);
  if (igdbUrl) {
    imageCache.set(cacheKey, igdbUrl);
    saveImageCache();
    return igdbUrl;
  }

  // 4. Fallback a archivo local
  const localPath = `imagenes/${titleToFilename(title)}`;
  imageCache.set(cacheKey, localPath);
  saveImageCache();
  return localPath;
}

function saveState() {
  try {
    localStorage.setItem(storageKeys.games, JSON.stringify(currentGames));
    
    const userVotesObj = {};
    for (const [key, data] of userVotes.entries()) {
      userVotesObj[key] = data;
    }
    localStorage.setItem(storageKeys.voters, JSON.stringify(userVotesObj));
    
    const displayNamesObj = Object.fromEntries(userDisplayNames.entries());
    localStorage.setItem(storageKeys.voterNames, JSON.stringify(displayNamesObj));
    
  } catch (e) {
    console.error('[Storage] Error saving state:', e);
  }
}

function loadState() {
  try {
    const userVotesRaw = localStorage.getItem(storageKeys.voters);
    const displayNamesRaw = localStorage.getItem(storageKeys.voterNames);
    
    if (displayNamesRaw) {
      const obj = JSON.parse(displayNamesRaw);
      for (const [key, val] of Object.entries(obj)) {
        userDisplayNames.set(key, val);
      }
    }
    
    if (userVotesRaw) {
      const obj = JSON.parse(userVotesRaw);
      const total = getTotalOptions();
      
      const lowerBlacklist = blacklist.map(u => u.toLowerCase());
      
      for (const [key, data] of Object.entries(obj)) {
        const userKey = key.toLowerCase();
        const displayName = (userDisplayNames.get(userKey) || "").toLowerCase();

        if (lowerBlacklist.includes(userKey) || (displayName && lowerBlacklist.includes(displayName))) {
          console.log(`[Blacklist] Skipping blacklisted user during load: ${userKey} (${displayName})`);
          continue;
        }
        
        if (typeof data === 'number') {
          if (data >= 0 && data < total) {
            userVotes.set(key, { choice: data, level: 0, extraBonus: 0 });
          }
          continue;
        }
        
        if (data && typeof data === 'object') {
          const userData = {
            choice: typeof data.choice === 'number' ? data.choice : -1,
            level: typeof data.level === 'number' ? data.level : 0,
            extraBonus: typeof data.extraBonus === 'number' ? data.extraBonus : 0
          };
          
          if (typeof data.fixedPoints === 'number') {
            userData.fixedPoints = data.fixedPoints;
          }

          // Preservar lastExtraDate para que el límite diario sobreviva recargas
          if (typeof data.lastExtraDate === 'string') {
            userData.lastExtraDate = data.lastExtraDate;
          }
          
          // Only load if choice is valid for current total
          if (userData.choice < total) {
            userVotes.set(key, userData);
          }
        }
      }
    }
    
    recalculateAllVotes();
    
  } catch (e) {
    console.error('[Storage] Error loading state:', e);
    userVotes.clear();
    votesByIndex = new Array(getTotalOptions()).fill(0);
  }
}

// ============================================================================
// UI - RENDERIZADO
// ============================================================================

/**
 * Comando de voto (!n) dentro de la tarjeta, junto al título del juego.
 */
function buildVoteCommandBadge(commandNum) {
  const el = document.createElement("div");
  el.className = "option-number option-number--in-card";
  el.setAttribute("role", "group");
  el.setAttribute(
    "aria-label",
    `Opción ${commandNum}: escribe !${commandNum} en el chat de Twitch`
  );
  el.innerHTML = `<span class="option-number__cmd">!${commandNum}</span>`;
  return el;
}

/**
 * Crea una tarjeta fija (slots 1 y 2)
 */
function createFixedCard(index) {
  const gameTitle = currentGames[index];
  const optionData = getOptionDataByIndex(index);
  
  const wrapper = document.createElement("div");
  wrapper.className = "card-wrapper entering";
  wrapper.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:0;height:100%;position:relative;";
  wrapper.style.animationDelay = `${index * 180}ms`;
  
  wrapper.addEventListener("animationend", (ev) => {
    if (ev.animationName === "slideInTech") {
      wrapper.classList.remove("entering");
      wrapper.style.animationDelay = "";
    }
  }, { once: true });
  
  const number = buildVoteCommandBadge(index + 1);
  
  // Card
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "flex:1;width:100%;";
  
  // Image
  setupCardImage(card, gameTitle, optionData);
  
  // Title row (comando + título en una sola franja)
  const top = document.createElement("div");
  top.className = "game-row";
  top.style.zIndex = "3";
  
  const title = document.createElement("div");
  title.className = "game-title";
  
  const titleText = document.createElement("span");
  titleText.style.cssText = "display:inline-block;white-space:nowrap;";
  titleText.textContent = gameTitle;
  title.appendChild(titleText);
  top.appendChild(number);
  top.appendChild(title);
  
  // Marquee for long titles
  setTimeout(() => {
    if (title.scrollWidth > title.clientWidth) {
      const dist = title.scrollWidth - title.clientWidth + 15;
      title.style.setProperty('--scroll-dist', `-${dist}px`);
      titleText.style.animation = 'scroll-marquee 4s linear infinite alternate';
    }
  }, 100);
  
  // Voter list
  const chips = document.createElement('div');
  chips.className = 'voter-inline';
  chips.style.cssText = 'z-index:5;left:0px;';
  
  // Votes badge
  const bottom = document.createElement("div");
  bottom.className = "votes-badge";
  bottom.style.zIndex = '20';
  
  const count = document.createElement("div");
  count.className = "vote-count";
  count.textContent = "0";
  
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "0%";
  
  bottom.appendChild(count);
  bottom.appendChild(label);
  
  card.appendChild(top);
  card.appendChild(bottom);
  
  wrapper.appendChild(card);
  wrapper.appendChild(chips);
  gridEl.appendChild(wrapper);
}

/**
 * Configura la imagen de fondo de una tarjeta
 */
function setupCardImage(card, gameTitle, optionData) {
  const opt = optionData || getOptionByTitle(gameTitle);
  const objPos = opt?.objectPosition || 'center center';
  
  resolveGameImage(gameTitle, opt).then(img => {
    if (img) {
      applyCardImage(card, img, objPos, gameTitle);
    } else {
      const key = gameTitle ? gameTitle.trim().toLowerCase() : '';
      const fallback = DEFAULT_LOCAL_IMAGES[key] || null;
      applyCardImage(card, fallback, objPos, gameTitle);
    }
  });
}

function applyCardImage(card, imageUrl, objPos = 'center center', gameTitle = '') {
  card.style.background = "none";
  card.style.overflow = "hidden";
  
  // Remove existing bg images
  const existing = card.querySelector('.card-bg-img');
  if (existing) existing.remove();
  
  if (!imageUrl) {
    card.style.background = "linear-gradient(135deg, #1f293d 0%, #111827 100%)";
    return;
  }

  const bgImg = document.createElement('img');
  bgImg.className = 'card-bg-img';
  bgImg.src = imageUrl;
  bgImg.alt = '';
  bgImg.decoding = 'async';
  bgImg.loading = 'lazy';
  bgImg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${objPos};z-index:0;pointer-events:none;`;
  
  bgImg.onerror = () => {
    console.warn(`[ImageLoad] Failed to load image: ${imageUrl}`);
    const key = gameTitle ? gameTitle.trim().toLowerCase() : '';
    const localFallback = DEFAULT_LOCAL_IMAGES[key];
    if (localFallback && !bgImg.src.endsWith(localFallback)) {
      bgImg.src = localFallback;
    } else {
      card.style.background = "linear-gradient(135deg, #1f293d 0%, #111827 100%)";
      bgImg.remove();
    }
  };

  card.prepend(bgImg);
}

/**
 * Crea la tarjeta carrusel (slot 3)
 */
function createCarouselCard() {
  const carouselGames = getCarouselData();
  if (carouselGames.length === 0) return;
  
  const wrapper = document.createElement("div");
  wrapper.className = "card-wrapper carousel-wrapper entering";
  wrapper.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:0;height:100%;position:relative;";
  wrapper.style.animationDelay = `${2 * 180}ms`;
  
  wrapper.addEventListener("animationend", (ev) => {
    if (ev.animationName === "slideInTech") {
      wrapper.classList.remove("entering");
      wrapper.style.animationDelay = "";
    }
  }, { once: true });
  
  const number = buildVoteCommandBadge(3);
  
  // Card
  const card = document.createElement("div");
  card.className = "card carousel-card";
  card.style.cssText = "flex:1;width:100%;";
  
  // Carousel content wrapper (for fade transitions)
  const contentWrap = document.createElement("div");
  contentWrap.className = "carousel-content";
  contentWrap.style.cssText = "display:contents;"; // flow children normally
  
  // Title row
  const top = document.createElement("div");
  top.className = "game-row carousel-content-fade";
  top.style.zIndex = "3";
  
  const title = document.createElement("div");
  title.className = "game-title";
  
  const titleText = document.createElement("span");
  titleText.style.cssText = "display:inline-block;white-space:nowrap;";
  titleText.textContent = "";
  title.appendChild(titleText);
  top.appendChild(number);
  top.appendChild(title);
  
  // Votes badge
  const bottom = document.createElement("div");
  bottom.className = "votes-badge carousel-content-fade";
  bottom.style.zIndex = '20';
  
  const count = document.createElement("div");
  count.className = "vote-count";
  count.textContent = "0";
  
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "0%";
  
  bottom.appendChild(count);
  bottom.appendChild(label);
  
  card.appendChild(top);
  card.appendChild(bottom);
  
  // Voter list
  const chips = document.createElement('div');
  chips.className = 'voter-inline carousel-content-fade';
  chips.style.cssText = 'z-index:5;left:0px;';
  
  wrapper.appendChild(card);
  wrapper.appendChild(chips);
  gridEl.appendChild(wrapper);
  
  // Store references for carousel updates
  carouselElements = {
    wrapper,
    card,
    numberBadge: number,
    titleElement: title,
    titleText,
    voteCount: count,
    labelEl: label,
    chipsContainer: chips,
  };
  
  // Set initial carousel display
  setCarouselContent(0, false);
}

/**
 * Updates the carousel card to show a specific carousel game
 */
function setCarouselContent(carouselIdx, animate = true) {
  if (!carouselElements) return;
  const carouselGames = getCarouselData();
  if (carouselIdx < 0 || carouselIdx >= carouselGames.length) return;
  
  const globalIndex = carouselIdx + FIXED_COUNT;
  const gameTitle = currentGames[globalIndex];
  const optionData = carouselGames[carouselIdx];
  
  if (!gameTitle) return;
  
  const doUpdate = () => {
    carouselDisplayIndex = carouselIdx;
    
    const cmdEl = carouselElements.numberBadge.querySelector(".option-number__cmd");
    if (cmdEl) cmdEl.textContent = `!${globalIndex + 1}`;
    carouselElements.numberBadge.setAttribute(
      "aria-label",
      `Opción ${globalIndex + 1}: escribe !${globalIndex + 1} en el chat de Twitch`
    );
    
    // Update title
    carouselElements.titleText.textContent = gameTitle;
    
    // Reset marquee
    carouselElements.titleText.style.animation = 'none';
    setTimeout(() => {
      const titleEl = carouselElements.titleElement;
      if (titleEl.scrollWidth > titleEl.clientWidth) {
        const dist = titleEl.scrollWidth - titleEl.clientWidth + 15;
        titleEl.style.setProperty('--scroll-dist', `-${dist}px`);
        carouselElements.titleText.style.animation = 'scroll-marquee 4s linear infinite alternate';
      }
    }, 50);
    
    // Update image
    const key = gameTitle ? gameTitle.trim().toLowerCase() : '';
    const cachedImg = imageCache.get(key);
    const objPos = optionData?.objectPosition || 'center center';
    if (cachedImg) {
      applyCardImage(carouselElements.card, cachedImg, objPos, gameTitle);
    } else {
      // Remove existing image
      const existing = carouselElements.card.querySelector('.card-bg-img');
      if (existing) existing.remove();
      carouselElements.card.style.background = '';
      
      resolveGameImage(gameTitle, optionData).then(img => {
        if (carouselDisplayIndex === carouselIdx) {
          applyCardImage(carouselElements.card, img, objPos, gameTitle);
        }
      });
    }
    
    // Refresh vote counts and voter lists for this card
    refreshUI();
  };
  
  if (animate) {
    const fadeEls = carouselElements.card.querySelectorAll(".carousel-content-fade");
    const chipsFade = carouselElements.chipsContainer;
    
    fadeEls.forEach(el => el.classList.add("c-fade-out"));
    chipsFade.classList.add("c-fade-out");
    
    setTimeout(() => {
      doUpdate();
      
      fadeEls.forEach(el => {
        el.classList.remove("c-fade-out");
        el.classList.add("c-fade-in");
      });
      chipsFade.classList.remove("c-fade-out");
      chipsFade.classList.add("c-fade-in");
      
      setTimeout(() => {
        fadeEls.forEach(el => el.classList.remove("c-fade-in"));
        chipsFade.classList.remove("c-fade-in");
      }, 300);
    }, 250);
  } else {
    doUpdate();
  }
}

function startCarousel() {
  stopCarousel();
  const carouselGames = getCarouselData();
  if (carouselGames.length <= 1) return;
  
  carouselTimerId = setInterval(() => {
    const next = (carouselDisplayIndex + 1) % carouselGames.length;
    setCarouselContent(next, true);
  }, config.carouselInterval);
}

function stopCarousel() {
  if (carouselTimerId) {
    clearInterval(carouselTimerId);
    carouselTimerId = null;
  }
}

/**
 * Renderiza las 3 tarjetas: 2 fijas + 1 carrusel
 */
function renderCards() {
  gridEl.innerHTML = "";
  carouselElements = null;
  stopCarousel();
  
  // Render search fixed games
  for (let i = 0; i < FIXED_COUNT; i++) {
    createFixedCard(i);
  }
}

/**
 * Updates vote counts and leader status on all visible cards
 */
function updateVoteBars() {
  const total = getTotalOptions();
  const sum = votesByIndex.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const totalForPercent = (!Number.isFinite(sum) || sum === 0) ? 1 : sum;
  
  const validVotes = votesByIndex.map(v => Number.isFinite(v) ? v : 0);
  
  // Map visible card index to global option index
  const visibleOptions = Array.from({ length: FIXED_COUNT }, (_, i) => i);
  
  const cards = gridEl.querySelectorAll(".card");
  
  // Find leader indices
  const maxVotes = Math.max(...validVotes);
  const leaderIndices = [];
  if (maxVotes > 0) {
    validVotes.forEach((v, idx) => {
      if (v === maxVotes) leaderIndices.push(idx);
    });
  }
  
  visibleOptions.forEach((optionIdx, cardIdx) => {
    const safeCount = validVotes[optionIdx] || 0;
    const percent = Math.round((safeCount / totalForPercent) * 100) || 0;
    const card = cards[cardIdx];
    if (!card) return;
    
    const counter = card.querySelector(".vote-count");
    const label = card.querySelector(".label");
    
    if (counter) counter.textContent = `${Math.round(Number(safeCount) * 10) / 10}`;
    if (label) label.textContent = `${percent}%`;
  });

  // Assign is-leader class to card wrappers
  const wrappers = gridEl.querySelectorAll(".card-wrapper");
  wrappers.forEach((wrapper, cardIdx) => {
    if (leaderIndices.includes(cardIdx)) {
      wrapper.classList.add("is-leader");
    } else {
      wrapper.classList.remove("is-leader");
    }
  });
}

function updateVoterLists() {
  const total = getTotalOptions();
  const cards = gridEl.querySelectorAll(".card");
  
  // Build voter lists for ALL options
  const votersByOption = [];
  for (let i = 0; i < total; i++) votersByOption.push([]);
  
  for (const [userKey, data] of userVotes.entries()) {
    const { choice, level, extraBonus, fixedPoints } = data;
    const displayName = userDisplayNames.get(userKey) || userKey;
    const weight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    
    if (choice >= 0 && choice < total) {
      votersByOption[choice].push({ 
        name: displayName, 
        level, 
        weight,
        hasBonus: extraBonus > 0 || fixedPoints !== undefined
      });
    }
  }
  
  // Sort each list by weight
  votersByOption.forEach(list => list.sort((a, b) => b.weight - a.weight));
  
  // Map visible card index to global option index
  const visibleOptions = Array.from({ length: FIXED_COUNT }, (_, i) => i);
  
  visibleOptions.forEach((optionIdx, cardIdx) => {
    const list = votersByOption[optionIdx] || [];
    const card = cards[cardIdx];
    if (!card) return;
    const wrapper = card.parentElement;
    
    const chipsWrap = wrapper.querySelector('.voter-inline');
    if (!chipsWrap) return;
    chipsWrap.innerHTML = '';
    
    list.forEach(voter => {
      const chip = document.createElement('span');
      chip.className = 'voter-chip';
      if (voter.hasBonus) chip.classList.add('has-bonus');
      
      const nameTag = document.createElement('span');
      nameTag.className = 'voter-name';
      nameTag.textContent = voter.name;
      
      const ptsTag = document.createElement('span');
      ptsTag.className = 'pts-tag';
      ptsTag.textContent = `+${Math.round(Number(voter.weight) * 10) / 10}`;
      
      chip.appendChild(nameTag);
      chip.appendChild(ptsTag);
      
      chipsWrap.appendChild(chip);
    });
  });
}

function refreshUI() {
  updateVoteBars();
  updateVoterLists();
  updateStatsPanel();
  checkForWinner();
}

// ============================================================================
// LÓGICA DE GANADOR
// ============================================================================

/**
 * Comprueba si alguna opción ha llegado al umbral y, si es así,
 * para las votaciones y marca el ganador visualmente.
 */
function checkForWinner() {
  if (!votingActive) return; // Ya hay un ganador, no re-checar

  const total = getTotalOptions();
  for (let i = 0; i < total; i++) {
    if ((votesByIndex[i] || 0) >= WINNER_THRESHOLD) {
      declareWinner(i);
      return;
    }
  }
}

function declareWinner(optionIndex) {
  votingActive = false;
  winnerOptionIndex = optionIndex;

  console.log(`[Winner] Option ${optionIndex + 1} reached ${WINNER_THRESHOLD} votes! Voting stopped.`);
  setStatus(`🏆 ¡GANADOR: Opción ${optionIndex + 1}! Votación detenida`);

  // Aplicar clase ganador a la tarjeta correspondiente
  const cards = gridEl.querySelectorAll('.card');
  cards.forEach((card, cardIdx) => {
    // Las tarjetas fijas tienen índice directo
    if (cardIdx < FIXED_COUNT) {
      if (cardIdx === optionIndex) {
        card.classList.add('card-winner');
      } else {
        card.classList.add('card-loser');
      }
    }
  });
}

function clearWinnerUI() {
  const cards = gridEl.querySelectorAll('.card');
  cards.forEach(card => {
    card.classList.remove('card-winner', 'card-loser');
  });
}

// ============================================================================
// RESETEO
// ============================================================================

function resetVotes(keepGames = true) {
  const total = getTotalOptions();
  
  if (!keepGames) {
    currentGames = buildGamesList();
  }
  
  votesByIndex = new Array(total).fill(0);
  userVotes.clear();
  carouselDisplayIndex = 0;
  votingActive = true;
  winnerOptionIndex = -1;
  
  renderCards();
  clearWinnerUI();
  refreshUI();
  saveState();
  setStatus("Encuesta reseteada");
}

/**
 * Reactiva las votaciones tras un ganador.
 * - Borra los votos de todos los usuarios que habían votado por la opción ganadora.
 * - Pone votesByIndex[winnerOptionIndex] = 0.
 * - Vuelve a activar votingActive.
 */
function iniciarVotacion() {
  if (winnerOptionIndex < 0) {
    // No hay ganador activo, simplemente reactivar
    votingActive = true;
    clearWinnerUI();
    setStatus('Votación iniciada');
    return;
  }

  const prevWinner = winnerOptionIndex;

  // Recopilar claves primero para evitar problemas al borrar durante iteración
  const keysToDelete = [];
  for (const [userKey, data] of userVotes.entries()) {
    if (data.choice === prevWinner) {
      keysToDelete.push(userKey);
    }
  }

  // Borrar y registrar en el set de purgados (para forzar extraBonus=0 al re-votar)
  clearedWinnerVoters.clear(); // Solo mantenemos los del ciclo actual
  for (const key of keysToDelete) {
    userVotes.delete(key);
    clearedWinnerVoters.add(key);
  }

  // Resetear contador de esa opción
  votesByIndex[prevWinner] = 0;

  winnerOptionIndex = -1;
  votingActive = true;

  clearWinnerUI();
  recalculateAllVotes();
  refreshUI();
  saveState();
  setStatus(`Votación iniciada — opción ${prevWinner + 1} reseteada`);
  console.log(`[iniciarVotacion] Voting restarted. Option ${prevWinner + 1} voters cleared: ${keysToDelete.join(', ')}`);
}

/**
 * Resetea los votos de una opción específica.
 */
function resetOptionVotes(index) {
  const total = getTotalOptions();
  if (index < 0 || index >= total) return;
  
  // Eliminar votos de usuarios que eligieron esta opción
  for (const [userKey, data] of userVotes.entries()) {
    if (data.choice === index) {
      userVotes.delete(userKey);
    }
  }
  
  recalculateAllVotes();
  refreshUI();
  saveState();
  setStatus(`Votos de la opción ${index + 1} reseteados`);
}

// ============================================================================
// CONEXIÓN A TWITCH IRC
// ============================================================================

function connectToTwitch() {
  let ws;
  try {
    ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  } catch (e) {
    setStatus("Error al conectar a Twitch.");
    return;
  }
  websocket = ws;
  
  ws.addEventListener("open", () => {
    const nick = `justinfan${Math.floor(Math.random() * 10_000_000)}`;
    sendRaw(`PASS SCHMOOPIIE`);
    sendRaw(`NICK ${nick}`);
    sendRaw(`CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership`);
    sendRaw(`JOIN #${config.channelName}`);
  });
  
  ws.addEventListener("message", (event) => {
    const lines = String(event.data).split("\r\n");
    for (const line of lines) {
      if (line) handleIrcLine(line);
    }
  });
  
  ws.addEventListener("close", () => {
    setStatus("Desconectado. Reintentando en 5s…");
    setTimeout(connectToTwitch, 5000);
  });
  
  ws.addEventListener("error", () => {
    setStatus("Error de conexión.");
  });
}

function sendRaw(message) {
  try { websocket && websocket.send(message); } catch {}
}

function handleIrcLine(line) {
  if (line.startsWith("PING")) {
    sendRaw("PONG :tmi.twitch.tv");
    return;
  }
  
  const match = line.match(/^(?:@([^ ]+) )?:(\w+)!.* PRIVMSG #[^ ]+ :(.+)$/);
  if (match) {
    const tagsStr = match[1] || '';
    const username = match[2].toLowerCase();
    const message = match[3].trim();
    
    let displayName = username;
    if (tagsStr) {
      const tags = Object.fromEntries(tagsStr.split(';').map(kv => {
        const [k, v = ''] = kv.split('=');
        return [k, v.replace(/\\s/g, ' ')];
      }));
      if (tags['display-name']) displayName = tags['display-name'];
    }
    
    const isRedemption = tagsStr.includes("msg-id=custom-reward-redemption") || 
                         tagsStr.includes("custom-reward-id=");
    
    handleChatMessage(username, message, displayName, isRedemption).catch(err => {
      console.error('[IRC] Unhandled error in handleChatMessage:', err);
    });
    return;
  }
}

// ============================================================================
// LÓGICA DE COMANDOS
// ============================================================================

/**
 * Extrae el índice de voto del mensaje (!1 a !10, o !vota X)
 * Retorna: índice 0-based o null
 */
function extractVote(message) {
  const lowered = message.toLowerCase().trim();
  const total = getTotalOptions();
  
  // Formato directo: !1, !2, ..., !10
  const direct = lowered.match(/^!(\d{1,2})(\b|$)/);
  if (direct) {
    const num = parseInt(direct[1], 10);
    if (num >= 1 && num <= total) {
      return num - 1;
    }
  }
  
  // Formato con alias: !vota 1, !votar 5, !vote 10
  const matchedAlias = config.commandAliases.find(
    alias => lowered.startsWith(alias + " ") || lowered === alias
  );
  if (!matchedAlias) return null;
  
  const rest = lowered.replace(matchedAlias, "").trim();
  const number = parseInt(rest, 10);
  if (!Number.isFinite(number) || number < 1 || number > total) return null;
  
  return number - 1;
}

/**
 * Extrae retirada (!not1 a !not10)
 */
function extractWithdrawal(message) {
  const total = getTotalOptions();
  const match = message.toLowerCase().trim().match(/^!not(\d{1,2})(\b|$)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= total) {
      return num - 1;
    }
  }
  return null;
}

/**
 * Extrae comando de admin: !<opción> <usuario> <puntos>
 * Ejemplo: !3 ractor09 4
 */
function extractAdminVote(message) {
  const total = getTotalOptions();
  const match = message.trim().match(/^!(\d{1,2})\s+(\S+)\s+\+?(\d+)$/i);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= total) {
      let targetUser = match[2].toLowerCase();
      if (targetUser.startsWith('@')) {
        targetUser = targetUser.substring(1);
      }
      return {
        optionIndex: num - 1,
        targetUser: targetUser,
        points: parseInt(match[3], 10)
      };
    }
  }
  return null;
}

/**
 * Extrae comando de admin para eliminar el voto de un usuario.
 * Ejemplos:
 *  - !quitarvoto usuario
 *  - !borrarvoto @usuario
 *  - !resetvoto usuario
 *  - !removevote usuario
 */
function extractAdminRemoveVote(message) {
  const match = message.trim().match(/^!(quitarvoto|borrarvoto|resetvoto|removevote)\s+(.+)$/i);
  if (!match) return null;
  let target = String(match[2] || '').trim();
  if (!target) return null;
  if (target.startsWith('@')) target = target.slice(1).trim();
  if (!target) return null;
  return { target };
}

/**
 * Extrae comando de admin para establecer puntos fijos a un usuario SIN mover su opción.
 * Ejemplos:
 *  - !setpuntos usuario 25
 *  - !puntos @usuario 25
 *  - !setpoints Votos Anónimos 30
 */
function extractAdminSetPoints(message) {
  const match = message.trim().match(/^!(setpuntos|puntos|setpoints)\s+(.+?)\s+(\d+)$/i);
  if (!match) return null;
  let target = String(match[2] || '').trim();
  if (!target) return null;
  if (target.startsWith('@')) target = target.slice(1).trim();
  const points = parseInt(match[3], 10);
  if (!target || !Number.isFinite(points)) return null;
  return { target, points };
}

// ============================================================================
// CONSULTA DE NIVEL
// ============================================================================

async function fetchUserLevel(username) {
  try {
    const userRef = doc(db, "users", username.toLowerCase());
    const userDoc = await getDoc(userRef);
    
    if (userDoc.exists()) {
      const data = userDoc.data();
      return typeof data.level === 'number' ? data.level : (parseInt(data.level, 10) || 0);
    }
    return 0;
  } catch (e) {
    console.error("[FetchLevel] Firestore Error:", e);
    const existing = userVotes.get(username.toLowerCase());
    return existing?.level || 0;
  }
}

// ============================================================================
// MANEJADOR PRINCIPAL DE MENSAJES
// ============================================================================

async function handleChatMessage(username, message, displayName, isExtraVote = false) {
  const userKey = username.toLowerCase();
  const total = getTotalOptions();
  
  // Blacklist check — Ignore votes and hidden from overlay
  // Check both username (login) and display name
  const lowerBlacklist = blacklist.map(u => u.toLowerCase());
  const lowerDisplayName = (displayName || "").toLowerCase();
  
  if (lowerBlacklist.includes(userKey) || (lowerDisplayName && lowerBlacklist.includes(lowerDisplayName))) {
    console.log(`[Blacklist] Blocking message from: ${userKey} (${displayName})`);
    return;
  }
  
  // Comando de reset (solo el streamer)
  const loweredMessage = message.toLowerCase().trim();
  if ((loweredMessage === "!reset" || loweredMessage === "!reset votacion" || loweredMessage === "!resetvotacion") 
      && userKey === config.channelName.toLowerCase()) {
    resetVotes(false);
    return;
  }

  // Comando !iniciar votacion (solo el streamer) — reactiva tras ganador
  if ((loweredMessage === "!iniciar votacion" || loweredMessage === "!iniciarvotacion" || loweredMessage === "!iniciar votación")
      && userKey === config.channelName.toLowerCase()) {
    iniciarVotacion();
    return;
  }

  // Restore snapshot (solo el streamer)
  if (loweredMessage === "!restaurar_captura" && userKey === config.channelName.toLowerCase()) {
    const snapshotVoters = {
      // Opción 1: 23
      "mithands": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 11 },
      "raulmilara79": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 3 },
      "トニーフォーリュ": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 3 },
      "srgrimx": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 2 },
      "moradorpep": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 1 },
      "ccxsnop": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 1 },
      "icarolinagi": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 1 },
      "sylarxd": { choice: 0, level: 0, extraBonus: 0, fixedPoints: 1 },
      
      // Opción 2: 92 (ractor09 20 + Inmaculadaconce 18 + Macusam 16 + MambiTV 7 + x1lenz 7 + James_193 7 + yisus_primero 3 = 78) + 14 faltantes = 92
      "ractor09": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 20 },
      "inmaculadaconce": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 18 },
      "macusam": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 16 },
      "mambitv": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 7 },
      "x1lenz": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 7 },
      "james_193": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 7 },
      "yisus_primero": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 3 },
      "votos_anonimos_op2": { choice: 1, level: 0, extraBonus: 0, fixedPoints: 14 },
      
      // Opción 3: 7
      "broxa24": { choice: 2, level: 0, extraBonus: 0, fixedPoints: 4 },
      "jookerlan": { choice: 2, level: 0, extraBonus: 0, fixedPoints: 2 },
      "oribor_tv": { choice: 2, level: 0, extraBonus: 0, fixedPoints: 1 },
      
      // Opción 4: 17
      "liiukiin": { choice: 3, level: 0, extraBonus: 0, fixedPoints: 8 },
      "reichskanz": { choice: 3, level: 0, extraBonus: 0, fixedPoints: 4 },
      "bitterbitz": { choice: 3, level: 0, extraBonus: 0, fixedPoints: 2 },
      "c_h_a_n_d_a_l_f": { choice: 3, level: 0, extraBonus: 0, fixedPoints: 2 },
      "azu_nai": { choice: 3, level: 0, extraBonus: 0, fixedPoints: 1 },
      
      // Opción 5: 5
      "xxchusmiflowxx": { choice: 4, level: 0, extraBonus: 0, fixedPoints: 3 },
      "aitorgp91": { choice: 4, level: 0, extraBonus: 0, fixedPoints: 1 },
      "muchachodelnorth": { choice: 4, level: 0, extraBonus: 0, fixedPoints: 1 },
      
      // Opción 6: 67 (diegori98_ 5 + MrKemm 3 + The_Panadero_Gamer 2 + oversilence 2 + xronix 1 + xporin 1 = 14) + 53 faltantes = 67
      "diegori98_": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 5 },
      "mrkemm": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 3 },
      "the_panadero_gamer": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 2 },
      "oversilence": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 2 },
      "xronix": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 1 },
      "xporin": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 1 },
      "votos_anonimos_op6": { choice: 5, level: 0, extraBonus: 0, fixedPoints: 53 }
    };
    
    const snapshotNames = {
      "mithands": "Mithands", "raulmilara79": "RaulMilara79", "トニーフォーリュ": "トニーフォーリュ",
      "srgrimx": "SrGrimx", "moradorpep": "moradorpep", "ccxsnop": "ccxsnop",
      "icarolinagi": "ICarolinaGI", "sylarxd": "sylarxd", "ractor09": "ractor09",
      "inmaculadaconce": "Inmaculadaconce", "macusam": "Macusam",
      "mambitv": "MambiTV", "x1lenz": "x1lenz", "james_193": "James_193",
      "yisus_primero": "yisus_primero", "votos_anonimos_op2": "Votos Anónimos",
      "broxa24": "BrOxA24", "jookerlan": "jookerlan", "oribor_tv": "oribor_tv", 
      "liiukiin": "Liiukiin", "reichskanz": "ReichSkanZ", "bitterbitz": "BitterBitZ", 
      "c_h_a_n_d_a_l_f": "c_h_a_n_d_a_l_f", "azu_nai": "azu_nai",
      "xxchusmiflowxx": "XxChusmiFlowxX", "aitorgp91": "aitorgp91", "muchachodelnorth": "muchachodelnorth",
      "diegori98_": "diegori98_", "mrkemm": "MrKemm", "the_panadero_gamer": "The_Panadero_Gamer", 
      "oversilence": "oversilence", "xronix": "xronix", "xporin": "xporin",
      "votos_anonimos_op6": "Votos Anónimos"
    };

    userVotes.clear();
    userDisplayNames.clear();
    
    for (const [k, v] of Object.entries(snapshotVoters)) {
      userVotes.set(k, v);
      userDisplayNames.set(k, snapshotNames[k]);
    }

    recalculateAllVotes();
    refreshUI();
    saveState();
    return;
  }

  // Reset de opción específica (solo el streamer)
  const resetOptionMatch = loweredMessage.match(/^!(\d{1,2})\s+reset$/);
  if (resetOptionMatch && userKey === config.channelName.toLowerCase()) {
    const optIdx = parseInt(resetOptionMatch[1], 10) - 1;
    resetOptionVotes(optIdx);
    return;
  }
  
  // ADMIN: Asignar voto manualmente
  if (userKey === config.channelName.toLowerCase()) {
    // ADMIN: Establecer puntos fijos sin mover opción
    const setPointsCmd = extractAdminSetPoints(message);
    if (setPointsCmd) {
      const targetRaw = setPointsCmd.target;
      const targetLower = targetRaw.toLowerCase();
      const newPoints = Math.min(setPointsCmd.points, MAX_USER_WEIGHT);

      const targetsToUpdate = new Set();

      // 1) Direct key by login
      if (userVotes.has(targetLower)) {
        targetsToUpdate.add(targetLower);
      }

      // 2) By exact display-name
      for (const [k, v] of userDisplayNames.entries()) {
        if (typeof v === 'string' && v.toLowerCase() === targetLower) {
          targetsToUpdate.add(k.toLowerCase());
        }
      }

      // Fallback: key match ignoring casing
      if (targetsToUpdate.size === 0) {
        for (const k of userVotes.keys()) {
          if (String(k).toLowerCase() === targetLower) {
            targetsToUpdate.add(String(k).toLowerCase());
          }
        }
      }

      let updated = 0;
      for (const targetUserKey of targetsToUpdate) {
        const existingData = userVotes.get(targetUserKey);
        if (!existingData) continue;

        const oldWeight = existingData.fixedPoints ?? calculateTotalWeight(existingData.level, existingData.extraBonus || 0);

        userVotes.set(targetUserKey, {
          ...existingData,
          fixedPoints: newPoints,
        });
        updated++;

        if (existingData.choice >= 0 && existingData.choice < total) {
          recordVoteIncrease(existingData.choice, newPoints - oldWeight);
        }
      }

      recalculateAllVotes();
      refreshUI();
      saveState();

      if (updated === 0) {
        setStatus(`No encontré votos para: ${targetRaw}`);
        console.log(`[Admin] ${userKey} tried to set points for "${targetRaw}", but none found.`);
      } else if (updated === 1) {
        setStatus(`Puntos actualizados: ${targetRaw} -> ${newPoints}`);
        console.log(`[Admin] ${userKey} set fixed points for "${targetRaw}" to ${newPoints}.`);
      } else {
        setStatus(`Puntos actualizados (${updated}): ${targetRaw} -> ${newPoints}`);
        console.log(`[Admin] ${userKey} set fixed points for ${updated} voters named "${targetRaw}" to ${newPoints}.`);
      }
      return;
    }

    // ADMIN: Eliminar voto de un usuario
    const removeCmd = extractAdminRemoveVote(message);
    if (removeCmd) {
      const targetRaw = removeCmd.target;
      const targetLower = targetRaw.toLowerCase();

      // Collect targets by:
      // 1) direct userKey (login)
      // 2) exact display-name match (can include spaces)
      const targetsToDelete = new Set();

      if (userVotes.has(targetLower)) {
        targetsToDelete.add(targetLower);
      }

      for (const [k, v] of userDisplayNames.entries()) {
        if (typeof v === 'string' && v.toLowerCase() === targetLower) {
          targetsToDelete.add(k.toLowerCase());
        }
      }

      // Fallback: if userDisplayNames didn't have it but userVotes key exists with different casing
      if (targetsToDelete.size === 0) {
        for (const k of userVotes.keys()) {
          if (String(k).toLowerCase() === targetLower) {
            targetsToDelete.add(String(k).toLowerCase());
          }
        }
      }

      // Apply deletions
      for (const targetUserKey of targetsToDelete) {
        const existingData = userVotes.get(targetUserKey);
        if (existingData && existingData.choice >= 0 && existingData.choice < total) {
          const weight = existingData.fixedPoints ?? calculateTotalWeight(existingData.level, existingData.extraBonus || 0);
          votesByIndex[existingData.choice] = Math.max(0, votesByIndex[existingData.choice] - weight);
        }
        userVotes.delete(targetUserKey);
      }

      recalculateAllVotes();
      refreshUI();
      saveState();
      const removedCount = targetsToDelete.size;
      if (removedCount === 0) {
        setStatus(`No encontré votos para: ${targetRaw}`);
        console.log(`[Admin] ${userKey} tried to remove vote for "${targetRaw}", but none found.`);
      } else if (removedCount === 1) {
        setStatus(`Voto eliminado: ${targetRaw}`);
        console.log(`[Admin] ${userKey} removed vote for "${targetRaw}".`);
      } else {
        setStatus(`Votos eliminados (${removedCount}): ${targetRaw}`);
        console.log(`[Admin] ${userKey} removed ${removedCount} votes for "${targetRaw}".`);
      }
      return;
    }

    const adminCmd = extractAdminVote(message);
    if (adminCmd) {
      const { optionIndex, targetUser, points } = adminCmd;
      const clampedPoints = Math.min(points, MAX_USER_WEIGHT);
      
      const existingData = userVotes.get(targetUser);
      let oldWeight = 0;
      if (existingData && existingData.choice >= 0 && existingData.choice < total) {
        oldWeight = existingData.fixedPoints ?? calculateTotalWeight(existingData.level, existingData.extraBonus || 0);
        votesByIndex[existingData.choice] = Math.max(0, votesByIndex[existingData.choice] - oldWeight);
      }
      
      const level = await fetchUserLevel(targetUser);
      
      const newData = {
        choice: optionIndex,
        level: level,
        extraBonus: 0,
        fixedPoints: clampedPoints
      };
      
      userVotes.set(targetUser, newData);
      userDisplayNames.set(targetUser, targetUser);
      votesByIndex[optionIndex] += clampedPoints;
      
      if (existingData && existingData.choice === optionIndex) {
        recordVoteIncrease(optionIndex, clampedPoints - oldWeight);
      } else {
        recordVoteIncrease(optionIndex, clampedPoints);
      }

      console.log(`[Admin] ${userKey} assigned ${targetUser} to option ${optionIndex + 1} with ${clampedPoints} fixed points${points !== clampedPoints ? ` (capped from ${points})` : ''}.`);
      
      refreshUI();
      saveState();
      return;
    }
  }
  
  // Si las votaciones están detenidas (hay un ganador), ignorar votos normales
  if (!votingActive) {
    console.log(`[Vote] Voting is stopped (winner declared). Ignoring vote from ${userKey}.`);
    return;
  }

  const voteIndex = extractVote(message);
  
  // ── LOCK: Prevent concurrent processing for the same user ──
  if (processingLock.has(userKey)) {
    console.log(`[Lock] User ${userKey} is already being processed. Queuing vote.`);
    // Wait for the lock to release, then re-check
    let attempts = 0;
    while (processingLock.has(userKey) && attempts < 20) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    if (processingLock.has(userKey)) {
      console.warn(`[Lock] Timeout waiting for lock on ${userKey}. Skipping.`);
      return;
    }
  }
  processingLock.add(userKey);
  
  try {
  
  // Guardar/Actualizar el display name
  userDisplayNames.set(userKey, displayName);
  
  // Always read LIVE state (not a stale snapshot from before awaits)
  let userData = userVotes.get(userKey) || null;
  
  // CASO 1: Redención de voto extra
  if (isExtraVote) {
    if (!userData) {
      userData = {
        choice: -1,
        level: await fetchUserLevel(userKey),
        extraBonus: 1
      };
      userVotes.set(userKey, userData);
      saveState();
      console.log(`[ExtraVote] User ${userKey} redeemed bonus (+1). No vote yet.`);
      
      if (voteIndex !== null) {
        await processVote(userKey, voteIndex, userData);
      }
      return;
    }
    
    const oldWeight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus || 0);
    
    if (userData.fixedPoints !== undefined) {
      // Cap fixedPoints al incrementar
      userData.fixedPoints = Math.min(userData.fixedPoints + 1, MAX_USER_WEIGHT);
    } else {
      userData.extraBonus = (userData.extraBonus || 0) + 1;
      // El cap final lo aplica calculateTotalWeight internamente
    }
    
    // NEW FIX: If redemption includes a vote (e.g. "!2"), allow changing choice
    if (voteIndex !== null && voteIndex !== userData.choice) {
      // Subtract OLD weight from OLD choice
      if (userData.choice >= 0 && userData.choice < total) {
        votesByIndex[userData.choice] = Math.max(0, votesByIndex[userData.choice] - oldWeight);
      }
      
      // Update choice
      userData.choice = voteIndex;
      
      // Recalculate level if needed before adding to NEW choice
      userData.level = await fetchUserLevel(userKey);
      const updatedWeight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus);
      
      votesByIndex[userData.choice] += updatedWeight;
      recordVoteIncrease(voteIndex, updatedWeight);
      console.log(`[ExtraVote] User ${userKey} redeemed bonus and switched to option ${voteIndex + 1}. Weight: ${updatedWeight}`);
    } else {
      // Just update current choice weight
      const newWeight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus);
      if (userData.choice >= 0 && userData.choice < total) {
        votesByIndex[userData.choice] = votesByIndex[userData.choice] - oldWeight + newWeight;
        recordVoteIncrease(userData.choice, newWeight - oldWeight);
      }
      console.log(`[ExtraVote] User ${userKey} redeemed bonus on current option ${userData.choice + 1}. New weight: ${newWeight}`);
    }
    
    userVotes.set(userKey, userData);
    refreshUI();
    saveState();
    return;

  }
  
  // CASO 1.5: Comandos de Voto Extra (!extra, !bonus)
  const isExtraCommand = loweredMessage === "!extra" || loweredMessage === "!bonus";
  if (isExtraCommand) {
    if (!userData || userData.choice === -1) {
      console.log(`[Extra] User ${userKey} tried !extra but has no active vote.`);
      return;
    }

    const today = getSpanishDate();
    if (userData.lastExtraDate === today) {
      console.log(`[Extra] User ${userKey} already used their daily extra.`);
      return;
    }

    // Verificar si el canal está en directo
    const isLive = await isChannelLive();
    if (!isLive) {
      console.log(`[Extra] Denied: Channel is offline.`);
      return;
    }

    // Refrescar nivel desde Firestore para usar siempre el nivel actual
    const freshLevel = await fetchUserLevel(userKey);
    if (freshLevel > 0) userData.level = freshLevel;

    // Calcular valor: 1% del nivel (mínimo 0.2), redondeado a 1 decimal
    const bonusValue = Math.round(Math.max(0.2, userData.level * 0.01) * 10) / 10;
    
    // Actualizar datos: sumar bonus y registrar fecha
    userData.extraBonus = Math.round(((userData.extraBonus || 0) + bonusValue) * 10) / 10;
    userData.lastExtraDate = today;

    // IMPORTANTE: guardar ANTES de recalcular para que el recálculo use datos actualizados
    userVotes.set(userKey, userData);

    if (userData.choice >= 0 && userData.choice < total) {
      recordVoteIncrease(userData.choice, bonusValue);
    }

    recalculateAllVotes();
    
    console.log(`[Extra] User ${userKey} added +${bonusValue.toFixed(1)} pts. Total bonus: ${userData.extraBonus.toFixed(1)}`);
    
    refreshUI();
    saveState();
    return;
  }
  
  // CASO 2: Retirada de voto (!notX)
  const withdrawIndex = extractWithdrawal(message);
  if (withdrawIndex !== null) {
    if (userData && userData.choice === withdrawIndex) {
      const weight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus || 0);
      votesByIndex[withdrawIndex] = Math.max(0, votesByIndex[withdrawIndex] - weight);
      userVotes.delete(userKey);
      
      console.log(`[Withdraw] User ${userKey} withdrew vote from option ${withdrawIndex + 1}`);
      
      refreshUI();
      saveState();
    }
    return;
  }
  
  // CASO 3: Voto normal (!1 a !10)
  if (voteIndex !== null) {
    // Re-read LIVE state after any awaits above (extra vote path has awaits)
    userData = userVotes.get(userKey) || null;
    
    // If already voted for THE SAME option, ignore
    if (userData && userData.choice === voteIndex) {
      console.log(`[Vote] User ${userKey} already voted for option ${voteIndex + 1}. Ignoring.`);
      return;
    }
    
    // Allow vote change: pass existing data so processVote can subtract old points
    await processVote(userKey, voteIndex, userData);
  }
  
  } finally {
    processingLock.delete(userKey);
  }
}

/**
 * Procesa un voto para un usuario.
 */
async function processVote(userKey, voteIndex, existingData) {
  try {
    const total = getTotalOptions();
    const level = await fetchUserLevel(userKey);
    
    // ── Re-check LIVE state after the await ──
    // Use the freshest data (might have been updated during the await)
    const liveData = userVotes.get(userKey);
    
    // If during the await the user already got moved to this exact option, skip
    if (liveData && liveData.choice === voteIndex) {
      console.log(`[Vote] User ${userKey} already on option ${voteIndex + 1} (live check). Skipping.`);
      return;
    }
    
    // Use liveData if available (it's fresher than existingData)
    const currentData = liveData || existingData;
    
    // Determinar si el usuario está CAMBIANDO de opción (ya tenía un voto válido en otra opción)
    const isSwitching = currentData && currentData.choice >= 0 && currentData.choice < total && currentData.choice !== voteIndex;
    
    let extraBonus = 0;
    let fixedPoints = undefined;
    if (currentData) {
      // Si el usuario fue purgado por ser votante del ganador anterior,
      // arranca sin extraBonus ni fixedPoints aunque haya datos residuales.
      if (clearedWinnerVoters.has(userKey)) {
        console.log(`[Vote] ${userKey} was a cleared winner voter — resetting extraBonus to 0.`);
        clearedWinnerVoters.delete(userKey); // solo aplicar una vez
      } else if (isSwitching) {
        // PENALIZACIÓN: Al cambiar de opción pierde extraBonus y fixedPoints.
        // Solo conserva los puntos base por su nivel.
        console.log(`[Vote] ${userKey} is switching options — losing extraBonus (${currentData.extraBonus || 0}) and fixedPoints (${currentData.fixedPoints ?? 'N/A'}). Only base weight remains.`);
        extraBonus = 0;
        fixedPoints = undefined;
      } else {
        extraBonus = currentData.extraBonus || 0;
        if (currentData.fixedPoints !== undefined) {
          fixedPoints = currentData.fixedPoints;
        }
      }
    }
    
    const newWeight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    
    // Subtract old vote if switching
    if (isSwitching) {
      const oldWeight = currentData.fixedPoints ?? calculateTotalWeight(currentData.level, currentData.extraBonus || 0);
      votesByIndex[currentData.choice] = Math.max(0, votesByIndex[currentData.choice] - oldWeight);
      
      console.log(`[Vote] User ${userKey} switching from option ${currentData.choice + 1} (-${oldWeight}) to option ${voteIndex + 1} (+${newWeight})`);
      recordVoteIncrease(voteIndex, newWeight);
    } else {
      const hasVotedBefore = currentData && currentData.choice >= 0 && currentData.choice < total;
      if (!hasVotedBefore) {
        recordVoteIncrease(voteIndex, newWeight);
      }
    }
    
    const newData = {
      choice: voteIndex,
      level: level,
      extraBonus: extraBonus
    };
    
    // Preserve fixedPoints only if NOT switching (switching resets them)
    if (fixedPoints !== undefined) {
      newData.fixedPoints = fixedPoints;
    }
    
    userVotes.set(userKey, newData);
    votesByIndex[voteIndex] += newWeight;
    
    console.log(`[Vote] User ${userKey} voted for option ${voteIndex + 1}. Level: ${level}, Base: ${calculateBaseWeight(level)}, Bonus: +${extraBonus}, Total: ${newWeight}`);
    
    // Visual pulse animation — map to visible card
    const cards = gridEl.querySelectorAll(".card");
    let cardToAnimate = null;
    
    if (voteIndex < FIXED_COUNT) {
      cardToAnimate = cards[voteIndex];
    } else if (voteIndex === FIXED_COUNT + carouselDisplayIndex) {
      cardToAnimate = cards[2]; // carousel card
    }
    
    if (cardToAnimate) {
      cardToAnimate.classList.remove("pulse-voted");
      void cardToAnimate.offsetWidth;
      cardToAnimate.classList.add("pulse-voted");
      setTimeout(() => cardToAnimate.classList.remove("pulse-voted"), 400);
    }
    
    refreshUI();
    saveState();
  } catch (err) {
    console.error(`[Vote] Error processing vote for ${userKey}:`, err);
    // Attempt to recover by recalculating from stored data
    recalculateAllVotes();
    refreshUI();
  }
}

// ============================================================================
// UTILIDADES UI
// ============================================================================

function showOverlay() {
  overlayEl.style.display = "flex";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setHint(text) {
  hintEl.textContent = text;
}

/**
 * Construye la lista de todos los juegos (fijos + carrusel)
 */
function buildGamesList() {
  const fixed = getFixedData();
  const carousel = getCarouselData();
  const total = FIXED_COUNT + carousel.length;
  
  const games = [];
  
  // Fixed games
  for (let i = 0; i < FIXED_COUNT; i++) {
    games.push(fixed[i]?.title || `Juego ${i + 1}`);
  }
  
  // Carousel games
  for (let i = 0; i < carousel.length; i++) {
    games.push(carousel[i]?.title || `Juego ${i + 3}`);
  }
  
  return games;
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

function init() {
  showOverlay();
  
  // Reset button disabled — only via !reset votacion in chat
  // if (resetBtnEl) {
  //   resetBtnEl.addEventListener("click", () => resetVotes(false));
  // }
  
  const total = getTotalOptions();
  setHint(`Vota con !1-!${total} en el chat`);
  
  // Cargar estado persistido
  loadState();
  
  // Construir lista de juegos desde data.js
  currentGames = buildGamesList();
  
  // Inicializar votesByIndex si no coincide
  if (!Array.isArray(votesByIndex) || votesByIndex.length !== total) {
    votesByIndex = new Array(total).fill(0);
    recalculateAllVotes();
  }
  
  renderCards();
  refreshUI();
  saveState();
  
  // Conectar a Twitch
  if (!config.channelName || /[^a-zA-Z0-9_]/.test(config.channelName)) {
    setStatus("Configura 'channelName' correctamente en el archivo.");
    return;
  }
  connectToTwitch();
  
  // Keyboard reset disabled — only via !reset votacion in chat
}

document.addEventListener("DOMContentLoaded", init);
