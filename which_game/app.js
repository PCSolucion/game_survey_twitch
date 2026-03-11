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
  selectionMode: "fixed",
  fixedGames: ["Juego A", "Juego B", "Juego C", "Juego D"],
  commandAliases: ["!vota", "!votar", "!vote"],
  oneVotePerUser: true,
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
let currentGames = [];
let votesByIndex = [0, 0, 0]; // Total de puntos por opción

// Mapas de estado de usuarios
const userVotes = new Map();       // userKey -> { choice: number, level: number, extraBonus: number }
const userDisplayNames = new Map(); // userKey -> displayName

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

/**
 * Calcula el peso base del voto según el nivel del usuario.
 * - Nivel < 10: 1 punto
 * - Nivel 70: 7 puntos
 * - Regla: Math.floor(level / 10)
 */
function calculateBaseWeight(level) {
  if (typeof level !== 'number' || level < 10) return 1;
  return Math.floor(level / 10);
}

/**
 * Calcula el peso TOTAL del voto de un usuario.
 * Peso Total = Base (por nivel) + Extra Bonus (por recompensa de canal)
 */
function calculateTotalWeight(level, extraBonus) {
  return calculateBaseWeight(level) + (extraBonus || 0);
}

/**
 * Recalcula votesByIndex desde cero basándose en userVotes.
 * Esta función SIEMPRE produce el resultado correcto.
 */
function recalculateAllVotes() {
  votesByIndex = [0, 0, 0];
  
  for (const [userKey, data] of userVotes.entries()) {
    const { choice, level, extraBonus, fixedPoints } = data;
    // Usar fixedPoints si existe (voto de admin), sino calcular
    const weight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    
    if (choice >= 0 && choice < 3) {
      votesByIndex[choice] += weight;
    }
  }
  
  console.log('[Recalculate] Votes recalculated:', votesByIndex);
}

function pickRandomUnique(array, count) {
  const pool = [...array];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function chooseGames() {
  try {
    const data = Array.isArray(window.OPTIONS_DATA) ? window.OPTIONS_DATA : [];
    const valid = data.length === 3 && data.every(it => it && typeof it.title === 'string' && it.title.trim().length > 0);
    if (valid) {
      return data.map(it => it.title);
    }
  } catch {}
  
  if (config.selectionMode === "fixed") {
    return config.fixedGames.slice(0, 3);
  }
  if (Array.isArray(config.gamePool) && config.gamePool.length >= 3) {
    return pickRandomUnique(config.gamePool, 3);
  }
  return config.fixedGames.slice(0, 3);
}

function getOptionByTitle(title) {
  try {
    const data = Array.isArray(window.OPTIONS_DATA) ? window.OPTIONS_DATA : [];
    return data.find(it => it && it.title === title) || null;
  } catch { return null; }
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

// La función adjustTitleFonts y su llamada han sido eliminadas
// para que el tamaño de fuente sea manejado por CSS.

function saveState() {
  try {
    localStorage.setItem(storageKeys.games, JSON.stringify(currentGames));
    localStorage.setItem(storageKeys.votes, JSON.stringify(votesByIndex));
    
    // Guardar userVotes como objeto
    const userVotesObj = {};
    for (const [key, data] of userVotes.entries()) {
      userVotesObj[key] = data;
    }
    localStorage.setItem(storageKeys.voters, JSON.stringify(userVotesObj));
    
    // Guardar displayNames
    const displayNamesObj = Object.fromEntries(userDisplayNames.entries());
    localStorage.setItem(storageKeys.voterNames, JSON.stringify(displayNamesObj));
    
  } catch (e) {
    console.error('[Storage] Error saving state:', e);
  }
}

function loadState() {
  try {
    const gamesRaw = localStorage.getItem(storageKeys.games);
    const userVotesRaw = localStorage.getItem(storageKeys.voters);
    const displayNamesRaw = localStorage.getItem(storageKeys.voterNames);
    
    if (gamesRaw) {
      currentGames = JSON.parse(gamesRaw);
    }
    
    if (displayNamesRaw) {
      const obj = JSON.parse(displayNamesRaw);
      for (const [key, val] of Object.entries(obj)) {
        userDisplayNames.set(key, val);
      }
    }
    
    // Cargar votos de usuarios
    if (userVotesRaw) {
      const obj = JSON.parse(userVotesRaw);
      
      for (const [key, data] of Object.entries(obj)) {
        // Migración desde formato antiguo (número solo = índice de choice)
        if (typeof data === 'number') {
          userVotes.set(key, { 
            choice: data, 
            level: 0, 
            extraBonus: 0
          });
          continue;
        }
        
        // Cargar datos del usuario preservando todos los campos
        if (data && typeof data === 'object') {
          const userData = {
            choice: typeof data.choice === 'number' ? data.choice : -1,
            level: typeof data.level === 'number' ? data.level : 0,
            extraBonus: typeof data.extraBonus === 'number' ? data.extraBonus : 0
          };
          
          // Preservar fixedPoints si existe (votos asignados por admin)
          if (typeof data.fixedPoints === 'number') {
            userData.fixedPoints = data.fixedPoints;
          }
          
          userVotes.set(key, userData);
        }
      }
    }
    
    // SIEMPRE recalcular votesByIndex desde userVotes para garantizar consistencia
    recalculateAllVotes();
    
  } catch (e) {
    console.error('[Storage] Error loading state:', e);
    // En caso de error, resetear a estado limpio
    userVotes.clear();
    votesByIndex = [0, 0, 0];
  }
}

// ============================================================================
// UI - RENDERIZADO
// ============================================================================

function renderCards() {
  gridEl.innerHTML = "";
  
  currentGames.forEach((gameTitle, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "card-wrapper entering";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "0px"; // Pegar el número a la tarjeta
    wrapper.style.height = "100%";
    wrapper.style.position = "relative";
    wrapper.style.animationDelay = `${index * 180}ms`;
    
    wrapper.addEventListener("animationend", (ev) => {
      if (ev.animationName === "optionIn" || ev.animationName === "slideInTech") {
        wrapper.classList.remove("entering");
        wrapper.style.animationDelay = "";
      }
    }, { once: true });
    
    const number = document.createElement("div");
    number.className = "option-number big-number";
    number.textContent = `!${index + 1}`;
    number.style.marginTop = "-25px"; // Mucho más arriba
    number.style.marginBottom = "8px"; 
    number.style.zIndex = "10";
    
    const card = document.createElement("div");
    card.className = "card";
    card.style.flex = "1";
    card.style.width = "100%";
    
    // Imagen de fondo
    let imageUrl = null;
    try {
      if (Array.isArray(window.OPTIONS_DATA) && window.OPTIONS_DATA.length === 3) {
        const atIndex = window.OPTIONS_DATA[index];
        if (atIndex && atIndex.image) imageUrl = atIndex.image;
      }
    } catch {}
    
    if (!imageUrl) {
      const opt = getOptionByTitle(gameTitle);
      if (opt && opt.image && opt.image !== "auto") imageUrl = opt.image;
    }
    
    // Si sigue sin haber imagen y tenemos API Key, buscamos en RAWG
    const objPos = (gameTitle.toUpperCase().includes('RYSE')) ? 'center center' : '65% center';
    
    if (!imageUrl || imageUrl === "auto") {
      fetchGameImage(gameTitle).then(img => {
        if (img) {
          card.style.background = "none";
          card.style.overflow = "hidden";
          
          const bgImg = document.createElement('img');
          bgImg.src = img;
          bgImg.alt = '';
          bgImg.decoding = 'async';
          bgImg.loading = 'lazy';
          bgImg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${objPos} !important;z-index:0;pointer-events:none;`;
          card.prepend(bgImg);
          
          if (!card.querySelector('.scanlines')) {
            const scanlines = document.createElement('div');
            scanlines.className = 'scanlines';
            card.appendChild(scanlines);
          }
        }
      });
    }

    if (imageUrl && imageUrl !== "auto") {
      card.style.background = "none";
      card.style.overflow = "hidden";
      
      const bgImg = document.createElement('img');
      bgImg.src = imageUrl;
      bgImg.alt = '';
      bgImg.decoding = 'async';
      bgImg.loading = 'lazy';
      bgImg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${objPos} !important;z-index:0;pointer-events:none;`;
      card.appendChild(bgImg);
      
      const scanlines = document.createElement('div');
      scanlines.className = 'scanlines';
      card.appendChild(scanlines);
    }
    
    // Fila superior: solo título
    const top = document.createElement("div");
    top.className = "game-row";
    top.style.zIndex = '1';
    
    const title = document.createElement("div");
    title.className = "game-title";
    title.textContent = gameTitle;
    
    top.appendChild(title);
    
    // Lista de votantes
    const chips = document.createElement('div');
    chips.className = 'voter-inline';
    chips.style.zIndex = '5';
    chips.style.left = '0px'; // Pegado al borde IZQUIERDO de la card
    // Estilos movidos al CSS para limpieza
    
    // Cartel flotante neón de votos
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
  });
  
  // Eliminado el ajuste de fuentes por JS para que mande el CSS con !important
}

function updateVoteBars() {
  const sum = votesByIndex.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const totalForPercent = (!Number.isFinite(sum) || sum === 0) ? 1 : sum;
  const cards = gridEl.querySelectorAll(".card");
  
  // Safe max count ensuring only valid numbers
  const validVotes = votesByIndex.map(v => Number.isFinite(v) ? v : 0);
  const maxCount = Math.max(0, ...validVotes);
  
  votesByIndex.forEach((count, index) => {
    const safeCount = Number.isFinite(count) ? count : 0;
    const percent = Math.round((safeCount / totalForPercent) * 100) || 0;
    const card = cards[index];
    if (!card) return;
    
    const fill = card.querySelector(".fill");
    const counter = card.querySelector(".vote-count");
    const label = card.querySelector(".label");
    
    if (fill) fill.style.width = `${percent}%`;
    if (counter) counter.textContent = `${safeCount}`;
    if (label) label.textContent = `${percent}%`;
    
    if (maxCount > 0 && safeCount === maxCount) {
      card.classList.add("is-leader");
      if (card.parentElement) card.parentElement.classList.add("is-leader");
    } else {
      card.classList.remove("is-leader");
      if (card.parentElement) card.parentElement.classList.remove("is-leader");
    }
  });
}

function updateVoterLists() {
  const cards = gridEl.querySelectorAll(".card");
  const votersByOption = [[], [], []];
  
  for (const [userKey, data] of userVotes.entries()) {
    const { choice, level, extraBonus, fixedPoints } = data;
    const displayName = userDisplayNames.get(userKey) || userKey;
    // Usar fixedPoints si existe (voto de admin), sino calcular
    const weight = fixedPoints ?? calculateTotalWeight(level, extraBonus);
    
    if (choice >= 0 && choice < 3) {
      votersByOption[choice].push({ 
        name: displayName, 
        level, 
        weight,
        hasBonus: extraBonus > 0 || fixedPoints !== undefined
      });
    }
  }
  
  votersByOption.forEach((list, index) => {
    list.sort((a, b) => b.weight - a.weight);
    
    const card = cards[index];
    if (!card) return;
    const wrapper = card.parentElement;
    
    const chipsWrap = wrapper.querySelector('.voter-inline');
    if (!chipsWrap) return;
    chipsWrap.innerHTML = '';
    
    list.forEach(voter => {
      const chip = document.createElement('span');
      chip.className = 'voter-chip';
      if (voter.hasBonus) chip.classList.add('has-bonus');
      
      // Los estilos ahora se manejan principalmente desde style.css (.voter-chip)
      
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
  if (!keepGames) {
    currentGames = chooseGames();
  }
  
  votesByIndex = [0, 0, 0];
  userVotes.clear();
  // NO limpiamos userDisplayNames para mantener los nombres
  // Los extraBonus se limpiarán automáticamente al día siguiente
  
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
    
    // Detectar redención de recompensa de canal
    const isRedemption = tagsStr.includes("msg-id=custom-reward-redemption") || 
                         tagsStr.includes("custom-reward-id=");
    
    handleChatMessage(username, message, displayName, isRedemption);
    return;
  }
  
  if (line.includes(" 001 ")) {
    // setStatus(`Conectado al chat de #${config.channelName}`); // Oculto a petición
  }
}

// ============================================================================
// LÓGICA DE COMANDOS
// ============================================================================

/**
 * Extrae el índice de voto del mensaje (!1, !2, !3 o !vota X)
 * Retorna: índice 0-2 o null si no es un voto válido
 */
function extractVote(message) {
  const lowered = message.toLowerCase().trim();
  
  // Formato directo: !1, !2, !3
  const direct = lowered.match(/^!([1-3])(\b|$)/);
  if (direct) {
    return parseInt(direct[1], 10) - 1;
  }
  
  // Formato con alias: !vota 1, !votar 2, !vote 3
  const matchedAlias = config.commandAliases.find(
    alias => lowered.startsWith(alias + " ") || lowered === alias
  );
  if (!matchedAlias) return null;
  
  const rest = lowered.replace(matchedAlias, "").trim();
  const number = parseInt(rest, 10);
  if (!Number.isFinite(number) || number < 1 || number > 3) return null;
  
  return number - 1;
}

/**
 * Extrae el índice de retirada del mensaje (!not1, !not2, !not3)
 * Retorna: índice 0-2 o null si no es una retirada válida
 */
function extractWithdrawal(message) {
  const match = message.toLowerCase().trim().match(/^!not([1-3])(\b|$)/);
  if (match) {
    return parseInt(match[1], 10) - 1;
  }
  return null;
}

/**
 * Extrae comando de administrador para asignar votos manualmente.
 * Formato: !<opción> <usuario> <puntos>
 * Ejemplo: !1 ractor09 4
 * Retorna: { optionIndex, targetUser, points } o null
 */
function extractAdminVote(message) {
  // Acepta: !1 ractor09 5  o  !1 ractor09 +5
  const match = message.trim().match(/^!([1-3])\s+(\S+)\s+\+?(\d+)$/i);
  if (match) {
    return {
      optionIndex: parseInt(match[1], 10) - 1,
      targetUser: match[2].toLowerCase(),
      points: parseInt(match[3], 10)
    };
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
    // Fallback: usar nivel guardado si existe
    const existing = userVotes.get(username.toLowerCase());
    return existing?.level || 0;
  }
}

// ============================================================================
// MANEJADOR PRINCIPAL DE MENSAJES
// ============================================================================

async function handleChatMessage(username, message, displayName, isExtraVote = false) {
  const userKey = username.toLowerCase();
  
  // Guardar displayName
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
  
  // =========================================================================
  // COMANDO DE ADMIN: Asignar voto manualmente
  // Formato: !<opción> <usuario> <puntos>
  // Ejemplo: !1 ractor09 4
  // Solo el streamer puede usar este comando
  // =========================================================================
  if (userKey === config.channelName.toLowerCase()) {
    const adminCmd = extractAdminVote(message);
    if (adminCmd) {
      const { optionIndex, targetUser, points } = adminCmd;
      
      // Si el usuario ya tenía un voto, quitarlo primero
      const existingData = userVotes.get(targetUser);
      if (existingData && existingData.choice >= 0 && existingData.choice < 3) {
        // Usar fixedPoints si existe, sino calcular
        const oldWeight = existingData.fixedPoints ?? calculateTotalWeight(existingData.level, existingData.extraBonus || 0);
        votesByIndex[existingData.choice] = Math.max(0, votesByIndex[existingData.choice] - oldWeight);
      }
      
      // Consultar el nivel real del usuario (solo para mostrar)
      const level = await fetchUserLevel(targetUser);
      
      // Guardar con puntos fijos (el admin decide los puntos exactos)
      const newData = {
        choice: optionIndex,
        level: level,
        extraBonus: 0,
        fixedPoints: points  // Puntos exactos asignados por el admin
      };
      
      userVotes.set(targetUser, newData);
      userDisplayNames.set(targetUser, targetUser);
      votesByIndex[optionIndex] += points;
      
      console.log(`[Admin] ${userKey} assigned ${targetUser} to option ${optionIndex + 1} with ${points} fixed points. Level: ${level}`);
      
      refreshUI();
      saveState();
      return;
    }
  }
  
  // Extraer índice de voto del mensaje
  const voteIndex = extractVote(message);
  
  // Obtener datos actuales del usuario
  let userData = userVotes.get(userKey) || null;
  
  // =========================================================================
  // CASO 1: Es una redención de voto extra
  // =========================================================================
  if (isExtraVote) {
    // Si no tiene un voto activo, guardar el bonus para cuando vote
    if (!userData) {
      // Crear entrada temporal con bonus pero sin choice
      userData = {
        choice: -1, // No ha votado aún
        level: await fetchUserLevel(userKey),
        extraBonus: 1
      };
      userVotes.set(userKey, userData);
      saveState();
      console.log(`[ExtraVote] User ${userKey} redeemed bonus (+1). No vote yet.`);
      
      // Si la redención incluye un voto (!1, !2, etc.), procesarlo ahora
      if (voteIndex !== null) {
        await processVote(userKey, voteIndex, userData);
      }
      return;
    }
    
    // Si ya tiene un voto activo, incrementar los puntos
    // Calcular peso anterior
    const oldWeight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus || 0);
    
    // Incrementar: si tiene fixedPoints (voto de admin), incrementar eso; sino incrementar extraBonus
    if (userData.fixedPoints !== undefined) {
      userData.fixedPoints += 1;
    } else {
      userData.extraBonus = (userData.extraBonus || 0) + 1;
    }
    
    // Calcular nuevo peso
    const newWeight = userData.fixedPoints ?? calculateTotalWeight(userData.level, userData.extraBonus);
    
    console.log(`[ExtraVote] User ${userKey} redeemed bonus. New weight: ${newWeight}`);
    
    // Si tiene un voto activo, actualizar la cuenta
    if (userData.choice >= 0 && userData.choice < 3) {
      votesByIndex[userData.choice] = votesByIndex[userData.choice] - oldWeight + newWeight;
    }
    
    userVotes.set(userKey, userData);
    refreshUI();
    saveState();
    
    // Si la redención también incluye un voto diferente, ignorar (ya tiene voto activo)
    return;
  }
  
  // =========================================================================
  // CASO 2: Retirada de voto (!notX)
  // =========================================================================
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
  
  // =========================================================================
  // CASO 3: Voto normal (!1, !2, !3, !4)
  // Solo se permite si el usuario NO tiene un voto previo.
  // Si ya votó (manualmente o por su cuenta), solo le cuentan los votos extra.
  // =========================================================================
  if (voteIndex !== null) {
    // Si ya tiene un voto activo, ignorar (no puede cambiar su voto)
    if (userData && userData.choice >= 0 && userData.choice < 3) {
      console.log(`[Vote] User ${userKey} already voted for option ${userData.choice + 1}. Ignoring new vote.`);
      return;
    }
    
    await processVote(userKey, voteIndex, userData);
  }
}

/**
 * Procesa un voto para un usuario.
 */
async function processVote(userKey, voteIndex, existingData) {
  const level = await fetchUserLevel(userKey);
  
  // Obtener bonus existente (si hay)
  let extraBonus = 0;
  
  if (existingData) {
    extraBonus = existingData.extraBonus || 0;

  }
  
  const newWeight = calculateTotalWeight(level, extraBonus);
  
  // Si ya votó previamente, quitar ese voto primero
  if (existingData && existingData.choice >= 0 && existingData.choice < 3) {
    const oldWeight = calculateTotalWeight(existingData.level, existingData.extraBonus || 0);
    votesByIndex[existingData.choice] = Math.max(0, votesByIndex[existingData.choice] - oldWeight);
    
    // Si vota lo mismo con el mismo peso, es redundante
    if (existingData.choice === voteIndex && oldWeight === newWeight) {
      console.log(`[Vote] User ${userKey} already voted for ${voteIndex + 1} with same weight. Skipping.`);
      return;
    }
  }
  
  // Registrar nuevo voto
  const newData = {
    choice: voteIndex,
    level: level,
    extraBonus: extraBonus
  };
  
  userVotes.set(userKey, newData);
  votesByIndex[voteIndex] += newWeight;
  
  console.log(`[Vote] User ${userKey} voted for option ${voteIndex + 1}. Level: ${level}, Base: ${calculateBaseWeight(level)}, Bonus: +${extraBonus}, Total: ${newWeight}`);
  
  // Animación visual
  const cards = gridEl.querySelectorAll(".card");
  if (cards[voteIndex]) {
    cards[voteIndex].classList.remove("pulse-voted");
    void cards[voteIndex].offsetWidth;
    cards[voteIndex].classList.add("pulse-voted");
    setTimeout(() => cards[voteIndex].classList.remove("pulse-voted"), 400);
  }
  
  refreshUI();
  saveState();
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

function initVideoBackground() {
  const v1 = document.getElementById('bgVideo1');
  const v2 = document.getElementById('bgVideo2');
  if (!v1 || !v2) return;
  
  let activeV = v1;
  let nextV = v2;
  let bgi = 0;

  activeV.src = config.backgrounds[bgi];
  activeV.playbackRate = config.backgrounds[bgi].includes('isabela.mp4') ? 0.5 : 1.0;
  activeV.play().catch(e => console.log('Autoplay blocked initially:', e));
  bgi = (bgi + 1) % config.backgrounds.length;

  function switchVideo() {
    const videoFile = config.backgrounds[bgi];
    nextV.onerror = () => {
      nextV.removeEventListener('loadeddata', onLoaded);
      bgi = (bgi + 1) % config.backgrounds.length;
      setTimeout(switchVideo, 500);
    };
    async function onLoaded() {
      nextV.removeEventListener('loadeddata', onLoaded);
      nextV.onerror = null;
      try {
        nextV.playbackRate = videoFile.includes('isabela.mp4') ? 0.5 : 1.0;
        await nextV.play();
        nextV.style.opacity = '1';
        activeV.style.opacity = '0';
        const oldV = activeV;
        setTimeout(() => { if (oldV !== activeV) oldV.pause(); }, 1600);
        [activeV, nextV] = [nextV, activeV];
        bgi = (bgi + 1) % config.backgrounds.length;
      } catch (err) {
        bgi = (bgi + 1) % config.backgrounds.length;
        setTimeout(switchVideo, 1000);
      }
    }
    nextV.addEventListener('loadeddata', onLoaded);
    nextV.src = videoFile;
    nextV.load();
  }
  setInterval(switchVideo, config.bgInterval);
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

function init() {
  showOverlay();
  // initVideoBackground(); // Desactivado para usar transparencia de OBS
  
  if (resetBtnEl) {
    // resetBtnEl.style.display = "inline-flex"; // Oculto el botón a petición del usuario
    resetBtnEl.addEventListener("click", () => resetVotes(false));
  }
  
  setHint("Vota con !1-!3 en el chat");
  
  // Cargar estado persistido
  loadState();
  
  // Usar juegos de data.js si está disponible
  try {
    const data = Array.isArray(window.OPTIONS_DATA) ? window.OPTIONS_DATA : [];
    const valid = data.length === 3 && data.every(it => it && typeof it.title === 'string' && it.title.trim().length > 0);
    if (valid) {
      currentGames = data.map(it => it.title);
    }
  } catch {}
  
  if (!Array.isArray(currentGames) || currentGames.length !== 3) {
    currentGames = chooseGames();
  }
  
  if (!Array.isArray(votesByIndex) || votesByIndex.length !== 3) {
    votesByIndex = [0, 0, 0];
  }
  
  renderCards();
  refreshUI();
  saveState();
  
  // Validar canal y conectar
  if (!config.channelName || /[^a-zA-Z0-9_]/.test(config.channelName)) {
    setStatus("Configura 'channelName' correctamente en el archivo.");
    return;
  }
  connectToTwitch();
  
  // Atajos de teclado
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") {
      resetVotes(!e.shiftKey);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
