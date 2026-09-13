const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MAX_CITIES = 5;
const STORAGE_KEYS = { cities: "yunxiang-cities", users: "yunxiang-users", session: "yunxiang-session" };

const defaultCities = [
  { id: "beijing-39.9042-116.4074", name: "北京", country: "中国", admin1: "北京市", latitude: 39.9042, longitude: 116.4074, timezone: "Asia/Shanghai" },
  { id: "qingdao-36.0671-120.3826", name: "青岛", country: "中国", admin1: "山东省", latitude: 36.0671, longitude: 120.3826, timezone: "Asia/Shanghai" }
];

const state = {
  cities: readJSON(STORAGE_KEYS.cities, defaultCities),
  selectedId: null,
  forecasts: new Map(),
  errors: new Map(),
  authMode: "login",
  isRefreshing: false
};

const els = {
  cityList: document.querySelector("#cityList"),
  cityCount: document.querySelector("#cityCount"),
  selectedCityTitle: document.querySelector("#selectedCityTitle"),
  weatherView: document.querySelector("#weatherView"),
  liveState: document.querySelector("#liveState"),
  citySearchForm: document.querySelector("#citySearchForm"),
  cityInput: document.querySelector("#cityInput"),
  searchResults: document.querySelector("#searchResults"),
  refreshButton: document.querySelector("#refreshButton"),
  accountTrigger: document.querySelector("#accountTrigger"),
  authDialog: document.querySelector("#authDialog"),
  accountDialog: document.querySelector("#accountDialog")
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  state.selectedId = state.cities[0]?.id || null;
  bindEvents();
  renderCities();
  updateAccountButton();
  if (state.cities.length) {
    Promise.allSettled(state.cities.map((city) => loadForecast(city, false))).then(() => {
      renderCities();
      renderSelectedCity();
    });
    window.setInterval(() => {
      state.cities.forEach((city) => loadForecast(city, true));
    }, 15 * 60 * 1000);
  } else {
    renderEmptyState();
  }
}

function bindEvents() {
  els.citySearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchCities(els.cityInput.value.trim());
  });
  els.cityInput.addEventListener("input", debounce(() => {
    if (els.cityInput.value.trim().length >= 2) searchCities(els.cityInput.value.trim(), true);
    else hideSearchResults();
  }, 350));
  els.refreshButton.addEventListener("click", () => {
    const city = getSelectedCity();
    if (city) loadForecast(city, true);
  });
  els.accountTrigger.addEventListener("click", () => {
    if (getSession()) openAccountDialog();
    else openAuthDialog("login");
  });
  document.querySelector("#authClose").addEventListener("click", () => els.authDialog.close());
  document.querySelector("#accountClose").addEventListener("click", () => els.accountDialog.close());
  document.querySelector("#loginTab").addEventListener("click", () => setAuthMode("login"));
  document.querySelector("#registerTab").addEventListener("click", () => setAuthMode("register"));
  document.querySelector("#authForm").addEventListener("submit", handleAuthSubmit);
  document.querySelector("#logoutButton").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEYS.session);
    els.accountDialog.close();
    updateAccountButton();
    showToast("已退出本机账户");
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-form")) hideSearchResults();
  });
}

async function searchCities(query, isLive = false) {
  if (!query) { hideSearchResults(); return; }
  const button = els.citySearchForm.querySelector("button");
  button.textContent = "读取中";
  button.disabled = true;
  try {
    const url = new URL(GEOCODE_URL);
    url.search = new URLSearchParams({ name: query, count: "6", language: "zh", format: "json" });
    const response = await fetch(url);
    if (!response.ok) throw new Error("城市搜索暂时不可用");
    const json = await response.json();
    renderSearchResults(json.results || []);
  } catch (error) {
    renderSearchMessage(error.message || "城市搜索失败");
  } finally {
    button.textContent = "搜索";
    button.disabled = false;
  }
}

function renderSearchResults(results) {
  if (!results.length) {
    renderSearchMessage("没有找到这个城市，请换一种写法");
    return;
  }
  els.searchResults.innerHTML = results.map((place, index) => {
    const location = [place.admin1, place.country].filter(Boolean).join(" · ");
    return `<button class="search-result" type="button" data-result-index="${index}">
      <span><strong>${escapeHTML(place.name)}</strong><span>${escapeHTML(location || "未知地区")}</span></span>
      <span class="result-add">加入 +</span>
    </button>`;
  }).join("");
  els.searchResults.hidden = false;
  [...els.searchResults.querySelectorAll(".search-result")].forEach((button, index) => {
    button.addEventListener("click", () => addSearchResult(results[index]));
  });
}

function renderSearchMessage(message) {
  els.searchResults.innerHTML = `<div class="search-result"><span>${escapeHTML(message)}</span></div>`;
  els.searchResults.hidden = false;
}

async function addSearchResult(place) {
  const city = normalizePlace(place);
  const existing = state.cities.find((item) => item.id === city.id || distance(item, city) < 0.01);
  if (existing) {
    state.selectedId = existing.id;
    hideSearchResults();
    renderCities();
    renderSelectedCity();
    return;
  }
  if (state.cities.length >= MAX_CITIES) {
    renderSearchMessage("关注城市已达到 5 个，请先移除一个城市");
    return;
  }
  state.cities.push(city);
  state.selectedId = city.id;
  persistCities();
  hideSearchResults();
  els.cityInput.value = "";
  renderCities();
  await loadForecast(city, false);
}

function normalizePlace(place) {
  const safeName = place.name || "未知城市";
  return {
    id: `${slugify(safeName)}-${Number(place.latitude).toFixed(4)}-${Number(place.longitude).toFixed(4)}`,
    name: safeName,
    country: place.country || "",
    admin1: place.admin1 || "",
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    timezone: place.timezone || "auto"
  };
}

async function loadForecast(city, forceRefresh) {
  if (!city) return;
  if (!forceRefresh && state.forecasts.has(city.id)) {
    renderCities();
    renderSelectedCity();
    return;
  }
  state.errors.delete(city.id);
  if (city.id === state.selectedId) renderLoading(city);
  if (city.id === state.selectedId) setRefreshLoading(true);
  try {
    const params = new URLSearchParams({
      latitude: String(city.latitude),
      longitude: String(city.longitude),
      timezone: "auto",
      forecast_days: "7",
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m",
      hourly: "temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,rain,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset"
    });
    const response = await fetch(`${FORECAST_URL}?${params.toString()}`);
    if (!response.ok) throw new Error(`天气源返回 ${response.status}`);
    const data = await response.json();
    state.forecasts.set(city.id, { ...data, retrievedAt: new Date().toISOString(), sourceUrl: `${FORECAST_URL}?${params.toString()}` });
    setLiveState("ready");
  } catch (error) {
    state.errors.set(city.id, error.message || "天气读取失败");
    if (city.id === state.selectedId) setLiveState("error");
  } finally {
    if (city.id === state.selectedId) setRefreshLoading(false);
    renderCities();
    renderSelectedCity();
  }
}

function renderCities() {
  els.cityCount.textContent = `${state.cities.length} / ${MAX_CITIES}`;
  els.cityList.innerHTML = state.cities.map((city) => {
    const forecast = state.forecasts.get(city.id);
    const current = forecast?.current;
    const error = state.errors.get(city.id);
    return `<button class="city-card ${city.id === state.selectedId ? "is-selected" : ""}" type="button" data-city-id="${escapeHTML(city.id)}">
      <strong>${escapeHTML(city.name)}</strong>
      <span class="city-temp">${current ? `${round(current.temperature_2m)}°` : "—"}</span>
      <small class="city-condition">${error ? "读取失败" : current ? weatherLabel(current.weather_code) : "正在读取…"}</small>
      <small>${current ? `湿度 ${round(current.relative_humidity_2m)}%` : ""}</small>
      <span class="city-loading">${error ? "重试" : ""}</span>
      <span class="remove-city" role="button" tabindex="0" aria-label="移除${escapeHTML(city.name)}" data-remove-id="${escapeHTML(city.id)}">×</span>
    </button>`;
  }).join("");
  [...els.cityList.querySelectorAll(".city-card")].forEach((card) => {
    card.addEventListener("click", (event) => {
      const removeId = event.target.closest("[data-remove-id]")?.dataset.removeId;
      if (removeId) { event.stopPropagation(); removeCity(removeId); return; }
      state.selectedId = card.dataset.cityId;
      renderCities();
      renderSelectedCity();
      const city = getSelectedCity();
      if (city && !state.forecasts.has(city.id)) loadForecast(city, false);
    });
  });
}

function renderSelectedCity() {
  const city = getSelectedCity();
  if (!city) { renderEmptyState(); return; }
  els.selectedCityTitle.textContent = city.name;
  const forecast = state.forecasts.get(city.id);
  const error = state.errors.get(city.id);
  if (!forecast) { renderLoading(city, error); return; }
  els.weatherView.innerHTML = renderWeather(forecast, city);
  bindChartInteractions(forecast);
}

function renderWeather(data, city) {
  const current = data.current;
  const currentUnits = data.current_units || {};
  const condition = weatherLabel(current.weather_code);
  const currentHour = findCurrentHour(data);
  const daily = getDailyRows(data);
  const analysis = analyzeDaily(daily);
  return `<article class="current-card">
    <div class="current-topline"><div class="city-meta"><strong>${escapeHTML(city.name)}</strong>${escapeHTML([city.admin1, city.country].filter(Boolean).join(" · "))}</div><span class="now-label">CURRENT / ${formatLocalDateTime(current.time, data.timezone)}</span></div>
    <div class="current-hero"><div class="temp-reading"><span class="temp-number">${round(current.temperature_2m)}</span><span class="temp-unit">${escapeHTML(currentUnits.temperature_2m || "°C")}</span></div><div class="condition-block"><span class="condition-mark ${isRainCode(current.weather_code) ? "is-rain" : ""}" aria-hidden="true"></span><strong>${condition}</strong><span>体感 ${round(current.apparent_temperature)}${escapeHTML(currentUnits.apparent_temperature || "°C")}</span></div></div>
    <div class="metrics-grid"><div class="metric"><span class="metric-label">湿度</span><span class="metric-value">${round(current.relative_humidity_2m)}<span class="metric-unit">${escapeHTML(currentUnits.relative_humidity_2m || "%")}</span></span></div><div class="metric"><span class="metric-label">风力</span><span class="metric-value">${round(current.wind_speed_10m)}<span class="metric-unit">${escapeHTML(currentUnits.wind_speed_10m || "km/h")}</span></span></div><div class="metric"><span class="metric-label">风向</span><span class="metric-value">${degToCompass(current.wind_direction_10m)}<span class="metric-unit">${round(current.wind_direction_10m)}°</span></span></div><div class="metric"><span class="metric-label">近 1 小时降水</span><span class="metric-value">${formatNumber(current.precipitation)}<span class="metric-unit">${escapeHTML(currentUnits.precipitation || "mm")}</span></span></div></div>
  </article>
  <div class="data-grid"><article class="data-card panel"><div class="data-heading"><div><h3>接下来 12 小时</h3><p>逐小时降雨概率，百分比不是降水量</p></div><span class="data-kicker">RAIN CHANCE</span></div><div class="hourly-scroll"><div class="hourly-strip">${renderHourly(data, currentHour)}</div></div></article><article class="data-card panel chart-card"><div class="data-heading"><div><h3>降水趋势</h3><p>每日累计降水量</p></div><span class="data-kicker">mm / DAY</span></div>${renderRainChart(daily)}<p class="chart-footnote">悬停或聚焦节点查看精确数值；缺失值保留为空。</p></article></div>
  <article class="seven-day-card panel"><div class="seven-day-head"><div><h3>未来七天分析</h3><p>${analysis.subtitle}</p></div><div class="analysis-note">${analysis.note}</div></div><div class="days-grid">${daily.map((day, index) => renderDay(day, index === 0)).join("")}</div><div class="source-note"><span>数据源：<a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo Forecast API</a> · 页面获取于 ${formatRetrieved(data.retrievedAt)}</span><span>时区：${escapeHTML(data.timezone || city.timezone || "自动")}</span></div></article>`;
}

function renderHourly(data, startIndex) {
  const h = data.hourly;
  if (!h?.time?.length) return "<p>暂无逐小时数据</p>";
  return h.time.slice(startIndex, startIndex + 12).map((time, offset) => {
    const i = startIndex + offset;
    const probability = numberOrNull(h.precipitation_probability?.[i]);
    const temp = numberOrNull(h.temperature_2m?.[i]);
    const rain = numberOrNull(h.precipitation?.[i]);
    const pct = probability ?? 0;
    return `<div class="hour-cell ${offset === 0 ? "is-now" : ""}"><span class="hour-time">${offset === 0 ? "现在" : formatHour(time)}</span><span class="hour-temp">${temp === null ? "—" : `${round(temp)}°`}</span><span class="probability-bar" title="降雨概率 ${probability === null ? "暂无数据" : `${round(probability)}%`}"><span style="height:${Math.max(0, Math.min(100, pct))}%"></span></span><span class="hour-prob">${probability === null ? "—" : `${round(probability)}%`}</span><span class="hour-rain">${rain === null ? "—" : `${formatNumber(rain)} mm`}</span></div>`;
  }).join("");
}

function renderRainChart(daily) {
  const width = 760; const height = 188; const left = 32; const right = 12; const top = 12; const bottom = 32;
  const chartWidth = width - left - right; const chartHeight = height - top - bottom;
  const values = daily.map((day) => day.amount);
  const finite = values.filter((value) => value !== null && Number.isFinite(value));
  const max = finite.length ? Math.max(...finite) : 0;
  const axisMax = max > 0 ? Math.ceil(max * 1.15 * 10) / 10 : 1;
  const points = daily.map((day, index) => day.amount === null ? null : { x: left + (chartWidth * index / Math.max(daily.length - 1, 1)), y: top + chartHeight - ((day.amount / axisMax) * chartHeight), day });
  const segments = [];
  let segment = [];
  points.forEach((point) => {
    if (point) segment.push(`${point.x},${point.y}`);
    else if (segment.length) { segments.push(segment.join(" ")); segment = []; }
  });
  if (segment.length) segments.push(segment.join(" "));
  const lineMarkup = segments.map((segmentPoints) => `<polyline class="chart-line" points="${segmentPoints}" />`).join("");
  const areaPoints = points.every(Boolean) && points.length > 1 ? `${left},${top + chartHeight} ${segments[0]} ${left + chartWidth},${top + chartHeight}` : "";
  const grid = [0, .5, 1].map((ratio) => { const y = top + chartHeight - ratio * chartHeight; return `<line class="chart-gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" /><text class="chart-axis-label" x="2" y="${y + 4}">${formatNumber(axisMax * ratio)}</text>`; }).join("");
  const labels = daily.map((day, index) => `<text class="chart-axis-label" text-anchor="middle" x="${left + (chartWidth * index / Math.max(daily.length - 1, 1))}" y="${height - 5}">${escapeHTML(day.shortDate)}</text>`).join("");
  const circles = points.map((point, index) => point ? `<circle class="chart-point" tabindex="0" role="img" aria-label="${escapeHTML(point.day.date)}，${formatNumber(point.day.amount)} 毫米" data-chart-index="${index}" cx="${point.x}" cy="${point.y}" r="5" />` : "").join("");
  return `<div class="chart-wrap"><svg class="rain-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="未来七天每日降水量折线图"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#d8ebff" stop-opacity=".9"/><stop offset="100%" stop-color="#d8ebff" stop-opacity=".08"/></linearGradient></defs>${grid}${areaPoints ? `<polygon class="chart-area" points="${areaPoints}" />` : ""}${lineMarkup}${circles}${labels}</svg><div class="chart-tooltip" id="chartTooltip"></div></div>`;
}

function renderDay(day, isToday) {
  return `<div class="day-card ${isToday ? "is-today" : ""}"><span class="day-name">${escapeHTML(day.label)}${isToday ? " · 今天" : ""}</span><span class="day-condition">${escapeHTML(day.condition)}</span><div class="day-temps"><span class="day-high">${day.high === null ? "—" : `${round(day.high)}°`}</span><span class="day-low">${day.low === null ? "—" : `${round(day.low)}°`}</span></div><span class="day-rain">${day.probability === null ? "—" : `雨 ${round(day.probability)}%`}</span><span class="day-amount">${day.amount === null ? "降水 —" : `降水 ${formatNumber(day.amount)} mm`}</span></div>`;
}

function getDailyRows(data) {
  const d = data.daily;
  return (d?.time || []).slice(0, 7).map((date, index) => ({
    date, shortDate: formatShortDate(date), label: formatDayLabel(date, index),
    condition: weatherLabel(d.weather_code?.[index]), high: numberOrNull(d.temperature_2m_max?.[index]), low: numberOrNull(d.temperature_2m_min?.[index]), amount: numberOrNull(d.precipitation_sum?.[index]), probability: numberOrNull(d.precipitation_probability_max?.[index]), wind: numberOrNull(d.wind_speed_10m_max?.[index])
  }));
}

function analyzeDaily(days) {
  const rainDays = days.filter((day) => day.probability !== null);
  const amounts = days.filter((day) => day.amount !== null);
  const maxRain = amounts.length ? amounts.reduce((best, day) => day.amount > best.amount ? day : best, amounts[0]) : null;
  const maxChance = rainDays.length ? rainDays.reduce((best, day) => day.probability > best.probability ? day : best, rainDays[0]) : null;
  const total = amounts.reduce((sum, day) => sum + day.amount, 0);
  const temps = days.filter((day) => day.high !== null && day.low !== null);
  const spread = temps.length ? Math.max(...temps.map((day) => day.high)) - Math.min(...temps.map((day) => day.low)) : null;
  const note = maxRain && maxRain.amount > 0 ? `降水集中在 ${maxRain.label}，预计累计 ${formatNumber(maxRain.amount)} mm；${maxChance ? `降雨概率峰值为 ${maxChance.label} ${round(maxChance.probability)}%。` : ""}` : maxChance ? `未来七天的降雨概率峰值在 ${maxChance.label}，为 ${round(maxChance.probability)}%；目前未读到明显的累计降水量。` : "当前七天降水数据不完整，建议刷新后再安排户外活动。";
  return { note, subtitle: `预计累计降水 ${amounts.length ? `${formatNumber(total)} mm` : "暂无"} · 高低温跨度 ${spread === null ? "暂无" : `${round(spread)}°C`}` };
}

function bindChartInteractions(data) {
  const tooltip = document.querySelector("#chartTooltip");
  if (!tooltip) return;
  const days = getDailyRows(data);
  document.querySelectorAll(".chart-point").forEach((point) => {
    const show = () => {
      const index = Number(point.dataset.chartIndex); const day = days[index];
      tooltip.innerHTML = `<strong>${escapeHTML(day.label)}</strong><span>${day.amount === null ? "暂无降水数据" : `降水 ${formatNumber(day.amount)} mm`}</span>`;
      const x = Number(point.getAttribute("cx")); const y = Number(point.getAttribute("cy"));
      tooltip.style.left = `${Math.min(Math.max((x / 760) * 100, 8), 76)}%`; tooltip.style.top = `${Math.max((y / 188) * 100 - 24, 2)}%`; tooltip.classList.add("is-visible");
    };
    point.addEventListener("mouseenter", show); point.addEventListener("focus", show);
    point.addEventListener("mouseleave", () => tooltip.classList.remove("is-visible")); point.addEventListener("blur", () => tooltip.classList.remove("is-visible"));
  });
}

function findCurrentHour(data) {
  const currentTime = data.current?.time; const times = data.hourly?.time || [];
  const exact = times.indexOf(currentTime); if (exact >= 0) return exact;
  const currentMs = Date.parse(currentTime || ""); const next = times.findIndex((time) => Date.parse(time) >= currentMs);
  return next >= 0 ? next : 0;
}

function renderLoading(city, error) {
  els.selectedCityTitle.textContent = city?.name || "正在读取天气…";
  els.weatherView.innerHTML = error ? `<div class="error-card panel"><strong>暂时无法读取 ${escapeHTML(city.name)} 的天气</strong><span>${escapeHTML(error)}</span><button type="button" id="retryButton">再次尝试</button></div>` : `<div class="loading-card panel"><span class="loading-pulse"></span>正在读取 ${escapeHTML(city?.name || "城市")} 的天气…</div>`;
  document.querySelector("#retryButton")?.addEventListener("click", () => loadForecast(city, true));
}

function renderEmptyState() { els.selectedCityTitle.textContent = "添加一个城市"; els.weatherView.innerHTML = `<div class="loading-card panel"><strong>还没有关注城市</strong><span>使用上方搜索框添加第一个城市。</span></div>`; }

function removeCity(id) {
  if (state.cities.length === 1) { showToast("至少保留一个城市，方便查看天气"); return; }
  state.cities = state.cities.filter((city) => city.id !== id); state.forecasts.delete(id); state.errors.delete(id);
  if (state.selectedId === id) state.selectedId = state.cities[0]?.id || null;
  persistCities(); renderCities(); renderSelectedCity();
}

function setRefreshLoading(isLoading) { state.isRefreshing = isLoading; els.refreshButton.classList.toggle("is-loading", isLoading); els.refreshButton.disabled = isLoading; }
function setLiveState(status) { els.liveState.classList.remove("is-ready", "is-error"); if (status === "ready") { els.liveState.classList.add("is-ready"); els.liveState.querySelector("span:last-child").textContent = "天气源已连接 · 15 分钟自动更新"; } else if (status === "error") { els.liveState.classList.add("is-error"); els.liveState.querySelector("span:last-child").textContent = "天气源连接异常"; } }
function hideSearchResults() { els.searchResults.hidden = true; els.searchResults.innerHTML = ""; }
function getSelectedCity() { return state.cities.find((city) => city.id === state.selectedId); }
function persistCities() { localStorage.setItem(STORAGE_KEYS.cities, JSON.stringify(state.cities)); }
function getSession() { return readJSON(STORAGE_KEYS.session, null); }

function openAuthDialog(mode) { setAuthMode(mode); els.authDialog.showModal(); setTimeout(() => document.querySelector("#authEmail").focus(), 0); }
function openAccountDialog() { const user = getSession(); if (!user) return; document.querySelector("#accountName").textContent = user.name; document.querySelector("#accountEmail").textContent = user.email; document.querySelector("#accountAvatar").textContent = (user.name || "云").slice(0, 1); els.accountDialog.showModal(); }
function setAuthMode(mode) {
  state.authMode = mode; const isRegister = mode === "register";
  document.querySelector("#loginTab").classList.toggle("is-active", !isRegister); document.querySelector("#registerTab").classList.toggle("is-active", isRegister);
  document.querySelector("#loginTab").setAttribute("aria-selected", String(!isRegister)); document.querySelector("#registerTab").setAttribute("aria-selected", String(isRegister));
  document.querySelector("#nameField").hidden = !isRegister; document.querySelector("#confirmField").hidden = !isRegister;
  document.querySelector("#authTitle").textContent = isRegister ? "创建你的天气视角" : "保存你的天气视角";
  document.querySelector("#authSubtitle").textContent = isRegister ? "注册一个本机账户，保留你的关注城市。" : "登录后可以在这台设备上保留关注城市。";
  document.querySelector("#authSubmit").textContent = isRegister ? "创建账户" : "登录";
  document.querySelector("#authPassword").setAttribute("autocomplete", isRegister ? "new-password" : "current-password");
  document.querySelector("#authMessage").textContent = "";
}

async function handleAuthSubmit(event) {
  event.preventDefault(); const email = document.querySelector("#authEmail").value.trim().toLowerCase(); const password = document.querySelector("#authPassword").value; const message = document.querySelector("#authMessage");
  const users = readJSON(STORAGE_KEYS.users, []);
  try {
    if (state.authMode === "register") {
      const name = document.querySelector("#authName").value.trim(); const confirm = document.querySelector("#authConfirm").value;
      if (!name) throw new Error("请填写昵称"); if (password !== confirm) throw new Error("两次密码不一致"); if (users.some((user) => user.email === email)) throw new Error("这个邮箱已经注册过了");
      const passwordHash = await hashPassword(password); const user = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name, email, passwordHash }; users.push(user); localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users)); localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({ id: user.id, name, email }));
      message.className = "auth-message is-success"; message.textContent = "账户已创建，正在打开你的天气工作台…"; updateAccountButton(); setTimeout(() => els.authDialog.close(), 500);
    } else {
      const user = users.find((item) => item.email === email); const passwordHash = await hashPassword(password);
      if (!user || user.passwordHash !== passwordHash) throw new Error("邮箱或密码不正确");
      localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({ id: user.id, name: user.name, email: user.email })); message.className = "auth-message is-success"; message.textContent = "登录成功"; updateAccountButton(); setTimeout(() => els.authDialog.close(), 450);
    }
  } catch (error) { message.className = "auth-message"; message.textContent = error.message; }
}

function updateAccountButton() { const session = getSession(); els.accountTrigger.textContent = session ? `${session.name} · 账户` : "登录 / 注册"; }
async function hashPassword(value) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function showToast(message) { const old = document.querySelector(".toast"); old?.remove(); const toast = document.createElement("div"); toast.className = "toast"; toast.textContent = message; Object.assign(toast.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", padding: "11px 16px", background: "#10243a", color: "white", fontSize: "13px", zIndex: "20" }); document.body.append(toast); setTimeout(() => toast.remove(), 2200); }

function weatherLabel(code) { const labels = { 0: "晴朗", 1: "大部晴朗", 2: "局部多云", 3: "阴天", 45: "雾", 48: "雾凇", 51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨", 56: "冻毛毛雨", 57: "冻毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨", 71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "阵雪", 95: "雷雨", 96: "雷雨伴冰雹", 99: "雷雨伴冰雹" }; return labels[code] || "天气数据"; }
function isRainCode(code) { return [51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(Number(code)); }
function formatDayLabel(date, index) { if (index === 0) return "今天"; return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(new Date(`${date}T12:00:00`)); }
function formatShortDate(date) { return date.slice(5).replace("-", "/"); }
function formatHour(value) { return value?.slice(11, 16) || "—"; }
function formatLocalDateTime(value, timezone) { try { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone || undefined }).format(new Date(value)); } catch { return value?.replace("T", " ").slice(0, 16) || "—"; } }
function formatRetrieved(value) { try { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); } catch { return "—"; } }
function degToCompass(deg) { if (deg === null || deg === undefined) return "—"; return ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][Math.round(Number(deg) / 45) % 8]; }
function distance(a, b) { return Math.abs(Number(a.latitude) - Number(b.latitude)) + Math.abs(Number(a.longitude) - Number(b.longitude)); }
function numberOrNull(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function round(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n) : "—"; }
function formatNumber(value) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(1).replace(/\.0$/, "") : "—"; }
function slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "city"; }
function readJSON(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } }
function debounce(fn, wait) { let timeout; return (...args) => { clearTimeout(timeout); timeout = setTimeout(() => fn(...args), wait); }; }
function escapeHTML(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
