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
  messageCounts: `wg_${config.channelName}_message_counts`,
};

// Estado
let websocket = null;
let currentGames = [];
let votesByIndex = [0, 0, 0, 0];
let userToChoice = new Map();
let userToDisplayName = new Map();
let userMessageCounts = new Map(); // Conteo de mensajes por usuario

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
    // Guardar conteo de mensajes
    const messageCountsObj = Object.fromEntries(userMessageCounts.entries());
    localStorage.setItem(storageKeys.messageCounts, JSON.stringify(messageCountsObj));
  } catch {}
}

// Datos iniciales de mensajes por usuario
const initialMessageCounts = {
  "james_193": 11350,
  "takeru_xiii": 11186,
  "ractor09": 10212,
  "x1lenz": 8122,
  "broxa24": 8062,
  "xroockk": 7486,
  "liiukiin": 8300,
  "darkous666": 7385,
  "c_h_a_n_d_a_l_f": 7322,
  "ccxsnop": 6913,
  "manguerazo": 6835,
  "urimas82": 6124,
  "macusam": 5513,
  "nanusso": 4836,
  "reichskanz": 4754,
  "yisus86": 4536,
  "mambiitv": 4358,
  "bitterbitz": 4326,
  "tonyforyu": 3871,
  "emma1403": 3774,
  "panicshow_12": 3664,
  "fabirules": 3562,
  "icarolinagi": 3313,
  "ifleky": 3292,
  "xxchusmiflowxx": 3289,
  "dmaster__io": 3024,
  "moradorpep": 2978,
  "damakimera": 2972,
  "reeckone": 2605,
  "juanka6668": 2454,
  "coerezil": 2443,
  "annacardo": 2176,
  "vannhackez": 2150,
  "akanas_": 2026,
  "mithands": 1926,
  "xioker": 1919,
  "sblazzin": 1908,
  "k0nrad_es": 1820,
  "mcguarru": 1757,
  "repxok": 1737,
  "n0cturne84": 1646,
  "n1tramix": 1635,
  "scotlane": 1605,
  "jookerlan": 1535,
  "albertplayxd": 1519,
  "srtapinguino": 1518,
  "olokaustho": 1440,
  "selenagomas_": 1436,
  "linabraun": 1432,
  "srgato_117": 1404,
  "pishadekai78": 1375,
  "kunfuu": 1363,
  "skodi": 1348,
  "duckcris": 1327,
  "01jenial": 1269,
  "sergiosc_games": 1233,
  "th3chukybar0": 1232,
  "redenil": 1188,
  "srroses": 1164,
  "azu_nai": 1161,
  "0necrodancer0": 1020,
  "cintramillencolin": 948,
  "miguela1982": 946,
  "fali_": 906,
  "jenial01": 896,
  "n4ch0g": 886,
  "inmaculadaconce": 879,
  "mxmktm": 873,
  "lingsh4n": 861,
  "melereh": 816,
  "zayavioleta": 810,
  "trujill04": 788,
  "sylarxd": 788,
  "scorgaming": 786,
  "extreme87r": 783,
  "grom_xl": 782,
  "an1st0pme": 778,
  "zeussar999": 775,
  "jramber": 774,
  "madgaia_": 769,
  "liiukiin": 750,
  "divazzi108": 721,
  "siilord": 708,
  "pesteavinno": 695,
  "adrivknj": 690,
  "belmont_z": 681,
  "wiismii": 663,
  "raulmilara79": 658,
  "rodrigo24714": 657,
  "c4n4rion": 648,
  "yllardelien": 647,
  "damnbearlord": 640,
  "sueir0": 629,
  "gray7": 621,
  "bre4k001": 596,
  "citrusjupiter": 594,
  "buu_ky": 590,
  "iblademax": 570,
  "oversilence": 567,
  "camperonaa": 563,
  "shzeta_": 555,
  "paxeco290": 553,
  "badulak3": 548,
  "aitorgp91": 544,
  "senbushito": 541,
  "eltri0n": 538,
  "brujita4894": 526,
  "zabala_ii": 524,
  "master_jashin": 512,
  "jamirovier": 482,
  "carlanga92": 475,
  "mifollower": 472,
  "mishuk0": 469,
  "mrkemm": 467,
  "witeriko": 433,
  "capitan__desastre": 432,
  "hartodebuscarnombre": 423,
  "teto05": 423,
  "viciuslab": 420,
  "simiskater": 419,
  "borknar": 418,
  "astr0way": 413,
  "alex_06____": 412,
  "mapache__xxx": 412,
  "daniellyep": 409,
  "tomacoo12": 409,
  "tvdestroyer9": 408,
  "saulcana": 405,
  "barriosesamo0": 399,
  "jcmintar": 399,
  "orodiz": 394,
  "amsoday": 391,
  "ragnar__85": 390,
  "yoxisko": 387,
  "kenneth_89": 384,
  "yisus_primero": 383,
  "tiressblacksoul": 379,
  "chinchyx": 377,
  "khhote": 361,
  "drlauti": 347,
  "llamp7": 345,
  "juankao9": 343,
  "lil_x01": 338,
  "metalex110": 334,
  "olmeca1982": 333,
  "maltajimn": 333,
  "sr_mayor": 332,
  "naircirk": 326,
  "suprgoaan": 315,
  "antenista": 311,
  "nue_p": 311,
  "noxiun": 307,
  "mazzykzn": 306,
  "celomar188": 305,
  "jayrow89": 304,
  "santarrosag": 303,
  "guilertv": 300,
  "xmagnifico": 295,
  "neivens_": 295,
  "el_tiodudu": 291,
  "robamadress": 290,
  "tuamigodoofter": 286,
  "rayco1922": 286,
  "cuzzoon": 281,
  "tarantantanxd": 278,
  "nier_enjoyer": 278,
  "the_panadero_gamer": 266,
  "ximanuu": 266,
  "alcatrazjose": 262,
  "sadalahanna": 261,
  "iguanamanjr": 261,
  "tiredbylol": 260,
  "raiso963": 259,
  "nicolebecb": 259,
  "lolommp25": 254,
  "pentakirk": 252,
  "afattwitch": 251,
  "tabiht": 246,
  "toxic30008": 245,
  "tokoro_temnosuke": 242,
  "jess________mndz": 241,
  "nandoss70": 239,
  "sir_fernan": 238,
  "tutifruty__": 238,
  "zoyifour": 237,
  "lexenemy": 237,
  "pepapic_": 233,
  "guillermojp06": 233,
  "dhampirian": 230,
  "rambodehacendao": 227,
  "dixgrakyz": 226,
  "shanat_destroyer": 226,
  "miguesf": 226,
  "misalf13": 225,
  "joz_hernam": 225,
  "danidux": 224,
  "ishilwen": 224,
  "furia_cc": 222,
  "zarkyhrr": 221,
  "desmoralizer": 218,
  "haldodd": 214,
  "jotauveh": 213,
  "xtreamejandro": 213,
  "aint_scene": 212,
  "victor_andorra1986": 212,
  "nekukun78": 209,
  "markozorro0": 206,
  "esnandez": 204,
  "poybitron": 203,
  "javiplms": 199,
  "vitty81": 198,
  "senketsur": 197,
  "jugador_no13": 195,
  "diegorl98_": 195,
  "tsirocco": 190,
  "jusstabe": 189,
  "furrypugy": 187,
  "draganzero": 186,
  "iizundae": 184,
  "diamantegt": 182,
  "namacrax": 181,
  "heyjeyjey92": 180,
  "pivi_": 180,
  "winniedepus": 180,
  "xusclado": 179,
  "bassi____": 179,
  "lalobgl": 178,
  "nina96_": 178,
  "kaisher30": 177,
  "djalex5": 176,
  "jorgens0n": 176,
  "jasobeam10": 176,
  "sensei_hn3": 175,
  "carfas": 175,
  "carlos_morigosa": 175,
  "blancoloureiro": 175,
  "tiobrew": 173,
  "theralez_": 173,
  "zhulthalas": 172,
  "camilo041191": 171,
  "hobbbby": 170,
  "monkeyvalent": 169,
  "rallo121": 169,
  "andloars": 168,
  "kaballo_": 168,
  "cristian_vg00": 165,
  "darkdoraem0n": 164,
  "lordhanibaltv": 164,
  "pepii__sg": 163,
  "sr_raider": 163,
  "valfede": 162,
};

function loadState() {
  try {
    const gamesRaw = localStorage.getItem(storageKeys.games);
    const votesRaw = localStorage.getItem(storageKeys.votes);
    const votersRaw = localStorage.getItem(storageKeys.voters);
    const voterNamesRaw = localStorage.getItem(storageKeys.voterNames);
    const messageCountsRaw = localStorage.getItem(storageKeys.messageCounts);
    if (gamesRaw) currentGames = JSON.parse(gamesRaw);
    if (votesRaw) votesByIndex = JSON.parse(votesRaw);
    if (votersRaw) userToChoice = new Map(Object.entries(JSON.parse(votersRaw)));
    if (voterNamesRaw) userToDisplayName = new Map(Object.entries(JSON.parse(voterNamesRaw)));
    // Cargar conteo de mensajes o inicializar con datos iniciales
    if (messageCountsRaw) {
      const loaded = JSON.parse(messageCountsRaw);
      userMessageCounts = new Map(Object.entries(loaded));
      // Asegurar que los datos iniciales estén presentes
      // Si el usuario no existe o tiene menos mensajes que el inicial, usar el inicial
      for (const [user, initialCount] of Object.entries(initialMessageCounts)) {
        const currentCount = userMessageCounts.get(user) || 0;
        // Si el usuario no existe o tiene menos que el inicial, establecer el inicial
        // Si ya tiene más, mantener su valor (los nuevos mensajes se suman automáticamente)
        if (currentCount < initialCount) {
          userMessageCounts.set(user, initialCount);
        }
      }
    } else {
      // Primera vez: inicializar con datos iniciales
      userMessageCounts = new Map(Object.entries(initialMessageCounts));
    }
  } catch {}
}

function resetVotes(keepGames = true) {
  if (!keepGames) {
    currentGames = chooseGames();
  }
  votesByIndex = [0, 0, 0, 0];
  userToChoice.clear();
  // No reseteamos el conteo de mensajes, se mantiene
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

    // Asegurar contenido por encima del fondo
    top.style.position = 'relative';
    top.style.zIndex = '1';
    chips.style.position = 'relative';
    chips.style.zIndex = '1';
    bottom.style.position = 'relative';
    bottom.style.zIndex = '1';

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
    if (choiceIndex >= 0 && choiceIndex < 4) votersByOption[choiceIndex].push(display);
  }
  votersByOption.forEach((list, index) => {
    const card = cards[index];
    if (!card) return;
    const chipsWrap = card.querySelector('.voter-inline');
    if (!chipsWrap) return;
    chipsWrap.innerHTML = '';
    list.forEach(name => {
      const chip = document.createElement('span');
      chip.className = 'voter-chip';
      chip.textContent = name;
      // Color único por nombre: calcular un tono (hue) determinístico
      let acc = 0;
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
    handleChatMessage(username, message, displayName);
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

// Calcular el peso del voto basado en el número de mensajes
function calculateVoteWeight(messageCount) {
  // Escala de votos:
  // Menos de 500 mensajes = 1 voto
  // 500-699 = 2 votos
  // 700-899 = 3 votos
  // 900-1199 = 4 votos
  // 1200-1499 = 5 votos
  // 1500-1799 = 6 votos
  // 1800-2099 = 7 votos
  // 2100-2399 = 8 votos
  // 2400-2699 = 9 votos
  // 2700-3999 = 10 votos
  // 4000-5499 = 11 votos
  // 5500-7299 = 12 votos
  // 7300-9399 = 13 votos
  // 9400-11799 = 14 votos
  // 11800+ = 15 votos (máximo)
  
  if (messageCount < 500) return 1;
  if (messageCount < 700) return 2;
  if (messageCount < 900) return 3;
  if (messageCount < 1200) return 4;
  if (messageCount < 1500) return 5;
  if (messageCount < 1800) return 6;
  if (messageCount < 2100) return 7;
  if (messageCount < 2400) return 8;
  if (messageCount < 2700) return 9;
  if (messageCount < 4000) return 10;
  if (messageCount < 5500) return 11;
  if (messageCount < 7300) return 12;
  if (messageCount < 9400) return 13;
  if (messageCount < 11800) return 14;
  return 15; // Máximo 15 votos
}

// Calcular el peso del voto basado en los mensajes del usuario
function getVoteWeight(username) {
  const messageCount = userMessageCounts.get(username) || 0;
  return calculateVoteWeight(messageCount);
}

function handleChatMessage(username, message, displayName) {
  // Comando para resetear votación (solo el streamer) - procesar antes de incrementar mensajes
  const loweredMessage = message.toLowerCase().trim();
  if ((loweredMessage === "!reset" || loweredMessage === "!reset votacion" || loweredMessage === "!resetvotacion") 
      && username === config.channelName.toLowerCase()) {
    resetVotes(false);
    saveState();
    return;
  }

  // Incrementar contador de mensajes para este usuario
  const currentCount = userMessageCounts.get(username) || 0;
  userMessageCounts.set(username, currentCount + 1);

  const newIndex = extractVote(message);
  if (newIndex === null) {
    // Aunque no sea un voto, guardamos el incremento de mensajes
    saveState();
    return;
  }

  const hadPrevious = userToChoice.has(username);
  const prevIndex = hadPrevious ? Number(userToChoice.get(username)) : null;

  // Si el voto no cambia, no hacemos nada (pero ya incrementamos los mensajes)
  if (prevIndex === newIndex) {
    saveState();
    return;
  }

  // Calcular el peso del voto anterior
  // El peso se calcula con el conteo ANTES del incremento (currentCount)
  // porque ese fue el conteo cuando se hizo el voto anterior
  const prevWeight = calculateVoteWeight(currentCount);

  // Restar el voto anterior si existía (con su peso correspondiente)
  if (hadPrevious && prevIndex !== null && prevIndex >= 0 && prevIndex < 4) {
    const currentPrev = Number(votesByIndex[prevIndex] || 0);
    votesByIndex[prevIndex] = Math.max(0, currentPrev - prevWeight);
  }

  // Calcular el nuevo peso del voto (con el mensaje ya incrementado)
  const newWeight = getVoteWeight(username);

  // Registrar nuevo voto con su peso
  userToChoice.set(username, newIndex);
  if (displayName) userToDisplayName.set(username, displayName);
  votesByIndex[newIndex] = (Number(votesByIndex[newIndex] || 0) + newWeight);

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


