// background/service_worker.js
importScripts('../config.js');

const SELLER_CACHE_KEY = 'sellerCache';
const SETTINGS_KEY = 'scraperSettings';
const QUEUE_KEY = 'asinQueuePersist';
const SELLER_SCAN_KEY = 'sellerScanPersist';
const SCAN_SESSION_KEY = 'activeScanSession';
const KEEPALIVE_ALARM = 'scanKeepalive';
const FLEET_HEARTBEAT_ALARM = 'fleetHeartbeat';
const FLEET_WATCHDOG_ALARM = 'fleetWatchdog';
const EXTENSION_VERSION = '1.4.0';
const DEFAULT_API_URL = SCRAPER_API.sellersUrl;
const DEFAULT_PARALLEL_TABS = 5;
const BRANCH_COLLAPSE_MAX = 300;
const BRANCH_COLLAPSE_MIN_LEAVES = 2;

// Amazon rate-limit koruması (ms)
const DELAY = {
  BEFORE_AOD: 3500,
  STORE_PAGE: 2800,
  CATEGORY_PAGE: 3200,
  BETWEEN_SELLERS: 2200,
  BETWEEN_CATEGORIES: 1800,
  BETWEEN_ASINS: 8000,
  AFTER_PRODUCT_NAV: 2500
};

let asinQueue = [];
let asinQueueIndex = 0;
let activeTabId = null;
let isRunning = false;
let lastPopupUpdate = 0;

let state = {
  runMode: 'asin',
  asin: null,
  asinQueue: [],
  asinQueueIndex: 0,
  asinQueueTotal: 0,
  queuePending: [],
  queueCompleted: [],
  sellerScanPending: [],
  sellerScanCompleted: [],
  sellers: {},
  storeProducts: {},
  skippedSellers: [],
  status: 'idle',
  skipCached: true,
  autoUpload: true,
  inventoryMode: 'category',
  resumeCategoryScan: true,
  apiUrl: DEFAULT_API_URL,
  apiMessage: '',
  categoryProgress: null,
  targetSellerId: null,
  fleetMode: false,
  fleetMachineId: '',
  fleetMachineLabel: '',
  fleetCurrentSeller: null,
  fleetQueueIndex: null
};

let lastFleetProgressAt = 0;
let activeCategoryTabIds = [];
let fleetLoopRunning = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_SCRAPE') {
    const asins = msg.asins?.length ? msg.asins : (msg.asin ? [msg.asin] : []);
    startBatchScrape(asins, {
      skipCached: msg.skipCached !== false,
      autoUpload: msg.autoUpload !== false,
      inventoryMode: msg.inventoryMode || 'category',
      apiUrl: msg.apiUrl || DEFAULT_API_URL,
      parallelTabs: clampParallelTabs(msg.parallelTabs)
    }).catch(err => handleScrapeError(err, 'ASIN taraması'));
    sendResponse({ ok: true });
  }
  if (msg.type === 'START_SELLER_SCAN') {
    startSellerRescan({
      sellerIds: msg.sellerIds,
      forceFullRescan: msg.forceFullRescan === true,
      skipCached: msg.skipCached !== false,
      autoUpload: msg.autoUpload !== false,
      inventoryMode: msg.inventoryMode || 'category',
      resumeCategoryScan: msg.resumeCategoryScan !== false,
      apiUrl: msg.apiUrl || DEFAULT_API_URL,
      parallelTabs: clampParallelTabs(msg.parallelTabs),
      branchPruning: msg.branchPruning !== false
    }).catch(err => handleScrapeError(err, 'Satıcı taraması'));
    sendResponse({ ok: true });
  }
  if (msg.type === 'GET_QUEUE') {
    getPersistedQueue().then(sendResponse);
    return true;
  }
  if (msg.type === 'SAVE_QUEUE') {
    savePersistedQueue({
      pending: msg.pending || [],
      completed: msg.completed ?? undefined
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CLEAR_QUEUE') {
    savePersistedQueue({ pending: [], completed: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_STATE') {
    tryResumeFleetMode()
      .catch(() => {})
      .finally(() => sendResponse(buildPopupSnapshot()));
    return true;
  }
  if (msg.type === 'GET_SELLER_PRODUCTS') {
    sendResponse(state.storeProducts[msg.sellerId] || []);
    return true;
  }
  if (msg.type === 'SELLERS_FOUND') {
    Object.assign(state.sellers, msg.sellers);
    updatePopup(true);
  }
  if (msg.type === 'STORE_PAGE_DONE') {
    // Ürün birleştirme scrapeSellerStore → waitForMessage içinde yapılır
    return true;
  }
  if (msg.type === 'DOWNLOAD_CSV') {
    downloadCSV(msg.sellerId);
    sendResponse({ ok: true });
  }
  if (msg.type === 'SEND_TO_API') {
    uploadSellerToAPI(msg.sellerId, msg.apiUrl || state.apiUrl)
      .then(result => { state.apiMessage = result.message; updatePopup(); });
    sendResponse({ ok: true });
  }
  if (msg.type === 'SAVE_SETTINGS') {
    saveSettings(msg.settings);
    sendResponse({ ok: true });
  }
  if (msg.type === 'START_FLEET') {
    startFleetOperations(msg).catch(err => handleScrapeError(err, 'Fleet'));
    sendResponse({ ok: true });
  }
  if (msg.type === 'STOP_FLEET') {
    stopFleetOperations().then(() => sendResponse({ ok: true }));
    return true;
  }
  return true;
});

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    apiUrl: data[SETTINGS_KEY]?.apiUrl || DEFAULT_API_URL,
    autoUpload: data[SETTINGS_KEY]?.autoUpload !== false,
    skipCached: data[SETTINGS_KEY]?.skipCached !== false,
    inventoryMode: data[SETTINGS_KEY]?.inventoryMode || 'category',
    resumeCategoryScan: data[SETTINGS_KEY]?.resumeCategoryScan !== false,
    parallelTabs: clampParallelTabs(data[SETTINGS_KEY]?.parallelTabs),
    branchPruning: data[SETTINGS_KEY]?.branchPruning !== false,
    fleetMode: data[SETTINGS_KEY]?.fleetMode === true,
    fleetMachineId: String(data[SETTINGS_KEY]?.fleetMachineId || '').trim(),
    fleetMachineLabel: String(data[SETTINGS_KEY]?.fleetMachineLabel || '').trim()
  };
}

function clampParallelTabs(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return DEFAULT_PARALLEL_TABS;
  return Math.min(8, Math.max(1, v));
}

async function saveSettings(settings) {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...settings } });
}

function queueLabel() {
  const done = state.queueCompleted?.length || 0;
  const left = state.queuePending?.length || 0;
  const total = done + left;
  if (total <= 1) return state.asin || '';
  return `${done + 1}/${total} (${state.asin}) — ${left} kalan`;
}

async function getPersistedQueue() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  const q = data[QUEUE_KEY] || { pending: [], completed: [] };
  return {
    pending: q.pending || [],
    completed: q.completed || []
  };
}

async function savePersistedQueue({ pending, completed }) {
  const current = await getPersistedQueue();
  const next = {
    pending: pending !== undefined ? pending : current.pending,
    completed: completed !== undefined ? completed : current.completed,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [QUEUE_KEY]: next });
  state.queuePending = next.pending;
  state.queueCompleted = next.completed;
  return next;
}

async function markAsinDone(asin) {
  const q = await getPersistedQueue();
  if (!q.completed.includes(asin)) q.completed.push(asin);
  q.pending = q.pending.filter(a => a !== asin);
  await savePersistedQueue(q);
}

async function startBatchScrape(asins, options = {}) {
  if (isRunning) return;
  if (!asins.length) return;

  const saved = await getSettings();
  const q = await getPersistedQueue();

  await savePersistedQueue({ pending: asins, completed: q.completed });

  isRunning = true;
  scheduleScanKeepalive();
  asinQueue = asins;
  asinQueueIndex = 0;

  state.sellers = {};
  state.storeProducts = {};
  state.skippedSellers = [];
  state.skipCached = options.skipCached ?? saved.skipCached;
  state.autoUpload = options.autoUpload ?? saved.autoUpload;
  state.inventoryMode = options.inventoryMode || saved.inventoryMode || 'category';
  state.apiUrl = (options.apiUrl || saved.apiUrl || DEFAULT_API_URL).trim();
  state.parallelTabs = clampParallelTabs(options.parallelTabs ?? saved.parallelTabs);
  state.runMode = 'asin';

  const fresh = await getPersistedQueue();
  state.queuePending = fresh.pending;
  state.queueCompleted = fresh.completed;
  state.asinQueueTotal = fresh.pending.length + fresh.completed.length;
  state.apiMessage = state.autoUpload
    ? `DB: ${state.apiUrl} — ${fresh.pending.length} ASIN kuyrukta (${fresh.completed.length} tamamlandı)`
    : `${fresh.pending.length} ASIN kuyrukta (${fresh.completed.length} tamamlandı)`;

  await beginAsinScrape(null);
}

async function beginAsinScrape(tabId) {
  const q = await getPersistedQueue();
  asinQueue = q.pending;

  if (!asinQueue.length) {
    await finishScanRun();
    state.status = 'done';
    state.apiMessage = `Tüm ASIN'ler tamamlandı (${q.completed.length}) ✓`;
    updatePopup(true);
    return;
  }

  const asin = asinQueue[0];
  asinQueueIndex = 0;
  state.asin = asin;
  state.queuePending = q.pending;
  state.queueCompleted = q.completed;
  state.asinQueueIndex = q.completed.length + 1;
  state.asinQueueTotal = q.pending.length + q.completed.length;
  state.status = 'scraping_product';
  state.apiMessage = `${queueLabel()} — başlıyor...`;
  updatePopup(true);

  if (tabId) {
    activeTabId = tabId;
    await delay(DELAY.BETWEEN_ASINS);
    await chrome.tabs.update(tabId, { url: `https://www.amazon.com/dp/${asin}` });
    await delay(DELAY.AFTER_PRODUCT_NAV);
  } else {
    const tab = await chrome.tabs.create({
      url: `https://www.amazon.com/dp/${asin}`,
      active: true
    });
    activeTabId = tab.id;
    await delay(DELAY.AFTER_PRODUCT_NAV);
  }
}

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== 'FORMAT_OPTIONS') return;
  if (state.status !== 'scraping_product') return;
  if (!isRunning) return;

  const tabId = sender.tab?.id || activeTabId;
  activeTabId = tabId;

  state.status = 'scraping_offers';
  state.apiMessage = `${queueLabel()} — teklifler toplanıyor...`;
  updatePopup();

  const sellersThisAsin = new Set();

  for (const fmt of msg.formats) {
    await delay(DELAY.BEFORE_AOD);
    await chrome.tabs.update(tabId, {
      url: `https://www.amazon.com/dp/${fmt.asin}?aod=1`
    });

    const result = await waitForMessage('SELLERS_FOUND', 20000, m => m.sourceAsin === fmt.asin);
    if (!result?.sellers) continue;

    for (const [id, seller] of Object.entries(result.sellers)) {
      sellersThisAsin.add(id);
      if (!state.sellers[id]) state.sellers[id] = seller;
      if (!state.sellers[id].sourceEditions) state.sellers[id].sourceEditions = [];
      if (!state.sellers[id].sourceAsins) state.sellers[id].sourceAsins = [];
      if (!state.sellers[id].sourceAsins.includes(state.asin)) {
        state.sellers[id].sourceAsins.push(state.asin);
      }
      const edition = fmt.label && fmt.label !== 'Default' ? fmt.label : null;
      if (edition && !state.sellers[id].sourceEditions.includes(edition)) {
        state.sellers[id].sourceEditions.push(edition);
      }
    }
    updatePopup(true);
  }

  state.status = 'scraping_stores';
  state.apiMessage = `${queueLabel()} — mağazalar taranıyor...`;
  updatePopup();

  const sellerIds = [...sellersThisAsin];
  for (let i = 0; i < sellerIds.length; i++) {
    const sellerId = sellerIds[i];
    if (i > 0) await delay(DELAY.BETWEEN_SELLERS);

    const outcome = await scrapeSellerInventory(sellerId, tabId, {
      skipCached: state.skipCached,
      inventoryMode: state.inventoryMode,
      autoUpload: state.autoUpload,
      apiUrl: state.apiUrl,
      sourceAsin: state.asin,
      parallelTabs: state.parallelTabs
    });
    if (outcome === 'skipped') {
      if (!state.skippedSellers.includes(sellerId)) state.skippedSellers.push(sellerId);
    }
  }

  await markAsinDone(state.asin);

  const q = await getPersistedQueue();
  if (q.pending.length > 0) {
    await beginAsinScrape(tabId);
    return;
  }

  await finishScanRun();
  state.status = 'done';
  const uploaded = Object.values(state.sellers).filter(s => s.dbStatus === 'synced').length;
  const failed = Object.values(state.sellers).filter(s => s.dbStatus === 'error').length;
  if (state.autoUpload && state.apiUrl) {
    state.apiMessage = failed
      ? `Bitti: ${q.completed.length} ASIN, ${uploaded} satıcı DB'de, ${failed} hata`
      : `Bitti: ${q.completed.length} ASIN tarandı, ${uploaded} satıcı DB'ye kaydedildi ✓`;
  } else {
    state.apiMessage = `Bitti: ${q.completed.length} ASIN tarandı`;
  }
  updatePopup(true);
});

async function getSellerCache() {
  const data = await chrome.storage.local.get(SELLER_CACHE_KEY);
  return data[SELLER_CACHE_KEY] || {};
}

async function saveSellerToCache(sellerId, entry) {
  const cache = await getSellerCache();
  cache[sellerId] = {
    name: entry.name,
    products: compactProducts(entry.products),
    scrapedAt: entry.scrapedAt,
    complete: entry.complete,
    pageCount: entry.pageCount
  };

  // En fazla 25 satıcı önbellekte tut (quota koruması)
  const ids = Object.keys(cache).sort(
    (a, b) => (cache[b].scrapedAt || 0) - (cache[a].scrapedAt || 0)
  );
  while (ids.length > 25) {
    const old = ids.pop();
    if (old !== sellerId) delete cache[old];
  }

  try {
    await chrome.storage.local.set({ [SELLER_CACHE_KEY]: cache });
  } catch (err) {
    console.warn('sellerCache yazılamadı, ürün listesi kırpılıyor:', err.message);
    cache[sellerId].products = cache[sellerId].products.map(p => ({
      asin: p.asin, title: p.asin, format: p.format, price: p.price
    }));
    await chrome.storage.local.set({ [SELLER_CACHE_KEY]: cache });
  }
}

function compactProducts(products) {
  return (products || []).map(p => ({
    asin: p.asin,
    title: String(p.title || p.asin).slice(0, 100),
    format: p.format || '',
    price: p.price || ''
  }));
}

function buildPopupSnapshot() {
  const productCounts = {};
  for (const [id, products] of Object.entries(state.storeProducts)) {
    productCounts[id] = products.length;
  }
  return {
    runMode: state.runMode,
    asin: state.asin,
    asinQueueIndex: state.asinQueueIndex,
    asinQueueTotal: state.asinQueueTotal,
    queuePending: state.queuePending,
    queueCompleted: state.queueCompleted,
    sellerScanPending: state.sellerScanPending,
    sellerScanCompleted: state.sellerScanCompleted,
    sellers: state.sellers,
    productCounts,
    skippedSellers: state.skippedSellers,
    status: state.status,
    autoUpload: state.autoUpload,
    inventoryMode: state.inventoryMode,
    categoryProgress: state.categoryProgress,
    targetSellerId: state.targetSellerId,
    apiMessage: state.apiMessage,
    fleetMode: state.fleetMode,
    fleetMachineId: state.fleetMachineId,
    fleetCurrentSeller: state.fleetCurrentSeller,
    fleetQueueIndex: state.fleetQueueIndex
  };
}

function apiBaseFromUrl(apiUrl) {
  try {
    const u = new URL(apiUrl || DEFAULT_API_URL);
    return u.origin;
  } catch {
    return SCRAPER_API.base;
  }
}

function buildStoreUrl(sellerId, page, rhPath) {
  let url = `https://www.amazon.com/s?i=merchant-items&me=${sellerId}&page=${page}`;
  if (rhPath) url += `&rh=${encodeURIComponent(rhPath)}`;
  return url;
}

/** Amazon URL'de rh= kısaltılmış veya segment sırası değişmiş olabilir */
function rhPathSegmentKey(rh) {
  if (!rh) return '';
  return [...new Set(rh.split(',').filter(Boolean))].sort().join('|');
}

function rhUrlMatches(msgRh, expectedRh) {
  if (!expectedRh) return !msgRh;
  if (!msgRh) return false;
  if (msgRh === expectedRh) return true;
  if (rhPathSegmentKey(msgRh) === rhPathSegmentKey(expectedRh)) return true;
  const lastExpected = expectedRh.split(',').pop();
  if (msgRh === lastExpected) return true;
  if (expectedRh.endsWith(',' + msgRh)) return true;
  return false;
}

function storePageMatch(sellerId, page, rhPath) {
  return (m) =>
    m.sellerId === sellerId &&
    m.page === page &&
    rhUrlMatches(m.rhPath, rhPath);
}

function leafShortName(rhPath) {
  return rhPath?.split(',').pop() || rhPath || '';
}

async function fetchJson(url, options = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`API zaman aşımı (${Math.round(timeoutMs / 1000)} sn): ${url}`);
    }
    throw new Error(`API bağlantı hatası: ${err.message} (${url})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (body ? ': ' + body.slice(0, 120) : ''));
  }
  return res.json();
}

async function fetchSellerInfo(apiBase, sellerId) {
  return fetchJson(`${apiBase}/sellers/${encodeURIComponent(sellerId)}`, {}, 20000);
}

function handleScrapeError(err, label) {
  finishScanRun().catch(() => {});
  state.status = 'idle';
  state.categoryProgress = null;
  state.targetSellerId = null;
  const raw = err?.message || String(err);
  state.apiMessage = raw.includes('Failed to fetch') || raw.includes('API bağlantı')
    ? `${label}: Backend yanıt vermiyor — cd backend && npm start`
    : `${label}: ${raw}`;
  updatePopup(true);
  console.error(label, err);
}

async function persistScanSession(partial) {
  const data = await chrome.storage.local.get(SCAN_SESSION_KEY);
  const prev = data[SCAN_SESSION_KEY] || {};
  await chrome.storage.local.set({
    [SCAN_SESSION_KEY]: { ...prev, ...partial, updatedAt: Date.now() }
  });
}

async function clearScanSession() {
  await chrome.storage.local.remove(SCAN_SESSION_KEY);
}

function scheduleScanKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM).finally(() => {
    chrome.alarms.create(KEEPALIVE_ALARM, { delayInMinutes: 0.5 });
  });
}

function stopScanKeepalive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}

async function finishScanRun() {
  isRunning = false;
  if (state.fleetMode) {
    scheduleScanKeepalive();
    return;
  }
  stopScanKeepalive();
  await clearScanSession();
}

async function tryResumeScanSession() {
  if (isRunning) return;
  const saved = await getSettings();
  if (state.fleetMode || saved.fleetMode) return;
  const data = await chrome.storage.local.get(SCAN_SESSION_KEY);
  const session = data[SCAN_SESSION_KEY];
  if (!session?.queue?.length) return;
  if (Date.now() - session.updatedAt > 15 * 60 * 1000) {
    await clearScanSession();
    return;
  }
  if ((session.resumeAttempts || 0) >= 3) {
    state.apiMessage = 'Tarama durdu — popup\'tan tekrar Başlat\'a basın (DB\'den devam eder)';
    updatePopup(true);
    await clearScanSession();
    return;
  }
  await persistScanSession({ resumeAttempts: (session.resumeAttempts || 0) + 1 });
  state.apiMessage = 'Service worker uyudu — tarama otomatik devam ediyor...';
  updatePopup(true);
  await startSellerRescan({
    ...session.options,
    _resumeFromIndex: session.sellerIndex || 0,
    _resumeAttempts: (session.resumeAttempts || 0) + 1
  });
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish(true);
    }).catch(() => finish(false));
  });
}

async function injectStoreContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['utils/helpers.js', 'content/store.js']
    });
    return true;
  } catch {
    return false;
  }
}

async function loadStorePageWithRetry(sellerId, page, rhPath, tabId, options = {}) {
  const { fast = false } = options;
  const match = storePageMatch(sellerId, page, rhPath);
  const url = buildStoreUrl(sellerId, page, rhPath);
  const maxAttempts = fast ? 1 : 3;
  const msgTimeout = fast ? 28000 : 45000;
  const completeTimeout = fast ? 25000 : 40000;
  const postCompleteDelay = fast ? 350 : 800;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await delay(fast ? 1200 : 2500 + attempt * 1500);

    const msgPromise = waitForMessage('STORE_PAGE_DONE', msgTimeout, match);
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId, completeTimeout);
    await delay(postCompleteDelay);

    let result = await msgPromise;
    if (result) return result;

    if (fast) continue;

    if (await injectStoreContentScript(tabId)) {
      await delay(2000);
      result = await waitForMessage('STORE_PAGE_DONE', 20000, match);
      if (result) return result;
    }

    try {
      await chrome.tabs.reload(tabId);
      await waitForTabComplete(tabId, completeTimeout);
      await delay(1000);
      if (await injectStoreContentScript(tabId)) {
        await delay(2000);
        result = await waitForMessage('STORE_PAGE_DONE', 20000, match);
        if (result) return result;
      }
    } catch (_) {}
  }
  return null;
}

let embeddedLeavesCache = null;

async function getEmbeddedLeafCategories() {
  if (embeddedLeavesCache) return embeddedLeavesCache;
  const url = chrome.runtime.getURL('data/leaf-categories.json');
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error('leaf-categories.json yüklenemedi: ' + err.message);
  }
  if (!res.ok) throw new Error('leaf-categories.json bulunamadı — extension reload');
  const data = await res.json();
  embeddedLeavesCache = filterScannableLeaves(data.leaves || []);
  return embeddedLeavesCache;
}

/** Orphan n:2419 gibi kısa yolları at — uzun yolda alt leaf varsa üstü tarama */
function filterScannableLeaves(leaves) {
  return leaves.filter(leaf => {
    const parts = leaf.rh_path.split(',');
    if (new Set(parts).size !== parts.length) return false;
    if (!leaf.rh_path.includes(',')) {
      const needle = ',' + leaf.rh_path + ',';
      if (leaves.some(o => o.rh_path.includes(needle))) return false;
    }
    return true;
  });
}

async function getLeafCategoryCount(_apiBase) {
  try {
    const leaves = await getEmbeddedLeafCategories();
    return leaves.length;
  } catch {
    return 0;
  }
}

async function initSellerCategoryJobs(apiBase, sellerId, sellerName) {
  const res = await fetch(`${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sellerName || sellerId })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Job init: HTTP ' + res.status + (body ? ' — ' + body.slice(0, 120) : ''));
  }
  return res.json().catch(() => ({}));
}

async function getAllCategoryJobs(apiBase, sellerId) {
  return fetchJson(`${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs`, {}, 60000);
}

async function getCategoryJobSummary(apiBase, sellerId) {
  return fetchJson(
    `${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs/summary`,
    {},
    15000
  );
}

async function getPendingCategoryJobs(apiBase, sellerId) {
  const rows = await fetchJson(
    `${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs?pending=true&minimal=true`,
    {},
    60000
  );
  return rows;
}

async function fetchScanQueue(apiBase, resumeOnly) {
  const q = resumeOnly ? 'resume=true' : 'resume=false';
  return fetchJson(`${apiBase}/sellers/scan-queue?${q}&limit=500`);
}

async function getPersistedSellerScan() {
  const data = await chrome.storage.local.get(SELLER_SCAN_KEY);
  return data[SELLER_SCAN_KEY] || { pending: [], completed: [] };
}

async function savePersistedSellerScan({ pending, completed }) {
  const current = await getPersistedSellerScan();
  const next = {
    pending: pending !== undefined ? pending : current.pending,
    completed: completed !== undefined ? completed : current.completed,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [SELLER_SCAN_KEY]: next });
  state.sellerScanPending = next.pending;
  state.sellerScanCompleted = next.completed;
  return next;
}

async function markSellerScanDone(sellerId) {
  const q = await getPersistedSellerScan();
  if (!q.completed.includes(sellerId)) q.completed.push(sellerId);
  q.pending = q.pending.filter(id => id !== sellerId);
  await savePersistedSellerScan(q);
}

async function uploadCategoryBatchToAPI({ sellerId, rhPath, products, job, apiUrl, sourceAsin }) {
  const apiBase = apiBaseFromUrl(apiUrl);
  const seller = state.sellers[sellerId] || { id: sellerId, name: sellerId };
  const payload = {
    seller: { id: sellerId, name: seller.name || sellerId },
    rhPath,
    products,
    job,
    sourceAsin: sourceAsin || undefined
  };
  const url = `${apiBase}/sellers/category-batch`;
  let lastErr;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        throw new Error(`API bağlantı hatası: ${err.message}`);
      }
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (errBody ? ': ' + errBody.slice(0, 80) : ''));
      }
      return res.json().catch(() => ({}));
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await delay(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

function buildBranchListFromLeaves(leaves) {
  const branches = new Map();
  for (const leaf of leaves) {
    const parts = leaf.rh_path.split(',');
    if (parts.length < 3) continue;
    for (let i = 2; i < parts.length; i++) {
      const rh_path = parts.slice(0, i).join(',');
      const depth = i - 1;
      if (!branches.has(rh_path)) {
        branches.set(rh_path, { rh_path, depth, name: leafShortName(rh_path) });
      }
    }
  }
  return [...branches.values()].sort((a, b) =>
    a.depth - b.depth || a.rh_path.localeCompare(b.rh_path)
  );
}

function isUnderPrunedPrefix(rhPath, prunedPrefixes) {
  for (const p of prunedPrefixes) {
    if (rhPath === p || rhPath.startsWith(p + ',')) return true;
  }
  return false;
}

function isBlockedPage(resultText) {
  if (!resultText) return false;
  return resultText.includes('Skip to') || resultText.includes('Keyboard shortcuts');
}

/** true = boş dal, false = ürün var, null = belirsiz (budama yapma) */
function isProbeEmpty(probeResult) {
  if (isBlockedPage(probeResult.resultText)) return null;
  if (probeResult.products?.length > 0) return false;
  if (probeResult.amazonTotal === 0) return true;
  if (/^0 results?\b/i.test(probeResult.resultText || '')) return true;
  if (/no results for your search/i.test(probeResult.resultText || '')) return true;
  if (probeResult.status === 'empty') return true;
  return null;
}

async function skipSubtreeOnAPI(apiBase, sellerId, rhPath, resultText) {
  return fetchJson(`${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs/skip-subtree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rhPath, resultText: resultText || 'parent branch empty (0 products)' })
  });
}

async function collapseSubtreeOnAPI(apiBase, sellerId, rhPath, meta) {
  return fetchJson(`${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs/collapse-subtree`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
}

/** Boş dalları budar; az ürünlü dallarda üst kategoriden tek tarama yapar */
async function optimizeBranchSubtrees(sellerId, leaves, todo, options) {
  const { apiUrl, autoUpload, sourceAsin } = options;
  const apiBase = apiBaseFromUrl(apiUrl);
  const branches = buildBranchListFromLeaves(leaves);
  const skipPrefixes = new Set();
  let skippedLeaves = 0;
  let collapsedLeaves = 0;
  let probedBranches = 0;

  const tabIds = await createCategoryTabPool(1);
  const tabId = tabIds[0];

  try {
    for (const branch of branches) {
      if (isUnderPrunedPrefix(branch.rh_path, skipPrefixes)) continue;

      const pendingUnder = todo.filter(l =>
        (l.rh_path === branch.rh_path || l.rh_path.startsWith(branch.rh_path + ',')) &&
        !isUnderPrunedPrefix(l.rh_path, skipPrefixes)
      );
      if (!pendingUnder.length) continue;

      state.apiMessage = `${sellerId}: dal kontrol — ${branch.name || leafShortName(branch.rh_path)}`;
      updatePopup(true);

      let probe;
      try {
        probe = await scrapeCategoryPages(sellerId, branch.rh_path, tabId, {
          startPage: 1,
          maxPages: 1,
          autoUpload: false,
          fastLoad: true
        });
      } catch (err) {
        console.warn('Branch probe hatası:', branch.rh_path, err.message);
        continue;
      }

      probedBranches++;
      await delay(DELAY.BETWEEN_CATEGORIES);

      if (isProbeEmpty(probe) === true) {
        skipPrefixes.add(branch.rh_path);
        const resultText = probe.resultText || '0 results (parent branch pruned)';
        if (autoUpload && apiUrl) {
          try {
            const res = await skipSubtreeOnAPI(apiBase, sellerId, branch.rh_path, resultText);
            skippedLeaves += res.skipped || pendingUnder.length;
          } catch (err) {
            console.warn('skip-subtree API:', err.message);
            skippedLeaves += pendingUnder.length;
          }
        } else {
          skippedLeaves += pendingUnder.length;
        }
        continue;
      }

      const branchTotal = probe.amazonTotal;
      const leafCount = pendingUnder.filter(l => l.rh_path !== branch.rh_path).length || pendingUnder.length;
      if (
        branchTotal == null ||
        branchTotal <= 0 ||
        branchTotal > BRANCH_COLLAPSE_MAX ||
        leafCount < BRANCH_COLLAPSE_MIN_LEAVES
      ) {
        continue;
      }

      state.apiMessage = `${sellerId}: üst kategori ${branchTotal} ürün — ${leafCount} leaf tek taramada`;
      updatePopup(true);

      let full;
      try {
        full = await scrapeCategoryPages(sellerId, branch.rh_path, tabId, {
          autoUpload: false,
          fastLoad: true,
          sourceAsin
        });
      } catch (err) {
        console.warn('Branch collapse taraması:', branch.rh_path, err.message);
        continue;
      }

      mergeProductsIntoState(sellerId, full.products);
      skipPrefixes.add(branch.rh_path);

      if (autoUpload && apiUrl) {
        try {
          await uploadCategoryBatchToAPI({
            sellerId,
            rhPath: branch.rh_path,
            products: full.products,
            job: {
              status: 'done',
              pagesScraped: full.pagesScraped,
              lastPage: full.lastPage,
              productsFound: full.products.length,
              amazonTotal: full.amazonTotal ?? branchTotal,
              resultText: full.resultText || probe.resultText
            },
            apiUrl,
            sourceAsin
          });
          const res = await collapseSubtreeOnAPI(apiBase, sellerId, branch.rh_path, {
            rhPath: branch.rh_path,
            productsFound: full.products.length,
            amazonTotal: full.amazonTotal ?? branchTotal,
            resultText: full.resultText || probe.resultText || `collapsed: ${full.products.length} products`,
            leafCount
          });
          collapsedLeaves += res.collapsed || pendingUnder.length;
        } catch (err) {
          console.warn('collapse-subtree API:', err.message);
          collapsedLeaves += pendingUnder.length;
        }
      } else {
        collapsedLeaves += pendingUnder.length;
      }
    }
  } finally {
    await closeCategoryTabPool(tabIds);
  }

  const remainingLeaves = todo.filter(l => !isUnderPrunedPrefix(l.rh_path, skipPrefixes));
  return { remainingLeaves, skippedLeaves, collapsedLeaves, probedBranches };
}

async function pruneEmptyBranchSubtrees(sellerId, leaves, todo, options) {
  return optimizeBranchSubtrees(sellerId, leaves, todo, options);
}

async function scrapeCategoryPages(sellerId, rhPath, tabId, options = {}) {
  const {
    startPage = 1,
    maxPages = 40,
    autoUpload = false,
    apiUrl,
    sourceAsin,
    onProgress,
    fastLoad = false
  } = options;

  const products = [];
  const seenKeys = new Set();
  let page = startPage;
  let pagesScraped = 0;
  let amazonTotal = null;
  let resultText = '';

  while (page <= maxPages) {
    if (page > startPage) {
      await delay(fastLoad ? 1400 : DELAY.CATEGORY_PAGE);
    }

    const result = await loadStorePageWithRetry(sellerId, page, rhPath, tabId, { fast: fastLoad });

    if (!result) {
      state.apiMessage = `${sellerId}: sayfa ${page} yanıt yok (${leafShortName(rhPath)}) — hata`;
      updatePopup(true);
      return {
        products,
        pagesScraped,
        lastPage: Math.max(0, page - 1),
        amazonTotal,
        resultText: resultText || 'timeout: content script yanıt vermedi',
        status: 'error'
      };
    }

    if (result.amazonTotal != null && result.amazonTotal >= 0) {
      amazonTotal = result.amazonTotal;
    }
    if (result.resultText) resultText = result.resultText;

    for (const p of result.products) {
      const key = `${p.asin}|${p.format || ''}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        products.push(p);
      }
    }
    pagesScraped++;

    if (onProgress) onProgress({ page, products: products.length });

    // Paralel leaf taramasında sayfa sayfa DB yazma — 5 kolun aynı anda ilerlemesi için sadece leaf sonunda upload
    const uploadEachPage = options.uploadEachPage === true;
    if (uploadEachPage && autoUpload && apiUrl) {
      try {
        await uploadCategoryBatchToAPI({
          sellerId,
          rhPath,
          products: result.products,
          job: {
            status: 'running',
            pagesScraped,
            lastPage: page,
            productsFound: products.length,
            amazonTotal,
            resultText
          },
          apiUrl,
          sourceAsin
        });
      } catch (err) {
        console.warn('Sayfa upload:', rhPath, page, err.message);
      }
    }

    if (result.products.length === 0) {
      return {
        products,
        pagesScraped,
        lastPage: page,
        amazonTotal,
        resultText,
        status: pagesScraped <= 1 && page === 1 ? 'empty' : 'done'
      };
    }

    page++;
  }

  return {
    products,
    pagesScraped,
    lastPage: page - 1,
    amazonTotal,
    resultText,
    status: 'done'
  };
}

function mergeProductsIntoState(sellerId, products) {
  if (!state.storeProducts[sellerId]) state.storeProducts[sellerId] = [];
  const seen = new Set(state.storeProducts[sellerId].map(p => `${p.asin}|${p.format || ''}`));
  for (const p of products) {
    const key = `${p.asin}|${p.format || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      state.storeProducts[sellerId].push(p);
    }
  }
}

async function createCategoryTabPool(count) {
  const tabs = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      chrome.tabs.create({ url: 'https://www.amazon.com/', active: i === 0 })
    )
  );
  await delay(600);
  const ids = tabs.map(t => t.id);
  activeCategoryTabIds = ids;
  return ids;
}

async function closeAllFleetCategoryTabs() {
  for (const tabId of [...activeCategoryTabIds]) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_) {}
  }
  activeCategoryTabIds = [];
}

async function closeCategoryTabPool(tabIds) {
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_) {}
  }
  activeCategoryTabIds = activeCategoryTabIds.filter(id => !tabIds.includes(id));
}

function updateParallelCategoryProgress(sellerId, stats) {
  const active = [...stats.active.values()];
  state.categoryProgress = {
    sellerId,
    parallel: stats.parallel,
    done: stats.done,
    total: stats.total,
    errors: stats.errors,
    current: stats.done + active.length,
    name: active.length
      ? active.map(a => a.name || leafShortName(a.rhPath)).join(' · ')
      : '',
    rhPath: active[0]?.rhPath || '',
    active
  };
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  const activeNames = active.map(a => `${a.name} [tab]`).slice(0, stats.parallel);
  state.apiMessage = `${sellerId}: ${stats.done}/${stats.total} leaf (${pct}%) — ${stats.parallel} kol paralel` +
    (activeNames.length ? `\n↳ ${activeNames.join(' · ')}` : '');
  noteFleetProgress(stats.done, stats.total);
  updatePopup(true);
}

async function processOneCategoryLeaf(sellerId, leaf, tabId, jobMap, options) {
  const { autoUpload, apiUrl, sourceAsin } = options;
  const rhPath = leaf.rh_path;
  const job = jobMap?.get(rhPath);
  const startPage = (job?.last_page && job?.status === 'running') ? job.last_page + 1 : 1;

  let result;
  try {
    result = await scrapeCategoryPages(sellerId, rhPath, tabId, {
      startPage,
      autoUpload: !!apiUrl,
      uploadEachPage: false,
      apiUrl,
      sourceAsin,
      fastLoad: options.fastLoad !== false
    });
  } catch (err) {
    throw new Error(`${leaf.name || rhPath}: ${err.message}`);
  }

  mergeProductsIntoState(sellerId, result.products);

  if (autoUpload && apiUrl) {
    const uploadPromise = uploadCategoryBatchToAPI({
      sellerId,
      rhPath,
      products: result.products,
      job: {
        status: result.status,
        pagesScraped: result.pagesScraped,
        lastPage: result.lastPage,
        productsFound: result.products.length,
        amazonTotal: result.amazonTotal,
        resultText: result.resultText
      },
      apiUrl,
      sourceAsin
    }).then(() => {
      if (state.sellers[sellerId]) {
        state.sellers[sellerId].dbStatus = 'synced';
        delete state.sellers[sellerId].dbError;
      }
    }).catch(err => {
      console.warn('Leaf upload:', rhPath, err.message);
      if (state.sellers[sellerId]) {
        state.sellers[sellerId].dbError = err.message;
      }
    });
    if (options.pendingUploads) {
      options.pendingUploads.push(uploadPromise);
    } else {
      await uploadPromise;
    }
  }
}

async function runParallelCategoryScan(sellerId, todo, jobMap, options) {
  const parallelTabs = clampParallelTabs(options.parallelTabs);
  const workerCount = Math.min(parallelTabs, todo.length);
  const stats = {
    parallel: workerCount,
    total: todo.length,
    done: 0,
    errors: 0,
    active: new Map()
  };

  let nextJobIndex = 0;
  function takeNextLeaf() {
    if (nextJobIndex >= todo.length) return null;
    const leaf = todo[nextJobIndex];
    const jobIndex = nextJobIndex;
    nextJobIndex++;
    return { leaf, jobIndex };
  }

  const tabIds = await createCategoryTabPool(workerCount);
  if (tabIds[0]) activeTabId = tabIds[0];
  updateParallelCategoryProgress(sellerId, stats);

  const pendingUploads = [];

  async function worker(tabId) {
    while (true) {
      const next = takeNextLeaf();
      if (!next) break;
      const { leaf, jobIndex } = next;
      stats.active.set(tabId, {
        name: leaf.name || leafShortName(leaf.rh_path),
        rhPath: leaf.rh_path,
        jobIndex
      });
      updateParallelCategoryProgress(sellerId, stats);

      try {
        await processOneCategoryLeaf(sellerId, leaf, tabId, jobMap, {
          ...options,
          fastLoad: true,
          pendingUploads
        });
        stats.done++;
      } catch (err) {
        stats.errors++;
        console.warn('Kategori atlandı:', err.message);
        if (state.sellers[sellerId]) {
          state.sellers[sellerId].dbError = err.message;
        }
      } finally {
        stats.active.delete(tabId);
        updateParallelCategoryProgress(sellerId, stats);
      }
    }
  }

  try {
    await Promise.all(tabIds.map(tabId => worker(tabId)));
    if (pendingUploads.length) {
      await Promise.allSettled(pendingUploads);
    }
  } finally {
    await closeCategoryTabPool(tabIds);
  }

  return stats;
}

async function scrapeSellerByCategories(sellerId, tabId, options) {
  const {
    autoUpload,
    apiUrl,
    sourceAsin,
    forceFullRescan = false
  } = options;

  const apiBase = apiBaseFromUrl(apiUrl);
  const sellerName = state.sellers[sellerId]?.name || sellerId;

  let leaves;
  try {
    leaves = await getEmbeddedLeafCategories();
  } catch (err) {
    state.apiMessage = err.message + ' — backend: npm run categories:export-leaf';
    updatePopup(true);
    return 'error';
  }

  if (!leaves.length) {
    state.apiMessage = 'Gömülü leaf listesi boş';
    updatePopup(true);
    return 'error';
  }

  if (forceFullRescan) {
    try {
      await fetch(`${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs/reset`, {
        method: 'POST'
      });
    } catch (_) {}
  } else if (options.skipCached && options.resumeCategoryScan !== false) {
    try {
      const sellerInfo = await fetchSellerInfo(apiBase, sellerId);
      if (sellerInfo?.category_scan_status === 'done') {
        if (state.sellers[sellerId]) {
          state.sellers[sellerId].fromCache = true;
          state.sellers[sellerId].categoryScanDone = true;
        }
        state.apiMessage = `${sellerId} zaten taranmış — Baştan tara ile zorla`;
        updatePopup(true);
        return 'skipped';
      }
    } catch (err) {
      state.apiMessage = `${sellerId}: satıcı bilgisi alınamadı — ${err.message}`;
      updatePopup(true);
    }
  }

  try {
    let initOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await initSellerCategoryJobs(apiBase, sellerId, sellerName);
        initOk = true;
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        state.apiMessage = `${sellerId}: DB init bekliyor (lock?) — tekrar ${attempt + 2}/3...`;
        updatePopup(true);
        await delay(1500 * (attempt + 1));
      }
    }
    if (!initOk) throw new Error('init failed');
  } catch (err) {
    state.apiMessage = `${sellerId}: DB init hatası — ${err.message}`;
    updatePopup(true);
    return 'error';
  }

  let todo;
  let pendingRows = [];
  try {
    pendingRows = await getPendingCategoryJobs(apiBase, sellerId);
    const pendingSet = new Set(pendingRows.map(j => j.rh_path));
    if (pendingSet.size) {
      todo = leaves.filter(leaf => pendingSet.has(leaf.rh_path));
    } else {
      const summary = await getCategoryJobSummary(apiBase, sellerId);
      if (summary.done > 0 && summary.pending === 0) {
        if (state.sellers[sellerId]) state.sellers[sellerId].categoryScanDone = true;
        state.apiMessage = `${sellerId}: tüm leaf kategoriler tamam ✓`;
        updatePopup(true);
        return 'skipped';
      }
      todo = leaves;
    }
  } catch (err) {
    state.apiMessage = `${sellerId}: job listesi alınamadı — ${err.message}`;
    updatePopup(true);
    return 'error';
  }

  const jobMap = new Map();
  for (const j of pendingRows) jobMap.set(j.rh_path, j);

  if (!todo.length) {
    if (state.sellers[sellerId]) state.sellers[sellerId].categoryScanDone = true;
    state.apiMessage = `${sellerId}: tüm leaf kategoriler tamam ✓`;
    updatePopup(true);
    return 'skipped';
  }

  const doneInDb = leaves.length - todo.length;
  const isResume = !forceFullRescan && doneInDb > 0;
  state.storeProducts[sellerId] = state.storeProducts[sellerId] || [];

  let scanTodo = todo;
  const shouldOptimize = options.branchPruning !== false && !isResume;
  if (shouldOptimize) {
    state.apiMessage = `${sellerId}: dal optimizasyonu (${todo.length} leaf bekliyor)...`;
    updatePopup(true);
    const opt = await optimizeBranchSubtrees(sellerId, leaves, todo, {
      apiUrl,
      autoUpload,
      sourceAsin
    });
    scanTodo = opt.remainingLeaves;
    if (opt.skippedLeaves > 0 || opt.collapsedLeaves > 0) {
      const parts = [];
      if (opt.skippedLeaves) parts.push(`${opt.skippedLeaves} boş dal atlandı`);
      if (opt.collapsedLeaves) parts.push(`${opt.collapsedLeaves} leaf üstten toplandı`);
      state.apiMessage = `${sellerId}: ${parts.join(', ')} — ${scanTodo.length} leaf taranacak`;
      updatePopup(true);
    }
  } else if (options.branchPruning !== false && isResume) {
    state.apiMessage = `${sellerId}: resume — sadece kalan ${scanTodo.length} leaf (dal optimizasyonu atlandı)`;
    updatePopup(true);
  }

  if (!scanTodo.length) {
    if (state.sellers[sellerId]) state.sellers[sellerId].categoryScanDone = true;
    state.apiMessage = `${sellerId}: budama sonrası taranacak leaf kalmadı ✓`;
    updatePopup(true);
    return 'scraped';
  }

  const parallelTabs = clampParallelTabs(options.parallelTabs);
  const resumeNote = isResume
    ? `DB'de ${doneInDb}/${leaves.length} hazır — kalan ${scanTodo.length} devam`
    : `${scanTodo.length} leaf`;
  state.apiMessage = `${sellerId}: ${resumeNote} — ${parallelTabs} tab paralel`;
  updatePopup(true);

  const stats = await runParallelCategoryScan(sellerId, scanTodo, jobMap, {
    autoUpload,
    apiUrl,
    sourceAsin,
    parallelTabs
  });

  state.categoryProgress = null;
  if (state.sellers[sellerId]) {
    state.sellers[sellerId].categoryScanDone = stats.errors === 0 && stats.done === stats.total;
    state.sellers[sellerId].inventoryMode = 'category';
  }
  state.apiMessage = `${sellerId}: bitti — ${stats.done}/${stats.total} leaf` +
    (stats.errors ? ` (${stats.errors} hata)` : '') + ' ✓';
  updatePopup(true);
  return 'scraped';
}

async function scrapeSellerInventory(sellerId, tabId, options) {
  const mode = options.inventoryMode || 'category';
  if (mode === 'flat') {
    state.apiMessage = 'UYARI: Flat mod (~306 ürün) — kategori için radio değiştir';
    updatePopup(true);
    const outcome = await scrapeSellerStore(sellerId, tabId, options.skipCached);
    if (outcome !== 'skipped' && options.autoUpload && options.apiUrl) {
      await uploadSellerToAPI(sellerId, options.apiUrl);
    }
    return outcome;
  }
  return scrapeSellerByCategories(sellerId, null, options);
}

async function startSellerRescan(options = {}) {
  if (isRunning) return;

  const saved = await getSettings();
  const apiUrl = (options.apiUrl || saved.apiUrl || DEFAULT_API_URL).trim();
  const apiBase = apiBaseFromUrl(apiUrl);
  const singleMode = Array.isArray(options.sellerIds) && options.sellerIds.length > 0;

  let queue;
  if (singleMode) {
    queue = [...new Set(options.sellerIds.map(id => String(id).trim().toUpperCase()).filter(Boolean))];
  } else {
    try {
      const rows = await fetchScanQueue(apiBase, options.resumeCategoryScan !== false);
      queue = rows.map(r => r.id);
    } catch (err) {
      state.apiMessage = 'Satıcı kuyruğu alınamadı: ' + err.message;
      updatePopup(true);
      return;
    }
  }

  if (!queue.length) {
    state.apiMessage = singleMode
      ? 'Geçerli satıcı ID yok'
      : 'Taranacak satıcı kalmadı (hepsi done) ✓';
    updatePopup(true);
    return;
  }

  if (options.forceFullRescan) {
    for (const sellerId of queue) {
      try {
        await fetch(`${apiBase}/sellers/${encodeURIComponent(sellerId)}/category-jobs/reset`, {
          method: 'POST'
        });
      } catch (_) {}
    }
  }

  await savePersistedSellerScan({
    pending: singleMode ? queue : queue,
    completed: singleMode ? [] : (await getPersistedSellerScan()).completed
  });

  isRunning = true;
  scheduleScanKeepalive();
  state.runMode = singleMode ? 'single_seller' : 'seller_rescan';
  state.targetSellerId = singleMode ? queue[0] : null;
  state.sellers = {};
  state.storeProducts = {};
  state.skippedSellers = [];
  state.skipCached = options.forceFullRescan ? false : (options.skipCached ?? saved.skipCached);
  state.autoUpload = options.autoUpload ?? saved.autoUpload;
  state.inventoryMode = 'category';
  state.resumeCategoryScan = options.forceFullRescan ? false : (options.resumeCategoryScan !== false);
  state.apiUrl = apiUrl;
  state.status = 'scraping_stores';
  state.apiMessage = singleMode
    ? `${queue[0]} — kategori taraması başlıyor...`
    : `${queue.length} satıcı kategori taraması başlıyor...`;
  updatePopup(true);

  const scanOpts = {
    sellerIds: singleMode ? queue : undefined,
    forceFullRescan: !!options.forceFullRescan,
    skipCached: state.skipCached,
    autoUpload: state.autoUpload,
    resumeCategoryScan: state.resumeCategoryScan,
    apiUrl: state.apiUrl,
    parallelTabs: clampParallelTabs(options.parallelTabs ?? saved.parallelTabs),
    branchPruning: options.branchPruning ?? saved.branchPruning,
    singleMode
  };
  await persistScanSession({
    type: 'seller_rescan',
    queue,
    sellerIndex: options._resumeFromIndex || 0,
    options: scanOpts,
    resumeAttempts: options._resumeAttempts || 0
  });

  const startIndex = options._resumeFromIndex || 0;
  try {
  for (let i = startIndex; i < queue.length; i++) {
    const sellerId = queue[i];
    if (i > startIndex) await delay(DELAY.BETWEEN_SELLERS);

    await persistScanSession({ sellerIndex: i });

    state.sellers[sellerId] = state.sellers[sellerId] || { id: sellerId, name: sellerId };

    try {
      const info = await fetchSellerInfo(apiBase, sellerId);
      if (info?.name) state.sellers[sellerId].name = info.name;
    } catch (_) {}

    state.apiMessage = `Satıcı ${i + 1}/${queue.length}: ${state.sellers[sellerId].name}`;
    updatePopup(true);

    const outcome = await scrapeSellerInventory(sellerId, null, {
      skipCached: state.skipCached,
      inventoryMode: 'category',
      autoUpload: state.autoUpload,
      apiUrl: state.apiUrl,
      resumeCategoryScan: state.resumeCategoryScan,
      forceFullRescan: options.forceFullRescan,
      parallelTabs: clampParallelTabs(options.parallelTabs ?? saved.parallelTabs),
      branchPruning: options.branchPruning ?? saved.branchPruning
    });

    if (outcome === 'skipped') {
      if (!state.skippedSellers.includes(sellerId)) state.skippedSellers.push(sellerId);
    } else if (outcome === 'error') {
      break;
    }

    await markSellerScanDone(sellerId);
  }
  } finally {
    await finishScanRun();
  }

  state.status = 'done';
  state.categoryProgress = null;
  state.targetSellerId = null;
  const q = await getPersistedSellerScan();
  if (singleMode) {
    const seller = queue[0];
    const products = state.storeProducts[seller]?.length || 0;
    state.apiMessage = state.skippedSellers.includes(seller)
      ? `${seller} atlandı (daha önce taranmış — Baştan tara ile zorla)`
      : `Bitti: ${seller} — ${products} ürün ✓`;
  } else {
    state.apiMessage = q.pending.length
      ? `Durdu: ${q.completed.length} satıcı tamam, ${q.pending.length} kaldı`
      : `Bitti: ${q.completed.length} satıcı kategori taraması tamamlandı ✓`;
  }
  updatePopup(true);
}

function updatePopup(force = false) {
  const now = Date.now();
  // Mağaza taramasında her sayfada storage'a yazma — quota patlamasını önler
  if (!force && state.status === 'scraping_stores' && now - lastPopupUpdate < 8000) {
    return;
  }
  lastPopupUpdate = now;

  chrome.storage.local.set({ scraperState: buildPopupSnapshot() }).catch(err => {
    console.warn('scraperState yazılamadı:', err.message);
  });
}

async function scrapeSellerStore(sellerId, tabId, skipCached, uploadOpts) {
  if (skipCached) {
    const cached = (await getSellerCache())[sellerId];
    if (cached?.complete) {
      state.storeProducts[sellerId] = [...(cached.products || [])];
      if (state.sellers[sellerId]) {
        state.sellers[sellerId].fromCache = true;
        state.sellers[sellerId].cachedAt = cached.scrapedAt;
      }
      updatePopup(true);
      return 'skipped';
    }
  }

  state.storeProducts[sellerId] = [];
  const seenKeys = new Set();
  let page = 1;
  let completed = false;

  // Boş sayfa gelene kadar devam et — "Sonraki" butonuna güvenme
  while (page <= 40) {
    if (page > 1) await delay(DELAY.STORE_PAGE);

    const url = `https://www.amazon.com/s?i=merchant-items&me=${sellerId}&page=${page}`;
    const match = m => m.sellerId === sellerId && m.page === page && !m.rhPath;
    const msgPromise = waitForMessage('STORE_PAGE_DONE', 35000, match);
    await chrome.tabs.update(tabId, { url });

    let result = await msgPromise;

    // Timeout olursa bir kez daha dene
    if (!result) {
      await delay(3000);
      result = await waitForMessage('STORE_PAGE_DONE', 35000, match);
    }

    if (!result) break;

    for (const p of result.products) {
      const key = `${p.asin}|${p.format || ''}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        state.storeProducts[sellerId].push(p);
      }
    }
    updatePopup();

    // Ürün yoksa son sayfaya ulaşıldı
    if (result.products.length === 0) {
      completed = true;
      break;
    }

    page++;
    if (page > 40) completed = true;
  }

  if (completed) {
    await saveSellerToCache(sellerId, {
      name: state.sellers[sellerId]?.name || sellerId,
      products: state.storeProducts[sellerId] || [],
      scrapedAt: Date.now(),
      complete: true,
      pageCount: page
    });
    if (state.sellers[sellerId]) {
      state.sellers[sellerId].fromCache = false;
      state.sellers[sellerId].pagesScraped = page;
    }
  }

  updatePopup(true);
  return 'scraped';
}

async function uploadSellerToAPI(sellerId, apiUrl) {
  const seller = state.sellers[sellerId];
  const products = state.storeProducts[sellerId] || [];

  if (!apiUrl || !seller) return { ok: false, message: 'API veya satıcı yok' };

  const payload = {
    sourceAsin: state.asin,
    seller,
    products
  };

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (errBody ? ': ' + errBody.slice(0, 80) : ''));
    }
    const body = await res.json().catch(() => ({}));
    seller.dbStatus = 'synced';
    seller.dbSyncedAt = Date.now();
    delete seller.dbError;
    updatePopup(true);
    return { ok: true, message: `${seller.name}: ${body.inserted ?? products.length} kayıt ✓` };
  } catch (err) {
    seller.dbStatus = 'error';
    seller.dbError = err.message;
    updatePopup(true);
    return { ok: false, message: `${seller.name}: ${err.message}` };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForMessage(type, timeoutMs, match) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(null);
    }, timeoutMs);
    const listener = (msg) => {
      if (msg.type === type && (!match || match(msg))) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

function downloadCSV(sellerId) {
  const products = state.storeProducts[sellerId] || [];
  const sellerName = state.sellers[sellerId]?.name || sellerId;

  const header = 'ASIN,Title,Format,Price\n';
  const rows = products.map(p =>
    `${p.asin},"${p.title.replace(/"/g, '""')}",${p.format},${p.price}`
  ).join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.create({
    url,
    filename: `${sellerName.replace(/[^a-z0-9]/gi, '_')}_products.csv`,
    saveAs: false
  });
}

function noteFleetProgress(jobsDone, jobsTotal) {
  lastFleetProgressAt = Date.now();
  if (!state.fleetMode) return;
  state.fleetJobsDone = jobsDone;
  state.fleetJobsTotal = jobsTotal;
  fleetHeartbeat('scanning', { progress: true }).catch(() => {});
}

async function fleetPost(path, body) {
  const saved = await getSettings();
  const base = apiBaseFromUrl(saved.apiUrl);
  return fetchJson(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 30000);
}

async function fleetLog(level, event, message, meta) {
  if (!state.fleetMachineId) return;
  try {
    await fleetPost('/fleet/log', {
      machineId: state.fleetMachineId,
      sellerId: state.fleetCurrentSeller,
      level,
      event,
      message,
      meta
    });
  } catch (err) {
    console.warn('fleetLog:', err.message);
  }
}

async function fleetHeartbeat(status, opts = {}) {
  if (!state.fleetMachineId) return null;
  const saved = await getSettings();
  const cp = state.categoryProgress;
  try {
    const data = await fleetPost('/fleet/heartbeat', {
      machineId: state.fleetMachineId,
      label: state.fleetMachineLabel || state.fleetMachineId,
      status: status || (isRunning ? 'scanning' : 'idle'),
      sellerId: state.fleetCurrentSeller || state.targetSellerId,
      queueIndex: state.fleetQueueIndex,
      jobsDone: cp?.done ?? state.fleetJobsDone ?? 0,
      jobsTotal: cp?.total ?? state.fleetJobsTotal ?? 0,
      parallelTabs: saved.parallelTabs,
      extensionVersion: EXTENSION_VERSION,
      popupMessage: state.apiMessage?.slice(0, 500),
      progressAt: opts.progress ? new Date(lastFleetProgressAt || Date.now()).toISOString() : undefined,
      meta: {
        isRunning,
        fleetLoopRunning,
        activeTabs: activeCategoryTabIds.length,
        runMode: state.runMode
      }
    });
    if (data?.commands?.length) {
      executeFleetCommands(data.commands).catch(err =>
        console.warn('Fleet commands:', err.message)
      );
    }
    return data;
  } catch (err) {
    console.warn('fleetHeartbeat:', err.message);
    return null;
  }
}

async function fleetAckCommand(commandId, success, result) {
  try {
    await fleetPost(`/fleet/commands/${commandId}/ack`, {
      machineId: state.fleetMachineId,
      success,
      result
    });
  } catch (err) {
    console.warn('fleetAck:', err.message);
  }
}

async function fleetReleaseCurrentSeller(reason) {
  const sellerId = state.fleetCurrentSeller || state.targetSellerId;
  if (!sellerId) return { released: false };
  try {
    const data = await fleetPost('/fleet/release', {
      machineId: state.fleetMachineId,
      sellerId,
      reason: reason || 'extension_release'
    });
    return data;
  } catch (err) {
    console.warn('fleetRelease:', err.message);
    return { released: false, error: err.message };
  }
}

async function fleetRestartCurrentSeller(reason) {
  const sellerId = state.fleetCurrentSeller || state.targetSellerId;
  if (!sellerId || !state.fleetMode) return;

  await fleetLog('warn', 'remote_restart', reason || 'Uzaktan yeniden başlatma');
  state.apiMessage = `${sellerId}: uzaktan yeniden başlatılıyor...`;
  updatePopup(true);

  await closeAllFleetCategoryTabs();
  await finishScanRun().catch(() => {});
  lastFleetProgressAt = Date.now();

  const saved = await getSettings();
  await runFleetSellerScan(sellerId, {
    skipCached: true,
    inventoryMode: 'category',
    autoUpload: saved.autoUpload,
    apiUrl: saved.apiUrl,
    resumeCategoryScan: true,
    parallelTabs: saved.parallelTabs,
    branchPruning: saved.branchPruning
  });
}

async function executeFleetCommands(commands) {
  for (const cmd of commands) {
    const id = cmd.id;
    const name = cmd.command;
    const payload = cmd.payload || {};
    try {
      if (name === 'stop_fleet') {
        await stopFleetOperations();
        await fleetAckCommand(id, true, { action: 'stopped' });
        continue;
      }

      if (name === 'set_parallel_tabs') {
        const n = clampParallelTabs(payload.parallelTabs);
        await saveSettings({ parallelTabs: n });
        await fleetAckCommand(id, true, { parallelTabs: n });
        continue;
      }

      if (name === 'release_seller') {
        const sellerId = payload.sellerId || state.fleetCurrentSeller || state.targetSellerId;
        if (sellerId && sellerId !== state.fleetCurrentSeller && sellerId !== state.targetSellerId) {
          await fleetAckCommand(id, false, { error: 'seller_not_active' });
          continue;
        }
        await fleetReleaseCurrentSeller(payload.reason || 'remote_release');
        await closeAllFleetCategoryTabs();
        await finishScanRun().catch(() => {});
        state.fleetCurrentSeller = null;
        state.targetSellerId = null;
        state.fleetQueueIndex = null;
        state.categoryProgress = null;
        lastFleetProgressAt = Date.now();
        state.apiMessage = 'Satıcı ataması serbest bırakıldı — sonraki kuyruk';
        updatePopup(true);
        await fleetAckCommand(id, true, { sellerId });
        continue;
      }

      if (name === 'restart_seller') {
        if (!state.fleetCurrentSeller && !state.targetSellerId) {
          await fleetAckCommand(id, false, { error: 'no_active_seller' });
          continue;
        }
        await fleetRestartCurrentSeller(payload.reason || 'remote_restart');
        await fleetAckCommand(id, true, { sellerId: state.fleetCurrentSeller || state.targetSellerId });
        continue;
      }

      await fleetAckCommand(id, false, { error: 'unknown_command' });
    } catch (err) {
      await fleetAckCommand(id, false, { error: err.message });
    }
  }
}

function scheduleFleetAlarms() {
  const hbMin = SCRAPER_API?.fleet?.heartbeatMin || 2;
  const wdMin = SCRAPER_API?.fleet?.watchdogMin || 15;
  chrome.alarms.create(FLEET_HEARTBEAT_ALARM, { periodInMinutes: hbMin });
  chrome.alarms.create(FLEET_WATCHDOG_ALARM, { periodInMinutes: wdMin });
}

function stopFleetAlarms() {
  chrome.alarms.clear(FLEET_HEARTBEAT_ALARM);
  chrome.alarms.clear(FLEET_WATCHDOG_ALARM);
}

async function stopFleetOperations() {
  const saved = await getSettings();
  state.fleetMode = false;
  fleetLoopRunning = false;
  stopFleetAlarms();
  await saveSettings({
    fleetMode: false,
    fleetMachineId: saved.fleetMachineId,
    fleetMachineLabel: saved.fleetMachineLabel
  });
  stopScanKeepalive();
  await finishScanRun().catch(() => {});
  await closeAllFleetCategoryTabs();
  await fleetLog('info', 'fleet_stop', 'Fleet durduruldu');
  await fleetHeartbeat('offline');
  state.apiMessage = 'Fleet modu durduruldu';
  updatePopup(true);
}

async function fleetClaimSeller() {
  const data = await fleetPost('/fleet/claim', { machineId: state.fleetMachineId });
  return data.claim || null;
}

async function fleetCompleteSeller(sellerId, success) {
  await fleetPost('/fleet/complete', {
    machineId: state.fleetMachineId,
    sellerId,
    success
  });
}

async function runFleetSellerScan(sellerId, options) {
  isRunning = true;
  state.status = 'scraping_stores';
  state.runMode = 'fleet';
  state.fleetCurrentSeller = sellerId;
  state.targetSellerId = sellerId;
  lastFleetProgressAt = Date.now();
  scheduleScanKeepalive();
  await fleetHeartbeat('scanning');
  await fleetLog('info', 'scan_start', `Tarama başlıyor: ${sellerId}`);
  updatePopup(true);

  let outcome;
  try {
    outcome = await scrapeSellerInventory(sellerId, null, options);
  } finally {
    state.fleetCurrentSeller = null;
    state.categoryProgress = null;
    await finishScanRun();
    if (state.fleetMode) {
      state.status = 'idle';
      updatePopup(true);
    }
  }

  const success = outcome !== 'error';
  await fleetCompleteSeller(sellerId, success);
  await fleetLog(success ? 'info' : 'error', success ? 'scan_done' : 'scan_error',
    `${sellerId} — ${outcome}`);
  return outcome;
}

async function fleetWatchdogTick() {
  if (!state.fleetMode) return;
  const sellerId = state.fleetCurrentSeller || state.targetSellerId;
  if (!sellerId) return;
  const staleMs = (SCRAPER_API?.fleet?.watchdogMin || 15) * 60 * 1000;
  if (Date.now() - lastFleetProgressAt < staleMs) return;

  await fleetLog('warn', 'watchdog', `15dk ilerleme yok — ${sellerId} yeniden başlatılıyor`);
  state.apiMessage = `${sellerId}: watchdog — sekmeler kapatılıp devam ediliyor...`;
  updatePopup(true);

  await closeAllFleetCategoryTabs();
  await finishScanRun().catch(() => {});
  lastFleetProgressAt = Date.now();

  if (!sellerId || !state.fleetMode) return;

  const saved = await getSettings();
  await runFleetSellerScan(sellerId, {
    skipCached: true,
    inventoryMode: 'category',
    autoUpload: saved.autoUpload,
    apiUrl: saved.apiUrl,
    resumeCategoryScan: true,
    parallelTabs: saved.parallelTabs,
    branchPruning: saved.branchPruning
  });
}

async function startFleetLoop() {
  if (fleetLoopRunning) return;
  fleetLoopRunning = true;
  const saved = await getSettings();

  while (state.fleetMode) {
    scheduleScanKeepalive();
    if (isRunning) {
      await delay(5000);
      continue;
    }
    let claim;
    try {
      claim = await fleetClaimSeller();
    } catch (err) {
      state.apiMessage = 'Fleet claim hatası: ' + err.message;
      await fleetLog('error', 'claim_error', err.message);
      updatePopup(true);
      await delay(15000);
      continue;
    }

    if (!claim?.sellerId) {
      state.apiMessage = 'Fleet: kuyruk boş — sunucuda POST /fleet/queue/sync gerekli';
      await fleetHeartbeat('idle');
      updatePopup(true);
      await delay(5 * 60 * 1000);
      continue;
    }

    state.fleetQueueIndex = claim.queueIndex;
    state.apiMessage = `Fleet #${claim.queueIndex}: ${claim.sellerName} (${claim.sellerId})`;
    updatePopup(true);

    const outcome = await runFleetSellerScan(claim.sellerId, {
      skipCached: true,
      inventoryMode: 'category',
      autoUpload: saved.autoUpload,
      apiUrl: saved.apiUrl,
      resumeCategoryScan: true,
      parallelTabs: saved.parallelTabs,
      branchPruning: saved.branchPruning
    });

    if (outcome === 'error') {
      await delay(10000);
    }
  }
  fleetLoopRunning = false;
}

async function startFleetOperations(msg = {}) {
  const saved = await getSettings();
  const machineId = String(msg.fleetMachineId || saved.fleetMachineId || '').trim();
  if (!machineId) throw new Error('Makine ID gerekli (örn. vm-01)');

  await saveSettings({
    fleetMode: true,
    fleetMachineId: machineId,
    fleetMachineLabel: msg.fleetMachineLabel || saved.fleetMachineLabel || machineId,
    apiUrl: msg.apiUrl || saved.apiUrl,
    parallelTabs: msg.parallelTabs ?? saved.parallelTabs,
    autoUpload: msg.autoUpload ?? saved.autoUpload
  });

  state.fleetMode = true;
  state.fleetMachineId = machineId;
  state.fleetMachineLabel = msg.fleetMachineLabel || saved.fleetMachineLabel || machineId;
  lastFleetProgressAt = Date.now();
  await clearScanSession();
  scheduleFleetAlarms();
  scheduleScanKeepalive();

  await fleetLog('info', 'fleet_start', 'Fleet modu başlatıldı');
  await fleetHeartbeat('idle');
  state.status = 'idle';
  state.apiMessage = `Fleet ${machineId} — kuyruktan satıcı alınıyor...`;
  updatePopup(true);

  startFleetLoop().catch(err => handleScrapeError(err, 'Fleet loop'));
}

async function tryResumeFleetMode() {
  const saved = await getSettings();
  if (!saved.fleetMode || !saved.fleetMachineId) return;
  state.fleetMode = true;
  state.fleetMachineId = saved.fleetMachineId;
  state.fleetMachineLabel = saved.fleetMachineLabel || saved.fleetMachineId;
  scheduleFleetAlarms();
  scheduleScanKeepalive();
  if (!fleetLoopRunning) {
    await fleetLog('info', 'fleet_resume', 'Service worker — fleet devam');
    startFleetLoop().catch(err => console.warn('Fleet resume:', err.message));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLEET_HEARTBEAT_ALARM) {
    getSettings().then(async saved => {
      if (!saved.fleetMode && !state.fleetMode) return;
      await tryResumeFleetMode().catch(() => {});
      fleetHeartbeat(isRunning ? 'scanning' : 'idle').catch(() => {});
    });
    return;
  }
  if (alarm.name === FLEET_WATCHDOG_ALARM) {
    fleetWatchdogTick().catch(err => console.warn('Watchdog:', err.message));
    return;
  }
  if (alarm.name !== KEEPALIVE_ALARM) return;
  getSettings().then(async saved => {
    if (saved.fleetMode || state.fleetMode) {
      scheduleScanKeepalive();
      if (!fleetLoopRunning) {
        await tryResumeFleetMode().catch(() => {});
      }
      return;
    }
    if (isRunning) {
      persistScanSession({}).catch(() => {});
      scheduleScanKeepalive();
      return;
    }
    tryResumeScanSession().catch(err => console.warn('Scan resume:', err.message));
  });
});

chrome.runtime.onStartup.addListener(() => {
  tryResumeFleetMode().catch(() => {});
  tryResumeScanSession().catch(() => {});
});

tryResumeFleetMode().catch(() => {});
