/* =============================================
   ANIMEFLIX — app.js v3.0
   Mejoras integradas:
   1. Rutas dinámicas con slugs + deep linking robusto (fetchAnimeById)
   2. Estado de emisión + countdown próximo episodio (AniList GraphQL)
   3. Miniaturas en 3 niveles: scraper → Jikan → AniList streamingEpisodes → degradado
   4. Control de secciones Home con setSearchState()
   5. Búsqueda predictiva en tiempo real con debounce + caché de sesión
   ============================================= */

"use strict";

// ─── CONFIGURACIÓN ────────────────────────────
const API_KEY   = "dev-anime1v-key";
const BASE_URL  = "https://nextarc-production.up.railway.app/api/v1/anime";
const USERS_URL = "https://nextarc-production.up.railway.app/api/users";
const JIKAN     = "https://api.jikan.moe/v4";
const ANILIST   = "https://graphql.anilist.co";

const apiHeaders = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};

function authHeaders() {
  const token = localStorage.getItem("rik_jwt");
  return token
    ? { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
    : { "Content-Type": "application/json" };
}

// ─── ESTADO GLOBAL ────────────────────────────
let localAnimeData       = [];   // catálogo completo de Jikan
let filteredAnimeData    = [];   // catálogo filtrado activo
let currentFilter        = "tv"; // "tv" | "movie"
let animeActualMAL       = null;
let animeActualBackend   = null;
let idiomaActual         = "sub";
let esModoDemoActivo     = false;
let heroAnimes           = [];   // top-5 para el banner
let heroIndex            = 0;
let heroTimer            = null;

let _episodeStartTime = null;   // timestamp cuando abre el modal
let _lastSavedTime    = 0;      // último currentTime guardado (throttle 5 s)
let _resumeTime       = 0;      // segundo al que saltar al cargar el video
let servidoresStreamCache   = [];
let servidoresDownloadCache = [];
let modoModalActual         = "stream";
let numeroEpisodioActual    = "?";

// ─── [NUEVO] ESTADO DE BÚSQUEDA ───────────────
let searchState    = "idle"; // "idle" | "active"
let debounceTimer  = null;
const DEBOUNCE_MS  = 300;

// IDs de secciones del Home que se ocultan durante búsqueda activa
const HOME_SECTIONS = [
  "continueWatchingSection",
  "followingTodaySection",
  "heroBanner",
];

// ─── [NUEVO] CACHÉ DE BÚSQUEDAS (sesión) ──────
const searchCache = new Map(); // query → resultados Jikan

// ─── [NUEVO] CACHÉ DE MINIATURAS ──────────────
const thumbCache      = {};   // "malId_epNum" → url
const aniListEpCache  = {};   // malId → array de { title, thumbnail }

// ─── [NUEVO] CONTADOR DE PRÓXIMO EPISODIO ─────
let _nextEpIntervalId = null; // para limpiar el setInterval al cambiar de anime

// ═══════════════════════════════════════════════════
// SISTEMA DE LIKES LOCALES (sin cuenta obligatoria)
// ═══════════════════════════════════════════════════
const LOCAL_LIKES_KEY = "rik_local_likes";

function getLocalHistory() {
  // Historial para usuarios sin cuenta guardado en localStorage
  try { return JSON.parse(localStorage.getItem("rik_local_history") || "[]"); }
  catch(e) { return []; }
}

function saveLocalHistory(arr) {
  localStorage.setItem("rik_local_history", JSON.stringify(arr));
}

// Guardar historial local (sin cuenta)
function saveLocalHistoryEntry(malId, epNumber, time) {
  const history = getLocalHistory();
  const key = `${malId}_${epNumber}`;
  const idx = history.findIndex(h => h.key === key);
  const entry = { key, mal_id: malId, episode: epNumber, time, updatedAt: Date.now() };
  if (idx > -1) history[idx] = entry;
  else history.push(entry);
  saveLocalHistory(history);
}

function getLocalLikes() {
  try { return JSON.parse(localStorage.getItem(LOCAL_LIKES_KEY) || "[]"); }
  catch(e) { return []; }
}

function saveLocalLikes(arr) {
  localStorage.setItem(LOCAL_LIKES_KEY, JSON.stringify(arr));
}

function isLocalLiked(malId) {
  return getLocalLikes().some(l => l.mal_id == malId);
}

function toggleLocalLike(animeObj) {
  const likes = getLocalLikes();
  const idx   = likes.findIndex(l => l.mal_id == animeObj.mal_id);
  if (idx > -1) {
    likes.splice(idx, 1);
    showToast(`"${animeObj.title}" eliminado de Me gusta`);
  } else {
    likes.push({
      mal_id: animeObj.mal_id,
      title:  animeObj.title,
      image:  animeObj.images?.jpg?.image_url || "",
      score:  animeObj.score,
      type:   animeObj.type,
      likedAt: Date.now(),
    });
    showToast(`💖 "${animeObj.title}" agregado a Me gusta`);
  }
  saveLocalLikes(likes);
  // Actualizar todos los botones de corazón visibles
  document.querySelectorAll(`.like-heart-btn[data-mal="${animeObj.mal_id}"]`).forEach(btn => {
    _updateLikeBtn(btn, isLocalLiked(animeObj.mal_id));
  });
  renderLocalLikesSection();
}

function _updateLikeBtn(btn, liked) {
  const icon = btn.querySelector("i");
  if (!icon) return;
  if (liked) {
    icon.className = "fas fa-heart";
    btn.classList.add("liked");
    btn.title = "Quitar Me gusta";
  } else {
    icon.className = "far fa-heart";
    btn.classList.remove("liked");
    btn.title = "Me gusta";
  }
}

// Crea el botón de corazón flotante sobre la portada
function createLikeBtn(animeObj) {
  const btn = document.createElement("button");
  btn.className = "like-heart-btn";
  btn.dataset.mal = animeObj.mal_id;
  btn.title = isLocalLiked(animeObj.mal_id) ? "Quitar Me gusta" : "Me gusta";
  btn.innerHTML = `<i class="${isLocalLiked(animeObj.mal_id) ? "fas" : "far"} fa-heart"></i>`;
  if (isLocalLiked(animeObj.mal_id)) btn.classList.add("liked");
  btn.addEventListener("click", e => {
    e.stopPropagation();
    toggleLocalLike(animeObj);
  });
  return btn;
}

// Renderiza la sección "Animes que te gustan" en el Home
function renderLocalLikesSection() {
  const section = document.getElementById("localLikesSection");
  const grid    = document.getElementById("localLikesGrid");
  if (!section || !grid) return;

  const likes = getLocalLikes().sort((a, b) => (b.likedAt || 0) - (a.likedAt || 0));
  if (!likes.length) { section.style.display = "none"; return; }
  section.style.display = "block";

  grid.innerHTML = "";
  likes.forEach(f => {
    const card = document.createElement("div");
    card.className = "anime-card";
    card.style.position = "relative";
    card.innerHTML = `
      <div class="anime-poster" style="background-image:url('${f.image}')">
        <span class="anime-type-badge">${f.type || "TV"}</span>
      </div>
      <div class="anime-info">
        <div class="anime-title">${f.title}</div>
        <div class="anime-rating"><i class="fas fa-star"></i> ${f.score || "N/A"}</div>
      </div>
    `;
    const likeBtn = createLikeBtn(f);
    likeBtn.style.cssText = "position:absolute;top:8px;right:8px;z-index:3;";
    card.querySelector(".anime-poster").appendChild(likeBtn);
    card.addEventListener("click", () => verDetallesAnime(f.mal_id));
    grid.appendChild(card);
  });
}

// ─── USUARIO / AUTH (JWT + Railway) ──────────
let currentUser = null;

function loadUser() {
  const raw = localStorage.getItem("animeflix_user");
  if (raw) {
    try { currentUser = JSON.parse(raw); } catch(e) { currentUser = null; }
  }
}

function saveUser() {
  if (currentUser) localStorage.setItem("animeflix_user", JSON.stringify(currentUser));
  else localStorage.removeItem("animeflix_user");
}

// Sincronizar todos los datos del servidor al iniciar sesión
async function syncUserFromServer() {
  if (!localStorage.getItem("rik_jwt")) return;
  try {
    const res = await fetch(`${USERS_URL}/me`, { headers: authHeaders() });
    if (!res.ok) { doLogout(); return; }
    const data = await res.json();
    if (!data.success) return;

    currentUser = {
      ...data.user,
      favorites:  data.favorites  || [],
      following:  data.following  || [],
      history:    data.history    || [],
      playlists:  data.playlists  || [],
    };
    saveUser();
    refreshFavViews();
    renderFollowingToday();
    renderContinueWatching();
    renderPlaylists();
  } catch(e) {
    console.warn("[Auth] Sync falló:", e.message);
  }
}

// Enviar una actualización al servidor sin bloquear la UI
function _pushToServer(method, path, body) {
  if (!localStorage.getItem("rik_jwt")) return;
  fetch(`${USERS_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  }).catch(e => console.warn("[Sync]", e.message));
}

function getFavorites() {
  return currentUser?.favorites || [];
}

function isFavorite(malId) {
  return getFavorites().some(f => f.mal_id == malId);
}

function toggleFavorite(animeObj) {
  if (!currentUser) {
    showToast("Inicia sesión para guardar favoritos", "error");
    return;
  }
  if (!currentUser.favorites) currentUser.favorites = [];
  const idx = currentUser.favorites.findIndex(f => f.mal_id == animeObj.mal_id);
  if (idx > -1) {
    currentUser.favorites.splice(idx, 1);
    showToast(`"${animeObj.title}" eliminado de favoritos`);
    _pushToServer("DELETE", `/favorites/${animeObj.mal_id}`);
  } else {
    const entry = {
      mal_id: animeObj.mal_id,
      title:  animeObj.title,
      image:  animeObj.images?.jpg?.image_url || "",
      score:  animeObj.score,
      type:   animeObj.type,
    };
    currentUser.favorites.push(entry);
    showToast(`"${animeObj.title}" agregado a favoritos ★`);
    _pushToServer("POST", "/favorites", entry);
  }
  saveUser();
  refreshFavViews();
}

function toggleFavoriteFromDetail() {
  if (!animeActualMAL) return;
  toggleFavorite(animeActualMAL);
  updateFavBtn();
}

function toggleDetLike() {
  if (!animeActualMAL) return;
  toggleLocalLike(animeActualMAL);
  updateDetLikeBtn();
}

function updateDetLikeBtn() {
  const btn = document.getElementById("detLikeBtn");
  if (!btn || !animeActualMAL) return;
  const liked = isLocalLiked(animeActualMAL.mal_id);
  btn.innerHTML = liked
    ? '<i class="fas fa-heart"></i> Te gusta'
    : '<i class="far fa-heart"></i> Me gusta';
  btn.classList.toggle("det-like-active", liked);
}

function updateFavBtn() {
  const btn = document.getElementById("detFavBtn");
  if (!btn || !animeActualMAL) return;
  const fav = isFavorite(animeActualMAL.mal_id);
  btn.innerHTML = fav
    ? '<i class="fas fa-heart"></i> En Favoritos'
    : '<i class="far fa-heart"></i> Agregar a Favoritos';
  btn.style.background = fav ? "var(--danger)" : "";
}

function refreshFavViews() {
  renderFavGrid(document.getElementById("favGrid"));
  renderFavGrid(document.getElementById("modalFavGrid"));
  const profileCount = document.getElementById("profileFavCount");
  if (profileCount) profileCount.textContent = `${getFavorites().length} favoritos guardados`;
}

function renderFavGrid(container) {
  if (!container) return;
  const favs = getFavorites();
  if (favs.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      <i class="far fa-star"></i><p>No tienes favoritos aún.</p>
    </div>`;
    return;
  }
  container.innerHTML = favs.map(f => `
    <div class="fav-item" onclick="verDetallesAnime(${f.mal_id})">
      <img src="${f.image}" alt="${f.title}" loading="lazy" />
      <button class="fav-remove" onclick="event.stopPropagation();removeFav(${f.mal_id})" title="Eliminar">
        <i class="fas fa-times"></i>
      </button>
      <div class="fav-title">${f.title}</div>
    </div>
  `).join("");
}

function removeFav(malId) {
  if (!currentUser?.favorites) return;
  currentUser.favorites = currentUser.favorites.filter(f => f.mal_id != malId);
  saveUser();
  refreshFavViews();
}

// ─── SIGUIENDO (Following) ────────────────────
function getFollowing() {
  return currentUser?.following || [];
}

function isFollowing(malId) {
  return getFollowing().some(f => f.mal_id == malId);
}

function toggleFollowing(animeObj) {
  if (!currentUser) {
    showToast("Inicia sesión para seguir animes", "error");
    return;
  }
  if (!currentUser.following) currentUser.following = [];
  const idx = currentUser.following.findIndex(f => f.mal_id == animeObj.mal_id);
  if (idx > -1) {
    currentUser.following.splice(idx, 1);
    showToast(`Dejaste de seguir "${animeObj.title}"`);
    _pushToServer("DELETE", `/following/${animeObj.mal_id}`);
  } else {
    const entry = {
      mal_id:    animeObj.mal_id,
      title:     animeObj.title,
      image:     animeObj.images?.jpg?.image_url || "",
      broadcast: animeObj.broadcast || {},
      episodes:  animeObj.episodes || 0,
    };
    currentUser.following.push(entry);
    showToast(`Siguiendo "${animeObj.title}" 🔔`);
    _pushToServer("POST", "/following", entry);
  }
  saveUser();
  updateFollowBtn();
  renderFollowingToday();
}

function toggleFollowingFromDetail() {
  if (!animeActualMAL) return;
  toggleFollowing(animeActualMAL);
}

function updateFollowBtn() {
  const btn = document.getElementById("detFollowBtn");
  if (!btn || !animeActualMAL) return;
  const following = isFollowing(animeActualMAL.mal_id);
  btn.innerHTML = following
    ? '<i class="fas fa-bell-slash"></i> Dejar de seguir'
    : '<i class="fas fa-bell"></i> Seguir';
  btn.style.background = following ? "var(--warning)" : "";
  btn.style.color      = following ? "#0a0a18" : "";
}

// ─── SIGUIENDO HOY (Following Today Section) ──
const JIKAN_DAY_MAP = {
  mondays:    1, tuesdays: 2, wednesdays: 3,
  thursdays:  4, fridays:  5, saturdays:  6, sundays: 0,
};

function renderFollowingToday() {
  const container = document.getElementById("followingTodayGrid");
  if (!container) return;

  const following = getFollowing();
  const section   = document.getElementById("followingTodaySection");

  if (!following.length) {
    if (section) section.style.display = "none";
    return;
  }

  const todayJS = new Date().getDay(); // 0=Dom ... 6=Sab
  const todayAnimes = following.filter(f => {
    if (!f.broadcast?.day) return false;
    const dayKey = f.broadcast.day.trim().toLowerCase();
    return JIKAN_DAY_MAP[dayKey] === todayJS;
  });

  if (!todayAnimes.length) {
    if (section) section.style.display = "none";
    return;
  }
  if (section) section.style.display = "block";

  container.innerHTML = todayAnimes.map(f => {
    const epApprox = f.episodes > 0 ? `Episodio ~${f.episodes}` : "Nuevo episodio";
    return `
      <div class="anime-card" onclick="verDetallesAnime(${f.mal_id})" style="cursor:pointer;">
        <div class="anime-poster" style="background-image:url('${f.image}')">
          <span class="anime-type-badge" style="background:rgba(243,195,86,0.9);color:#0a0a18;">
            <i class="fas fa-broadcast-tower"></i> HOY
          </span>
        </div>
        <div class="anime-info">
          <div class="anime-title">${f.title}</div>
          <div class="anime-rating" style="color:var(--accent);">
            <i class="fas fa-calendar-check"></i> ${epApprox}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// ─── HISTORIAL / CONTINUAR VIENDO ─────────────
function saveHistory(malId, epNumber, currentTime) {
  // Guardar localmente siempre (con o sin cuenta)
  saveLocalHistoryEntry(malId, epNumber, currentTime);
  if (!currentUser) return;
  if (!currentUser.history) currentUser.history = [];
  const key = `${malId}_${epNumber}`;
  const existing = currentUser.history.findIndex(h => h.key === key);
  const entry = { key, mal_id: malId, episode: epNumber, time: currentTime, updatedAt: Date.now() };
  if (existing > -1) currentUser.history[existing] = entry;
  else currentUser.history.push(entry);
  saveUser();
  // Sync silencioso al servidor cada 10s de progreso real
  _pushToServer("PUT", "/history", { mal_id: malId, episode: epNumber, time_sec: currentTime });
}

function getHistoryEntry(malId, epNumber) {
  if (!currentUser?.history) return null;
  return currentUser.history.find(h => h.key === `${malId}_${epNumber}`) || null;
}

// ─── ABRIR EPISODIO DIRECTO DESDE "CONTINUAR VIENDO" ─────────
async function abrirContinuarViendo(malId, epNumber) {
  if (!animeActualMAL || animeActualMAL.mal_id != malId) {
    await verDetallesAnime(malId);
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  const epList = animeActualBackend?.episodes ||
                 animeActualBackend?.list ||
                 animeActualBackend?.episodeList || [];

  const epObj = epList.find(e => (e.number || e.episode || e.id) == epNumber);

  if (epObj) {
    procesarStreamingEpisodio(epObj);
  } else {
    const baseUrl = animeActualBackend?.url || "";
    procesarStreamingEpisodio({
      number: epNumber,
      url: baseUrl
        ? (baseUrl.endsWith("/") ? `${baseUrl}${epNumber}` : `${baseUrl}-${epNumber}`)
        : `https://mock-provider.com/episode-${epNumber}`,
    });
  }
}

function renderContinueWatching() {
  const container = document.getElementById("continueWatchingGrid");
  if (!container) return;
  const section = document.getElementById("continueWatchingSection");
  const history = currentUser?.history || [];
  if (!history.length) {
    if (section) section.style.display = "none";
    return;
  }
  if (section) section.style.display = "block";

  const sorted = [...history].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8);
  container.innerHTML = sorted.map(h => {
    const anime = localAnimeData.find(a => a.mal_id == h.mal_id);
    const img   = anime?.images?.jpg?.image_url || "";
    const title = anime?.title || `Anime ${h.mal_id}`;
    const pct   = h.time > 0 ? Math.min(100, Math.round((h.time / 1440) * 100)) : 0;
    const timeStr = h.time > 0 ? `${Math.floor(h.time / 60)}m ${Math.floor(h.time % 60)}s` : "Sin progreso";
    return `
      <div class="cw-card" onclick="abrirContinuarViendo(${h.mal_id}, ${h.episode})">
        <div class="cw-thumb" style="background-image:url('${img}')">
          <div class="cw-play-overlay"><i class="fas fa-play"></i></div>
          <span class="cw-ep-badge">EP. ${h.episode}</span>
        </div>
        <div class="cw-info">
          <div class="cw-title">${title}</div>
          <div class="cw-time"><i class="fas fa-clock"></i> ${timeStr}</div>
          <div class="cw-progress-bar">
            <div class="cw-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// ─── [NUEVO] CONTROL DE SECCIONES HOME ────────
// Centraliza la lógica de mostrar/ocultar secciones según estado de búsqueda.
// Llamar con "active" al iniciar búsqueda, "idle" al limpiarla.
function setSearchState(state) {
  searchState = state;
  const searching = state === "active";

  HOME_SECTIONS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = searching ? "none" : "";
  });

  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.style.display = searching ? "none" : "";
  });

  if (!searching) {
    // Restaurar catálogo y título normales al salir de búsqueda
    const titleEl = document.getElementById("catalogTitle");
    if (titleEl) {
      titleEl.textContent = currentFilter === "movie"
        ? "Películas, OVAs y Especiales"
        : "Animes Más Populares";
    }
    renderGrid(filteredAnimeData);
    renderFollowingToday();
    renderContinueWatching();
    renderLocalLikesSection();
  }
}

// ─── ENRUTAMIENTO DINÁMICO POR URL ────────────

// [NUEVO] Genera un slug legible desde el título del anime
function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// [MODIFICADO] Ahora incluye slug legible en la URL además del anime_id numérico
function pushUrl(animeId, epNumber) {
  const params = new URLSearchParams();
  if (animeId != null) {
    params.set("anime_id", animeId);
    // Agregar slug si el anime está disponible en memoria
    const anime = localAnimeData.find(a => a.mal_id == animeId);
    if (anime?.title) params.set("slug", slugify(anime.title));
  }
  if (epNumber != null) params.set("ep", epNumber);
  const newUrl = params.toString() ? `${location.pathname}?${params}` : location.pathname;
  history.pushState({ animeId, epNumber }, "", newUrl);
}

function clearUrl() {
  history.pushState({}, "", location.pathname);
}

// [NUEVO] Fallback de deep linking: obtiene un anime por ID directamente desde Jikan
// cuando NO está en el catálogo local (p. ej. URL compartida de búsqueda)
async function fetchAnimeById(malId) {
  try {
    const res  = await fetch(`${JIKAN}/anime/${malId}`);
    const data = await res.json();
    if (data.data) {
      // Registrar en catálogo local para que el resto de la app pueda usarlo
      if (!localAnimeData.find(a => a.mal_id == data.data.mal_id)) {
        localAnimeData.push(data.data);
      }
      return data.data;
    }
  } catch(e) {
    console.warn("[fetchAnimeById] Error:", e.message);
  }
  return null;
}

// ─── TOAST ────────────────────────────────────
function showToast(msg, type = "ok") {
  const t = document.getElementById("toastMsg");
  t.textContent = msg;
  t.className = `toast${type === "error" ? " error" : ""}`;
  setTimeout(() => t.classList.add("show"), 10);
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove("show"), 3200);
}

// ─── SISTEMA DE PLAYLISTS ─────────────────────────────────────

const PLAYLISTS_KEY = "animeflix_playlists";

// Retorna el mapa de playlists desde localStorage { name: [animeObj, ...] }
function getPlaylists() {
  try {
    return JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || "{}");
  } catch(e) { return {}; }
}

function savePlaylists(playlists) {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
}

// Crea una playlist nueva si no existe. Retorna true si fue creada.
function createNewPlaylist(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const playlists = getPlaylists();
  if (playlists[trimmed]) return false; // ya existe
  playlists[trimmed] = [];
  savePlaylists(playlists);
  return true;
}

// Añade o elimina el anime actual de la playlist indicada.
function toggleAnimeInPlaylist(playlistName) {
  if (!animeActualMAL) return;
  const playlists = getPlaylists();
  if (!playlists[playlistName]) playlists[playlistName] = [];
  const list = playlists[playlistName];
  const idx  = list.findIndex(a => a.mal_id == animeActualMAL.mal_id);
  if (idx > -1) {
    list.splice(idx, 1);
    savePlaylists(playlists);
    showToast(`"${animeActualMAL.title}" eliminado de ${playlistName}`);
  } else {
    list.push({
      mal_id:  animeActualMAL.mal_id,
      title:   animeActualMAL.title,
      image:   animeActualMAL.images?.jpg?.image_url || "",
      score:   animeActualMAL.score,
      type:    animeActualMAL.type,
      addedAt: Date.now(),
    });
    savePlaylists(playlists);
    showToast(`"${animeActualMAL.title}" agregado a ${playlistName} ✓`);
  }
  // Refrescar checkboxes si el dropdown está abierto
  _renderPlaylistDropdownItems();
}

// Comprueba si el anime actual ya está en la playlist dada
function animeEnPlaylist(playlistName) {
  if (!animeActualMAL) return false;
  const playlists = getPlaylists();
  return (playlists[playlistName] || []).some(a => a.mal_id == animeActualMAL.mal_id);
}

// ─── DROPDOWN DE PLAYLIST ─────────────────────

let _playlistDropdownOpen = false;

function agregarAPlaylist() {
  if (!currentUser) {
    showToast("Inicia sesión para usar playlists", "error");
    return;
  }
  if (!animeActualMAL) return;

  const existing = document.getElementById("playlistDropdown");
  if (existing) { _cerrarPlaylistDropdown(); return; }

  // Asegurar playlists por defecto si el usuario nunca ha creado ninguna
  const playlists = getPlaylists();
  let changed = false;
  ["Ver más tarde", "Mis favoritos", "Completados"].forEach(def => {
    if (!playlists[def]) { playlists[def] = []; changed = true; }
  });
  if (changed) savePlaylists(playlists);

  // Crear dropdown
  const btn = document.querySelector(".player-action-btn[onclick='agregarAPlaylist()']")
           || document.querySelector("#playlistAnchor");

  const dropdown = document.createElement("div");
  dropdown.id = "playlistDropdown";
  dropdown.className = "playlist-dropdown";
  dropdown.setAttribute("role", "dialog");
  dropdown.setAttribute("aria-label", "Gestionar playlists");

  dropdown.innerHTML = `
    <div class="pd-header">
      <i class="fas fa-list-ul"></i>
      <span>Mis Playlists</span>
      <button class="pd-close" onclick="_cerrarPlaylistDropdown()" aria-label="Cerrar">
        <i class="fas fa-times"></i>
      </button>
    </div>
    <div class="pd-list" id="pdList"></div>
    <div class="pd-create">
      <input
        type="text"
        id="pdNewName"
        class="pd-input"
        placeholder="Nueva playlist..."
        maxlength="40"
        autocomplete="off"
      />
      <button class="pd-add-btn" onclick="_crearPlaylistDesdeInput()" aria-label="Crear">
        <i class="fas fa-plus"></i>
      </button>
    </div>
  `;

  // Posicionar relativo al botón o al meta block
  const anchor = btn?.closest(".player-actions") || document.getElementById("playerView");
  if (anchor) {
    anchor.style.position = "relative";
    anchor.appendChild(dropdown);
  } else {
    document.body.appendChild(dropdown);
  }

  _renderPlaylistDropdownItems();
  _playlistDropdownOpen = true;

  // Cerrar al hacer clic fuera
  setTimeout(() => {
    document.addEventListener("click", _outsidePlaylistClick, { capture: true });
  }, 10);

  // Enfocar input
  const input = document.getElementById("pdNewName");
  if (input) {
    setTimeout(() => input.focus(), 50);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") _crearPlaylistDesdeInput();
      if (e.key === "Escape") _cerrarPlaylistDropdown();
    });
  }
}

function _renderPlaylistDropdownItems() {
  const list = document.getElementById("pdList");
  if (!list) return;
  const playlists = getPlaylists();
  const names = Object.keys(playlists);

  if (!names.length) {
    list.innerHTML = `<div class="pd-empty">No tienes playlists aún.</div>`;
    return;
  }

  list.innerHTML = names.map(name => {
    const inList = animeEnPlaylist(name);
    const count  = playlists[name].length;
    return `
      <div class="pd-item ${inList ? "pd-item--active" : ""}" onclick="toggleAnimeInPlaylist('${name.replace(/'/g, "\\'")}')">
        <span class="pd-check">
          ${inList
            ? `<i class="fas fa-check-circle" style="color:var(--accent)"></i>`
            : `<i class="far fa-circle" style="color:var(--text-muted)"></i>`}
        </span>
        <span class="pd-name">${name}</span>
        <span class="pd-count">${count} anime${count !== 1 ? "s" : ""}</span>
      </div>
    `;
  }).join("");
}

function _crearPlaylistDesdeInput() {
  const input = document.getElementById("pdNewName");
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast("Escribe un nombre para la playlist", "error"); return; }
  const created = createNewPlaylist(name);
  if (!created) { showToast(`"${name}" ya existe`, "error"); return; }
  input.value = "";
  showToast(`Playlist "${name}" creada ✓`);
  _renderPlaylistDropdownItems();
}

function _cerrarPlaylistDropdown() {
  const dd = document.getElementById("playlistDropdown");
  if (dd) dd.remove();
  _playlistDropdownOpen = false;
  document.removeEventListener("click", _outsidePlaylistClick, { capture: true });
}

function _outsidePlaylistClick(e) {
  const dd = document.getElementById("playlistDropdown");
  if (dd && !dd.contains(e.target)) {
    const btn = document.querySelector(".player-action-btn[onclick='agregarAPlaylist()']");
    if (btn && btn.contains(e.target)) return; // el propio botón lo cierra con el toggle
    _cerrarPlaylistDropdown();
  }
}

// ─── VISTA PLAYLISTS ──────────────────────────

let _plvActiveList = null; // nombre de la playlist abierta actualmente

function loadPlaylistsView() {
  mostrarVista("playlistsView");
  _plvActiveList = null;
  _plvMostrarIndice();
  renderPlaylists();
}

// Renderiza la cuadrícula de carpetas/tarjetas de playlists
function renderPlaylists() {
  const grid = document.getElementById("plvGrid");
  if (!grid) return;

  const playlists = getPlaylists();
  const names = Object.keys(playlists);

  if (!names.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <i class="fas fa-list-ul"></i>
        <p>Aún no tienes playlists.<br>Crea una desde el reproductor o con el botón de arriba.</p>
      </div>`;
    return;
  }

  // Paleta de colores para las carpetas
  const FOLDER_COLORS = [
    "var(--accent)", "#7c6af7", "#f77c6a", "#f7c26a",
    "#6af7c2", "#6aa8f7", "#f76ab4", "#a8f76a",
  ];

  grid.innerHTML = names.map((name, i) => {
    const count  = playlists[name].length;
    const color  = FOLDER_COLORS[i % FOLDER_COLORS.length];
    // Hasta 4 thumbnails de preview
    const thumbs = playlists[name].slice(0, 4).map(a =>
      a.image ? `<div class="plv-folder-thumb" style="background-image:url('${a.image}')"></div>` : ""
    ).join("");

    return `
      <div class="plv-folder-card" onclick="_plvAbrirLista('${name.replace(/'/g, "\\'")}')">
        <div class="plv-folder-preview" style="--folder-color:${color}">
          ${thumbs || `<i class="fas fa-list-ul" style="font-size:2rem;color:${color};opacity:0.4;"></i>`}
          <div class="plv-folder-count-badge">${count}</div>
        </div>
        <div class="plv-folder-info">
          <div class="plv-folder-name" title="${name}">${name}</div>
          <div class="plv-folder-meta">${count} anime${count !== 1 ? "s" : ""}</div>
        </div>
        <button class="plv-folder-del" title="Eliminar playlist"
          onclick="event.stopPropagation(); _plvEliminarPlaylist('${name.replace(/'/g, "\\'")}')">
          <i class="fas fa-trash-alt"></i>
        </button>
      </div>
    `;
  }).join("");
}

// Abre la sub-vista de detalle de una playlist
function _plvAbrirLista(name) {
  _plvActiveList = name;
  const playlists = getPlaylists();
  const list      = playlists[name] || [];

  document.getElementById("plv-index").style.display  = "none";
  document.getElementById("plv-detail").style.display = "block";
  document.getElementById("plvDetailTitle").textContent = name;
  document.getElementById("plvDetailCount").textContent = `${list.length} anime${list.length !== 1 ? "s" : ""}`;

  _renderPlvDetailGrid(name);
}

function _renderPlvDetailGrid(name) {
  const grid = document.getElementById("plvDetailGrid");
  if (!grid) return;
  const playlists = getPlaylists();
  const list      = playlists[name] || [];

  if (!list.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <i class="far fa-folder-open"></i>
        <p>Esta playlist está vacía.<br>Añade animes desde el reproductor.</p>
      </div>`;
    return;
  }

  grid.innerHTML = list.map(a => `
    <div class="anime-card" style="position:relative;" onclick="verDetallesAnime(${a.mal_id})">
      <div class="anime-poster" style="background-image:url('${a.image}')">
        <span class="anime-type-badge">${a.type || "TV"}</span>
      </div>
      <div class="anime-info">
        <div class="anime-title">${a.title}</div>
        <div class="anime-rating"><i class="fas fa-star"></i> ${a.score || "N/A"}</div>
      </div>
      <button class="plv-remove-btn" title="Quitar de la playlist"
        onclick="event.stopPropagation(); _plvQuitarAnime('${name.replace(/'/g, "\\'")}', ${a.mal_id})">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `).join("");
}

function _plvQuitarAnime(playlistName, malId) {
  const playlists = getPlaylists();
  if (!playlists[playlistName]) return;
  playlists[playlistName] = playlists[playlistName].filter(a => a.mal_id != malId);
  savePlaylists(playlists);
  showToast("Anime eliminado de la playlist");
  // refrescar el grid de detalle en caliente
  _renderPlvDetailGrid(playlistName);
  document.getElementById("plvDetailCount").textContent =
    `${playlists[playlistName].length} anime${playlists[playlistName].length !== 1 ? "s" : ""}`;
  // si la playlist quedó vacía, mostrar empty state
  if (!playlists[playlistName].length) _renderPlvDetailGrid(playlistName);
  // refrescar el dropdown si está abierto
  _renderPlaylistDropdownItems();
}

function _plvEliminarPlaylist(name) {
  const playlists = getPlaylists();
  delete playlists[name];
  savePlaylists(playlists);
  showToast(`Playlist "${name}" eliminada`);
  renderPlaylists();
  _renderPlaylistDropdownItems();
}

function _plvMostrarIndice() {
  const idx = document.getElementById("plv-index");
  const det = document.getElementById("plv-detail");
  if (idx) idx.style.display = "block";
  if (det) det.style.display = "none";
  _plvActiveList = null;
}

function _plvCrear() {
  const input = document.getElementById("plvNewName");
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast("Escribe un nombre para la playlist", "error"); return; }
  const created = createNewPlaylist(name);
  if (!created) { showToast(`"${name}" ya existe`, "error"); return; }
  input.value = "";
  _plvCerrarForm();
  showToast(`Playlist "${name}" creada ✓`);
  renderPlaylists();
  _renderPlaylistDropdownItems();
}

function _plvCerrarForm() {
  const form = document.getElementById("plvCreateForm");
  if (form) form.style.display = "none";
}

// ─── SETTINGS ────────────────────────────────
function loadSettings() {
  const s = JSON.parse(localStorage.getItem("animeflix_settings") || "{}");
  if (s.theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    document.getElementById("themeToggle").checked = true;
  }
  if (s.defaultLang) {
    idiomaActual = s.defaultLang;
    document.getElementById("defaultLangSelect").value = s.defaultLang;
  }
  if (s.preferredServer !== undefined) {
    document.getElementById("preferredServerSelect").value = s.preferredServer;
  }
}

function saveSettings() {
  const s = {
    theme:           document.documentElement.getAttribute("data-theme"),
    defaultLang:     document.getElementById("defaultLangSelect").value,
    preferredServer: document.getElementById("preferredServerSelect").value,
  };
  localStorage.setItem("animeflix_settings", JSON.stringify(s));
}

// ─── AUTH MODAL TABS ──────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll("#authSection .account-tab-btn").forEach((b, i) => {
    b.classList.toggle("active", (i === 0 && tab === "login") || (i === 1 && tab === "register"));
  });
  document.getElementById("panelLogin").classList.toggle("active", tab === "login");
  document.getElementById("panelRegister").classList.toggle("active", tab === "register");
}

function switchUserTab(tab) {
  document.querySelectorAll("#userSection .account-tab-btn").forEach((b, i) => {
    b.classList.toggle("active", (i === 0 && tab === "favs") || (i === 1 && tab === "profile"));
  });
  document.getElementById("panelFavs").classList.toggle("active", tab === "favs");
  document.getElementById("panelProfile").classList.toggle("active", tab === "profile");
}

async function doLogin() {
  const emailEl = document.getElementById("loginUser");
  const passEl  = document.getElementById("loginPass");
  const email   = emailEl?.value.trim();
  const pass    = passEl?.value;

  if (!email || !pass) { showToast("Completa todos los campos", "error"); return; }

  const btn = document.querySelector("#panelLogin .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Entrando..."; }

  try {
    const res  = await fetch(`${USERS_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Error al iniciar sesión");

    localStorage.setItem("rik_jwt", data.token);
    currentUser = { ...data.user, favorites: [], following: [], history: [], playlists: [] };
    saveUser();
    await syncUserFromServer();
    openUserSection();
    showToast(`¡Bienvenido de nuevo, ${currentUser.username}!`);
  } catch(err) {
    showToast(err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Iniciar Sesión"; }
  }
}

async function doRegister() {
  const userEl  = document.getElementById("regUser");
  const emailEl = document.getElementById("regEmail");
  const passEl  = document.getElementById("regPass");

  const username = userEl?.value.trim();
  const email    = emailEl?.value.trim();
  const pass     = passEl?.value;

  if (!username || !email || !pass) { showToast("Completa todos los campos", "error"); return; }
  if (pass.length < 6) { showToast("Contraseña mínimo 6 caracteres", "error"); return; }

  const btn = document.querySelector("#panelRegister .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Creando cuenta..."; }

  try {
    const res  = await fetch(`${USERS_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, username, password: pass }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Error al registrarse");

    localStorage.setItem("rik_jwt", data.token);
    currentUser = { ...data.user, favorites: [], following: [], history: [], playlists: [] };
    saveUser();
    openUserSection();
    showToast(`¡Cuenta creada! Bienvenido, ${username} 🎉`);
  } catch(err) {
    showToast(err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Crear Cuenta"; }
  }
}

function doLogout() {
  localStorage.removeItem("rik_jwt");
  currentUser = null;
  saveUser();
  document.getElementById("userSection").style.display  = "none";
  document.getElementById("authSection").style.display  = "block";
  showToast("Sesión cerrada");
  renderContinueWatching();
  renderFollowingToday();
}

function openUserSection() {
  document.getElementById("authSection").style.display = "none";
  document.getElementById("userSection").style.display = "block";
  document.getElementById("profileUsername").textContent = currentUser.username;
  refreshFavViews();
  document.getElementById("profileFavCount").textContent = `${getFavorites().length} favoritos guardados`;
}

// ─── VISTAS ───────────────────────────────────
const VIEWS = ["homeView", "detailsView", "airingView", "calendarView", "favoritesView", "playlistsView", "playerView", "directoryView"];

function mostrarVista(vista) {
  // ── FIX: Detener audio/video al abandonar playerView por CUALQUIER vía ──
  if (vista !== "playerView") {
    const iframe = document.getElementById("videoPlayer");
    const native = document.getElementById("videoPlayerNative");
    if (iframe && iframe.src) { iframe.src = ""; iframe.style.display = "none"; }
    if (native && native.src) { native.src = ""; native.style.display = "none"; }
  }

  VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (id === vista) ? (id === "playerView" ? "flex" : "block") : "none";
  });
  document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
  if (vista === "homeView")       document.getElementById("sideHome")?.classList.add("active");
  if (vista === "airingView")     document.getElementById("sideAiring")?.classList.add("active");
  if (vista === "calendarView")   document.getElementById("sideCalendar")?.classList.add("active");
  if (vista === "favoritesView")  document.getElementById("sideFavorites")?.classList.add("active");
  if (vista === "playlistsView")  document.getElementById("sidePlaylists")?.classList.add("active");
  if (vista === "directoryView")  document.getElementById("sideDirectory")?.classList.add("active");

  if (vista === "detailsView") {
    document.getElementById("detailsContainer").style.display = "flex";
  }

  // Ocultar sidebar derecho cuando se está en el reproductor
  const sidebarRight = document.getElementById("sidebarRight");
  if (sidebarRight) {
    sidebarRight.style.display = (vista === "playerView") ? "none" : "";
  }
  // Cerrar dropdown de playlist si está abierto
  _cerrarPlaylistDropdown();
}

// ─── HERO BANNER ──────────────────────────────
function buildHero() {
  // Si loadAnime ya asignó heroAnimes, usarlos; si no, tomar los primeros 6 del catálogo
  if (!heroAnimes.length) {
    heroAnimes = localAnimeData.slice(0, 6).filter(a => a.images?.jpg?.large_image_url);
  }
  if (!heroAnimes.length) return;

  const banner = document.getElementById("heroBanner");
  const dotsEl = document.getElementById("heroDots");

  heroAnimes.forEach((anime, i) => {
    const slide = document.createElement("div");
    slide.className = `hero-slide${i === 0 ? " active" : ""}`;
    slide.style.backgroundImage = `url('${anime.images.jpg.large_image_url || anime.images.jpg.image_url}')`;
    banner.insertBefore(slide, banner.querySelector(".hero-overlay"));
  });

  heroAnimes.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = `hero-dot${i === 0 ? " active" : ""}`;
    dot.addEventListener("click", () => goToHeroSlide(i));
    dotsEl.appendChild(dot);
  });

  // ── Mover flechas dentro del banner ──
  const arrowL = document.getElementById("heroArrowLeft");
  const arrowR = document.getElementById("heroArrowRight");
  if (arrowL) banner.appendChild(arrowL);
  if (arrowR) banner.appendChild(arrowR);

  // ── Swipe táctil ──
  let _txStart = 0;
  banner.addEventListener("touchstart", e => { _txStart = e.touches[0].clientX; }, { passive: true });
  banner.addEventListener("touchend", e => {
    const diff = _txStart - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 40) goToHeroSlide(heroIndex + (diff > 0 ? 1 : -1));
  }, { passive: true });

  updateHeroContent(0);
  startHeroTimer();
  buildGenreFilter();
}

function goToHeroSlide(idx) {
  const slides = document.querySelectorAll(".hero-slide");
  const dots   = document.querySelectorAll(".hero-dot");
  slides[heroIndex]?.classList.remove("active");
  dots[heroIndex]?.classList.remove("active");
  heroIndex = (idx + heroAnimes.length) % heroAnimes.length;
  slides[heroIndex]?.classList.add("active");
  dots[heroIndex]?.classList.add("active");
  updateHeroContent(heroIndex);
  restartHeroTimer();
}

function updateHeroContent(idx) {
  const anime = heroAnimes[idx];
  if (!anime) return;
  document.getElementById("heroTitle").textContent   = anime.title || "";
  document.getElementById("heroSubtitle").textContent = anime.title_english && anime.title_english !== anime.title
    ? anime.title_english : (anime.title_japanese || "");
  document.getElementById("heroDesc").textContent    = (anime.synopsis || "").slice(0, 220) + "...";
  document.getElementById("heroRating").innerHTML    = anime.score ? `<i class="fas fa-star"></i> ${anime.score}` : "";
  document.getElementById("heroEps").textContent     = anime.episodes ? `${anime.episodes} eps` : "";
  document.getElementById("heroType").textContent    = anime.type || "";
  document.getElementById("heroBadge").textContent   = anime.status === "Currently Airing" ? "EN EMISIÓN" : "TOP ANIME";
}

function startHeroTimer() {
  heroTimer = setInterval(() => goToHeroSlide(heroIndex + 1), 7000);
}
function restartHeroTimer() {
  clearInterval(heroTimer);
  startHeroTimer();
}

// ─── FILTRO DE SEGURIDAD ───────────────────────
function esContenidoAdulto(anime) {
  if (anime.rating === "Rx - Hentai") return true;
  if (Array.isArray(anime.genres)) {
    return anime.genres.some(g => g.mal_id === 12 || g.name === "Hentai");
  }
  return false;
}

// ─── CATÁLOGO ─────────────────────────────────

// Fuentes rotativas para el catálogo y el hero
const HERO_SOURCES = [
  `${JIKAN}/top/anime?limit=25&filter=airing`,
  `${JIKAN}/top/anime?limit=25&filter=bypopularity`,
  `${JIKAN}/top/anime?limit=25&filter=favorite`,
  `${JIKAN}/seasons/now?limit=25`,
  `${JIKAN}/top/anime?limit=25&page=2`,
  `${JIKAN}/top/anime?limit=25&page=3`,
];

function _heroSourceIndex() {
  // Rota la fuente cada día distinto + aleatorio por sesión
  const dayKey = new Date().toISOString().slice(0, 10); // "2025-06-01"
  const stored = sessionStorage.getItem("rik_hero_src");
  if (stored) return parseInt(stored);
  const idx = (new Date().getDate() + Math.floor(Math.random() * HERO_SOURCES.length)) % HERO_SOURCES.length;
  sessionStorage.setItem("rik_hero_src", idx);
  return idx;
}

async function loadAnime() {
  try {
    // Fuente principal del catálogo (siempre top para el grid)
    const resMain = await fetch(`${JIKAN}/top/anime?limit=24`);
    const dataMain = await resMain.json();
    localAnimeData    = (dataMain.data || []).filter(a => !esContenidoAdulto(a));
    filteredAnimeData = localAnimeData;
    renderGrid(filteredAnimeData);

    // Fuente del hero: diferente cada sesión/día
    const heroIdx = _heroSourceIndex();
    const resHero = await fetch(HERO_SOURCES[heroIdx]);
    const dataHero = await resHero.json();
    const heroPool = (dataHero.data || []).filter(a =>
      !esContenidoAdulto(a) && a.images?.jpg?.large_image_url
    );

    // Mezclar el pool aleatoriamente y tomar 6
    for (let i = heroPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [heroPool[i], heroPool[j]] = [heroPool[j], heroPool[i]];
    }

    // Agregar al localAnimeData sin duplicados
    heroPool.forEach(a => {
      if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a);
    });

    // Sobreescribir heroAnimes con el pool rotativo
    heroAnimes = heroPool.slice(0, 6);

    buildHero();
    loadSidebarAiring();
    renderFollowingToday();
    renderContinueWatching();
  } catch (err) {
    console.error("Error cargando catalogo:", err);
    document.getElementById("animeGrid").innerHTML =
      `<p style="color:var(--text-muted);grid-column:1/-1;"><i class="fas fa-exclamation-triangle"></i> No se pudo cargar el catalogo.</p>`;
  }
}

function renderGrid(animes) {
  const grid = document.getElementById("animeGrid");
  grid.innerHTML = "";

  const seguros = animes.filter(a => !esContenidoAdulto(a));

  const count = document.getElementById("catalogCount");
  if (count) count.textContent = `${seguros.length} títulos`;

  if (!seguros.length) {
    grid.innerHTML = `<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:2rem;">
      <i class="fas fa-search"></i> No se encontraron resultados.
    </p>`;
    return;
  }

  seguros.forEach(anime => {
    const genres = anime.genres ? anime.genres.map(g => g.name).join(", ") : "";
    const card = document.createElement("div");
    card.className = "anime-card";
    card.style.position = "relative";
    card.innerHTML = `
      <div class="anime-poster" style="background-image:url('${anime.images.jpg.image_url}')">
        <span class="anime-type-badge">${anime.type || "TV"}</span>
      </div>
      <div class="anime-info">
        <div class="anime-title">${anime.title}</div>
        <div class="anime-rating"><i class="fas fa-star"></i> ${anime.score || "N/A"}</div>
        <div class="anime-genres">${genres}</div>
      </div>
    `;
    const likeBtn = createLikeBtn(anime);
    card.querySelector(".anime-poster").appendChild(likeBtn);
    card.addEventListener("click", () => verDetallesAnime(anime.mal_id));
    grid.appendChild(card);
  });
}
  

// ─── FILTROS TV / MOVIE ────────────────────────
function applyFilter(filterType) {
  currentFilter = filterType;

  document.querySelectorAll(".nav-tab").forEach(t => {
    t.classList.toggle("active", t.getAttribute("data-filter") === filterType);
  });

  const titleEl = document.getElementById("catalogTitle");

  if (filterType === "movie") {
    filteredAnimeData = localAnimeData.filter(a =>
      ["Movie","OVA","ONA","Special","Music"].includes(a.type) && !esContenidoAdulto(a)
    );
    if (titleEl) titleEl.textContent = "Películas, OVAs y Especiales";
  } else {
    filteredAnimeData = localAnimeData.filter(a =>
      (!["Movie"].includes(a.type) || !a.type) && !esContenidoAdulto(a)
    );
    if (titleEl) titleEl.textContent = "Animes Más Populares";
  }

  mostrarVista("homeView");
  renderGrid(filteredAnimeData);
}

// ─── EN EMISIÓN ───────────────────────────────
let airingDataCache = null;

async function loadAiringView() {
  mostrarVista("airingView");
  if (airingDataCache) { renderAiringGrid(airingDataCache); return; }

  document.getElementById("airingStatus").textContent = "Cargando desde Jikan...";
  document.getElementById("airingGrid").innerHTML = `<p style="color:var(--accent);grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> Conectando con MyAnimeList...</p>`;

  try {
    const res  = await fetch(`${JIKAN}/seasons/now?limit=24`);
    const data = await res.json();
    airingDataCache = data.data || [];
    renderAiringGrid(airingDataCache);
    document.getElementById("airingStatus").innerHTML =
      `<i class="fas fa-check-circle" style="color:var(--accent)"></i> ${airingDataCache.length} series`;
  } catch(e) {
    document.getElementById("airingStatus").innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error`;
    document.getElementById("airingGrid").innerHTML = `<p style="color:var(--text-muted);grid-column:1/-1;">Error al cargar.</p>`;
  }
}

function renderAiringGrid(animes) {
  const grid = document.getElementById("airingGrid");
  grid.innerHTML = "";
  animes.forEach(anime => {
    const card = document.createElement("div");
    card.className = "anime-card";
    card.innerHTML = `
      <div class="anime-poster" style="background-image:url('${anime.images.jpg.image_url}')">
        <span class="anime-type-badge" style="background:rgba(243,195,86,0.85);color:#0a0a18;">AIRING</span>
      </div>
      <div class="anime-info">
        <div class="anime-title">${anime.title}</div>
        <div class="anime-rating"><i class="fas fa-star"></i> ${anime.score || "N/A"}</div>
        <div class="anime-genres">${(anime.genres || []).map(g => g.name).join(", ")}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      if (!localAnimeData.find(a => a.mal_id === anime.mal_id)) localAnimeData.push(anime);
      verDetallesAnime(anime.mal_id);
    });
    grid.appendChild(card);
  });
}

// ─── SIDEBAR AIRING (mini list) ───────────────
async function loadSidebarAiring() {
  const list = document.getElementById("sidebarAiringList");
  if (!list) return;
  try {
    const res  = await fetch(`${JIKAN}/seasons/now?limit=8`);
    const data = await res.json();
    const animes = (data.data || []).slice(0, 6);
    list.innerHTML = animes.map(a => `
      <div class="airing-item" onclick="verDetallesAnime(${a.mal_id})">
        <div class="airing-dot"></div>
        <span class="airing-title">${a.title}</span>
        <span class="airing-ep">${a.episodes ? a.episodes + "ep" : "?"}</span>
      </div>
    `).join("");
    animes.forEach(a => { if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a); });
  } catch(e) {
    list.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:0.5rem;">No disponible</div>`;
  }
}

// ─── CALENDARIO ───────────────────────────────
let calendarDataCache = null;
const DAYS_ES = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];
const DAYS_EN = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

async function loadCalendarView() {
  mostrarVista("calendarView");
  if (calendarDataCache) { renderCalendar(calendarDataCache); return; }

  document.getElementById("calendarStatus").textContent = "Cargando...";
  document.getElementById("calendarGrid").innerHTML = `<p style="color:var(--accent);"><i class="fas fa-spinner fa-spin"></i> Conectando con Jikan...</p>`;

  try {
    const res  = await fetch(`${JIKAN}/schedules`);
    const data = await res.json();
    calendarDataCache = data.data || [];
    renderCalendar(calendarDataCache);
    document.getElementById("calendarStatus").innerHTML =
      `<i class="fas fa-check-circle" style="color:var(--accent)"></i> Actualizado`;
  } catch(e) {
    document.getElementById("calendarStatus").innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error`;
    document.getElementById("calendarGrid").innerHTML = `<p style="color:var(--text-muted);">No se pudo cargar el calendario.</p>`;
  }
}

function renderCalendar(animes) {
  const grid   = document.getElementById("calendarGrid");
  const todayN = new Date().getDay();
  const todayIdx = todayN === 0 ? 6 : todayN - 1;

  grid.innerHTML = "";

  DAYS_EN.forEach((dayEn, idx) => {
    const dayAnimes = animes.filter(a =>
      a.broadcast?.day?.toLowerCase().includes(dayEn.slice(0, 3))
    );
    if (!dayAnimes.length) return;

    const block = document.createElement("div");
    block.className = "calendar-day-block";

    const header = document.createElement("div");
    header.className = `calendar-day-header${idx === todayIdx ? " today" : ""}`;
    header.textContent = `${DAYS_ES[idx]}${idx === todayIdx ? " — Hoy" : ""}`;
    block.appendChild(header);

    dayAnimes.slice(0, 6).forEach(a => {
      if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a);
      const row = document.createElement("div");
      row.className = "calendar-show";
      row.innerHTML = `
        <div class="calendar-show-poster" style="background-image:url('${a.images?.jpg?.image_url || ""}');"></div>
        <div class="calendar-show-info">
          <div class="calendar-show-title">${a.title}</div>
          <div class="calendar-show-time">${a.broadcast?.time ? "⏰ " + a.broadcast.time + " JST" : ""}  ★ ${a.score || "?"}</div>
        </div>
      `;
      row.addEventListener("click", () => verDetallesAnime(a.mal_id));
      block.appendChild(row);
    });

    grid.appendChild(block);
  });
}

// ─── IDIOMA ───────────────────────────────────
function cambiarIdioma(nuevoIdioma) {
  idiomaActual = nuevoIdioma;
  document.getElementById("btnSub").classList.toggle("active", nuevoIdioma === "sub");
  document.getElementById("btnDub").classList.toggle("active", nuevoIdioma === "dub");

  if (animeActualBackend) {
    const lista = animeActualBackend.episodes || animeActualBackend.list || animeActualBackend.episodeList || [];
    construirListaEpisodios(lista);
  }
}

// ─── MODAL MODE ───────────────────────────────
function setModalMode(mode) {
  modoModalActual = mode;

  const tabStream   = document.getElementById("tabStream");
  const tabDownload = document.getElementById("tabDownload");
  const player      = document.getElementById("videoPlayer");
  const playerNat   = document.getElementById("videoPlayerNative");
  const actionBox   = document.getElementById("downloadActionBox");

  if (tabStream)   tabStream.classList.toggle("active", mode === "stream");
  if (tabDownload) tabDownload.classList.toggle("active", mode === "download");

  if (mode === "stream") {
    if (actionBox) actionBox.style.display = "none";
    renderizarBotonesDeServidor(servidoresStreamCache);
  } else {
    if (player)    { player.style.display = "none"; player.src = ""; }
    if (playerNat) { playerNat.style.display = "none"; playerNat.src = ""; }
    if (actionBox) actionBox.style.display = "flex";
    renderizarBotonesDeServidor(servidoresDownloadCache);
  }
}

// ─── STREAMING ────────────────────────────────
async function procesarStreamingEpisodio(episodeObj) {
  mostrarVista("playerView");

  const serverCont  = document.getElementById("modalServers");
  const loader      = document.getElementById("playerLoader");
  const iframeEl    = document.getElementById("videoPlayer");
  const nativeEl    = document.getElementById("videoPlayerNative");

  if (loader)   { loader.classList.remove("hidden"); }
  if (iframeEl) { iframeEl.style.display = "none"; iframeEl.src = ""; }
  if (nativeEl) { nativeEl.style.display = "none"; nativeEl.src = ""; }
  if (serverCont) serverCont.innerHTML = "";

  numeroEpisodioActual    = episodeObj.number || "?";
  servidoresStreamCache   = [];
  servidoresDownloadCache = [];
  setModalMode("stream");

  const animeTitleEl = document.getElementById("playerAnimeTitle");
  const epLabelEl    = document.getElementById("playerEpLabel");
  const bcAnime      = document.getElementById("playerBreadcrumbAnime");
  const bcEp         = document.getElementById("playerBreadcrumbEp");
  const animeNombre  = animeActualBackend?.title || animeActualMAL?.title || "Anime";

  if (animeTitleEl) animeTitleEl.textContent = animeNombre;
  if (epLabelEl)    epLabelEl.textContent    = `Episodio ${numeroEpisodioActual}`;
  if (bcAnime)      bcAnime.textContent      = animeNombre;
  if (bcEp)         bcEp.textContent         = `Ep. ${numeroEpisodioActual}`;

  updatePlayerFavBtn();
  updatePlayerFollowBtn();

  document.querySelectorAll("#playerEpisodeGrid .ep-card-sidebar").forEach(c => {
    const isActive = c.dataset.epNum == numeroEpisodioActual;
    c.classList.toggle("active", isActive);
    if (isActive) {
      const dateEl = c.querySelector(".ep-sidebar-date");
      const nowEl  = c.querySelector(".ep-now-playing");
      if (dateEl) dateEl.style.display = "none";
      if (!nowEl) {
        const info = c.querySelector(".ep-sidebar-info");
        if (info) info.insertAdjacentHTML("beforeend",
          `<span class="ep-now-playing"><span class="ep-now-dot"></span>Reproduciendo</span>`);
      }
      c.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      const nowEl = c.querySelector(".ep-now-playing");
      if (nowEl) nowEl.remove();
      const dateEl = c.querySelector(".ep-sidebar-date");
      if (dateEl) dateEl.style.display = "";
    }
  });

  if (animeActualMAL?.mal_id) {
    pushUrl(animeActualMAL.mal_id, numeroEpisodioActual);
    const prevEntry = getHistoryEntry(animeActualMAL.mal_id, numeroEpisodioActual);
    _episodeStartTime = Date.now();
    _lastSavedTime    = 0;
    _resumeTime       = (prevEntry && prevEntry.time > 5) ? prevEntry.time : 0;
    saveHistory(animeActualMAL.mal_id, numeroEpisodioActual, prevEntry?.time || 0);
    renderContinueWatching();
  }

  // ── URL inválida o modo demo → mostrar mensaje, sin video de prueba ──
  const esUrlFalsa = !episodeObj.url ||
    episodeObj.url.includes("mock-provider") ||
    episodeObj.url.includes("undefined") ||
    episodeObj.url.trim() === "";

  if (esModoDemoActivo || esUrlFalsa) {
    _mostrarMensajeNoDisponible(serverCont, loader);
    return;
  }

  // ── Caché en sessionStorage por episodio ──
  const cacheKey = `nextarc_ep_${animeActualMAL?.mal_id || "x"}_${numeroEpisodioActual}_${idiomaActual}`;
  let result = null;

  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      result = JSON.parse(cached);
      console.info("[Caché] Episodio cargado desde sessionStorage:", cacheKey);
    }
  } catch (e) { /* sessionStorage bloqueado por extensión o privado */ }

  if (!result) {
    try {
      const res = await fetch(`${BASE_URL}/episode?url=${encodeURIComponent(episodeObj.url)}`, { headers: apiHeaders });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result = await res.json();
      try { sessionStorage.setItem(cacheKey, JSON.stringify(result)); } catch (e) {}
    } catch (err) {
      console.warn("[Stream] Error al obtener episodio:", err.message);
      _mostrarMensajeNoDisponible(serverCont, loader);
      return;
    }
  }

  if (result?.success && result.data) {
    const lk  = idiomaActual.toLowerCase();
    const lkU = idiomaActual.toUpperCase();

    servidoresStreamCache   = result.data.servers?.[lk] || result.data.streamLinks?.[lkU] || [];
    servidoresDownloadCache = result.data.downloadLinks?.[lkU] ||
      servidoresStreamCache.filter(s => s.url || s.download_url);

    if (servidoresStreamCache.length || servidoresDownloadCache.length) {
      renderizarBotonesDeServidor(servidoresStreamCache);
      return;
    }
  }

  // Sin servidores en el idioma solicitado
  _mostrarMensajeNoDisponible(serverCont, loader);
}

// ── Helper: mensaje estético de no disponible ──
function _mostrarMensajeNoDisponible(serverCont, loader) {
  if (loader) loader.classList.add("hidden");
  if (serverCont) {
    serverCont.innerHTML = `
      <div class="player-unavailable">
        <i class="fas fa-video-slash"></i>
        <div>
          <strong>Episodio no disponible</strong>
          <p>Este episodio no se encuentra disponible en este momento o no cuenta con doblaje latino.<br>
          Intenta cambiar de versión.</p>
        </div>
      </div>`;
  }
  
}

function renderizarBotonesDeServidor(listaServidores) {
  const modalTitle      = document.getElementById("modalTitle");
  const videoPlayer     = document.getElementById("videoPlayer");
  const videoNative     = document.getElementById("videoPlayerNative");
  const serverCont      = document.getElementById("modalServers");
  const downloadBtn     = document.getElementById("downloadDirectBtn");
  const loader          = document.getElementById("playerLoader");

  if (serverCont) serverCont.innerHTML  = "";
  if (modalTitle) modalTitle.textContent = `${animeActualBackend?.title || animeActualMAL?.title || "Anime"} — Ep. ${numeroEpisodioActual} (${idiomaActual.toUpperCase()})`;

  if (!listaServidores?.length) {
    if (serverCont) serverCont.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem;">
      <i class="fas fa-exclamation-circle"></i> Sin servidores disponibles en ${idiomaActual.toUpperCase()}.
    </p>`;
    if (loader) loader.classList.remove("hidden");
    if (videoPlayer) videoPlayer.src = "";
    if (downloadBtn) downloadBtn.href = "#";
    return;
  }

  const prefIdx = parseInt(localStorage.getItem("animeflix_settings")
    ? JSON.parse(localStorage.getItem("animeflix_settings") || "{}").preferredServer || 0
    : 0);

  listaServidores.forEach((server, idx) => {
    const activeIdx = Math.min(prefIdx, listaServidores.length - 1);
    const btn = document.createElement("button");
    btn.className = `server-btn ${idx === activeIdx ? "active" : ""}`;
    btn.innerHTML = `<i class="${modoModalActual === "stream" ? "fas fa-play-circle" : "fas fa-hdd"}"></i> ${server.server || server.name || "HD " + (idx + 1)}`;
    btn.addEventListener("click", () => {
      document.querySelectorAll(".server-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (modoModalActual === "stream") cargarEnPlayer(server.embed_url || server.url);
      else if (downloadBtn) downloadBtn.href = server.url || server.download_url || "#";
    });
    if (serverCont) serverCont.appendChild(btn);
  });

  const activeIdx = Math.min(prefIdx, listaServidores.length - 1);
  if (modoModalActual === "stream") {
    cargarEnPlayer(listaServidores[activeIdx].embed_url || listaServidores[activeIdx].url);
  } else {
    if (downloadBtn) downloadBtn.href = listaServidores[activeIdx].url || listaServidores[activeIdx].download_url || "#";
  }
}

// Carga una URL en el iframe o el video nativo según el tipo de enlace.
// Para video nativo (.mp4) aplica auto-resume via loadedmetadata.
// Para iframes embebidos intenta añadir el parámetro #t= a la URL si procede.
function cargarEnPlayer(url) {
  const iframe   = document.getElementById("videoPlayer");
  const native   = document.getElementById("videoPlayerNative");
  const loader   = document.getElementById("playerLoader");

  if (!url) return;

  const esMP4 = url.endsWith(".mp4") || url.includes(".mp4?");

  if (esMP4) {
    if (iframe)  { iframe.style.display = "none"; iframe.src = ""; }
    if (native)  {
      native.style.display = "block";

      // Aplicar resume: escuchar loadedmetadata una sola vez
      if (_resumeTime > 5) {
        const _rt = _resumeTime; // captura local para el closure
        const _onLoaded = function() {
          try {
            native.currentTime = _rt;
            const mm = Math.floor(_rt / 60).toString().padStart(2, "0");
            const ss = Math.floor(_rt % 60).toString().padStart(2, "0");
            showToast(`▶ Progreso reanudado en ${mm}:${ss}`);
          } catch(e) { /* sin permisos de currentTime */ }
          native.removeEventListener("loadedmetadata", _onLoaded);
        };
        native.addEventListener("loadedmetadata", _onLoaded);
        _resumeTime = 0; // consumido — no re-aplicar en cambios de servidor
      }

      native.src = url;
    }
  } else {
    // iframe embebido: intentar inyectar #t=Xs si el servidor lo soporta
    // (funciona en vjs, vidcloud, mp4upload y derivados de JW Player)
    let finalUrl = url;
    if (_resumeTime > 5) {
      try {
        const u = new URL(url);
        // Algunos servidores: parámetro ?t= (JW)  |  fragmento #t= (HTML5 media)
        // Intentamos ambos de forma no destructiva
        if (!u.searchParams.has("t") && !u.hash.includes("t=")) {
          u.hash = `t=${Math.floor(_resumeTime)}`;
        }
        finalUrl = u.toString();
        const mm = Math.floor(_resumeTime / 60).toString().padStart(2, "0");
        const ss = Math.floor(_resumeTime % 60).toString().padStart(2, "0");
        showToast(`▶ Progreso reanudado en ${mm}:${ss}`);
      } catch(e) { /* URL inválida — usar original */ }
      _resumeTime = 0; // consumido
    }

    if (native)  { native.style.display = "none"; native.src = ""; }
    if (iframe)  { iframe.style.display = "block"; iframe.src = finalUrl; }
  }

  if (loader) loader.classList.add("hidden");

  // Show one-time mobile seek hint on first native video load
  if (esMP4 && !sessionStorage.getItem("rik_seek_hint_shown")) {
    sessionStorage.setItem("rik_seek_hint_shown", "1");
    const wrap = document.getElementById("playerVideoWrap");
    if (wrap && window.innerWidth <= 768) {
      const hint = document.createElement("div");
      hint.className = "seek-hint";
      hint.innerHTML = `<i class="fas fa-hand-point-left"></i> Doble toque para ±${SEEK_SECONDS}s`;
      wrap.appendChild(hint);
      setTimeout(() => hint.remove(), 3600);
    }
  }
}

// ═══════════════════════════════════════════════════
// SEEK OVERLAY — Adelantar/Retroceder estilo YouTube
// Doble toque en móvil | teclas ← → en PC
// Solo funciona con video nativo (.mp4).
// Para iframes muestra un aviso informativo.
// ═══════════════════════════════════════════════════

const SEEK_SECONDS = 10; // segundos a adelantar/retroceder

let _seekFeedbackTimer = null;

function _getNativeVideo() {
  const v = document.getElementById("videoPlayerNative");
  return (v && v.style.display !== "none" && v.src) ? v : null;
}

// Muestra el ripple de feedback encima del video
// side: "left" | "right"   delta: número de segundos (positivo o negativo)
function _showSeekFeedback(side, delta) {
  const wrap = document.getElementById("playerVideoWrap");
  if (!wrap) return;

  // Reutilizar o crear el elemento
  let fb = document.getElementById(`seekFb_${side}`);
  if (!fb) {
    fb = document.createElement("div");
    fb.id = `seekFb_${side}`;
    fb.className = `seek-feedback seek-feedback--${side}`;
    wrap.appendChild(fb);
  }

  const sign  = delta > 0 ? "+" : "";
  const label = `${sign}${delta}s`;
  const icon  = delta > 0 ? "fa-forward" : "fa-backward";
  fb.innerHTML = `<i class="fas ${icon}"></i><span>${label}</span>`;

  // Reset animation
  fb.classList.remove("seek-feedback--active");
  void fb.offsetWidth; // reflow
  fb.classList.add("seek-feedback--active");

  clearTimeout(_seekFeedbackTimer);
  _seekFeedbackTimer = setTimeout(() => {
    fb.classList.remove("seek-feedback--active");
  }, 700);
}

// Realiza el seek efectivo (solo en video nativo)
// Devuelve true si tuvo éxito, false si era iframe
function seekVideo(delta) {
  const v = _getNativeVideo();
  if (!v) {
    // Iframe: informar al usuario
    showToast(`${delta > 0 ? "⏩" : "⏪"} Control de tiempo no disponible en este servidor`);
    return false;
  }
  try {
    v.currentTime = Math.max(0, Math.min(v.duration || 9999, v.currentTime + delta));
  } catch(e) { /* sin permisos */ }
  return true;
}

// ── Teclado (PC) ───────────────────────────────────
// ← → para seek | Space para play/pause | F para fullscreen
document.addEventListener("keydown", function(e) {
  // Solo actuar si el playerView está visible y el foco no está en un input
  const pv = document.getElementById("playerView");
  if (!pv || pv.style.display === "none") return;
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;

  switch(e.key) {
    case "ArrowRight":
      e.preventDefault();
      if (seekVideo(SEEK_SECONDS)) _showSeekFeedback("right", +SEEK_SECONDS);
      break;
    case "ArrowLeft":
      e.preventDefault();
      if (seekVideo(-SEEK_SECONDS)) _showSeekFeedback("left", -SEEK_SECONDS);
      break;
    case " ":
    case "k": {
      e.preventDefault();
      const v = _getNativeVideo();
      if (v) { v.paused ? v.play() : v.pause(); }
      break;
    }
    case "f":
    case "F": {
      const v = _getNativeVideo();
      if (v) {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else v.requestFullscreen?.();
      }
      break;
    }
    case "ArrowUp":
    case "ArrowDown": {
      const v = _getNativeVideo();
      if (v) {
        e.preventDefault();
        v.volume = Math.max(0, Math.min(1, v.volume + (e.key === "ArrowUp" ? 0.1 : -0.1)));
        showToast(`🔊 Volumen: ${Math.round(v.volume * 100)}%`);
      }
      break;
    }
  }
});

// ── Toque doble (Móvil) ────────────────────────────
// Toque en la mitad izquierda = -10s | mitad derecha = +10s
// Un solo toque en el centro = play/pause (solo nativo)
(function _initTouchSeek() {
  let _tapTimer    = null;
  let _tapCount    = 0;
  let _tapSide     = null;
  let _tapAccum    = 0;       // segundos acumulados en toques rápidos

  function _attachTouchSeek() {
    const wrap = document.getElementById("playerVideoWrap");
    if (!wrap || wrap._touchSeekAttached) return;
    wrap._touchSeekAttached = true;

    wrap.addEventListener("touchend", function(e) {
      const pv = document.getElementById("playerView");
      if (!pv || pv.style.display === "none") return;

      // Ignorar si el toque fue sobre un botón/overlay interno
      if (e.target.closest("button, .autoplay-card, .seek-feedback")) return;

      const rect  = wrap.getBoundingClientRect();
      const touchX = e.changedTouches[0].clientX;
      const relX   = (touchX - rect.left) / rect.width;

      // Zona central (40-60%): play/pause con un solo toque
      const side = relX < 0.4 ? "left" : (relX > 0.6 ? "right" : "center");

      if (side === "center") {
        // Un solo toque en centro: play/pause en nativo, ignorar en iframe
        clearTimeout(_tapTimer);
        _tapTimer = setTimeout(() => {
          const v = _getNativeVideo();
          if (v) { v.paused ? v.play() : v.pause(); }
        }, 220);
        return;
      }

      // Doble (o múltiple) toque en los laterales
      if (_tapSide !== side) {
        // Cambió de lado: reiniciar acumulador
        _tapCount  = 0;
        _tapAccum  = 0;
        _tapSide   = side;
      }

      clearTimeout(_tapTimer);
      _tapCount++;
      const delta  = side === "right" ? SEEK_SECONDS : -SEEK_SECONDS;
      _tapAccum   += delta;

      _tapTimer = setTimeout(() => {
        if (_tapCount >= 2) {
          // Doble toque confirmado
          if (seekVideo(_tapAccum)) _showSeekFeedback(side, _tapAccum);
        }
        // Primer toque solo: mostrar controles nativos (no hacemos nada extra)
        _tapCount = 0;
        _tapAccum = 0;
        _tapSide  = null;
      }, 280);

    }, { passive: true });
  }

  // Adjuntar cuando el DOM esté listo, y re-adjuntar si la vista cambia
  document.addEventListener("DOMContentLoaded", _attachTouchSeek);
  // También intentar adjuntar cuando se muestra el playerView
  const _origMostrarVista = window.mostrarVista;
  if (typeof _origMostrarVista === "function") {
    window.mostrarVista = function(vista) {
      _origMostrarVista(vista);
      if (vista === "playerView") setTimeout(_attachTouchSeek, 100);
    };
  }
})();


// ─── [NUEVO] PERSONAJES (JIKAN) ─────────────────────
async function fetchCharacters(malId) {
  try {
    const res  = await fetch(`${JIKAN}/anime/${malId}/characters`);
    const data = await res.json();
    return (data.data || []).filter(c => c.role === "Main").slice(0, 10);
  } catch(e) {
    console.warn("[Characters]", e.message);
    return [];
  }
}

function renderCharacterCarousel(characters) {
  const container = document.getElementById("characterCarouselSection");
  if (!container) return;
  if (!characters.length) { container.style.display = "none"; return; }

  container.style.display = "block";
  const track = document.getElementById("characterTrack");
  if (!track) return;
  track.innerHTML = "";

  characters.forEach(c => {
    const name    = c.character?.name || "Desconocido";
    const img     = c.character?.images?.jpg?.image_url || "";
    const va      = (c.voice_actors || []).find(v => v.language === "Japanese");
    const vaName  = va?.person?.name || "";
    const vaImg   = va?.person?.images?.jpg?.image_url || "";

    const card = document.createElement("div");
    card.className = "char-card";
    card.innerHTML = `
      <div class="char-img-wrap">
        ${img ? `<img class="char-img" src="${img}" alt="${name}" loading="lazy" />` : `<div class="char-img char-img-placeholder"><i class="fas fa-user"></i></div>`}
      </div>
      <div class="char-name">${name}</div>
      ${vaName ? `
        <div class="char-va-row">
          ${vaImg ? `<img class="char-va-img" src="${vaImg}" alt="${vaName}" loading="lazy" />` : ""}
          <span class="char-va-name">${vaName}</span>
        </div>
      ` : ""}
    `;
    track.appendChild(card);
  });
}

// ─── [NUEVO] RELACIONES PRECUELA / SECUELA (AniList) ───────────
async function fetchRelacionesAniList(malId) {
  const query = `
    query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        relations {
          edges {
            relationType
            node {
              idMal
              title { romaji english }
              coverImage { medium }
              format
            }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { malId: Number(malId) } }),
    });
    const json = await res.json();
    return json?.data?.Media?.relations?.edges || [];
  } catch(e) {
    console.warn("[AniList relaciones]", e.message);
    return [];
  }
}

function renderRelacionesTemporadas(edges) {
  const container = document.getElementById("relacionesContainer");
  if (!container) return;

  // Filtrar solo PREQUEL y SEQUEL
  const relevantes = edges.filter(e =>
    e.relationType === "PREQUEL" || e.relationType === "SEQUEL"
  );

  if (!relevantes.length) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";

  // Inyectar estilos (solo una vez)
  if (!document.getElementById("relacionesStyle")) {
    const s = document.createElement("style");
    s.id = "relacionesStyle";
    s.textContent = `
      #relacionesContainer {
        margin-top: 1.25rem;
        padding-top: 1.25rem;
        border-top: 1px solid var(--border);
      }
      .rel-titulo {
        font-size: 0.75rem;
        font-weight: 700;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.07em;
        margin-bottom: 0.75rem;
      }
      .rel-titulo i { color: var(--accent); margin-right: 0.35rem; }
      .rel-cards {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .rel-card {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.5rem 0.75rem 0.5rem 0.5rem;
        cursor: pointer;
        transition: border-color 0.2s, transform 0.18s, box-shadow 0.18s;
        max-width: 260px;
        text-decoration: none;
      }
      .rel-card:hover {
        border-color: var(--accent);
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(243,195,86,0.18);
      }
      .rel-card-cover {
        width: 44px;
        height: 62px;
        border-radius: 6px;
        object-fit: cover;
        background: var(--bg-card);
        flex-shrink: 0;
      }
      .rel-card-info { flex: 1; min-width: 0; }
      .rel-card-badge {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 1px 6px;
        border-radius: 4px;
        display: inline-block;
        margin-bottom: 0.3rem;
      }
      .rel-card-badge.prequel {
        background: rgba(124,106,247,0.2);
        color: #a89af7;
        border: 1px solid rgba(124,106,247,0.4);
      }
      .rel-card-badge.sequel {
        background: rgba(243,195,86,0.15);
        color: var(--accent);
        border: 1px solid rgba(243,195,86,0.35);
      }
      .rel-card-title {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rel-card-fmt {
        font-size: 0.7rem;
        color: var(--text-muted);
        margin-top: 1px;
      }
    `;
    document.head.appendChild(s);
  }

  container.innerHTML = `
    <div class="rel-titulo">
      <i class="fas fa-layer-group"></i> Temporadas Relacionadas
    </div>
    <div class="rel-cards" id="relCardsInner"></div>
  `;

  const inner = document.getElementById("relCardsInner");

  relevantes.forEach(edge => {
    const node    = edge.node;
    const malId   = node.idMal;
    const titulo  = node.title?.english || node.title?.romaji || "Sin título";
    const cover   = node.coverImage?.medium || "";
    const tipo    = edge.relationType; // "PREQUEL" | "SEQUEL"
    const formato = node.format?.replace(/_/g, " ") || "";

    const card = document.createElement("div");
    card.className = "rel-card";
    card.setAttribute("title", tipo === "PREQUEL" ? "Ver precuela" : "Ver secuela");
    card.innerHTML = `
      ${cover ? `<img class="rel-card-cover" src="${cover}" alt="${titulo}" loading="lazy" />` : `<div class="rel-card-cover"></div>`}
      <div class="rel-card-info">
        <span class="rel-card-badge ${tipo.toLowerCase()}">${tipo === "PREQUEL" ? "◀ Precuela" : "Secuela ▶"}</span>
        <div class="rel-card-title" title="${titulo}">${titulo}</div>
        ${formato ? `<div class="rel-card-fmt">${formato}</div>` : ""}
      </div>
    `;

    if (malId) {
      card.addEventListener("click", async () => {
        // Buscar en catálogo local primero, si no hacer fetch
        let found = localAnimeData.find(a => a.mal_id == malId);
        if (!found) found = await fetchAnimeById(malId);
        if (found) verDetallesAnime(malId);
        else showToast("No se encontró información de este anime", "error");
      });
    } else {
      card.style.opacity = "0.5";
      card.style.cursor  = "default";
    }

    inner.appendChild(card);
  });
}

// ─── [NUEVO] METADATOS ANILIST — PRÓXIMO EPISODIO ─────────────
// Obtiene status de emisión y timestamp exacto del próximo episodio desde AniList GraphQL.
// No requiere API key; uso gratuito para consultas públicas.
async function fetchNextEpisodeAniList(malId) {
  const query = `
    query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        status
        nextAiringEpisode {
          episode
          airingAt
          timeUntilAiring
        }
      }
    }
  `;
  try {
    const res = await fetch(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { malId: Number(malId) } }),
    });
    const json = await res.json();
    return json?.data?.Media || null;
  } catch(e) {
    console.warn("[AniList próximo ep]", e.message);
    return null;
  }
}

// Renderiza el badge de próximo episodio con countdown en tiempo real.
// Requiere que exista en el HTML: <div id="nextEpisodeBadge"></div>
function renderNextEpisodeBadge(episode, airingAtUnix) {
  const el = document.getElementById("nextEpisodeBadge");
  if (!el) return;

  // Limpiar intervalo anterior si el usuario cambió de anime
  if (_nextEpIntervalId) {
    clearInterval(_nextEpIntervalId);
    _nextEpIntervalId = null;
  }

  function updateCountdown() {
    const diff = airingAtUnix * 1000 - Date.now();
    if (diff <= 0) {
      el.innerHTML = `<i class="fas fa-broadcast-tower"></i> Ep. ${episode} — ¡Disponible ahora!`;
      el.style.background = "rgba(243,195,86,0.9)";
      el.style.color = "#0a0a18";
      clearInterval(_nextEpIntervalId);
      return;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    el.innerHTML = `
      <i class="fas fa-clock"></i>
      Ep. ${episode} en ${d > 0 ? d + "d " : ""}${h}h ${m}m
    `;
    el.style.background = "rgba(255,170,0,0.85)";
    el.style.color = "#0a0a18";
  }

  updateCountdown();
  _nextEpIntervalId = setInterval(updateCountdown, 60000);
}

// ─── [NUEVO] MINIATURAS ANILIST (streamingEpisodes) ──────────
// Nivel 3A del sistema de miniaturas: AniList provee thumbnails de Crunchyroll
// con alta cobertura para series populares.
async function fetchAniListEpisodes(malId) {
  if (aniListEpCache[malId]) return aniListEpCache[malId];

  const query = `
    query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) {
        streamingEpisodes {
          title
          thumbnail
        }
      }
    }
  `;
  try {
    const res = await fetch(ANILIST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { malId: Number(malId) } }),
    });
    const json = await res.json();
    const eps  = json?.data?.Media?.streamingEpisodes || [];
    aniListEpCache[malId] = eps;
    return eps;
  } catch(e) {
    console.warn("[AniList eps]", e.message);
    aniListEpCache[malId] = [];
    return [];
  }
}

// Resuelve la mejor miniatura disponible para un episodio dado usando 3 niveles:
// Nivel 1: datos del scraper propio (ep.thumbnail / ep.image / ep.cover)
// Nivel 2: Jikan /anime/{id}/episodes (jikanMeta ya consultado en construirListaEpisodios)
// Nivel 3A: AniList streamingEpisodes (lazy fetch, cacheado)
// Nivel 3B: null → el llamador usará el degradado CSS
async function resolveThumbnail(malId, epNumber, scraperEp, jikanMeta) {
  const key = `${malId}_${epNumber}`;
  if (thumbCache[key] !== undefined) return thumbCache[key];

  // Nivel 1: scraper
  const scraperImg = scraperEp?.thumbnail || scraperEp?.image || scraperEp?.cover || null;
  if (scraperImg) return (thumbCache[key] = scraperImg);

  // Nivel 2: Jikan
  const jikanImg = jikanMeta?.images?.jpg?.image_url || null;
  if (jikanImg) return (thumbCache[key] = jikanImg);

  // Nivel 3A: AniList
  const aniEps = await fetchAniListEpisodes(malId);
  // AniList indexa los episodios en orden, posición 0 = episodio 1
  const aniEp = aniEps[epNumber - 1];
  if (aniEp?.thumbnail) return (thumbCache[key] = aniEp.thumbnail);

  // Sin imagen — usar degradado
  return (thumbCache[key] = null);
}

// ─── SELECTOR DE BLOQUES PARA ANIMES LARGOS ───
// Crea un <select> de rangos de 50 eps si el total supera ese umbral.
// Al cambiar de opción recalcula la página y re-renderiza el segmento.
let _episodesArrayGlobal = []; // referencia al array completo para el selector

function renderSelectorBloques(totalEpisodios) {
  const container = document.getElementById("selector-bloques-container");
  if (!container) return;
  container.innerHTML = "";

  if (totalEpisodios <= 50) return; // no necesita selector

  const BLOQUE = 50;
  const totalBloques = Math.ceil(totalEpisodios / BLOQUE);

  // Inyectar estilos del selector (solo una vez)
  if (!document.getElementById("selectorBloquesStyle")) {
    const s = document.createElement("style");
    s.id = "selectorBloquesStyle";
    s.textContent = `
      #selector-bloques-container {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 1rem;
        flex-wrap: wrap;
      }
      .selector-bloques-label {
        font-size: 0.78rem;
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .selector-bloques-select {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text-primary);
        font-size: 0.85rem;
        padding: 0.35rem 0.85rem;
        cursor: pointer;
        outline: none;
        transition: border-color 0.2s;
        -webkit-appearance: none;
        appearance: none;
        padding-right: 2rem;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='%2300d4aa'%3E%3Cpath d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 0.6rem center;
      }
      .selector-bloques-select:focus,
      .selector-bloques-select:hover { border-color: var(--accent); }
    `;
    document.head.appendChild(s);
  }

  const label = document.createElement("span");
  label.className = "selector-bloques-label";
  label.innerHTML = `<i class="fas fa-th-list" style="color:var(--accent)"></i> Rango:`;

  const select = document.createElement("select");
  select.className = "selector-bloques-select";
  select.setAttribute("aria-label", "Seleccionar rango de episodios");

  for (let i = 0; i < totalBloques; i++) {
    const desde = i * BLOQUE + 1;
    const hasta = Math.min((i + 1) * BLOQUE, totalEpisodios);
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `Episodios ${desde} – ${hasta}`;
    select.appendChild(opt);
  }

  select.addEventListener("change", () => {
    const bloque     = parseInt(select.value, 10);
    const desde      = bloque * BLOQUE;
    const hasta      = Math.min(desde + BLOQUE, _episodesArrayGlobal.length);
    const segmento   = _episodesArrayGlobal.slice(desde, hasta);
    _renderSegmentoEpisodios(segmento);
  });

  container.appendChild(label);
  container.appendChild(select);
}

// Renderiza solo un segmento del array de episodios en el epGrid (sin tocar el playerGrid ni los contadores)
async function _renderSegmentoEpisodios(segmento) {
  const epGrid   = document.getElementById("episodeGrid");
  if (!epGrid) return;
  epGrid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> Cargando episodios...</p>`;

  const animeId  = animeActualMAL?.mal_id;
  const jikanEps = animeId ? (await fetchJikanEpisodes(animeId)) : [];
  const GRADS    = [
    "linear-gradient(135deg,#0f0c29,#302b63,#24243e)",
    "linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)",
    "linear-gradient(135deg,#0d0d0d,#1a0033,#0a0a18)",
    "linear-gradient(135deg,#003333,#005555,#001a1a)",
    "linear-gradient(135deg,#1b0036,#3a0068,#0d001a)",
    "linear-gradient(135deg,#00141a,#003344,#001122)",
    "linear-gradient(135deg,#1a0000,#330011,#0d0000)",
    "linear-gradient(135deg,#001a00,#003300,#000d00)",
  ];

  epGrid.innerHTML = "";

  for (const ep of segmento) {
    const numeroEpisodio = typeof ep === "object" ? (ep.number || ep.episode || ep.id) : ep;
    const jikanMeta      = jikanEps.find(j => j.mal_id == numeroEpisodio || j.episode_id == numeroEpisodio);
    const epTitle        = jikanMeta?.title || `Episodio ${numeroEpisodio}`;
    const grad           = GRADS[(numeroEpisodio - 1) % GRADS.length];
    const thumbUrl       = await resolveThumbnail(animeId, numeroEpisodio, ep, jikanMeta);

    const getEpPayload = () => {
      const payload = { number: numeroEpisodio };
      if (typeof ep === "object" && ep.url) {
        payload.url = ep.url;
      } else {
        const baseUrl = animeActualBackend?.url || "";
        payload.url = baseUrl
          ? (baseUrl.endsWith("/") ? `${baseUrl}${numeroEpisodio}` : `${baseUrl}-${numeroEpisodio}`)
          : `https://mock-provider.com/episode-${numeroEpisodio}`;
      }
      return payload;
    };

    const histEntry = animeActualMAL?.mal_id
      ? (currentUser?.history || getLocalHistory()).find(h => h.key === `${animeActualMAL.mal_id}_${numeroEpisodio}`)
      : null;
    const isWatched = histEntry && histEntry.time > 30;
    const watchedOverlay = isWatched ? `<div class="ep-watched-badge"><i class="fas fa-check-circle"></i></div>` : "";

    const mediaEl = thumbUrl
      ? `<img class="ep-card-thumb${isWatched ? " ep-watched-thumb" : ""}" src="${thumbUrl}" alt="Ep ${numeroEpisodio}" loading="lazy"
              onerror="this.style.display='none';this.nextElementSibling.style.display='block';" />
         <div class="ep-card-gradient" style="display:none;background:${grad};"></div>`
      : `<div class="ep-card-gradient${isWatched ? " ep-watched-thumb" : ""}" style="background:${grad};"></div>`;

    const detCard = document.createElement("div");
    detCard.className = `ep-card-premium${isWatched ? " ep-card-watched" : ""}`;
    detCard.innerHTML = `
      ${mediaEl}
      <div class="ep-card-overlay"><i class="fas fa-play ep-card-play"></i></div>
      <span class="ep-card-badge">Ep. ${numeroEpisodio}</span>
      ${watchedOverlay}
      <div class="ep-card-info">
        <div class="ep-card-title" title="${epTitle}">${epTitle}</div>
        ${isWatched ? `<div class="ep-card-progress-bar"><div class="ep-card-progress-fill" style="width:100%"></div></div>` : ""}
      </div>
    `;
    detCard.addEventListener("click", () => procesarStreamingEpisodio(getEpPayload()));
    epGrid.appendChild(detCard);
  }
}

// ─── LISTA DE EPISODIOS ────────────────────────
async function construirListaEpisodios(episodesArray) {
  const epGrid        = document.getElementById("episodeGrid");       // grid en detailsView
  const playerGrid    = document.getElementById("playerEpisodeGrid"); // sidebar del player
  const epCount       = document.getElementById("epCount");
  const playerEpCount = document.getElementById("playerEpCount");

  if (epGrid)     epGrid.innerHTML = "";
  if (playerGrid) playerGrid.innerHTML = "";

  if (!episodesArray?.length) {
    const msg = `<p style="color:var(--text-muted);padding:10px;font-size:0.85rem;">
      <i class="fas fa-info-circle"></i> No se encontraron episodios.
    </p>`;
    if (epGrid)     epGrid.innerHTML = msg;
    if (playerGrid) playerGrid.innerHTML = msg;
    if (epCount)       epCount.textContent = "";
    if (playerEpCount) playerEpCount.textContent = "";
    // Limpiar selector de bloques si no hay episodios
    const sc = document.getElementById("selector-bloques-container");
    if (sc) sc.innerHTML = "";
    return;
  }

  // Guardar referencia global y renderizar selector de bloques
  _episodesArrayGlobal = episodesArray;
  renderSelectorBloques(episodesArray.length);

  if (epCount)       epCount.textContent = `${episodesArray.length} episodios`;
  if (playerEpCount) playerEpCount.textContent = `${episodesArray.length} eps`;

  const animeId  = animeActualMAL?.mal_id;
  const jikanEps = animeId ? (await fetchJikanEpisodes(animeId)) : [];

  const GRADS = [
    "linear-gradient(135deg,#0f0c29,#302b63,#24243e)",
    "linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)",
    "linear-gradient(135deg,#0d0d0d,#1a0033,#0a0a18)",
    "linear-gradient(135deg,#003333,#005555,#001a1a)",
    "linear-gradient(135deg,#1b0036,#3a0068,#0d001a)",
    "linear-gradient(135deg,#00141a,#003344,#001122)",
    "linear-gradient(135deg,#1a0000,#330011,#0d0000)",
    "linear-gradient(135deg,#001a00,#003300,#000d00)",
  ];

  // Inyectar estilos de tarjetas premium del grid de detalles (solo una vez)
  if (!document.getElementById("epCardPremiumStyle")) {
    const style = document.createElement("style");
    style.id = "epCardPremiumStyle";
    style.textContent = `
      #episodeGrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:12px; }
      .ep-card-premium {
        position:relative; border-radius:10px; overflow:hidden;
        background:var(--bg-elevated); cursor:pointer;
        transition:transform 0.2s,box-shadow 0.2s;
        border:1px solid var(--border);
      }
      .ep-card-premium:hover { transform:translateY(-4px); box-shadow:0 8px 24px rgba(243,195,86,0.2); }
      .ep-card-thumb { width:100%; aspect-ratio:16/9; object-fit:cover; background:var(--bg-card); display:block; }
      .ep-card-overlay {
        position:absolute; inset:0 0 auto 0; height:calc(100% - 52px);
        background:rgba(10,10,24,0); transition:background 0.2s;
        display:flex; align-items:center; justify-content:center;
      }
      .ep-card-premium:hover .ep-card-overlay { background:rgba(10,10,24,0.55); }
      .ep-card-play { font-size:2rem; color:var(--accent); opacity:0; transition:opacity 0.2s; text-shadow:0 2px 8px #000; }
      .ep-card-premium:hover .ep-card-play { opacity:1; }
      .ep-card-badge {
        position:absolute; top:6px; left:6px;
        background:var(--accent); color:#0a0a18;
        font-size:0.65rem; font-weight:700; padding:2px 7px; border-radius:4px;
      }
      .ep-card-info { padding:7px 8px 8px; font-size:0.75rem; color:var(--text-secondary); line-height:1.3; }
      .ep-card-title { font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ep-card-gradient { width:100%; aspect-ratio:16/9; display:block; }
    `;
    document.head.appendChild(style);
  }

  if (animeId) fetchAniListEpisodes(animeId);

  // Para animes con >50 eps, el epGrid ya fue delegado al selector de bloques.
  // Disparar la renderización del primer bloque ahora:
  if (episodesArray.length > 50 && epGrid) {
    _renderSegmentoEpisodios(episodesArray.slice(0, 50));
  }

  for (const ep of episodesArray) {
    const numeroEpisodio = typeof ep === "object" ? (ep.number || ep.episode || ep.id) : ep;
    const jikanMeta      = jikanEps.find(j => j.mal_id == numeroEpisodio || j.episode_id == numeroEpisodio);
    const epTitle        = jikanMeta?.title || `Episodio ${numeroEpisodio}`;
    const epDate         = jikanMeta?.aired ? new Date(jikanMeta.aired).toLocaleDateString("es", { day:"2-digit", month:"short", year:"numeric" }) : "";
    const grad           = GRADS[(numeroEpisodio - 1) % GRADS.length];
    const thumbUrl       = await resolveThumbnail(animeId, numeroEpisodio, ep, jikanMeta);

    // Payload compartido para el click
    const getEpPayload = () => {
      const payload = { number: numeroEpisodio };
      if (typeof ep === "object" && ep.url) {
        payload.url = ep.url;
      } else {
        const baseUrl = animeActualBackend?.url || "";
        payload.url = baseUrl
          ? (baseUrl.endsWith("/") ? `${baseUrl}${numeroEpisodio}` : `${baseUrl}-${numeroEpisodio}`)
          : `https://mock-provider.com/episode-${numeroEpisodio}`;
      }
      return payload;
    };

    // ── Tarjeta del grid de detalles: solo para animes ≤50 eps (los de >50 los maneja el selector) ──
    if (epGrid && episodesArray.length <= 50) {
      const histEntry = animeActualMAL?.mal_id
        ? (currentUser?.history || getLocalHistory()).find(h => h.key === `${animeActualMAL.mal_id}_${numeroEpisodio}`)
        : null;
      const isWatched = histEntry && histEntry.time > 30;
      const watchedOverlay = isWatched
        ? `<div class="ep-watched-badge"><i class="fas fa-check-circle"></i></div>`
        : "";
      const mediaEl = thumbUrl
        ? `<img class="ep-card-thumb${isWatched ? " ep-watched-thumb" : ""}" src="${thumbUrl}" alt="Ep ${numeroEpisodio}" loading="lazy"
                onerror="this.style.display='none';this.nextElementSibling.style.display='block';" />
           <div class="ep-card-gradient" style="display:none;background:${grad};"></div>`
        : `<div class="ep-card-gradient${isWatched ? " ep-watched-thumb" : ""}" style="background:${grad};"></div>`;

      const detCard = document.createElement("div");
      detCard.className = `ep-card-premium${isWatched ? " ep-card-watched" : ""}`;
      detCard.innerHTML = `
        ${mediaEl}
        <div class="ep-card-overlay"><i class="fas fa-play ep-card-play"></i></div>
        <span class="ep-card-badge">Ep. ${numeroEpisodio}</span>
        ${watchedOverlay}
        <div class="ep-card-info">
          <div class="ep-card-title" title="${epTitle}">${epTitle}</div>
          ${isWatched ? `<div class="ep-card-progress-bar"><div class="ep-card-progress-fill" style="width:100%"></div></div>` : ""}
        </div>
      `;
      detCard.addEventListener("click", () => procesarStreamingEpisodio(getEpPayload()));
      epGrid.appendChild(detCard);
    }

    // ── Tarjeta del sidebar del player (horizontal) ──
    if (playerGrid) {
      const thumbContent = thumbUrl
        ? `<img src="${thumbUrl}" alt="Ep ${numeroEpisodio}" loading="lazy"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block';" />
           <div class="ep-thumb-gradient" style="display:none;background:${grad};width:100%;height:100%;"></div>`
        : `<div class="ep-thumb-gradient" style="background:${grad};width:100%;height:100%;"></div>`;

      const sideCard = document.createElement("div");
      sideCard.className = "ep-card-sidebar";
      sideCard.dataset.epNum = numeroEpisodio;
      sideCard.innerHTML = `
        <div class="ep-sidebar-thumb">${thumbContent}</div>
        <div class="ep-sidebar-info">
          <div class="ep-sidebar-num">EP. ${numeroEpisodio}</div>
          <div class="ep-sidebar-title" title="${epTitle}">${epTitle}</div>
          ${epDate ? `<div class="ep-sidebar-date">${epDate}</div>` : ""}
        </div>
      `;
      sideCard.addEventListener("click", () => procesarStreamingEpisodio(getEpPayload()));
      playerGrid.appendChild(sideCard);
    }
  }
}
// ─── METADATOS JIKAN EPISODIOS (caché) ────────
let jikanEpisodesCache = {};

async function fetchJikanEpisodes(animeId) {
  if (jikanEpisodesCache[animeId]) return jikanEpisodesCache[animeId];
  try {
    const res  = await fetch(`${JIKAN}/anime/${animeId}/episodes`);
    const data = await res.json();
    jikanEpisodesCache[animeId] = data.data || [];
  } catch(e) {
    jikanEpisodesCache[animeId] = [];
  }
  return jikanEpisodesCache[animeId];
}

// ─── ACTUALIZAR BOTONES DEL PLAYER ────────────
function updatePlayerFavBtn() {
  const btn = document.getElementById("playerFavBtn");
  if (!btn || !animeActualMAL) return;
  const fav = isFavorite(animeActualMAL.mal_id);
  btn.classList.toggle("active", fav);
  btn.innerHTML = fav
    ? '<i class="fas fa-heart"></i><span>Guardado</span>'
    : '<i class="far fa-heart"></i><span>Favorito</span>';
}

function updatePlayerFollowBtn() {
  const btn = document.getElementById("playerFollowBtn");
  if (!btn || !animeActualMAL) return;
  const following = isFollowing(animeActualMAL.mal_id);
  btn.classList.toggle("active", following);
  btn.innerHTML = following
    ? '<i class="fas fa-bell-slash"></i><span>Siguiendo</span>'
    : '<i class="fas fa-bell"></i><span>Seguir</span>';
}

// Sobreescribir updateFavBtn y updateFollowBtn para que también actualicen el player
const _origUpdateFavBtn = typeof updateFavBtn === "function" ? updateFavBtn : null;
function updateFavBtn() {
  // versión legacy (detailsView)
  const btn = document.getElementById("detFavBtn");
  if (btn && animeActualMAL) {
    const fav = isFavorite(animeActualMAL.mal_id);
    btn.innerHTML = fav ? '<i class="fas fa-heart"></i> En Favoritos' : '<i class="far fa-heart"></i> Agregar a Favoritos';
    btn.style.background = fav ? "var(--danger)" : "";
  }
  updatePlayerFavBtn();
}

// ─── VER DETALLES ─────────────────────────────
async function verDetallesAnime(animeId) {
  const anime = localAnimeData.find(a => a.mal_id == animeId);
  if (!anime) return;

  animeActualMAL     = anime;
  animeActualBackend = null;
  esModoDemoActivo   = false;

  // Limpiar countdown anterior si existía
  if (_nextEpIntervalId) {
    clearInterval(_nextEpIntervalId);
    _nextEpIntervalId = null;
  }

  pushUrl(animeId, null);

  // Pre-cargar metadatos de episodios y AniList en paralelo (segundo plano)
  fetchJikanEpisodes(animeId);
  fetchAniListEpisodes(animeId);

  // Poblar UI básica
  document.getElementById("detPoster").style.backgroundImage = `url('${anime.images.jpg.large_image_url || anime.images.jpg.image_url}')`;
  document.getElementById("detTitle").textContent     = anime.title;
  document.getElementById("detSynopsis").textContent  = "Cargando...";

  const meta = document.getElementById("detMeta");
  meta.innerHTML = [
    anime.score    ? `<span class="details-meta-item"><i class="fas fa-star" style="color:var(--warning)"></i> ${anime.score}</span>` : "",
    anime.year     ? `<span class="details-meta-item">\uD83D\uDCC5 ${anime.year}</span>` : "",
    anime.type     ? `<span class="details-meta-item">${anime.type}</span>` : "",
    anime.episodes ? `<span class="details-meta-item">${anime.episodes} eps</span>` : "",
    anime.status   ? `<span class="details-meta-item">${anime.status}</span>` : "",
  ].join("");

  // [NUEVO] Badge de estado de emisión con CSS semántico
  const statusBadgeEl = document.getElementById("detStatusBadge");
  if (statusBadgeEl) {
    const isAiring = anime.status === "Currently Airing";
    statusBadgeEl.innerHTML = isAiring
      ? `<span class="anime-type-badge" style="background:rgba(243,195,86,0.9);color:#0a0a18;">
           <i class="fas fa-broadcast-tower"></i> EN EMISIÓN
         </span>`
      : `<span class="anime-type-badge" style="background:rgba(100,100,130,0.7);">
           <i class="fas fa-check-circle"></i> FINALIZADO
         </span>`;
  }

  // [NUEVO] Limpiar badge de próximo episodio (se rellenará desde AniList)
  const nextBadgeEl = document.getElementById("nextEpisodeBadge");
  if (nextBadgeEl) nextBadgeEl.innerHTML = "";

  // [NUEVO] Limpiar sección de relaciones mientras se carga
  const relContainer = document.getElementById("relacionesContainer");
  if (relContainer) relContainer.style.display = "none";

  const genresEl = document.getElementById("detGenres");
  genresEl.innerHTML = (anime.genres || []).map(g =>
    `<span style="background:var(--bg-elevated);border:1px solid var(--border);padding:2px 10px;border-radius:4px;font-size:0.78rem;color:var(--text-secondary);">${g.name}</span>`
  ).join("");

  const epGrid    = document.getElementById("episodeGrid");
  const statusInd = document.getElementById("statusIndicator");

  if (epGrid) epGrid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> Conectando...</p>`;

 mostrarVista("detailsView");

  // ─── Toggle Leer más / Leer menos ────────────────
  const synopsisEl = document.getElementById("detSynopsis");
  const toggleBtn  = document.getElementById("btnToggleSynopsis");
  if (synopsisEl && toggleBtn) {
    synopsisEl.classList.add("sinopsis-recortada");
    toggleBtn.textContent = "Leer más";
    toggleBtn.onclick = function () {
      const recortada = synopsisEl.classList.toggle("sinopsis-recortada");
      toggleBtn.textContent = recortada ? "Leer más" : "Leer menos";
    };
  }

  updateFavBtn();
  updateFollowBtn();
  updateDetLikeBtn();

  // [NUEVO] Cargar próximo episodio desde AniList en paralelo (no bloquea la UI)
  fetchNextEpisodeAniList(animeId).then(aniData => {
    if (aniData?.nextAiringEpisode) {
      const { episode, airingAt } = aniData.nextAiringEpisode;
      renderNextEpisodeBadge(episode, airingAt);
    }
  });

  // [NUEVO] Cargar relaciones precuela/secuela desde AniList en paralelo
  fetchRelacionesAniList(animeId).then(edges => {
    renderRelacionesTemporadas(edges);
  });

  // [NUEVO] Cargar personajes desde Jikan en paralelo
  fetchCharacters(animeId).then(chars => {
    renderCharacterCarousel(chars);
  });
// ── Caché sessionStorage por anime ──
  const animeCache = (() => {
    const key = `nextarc_info_${animeId}`;
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  })();

   try {
    let resultsArray   = [];
    let origenServidor = "Local";
    let infoData       = animeCache;

    if (!infoData) {
      const searchRes = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(anime.title)}`, { headers: apiHeaders });
      if (searchRes.ok) {
        const r = await searchRes.json();
        if (r?.success && r.data) {
          resultsArray   = Array.isArray(r.data) ? r.data : (r.data.results || []);
          origenServidor = r.source || "Scraper";
        }
      }

      if (!resultsArray.length && anime.title_japanese) {
        const altRes = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(anime.title_japanese)}`, { headers: apiHeaders });
        if (altRes.ok) {
          const r = await altRes.json();
          if (r?.success && r.data) {
            resultsArray   = Array.isArray(r.data) ? r.data : (r.data.results || []);
            origenServidor = r.source || origenServidor;
          }
        }
      }

      if (resultsArray.length > 0) {
        const infoRes = await fetch(`${BASE_URL}/info?url=${encodeURIComponent(resultsArray[0].url)}`, { headers: apiHeaders });
        if (!infoRes.ok) throw new Error("Fallo info");
        const infoResult = await infoRes.json();
        if (infoResult?.success && infoResult.data) {
          infoData = infoResult.data;
          try { sessionStorage.setItem(`nextarc_info_${animeId}`, JSON.stringify(infoData)); } catch {}
        }
      }
    } else {
      origenServidor = "Caché Local";
    }

    if (infoData) {
      animeActualBackend = infoData;

      if (animeActualBackend.title)
        document.getElementById("detTitle").textContent = animeActualBackend.title;
      document.getElementById("detSynopsis").textContent =
        animeActualBackend.description || animeActualBackend.synopsis || anime.synopsis || "Sin descripción.";

      statusInd.innerHTML = `<i class="fas fa-server"></i> ${origenServidor.toUpperCase()}`;
      statusInd.style.background = "var(--accent)";
      statusInd.style.color      = "#0a0a18";

      construirListaEpisodios(
        animeActualBackend.episodes || animeActualBackend.list || animeActualBackend.episodeList || []
      );
      return;
    }

    throw new Error("Sin registros en scraper.");
  } catch (err) {
    console.warn("[Backend]", err.message);
    esModoDemoActivo = false; // no activar modo demo: solo mostrar episodios vacíos

    statusInd.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Sin conexión`;
    statusInd.style.background = "var(--warning)";
    statusInd.style.color      = "#0a0a18";

    document.getElementById("detSynopsis").textContent = anime.synopsis || "Sin descripción disponible.";

    const totalEps = typeof anime.episodes === "number" && anime.episodes > 0 ? anime.episodes : 12;
    animeActualBackend = {
      title: anime.title, url: "",
      episodes: Array.from({ length: totalEps }, (_, i) => ({
        number: i + 1,
        url:    "", // URL vacía → procesarStreamingEpisodio muestra mensaje, no video demo
      })),
    };
    construirListaEpisodios(animeActualBackend.episodes);
  }
}

// ─── [NUEVO] BÚSQUEDA PREDICTIVA CON DEBOUNCE ─
// Reemplaza el listener de "keypress" original. Dispara búsqueda 300ms
// después de que el usuario deja de escribir. Incluye:
//   - Resultados locales instantáneos (0ms) para sensación de rapidez
//   - Caché de sesión para no repetir peticiones a Jikan
//   - setSearchState() para ocultar/restaurar secciones del Home

async function buscarPorNombreYVer(nombre) {
  const query = nombre.trim();
  if (!query) {
    setSearchState("idle");
    return;
  }

  setSearchState("active");
  mostrarVista("homeView");

  const queryLower = query.toLowerCase();
  const localResults = localAnimeData.filter(a => {
    if (esContenidoAdulto(a)) return false;
    if ((a.title || "").toLowerCase().includes(queryLower)) return true;
    if ((a.title_english || "").toLowerCase().includes(queryLower)) return true;
    if ((a.title_japanese || "").toLowerCase().includes(queryLower)) return true;
    if (Array.isArray(a.titles)) {
      return a.titles.some(t => (t.title || "").toLowerCase().includes(queryLower));
    }
    return false;
  });

  if (localResults.length) {
    document.getElementById("catalogTitle").textContent = `Resultados para: "${query}"`;
    renderGrid(localResults);
  } else {
    document.getElementById("catalogTitle").textContent = `Buscando "${query}"...`;
  }

  if (searchCache.has(query)) {
    const cached = searchCache.get(query).filter(a => !esContenidoAdulto(a));
    document.getElementById("catalogTitle").textContent = `Resultados para: "${query}"`;
    renderGrid(cached);
    return;
  }

  try {
    const res  = await fetch(`${JIKAN}/anime?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (data.data?.length) {
      const seguros = data.data.filter(a => !esContenidoAdulto(a));

      seguros.forEach(found => {
        if (!localAnimeData.find(a => a.mal_id === found.mal_id)) {
          localAnimeData.push(found);
        }
      });

      searchCache.set(query, seguros);
      setTimeout(() => searchCache.delete(query), 5 * 60 * 1000);

      document.getElementById("catalogTitle").textContent = `Resultados para: "${query}"`;
      renderGrid(seguros);
    } else if (!localResults.length) {
      showToast("No se encontraron resultados", "error");
    }
  } catch(err) {
    console.error("Búsqueda fallida:", err);
    if (!localResults.length) {
      showToast("Error de búsqueda", "error");
      setSearchState("idle");
    }
  }
}

// ─── EVENTOS ──────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

  loadUser();
  loadSettings();

  // ── Inyectar estilos dinámicos de UX ──────────────────────────
  if (!document.getElementById("uxEnhancedStyles")) {
    const s = document.createElement("style");
    s.id = "uxEnhancedStyles";
    s.textContent = `
      /* ── Carrusel "Continuar Viendo" ── */
      .continue-watching-carousel {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        padding-bottom: 10px;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
      }
      .continue-watching-carousel::-webkit-scrollbar { height: 4px; }
      .continue-watching-carousel::-webkit-scrollbar-track { background: var(--bg-elevated); border-radius: 4px; }
      .continue-watching-carousel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
      .continue-watching-carousel::-webkit-scrollbar-thumb:hover { background: var(--accent); }

      .cw-card {
        flex: 0 0 260px;
        scroll-snap-align: start;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      }
      .cw-card:hover {
        transform: translateY(-3px);
        box-shadow: 0 8px 24px rgba(243,195,86,0.18);
        border-color: var(--accent);
      }
      .cw-thumb {
        position: relative;
        width: 100%;
        aspect-ratio: 16/9;
        background-size: cover;
        background-position: center;
        background-color: var(--bg-elevated);
      }
      .cw-play-overlay {
        position: absolute;
        inset: 0;
        background: rgba(10,10,24,0);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
        font-size: 1.6rem;
        color: var(--accent);
        opacity: 0;
        transition: opacity 0.2s, background 0.2s;
      }
      .cw-card:hover .cw-play-overlay { background: rgba(10,10,24,0.5); opacity: 1; }
      .cw-ep-badge {
        position: absolute;
        top: 7px; left: 7px;
        background: var(--accent);
        color: #0a0a18;
        font-size: 0.62rem;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 4px;
        letter-spacing: 0.04em;
      }
      .cw-info { padding: 8px 10px 10px; }
      .cw-title {
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 3px;
      }
      .cw-time {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-bottom: 6px;
      }
      .cw-progress-bar {
        height: 3px;
        background: var(--border);
        border-radius: 2px;
        overflow: hidden;
      }
      .cw-progress-fill {
        height: 100%;
        background: var(--warning);
        border-radius: 2px;
        transition: width 0.3s ease;
      }

      /* ── Sidebar right oculta en playerView ── */
      #playerView ~ #sidebarRight,
      .player-view-active .sidebar-right { display: none !important; }

      /* ── Bloque de metadatos del reproductor: más espacio y limpio ── */
      .player-meta-block {
        padding: 1.25rem 1.5rem 1.5rem;
        background: var(--bg-card);
        border-top: 1px solid var(--border);
      }
      .player-title-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 1rem;
      }
      .player-anime-title {
        font-size: 1.15rem;
        font-weight: 700;
        color: var(--text-primary);
        margin: 0 0 0.2rem;
        line-height: 1.3;
      }
      .player-ep-label {
        font-size: 0.82rem;
        color: var(--text-muted);
        margin: 0;
      }
      .player-actions {
        display: flex;
        gap: 0.35rem;
        flex-wrap: wrap;
        align-items: center;
        margin-bottom: 1.25rem;
        padding-bottom: 1.25rem;
        border-bottom: 1px solid var(--border);
      }
      .player-server-section {
        background: var(--bg-elevated);
        border-radius: 10px;
        padding: 1rem 1.25rem;
        border: 1px solid var(--border);
      }
      .player-server-label {
        font-size: 0.75rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin: 0.75rem 0 0.5rem;
        font-weight: 600;
      }
      .player-server-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }
      .player-server-mode-tabs {
        display: flex;
        gap: 0.4rem;
        margin-bottom: 0.25rem;
      }

      /* ── Vista Playlists: cuadrícula de carpetas ── */
      .plv-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 16px;
      }
      .plv-folder-card {
        position: relative;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      }
      .plv-folder-card:hover {
        transform: translateY(-4px);
        box-shadow: 0 10px 28px rgba(0,0,0,0.35);
        border-color: var(--folder-color, var(--accent));
      }
      .plv-folder-preview {
        position: relative;
        width: 100%;
        aspect-ratio: 16/10;
        background: var(--bg-elevated);
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
        overflow: hidden;
        align-items: center;
        justify-items: center;
      }
      .plv-folder-thumb {
        width: 100%;
        height: 100%;
        background-size: cover;
        background-position: center;
        opacity: 0.75;
        transition: opacity 0.2s;
      }
      .plv-folder-card:hover .plv-folder-thumb { opacity: 0.95; }
      .plv-folder-count-badge {
        position: absolute;
        bottom: 7px; right: 8px;
        background: rgba(10,10,24,0.82);
        color: var(--folder-color, var(--accent));
        font-size: 0.72rem;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 20px;
        border: 1px solid var(--folder-color, var(--accent));
      }
      .plv-folder-info {
        padding: 9px 12px 10px;
      }
      .plv-folder-name {
        font-size: 0.88rem;
        font-weight: 700;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 2px;
      }
      .plv-folder-meta {
        font-size: 0.74rem;
        color: var(--text-muted);
      }
      .plv-folder-del {
        position: absolute;
        top: 7px; right: 7px;
        background: rgba(10,10,24,0.75);
        border: 1px solid var(--border);
        color: var(--text-muted);
        border-radius: 6px;
        width: 26px; height: 26px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        font-size: 0.72rem;
        opacity: 0;
        transition: opacity 0.15s, color 0.15s, background 0.15s;
      }
      .plv-folder-card:hover .plv-folder-del { opacity: 1; }
      .plv-folder-del:hover { color: var(--danger); background: rgba(220,50,50,0.18); border-color: var(--danger); }

      /* Botón eliminar sobre tarjeta de anime dentro de playlist */
      .plv-remove-btn {
        position: absolute;
        top: 7px; right: 7px;
        background: rgba(10,10,24,0.8);
        border: 1px solid var(--border);
        color: var(--text-muted);
        border-radius: 50%;
        width: 26px; height: 26px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        font-size: 0.72rem;
        opacity: 0;
        transition: opacity 0.15s, color 0.15s, background 0.15s;
        z-index: 2;
      }
      .anime-card:hover .plv-remove-btn { opacity: 1; }
      .plv-remove-btn:hover { color: var(--danger); background: rgba(220,50,50,0.22); border-color: var(--danger); }

      /* Sub-vista detalle de playlist */
      #plv-detail .section-header {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
      }

      /* ── Playlist Dropdown ── */
      .playlist-dropdown {
        position: absolute;
        bottom: calc(100% + 10px);
        left: 0;
        z-index: 9999;
        width: 300px;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(243,195,86,0.12);
        overflow: hidden;
        animation: pdSlideIn 0.18s cubic-bezier(0.34,1.36,0.64,1) both;
      }
      @keyframes pdSlideIn {
        from { opacity:0; transform:translateY(10px) scale(0.96); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .pd-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--text-primary);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .pd-header i { color: var(--accent); }
      .pd-header span { flex: 1; }
      .pd-close {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
        font-size: 0.85rem;
        transition: color 0.15s;
      }
      .pd-close:hover { color: var(--danger); }
      .pd-list {
        max-height: 220px;
        overflow-y: auto;
        padding: 0.4rem 0;
      }
      .pd-list::-webkit-scrollbar { width: 4px; }
      .pd-list::-webkit-scrollbar-track { background: transparent; }
      .pd-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
      .pd-item {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.55rem 1rem;
        cursor: pointer;
        transition: background 0.15s;
        font-size: 0.84rem;
        color: var(--text-primary);
      }
      .pd-item:hover { background: var(--bg-elevated); }
      .pd-item--active { background: rgba(243,195,86,0.07); }
      .pd-check { font-size: 1rem; flex-shrink: 0; width: 18px; text-align: center; }
      .pd-name { flex: 1; }
      .pd-count { font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; }
      .pd-empty { padding: 0.75rem 1rem; font-size: 0.82rem; color: var(--text-muted); text-align: center; }
      .pd-create {
        display: flex;
        gap: 0.4rem;
        padding: 0.65rem 0.75rem;
        border-top: 1px solid var(--border);
        background: var(--bg-elevated);
      }
      .pd-input {
        flex: 1;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.38rem 0.65rem;
        font-size: 0.82rem;
        color: var(--text-primary);
        outline: none;
        transition: border-color 0.15s;
      }
      .pd-input:focus { border-color: var(--accent); }
      .pd-input::placeholder { color: var(--text-muted); }
      .pd-add-btn {
        background: var(--accent);
        color: #0a0a18;
        border: none;
        border-radius: 6px;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 0.85rem;
        flex-shrink: 0;
        transition: opacity 0.15s, transform 0.15s;
      }
      .pd-add-btn:hover { opacity: 0.85; transform: scale(1.08); }
    `;
    document.head.appendChild(s);
  }
  // ─────────────────────────────────────────────────────────────

  // Botón volver del player
  const playerBackBtn = document.getElementById("playerBackBtn");
  if (playerBackBtn) {
    playerBackBtn.addEventListener("click", () => {
      // Detener reproducción
      const iframe = document.getElementById("videoPlayer");
      const native = document.getElementById("videoPlayerNative");
      if (iframe) { iframe.style.display = "none"; iframe.src = ""; }
      if (native) { native.style.display = "none"; native.src = ""; }
      // Guardar tiempo si corresponde
      if (_episodeStartTime && animeActualMAL?.mal_id) {
        const elapsed   = Math.floor((Date.now() - _episodeStartTime) / 1000);
        const prev      = getHistoryEntry(animeActualMAL.mal_id, numeroEpisodioActual);
        const totalTime = (prev?.time || 0) + elapsed;
        saveHistory(animeActualMAL.mal_id, numeroEpisodioActual, totalTime);
        _episodeStartTime = null;
        renderContinueWatching();
      }
      // Volver a detalles del anime si hay uno activo, si no al home
      if (animeActualMAL?.mal_id) {
        pushUrl(animeActualMAL.mal_id, null);
        mostrarVista("detailsView");
      } else {
        clearUrl();
        volverAlHome();
      }
    });
  }

  // Mantener closeModal como alias por compatibilidad con deep linking
  const closeModalBtn = document.getElementById("closeModal");
  if (closeModalBtn) {
    closeModalBtn.addEventListener("click", () => {
      if (playerBackBtn) playerBackBtn.click();
    });
  }

  // Función auxiliar para restaurar Home (reutilizada en varios handlers)
  function volverAlHome() {
    setSearchState("idle"); // restaura secciones y catálogo
    clearUrl();
    mostrarVista("homeView");
  }

  // Botón volver
  document.getElementById("backToHomeBtn").addEventListener("click", volverAlHome);

  // Logo
  document.getElementById("brandLogo").addEventListener("click", volverAlHome);

  // Sidebar navegación
  document.getElementById("sideHome").addEventListener("click", e => {
    e.preventDefault();
    volverAlHome();
  });
  document.getElementById("sideAiring").addEventListener("click", e => {
    e.preventDefault(); loadAiringView();
  });
  document.getElementById("sideCalendar").addEventListener("click", e => {
    e.preventDefault(); loadCalendarView();
  });
  document.getElementById("sideFavorites").addEventListener("click", e => {
    e.preventDefault();
    refreshFavViews();
    mostrarVista("favoritesView");
  });
  document.getElementById("sidePlaylists").addEventListener("click", e => {
    e.preventDefault();
    loadPlaylistsView();
  });

  // Directorio
  document.getElementById("sideDirectory")?.addEventListener("click", e => {
    e.preventDefault();
    loadDirectoryView();
  });

  // Render inicial de likes locales
  renderLocalLikesSection();

  // Botones internos de la vista playlists
  document.getElementById("plvNewBtn").addEventListener("click", () => {
    const form = document.getElementById("plvCreateForm");
    if (!form) return;
    const visible = form.style.display !== "none";
    form.style.display = visible ? "none" : "flex";
    if (!visible) {
      const inp = document.getElementById("plvNewName");
      if (inp) {
        inp.focus();
        inp.addEventListener("keydown", function handler(e) {
          if (e.key === "Enter") _plvCrear();
          if (e.key === "Escape") { _plvCerrarForm(); inp.removeEventListener("keydown", handler); }
        });
      }
    }
  });
  document.getElementById("plvBackBtn").addEventListener("click", () => {
    _plvMostrarIndice();
    renderPlaylists();
  });

  // Nav tabs filtro
  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.addEventListener("click", e => {
      e.preventDefault();
      applyFilter(tab.getAttribute("data-filter"));
    });
  });

  // Hero botones
  document.getElementById("btnPlayHero").addEventListener("click", () => {
    const anime = heroAnimes[heroIndex];
    if (anime) verDetallesAnime(anime.mal_id);
  });
  document.getElementById("btnFavHero").addEventListener("click", () => {
    const anime = heroAnimes[heroIndex];
    if (anime) toggleFavorite(anime);
  });

  // Recomendados sidebar
  document.querySelectorAll(".popular-item").forEach(item => {
    item.addEventListener("click", function () {
      buscarPorNombreYVer(this.getAttribute("data-search"));
    });
  });

  // ─── [NUEVO] Búsqueda predictiva con debounce ──────────────
  const searchInput = document.getElementById("globalSearchInput");

  // Input: dispara búsqueda tras 300ms de inactividad
  searchInput.addEventListener("input", function() {
    const query = this.value.trim();
    clearTimeout(debounceTimer);

    if (!query) {
      setSearchState("idle");
      return;
    }

    // Feedback visual inmediato antes del debounce
    setSearchState("active");
    document.getElementById("catalogTitle").textContent = `Buscando "${query}"...`;

    debounceTimer = setTimeout(() => {
      buscarPorNombreYVer(query);
    }, DEBOUNCE_MS);
  });

  // Enter: ejecuta búsqueda inmediata cancelando el debounce pendiente
  searchInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && this.value.trim()) {
      clearTimeout(debounceTimer);
      buscarPorNombreYVer(this.value.trim());
    }
    // Escape: limpia el campo y restaura el Home
    if (e.key === "Escape") {
      this.value = "";
      clearTimeout(debounceTimer);
      setSearchState("idle");
    }
  });
  // ─────────────────────────────────────────────────────────────

  // Settings modal
  document.getElementById("btnSettingsToggle").addEventListener("click", () => {
    document.getElementById("settingsModal").classList.add("open");
  });
  document.getElementById("settingsModal").addEventListener("click", e => {
    if (e.target === document.getElementById("settingsModal"))
      document.getElementById("settingsModal").classList.remove("open");
  });

  // Theme toggle
  document.getElementById("themeToggle").addEventListener("change", function() {
    document.documentElement.setAttribute("data-theme", this.checked ? "light" : "dark");
    saveSettings();
  });
  document.getElementById("defaultLangSelect").addEventListener("change", () => {
    idiomaActual = document.getElementById("defaultLangSelect").value;
    saveSettings();
  });
  document.getElementById("preferredServerSelect").addEventListener("change", saveSettings);

  // Account modal
  document.getElementById("btnAccountToggle").addEventListener("click", () => {
    if (currentUser) {
      document.getElementById("authSection").style.display = "none";
      document.getElementById("userSection").style.display = "block";
      document.getElementById("profileUsername").textContent = currentUser.username;
      refreshFavViews();
    } else {
      document.getElementById("authSection").style.display = "block";
      document.getElementById("userSection").style.display = "none";
    }
    document.getElementById("accountModal").classList.add("open");
  });
  document.getElementById("accountModal").addEventListener("click", e => {
    if (e.target === document.getElementById("accountModal"))
      document.getElementById("accountModal").classList.remove("open");
  });

  // Cerrar modals con Escape
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay.open").forEach(m => m.classList.remove("open"));
    }
  });

  // ─── TIMEUPDATE: Guardado de progreso (throttle 5 s) ──────────
  // Guarda cada 5 s para no saturar localStorage con escrituras continuas.
  // Cubre tanto el <video> nativo (.mp4) como el iframe (solo cuando no hay CORS).
  function _onTimeUpdate(videoEl) {
    try {
      const t = videoEl.currentTime;
      if (t > 0 && animeActualMAL?.mal_id && t - _lastSavedTime >= 5) {
        _lastSavedTime = t;
        saveHistory(animeActualMAL.mal_id, numeroEpisodioActual, t);
      }
    } catch(e) {
      // iframe externo bloqueado por CORS — se guarda al cerrar el player
    }
  }

  const videoPlayer  = document.getElementById("videoPlayer");
  const videoNative  = document.getElementById("videoPlayerNative");

  if (videoPlayer) {
    videoPlayer.addEventListener("timeupdate", () => _onTimeUpdate(videoPlayer));
  }
  if (videoNative) {
    videoNative.addEventListener("timeupdate", () => _onTimeUpdate(videoNative));
  }

  // ─── popstate: soporte del botón atrás del navegador ────────
  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(location.search);
    const aid = params.get("anime_id");
    const ep  = params.get("ep");
    if (!aid) {
      setSearchState("idle");
      // Detener reproductor si estaba activo
      const iframe = document.getElementById("videoPlayer");
      const native = document.getElementById("videoPlayerNative");
      if (iframe) { iframe.style.display = "none"; iframe.src = ""; }
      if (native) { native.style.display = "none"; native.src = ""; }
      mostrarVista("homeView");
    } else if (!ep) {
      const iframe = document.getElementById("videoPlayer");
      const native = document.getElementById("videoPlayerNative");
      if (iframe) { iframe.style.display = "none"; iframe.src = ""; }
      if (native) { native.style.display = "none"; native.src = ""; }
    }
  });

  // ─── Carga inicial + Deep Linking robusto ────
  loadAnime().then(async () => {
    renderFollowingToday();
    renderContinueWatching();

    const params  = new URLSearchParams(location.search);
    const animeId = params.get("anime_id");
    const epNum   = params.get("ep");

    if (animeId) {
      // [NUEVO] Deep linking robusto: busca en catálogo local primero,
      // y si no lo encuentra hace fetch directo a Jikan por ID.
      const tryOpen = async (retries) => {
        let found = localAnimeData.find(a => a.mal_id == animeId);

        if (!found && retries === 0) {
          // Último recurso: obtener el anime directamente por ID desde Jikan
          found = await fetchAnimeById(animeId);
        }

        if (found) {
          await verDetallesAnime(animeId);
          if (epNum) {
            setTimeout(() => {
              const epList = animeActualBackend?.episodes ||
                             animeActualBackend?.list ||
                             animeActualBackend?.episodeList || [];
              const epObj  = epList.find(e => (e.number || e.episode || e.id) == epNum);
              if (epObj) {
                procesarStreamingEpisodio(epObj);
              } else if (epList.length) {
                const baseUrl = animeActualBackend?.url || "";
                procesarStreamingEpisodio({
                  number: epNum,
                  url: baseUrl
                    ? (baseUrl.endsWith("/") ? `${baseUrl}${epNum}` : `${baseUrl}-${epNum}`)
                    : `https://mock-provider.com/episode-${epNum}`,
                });
              }
            }, 600);
          }
        } else if (retries > 0) {
          setTimeout(() => tryOpen(retries - 1), 800);
        }
      };
      tryOpen(5);
    }
  });
});

// ═══════════════════════════════════════════════════
// NUEVAS FUNCIONALIDADES MÓVIL v2 — RikAnime
// ═══════════════════════════════════════════════════

// ── Bottom Nav Móvil ─────────────────────────────
function mbnGo(dest) {
  document.querySelectorAll(".mbn-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("mobileSearchDrawer")?.classList.remove("open");
  document.getElementById("mobileLibraryDrawer")?.classList.remove("open");

  if (dest === "home") {
    document.getElementById("mbnHome")?.classList.add("active");
    setSearchState("idle");
    mostrarVista("homeView");
    document.getElementById("sideHome")?.click();
  } else if (dest === "airing") {
    document.getElementById("mbnAiring")?.classList.add("active");
    document.getElementById("sideAiring")?.click();
  } else if (dest === "calendar") {
    document.getElementById("sideCalendar")?.click();
  }
}

function mbnToggleLibrary() {
  const drawer  = document.getElementById("mobileLibraryDrawer");
  const searchD = document.getElementById("mobileSearchDrawer");
  const btn     = document.getElementById("mbnMore");
  const isOpen  = drawer?.classList.contains("open");

  document.querySelectorAll(".mbn-btn").forEach(b => b.classList.remove("active"));
  searchD?.classList.remove("open");

  if (isOpen) {
    drawer.classList.remove("open");
  } else {
    drawer.classList.add("open");
    btn?.classList.add("active");
  }
}

function mbnToggleSearch() {
  const drawer = document.getElementById("mobileSearchDrawer");
  const btn    = document.getElementById("mbnSearch");
  const isOpen = drawer?.classList.contains("open");

  document.querySelectorAll(".mbn-btn").forEach(b => b.classList.remove("active"));

  if (isOpen) {
    drawer.classList.remove("open");
  } else {
    drawer.classList.add("open");
    btn?.classList.add("active");
    setTimeout(() => document.getElementById("mobileSearchInput")?.focus(), 320);
  }
}

// Conectar el input móvil a buscarPorNombreYVer
document.addEventListener("DOMContentLoaded", () => {
  const msi = document.getElementById("mobileSearchInput");
  if (msi) {
    let _msiTimer = null;
    msi.addEventListener("input", () => {
      clearTimeout(_msiTimer);
      _msiTimer = setTimeout(() => {
        const q = msi.value.trim();
        if (q) {
          buscarPorNombreYVer(q);
          document.getElementById("mobileSearchDrawer")?.classList.remove("open");
          document.querySelectorAll(".mbn-btn").forEach(b => b.classList.remove("active"));
        }
      }, 320);
    });
    msi.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const q = msi.value.trim();
        if (q) {
          buscarPorNombreYVer(q);
          document.getElementById("mobileSearchDrawer")?.classList.remove("open");
          document.querySelectorAll(".mbn-btn").forEach(b => b.classList.remove("active"));
        }
      }
    });
  }
});

// ── Navegación Anterior / Siguiente Episodio ─────
function navegarEpisodio(delta) {
  const lista = animeActualBackend?.episodes ||
                animeActualBackend?.list ||
                animeActualBackend?.episodeList || [];
  if (!lista.length) return;

  const idx = lista.findIndex(e => String(e.number) === String(numeroEpisodioActual));
  if (idx === -1) return;

  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= lista.length) return;

  const ep = lista[newIdx];
  procesarStreamingEpisodio({
    url:    ep.url    || "",
    number: ep.number || (newIdx + 1),
    title:  ep.title  || `Episodio ${ep.number || newIdx + 1}`,
  });
}

function actualizarBotonesEpNav() {
  const lista = animeActualBackend?.episodes ||
                animeActualBackend?.list ||
                animeActualBackend?.episodeList || [];
  const btnPrev = document.getElementById("btnPrevEp");
  const btnNext = document.getElementById("btnNextEp");
  if (!btnPrev || !btnNext) return;

  const idx = lista.findIndex(e => String(e.number) === String(numeroEpisodioActual));
  btnPrev.disabled = idx <= 0;
  btnNext.disabled = idx === -1 || idx >= lista.length - 1;
}

// ── Fila de Géneros Interactiva ──────────────────
const GENEROS_PRINCIPALES = [
  "Acción","Aventura","Comedia","Drama","Fantasía","Romance",
  "Suspenso","Terror","Ciencia Ficción","Magia","Deportes","Misterio",
  "Slice of Life","Sobrenatural","Psicológico","Isekai",
];

let generoActivo = null;

function buildGenreFilter() {
  const row = document.getElementById("genreFilterRowHome");
  if (!row) return;
  row.innerHTML = "";

  // Botón "Todos"
  const all = document.createElement("button");
  all.className = "genre-pill active";
  all.textContent = "✦ Todos";
  all.onclick = () => filtrarPorGenero(null, all);
  row.appendChild(all);

  GENEROS_PRINCIPALES.forEach(g => {
    const pill = document.createElement("button");
    pill.className = "genre-pill";
    pill.textContent = g;
    pill.onclick = () => filtrarPorGenero(g, pill);
    row.appendChild(pill);
  });
}

// IDs de géneros en MAL/Jikan
const GEN_MAP = {
  "Acción":          { en: ["Action"],              id: 1  },
  "Aventura":        { en: ["Adventure"],            id: 2  },
  "Comedia":         { en: ["Comedy"],               id: 4  },
  "Drama":           { en: ["Drama"],                id: 8  },
  "Fantasía":        { en: ["Fantasy"],              id: 10 },
  "Romance":         { en: ["Romance"],              id: 22 },
  "Suspenso":        { en: ["Thriller","Suspense"],  id: 41 },
  "Terror":          { en: ["Horror"],               id: 14 },
  "Ciencia Ficción": { en: ["Sci-Fi","Science Fiction"], id: 24 },
  "Magia":           { en: ["Magic"],                id: 16 },
  "Deportes":        { en: ["Sports"],               id: 30 },
  "Misterio":        { en: ["Mystery"],              id: 7  },
  "Slice of Life":   { en: ["Slice of Life"],        id: 36 },
  "Sobrenatural":    { en: ["Supernatural"],         id: 37 },
  "Psicológico":     { en: ["Psychological"],        id: 40 },
  "Isekai":          { en: ["Isekai"],               id: 62 },
};

const _genreCache = {}; // genero → resultados ya descargados

async function filtrarPorGenero(genero, pillEl) {
  generoActivo = genero;
  document.querySelectorAll(".genre-pill").forEach(p => p.classList.remove("active"));
  pillEl.classList.add("active");

  if (!genero) {
    renderGrid(filteredAnimeData);
    return;
  }

  const meta    = GEN_MAP[genero];
  const aliases = meta?.en || [genero];

  // 1) Primero mostrar lo que ya hay en memoria al instante
  const local = localAnimeData.filter(a =>
    Array.isArray(a.genres) && a.genres.some(g => aliases.includes(g.name))
  );
  if (local.length) renderGrid(local);

  // 2) Si ya tenemos caché de Jikan para este género, usarlo directamente
  if (_genreCache[genero]) {
    renderGrid(_genreCache[genero]);
    if (_genreCache[genero].length === 0)
      showToast(`No se encontraron animes de "${genero}"`, "error");
    return;
  }

  // 3) Consultar Jikan por genre_id (trae hasta 25 resultados por página)
  if (!meta?.id) {
    if (!local.length) showToast(`No hay animes de "${genero}" cargados`, "error");
    return;
  }

  try {
    const [p1, p2] = await Promise.all([
      fetch(`${JIKAN}/anime?genres=${meta.id}&order_by=score&sort=desc&limit=25&page=1`).then(r => r.json()),
      fetch(`${JIKAN}/anime?genres=${meta.id}&order_by=score&sort=desc&limit=25&page=2`).then(r => r.json()),
    ]);

    const nuevos = [...(p1.data || []), ...(p2.data || [])]
      .filter(a => !esContenidoAdulto(a));

    // Merge en localAnimeData sin duplicados
    nuevos.forEach(a => {
      if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a);
    });

    // Combinar locales + jikan para este género
    const todos = localAnimeData.filter(a =>
      Array.isArray(a.genres) && a.genres.some(g => aliases.includes(g.name))
    );

    _genreCache[genero] = todos;
    renderGrid(todos);

    if (!todos.length) showToast(`No se encontraron animes de "${genero}"`, "error");
  } catch (err) {
    console.warn("[Géneros]", err.message);
    if (!local.length) showToast(`Error al buscar "${genero}"`, "error");
  }
}

// Llamar actualizarBotonesEpNav cada vez que se carga un episodio
// Se engancha dentro de procesarStreamingEpisodio — patch no destructivo
const _origPSE = procesarStreamingEpisodio;
procesarStreamingEpisodio = async function(episodeObj) {
  await _origPSE(episodeObj);
  actualizarBotonesEpNav();
};
// ═══════════════════════════════════════════════════
// PAGINACIÓN DEL CATÁLOGO
// ═══════════════════════════════════════════════════

let _catalogPage    = 1;
let _catalogTotal   = 1;
const CATALOG_LIMIT = 24;

async function loadCatalogPage(page) {
  const grid   = document.getElementById("animeGrid");
  const pgInfo = document.getElementById("paginationInfo");
  const btnPrev = document.getElementById("btnCatalogPrev");
  const btnNext = document.getElementById("btnCatalogNext");

  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:2rem;">
    <i class="fas fa-spinner fa-spin"></i> Cargando página ${page}...
  </p>`;

  try {
    const res  = await fetch(`${JIKAN}/top/anime?limit=${CATALOG_LIMIT}&page=${page}`);
    const data = await res.json();

    const items = (data.data || []).filter(a => !esContenidoAdulto(a));
    _catalogPage  = data.pagination?.current_page || page;
    _catalogTotal = data.pagination?.last_visible_page || 1;

    // Merge en local sin duplicados
    items.forEach(a => {
      if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a);
    });
    filteredAnimeData = items;
    renderGrid(items);

    if (pgInfo) pgInfo.textContent = `Página ${_catalogPage} de ${_catalogTotal}`;
    if (btnPrev) btnPrev.disabled = _catalogPage <= 1;
    if (btnNext) btnNext.disabled = _catalogPage >= _catalogTotal;

    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch(err) {
    console.error("[Paginación]", err.message);
  }
}

function catalogPrev() {
  if (_catalogPage > 1) loadCatalogPage(_catalogPage - 1);
}

function catalogNext() {
  if (_catalogPage < _catalogTotal) loadCatalogPage(_catalogPage + 1);
}

// ═══════════════════════════════════════════════════
// DIRECTORIO CON FILTRADO AVANZADO
// ═══════════════════════════════════════════════════

let _dirResults       = [];
let _dirFilterOpen    = false;

const DIR_GENRES = [
  "Action","Adventure","Comedy","Drama","Fantasy","Romance",
  "Horror","Mystery","Sci-Fi","Slice of Life","Sports","Supernatural",
  "Psychological","Thriller","Magic","Isekai","Mecha","Music",
];
const DIR_DEMOGRAPHICS = ["Shounen","Shoujo","Seinen","Josei","Kids"];
const DIR_TYPES        = ["TV","Movie","OVA","ONA","Special","Music"];
const DIR_STATUS       = ["airing","complete","upcoming"];
const DIR_STATUS_LABEL = { airing: "En Emisión", complete: "Finalizado", upcoming: "Próximamente" };
const DIR_SEASONS      = ["winter","spring","summer","fall"];
const DIR_SEASONS_LABEL = { winter:"Invierno", spring:"Primavera", summer:"Verano", fall:"Otoño" };
const DIR_LETTERS      = ["#","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z"];
const DIR_YEARS_START  = 1980;

async function loadDirectoryView() {
  mostrarVista("directoryView");
  document.getElementById("sideDirectory")?.classList.add("active");

  const grid = document.getElementById("dirGrid");
  if (grid && grid.children.length === 0) {
    grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;">
      <i class="fas fa-filter"></i> Usa los filtros y presiona <strong>Filtrar</strong> para buscar.
    </p>`;
  }
  _buildDirYearOptions();
}

function _buildDirYearOptions() {
  const sel = document.getElementById("dirYear");
  if (!sel || sel.options.length > 1) return;
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= DIR_YEARS_START; y--) {
    const opt = document.createElement("option");
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  }
}

async function applyDirectoryFilters() {
  const grid    = document.getElementById("dirGrid");
  const orderBy = document.getElementById("dirOrderBy")?.value || "score";
  const genre   = document.getElementById("dirGenre")?.value   || "";
  const letter  = document.getElementById("dirLetter")?.value  || "";
  const demo    = document.getElementById("dirDemographic")?.value || "";
  const type    = document.getElementById("dirType")?.value    || "";
  const status  = document.getElementById("dirStatus")?.value  || "";
  const year    = document.getElementById("dirYear")?.value    || "";
  const season  = document.getElementById("dirSeason")?.value  || "";

  if (!grid) return;
  grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;">
    <i class="fas fa-spinner fa-spin"></i> Buscando...
  </p>`;

  // Construir parámetros para Jikan
  const params = new URLSearchParams();
  params.set("limit", "24");
  params.set("sfw", "true");
  if (orderBy)  params.set("order_by", orderBy);
  if (genre)    params.set("genres",   genre);
  if (letter && letter !== "#") params.set("letter", letter);
  if (type)     params.set("type",     type);
  if (status)   params.set("status",   status);
  if (year)     params.set("start_date", `${year}-01-01`);

  // Si hay temporada + año, usar /seasons endpoint
  let url = `${JIKAN}/anime?${params.toString()}`;
  if (season && year) {
    url = `${JIKAN}/seasons/${year}/${season}?limit=24&sfw=true`;
  } else if (season) {
    url = `${JIKAN}/seasons/now?limit=24&sfw=true`;
  }

  try {
    const res  = await fetch(url);
    const data = await res.json();
    let results = (data.data || []).filter(a => !esContenidoAdulto(a));

    // Filtrar demografía (no disponible como param en Jikan v4 genérico)
    if (demo) {
      results = results.filter(a =>
        (a.demographics || []).some(d => d.name.toLowerCase() === demo.toLowerCase()) ||
        (a.themes       || []).some(d => d.name.toLowerCase() === demo.toLowerCase())
      );
    }

    // Merge en catálogo local
    results.forEach(a => {
      if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a);
    });

    _dirResults = results;
    _renderDirGrid(results);
  } catch(err) {
    console.error("[Directorio]", err.message);
    grid.innerHTML = `<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:3rem;">
      <i class="fas fa-exclamation-triangle"></i> Error al buscar. Intenta de nuevo.
    </p>`;
  }
}

function _renderDirGrid(results) {
  const grid = document.getElementById("dirGrid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!results.length) {
    grid.innerHTML = `<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:3rem;">
      <i class="fas fa-search"></i> Sin resultados. Prueba otros filtros.
    </p>`;
    return;
  }
  results.forEach(anime => {
    const card = document.createElement("div");
    card.className = "anime-card";
    card.style.position = "relative";
    card.innerHTML = `
      <div class="anime-poster" style="background-image:url('${anime.images?.jpg?.image_url || ""}')">
        <span class="anime-type-badge">${anime.type || "TV"}</span>
      </div>
      <div class="anime-info">
        <div class="anime-title">${anime.title}</div>
        <div class="anime-rating"><i class="fas fa-star"></i> ${anime.score || "N/A"}</div>
        <div class="anime-genres">${(anime.genres || []).map(g => g.name).slice(0,2).join(", ")}</div>
      </div>
    `;
    const likeBtn = createLikeBtn(anime);
    card.querySelector(".anime-poster").appendChild(likeBtn);
    card.addEventListener("click", () => verDetallesAnime(anime.mal_id));
    grid.appendChild(card);
  });
}

function dirRandomAnime() {
  const pool = _dirResults.length ? _dirResults : localAnimeData;
  if (!pool.length) { showToast("Cargando catálogo... intenta de nuevo", "error"); return; }
  const randomAnime = pool[Math.floor(Math.random() * pool.length)];
  showToast(`🎲 Abriendo: ${randomAnime.title}`);
  setTimeout(() => verDetallesAnime(randomAnime.mal_id), 400);
}

function toggleDirFilters() {
  _dirFilterOpen = !_dirFilterOpen;
  const panel = document.getElementById("dirFilterPanel");
  if (panel) {
    panel.classList.toggle("dir-filters-open", _dirFilterOpen);
  }
  const btn = document.getElementById("dirToggleFiltersBtn");
  if (btn) {
    btn.innerHTML = _dirFilterOpen
      ? `<i class="fas fa-times"></i> Ocultar Filtros`
      : `<i class="fas fa-sliders-h"></i> Mostrar Filtros`;
  }
}

// ═══════════════════════════════════════════════════
// AUTOPLAY (Controles de Maratón)
// ═══════════════════════════════════════════════════

let _autoplayTimer  = null;
let _autoplayCount  = 10;
let _autoplayActive = false;
let _autoplayPaused = false;  // NEW: tracks if the user paused the countdown

// Autoplay: appears when ~10s remain (native) or via timer (iframe)
function _initAutoplay() {
  const native = document.getElementById("videoPlayerNative");

  // For native video
  if (native && native.style.display !== "none") {
    native.addEventListener("timeupdate", function _ap() {
      const remaining = native.duration - native.currentTime;
      if (!isNaN(remaining) && remaining <= 10 && remaining > 0 && !_autoplayActive) {
        _autoplayActive = true;
        _showAutoplayCard();
        native.removeEventListener("timeupdate", _ap);
      }
    });
    return;
  }

  // For iframe: show autoplay after estimated time (20 min), only if next episode exists
  const lista = animeActualBackend?.episodes || animeActualBackend?.list || animeActualBackend?.episodeList || [];
  const idx   = lista.findIndex(e => String(e.number) === String(numeroEpisodioActual));
  if (idx === -1 || idx >= lista.length - 1) return; // no next episode

  const IFRAME_AUTOPLAY_MS = 20 * 60 * 1000; // 20 min
  _autoplayTimer = setTimeout(() => {
    if (!_autoplayActive) {
      _autoplayActive = true;
      _showAutoplayCard();
    }
  }, IFRAME_AUTOPLAY_MS);
}

function _showAutoplayCard() {
  const lista  = animeActualBackend?.episodes ||
                 animeActualBackend?.list ||
                 animeActualBackend?.episodeList || [];
  const idx    = lista.findIndex(e => String(e.number) === String(numeroEpisodioActual));
  const nextEp = lista[idx + 1];
  if (!nextEp) return;

  const existing = document.getElementById("autoplayCard");
  if (existing) existing.remove();

  const anime = animeActualMAL;
  const img   = anime?.images?.jpg?.image_url || "";
  const title = anime?.title || "Siguiente episodio";

  const card = document.createElement("div");
  card.id        = "autoplayCard";
  card.className = "autoplay-card";
  card.innerHTML = `
    <div class="apc-loading-overlay" id="apcLoadingOverlay" style="display:none;">
      <div class="apc-spinner"></div>
      <span>Cargando episodio...</span>
    </div>
    <div class="apc-poster" style="background-image:url('${img}')"></div>
    <div class="apc-info">
      <div class="apc-label">A continuación</div>
      <div class="apc-title">${title}</div>
      <div class="apc-ep">Episodio ${nextEp.number || idx + 2}</div>
      <div class="apc-bar"><div class="apc-bar-fill" id="apcBarFill"></div></div>
      <div class="apc-actions">
        <button class="apc-play" id="apcPlayBtn">
          <i class="fas fa-play"></i> Reproducir (<span id="apcCount">10</span>s)
        </button>
        <button class="apc-pause" id="apcPauseBtn" title="Pausar cuenta regresiva">
          <i class="fas fa-pause"></i>
        </button>
        <button class="apc-cancel" onclick="cancelarAutoplay()">Cancelar</button>
      </div>
    </div>
  `;

  const wrap = document.getElementById("playerVideoWrap");
  if (wrap) wrap.appendChild(card);

  document.getElementById("apcPlayBtn").onclick = () => {
    _triggerAutoplayNext(nextEp, idx);
  };

  // NEW: pause/resume button for the countdown
  const pauseBtn = document.getElementById("apcPauseBtn");
  pauseBtn.onclick = () => {
    _autoplayPaused = !_autoplayPaused;
    pauseBtn.innerHTML = _autoplayPaused
      ? `<i class="fas fa-play"></i>`
      : `<i class="fas fa-pause"></i>`;
    pauseBtn.title = _autoplayPaused ? "Reanudar cuenta regresiva" : "Pausar cuenta regresiva";
  };

  _autoplayCount  = 10;
  _autoplayPaused = false;
  const fill    = document.getElementById("apcBarFill");
  const counter = document.getElementById("apcCount");

  _autoplayTimer = setInterval(() => {
    if (_autoplayPaused) return; // respect pause
    _autoplayCount--;
    if (counter) counter.textContent = _autoplayCount;
    if (fill)    fill.style.width    = `${(10 - _autoplayCount) * 10}%`;
    if (_autoplayCount <= 0) {
      _triggerAutoplayNext(nextEp, idx);
    }
  }, 1000);
}

// NEW: shows loading state then navigates
function _triggerAutoplayNext(nextEp, idx) {
  clearInterval(_autoplayTimer);
  _autoplayActive = false;

  // Show loading overlay on the card
  const overlay = document.getElementById("apcLoadingOverlay");
  const actionsEl = document.querySelector(".apc-actions");
  if (overlay) overlay.style.display = "flex";
  if (actionsEl) actionsEl.style.display = "none";

  // Brief delay to let loading show, then navigate
  setTimeout(() => {
    const card = document.getElementById("autoplayCard");
    if (card) card.remove();
    navegarEpisodio(1);
  }, 600);
}

function cancelarAutoplay() {
  clearInterval(_autoplayTimer);
  clearTimeout(_autoplayTimer);
  _autoplayActive = false;
  _autoplayPaused = false;
  const card = document.getElementById("autoplayCard");
  if (card) card.remove();
}

// Hook _initAutoplay after loading into player
const _origCargarEnPlayer = cargarEnPlayer;
cargarEnPlayer = function(url) {
  _origCargarEnPlayer(url);
  cancelarAutoplay();
  // Wait for video to be visible and have src
  setTimeout(() => {
    _initAutoplay();
  }, 800);
};

// ── Sincronizar al cargar la app ──────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadUser();
  if (localStorage.getItem("rik_jwt") && currentUser) {
    syncUserFromServer();
  }
});
