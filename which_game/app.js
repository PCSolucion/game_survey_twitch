import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseConfig } from "./api.js";

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
const FIXED_COUNT = 2; // Slots fijos (!1, !2)

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

// Mapas de estado de usuarios
const userVotes = new Map();       // userKey -> { choice: number, level: number, extraBonus: number }
const userDisplayNames = new Map(); // userKey -> displayName
const processingLock = new Set();   // Prevents concurrent processing for the same user

// ============================================================================
// ELEMENTOS DEL DOM
// ============================================================================
const overlayEl = document.getElementById("overlay");
const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const resetBtnEl = document.getElementById("resetBtn");

// ============================================================================
// UTILIDADES
// ============================================================================

function calculateBaseWeight(level) {
  if (typeof level !== 'number' || level < 10) return 1;
  return Math.floor(level / 10);
}

function calculateTotalWeight(level, extraBonus) {
  return calculateBaseWeight(level) + (extraBonus || 0);
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

/**
 * Busca una imagen de juego en RAWG por título
 */
async function fetchGameImage(title) {
  if (!firebaseConfig.rawgKey) return null;
  try {
    const response = await fetch(`https://api.rawg.io/api/games?key=${firebaseConfig.rawgKey}&search=${encodeURIComponent(title)}&page_size=1`);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results[0].background_image;
    }
  } catch (e) {
    console.error('[RAWG] Error searching image:', e);
  }
  return null;
}

// Image cache for carousel games
const imageCache = new Map();

async function resolveGameImage(title, optionData) {
  // Check cache first
  if (imageCache.has(title)) return imageCache.get(title);
  
  let imageUrl = null;
  if (optionData && optionData.image && optionData.image !== "auto") {
    imageUrl = optionData.image;
  } else {
    imageUrl = await fetchGameImage(title);
  }
  
  if (imageUrl) imageCache.set(title, imageUrl);
  return imageUrl;
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
      
      for (const [key, data] of Object.entries(obj)) {
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
  
  // Number badge
  const number = document.createElement("div");
  number.className = "option-number big-number";
  number.textContent = `!${index + 1}`;
  number.style.cssText = "margin-top:-25px;margin-bottom:8px;z-index:10;";
  
  // Card
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "flex:1;width:100%;";
  
  // Image
  setupCardImage(card, gameTitle, optionData);
  
  // Title row
  const top = document.createElement("div");
  top.className = "game-row";
  top.style.zIndex = '1';
  
  const title = document.createElement("div");
  title.className = "game-title";
  
  const titleText = document.createElement("span");
  titleText.style.cssText = "display:inline-block;white-space:nowrap;";
  titleText.textContent = gameTitle;
  title.appendChild(titleText);
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
  
  wrapper.appendChild(number);
  wrapper.appendChild(card);
  wrapper.appendChild(chips);
  gridEl.appendChild(wrapper);
}

/**
 * Configura la imagen de fondo de una tarjeta
 */
function setupCardImage(card, gameTitle, optionData) {
  let imageUrl = optionData?.image || null;
  const objPos = 'center center';
  
  if (!imageUrl || imageUrl === "auto") {
    fetchGameImage(gameTitle).then(img => {
      if (img) {
        imageCache.set(gameTitle, img);
        applyCardImage(card, img, objPos);
      }
    });
  } else {
    imageCache.set(gameTitle, imageUrl);
    applyCardImage(card, imageUrl, objPos);
  }
}

function applyCardImage(card, imageUrl, objPos = 'center center') {
  card.style.background = "none";
  card.style.overflow = "hidden";
  
  // Remove existing bg images
  const existing = card.querySelector('.card-bg-img');
  if (existing) existing.remove();
  
  const bgImg = document.createElement('img');
  bgImg.className = 'card-bg-img';
  bgImg.src = imageUrl;
  bgImg.alt = '';
  bgImg.decoding = 'async';
  bgImg.loading = 'lazy';
  bgImg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${objPos};z-index:0;pointer-events:none;`;
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
  
  // Number badge (will update: !3, !4, ..., !10)
  const number = document.createElement("div");
  number.className = "option-number big-number";
  number.textContent = `!3`;
  number.style.cssText = "margin-top:-25px;margin-bottom:8px;z-index:10;";
  
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
  top.style.zIndex = '1';
  
  const title = document.createElement("div");
  title.className = "game-title";
  
  const titleText = document.createElement("span");
  titleText.style.cssText = "display:inline-block;white-space:nowrap;";
  titleText.textContent = "";
  title.appendChild(titleText);
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
  
  wrapper.appendChild(number);
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
    
    // Update number badge
    carouselElements.numberBadge.textContent = `!${globalIndex + 1}`;
    
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
    const cachedImg = imageCache.get(gameTitle);
    if (cachedImg) {
      applyCardImage(carouselElements.card, cachedImg, 'center center');
    } else {
      // Remove existing image
      const existing = carouselElements.card.querySelector('.card-bg-img');
      if (existing) existing.remove();
      carouselElements.card.style.background = '';
      
      // Try to fetch
      resolveGameImage(gameTitle, optionData).then(img => {
        if (img && carouselDisplayIndex === carouselIdx) {
          applyCardImage(carouselElements.card, img, 'center center');
        }
      });
    }
    
    // Refresh vote counts and voter lists for this card
    refreshUI();
  };
  
  if (animate) {
    // Fade out
    const fadeEls = carouselElements.card.querySelectorAll('.carousel-content-fade');
    const chipsFade = carouselElements.chipsContainer;
    const badgeFade = carouselElements.numberBadge;
    
    fadeEls.forEach(el => el.classList.add('c-fade-out'));
    chipsFade.classList.add('c-fade-out');
    badgeFade.classList.add('c-fade-out');
    
    setTimeout(() => {
      doUpdate();
      
      fadeEls.forEach(el => {
        el.classList.remove('c-fade-out');
        el.classList.add('c-fade-in');
      });
      chipsFade.classList.remove('c-fade-out');
      chipsFade.classList.add('c-fade-in');
      badgeFade.classList.remove('c-fade-out');
      badgeFade.classList.add('c-fade-in');
      
      setTimeout(() => {
        fadeEls.forEach(el => el.classList.remove('c-fade-in'));
        chipsFade.classList.remove('c-fade-in');
        badgeFade.classList.remove('c-fade-in');
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
  
  // Card 0 and 1: fixed games
  for (let i = 0; i < FIXED_COUNT; i++) {
    createFixedCard(i);
  }
  
  // Card 2: carousel
  createCarouselCard();
  
  // Pre-fetch all carousel images
  const carouselGames = getCarouselData();
  carouselGames.forEach((game, i) => {
    const globalIdx = i + FIXED_COUNT;
    const title = currentGames[globalIdx];
    if (title) {
      resolveGameImage(title, game);
    }
  });
  
  // Start carousel rotation
  startCarousel();
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
  const visibleOptions = [0, 1, FIXED_COUNT + carouselDisplayIndex];
  
  const cards = gridEl.querySelectorAll(".card");
  
  visibleOptions.forEach((optionIdx, cardIdx) => {
    const safeCount = validVotes[optionIdx] || 0;
    const percent = Math.round((safeCount / totalForPercent) * 100) || 0;
    const card = cards[cardIdx];
    if (!card) return;
    
    const counter = card.querySelector(".vote-count");
    const label = card.querySelector(".label");
    
    if (counter) counter.textContent = `${safeCount}`;
    if (label) label.textContent = `${percent}%`;
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
  const visibleOptions = [0, 1, FIXED_COUNT + carouselDisplayIndex];
  
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
      ptsTag.textContent = `+${voter.weight}`;
      
      chip.appendChild(nameTag);
      chip.appendChild(ptsTag);
      
      chipsWrap.appendChild(chip);
    });
  });
}

function refreshUI() {
  updateVoteBars();
  updateVoterLists();
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
  
  renderCards();
  refreshUI();
  saveState();
  setStatus("Encuesta reseteada");
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
      return {
        optionIndex: num - 1,
        targetUser: match[2].toLowerCase(),
        points: parseInt(match[3], 10)
      };
    }
  }
  return null;
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
  
  if (displayName) {
    userDisplayNames.set(userKey, displayName);
  }
  
  // Comando de reset (solo el streamer)
  const loweredMessage = message.toLowerCase().trim();
  if ((loweredMessage === "!reset" || loweredMessage === "!reset votacion" || loweredMessage === "!resetvotacion") 
      && userKey === config.channelName.toLowerCase()) {
    resetVotes(false);
    return;
  }
  
  // ADMIN: Asignar voto manualmente
  if (userKey === config.channelName.toLowerCase()) {
    const adminCmd = extractAdminVote(message);
    if (adminCmd) {
      const { optionIndex, targetUser, points } = adminCmd;
      
      const existingData = userVotes.get(targetUser);
      if (existingData && existingData.choice >= 0 && existingData.choice < total) {
        const oldWeight = existingData.fixedPoints ?? calculateTotalWeight(existingData.level, existingData.extraBonus || 0);
        votesByIndex[existingData.choice] = Math.max(0, votesByIndex[existingData.choice] - oldWeight);
      }
      
      const level = await fetchUserLevel(targetUser);
      
      const newData = {
        choice: optionIndex,
        level: level,
        extraBonus: 0,
        fixedPoints: points
      };
      
      userVotes.set(targetUser, newData);
      userDisplayNames.set(targetUser, targetUser);
      votesByIndex[optionIndex] += points;
      
      console.log(`[Admin] ${userKey} assigned ${targetUser} to option ${optionIndex + 1} with ${points} fixed points.`);
      
      refreshUI();
      saveState();
      return;
    }
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
      userData.fixedPoints += 1;
    } else {
      userData.extraBonus = (userData.extraBonus || 0) + 1;
    }
    
    const newWeight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus);
    
    console.log(`[ExtraVote] User ${userKey} redeemed bonus. New weight: ${newWeight}`);
    
    if (userData.choice >= 0 && userData.choice < total) {
      votesByIndex[userData.choice] = votesByIndex[userData.choice] - oldWeight + newWeight;
    }
    
    userVotes.set(userKey, userData);
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
    
    let extraBonus = 0;
    let fixedPoints = undefined;
    if (currentData) {
      extraBonus = currentData.extraBonus || 0;
      if (currentData.fixedPoints !== undefined) {
        fixedPoints = currentData.fixedPoints;
      }
    }
    
    const newWeight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    
    // Subtract old vote if switching
    if (currentData && currentData.choice >= 0 && currentData.choice < total) {
      const oldWeight = currentData.fixedPoints ?? calculateTotalWeight(currentData.level, currentData.extraBonus || 0);
      votesByIndex[currentData.choice] = Math.max(0, votesByIndex[currentData.choice] - oldWeight);
      
      console.log(`[Vote] User ${userKey} switching from option ${currentData.choice + 1} (-${oldWeight}) to option ${voteIndex + 1} (+${newWeight})`);
    }
    
    const newData = {
      choice: voteIndex,
      level: level,
      extraBonus: extraBonus
    };
    
    // Preserve fixedPoints if admin-assigned
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
