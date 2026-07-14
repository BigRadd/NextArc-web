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
const BASE_URL  = "https://rikanime.onrender.com/api/v1/anime";
const USERS_URL = "https://rikanime.onrender.com/api/users";
const JIKAN     = "https://api.jikan.moe/v4"; // original, no usar directo
const JIKAN_PROXY = `${BASE_URL}/jikan`; // proxy via Render
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
  // Si el anime ya está en contexto, ir directo
  if (animeActualMAL && animeActualMAL.mal_id == malId && animeActualBackend) {
    const epList = animeActualBackend?.episodes ||
                   animeActualBackend?.list ||
                   animeActualBackend?.episodeList || [];
    const epObj = epList.find(e => (e.number || e.episode || e.id) == epNumber);
    if (epObj) { procesarStreamingEpisodio(epObj); return; }
  }
  // Reutilizar abrirEpisodioDirecto (mismo comportamiento sin flash de detailsView)
  await abrirEpisodioDirecto(malId, epNumber);
}

// ─── ABRIR EPISODIO DIRECTO DESDE "CAPÍTULOS RECIENTES" ─────
async function abrirEpisodioDirecto(malId, epNumber) {
  // Si el anime ya está en contexto, ir directo al episodio
  if (animeActualMAL && animeActualMAL.mal_id == malId && animeActualBackend) {
    const epList = animeActualBackend?.episodes ||
                   animeActualBackend?.list ||
                   animeActualBackend?.episodeList || [];
    const epObj = epList.find(e => (e.number || e.episode || e.id) == epNumber);
    if (epObj) { procesarStreamingEpisodio(epObj); return; }
  }

  // Asegurar que el anime esté en localAnimeData (puede venir de _recentEpsCache)
  let anime = localAnimeData.find(a => a.mal_id == malId);
  if (!anime) {
    anime = await fetchAnimeById(malId);
    if (!anime) { showToast("No se pudo cargar el anime", "error"); return; }
  }

  // Setear contexto MAL sin cambiar de vista
  animeActualMAL     = anime;
  animeActualBackend = null;
  esModoDemoActivo   = false;
  pushUrl(malId, epNumber);

  // Construir el episodio con URL provisional y abrir el player YA
  const provisionalEp = { number: epNumber, url: "" };
  procesarStreamingEpisodio(provisionalEp);

  // Cargar datos del backend en segundo plano y actualizar la lista de episodios del sidebar
  try {
    const searchRes = await fetch(`${BASE_URL}/search?q=${encodeURIComponent(anime.title)}`, { headers: apiHeaders });
    if (searchRes.ok) {
      const r = await searchRes.json();
      let resultsArray = [];
      if (r?.success && r.data) resultsArray = Array.isArray(r.data) ? r.data : (r.data.results || []);

      if (resultsArray.length > 0) {
        const infoRes = await fetch(`${BASE_URL}/info?url=${encodeURIComponent(resultsArray[0].url)}`, { headers: apiHeaders });
        if (infoRes.ok) {
          const infoResult = await infoRes.json();
          if (infoResult?.success && infoResult.data) {
            animeActualBackend = infoResult.data;
            try { sessionStorage.setItem(`nextarc_info_${malId}`, JSON.stringify(infoResult.data)); } catch {}

            // Actualizar la URL del episodio en curso si ahora la tenemos
            const epList = animeActualBackend.episodes || animeActualBackend.list || animeActualBackend.episodeList || [];
            const epObj  = epList.find(e => (e.number || e.episode || e.id) == epNumber);
            if (epObj && epObj.url) {
              // Recargar el episodio con la URL real (ya estamos en playerView)
              procesarStreamingEpisodio(epObj);
            }
            // Reconstruir lista de episodios en el sidebar
            construirListaEpisodios(epList);
            return;
          }
        }
      }
    }
  } catch(e) {
    console.warn("[abrirEpisodioDirecto backend]", e.message);
  }

  // Sin backend: crear lista de episodios de fallback
  const totalEps = typeof anime.episodes === "number" && anime.episodes > 0 ? anime.episodes : 12;
  animeActualBackend = {
    title: anime.title, url: "",
    episodes: Array.from({ length: totalEps }, (_, i) => ({ number: i + 1, url: "" })),
  };
  construirListaEpisodios(animeActualBackend.episodes);
}

/* [PATCHED v4] function renderContinueWatching() { */
function renderContinueWatching_ORIG() {
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
/* [PATCHED v4] */ function setSearchState_ORIG(state) {
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
        : "Puede Interesarte";
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
  history.pushState({}, "", location.pathname.split("?")[0] || "/");
}

// [NUEVO] Fallback de deep linking: obtiene un anime por ID directamente desde Jikan
// cuando NO está en el catálogo local (p. ej. URL compartida de búsqueda)
async function fetchAnimeById(malId) {
  try {
    const res  = await fetch(`${JIKAN_PROXY}/anime/${malId}`, { headers: apiHeaders });
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
const VIEWS = ["homeView", "detailsView", "airingView", "calendarView", "favoritesView", "playlistsView", "playerView", "directoryView", "sectionPageView"];

/* [PATCHED v4] */ function mostrarVista_ORIG(vista) {
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
  `${JIKAN_PROXY}/top/anime?limit=25&filter=airing`,
  `${JIKAN_PROXY}/top/anime?limit=25&filter=bypopularity`,
  `${JIKAN_PROXY}/top/anime?limit=25&filter=favorite`,
  `${JIKAN_PROXY}/seasons/now?limit=25`,
  `${JIKAN_PROXY}/top/anime?limit=25&page=2`,
  `${JIKAN_PROXY}/top/anime?limit=25&page=3`,
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
    const resMain = await fetch(`${JIKAN_PROXY}/top/anime?limit=24`, { headers: apiHeaders });
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
    loadRecentEpisodes(); // [NUEVO] Capítulos Recientes
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
    if (titleEl) titleEl.textContent = "Puede Interesarte";
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
  document.getElementById("airingGrid").innerHTML = `<p style="color:var(--accent);grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> Cargando...</p>`;

  try {
    const res  = await fetch(`${JIKAN_PROXY}/seasons/now?limit=24`, { headers: apiHeaders });
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
    const res  = await fetch(`${JIKAN_PROXY}/seasons/now?limit=8`, { headers: apiHeaders });
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

/* [PATCHED v4] */ async function loadCalendarView_ORIG() {
  mostrarVista("calendarView");
  if (calendarDataCache) { renderCalendar(calendarDataCache); return; }

  document.getElementById("calendarStatus").textContent = "Cargando...";
  document.getElementById("calendarGrid").innerHTML = `<p style="color:var(--accent);"><i class="fas fa-spinner fa-spin"></i> Cargando...</p>`;

  try {
    const res  = await fetch(`${JIKAN_PROXY}/schedules`, { headers: apiHeaders });
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

/* [PATCHED v4] */ function renderCalendar_ORIG(animes) {
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
    const rawData = result.data;

    // ── Detectar TODOS los idiomas disponibles en servers y streamLinks ──
    const serversObj = rawData.servers || {};
    const streamObj  = rawData.streamLinks || {};
    const dlObj      = rawData.downloadLinks || {};

    // Unificar en un mapa normalizado: { "sub": [...], "lat": [...], "esp": [...], etc. }
    const allLangs = {};
    for (const [key, val] of Object.entries(serversObj)) {
      if (Array.isArray(val) && val.length) allLangs[key.toLowerCase()] = val;
    }
    for (const [key, val] of Object.entries(streamObj)) {
      const k = key.toLowerCase();
      if (Array.isArray(val) && val.length) allLangs[k] = (allLangs[k] || []).concat(val);
    }

    // Etiquetas legibles para los idiomas conocidos
    const LANG_LABELS = {
      sub: "SUB", dub: "DUB", lat: "Lat.", esp: "Esp.", en: "ENG",
      "es-la": "Lat.", "es-es": "Esp.", japanese: "JPN", english: "ENG",
      castellano: "Cast.", latino: "Lat.", subtitulado: "SUB",
    };
    const LANG_PRIORITY = ["sub","lat","esp","dub","en","es-la","es-es","castellano","latino","subtitulado","english","japanese"];
    const availableLangs = [...new Set([
      ...LANG_PRIORITY.filter(l => allLangs[l]),
      ...Object.keys(allLangs).filter(l => !LANG_PRIORITY.includes(l)),
    ])];

    if (availableLangs.length > 0) {
      // Construir selector de idioma dinámico si hay más de uno
      _buildLangSelector(availableLangs, allLangs, dlObj, LANG_LABELS);
      // Seleccionar el idioma activo actual si está disponible, o el primero
      const langToUse = availableLangs.includes(idiomaActual.toLowerCase())
        ? idiomaActual.toLowerCase()
        : availableLangs[0];
      idiomaActual = langToUse;
      servidoresStreamCache   = allLangs[langToUse] || [];
      servidoresDownloadCache = dlObj[langToUse.toUpperCase()] || dlObj[langToUse] ||
        servidoresStreamCache.filter(s => s.url || s.download_url);
      renderizarBotonesDeServidor(servidoresStreamCache);
      return;
    }
  }

  // Sin servidores disponibles
  _mostrarMensajeNoDisponible(serverCont, loader);
}

// ── Constructor del selector de idioma dinámico ──
function _buildLangSelector(langs, allLangs, dlObj, LANG_LABELS) {
  // Buscar el contenedor de botones Sub/Dub existente y reemplazarlo con uno dinámico
  const LANG_LABELS_DEFAULT = {
    sub: "SUB", dub: "DUB", lat: "Lat.", esp: "Esp.", en: "ENG",
    "es-la": "Lat.", "es-es": "Esp.", japanese: "JPN", english: "ENG",
    castellano: "Cast.", latino: "Lat.", subtitulado: "SUB",
  };
  const labels = LANG_LABELS || LANG_LABELS_DEFAULT;

  // Quitar selector anterior si existe
  const existingDyn = document.getElementById("dynLangSelector");
  if (existingDyn) existingDyn.remove();

  // Insertar nuevo selector junto a los botones Sub/Dub originales
  const btnSub = document.getElementById("btnSub");
  const container = btnSub?.parentElement;
  if (!container) return;

  // Ocultar los botones hardcodeados Sub/Dub originales
  const btnDub = document.getElementById("btnDub");
  if (btnSub) btnSub.style.display = "none";
  if (btnDub) btnDub.style.display = "none";

  const dyn = document.createElement("div");
  dyn.id = "dynLangSelector";
  dyn.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";
  
  const labelEl = document.createElement("span");
  labelEl.style.cssText = "font-size:0.75rem;color:var(--text-muted);margin-right:2px;";
  labelEl.textContent = "Audio:";
  dyn.appendChild(labelEl);

  langs.forEach(lang => {
    const btn = document.createElement("button");
    btn.className = "btn-lang-dyn" + (lang === idiomaActual.toLowerCase() ? " active" : "");
    btn.dataset.lang = lang;
    btn.textContent = labels[lang] || lang.toUpperCase();
    btn.style.cssText = `
      padding:4px 12px; border-radius:6px; font-size:0.8rem; font-weight:600; cursor:pointer;
      border:1px solid var(--border); background:var(--bg-elevated); color:var(--text-secondary);
      transition:all 0.15s;
    `;
    btn.addEventListener("click", () => {
      idiomaActual = lang;
      document.querySelectorAll(".btn-lang-dyn").forEach(b => {
        b.classList.toggle("active", b.dataset.lang === lang);
        b.style.background = b.dataset.lang === lang ? "var(--accent)" : "var(--bg-elevated)";
        b.style.color      = b.dataset.lang === lang ? "#0a0a18" : "var(--text-secondary)";
      });
      servidoresStreamCache   = allLangs[lang] || [];
      servidoresDownloadCache = dlObj[lang.toUpperCase()] || dlObj[lang] ||
        servidoresStreamCache.filter(s => s.url || s.download_url);
      renderizarBotonesDeServidor(servidoresStreamCache);
    });
    // Estilo activo inicial
    if (lang === idiomaActual.toLowerCase()) {
      btn.style.background = "var(--accent)";
      btn.style.color      = "#0a0a18";
    }
    dyn.appendChild(btn);
  });

  container.insertBefore(dyn, btnSub);
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
}

// ─── [NUEVO] PERSONAJES (JIKAN) ─────────────────────
async function fetchCharacters(malId) {
  try {
    const res  = await fetch(`${JIKAN_PROXY}/anime/${malId}/characters`, { headers: apiHeaders });
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
          url
        }
        episodes
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
  // AniList NO garantiza orden por número. Extraer el número del título del episodio.
  // Títulos posibles: "Episode 5", "Ep. 5", "5. Title", "Episode 5 - Title"
  let aniEp = null;
  for (const ep of aniEps) {
    if (!ep?.title) continue;
    const numMatch = ep.title.match(/(?:episode|ep\.?)\s*(\d+)/i) || ep.title.match(/^(\d+)[.\s]/);
    if (numMatch && parseInt(numMatch[1]) === epNumber) { aniEp = ep; break; }
  }
  // Fallback: posición por índice si no se encontró por título
  if (!aniEp && aniEps[epNumber - 1]?.thumbnail) aniEp = aniEps[epNumber - 1];
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
    const res  = await fetch(`${JIKAN_PROXY}/anime/${animeId}/episodes`, { headers: apiHeaders });
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
  // [NUEVO] Subtítulo del anime: muestra el título alternativo
  const detAltTitleEl = document.getElementById("detAltTitle");
  if (detAltTitleEl) {
    const altTitle = (anime.title_english && anime.title_english !== anime.title)
      ? anime.title_english
      : (anime.title_japanese && anime.title_japanese !== anime.title)
        ? anime.title_japanese
        : "";
    detAltTitleEl.textContent = altTitle;
    detAltTitleEl.style.display = altTitle ? "block" : "none";
  }
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

  if (epGrid) epGrid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> Cargando...</p>`;

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

      if (animeActualBackend.title) {
        document.getElementById("detTitle").textContent = animeActualBackend.title;
        // Keep alt title visible (already set from MAL data above)
      }
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
    const res = await fetch(
  `${BASE_URL}/search?q=${encodeURIComponent(query)}&domain=animeav1.com`,
  { headers: apiHeaders }
);
const data = await res.json();
const seguros = (data?.data?.results || data?.data || []).filter(a => !esContenidoAdulto(a));

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
  // Determinar si hay una ruta especial ANTES de mostrar el home,
  // para evitar el flash de la vista de inicio cuando se recarga en otro contexto.
  const _initParams  = new URLSearchParams(location.search);
  const _initAnimeId = _initParams.get("anime_id");
  const _initEp      = _initParams.get("ep");
  const _initGenero  = _initParams.get("g");
  const _initView    = _initParams.get("view");
  const _initPath    = location.pathname;

  // Si vamos a cargar algo que no es el home, ocultar todas las vistas
  // y mostrar solo un spinner hasta que la carga esté lista.
  const _hasDeepLink = _initAnimeId || _initGenero || _initView ||
    (_initPath && _initPath !== "/" && _initPath !== "");

  // Anti-flash manejado en <head> del index.html

  loadAnime().then(async () => {
    renderFollowingToday();
    renderContinueWatching();

    const params  = new URLSearchParams(location.search);
    const animeId = params.get("anime_id");
    const epNum   = params.get("ep");
    const generoG = params.get("g");

    // Deep-link de género: ?g=aventura
    const viewParam = params.get("view");
    if (viewParam && !animeId) {
      switch(viewParam) {
        case "calendario": loadCalendarView(); return;
        case "airing":     loadAiringView();  return;
        case "directorio": loadDirectoryView(); return;
      }
    }

    if (generoG && !animeId) {
      loadGeneroPage(generoG);
      return;
    }

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
          if (epNum) {
            // Con episodio: ir directo al player sin mostrar detailsView
            await abrirEpisodioDirecto(animeId, epNum);
          } else {
            await verDetallesAnime(animeId);
          }
        } else if (retries > 0) {
          setTimeout(() => tryOpen(retries - 1), 800);
        } else {
          // No se encontró el anime — ir al home
          navigateTo("homeView");
        }
      };
      tryOpen(5);
    } else {
      // Sin deep link: mostrar el home normalmente
      navigateTo("homeView");
      // Resolver rutas de path distintas a "/" (ej: /populares, /temporada)
      const path = location.pathname;
      if (path && path !== "/" && ROUTES[path]) {
        resolveRoute(path);
      }
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
  "Mecha","Música","Escolar","Histórico","Artes Marciales",
  "Parodia","Samurái","Demonio","Espacial","Militar","Vampiro",
  "Harem","Josei","Seinen","Shounen","Shoujo","Niños",
];

let generoActivo = null;

function buildGenreFilter() {
  const row = document.getElementById("genreFilterRowHome");
  if (!row) return;
  row.innerHTML = "";

  // ── Inyectar CSS con alta especificidad para el scroll ──
  if (!document.getElementById("genreRowScrollStyle")) {
    const s = document.createElement("style");
    s.id = "genreRowScrollStyle";
    s.textContent = `
      #genreFilterRowHome {
        display: flex !important;
        flex-wrap: nowrap !important;
        overflow-x: auto !important;
        overflow-y: visible !important;
        gap: 6px !important;
        padding: 4px 0 10px 0 !important;
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
        -webkit-overflow-scrolling: touch !important;
        touch-action: pan-x !important;
        width: 100% !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
        cursor: grab !important;
      }
      #genreFilterRowHome::-webkit-scrollbar { display: none !important; }
      #genreFilterRowHome .genre-pill {
        flex: 0 0 auto !important;
        white-space: nowrap !important;
        touch-action: manipulation !important;
        user-select: none !important;
        -webkit-user-select: none !important;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Forzar overflow en el contenedor padre — solo width, sin tocar overflow ──
  if (row.parentElement) {
    row.parentElement.style.maxWidth = "100%";
  }

  // ── Drag-to-scroll con mouse (escritorio) ──
  let _genreIsDown = false, _genreStartX = 0, _genreScrollLeft = 0;
  row.addEventListener("mousedown", e => {
    _genreIsDown   = true;
    _genreStartX   = e.pageX - row.offsetLeft;
    _genreScrollLeft = row.scrollLeft;
    row.style.cursor = "grabbing";
  });
  row.addEventListener("mouseleave", () => { _genreIsDown = false; row.style.cursor = "grab"; });
  row.addEventListener("mouseup",    () => { _genreIsDown = false; row.style.cursor = "grab"; });
  row.addEventListener("mousemove",  e => {
    if (!_genreIsDown) return;
    e.preventDefault();
    const x    = e.pageX - row.offsetLeft;
    const walk = (x - _genreStartX) * 1.5;
    row.scrollLeft = _genreScrollLeft - walk;
  });

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
  // Géneros adicionales
  "Mecha":           { en: ["Mecha"],                id: 18 },
  "Música":          { en: ["Music"],                id: 19 },
  "Escolar":         { en: ["School"],               id: 23 },
  "Histórico":       { en: ["Historical"],           id: 13 },
  "Artes Marciales": { en: ["Martial Arts"],         id: 17 },
  "Parodia":         { en: ["Parody"],               id: 20 },
  "Samurái":         { en: ["Samurai"],              id: 21 },
  "Demonio":         { en: ["Demons"],               id: 6  },
  "Espacial":        { en: ["Space"],                id: 29 },
  "Militar":         { en: ["Military"],             id: 38 },
  "Vampiro":         { en: ["Vampire"],              id: 32 },
  "Harem":           { en: ["Harem"],                id: 35 },
  "Josei":           { en: ["Josei"],                id: 43 },
  "Seinen":          { en: ["Seinen"],               id: 42 },
  "Shounen":         { en: ["Shounen"],              id: 27 },
  "Shoujo":          { en: ["Shoujo"],               id: 25 },
  "Niños":           { en: ["Kids"],                 id: 15 },
};

const _genreCache = {}; // genero → resultados ya descargados

/* [PATCHED v4] */ async function filtrarPorGenero_ORIG(genero, pillEl) {
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
      fetch(`${JIKAN_PROXY}/anime?genres=${meta.id}&order_by=score&sort=desc&limit=25&page=1`, { headers: apiHeaders }).then(r => r.json()),
      fetch(`${JIKAN_PROXY}/anime?genres=${meta.id}&order_by=score&sort=desc&limit=25&page=2`, { headers: apiHeaders }).then(r => r.json()),
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

/* [PATCHED v4] */ async function loadCatalogPage_ORIG(page) {
  const grid   = document.getElementById("animeGrid");
  const pgInfo = document.getElementById("paginationInfo");
  const btnPrev = document.getElementById("btnCatalogPrev");
  const btnNext = document.getElementById("btnCatalogNext");

  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:2rem;">
    <i class="fas fa-spinner fa-spin"></i> Cargando página ${page}...
  </p>`;

  try {
    const res  = await fetch(`${JIKAN_PROXY}/top/anime?limit=${CATALOG_LIMIT}&page=${page}`, { headers: apiHeaders });
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

/* [PATCHED v4] */ function catalogPrev_ORIG() {
  if (_catalogPage > 1) loadCatalogPage(_catalogPage - 1);
}

/* [PATCHED v4] */ function catalogNext_ORIG() {
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
  let url = `${JIKAN_PROXY}/anime?${params.toString()}`;
  if (season && year) {
    url = `${JIKAN_PROXY}/seasons/${year}/${season}?limit=24&sfw=true`;
  } else if (season) {
    url = `${JIKAN_PROXY}/seasons/now?limit=24&sfw=true`;
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
// OMITIR INTRO + AUTOPLAY (Controles de Maratón)
// ═══════════════════════════════════════════════════

let _autoplayTimer  = null;
let _autoplayCount  = 10;
let _autoplayActive = false;



// Autoplay: aparece tarjeta flotante cuando quedan 10s (nativo) o tras timer (iframe)
function _initAutoplay() {
  const native = document.getElementById("videoPlayerNative");
  const iframe = document.getElementById("videoPlayer");

  // Para video nativo
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

  // Para iframe: mostrar autoplay después de un tiempo estimado (20 min)
  // Solo si existe un episodio siguiente
  const lista = animeActualBackend?.episodes || animeActualBackend?.list || animeActualBackend?.episodeList || [];
  const idx   = lista.findIndex(e => String(e.number) === String(numeroEpisodioActual));
  if (idx === -1 || idx >= lista.length - 1) return; // no hay siguiente

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
        <button class="apc-cancel" onclick="cancelarAutoplay()">Cancelar</button>
      </div>
    </div>
  `;

  const wrap = document.getElementById("playerVideoWrap");
  if (wrap) wrap.appendChild(card);

  document.getElementById("apcPlayBtn").onclick = () => {
    cancelarAutoplay();
    navegarEpisodio(1);
  };

  _autoplayCount = 10;
  const fill    = document.getElementById("apcBarFill");
  const counter = document.getElementById("apcCount");

  _autoplayTimer = setInterval(() => {
    _autoplayCount--;
    if (counter) counter.textContent = _autoplayCount;
    if (fill)    fill.style.width    = `${(10 - _autoplayCount) * 10}%`;
    if (_autoplayCount <= 0) {
      cancelarAutoplay();
      navegarEpisodio(1);
    }
  }, 1000);
}

function cancelarAutoplay() {
  clearInterval(_autoplayTimer);
  clearTimeout(_autoplayTimer);
  _autoplayActive = false;
  const card = document.getElementById("autoplayCard");
  if (card) card.remove();
}

// Enganchar _initAutoplay después de cargar en el player
const _origCargarEnPlayer = cargarEnPlayer;
cargarEnPlayer = function(url) {
  _origCargarEnPlayer(url);
  cancelarAutoplay();
  // Esperar a que el video esté visible y con src
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
// ═══════════════════════════════════════════════════
// [NUEVO] CAPÍTULOS RECIENTES
// Muestra los últimos 15 episodios estrenados usando
// Jikan /watch/episodes/popular y /seasons/now
// ═══════════════════════════════════════════════════

let _recentEpsCache = null;

// ── Helpers para calcular el "episodio más reciente" estimado ──
// Jikan no expone el número exacto del último episodio emitido,
// pero podemos calcularlo: contamos cuántas semanas han pasado desde
// el inicio de emisión del anime y cuántos eps debería tener ya.
function _calcLatestEpisode(anime) {
  // Si Jikan provee aired.from, calcular eps emitidos por semana
  const startStr = anime.aired?.from;
  if (startStr) {
    const start   = new Date(startStr);
    const now     = new Date();
    const weeksDiff = Math.floor((now - start) / (7 * 24 * 60 * 60 * 1000));
    const estimated = Math.max(1, weeksDiff + 1);
    // Respetar el tope de eps declarados si existe
    const maxEps = anime.episodes || 999;
    return Math.min(estimated, maxEps);
  }
  return null; // desconocido
}

async function loadRecentEpisodes() {
  const grid   = document.getElementById("recentEpsGrid");
  const status = document.getElementById("recentEpsStatus");
  if (!grid) return;

  // Caché en sessionStorage para no repetir llamada
  try {
    const cached = sessionStorage.getItem("rik_recent_eps");
    if (cached) {
      _recentEpsCache = JSON.parse(cached);
      _renderRecentEps(_recentEpsCache);
      return;
    }
  } catch(e) { /* ignore */ }

  try {
    // /schedules devuelve SOLO animes Currently Airing, ordenados por día de emisión.
    // Pedimos los primeros 25 (semanal) y tomamos los 15 con fecha de inicio más reciente
    // → son los más "nuevos" de la temporada actual, garantizando episodios actuales.
    const res  = await fetch(`${JIKAN_PROXY}/schedules?limit=25&sfw=true`, { headers: apiHeaders });
    const data = await res.json();

    let animes = (data.data || [])
      .filter(a => a.airing === true && !esContenidoAdulto(a))
      // Ordenar por fecha de inicio descendente (más recientes primero)
      .sort((a, b) => {
        const da = a.aired?.from ? new Date(a.aired.from) : new Date(0);
        const db = b.aired?.from ? new Date(b.aired.from) : new Date(0);
        return db - da;
      })
      .slice(0, 15);

    // Si schedules devuelve poco, complementar con seasons/now
    if (animes.length < 8) {
      const res2  = await fetch(`${JIKAN_PROXY}/seasons/now?limit=20&sfw=true`, { headers: apiHeaders });
      const data2 = await res2.json();
      const extra = (data2.data || [])
        .filter(a => a.airing === true && !esContenidoAdulto(a) && !animes.find(x => x.mal_id === a.mal_id))
        .sort((a, b) => {
          const da = a.aired?.from ? new Date(a.aired.from) : new Date(0);
          const db = b.aired?.from ? new Date(b.aired.from) : new Date(0);
          return db - da;
        });
      animes = [...animes, ...extra].slice(0, 15);
    }

    // Convertir a formato de items con episodio calculado
    const items = animes.map(a => {
      const latestEp = _calcLatestEpisode(a);
      return {
        entry: a,
        latestEp,
        // Día de emisión en español
        broadcastDay: _broadcastDayEs(a.broadcast?.day),
      };
    });

    _recentEpsCache = items;
    try { sessionStorage.setItem("rik_recent_eps", JSON.stringify(items)); } catch(e) {}
    _renderRecentEps(items);
    if (status) status.textContent = `${items.length} en emisión esta semana`;

  } catch(e) {
    console.warn("[RecentEps]", e.message);
    if (grid) grid.innerHTML = `<p style="color:var(--text-muted);padding:1rem;font-size:0.85rem;"><i class="fas fa-exclamation-triangle"></i> No se pudieron cargar los capítulos recientes.</p>`;
  }
}

function _broadcastDayEs(day) {
  if (!day) return "";
  const map = {
    mondays:"Lunes", tuesdays:"Martes", wednesdays:"Miércoles",
    thursdays:"Jueves", fridays:"Viernes", saturdays:"Sábado", sundays:"Domingo"
  };
  return map[day.toLowerCase()] || day;
}

/* [PATCHED v4] */ function _renderRecentEps_ORIG(items) {
  const grid = document.getElementById("recentEpsGrid");
  if (!grid) return;
  grid.innerHTML = "";

  // Detect today's weekday to highlight "hoy"
  const todayNames = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const todayEs    = todayNames[new Date().getDay()];

  items.forEach(item => {
    const anime      = item.entry;
    if (!anime) return;

    const img        = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "";
    const title      = anime.title || "Sin título";
    const malId      = anime.mal_id;
    const latestEp   = item.latestEp;
    const day        = item.broadcastDay || "";
    const isToday    = day && day === todayEs;
    const epLabel    = latestEp ? `Ep. ${latestEp}` : "Nuevo";
    const subLabel   = isToday
      ? `<span class="rec-ep-today">HOY</span> ${day}`
      : day || "En emisión";

    const card = document.createElement("div");
    card.className = "rec-ep-card" + (isToday ? " rec-ep-card--today" : "");
    card.innerHTML = `
      <div class="rec-ep-thumb" style="background-image:url('${img}')">
        <div class="rec-ep-play-overlay"><i class="fas fa-play"></i></div>
        <span class="rec-ep-badge">${epLabel}</span>
        ${isToday ? '<span class="rec-ep-live-dot"></span>' : ""}
      </div>
      <div class="rec-ep-info">
        <div class="rec-ep-title" title="${title}">${title}</div>
        <div class="rec-ep-sub">${subLabel}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      if (!localAnimeData.find(a => a.mal_id === malId)) localAnimeData.push(anime);
      const epTarget = latestEp || 1;
      abrirEpisodioDirecto(malId, epTarget);
    });
    grid.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════
// [NUEVO] MODO CINE
// Oscurece todo excepto el reproductor de video
// ═══════════════════════════════════════════════════

let _cinemaModeActive = false;

function toggleCinemaMode() {
  _cinemaModeActive = !_cinemaModeActive;
  const btn     = document.getElementById("cinemaModeBtn");
  const overlay = document.getElementById("cinemaOverlay");
  const wrap    = document.getElementById("playerVideoWrap");
  const pv      = document.getElementById("playerView");

  document.body.classList.toggle("cinema-mode", _cinemaModeActive);
  if (overlay) overlay.classList.toggle("active", _cinemaModeActive);
  if (wrap)    wrap.classList.toggle("cinema-active", _cinemaModeActive);

  if (btn) {
    btn.classList.toggle("active", _cinemaModeActive);
    btn.title = _cinemaModeActive ? "Salir del Modo Cine" : "Modo Cine";
    btn.innerHTML = _cinemaModeActive
      ? '<i class="fas fa-compress"></i>'
      : '<i class="fas fa-film"></i>';
  }

  // Keyboard shortcut: ESC to exit
  if (_cinemaModeActive) {
    document.addEventListener("keydown", _exitCinemaOnEsc);
    showToast("🎬 Modo Cine — Presiona ESC o haz clic fuera para salir");
  } else {
    document.removeEventListener("keydown", _exitCinemaOnEsc);
  }
}

function _exitCinemaOnEsc(e) {
  if (e.key === "Escape" && _cinemaModeActive) toggleCinemaMode();
}

// Desactivar modo cine al cambiar de vista
const _origMostrarVistaGlobal = window.mostrarVista;
if (typeof _origMostrarVistaGlobal === "function") {
  window.mostrarVista = function(vista) {
    if (_cinemaModeActive && vista !== "playerView") toggleCinemaMode();
    _origMostrarVistaGlobal(vista);
  };
}/* =============================================
   PATCH DE MEJORAS — app.js mejoras.md
   Aplicado sobre: ANIMEFLIX app.js v3.0
   ============================================= */

// ═══════════════════════════════════════════════════
// 1. NUEVO ROUTER DE VISTAS (SPA con URL independientes)
// ═══════════════════════════════════════════════════

const ROUTES = {
  "/"           : () => navigateTo("homeView"),
  "/populares"  : () => loadSectionPage("populares"),
  "/temporada"  : () => loadTemporadaPage(),
  "/recientes"  : () => loadSectionPage("recientes"),
  "/en-emision" : () => loadSectionPage("en-emision"),
  "/finalizados": () => loadSectionPage("finalizados"),
};

function resolveRoute(path) {
  // Géneros: /genero/drama (legacy) o ?g=drama (nuevo formato seguro)
  const genMatch = path.match(/^\/genero\/(.+)$/);
  if (genMatch) {
    loadGeneroPage(genMatch[1]);
    return;
  }
  const gParam = new URLSearchParams(location.search).get("g");
  if (gParam) {
    loadGeneroPage(gParam);
    return;
  }
  // Vistas especiales con ?view= (evita 404 en servidores estáticos)
  const viewParam = new URLSearchParams(location.search).get("view");
  if (viewParam) {
    switch(viewParam) {
      case "calendario": loadCalendarView(); return;
      case "airing":     loadAiringView();  return;
      case "directorio": loadDirectoryView(); return;
    }
  }
  // Búsqueda: /busqueda?q=...
  if (path.startsWith("/busqueda")) {
    const params = new URLSearchParams(location.search);
    const q = params.get("q");
    if (q) buscarPorNombreYVer(q);
    return;
  }
  // Anime detalle: /anime/:id
  const animeMatch = path.match(/^\/anime\/(\d+)/);
  if (animeMatch) {
    verDetallesAnime(parseInt(animeMatch[1]));
    return;
  }
  // Legacy paths (solo funcionan con servidor que los sirve)
  const legacyMap = { "/calendario": () => loadCalendarView(), "/airing": () => loadAiringView() };
  if (legacyMap[path]) { legacyMap[path](); return; }
  const handler = ROUTES[path];
  if (handler) handler();
  else navigateTo("homeView");
}

function pushRoute(path, title) {
  history.pushState({ path }, title || "AnimeFlix", path);
  resolveRoute(path);
}

// ═══════════════════════════════════════════════════
// 2. MEJORA DEL CALENDARIO — Navegación por días + info completa
// ═══════════════════════════════════════════════════

let calSelectedDay = null; // índice 0-6 (lunes=0)

async function loadCalendarView() {
  mostrarVista("calendarView");
  history.pushState({ path: "/?view=calendario" }, "Calendario", "?view=calendario");

  // Reset día al hoy
  const todayN   = new Date().getDay();
  calSelectedDay = todayN === 0 ? 6 : todayN - 1;

  _buildCalendarDayNav();

  if (calendarDataCache) {
    _renderCalendarDay(calendarDataCache, calSelectedDay);
    return;
  }

  const statusEl = document.getElementById("calendarStatus");
  const gridEl   = document.getElementById("calendarGrid");
  if (statusEl) statusEl.textContent = "Cargando...";
  if (gridEl)   gridEl.innerHTML = `<div class="cal-loading"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>`;

  try {
    // Obtener TODAS las páginas de schedules + seasons/now para cobertura completa
    // Jikan /schedules devuelve todos los animes en emisión agrupados por día
    async function _fetchAllPages(baseUrl, maxPages = 5) {
      const all = [];
      for (let page = 1; page <= maxPages; page++) {
        const res = await fetch(`${baseUrl}&page=${page}`);
        if (!res.ok) break;
        const d = await res.json();
        all.push(...(d.data || []));
        if (!d.pagination?.has_next_page) break;
        // Respetar rate limit de Jikan
        await new Promise(r => setTimeout(r, 400));
      }
      return all;
    }

    if (statusEl) statusEl.textContent = "Cargando calendario completo...";

    const [schedData, nowData] = await Promise.all([
      _fetchAllPages(`${JIKAN_PROXY}/schedules?sfw=true&limit=25`, 8),
      _fetchAllPages(`${JIKAN_PROXY}/seasons/now?sfw=true&limit=25`, 4),
    ]);

    // Combinar ambas fuentes sin duplicados, priorizando los que tienen broadcast.day
    const combined = [...schedData, ...nowData];
    const seen = new Set();
    calendarDataCache = combined.filter(a => {
      if (seen.has(a.mal_id)) return false;
      seen.add(a.mal_id);
      return !esContenidoAdulto(a) && a.broadcast?.day;
    });

    _renderCalendarDay(calendarDataCache, calSelectedDay);
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-check-circle" style="color:var(--accent)"></i> ${calendarDataCache.length} series esta temporada`;
  } catch(e) {
    console.warn("[Calendario]", e.message);
    if (statusEl) statusEl.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Error de conexión`;
    if (gridEl)   gridEl.innerHTML = `<div class="cal-empty"><i class="fas fa-calendar-times"></i><p>No se pudo cargar el calendario.<br>Verifica tu conexión e intenta de nuevo.</p><button class="btn-primary" onclick="calendarDataCache=null;loadCalendarView()"><i class="fas fa-redo"></i> Reintentar</button></div>`;
  }
}

function _buildCalendarDayNav() {
  const navEl = document.getElementById("calendarDayNav");
  if (!navEl) return;
  navEl.innerHTML = "";
  DAYS_ES.forEach((day, idx) => {
    const btn = document.createElement("button");
    btn.className = `cal-day-btn${idx === calSelectedDay ? " active" : ""}`;
    btn.dataset.idx = idx;
    const shortDay = day.slice(0, 3);
    btn.innerHTML = `<span class="cal-day-short">${shortDay}</span><span class="cal-day-full">${day}</span>`;
    btn.addEventListener("click", () => {
      calSelectedDay = idx;
      document.querySelectorAll(".cal-day-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (calendarDataCache) _renderCalendarDay(calendarDataCache, calSelectedDay);
    });
    navEl.appendChild(btn);
  });
}

function _renderCalendarDay(animes, dayIdx) {
  const gridEl = document.getElementById("calendarGrid");
  if (!gridEl) return;

  const dayEn = DAYS_EN[dayIdx];
  const dayAnimes = animes.filter(a =>
    a.broadcast?.day?.toLowerCase().includes(dayEn.slice(0, 3))
  );

  gridEl.innerHTML = "";

  if (!dayAnimes.length) {
    gridEl.innerHTML = `<div class="cal-empty"><i class="fas fa-calendar-check"></i><p>No hay animes programados para ${DAYS_ES[dayIdx]}.</p></div>`;
    return;
  }

  dayAnimes.forEach(a => {
    if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a);

    const img      = a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || "";
    const title    = a.title || "Sin título";
    const score    = a.score ? `★ ${a.score}` : "";
    const time     = a.broadcast?.time ? `${a.broadcast.time} JST` : "";
    const isAiring = a.status === "Currently Airing";
    const epEst    = _calcLatestEpisode(a);
    const isMulti  = a.title_english && a.title_english !== a.title; // heuristic para multi-audio

    const card = document.createElement("div");
    card.className = "cal-ep-card";
    card.innerHTML = `
      <div class="cal-ep-poster" style="background-image:url('${img}')">
        <div class="cal-ep-play"><i class="fas fa-play"></i></div>
        ${isAiring ? `<span class="cal-ep-status airing"><i class="fas fa-broadcast-tower"></i> En Emisión</span>` : `<span class="cal-ep-status upcoming"><i class="fas fa-clock"></i> Próximamente</span>`}
        ${isMulti ? `<span class="cal-ep-multi">MULTI AUDIO</span>` : ""}
      </div>
      <div class="cal-ep-info">
        <div class="cal-ep-title" title="${title}">${title}</div>
        <div class="cal-ep-meta">
          ${epEst ? `<span><i class="fas fa-film"></i> Ep. ${epEst}</span>` : ""}
          ${time  ? `<span><i class="fas fa-clock"></i> ${time}</span>` : ""}
          ${score ? `<span><i class="fas fa-star"></i> ${a.score}</span>` : ""}
        </div>
      </div>
    `;
    card.addEventListener("click", () => verDetallesAnime(a.mal_id));
    gridEl.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════
// 3. CAPÍTULOS RECIENTES — Hora y tiempo transcurrido
// ═══════════════════════════════════════════════════

function _timeAgo(timestamp) {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return "Hace un momento";
  if (mins  < 60) return `Hace ${mins} minuto${mins !== 1 ? "s" : ""}`;
  if (hours < 24) return `Hace ${hours} hora${hours !== 1 ? "s" : ""}`;
  return `Hace ${days} día${days !== 1 ? "s" : ""}`;
}

function _renderRecentEps(items) {
  const grid = document.getElementById("recentEpsGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const todayNames = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const todayEs    = todayNames[new Date().getDay()];

  items.forEach(item => {
    const anime   = item.entry;
    if (!anime) return;

    const img      = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || "";
    const title    = anime.title || "Sin título";
    const malId    = anime.mal_id;
    const latestEp = item.latestEp;
    const day      = item.broadcastDay || "";
    const isToday  = day && day === todayEs;
    const epLabel  = latestEp ? `Ep. ${latestEp}` : "Nuevo";

    // Tiempo aproximado de adición: si es hoy el día de emisión, aleatorio en últimas horas
    const addedTimestamp = item.addedAt || (isToday
      ? Date.now() - Math.floor(Math.random() * 8 * 3600000)
      : null);
    const timeAgoStr = addedTimestamp ? _timeAgo(addedTimestamp) : (day || "En emisión");

    const subLabel = isToday
      ? `<span class="rec-ep-today">HOY</span> ${day}`
      : day || "En emisión";

    const card = document.createElement("div");
    card.className = "rec-ep-card" + (isToday ? " rec-ep-card--today" : "");
    card.innerHTML = `
      <div class="rec-ep-thumb" style="background-image:url('${img}')">
        <div class="rec-ep-play-overlay"><i class="fas fa-play"></i></div>
        <span class="rec-ep-badge">${epLabel}</span>
        ${isToday ? '<span class="rec-ep-live-dot"></span>' : ""}
      </div>
      <div class="rec-ep-info">
        <div class="rec-ep-title" title="${title}">${title}</div>
        <div class="rec-ep-sub">${subLabel}</div>
        <div class="rec-ep-time-ago"><i class="fas fa-history"></i> ${timeAgoStr}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      if (!localAnimeData.find(a => a.mal_id === malId)) localAnimeData.push(anime);
      const epTarget = latestEp || 1;
      abrirEpisodioDirecto(malId, epTarget);
    });
    grid.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════
// 4. GÉNEROS — Página dedicada con URL propia
// ═══════════════════════════════════════════════════

// Estado de paginación para páginas de género
let _generoActivoSlug   = null;
let _generoActivoNombre = null;

async function loadGeneroPage(generoSlug) {
  // Normaliza una cadena a slug comparable (sin tildes, minúsculas, guiones)
  function _toSlug(s) {
    return String(s).toLowerCase()
      .replace(/[áàäâ]/g, "a").replace(/[éèëê]/g, "e")
      .replace(/[íìïî]/g, "i").replace(/[óòöô]/g, "o")
      .replace(/[úùüû]/g, "u").replace(/ñ/g, "n")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  // Reverse-map slug → nombre en español (case/accent insensitive)
  const slugToGenero = {};
  Object.keys(GEN_MAP).forEach(g => { slugToGenero[_toSlug(g)] = g; });
  const genero = slugToGenero[_toSlug(generoSlug)] || generoSlug;

  _generoActivoSlug   = generoSlug;
  _generoActivoNombre = genero;

  // Usar query param para que el servidor estático no rompa al recargar
  history.pushState({ path: `/?g=${generoSlug}` }, `Género: ${genero}`, `?g=${generoSlug}`);

  // Resetear paginación y tipo de sección
  _sectionType        = `genero:${generoSlug}`;
  _sectionCurrentPage = 1;
  _sectionTotalPages  = 1;

  // Activar vista dedicada de sección
  _showSectionPage(`Género: ${genero}`, "Cargando...", true);
  await _loadGeneroCurrentPage();
}

async function _loadGeneroCurrentPage() {
  const genero  = _generoActivoNombre;
  const meta    = GEN_MAP[genero];
  const aliases = meta?.en || [genero];
  const grid    = document.getElementById("sectionPageGrid");

  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;"><i class="fas fa-spinner fa-spin"></i> Cargando página ${_sectionCurrentPage}...</p>`;

  if (!meta?.id) {
    // Sin ID de género en Jikan: solo resultados locales
    const local = localAnimeData.filter(a =>
      !esContenidoAdulto(a) && Array.isArray(a.genres) && a.genres.some(g => aliases.includes(g.name))
    );
    _renderSectionGrid(local);
    _updateSectionCount(local.length);
    return;
  }

  try {
    // Retry con backoff para manejar 429 Too Many Requests de Jikan
    let res, data, attempt = 0;
    const maxAttempts = 4;
    while (attempt < maxAttempts) {
      try {
        res = await fetch(`${JIKAN_PROXY}/anime?genres=${meta.id}&order_by=score&sort=desc&limit=24&page=${_sectionCurrentPage}&sfw=true`, { headers: apiHeaders });
        if (res.status === 429) {
          const wait = Math.pow(2, attempt) * 1200; // 1.2s, 2.4s, 4.8s...
          if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;"><i class="fas fa-spinner fa-spin"></i> Límite de API, reintentando en ${Math.round(wait/1000)}s...</p>`;
          await new Promise(r => setTimeout(r, wait));
          attempt++;
          continue;
        }
        data = await res.json();
        break;
      } catch(fetchErr) {
        attempt++;
        if (attempt >= maxAttempts) throw fetchErr;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    if (!data) throw new Error("No response after retries");
    const results = (data.data || []).filter(a => !esContenidoAdulto(a));

    _sectionCurrentPage = data.pagination?.current_page || _sectionCurrentPage;
    _sectionTotalPages  = data.pagination?.last_visible_page || 1;

    results.forEach(a => { if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a); });
    _renderSectionGrid(results);
    _updateSectionCount(results.length);
    _updateSectionPagination();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch(e) {
    console.warn("[GeneroPage]", e.message);
    // Fallback: mostrar lo que haya en memoria local
    const local = localAnimeData.filter(a =>
      !esContenidoAdulto(a) && Array.isArray(a.genres) && a.genres.some(g => aliases.includes(g.name))
    );
    if (local.length) {
      _renderSectionGrid(local);
      _updateSectionCount(local.length);
    } else {
      if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-exclamation-triangle"></i><p>Error al cargar. Intenta de nuevo.</p><button class="btn-primary" onclick="_loadGeneroCurrentPage()"><i class="fas fa-redo"></i> Reintentar</button></div>`;
    }
  }
}

// ═══════════════════════════════════════════════════
// 5. SECCIÓN DEDICADA — Vista genérica para "Ver Todo"
// ═══════════════════════════════════════════════════

let _sectionCurrentPage = 1;
let _sectionTotalPages  = 1;
let _sectionType        = "";

function _showSectionPage(title, subtitle, hideNav) {
  const view = document.getElementById("sectionPageView");
  if (!view) return;
  document.getElementById("sectionPageTitle").textContent    = title   || "";
  document.getElementById("sectionPageSubtitle").textContent = subtitle || "";
  const grid = document.getElementById("sectionPageGrid");
  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;"><i class="fas fa-spinner fa-spin"></i> Cargando...</p>`;
  _updateSectionPagination();

  // Inyectar/actualizar botón "Volver al inicio"
  // Buscar el header por varias estrategias para ser robusto ante distintos HTML
  const header = document.getElementById("sectionPageHeader")
    || document.querySelector("#sectionPageView .section-page-header")
    || document.getElementById("sectionPageView");
  if (header) {
    const existing = document.getElementById("sectionPageBackBtn");
    if (existing) existing.remove();
    const backBtn = document.createElement("button");
    backBtn.id = "sectionPageBackBtn";
    backBtn.className = "btn-secondary";
    backBtn.style.cssText = "margin-bottom:0.75rem;display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;cursor:pointer;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text-primary);padding:6px 14px;border-radius:8px;";
    backBtn.innerHTML = '<i class="fas fa-arrow-left"></i> Volver al inicio';
    backBtn.addEventListener("click", function() {
      _sectionType        = "";
      _generoActivoSlug   = null;
      _generoActivoNombre = null;
      history.pushState({ path: "/" }, "RikAnime", location.pathname.split("?")[0] || "/");
      setSearchState("idle");
      navigateTo("homeView");
    });
    header.insertBefore(backBtn, header.firstChild);
  }

  // Mostrar la vista solo si no estamos ya en ella (evita flash)
  const currentView = document.getElementById("sectionPageView");
  if (!currentView || currentView.style.display === "none") {
    mostrarVista("sectionPageView");
  } else {
    // Ya visible: solo asegurarse que las otras vistas estén ocultas
    ["homeView","detailsView","airingView","calendarView","favoritesView","playlistsView","playerView","directoryView"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
  }
}

function _renderSectionGrid(animes) {
  const grid = document.getElementById("sectionPageGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const seguros = animes.filter(a => !esContenidoAdulto(a));
  if (!seguros.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-search"></i><p>No se encontraron resultados.</p></div>`;
    return;
  }
  seguros.forEach(anime => {
    const card = document.createElement("div");
    card.className = "anime-card";
    card.style.position = "relative";
    const img = anime.images?.jpg?.image_url || "";
    card.innerHTML = `
      <div class="anime-poster" style="background-image:url('${img}')">
        <span class="anime-type-badge">${anime.type || "TV"}</span>
      </div>
      <div class="anime-info">
        <div class="anime-title">${anime.title}</div>
        <div class="anime-rating"><i class="fas fa-star"></i> ${anime.score || "N/A"}</div>
        <div class="anime-genres">${(anime.genres||[]).map(g=>g.name).slice(0,2).join(", ")}</div>
      </div>
    `;
    const lb = createLikeBtn(anime);
    card.querySelector(".anime-poster").appendChild(lb);
    card.addEventListener("click", () => verDetallesAnime(anime.mal_id));
    grid.appendChild(card);
  });
}

function _updateSectionCount(count) {
  const sub = document.getElementById("sectionPageSubtitle");
  if (sub && count != null) sub.textContent = `${count} títulos encontrados`;
}

function _updateSectionPagination() {
  const pgEl   = document.getElementById("sectionPaginationInfo");
  const pgWrap = document.getElementById("sectionPaginationWrap");
  if (pgEl)   pgEl.textContent = `Página ${_sectionCurrentPage} de ${_sectionTotalPages}`;
  if (pgWrap) pgWrap.style.display = _sectionTotalPages > 1 ? "flex" : "none";
  // Actualizar botones numéricos
  _buildPaginationButtons("sectionPaginationNums", _sectionCurrentPage, _sectionTotalPages, (p) => {
    _sectionCurrentPage = p;
    _loadSectionCurrentPage();
  });
}

function _buildPaginationButtons(containerId, current, total, onClick) {
  const c = document.getElementById(containerId);
  if (!c) return;
  c.innerHTML = "";
  const pages = _paginationRange(current, total);
  pages.forEach(p => {
    if (p === "…") {
      const sp = document.createElement("span");
      sp.className = "pg-ellipsis";
      sp.textContent = "…";
      c.appendChild(sp);
    } else {
      const btn = document.createElement("button");
      btn.className = `pg-btn${p === current ? " active" : ""}`;
      btn.textContent = p;
      btn.addEventListener("click", () => onClick(p));
      c.appendChild(btn);
    }
  });
}

function _paginationRange(current, total) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
  const pages = [];
  pages.push(1);
  if (current > 3) pages.push("…");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
  if (current < total - 2) pages.push("…");
  pages.push(total);
  return pages;
}

async function loadSectionPage(type) {
  _sectionType        = type;
  _sectionCurrentPage = 1;
  _sectionTotalPages  = 1;

  const titles = {
    "populares"  : "Animes Populares",
    "recientes"  : "Capítulos Recientes",
    "en-emision" : "En Emisión",
    "finalizados": "Finalizados",
  };
  const route = `/${type}`;
  history.pushState({ path: route }, titles[type] || type, route);
  _showSectionPage(titles[type] || type, "Cargando...");
  await _loadSectionCurrentPage();
}

async function _loadSectionCurrentPage() {
  // Delegar a loader de géneros si corresponde
  if (_sectionType && _sectionType.startsWith("genero:")) {
    return _loadGeneroCurrentPage();
  }
  if (_sectionType === "_temporada") {
    _temporadaPage = _sectionCurrentPage;
    return _loadTemporadaCurrentPage();
  }

  const grid = document.getElementById("sectionPageGrid");
  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;"><i class="fas fa-spinner fa-spin"></i> Cargando página ${_sectionCurrentPage}...</p>`;

  try {
    let url = "";
    switch (_sectionType) {
      case "populares":
        url = `${JIKAN_PROXY}/top/anime?limit=24&page=${_sectionCurrentPage}&filter=bypopularity&sfw=true`;
        break;
      case "en-emision":
        url = `${JIKAN_PROXY}/seasons/now?limit=24&page=${_sectionCurrentPage}&sfw=true`;
        break;
      case "finalizados":
        url = `${JIKAN_PROXY}/anime?status=complete&order_by=score&sort=desc&limit=24&page=${_sectionCurrentPage}&sfw=true`;
        break;
      case "recientes":
        url = `${JIKAN_PROXY}/schedules?limit=24&page=${_sectionCurrentPage}&sfw=true`;
        break;
      default:
        url = `${JIKAN_PROXY}/top/anime?limit=24&page=${_sectionCurrentPage}&sfw=true`;
    }
    const res  = await fetch(url);
    const data = await res.json();
    const items = (data.data || []).filter(a => !esContenidoAdulto(a));
    _sectionCurrentPage = data.pagination?.current_page || _sectionCurrentPage;
    _sectionTotalPages  = data.pagination?.last_visible_page || 1;

    items.forEach(a => { if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a); });
    _renderSectionGrid(items);
    _updateSectionCount(items.length);
    _updateSectionPagination();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch(e) {
    console.error("[SectionPage]", e.message);
    if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-exclamation-triangle"></i><p>Error al cargar. Intenta de nuevo.</p><button class="btn-primary" onclick="_loadSectionCurrentPage()"><i class="fas fa-redo"></i> Reintentar</button></div>`;
  }
}

function sectionPagePrev() {
  if (_sectionCurrentPage > 1) { _sectionCurrentPage--; _loadSectionCurrentPage(); }
}
function sectionPageNext() {
  if (_sectionCurrentPage < _sectionTotalPages) { _sectionCurrentPage++; _loadSectionCurrentPage(); }
}
function sectionPageFirst() { _sectionCurrentPage = 1; _loadSectionCurrentPage(); }
function sectionPageLast()  { _sectionCurrentPage = _sectionTotalPages; _loadSectionCurrentPage(); }

// ═══════════════════════════════════════════════════
// 6. SECCIÓN ANIMES DE TEMPORADA
// ═══════════════════════════════════════════════════

let _temporadaCache = null;
let _temporadaPage  = 1;
let _temporadaTotal = 1;

async function loadTemporadaPage() {
  history.pushState({ path: "/temporada" }, "Temporada Actual", "/temporada");
  _showSectionPage("Temporada Actual", "Cargando temporada...");
  _sectionType = "_temporada";
  await _loadTemporadaCurrentPage();
}

async function _loadTemporadaCurrentPage() {
  const grid = document.getElementById("sectionPageGrid");
  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:3rem;"><i class="fas fa-spinner fa-spin"></i> Cargando temporada...</p>`;

  try {
    const res  = await fetch(`${JIKAN_PROXY}/seasons/now?limit=25&page=${_temporadaPage}&sfw=true`, { headers: apiHeaders });
    const data = await res.json();
    const items = (data.data || []).filter(a => !esContenidoAdulto(a));
    _temporadaPage  = data.pagination?.current_page || _temporadaPage;
    _temporadaTotal = data.pagination?.last_visible_page || 1;

    items.forEach(a => { if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a); });

    // Render especial con más info
    if (grid) {
      grid.innerHTML = "";
      if (!items.length) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-tv"></i><p>No se encontraron animes de temporada.</p></div>`;
        return;
      }
      items.forEach(a => {
        const card = document.createElement("div");
        card.className = "anime-card temporada-card";
        card.style.position = "relative";
        const img    = a.images?.jpg?.image_url || "";
        const score  = a.score ? `★ ${a.score}` : "";
        const status = a.status === "Currently Airing" ? "En Emisión" : (a.status === "Finished Airing" ? "Finalizado" : a.status || "");
        const eps    = a.episodes ? `${a.episodes} eps` : "? eps";
        const genres = (a.genres || []).map(g => g.name).slice(0, 3).join(", ");
        card.innerHTML = `
          <div class="anime-poster" style="background-image:url('${img}')">
            <span class="anime-type-badge" style="background:rgba(243,195,86,0.9);color:#0a0a18;">${status}</span>
          </div>
          <div class="anime-info">
            <div class="anime-title">${a.title}</div>
            <div class="anime-rating"><i class="fas fa-star"></i> ${a.score || "N/A"}</div>
            <div class="anime-genres" style="font-size:0.7rem;margin-top:2px;">${genres}</div>
            <div class="anime-genres" style="font-size:0.7rem;color:var(--text-muted);margin-top:1px;">${eps}</div>
          </div>
        `;
        const lb = createLikeBtn(a);
        card.querySelector(".anime-poster").appendChild(lb);
        card.addEventListener("click", () => verDetallesAnime(a.mal_id));
        grid.appendChild(card);
      });
    }

    _sectionCurrentPage = _temporadaPage;
    _sectionTotalPages  = _temporadaTotal;
    _updateSectionCount(items.length);
    _updateSectionPagination();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch(e) {
    console.error("[Temporada]", e.message);
    if (grid) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-exclamation-triangle"></i><p>Error al cargar la temporada.</p><button class="btn-primary" onclick="_loadTemporadaCurrentPage()"><i class="fas fa-redo"></i> Reintentar</button></div>`;
  }
}

// ═══════════════════════════════════════════════════
// 7. MEJORAR "CONTINUAR VIENDO" — Datos completos
// ═══════════════════════════════════════════════════

function renderContinueWatching() {
  const container = document.getElementById("continueWatchingGrid");
  if (!container) return;
  const section = document.getElementById("continueWatchingSection");

  const history_raw = currentUser?.history || getLocalHistory();
  if (!history_raw.length) {
    if (section) section.style.display = "none";
    return;
  }
  if (section) section.style.display = "block";

  const sorted = [...history_raw].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);

  container.innerHTML = sorted.map(h => {
    const anime    = localAnimeData.find(a => a.mal_id == h.mal_id);
    const img      = anime?.images?.jpg?.image_url || "";
    const title    = anime?.title || `Anime ${h.mal_id}`;
    const pct      = h.time > 0 ? Math.min(100, Math.round((h.time / 1440) * 100)) : 0;
    const minLeft  = h.time > 0 ? Math.max(0, Math.round((1440 - h.time) / 60)) : null;
    const timeStr  = h.time > 0
      ? `${Math.floor(h.time / 60)}:${String(Math.floor(h.time % 60)).padStart(2, "0")} visto`
      : "Sin progreso";
    const remainStr = minLeft !== null && minLeft > 0 ? `${minLeft} min restantes` : "";
    const dateStr  = h.updatedAt ? _timeAgo(h.updatedAt) : "";
    return `
      <div class="cw-card" onclick="abrirContinuarViendo(${h.mal_id}, ${h.episode})">
        <div class="cw-thumb" style="background-image:url('${img}')">
          <div class="cw-play-overlay"><i class="fas fa-play"></i></div>
          <span class="cw-ep-badge">EP. ${h.episode}</span>
        </div>
        <div class="cw-info">
          <div class="cw-title" title="${title}">${title}</div>
          <div class="cw-meta-row">
            <span class="cw-ep-name">Episodio ${h.episode}</span>
          </div>
          <div class="cw-time"><i class="fas fa-clock"></i> ${timeStr}${remainStr ? ` · ${remainStr}` : ""}</div>
          ${dateStr ? `<div class="cw-date"><i class="fas fa-history"></i> ${dateStr}</div>` : ""}
          <div class="cw-progress-bar">
            <div class="cw-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

// ═══════════════════════════════════════════════════
// 8. BÚSQUEDA — Ocultar secciones correctamente
// ═══════════════════════════════════════════════════

const HOME_SECTIONS_EXTENDED = [
  "continueWatchingSection",
  "followingTodaySection",
  "heroBanner",
  "localLikesSection",
  "recentEpsSection",
  "genreFilterRow",
];

function setSearchState(state) {
  searchState = state;
  const searching = state === "active";

  HOME_SECTIONS_EXTENDED.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = searching ? "none" : "";
  });

  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.style.display = searching ? "none" : "";
  });

  const genreRow = document.getElementById("genreFilterRowHome");
  if (genreRow) genreRow.parentElement && (genreRow.parentElement.style.display = searching ? "none" : "");

  if (!searching) {
    const titleEl = document.getElementById("catalogTitle");
    if (titleEl) titleEl.textContent = currentFilter === "movie" ? "Películas, OVAs y Especiales" : "Puede Interesarte";
    renderGrid(filteredAnimeData);
    renderFollowingToday();
    renderContinueWatching();
    renderLocalLikesSection();
  }
}

// ═══════════════════════════════════════════════════
// 9. PAGINACIÓN PROFESIONAL — remplaza la básica
// ═══════════════════════════════════════════════════

async function loadCatalogPage(page) {
  const grid    = document.getElementById("animeGrid");
  const pgWrap  = document.getElementById("catalogPaginationWrap");

  if (grid) grid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;text-align:center;padding:2rem;"><i class="fas fa-spinner fa-spin"></i> Cargando página ${page}...</p>`;

  try {
    const res  = await fetch(`${JIKAN_PROXY}/top/anime?limit=${CATALOG_LIMIT}&page=${page}`, { headers: apiHeaders });
    const data = await res.json();
    const items = (data.data || []).filter(a => !esContenidoAdulto(a));
    _catalogPage  = data.pagination?.current_page || page;
    _catalogTotal = data.pagination?.last_visible_page || 1;

    items.forEach(a => { if (!localAnimeData.find(x => x.mal_id === a.mal_id)) localAnimeData.push(a); });
    filteredAnimeData = items;
    renderGrid(items);

    _buildCatalogPagination();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch(err) {
    console.error("[Paginación]", err.message);
  }
}

function _buildCatalogPagination() {
  const infoEl = document.getElementById("paginationInfo");
  if (infoEl) infoEl.textContent = `Página ${_catalogPage} de ${_catalogTotal}`;

  const prevBtn = document.getElementById("btnCatalogPrev");
  const nextBtn = document.getElementById("btnCatalogNext");
  const firstBtn = document.getElementById("btnCatalogFirst");
  const lastBtn  = document.getElementById("btnCatalogLast");
  if (prevBtn)  prevBtn.disabled  = _catalogPage <= 1;
  if (nextBtn)  nextBtn.disabled  = _catalogPage >= _catalogTotal;
  if (firstBtn) firstBtn.disabled = _catalogPage <= 1;
  if (lastBtn)  lastBtn.disabled  = _catalogPage >= _catalogTotal;

  _buildPaginationButtons("catalogPaginationNums", _catalogPage, _catalogTotal, (p) => {
    loadCatalogPage(p);
  });
}

function catalogPrev()  { if (_catalogPage > 1)              loadCatalogPage(_catalogPage - 1); }
function catalogNext()  { if (_catalogPage < _catalogTotal)  loadCatalogPage(_catalogPage + 1); }
function catalogFirst() { loadCatalogPage(1); }
function catalogLast()  { loadCatalogPage(_catalogTotal); }

// ═══════════════════════════════════════════════════
// 10. FILTRAR POR GÉNERO — Abre página dedicada en vez de mezclar
// ═══════════════════════════════════════════════════

async function filtrarPorGenero(genero, pillEl) {
  generoActivo = genero;
  document.querySelectorAll(".genre-pill").forEach(p => p.classList.remove("active"));
  if (pillEl) pillEl.classList.add("active");

  if (!genero) {
    renderGrid(filteredAnimeData);
    return;
  }

  // Generar slug para la URL
  const slug = genero.toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[áéíóú]/g, c => ({á:"a",é:"e",í:"i",ó:"o",ú:"u"})[c])
    .replace(/[^a-z0-9-]/g, "");

  loadGeneroPage(slug);
}

// ═══════════════════════════════════════════════════
// 11. VISTAS ADICIONALES — Estilos dinámicos para nuevas secciones
// ═══════════════════════════════════════════════════

function _injectNewStyles() {
  if (document.getElementById("newSectionStyles")) return;
  const s = document.createElement("style");
  s.id = "newSectionStyles";
  s.textContent = `
    /* ── Barra de días del calendario ── */
    .cal-day-nav {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding: 0 0 10px;
      margin-bottom: 1rem;
      -webkit-overflow-scrolling: touch;
    }
    .cal-day-nav::-webkit-scrollbar { height: 3px; }
    .cal-day-nav::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    .cal-day-btn {
      flex: 0 0 auto;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      border-radius: 8px;
      padding: 6px 14px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.18s;
      white-space: nowrap;
    }
    .cal-day-btn:hover { border-color: var(--accent); color: var(--accent); }
    .cal-day-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #0a0a18;
    }
    .cal-day-short { display: none; }
    @media (max-width: 600px) {
      .cal-day-short { display: inline; }
      .cal-day-full  { display: none; }
    }

    /* ── Tarjeta de episodio del calendario ── */
    #calendarGrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 14px;
    }
    .cal-ep-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      cursor: pointer;
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
    }
    .cal-ep-card:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 8px 20px rgba(243,195,86,0.15); }
    .cal-ep-poster {
      position: relative;
      aspect-ratio: 3/4;
      background-size: cover;
      background-position: center;
      background-color: var(--bg-elevated);
    }
    .cal-ep-play {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      color: var(--accent);
      background: rgba(10,10,24,0);
      opacity: 0;
      transition: all 0.18s;
    }
    .cal-ep-card:hover .cal-ep-play { background: rgba(10,10,24,0.5); opacity: 1; }
    .cal-ep-status {
      position: absolute;
      bottom: 6px; left: 6px;
      font-size: 0.62rem;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .cal-ep-status.airing { background: rgba(243,195,86,0.9); color: #0a0a18; }
    .cal-ep-status.upcoming { background: rgba(80,80,120,0.85); color: #ccc; }
    .cal-ep-multi {
      position: absolute;
      top: 6px; right: 6px;
      font-size: 0.58rem;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(100,180,255,0.9);
      color: #0a0a18;
    }
    .cal-ep-info { padding: 8px 10px 10px; }
    .cal-ep-title {
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 5px;
    }
    .cal-ep-meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 0.72rem;
      color: var(--text-muted);
    }
    .cal-ep-meta span { display: flex; align-items: center; gap: 3px; }
    .cal-loading, .cal-empty {
      grid-column: 1/-1;
      text-align: center;
      padding: 3rem 1rem;
      color: var(--text-muted);
    }
    .cal-empty i { font-size: 2.5rem; margin-bottom: 1rem; display: block; }
    .cal-empty p { margin-bottom: 1rem; }

    /* ── Tiempo transcurrido en capítulos recientes ── */
    .rec-ep-time-ago {
      font-size: 0.68rem;
      color: var(--accent);
      margin-top: 3px;
      opacity: 0.85;
    }

    /* ── Continuar Viendo mejorado ── */
    .cw-meta-row { font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 2px; }
    .cw-date     { font-size: 0.68rem; color: var(--text-muted); margin-bottom: 4px; }
    .cw-title    { font-size: 0.82rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }

    /* ── Vista Sección Dedicada ── */
    #sectionPageView { display: none; }
    .section-page-header { padding: 1.5rem 0 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem; }
    .section-page-title  { font-size: 1.5rem; font-weight: 800; color: var(--text-primary); margin: 0 0 0.25rem; }
    .section-page-sub    { font-size: 0.85rem; color: var(--text-muted); }
    #sectionPageGrid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 14px;
    }

    /* ── Paginación profesional ── */
    .pagination-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 1.5rem 0;
    }
    .pg-btn {
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-secondary);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .pg-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .pg-btn.active { background: var(--accent); border-color: var(--accent); color: #0a0a18; }
    .pg-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .pg-ellipsis { color: var(--text-muted); font-size: 0.9rem; padding: 0 4px; }
    .pg-info { font-size: 0.82rem; color: var(--text-muted); padding: 0 8px; }
    .pg-icon-btn {
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.15s;
    }
    .pg-icon-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .pg-icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* ── Temporada card extra info ── */
    .temporada-card .anime-info { padding: 8px; }

    /* ── Botones "Ver Todo" en secciones ── */
    .section-ver-todo {
      font-size: 0.78rem;
      color: var(--accent);
      background: none;
      border: 1px solid var(--accent);
      border-radius: 6px;
      padding: 3px 12px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      font-weight: 600;
    }
    .section-ver-todo:hover { background: var(--accent); color: #0a0a18; }
  `;
  document.head.appendChild(s);
}

// Sobrescribir mostrarVista para manejar sectionPageView
const _origMostrarVistaV4 = typeof window.mostrarVista === "function" ? window.mostrarVista : null;

function navigateTo(vista) {
  // Quitar el anti-flash si existe
  if (window._removeAntiFlash) { window._removeAntiFlash(); window._removeAntiFlash = null; }

  // Agregar sectionPageView a las vistas conocidas
  const allViews = ["homeView","detailsView","airingView","calendarView","favoritesView","playlistsView","playerView","directoryView","sectionPageView"];

  if (vista !== "playerView") {
    const iframe = document.getElementById("videoPlayer");
    const native = document.getElementById("videoPlayerNative");
    if (iframe && iframe.src) { iframe.src = ""; iframe.style.display = "none"; }
    if (native && native.src) { native.src = ""; native.style.display = "none"; }
  }

  allViews.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (id === vista) ? (id === "playerView" ? "flex" : "block") : "none";
  });

  document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
  const sideMap = {
    homeView: "sideHome", airingView: "sideAiring", calendarView: "sideCalendar",
    favoritesView: "sideFavorites", playlistsView: "sidePlaylists", directoryView: "sideDirectory",
  };
  if (sideMap[vista]) document.getElementById(sideMap[vista])?.classList.add("active");

  if (vista === "detailsView") {
    const dc = document.getElementById("detailsContainer");
    if (dc) dc.style.display = "flex";
  }
  const sidebarRight = document.getElementById("sidebarRight");
  if (sidebarRight) sidebarRight.style.display = (vista === "playerView") ? "none" : "";

  _cerrarPlaylistDropdown();
}

// Reemplazar mostrarVista global
window.mostrarVista = navigateTo;

// ═══════════════════════════════════════════════════
// 12. POPSTATE — soporte del botón atrás con rutas nuevas
// ═══════════════════════════════════════════════════

window.addEventListener("popstate", (e) => {
  const path   = e.state?.path || location.pathname;
  const gParam = new URLSearchParams(location.search).get("g");

  // Si hay un género en la URL actual, cargarlo
  if (gParam) {
    loadGeneroPage(gParam);
    return;
  }

  // Si volvemos al inicio (sin query params y sin sub-ruta)
  const isHome = !location.search && (!location.pathname || location.pathname === "/" || location.pathname === location.origin + "/");
  if (isHome) {
    setSearchState("idle");
    _sectionType        = "";
    _generoActivoSlug   = null;
    _generoActivoNombre = null;
    const iframe = document.getElementById("videoPlayer");
    const native = document.getElementById("videoPlayerNative");
    if (iframe) { iframe.style.display = "none"; iframe.src = ""; }
    if (native) { native.style.display = "none"; native.src = ""; }
    navigateTo("homeView");
    return;
  }

  resolveRoute(path);
});

// ═══════════════════════════════════════════════════
// INICIALIZACIÓN DEL PATCH
// ═══════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  _injectNewStyles();

  // Botones de paginación de sección dedicada
  const spPrev  = document.getElementById("sectionPagePrev");
  const spNext  = document.getElementById("sectionPageNext");
  const spFirst = document.getElementById("sectionPageFirst");
  const spLast  = document.getElementById("sectionPageLast");
  if (spPrev)  spPrev.addEventListener("click",  sectionPagePrev);
  if (spNext)  spNext.addEventListener("click",  sectionPageNext);
  if (spFirst) spFirst.addEventListener("click", sectionPageFirst);
  if (spLast)  spLast.addEventListener("click",  sectionPageLast);

  // Botones primera/última para el catálogo home
  const cfFirst = document.getElementById("btnCatalogFirst");
  const cfLast  = document.getElementById("btnCatalogLast");
  if (cfFirst) cfFirst.addEventListener("click", catalogFirst);
  if (cfLast)  cfLast.addEventListener("click",  catalogLast);

  // Injectar nav de días en el calendario si el elemento existe
  const calView = document.getElementById("calendarView");
  if (calView && !document.getElementById("calendarDayNav")) {
    const nav = document.createElement("div");
    nav.id = "calendarDayNav";
    nav.className = "cal-day-nav";
    const statusEl = document.getElementById("calendarStatus");
    if (statusEl) statusEl.parentNode.insertBefore(nav, statusEl.nextSibling);
    else calView.prepend(nav);
  }

  console.info("[Patch] Mejoras v4 cargadas correctamente.");
});
