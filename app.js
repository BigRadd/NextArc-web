/* =============================================
   ANIMEFLIX — app.js v2.0
   ============================================= */

"use strict";

// ─── CONFIGURACIÓN ────────────────────────────
const API_KEY  = "dev-anime1v-key";
const BASE_URL = "https://nextarc.onrender.com/api/v1/anime";
const JIKAN    = "https://api.jikan.moe/v4";

const apiHeaders = {
  "X-API-Key": API_KEY,
  "Content-Type": "application/json",
};

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

let servidoresStreamCache   = [];
let servidoresDownloadCache = [];
let modoModalActual         = "stream";
let numeroEpisodioActual    = "?";

// ─── USUARIO / AUTH (localStorage) ───────────
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
  } else {
    currentUser.favorites.push({
      mal_id: animeObj.mal_id,
      title:  animeObj.title,
      image:  animeObj.images?.jpg?.image_url || "",
      score:  animeObj.score,
      type:   animeObj.type,
    });
    showToast(`"${animeObj.title}" agregado a favoritos ★`);
  }
  saveUser();
  refreshFavViews();
}

function toggleFavoriteFromDetail() {
  if (!animeActualMAL) return;
  toggleFavorite(animeActualMAL);
  updateFavBtn();
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

// ─── TOAST ────────────────────────────────────
function showToast(msg, type = "ok") {
  const t = document.getElementById("toastMsg");
  t.textContent = msg;
  t.className = `toast${type === "error" ? " error" : ""}`;
  setTimeout(() => t.classList.add("show"), 10);
  clearTimeout(t._timeout);
  t._timeout = setTimeout(() => t.classList.remove("show"), 3200);
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

function doLogin() {
  const user = document.getElementById("loginUser").value.trim();
  const pass = document.getElementById("loginPass").value;
  if (!user || !pass) { showToast("Completa todos los campos", "error"); return; }

  const stored = JSON.parse(localStorage.getItem(`animeflix_account_${user}`) || "null");
  if (!stored || stored.password !== btoa(pass)) {
    showToast("Usuario o contraseña incorrectos", "error"); return;
  }
  currentUser = stored;
  saveUser();
  openUserSection();
  showToast(`¡Bienvenido de nuevo, ${currentUser.username}!`);
}

function doRegister() {
  const user = document.getElementById("regUser").value.trim();
  const pass = document.getElementById("regPass").value;
  if (!user || pass.length < 6) { showToast("Usuario o contraseña inválidos (mín. 6 caracteres)", "error"); return; }
  if (localStorage.getItem(`animeflix_account_${user}`)) {
    showToast("Ese nombre de usuario ya existe", "error"); return;
  }
  const newAccount = { username: user, password: btoa(pass), favorites: [] };
  localStorage.setItem(`animeflix_account_${user}`, JSON.stringify(newAccount));
  currentUser = newAccount;
  saveUser();
  openUserSection();
  showToast(`¡Cuenta creada! Bienvenido, ${user} 🎉`);
}

function doLogout() {
  currentUser = null;
  saveUser();
  document.getElementById("userSection").style.display = "none";
  document.getElementById("authSection").style.display = "block";
  showToast("Sesión cerrada");
}

function openUserSection() {
  document.getElementById("authSection").style.display = "none";
  document.getElementById("userSection").style.display = "block";
  document.getElementById("profileUsername").textContent = currentUser.username;
  refreshFavViews();
  document.getElementById("profileFavCount").textContent = `${getFavorites().length} favoritos guardados`;
}

// ─── VISTAS ───────────────────────────────────
const VIEWS = ["homeView", "detailsView", "airingView", "calendarView", "favoritesView"];

function mostrarVista(vista) {
  VIEWS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (id === vista) ? "block" : "none";
  });
  // Active state en sidebar
  document.querySelectorAll(".sidebar-item").forEach(el => el.classList.remove("active"));
  if (vista === "homeView")      document.getElementById("sideHome")?.classList.add("active");
  if (vista === "airingView")    document.getElementById("sideAiring")?.classList.add("active");
  if (vista === "calendarView")  document.getElementById("sideCalendar")?.classList.add("active");
  if (vista === "favoritesView") document.getElementById("sideFavorites")?.classList.add("active");

  if (vista === "detailsView") {
    document.getElementById("detailsContainer").style.display = "flex";
  }
}

// ─── HERO BANNER ──────────────────────────────
function buildHero() {
  heroAnimes = localAnimeData.slice(0, 6).filter(a => a.images?.jpg?.large_image_url);
  if (!heroAnimes.length) return;

  const banner = document.getElementById("heroBanner");
  const dotsEl = document.getElementById("heroDots");

  // Crear slides
  heroAnimes.forEach((anime, i) => {
    const slide = document.createElement("div");
    slide.className = `hero-slide${i === 0 ? " active" : ""}`;
    slide.style.backgroundImage = `url('${anime.images.jpg.large_image_url || anime.images.jpg.image_url}')`;
    banner.insertBefore(slide, banner.querySelector(".hero-overlay"));
  });

  // Dots
  heroAnimes.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = `hero-dot${i === 0 ? " active" : ""}`;
    dot.addEventListener("click", () => goToHeroSlide(i));
    dotsEl.appendChild(dot);
  });

  updateHeroContent(0);
  startHeroTimer();
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

// ─── CATÁLOGO ─────────────────────────────────
async function loadAnime() {
  try {
    const res  = await fetch(`${JIKAN}/top/anime?limit=24`);
    const data = await res.json();
    localAnimeData = data.data || [];
    filteredAnimeData = localAnimeData;
    renderGrid(filteredAnimeData);
    buildHero();
    loadSidebarAiring();
  } catch (err) {
    console.error("Error cargando catálogo:", err);
    document.getElementById("animeGrid").innerHTML =
      `<p style="color:var(--text-muted);grid-column:1/-1;"><i class="fas fa-exclamation-triangle"></i> No se pudo cargar el catálogo.</p>`;
  }
}

function renderGrid(animes) {
  const grid = document.getElementById("animeGrid");
  grid.innerHTML = "";

  const count = document.getElementById("catalogCount");
  if (count) count.textContent = `${animes.length} títulos`;

  if (!animes.length) {
    grid.innerHTML = `<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:2rem;">
      <i class="fas fa-search"></i> No se encontraron resultados.
    </p>`;
    return;
  }

  animes.forEach(anime => {
    const genres = anime.genres ? anime.genres.map(g => g.name).join(", ") : "";
    const card = document.createElement("div");
    card.className = "anime-card";
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
      ["Movie","OVA","ONA","Special","Music"].includes(a.type)
    );
    if (titleEl) titleEl.textContent = "Películas, OVAs y Especiales";
  } else {
    filteredAnimeData = localAnimeData.filter(a =>
      !["Movie"].includes(a.type) || !a.type
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
        <span class="anime-type-badge" style="background:rgba(0,212,170,0.85);color:#0a0a18;">AIRING</span>
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
    // Add to localAnimeData if not present
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
  const todayN = new Date().getDay(); // 0=Sun
  // Convert JS day (0=Sun) to our index (0=Mon)
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
  document.getElementById("tabStream").classList.toggle("active", mode === "stream");
  document.getElementById("tabDownload").classList.toggle("active", mode === "download");

  const player    = document.getElementById("videoPlayer");
  const actionBox = document.getElementById("downloadActionBox");

  if (mode === "stream") {
    actionBox.style.display = "none";
    player.style.display    = "block";
    renderizarBotonesDeServidor(servidoresStreamCache);
  } else {
    player.style.display    = "none";
    player.src              = "";
    actionBox.style.display = "block";
    renderizarBotonesDeServidor(servidoresDownloadCache);
  }
}

// ─── STREAMING ────────────────────────────────
async function procesarStreamingEpisodio(episodeObj) {
  const modal       = document.getElementById("videoModal");
  const modalTitle  = document.getElementById("modalTitle");
  const serverCont  = document.getElementById("modalServers");

  modalTitle.textContent = "Buscando servidores disponibles...";
  serverCont.innerHTML   = "";
  modal.style.display    = "flex";

  numeroEpisodioActual     = episodeObj.number || "?";
  servidoresStreamCache    = [];
  servidoresDownloadCache  = [];
  setModalMode("stream");

  const esUrlFalsa = !episodeObj.url ||
    episodeObj.url.includes("mock-provider") ||
    episodeObj.url.includes("undefined") ||
    (
      !episodeObj.url.includes("animeav1.com") &&
      !episodeObj.url.includes("jkanime.net")  &&
      !episodeObj.url.includes("animeflv.net")
    );

  if (esModoDemoActivo || esUrlFalsa) {
    setTimeout(() => {
      servidoresStreamCache   = [{ server: "Servidor Demo", embed_url: "https://vjs.zencdn.net/v/oceans.mp4" }];
      servidoresDownloadCache = [{ server: "Mega Demo", url: "https://mega.nz" }];
      renderizarBotonesDeServidor(servidoresStreamCache);
    }, 300);
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/episode?url=${encodeURIComponent(episodeObj.url)}`, { headers: apiHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();

    if (result?.success && result.data) {
      const lk   = idiomaActual.toLowerCase();
      const lkU  = idiomaActual.toUpperCase();

      servidoresStreamCache   = result.data.servers?.[lk] || result.data.streamLinks?.[lkU] || [];
      servidoresDownloadCache = result.data.downloadLinks?.[lkU] || servidoresStreamCache.filter(s => s.url || s.download_url);

      if (servidoresStreamCache.length || servidoresDownloadCache.length) {
        renderizarBotonesDeServidor(servidoresStreamCache);
        return;
      }
    }
    throw new Error("Sin enlaces.");
  } catch(err) {
    console.warn("[Fallback stream]", err.message);
    servidoresStreamCache   = [{ server: "Reproductor Seguro", embed_url: "https://vjs.zencdn.net/v/oceans.mp4" }];
    servidoresDownloadCache = [{ server: "Descarga Emergencia", url: "https://vjs.zencdn.net/v/oceans.mp4" }];
    renderizarBotonesDeServidor(servidoresStreamCache);
  }
}

function renderizarBotonesDeServidor(listaServidores) {
  const modalTitle      = document.getElementById("modalTitle");
  const videoPlayer     = document.getElementById("videoPlayer");
  const serverCont      = document.getElementById("modalServers");
  const downloadBtn     = document.getElementById("downloadDirectBtn");

  serverCont.innerHTML  = "";
  modalTitle.textContent = `${animeActualBackend?.title || animeActualMAL?.title || "Anime"} — Ep. ${numeroEpisodioActual} (${idiomaActual.toUpperCase()})`;

  if (!listaServidores?.length) {
    serverCont.innerHTML = `<p style="color:var(--text-muted);font-size:0.88rem;">
      <i class="fas fa-exclamation-circle"></i> Sin servidores disponibles en ${idiomaActual.toUpperCase()}.
    </p>`;
    videoPlayer.src = "";
    downloadBtn.href = "#";
    return;
  }

  // Preferencia guardada
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
      if (modoModalActual === "stream") videoPlayer.src = server.embed_url || server.url;
      else downloadBtn.href = server.url || server.download_url || "#";
    });
    serverCont.appendChild(btn);
  });

  const activeIdx = Math.min(prefIdx, listaServidores.length - 1);
  if (modoModalActual === "stream") {
    videoPlayer.src = listaServidores[activeIdx].embed_url || listaServidores[activeIdx].url;
  } else {
    downloadBtn.href = listaServidores[activeIdx].url || listaServidores[activeIdx].download_url || "#";
  }
}

// ─── LISTA EPISODIOS ──────────────────────────
function construirListaEpisodios(episodesArray) {
  const epGrid   = document.getElementById("episodeGrid");
  const epCount  = document.getElementById("epCount");
  epGrid.innerHTML = "";

  if (!episodesArray?.length) {
    epGrid.innerHTML = `<p style="color:var(--text-muted);padding:10px;grid-column:1/-1;">
      <i class="fas fa-info-circle"></i> No se encontraron episodios.
    </p>`;
    if (epCount) epCount.textContent = "";
    return;
  }

  if (epCount) epCount.textContent = `${episodesArray.length} episodios`;

  episodesArray.forEach(ep => {
    const numeroEpisodio = typeof ep === "object" ? (ep.number || ep.episode || ep.id) : ep;
    const btn = document.createElement("button");
    btn.className = "episode-btn";
    btn.textContent = `Ep. ${numeroEpisodio}`;

    btn.addEventListener("click", () => {
      const epPayload = { number: numeroEpisodio };
      if (typeof ep === "object" && ep.url) {
        epPayload.url = ep.url;
      } else {
        const baseUrl = animeActualBackend?.url || "";
        epPayload.url = baseUrl
          ? (baseUrl.endsWith("/") ? `${baseUrl}${numeroEpisodio}` : `${baseUrl}-${numeroEpisodio}`)
          : `https://mock-provider.com/episode-${numeroEpisodio}`;
      }
      procesarStreamingEpisodio(epPayload);
    });
    epGrid.appendChild(btn);
  });
}

// ─── VER DETALLES ─────────────────────────────
async function verDetallesAnime(animeId) {
  const anime = localAnimeData.find(a => a.mal_id == animeId);
  if (!anime) return;

  animeActualMAL     = anime;
  animeActualBackend = null;
  esModoDemoActivo   = false;

  // Poblar UI básica
  document.getElementById("detPoster").style.backgroundImage = `url('${anime.images.jpg.large_image_url || anime.images.jpg.image_url}')`;
  document.getElementById("detTitle").textContent     = anime.title;
  document.getElementById("detSynopsis").textContent  = "Conectando con los scrapers...";

  const meta = document.getElementById("detMeta");
  meta.innerHTML = [
    anime.score    ? `<span class="details-meta-item"><i class="fas fa-star" style="color:var(--warning)"></i> ${anime.score}</span>` : "",
    anime.year     ? `<span class="details-meta-item">📅 ${anime.year}</span>` : "",
    anime.type     ? `<span class="details-meta-item">${anime.type}</span>` : "",
    anime.episodes ? `<span class="details-meta-item">${anime.episodes} eps</span>` : "",
    anime.status   ? `<span class="details-meta-item">${anime.status}</span>` : "",
  ].join("");

  const genresEl = document.getElementById("detGenres");
  genresEl.innerHTML = (anime.genres || []).map(g =>
    `<span style="background:var(--bg-elevated);border:1px solid var(--border);padding:2px 10px;border-radius:4px;font-size:0.78rem;color:var(--text-secondary);">${g.name}</span>`
  ).join("");

  const epGrid    = document.getElementById("episodeGrid");
  const statusInd = document.getElementById("statusIndicator");

  epGrid.innerHTML = `<p style="color:var(--accent);grid-column:1/-1;"><i class="fas fa-spinner fa-spin"></i> Conectando...</p>`;
  mostrarVista("detailsView");
  updateFavBtn();

  let resultsArray  = [];
  let origenServidor = "Local";

  try {
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
        animeActualBackend = infoResult.data;

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
    }
    throw new Error("Sin registros en scraper.");
  } catch(err) {
    // Fallback limpio con datos de Jikan
    esModoDemoActivo = true;
    statusInd.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Modo Demo`;
    statusInd.style.background = "var(--warning)";
    statusInd.style.color      = "#0a0a18";

    document.getElementById("detSynopsis").textContent = anime.synopsis || "Sin descripción disponible.";

    const totalEps = typeof anime.episodes === "number" && anime.episodes > 0 ? anime.episodes : 12;
    animeActualBackend = {
      title: anime.title, url: "",
      episodes: Array.from({ length: totalEps }, (_, i) => ({
        number: i + 1,
        url:    `https://mock-provider.com/episode-${i + 1}`,
      })),
    };
    construirListaEpisodios(animeActualBackend.episodes);
  }
}

// ─── BÚSQUEDA ─────────────────────────────────
// ─── BÚSQUEDA CORREGIDA (Pinta todos los resultados) ──────────
async function buscarPorNombreYVer(nombre) {
  try {
    showToast(`Buscando "${nombre}"...`);
    
    // 1. Quitamos el &limit=1 para que traiga todo lo relacionado (Series, películas, ovas)
    const res  = await fetch(`${JIKAN}/anime?q=${encodeURIComponent(nombre)}`);
    const data = await res.json();
    
    if (data.data?.length) {
      // 2. Registramos los animes nuevos en el catálogo local para que no rompa al darles clic
      data.data.forEach(found => {
        if (!localAnimeData.find(a => a.mal_id === found.mal_id)) {
          localAnimeData.push(found);
        }
      });
      
      // 3. Mandamos al usuario a la vista de inicio (Home)
      mostrarVista("homeView");
      
      // 4. Ocultamos el Hero Banner y las pestañas de filtro para que
      //    los resultados suban limpiamente al primer plano
      const heroBanner = document.getElementById("heroBanner");
      if (heroBanner) heroBanner.style.display = "none";
      document.querySelectorAll(".nav-tab").forEach(tab => {
        tab.style.display = "none";
      });
      
      // 5. Cambiamos el título del catálogo para avisar qué se buscó
      const titleEl = document.getElementById("catalogTitle");
      if (titleEl) titleEl.textContent = `Resultados para: "${nombre}"`;
      
      // 6. Pintamos la lista completa de resultados en tu grid existente
      renderGrid(data.data);
      
    } else {
      showToast("No se encontraron resultados", "error");
    }
  } catch(err) {
    console.error("Búsqueda fallida:", err);
    showToast("Error de búsqueda", "error");
  }
}

// ─── EVENTOS ──────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

  loadUser();
  loadSettings();

  // Cierre modal video
  document.getElementById("closeModal").addEventListener("click", () => {
    const modal  = document.getElementById("videoModal");
    const player = document.getElementById("videoPlayer");
    modal.style.display = "none";
    player.src = "";
  });

  // Botón volver
  document.getElementById("backToHomeBtn").addEventListener("click", () => {
    const heroBanner = document.getElementById("heroBanner");
    if (heroBanner && heroBanner.style.display === "none") heroBanner.style.display = "block";
    document.querySelectorAll(".nav-tab").forEach(tab => {
      if (tab.style.display === "none") tab.style.display = "";
    });
    mostrarVista("homeView");
  });

  // Logo
  document.getElementById("brandLogo").addEventListener("click", () => {
    const heroBanner = document.getElementById("heroBanner");
    if (heroBanner && heroBanner.style.display === "none") heroBanner.style.display = "block";
    document.querySelectorAll(".nav-tab").forEach(tab => {
      if (tab.style.display === "none") tab.style.display = "";
    });
    mostrarVista("homeView");
  });

  // Sidebar navegación
  document.getElementById("sideHome").addEventListener("click", e => {
    e.preventDefault();
    const heroBanner = document.getElementById("heroBanner");
    if (heroBanner && heroBanner.style.display === "none") heroBanner.style.display = "block";
    document.querySelectorAll(".nav-tab").forEach(tab => {
      if (tab.style.display === "none") tab.style.display = "";
    });
    mostrarVista("homeView");
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

  // Búsqueda
  document.getElementById("globalSearchInput").addEventListener("keypress", function(e) {
    if (e.key === "Enter" && this.value.trim()) {
      buscarPorNombreYVer(this.value.trim());
    }
  });

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
    // Mostrar sección correcta
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
      const vm = document.getElementById("videoModal");
      if (vm.style.display === "flex") {
        vm.style.display = "none";
        document.getElementById("videoPlayer").src = "";
      }
    }
  });

  // Carga inicial
  loadAnime();
});
