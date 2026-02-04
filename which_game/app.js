// Configuración del overlay (edítala si lo necesitas)
const config = {
  channelName: "liiukiin", // ← canal de Twitch (sin #)
  selectionMode: "fixed", // "fixed" | "random"
  fixedGames: [
    "Juego A",
    "Juego B",
    "Juego C",
    "Juego D",
  ],
  commandAliases: ["!vota", "!votar", "!vote"],
  oneVotePerUser: true,
};

// Claves de almacenamiento
const storageKeys = {
  games: `wg_${config.channelName}_games`,
  votes: `wg_${config.channelName}_votes`,
  voters: `wg_${config.channelName}_voters`,
  voterNames: `wg_${config.channelName}_voter_names`,

  weights: `wg_${config.channelName}_weights`,
  levels: `wg_${config.channelName}_levels`, // Nueva clave para niveles
  extraVotes: `wg_${config.channelName}_extra_votes`, // Nueva clave para votos extra diarios
};

// Estado
let websocket = null;
let currentGames = [];
let votesByIndex = [0, 0, 0, 0];
let userToChoice = new Map();
let userToDisplayName = new Map();

let userToWeight = new Map(); // Mapa de pesos de voto por usuario
let userToLevel = new Map();  // Mapa de niveles por usuario
let userToExtraVoteDate = new Map(); // Mapa de usuario -> fecha del último voto extra

// Elementos del DOM
const overlayEl = document.getElementById("overlay");
const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const badgeEl = document.getElementById("roundBadge");
const resetBtnEl = document.getElementById("resetBtn");

// Utilidades
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
    const valid = data.length === 4 && data.every(it => it && typeof it.title === 'string' && it.title.trim().length > 0);
    if (valid) {
      return data.map(it => it.title);
    }
  } catch {}
  if (config.selectionMode === "fixed") {
    return config.fixedGames.slice(0, 4);
  }
  if (Array.isArray(config.gamePool) && config.gamePool.length >= 4) return pickRandomUnique(config.gamePool, 4);
  return config.fixedGames.slice(0, 4);
}

function getOptionByTitle(title) {
  try {
    const data = Array.isArray(window.OPTIONS_DATA) ? window.OPTIONS_DATA : [];
    return data.find(it => it && it.title === title) || null;
  } catch { return null; }
}

function saveState() {
  try {
    localStorage.setItem(storageKeys.games, JSON.stringify(currentGames));
    localStorage.setItem(storageKeys.votes, JSON.stringify(votesByIndex));
    // Guardar mapa de votantes como objeto simple
    const votersObj = Object.fromEntries(userToChoice.entries());
    localStorage.setItem(storageKeys.voters, JSON.stringify(votersObj));
    const voterNamesObj = Object.fromEntries(userToDisplayName.entries());
    localStorage.setItem(storageKeys.voterNames, JSON.stringify(voterNamesObj));
    // Guardar pesos y niveles
    const weightsObj = Object.fromEntries(userToWeight.entries());
    localStorage.setItem(storageKeys.weights, JSON.stringify(weightsObj));
    const levelsObj = Object.fromEntries(userToLevel.entries());
    localStorage.setItem(storageKeys.levels, JSON.stringify(levelsObj));
    const extraVotesObj = Object.fromEntries(userToExtraVoteDate.entries());
    localStorage.setItem(storageKeys.extraVotes, JSON.stringify(extraVotesObj));
  } catch {}
}

// Datos iniciales de mensajes por usuario

function loadState() {
  try {
    const gamesRaw = localStorage.getItem(storageKeys.games);
    const votesRaw = localStorage.getItem(storageKeys.votes);
    const votersRaw = localStorage.getItem(storageKeys.voters);
    const voterNamesRaw = localStorage.getItem(storageKeys.voterNames);
    const weightsRaw = localStorage.getItem(storageKeys.weights);
    const levelsRaw = localStorage.getItem(storageKeys.levels);
    if (gamesRaw) currentGames = JSON.parse(gamesRaw);
    if (votesRaw) votesByIndex = JSON.parse(votesRaw);
    if (votersRaw) userToChoice = new Map(Object.entries(JSON.parse(votersRaw)));
    if (voterNamesRaw) userToDisplayName = new Map(Object.entries(JSON.parse(voterNamesRaw)));
    if (weightsRaw) userToWeight = new Map(Object.entries(JSON.parse(weightsRaw)));
    if (levelsRaw) userToLevel = new Map(Object.entries(JSON.parse(levelsRaw)));
    const extraVotesRaw = localStorage.getItem(storageKeys.extraVotes);
    if (extraVotesRaw) userToExtraVoteDate = new Map(Object.entries(JSON.parse(extraVotesRaw)));
  } catch {}
}

function resetVotes(keepGames = true) {
  if (!keepGames) {
    currentGames = chooseGames();
  }
  votesByIndex = [0, 0, 0, 0];
  userToChoice.clear();
  userToWeight.clear();
  userToLevel.clear();
  renderCards();
  updateVoteBars();
  updateVoterLists();
  saveState();
  setStatus("Encuesta reseteada");
}

function renderCards() {
  gridEl.innerHTML = "";
  currentGames.forEach((gameTitle, index) => {
    const card = document.createElement("div");
    card.className = "card";
    // Animación de entrada con retardo escalonado
    card.classList.add("entering");
    card.style.animationDelay = `${index * 180}ms`;
    card.addEventListener("animationend", (ev) => {
      if (ev.animationName === "optionIn") {
        card.classList.remove("entering");
        card.style.animationDelay = "";
      }
    }, { once: true });
    // Imagen: prioriza por índice en OPTIONS_DATA, luego por título
    let imageUrl = null;
    try {
      if (Array.isArray(window.OPTIONS_DATA) && window.OPTIONS_DATA.length === 4) {
        const atIndex = window.OPTIONS_DATA[index];
        if (atIndex && atIndex.image) imageUrl = atIndex.image;
      }
    } catch {}
    if (!imageUrl) {
      const opt = getOptionByTitle(gameTitle);
      if (opt && opt.image) imageUrl = opt.image;
    }
    if (imageUrl) {
      // Usar un <img> absoluto como fondo visible
      card.style.background = "none";
      card.style.overflow = "hidden";

      const bgImg = document.createElement('img');
      bgImg.src = imageUrl;
      bgImg.alt = '';
      bgImg.decoding = 'async';
      bgImg.loading = 'lazy';
      bgImg.style.position = 'absolute';
      bgImg.style.inset = '0';
      bgImg.style.width = '100%';
      bgImg.style.height = '100%';
      bgImg.style.objectFit = 'cover';
      bgImg.style.zIndex = '0';
      bgImg.style.pointerEvents = 'none';
      card.appendChild(bgImg);

      // Overlay de Scanlines
      const scanlines = document.createElement('div');
      scanlines.className = 'scanlines';
      card.appendChild(scanlines);
    }

    const top = document.createElement("div");
    top.className = "game-row";
    const number = document.createElement("div");
    number.className = "option-number";
    number.textContent = `!${index + 1}`;
    const title = document.createElement("div");
    title.className = "game-title";
    title.textContent = gameTitle;
    top.appendChild(number);
    top.appendChild(title);

    // Lista de votantes inline (siempre visible y discreta)
    const chips = document.createElement('div');
    chips.className = 'voter-inline';

    const bottom = document.createElement("div");
    bottom.className = "votes";
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = "0%";
    bar.appendChild(fill);
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = "0%";
    bar.appendChild(label);
    const count = document.createElement("div");
    count.className = "vote-count";
    count.textContent = "0";
    bottom.appendChild(bar);
    bottom.appendChild(count);

    // Asegurar contenido por encima del fondo (Manejado por CSS)
    top.style.zIndex = '1';
    chips.style.zIndex = '5';
    bottom.style.zIndex = '20';

    card.appendChild(top);
    card.appendChild(chips);
    card.appendChild(bottom);
    gridEl.appendChild(card);
  });
}

function updateVoteBars() {
  const sum = votesByIndex.reduce((a, b) => a + b, 0);
  const totalForPercent = sum === 0 ? 1 : sum;
  const cards = gridEl.querySelectorAll(".card");
  const maxCount = Math.max(...votesByIndex);
  votesByIndex.forEach((count, index) => {
    const percent = Math.round((count / totalForPercent) * 100);
    const card = cards[index];
    if (!card) return;
    const fill = card.querySelector(".fill");
    const counter = card.querySelector(".vote-count");
    const label = card.querySelector(".label");
    if (fill) fill.style.width = `${percent}%`;
    if (counter) counter.textContent = `${count}`;
    if (label) label.textContent = `${percent}%`;
    if (maxCount > 0) {
      if (count === maxCount) {
        card.classList.add("is-leader");
      } else {
        card.classList.remove("is-leader");
      }
    } else {
      card.classList.remove("is-leader");
    }
  });
}

function updateVoterLists() {
  const cards = gridEl.querySelectorAll(".card");
  // Reunir votantes por opción
  const votersByOption = [[], [], [], []];
  for (const [username, choiceIndex] of userToChoice.entries()) {
    const display = userToDisplayName.get(username) || username;
    const level = userToLevel.get(username) || 0;
    const weight = userToWeight.get(username) || 1;
    if (choiceIndex >= 0 && choiceIndex < 4) {
      votersByOption[choiceIndex].push({ name: display, level, weight });
    }
  }
  votersByOption.forEach((list, index) => {
    // Ordenar de mayor a menor peso (puntos)
    list.sort((a, b) => b.weight - a.weight);

    const card = cards[index];
    if (!card) return;
    const chipsWrap = card.querySelector('.voter-inline');
    if (!chipsWrap) return;
    chipsWrap.innerHTML = '';
    list.forEach(voter => {
      const chip = document.createElement('span');
      chip.className = 'voter-chip';
      if (voter.level >= 50) chip.classList.add('high-level');
      
      const lvlTag = document.createElement('span');
      lvlTag.className = 'lvl-tag';
      lvlTag.textContent = `Lvl.${voter.level}`;

      const nameTag = document.createElement('span');
      nameTag.className = 'voter-name';
      nameTag.textContent = voter.name;
      
      const ptsTag = document.createElement('span');
      ptsTag.className = 'pts-tag';
      ptsTag.textContent = `+${voter.weight}`;
      
      chip.appendChild(lvlTag);
      chip.appendChild(nameTag);
      chip.appendChild(ptsTag);

      // Color único por nombre: calcular un tono (hue) determinístico
      let acc = 0;
      const name = voter.name;
      for (let i = 0; i < name.length; i++) acc = (acc + name.charCodeAt(i) * 17) % 3600;
      const hue = acc % 360;

      chip.style.setProperty('--chip-hue', String(hue));
      chipsWrap.appendChild(chip);
    });
  });
}

function showOverlay() {
  overlayEl.style.display = "block";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setHint(text) {
  hintEl.textContent = text;
}

// Conexión a Twitch IRC (solo lectura)
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
    const data = event.data;
    const lines = String(data).split("\r\n");
    for (const line of lines) {
      if (!line) continue;
      handleIrcLine(line);
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

  // Captura opcional de tags para obtener display-name
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
    
    // Detectar si es una redención de puntos de canal con mensaje
    const isRedemption = tagsStr.includes("msg-id=custom-reward-redemption") || tagsStr.includes("custom-reward-id=");
    
    handleChatMessage(username, message, displayName, isRedemption);
    return;
  }

  if (line.includes(" 001 ")) {
    setStatus(`Conectado al chat de #${config.channelName}`);
  }
}

function extractVote(message) {
  const lowered = message.toLowerCase().trim();
  // Nuevo formato: !1, !2, !3, !4
  const direct = lowered.match(/^!([1-4])(\b|$)/);
  if (direct) {
    return parseInt(direct[1], 10) - 1;
  }
  // Compatibilidad: !vota 1, !votar 2, !vote 3, etc.
  const matchedAlias = config.commandAliases.find(alias => lowered.startsWith(alias + " ") || lowered === alias);
  if (!matchedAlias) return null;
  const rest = lowered.replace(matchedAlias, "").trim();
  const number = parseInt(rest, 10);
  if (!Number.isFinite(number)) return null;
  if (number < 1 || number > 4) return null;
  return number - 1;
}

function extractWithdrawal(message) {
  const lowered = message.toLowerCase().trim();
  const match = lowered.match(/^!not([1-4])(\b|$)/);
  if (match) {
    return parseInt(match[1], 10) - 1;
  }
  return null;
}

// Calcular el peso del voto basado en el número de mensajes
// Consultar y calcular el peso del voto usando el Gist y lógica de niveles
async function fetchUserLevel(username) {
  try {
    // Usamos timestamp para evitar cache y "consultar en directo"
    const res = await fetch(`https://gist.githubusercontent.com/PCSolucion/16f750fb60b890aa9b06e53cc97cc49e/raw/xp_data.json?t=${Date.now()}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return data.users?.[username.toLowerCase()]?.level || 0;
  } catch (e) {
    console.error("Error fetching user level:", e);
    return 0; // Si falla, nivel 0 (peso 1)
  }
}

function calculateVoteWeight(level) {
  // del level 1 al 19 vale 1
  if (typeof level !== 'number' || level < 20) return 1;
  // de 20 a 29 vale 2, 37 vale 3, etc. (floor division)
  // maximo 100 o mas vale 10
  if (level >= 100) return 10;
  return Math.floor(level / 10);
}

// Calcular el peso del voto basado en los mensajes del usuario


async function handleChatMessage(username, message, displayName, isExtraVote = false) {
  // Comando para resetear votación (solo el streamer)
  const loweredMessage = message.toLowerCase().trim();
  if ((loweredMessage === "!reset" || loweredMessage === "!reset votacion" || loweredMessage === "!resetvotacion") 
      && username === config.channelName.toLowerCase()) {
    resetVotes(false);
    saveState();
    return;
  }

  // Ya no incrementamos messageCounts localmente

  // Comprobar si es un comando de retirada !notX
  const withdrawalIndex = extractWithdrawal(message);
  if (withdrawalIndex !== null) {
    const prevIndex = userToChoice.has(username) ? Number(userToChoice.get(username)) : null;
    if (prevIndex === withdrawalIndex) {
      const prevWeight = userToWeight.get(username) || 0;
      votesByIndex[withdrawalIndex] = Math.max(0, (votesByIndex[withdrawalIndex] || 0) - prevWeight);
      userToChoice.delete(username);
      // No borramos el peso por si vuelve a votar, pero el Choice indica que no tiene voto activo
      updateVoteBars();
      updateVoterLists();
      saveState();
      console.log(`[Withdraw] User ${username} withdrew vote for index ${withdrawalIndex}`);
    }
    return;
  }

  const newIndex = extractVote(message);
  if (newIndex === null) {
    return;
  }

  // Consultar Nivel y Calcular Peso Base
  const level = await fetchUserLevel(username);
  const baseWeight = calculateVoteWeight(level);
  
  // Determinar si el usuario tiene activado el bonus extra hoy
  const today = new Date().toISOString().split('T')[0];
  let hasExtraToday = userToExtraVoteDate.get(username) === today;

  // Si es un canje de recompensa Y aún no lo ha usado hoy, activarlo
  if (isExtraVote && !hasExtraToday) {
    userToExtraVoteDate.set(username, today);
    hasExtraToday = true;
    console.log(`[Extra Vote] User ${username} activated +1 point bonus for today.`);
  }

  // Peso TOTAL = Base + Bonus
  const newWeight = baseWeight + (hasExtraToday ? 1 : 0);

  const hadPrevious = userToChoice.has(username);
  const prevIndex = hadPrevious ? Number(userToChoice.get(username)) : null;
  const prevWeight = userToWeight.get(username) || 1;

  // Si el usuario vota lo mismo que antes Y con el mismo peso, no hacemos nada
  if (hadPrevious && prevIndex === newIndex && prevWeight === newWeight) {
    return;
  }

  // Si tenía voto previo, retíralo con su peso anterior
  // Si cambia de opción O cambia de peso, necesitamos restar lo anterior
  if (hadPrevious && prevIndex !== null && prevIndex >= 0 && prevIndex < 4) {
    const currentPrev = Number(votesByIndex[prevIndex] || 0);
    votesByIndex[prevIndex] = Math.max(0, currentPrev - prevWeight);
  }

  // Si el nuevo voto es el mismo pero con peso distinto, o es voto nuevo, lo añadimos
  // (Nota: si era el mismo voto y peso distinto, ya lo restamos arriba, ahora sumamos el nuevo)
  userToChoice.set(username, newIndex);
  userToWeight.set(username, newWeight);
  userToLevel.set(username, level);
  if (displayName) userToDisplayName.set(username, displayName);
  
  votesByIndex[newIndex] = (Number(votesByIndex[newIndex] || 0) + newWeight);

  // Trigger pulse animation on the card
  const cards = gridEl.querySelectorAll(".card");
  if (cards[newIndex]) {
    cards[newIndex].classList.remove("pulse-voted");
    void cards[newIndex].offsetWidth; // force reflow
    cards[newIndex].classList.add("pulse-voted");
    setTimeout(() => cards[newIndex].classList.remove("pulse-voted"), 400);
  }

  updateVoteBars();
  updateVoterLists();
  saveState();
}

// Inicialización
function init() {
  // Mostrar overlay siempre activo
  showOverlay();
  if (resetBtnEl) {
    resetBtnEl.style.display = "inline-flex";
    // El botón recarga también los juegos (útil tras editar data.js)
    resetBtnEl.addEventListener("click", () => resetVotes(false));
  }

  setHint("Vota con !1-!4 en el chat");
  badgeEl.textContent = "activa";

  // Cargar estado persistido o iniciar uno nuevo
  loadState();
  // Asegurar que los datos iniciales estén guardados después de cargar
  saveState();
  // Si existe data.js válido, forzar a usar sus títulos (garantiza correspondencia con imágenes)
  try {
    const data = Array.isArray(window.OPTIONS_DATA) ? window.OPTIONS_DATA : [];
    const valid = data.length === 4 && data.every(it => it && typeof it.title === 'string' && it.title.trim().length > 0);
    if (valid) {
      currentGames = data.map(it => it.title);
    }
  } catch {}
  if (!Array.isArray(currentGames) || currentGames.length !== 4) {
    currentGames = chooseGames();
  }
  if (!Array.isArray(votesByIndex) || votesByIndex.length !== 4) {
    votesByIndex = [0, 0, 0, 0];
  }

  renderCards();
  updateVoteBars();
  updateVoterLists();

  // Conectar a Twitch
  if (!config.channelName || /[^a-zA-Z0-9_]/.test(config.channelName)) {
    setStatus("Configura 'channelName' correctamente en el archivo.");
  }
  connectToTwitch();

  // Atajos de teclado:
  // - R: resetear solo votos
  // - Shift+R: resetear y recargar juegos desde configuración
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") {
      if (e.shiftKey) {
        resetVotes(false);
      } else {
        resetVotes(true);
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", init);


