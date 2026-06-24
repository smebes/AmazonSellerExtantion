// popup/popup.js

const SETTINGS_KEY = 'scraperSettings';
const QUEUE_KEY = 'asinQueuePersist';

function parseAsins(text) {
  const seen = new Set();
  const result = [];
  for (const part of text.split(/[\s,;\n]+/)) {
    const s = part.trim().toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(s) && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}

function parseSellerId(text) {
  const t = String(text || '').trim();
  const urlMatch = t.match(/[?&]me=([A-Z0-9]+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  if (/^A[A-Z0-9]{9,20}$/i.test(t)) return t.toUpperCase();
  return null;
}

function updateAsinCount(pendingLen) {
  const n = pendingLen ?? parseAsins(document.getElementById('asinInput').value).length;
  document.getElementById('asinCount').textContent =
    n === 1 ? '1 ASIN kalan' : `${n} ASIN kalan`;
}

function updateQueueProgress(q) {
  const el = document.getElementById('queue-progress');
  if (!q) {
    el.textContent = '';
    return;
  }
  const done = q.completed?.length || 0;
  const left = q.pending?.length || 0;
  if (!done && !left) {
    el.textContent = '';
    return;
  }
  let html = `<span class="done">✓ ${done} tamamlandı</span> · ${left} kalan`;
  if (q.completed?.length) {
    const last = q.completed.slice(-3).join(', ');
    html += `<br><span class="done">Son: ${last}</span>`;
  }
  el.innerHTML = html;
}

function syncTextareaFromQueue(q, force = false) {
  const ta = document.getElementById('asinInput');
  if (!force && document.activeElement === ta) return;
  if (q?.pending) {
    ta.value = q.pending.join('\n');
    updateAsinCount(q.pending.length);
  }
}

function loadQueue() {
  chrome.runtime.sendMessage({ type: 'GET_QUEUE' }, (q) => {
    if (chrome.runtime.lastError || !q) return;
    syncTextareaFromQueue(q, true);
    updateQueueProgress(q);
  });
}

function saveQueueDraft() {
  const pending = parseAsins(document.getElementById('asinInput').value);
  chrome.runtime.sendMessage({ type: 'SAVE_QUEUE', pending });
  updateAsinCount(pending.length);
}

function getFormSettings() {
  const inventoryMode = document.querySelector('input[name="inventoryMode"]:checked')?.value || 'category';
  const parallelRaw = parseInt(document.getElementById('parallelTabs').value, 10);
  const parallelTabs = Number.isFinite(parallelRaw)
    ? Math.min(8, Math.max(1, parallelRaw))
    : 5;
  return {
    skipCached: document.getElementById('skipCached').checked,
    autoUpload: document.getElementById('autoUpload').checked,
    inventoryMode,
    apiUrl: document.getElementById('apiUrl').value.trim(),
    sellerId: document.getElementById('sellerIdInput')?.value?.trim() || '',
    parallelTabs,
    branchPruning: document.getElementById('branchPruning').checked,
    fleetMachineId: document.getElementById('fleetMachineId')?.value?.trim() || '',
    fleetMachineLabel: document.getElementById('fleetMachineLabel')?.value?.trim() || ''
  };
}

function persistSettings() {
  chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: getFormSettings()
  });
}

function loadSettings() {
  const apiInput = document.getElementById('apiUrl');
  const defaultApi = typeof SCRAPER_API !== 'undefined' ? SCRAPER_API.sellersUrl : '';
  if (defaultApi && !apiInput.value) apiInput.value = defaultApi;

  chrome.storage.local.get(SETTINGS_KEY, ({ scraperSettings: s }) => {
    if (s?.apiUrl) apiInput.value = s.apiUrl;
    else if (defaultApi && !apiInput.value) apiInput.value = defaultApi;
    if (!s) return;
    if (s.autoUpload === false) document.getElementById('autoUpload').checked = false;
    if (s.skipCached === false) document.getElementById('skipCached').checked = false;
    if (s.sellerId) document.getElementById('sellerIdInput').value = s.sellerId;
    if (s.parallelTabs != null) document.getElementById('parallelTabs').value = s.parallelTabs;
    if (s.branchPruning === false) document.getElementById('branchPruning').checked = false;
    if (s.fleetMachineId) document.getElementById('fleetMachineId').value = s.fleetMachineId;
    if (s.fleetMachineLabel) document.getElementById('fleetMachineLabel').value = s.fleetMachineLabel;
    const mode = s.inventoryMode || 'category';
    const radio = document.querySelector(`input[name="inventoryMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
  });
}

document.getElementById('asinInput').addEventListener('input', () => updateAsinCount());
document.getElementById('asinInput').addEventListener('blur', saveQueueDraft);

['skipCached', 'autoUpload', 'apiUrl', 'parallelTabs', 'branchPruning'].forEach(id => {
  document.getElementById(id).addEventListener('change', persistSettings);
  if (id === 'apiUrl' || id === 'parallelTabs') {
    document.getElementById(id).addEventListener('blur', persistSettings);
  }
});

document.querySelectorAll('input[name="inventoryMode"]').forEach(el => {
  el.addEventListener('change', persistSettings);
});

document.getElementById('sellerIdInput')?.addEventListener('blur', persistSettings);
document.getElementById('fleetMachineId')?.addEventListener('blur', persistSettings);
document.getElementById('fleetMachineLabel')?.addEventListener('blur', persistSettings);

document.getElementById('startFleetBtn')?.addEventListener('click', () => {
  const settings = getFormSettings();
  if (!settings.fleetMachineId) {
    alert('Makine ID girin (örn. vm-01)');
    return;
  }
  persistSettings();
  if (settings.autoUpload && !settings.apiUrl) {
    alert('Otomatik DB yükleme için API URL girin');
    return;
  }
  chrome.runtime.sendMessage({
    type: 'START_FLEET',
    fleetMachineId: settings.fleetMachineId,
    fleetMachineLabel: settings.fleetMachineLabel,
    apiUrl: settings.apiUrl,
    parallelTabs: settings.parallelTabs,
    autoUpload: settings.autoUpload
  });
  document.getElementById('status').textContent = `Fleet ${settings.fleetMachineId} başlatılıyor...`;
});

document.getElementById('stopFleetBtn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_FLEET' });
  document.getElementById('status').textContent = 'Fleet durduruluyor...';
});

document.getElementById('scanOneSellerBtn').addEventListener('click', () => {
  const settings = getFormSettings();
  const sellerId = parseSellerId(settings.sellerId);
  if (!sellerId) {
    alert('Geçerli satıcı ID girin (örn. AV8BWFAA8SLJI veya me= içeren URL)');
    return;
  }
  persistSettings();
  if (settings.autoUpload && !settings.apiUrl) {
    alert('Otomatik DB yükleme için API URL girin');
    return;
  }
  const forceFullRescan = document.getElementById('forceFullRescan').checked;
  chrome.runtime.sendMessage({
    type: 'START_SELLER_SCAN',
    sellerIds: [sellerId],
    forceFullRescan,
    resumeCategoryScan: !forceFullRescan,
    skipCached: forceFullRescan ? false : settings.skipCached,
    inventoryMode: 'category',
    autoUpload: settings.autoUpload,
    apiUrl: settings.apiUrl,
    parallelTabs: settings.parallelTabs
  });
  document.getElementById('status').textContent = `${sellerId} kategori taraması başlatıldı...`;
  document.getElementById('scanOneSellerBtn').disabled = true;
  document.getElementById('scanSellersBtn').disabled = true;
  document.getElementById('startBtn').disabled = true;
});

document.getElementById('scanSellersBtn').addEventListener('click', () => {
  const settings = getFormSettings();
  persistSettings();
  if (settings.autoUpload && !settings.apiUrl) {
    alert('Otomatik DB yükleme için API URL girin');
    return;
  }
  if (!confirm('DB\'deki satıcılar kategori bazlı taranacak. Devam?')) return;
  chrome.runtime.sendMessage({ type: 'START_SELLER_SCAN', ...settings });
  document.getElementById('status').textContent = 'Satıcı kategori taraması başlatıldı...';
  document.getElementById('scanSellersBtn').disabled = true;
});

document.getElementById('startBtn').addEventListener('click', () => {
  const asins = parseAsins(document.getElementById('asinInput').value);
  if (!asins.length) {
    alert('Kuyrukta ASIN yok. Listeye ASIN ekleyin veya kaldığınız yerden devam için kayıtlı listeyi yükleyin.');
    return;
  }

  const settings = getFormSettings();
  persistSettings();

  if (settings.autoUpload && !settings.apiUrl) {
    alert('Otomatik DB yükleme için API URL girin');
    return;
  }

  chrome.runtime.sendMessage({ type: 'START_SCRAPE', asins, ...settings });
  document.getElementById('status').textContent =
    asins.length === 1 ? 'Tarama başlatıldı...' : `${asins.length} ASIN kuyruğa alındı...`;
  document.getElementById('startBtn').disabled = true;
});

document.getElementById('clearQueueBtn').addEventListener('click', () => {
  if (!confirm('Kalan ve tamamlanan ASIN listesi silinsin mi?')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE' }, () => {
    document.getElementById('asinInput').value = '';
    updateAsinCount(0);
    updateQueueProgress({ pending: [], completed: [] });
  });
});

document.getElementById('csvBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_CSV', sellerId: getActiveSeller() });
});

document.getElementById('apiBtn').addEventListener('click', () => {
  const url = document.getElementById('apiUrl').value.trim();
  if (!url) { alert('API URL girin'); return; }
  const activeSeller = getActiveSeller();
  if (!activeSeller) { alert('Önce bir satıcı seçin'); return; }
  chrome.runtime.sendMessage({ type: 'SEND_TO_API', sellerId: activeSeller, apiUrl: url });
});

chrome.storage.local.get('scraperState', ({ scraperState: s }) => {
  if (s) renderState(s);
  else chrome.runtime.sendMessage({ type: 'GET_STATE' }, (full) => { if (full) renderState(full); });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.scraperState) renderState(changes.scraperState.newValue);
  if (changes[QUEUE_KEY]) {
    const q = changes[QUEUE_KEY].newValue;
    syncTextareaFromQueue(q);
    updateQueueProgress(q);
  }
});

loadSettings();
loadQueue();

let activeSellerId = null;
function getActiveSeller() { return activeSellerId; }

function dbStatusLabel(seller) {
  if (seller.dbStatus === 'synced') return '✓ kayıtlı';
  if (seller.dbStatus === 'error') return '✗ hata';
  return '—';
}

function productCount(state, sellerId) {
  return state.productCounts?.[sellerId]
    ?? state.storeProducts?.[sellerId]?.length
    ?? 0;
}

function renderState(state) {
  const statusMap = {
    idle: 'Bekliyor',
    scraping_product: 'Ürün sayfası taranıyor...',
    scraping_offers: 'Teklifler toplanıyor...',
    scraping_stores: state.runMode === 'single_seller'
      ? 'Tek satıcı kategori taraması...'
      : state.runMode === 'seller_rescan'
        ? 'Satıcı kategori taraması...'
        : 'Mağaza / kategori taranıyor...',
    done: 'Tamamlandı!'
  };

  let statusText = statusMap[state.status] || state.status;
  const done = state.queueCompleted?.length || 0;
  const left = state.queuePending?.length || 0;

  if (state.status !== 'idle' && state.status !== 'done' && state.asin && state.runMode === 'asin') {
    statusText = `${done + 1}/${done + left} (${state.asin}) — ${statusText}`;
  }
  if (state.status !== 'idle' && state.status !== 'done' && state.runMode === 'single_seller' && state.targetSellerId) {
    statusText = `${state.targetSellerId} — ${statusText}`;
  }
  if (state.status === 'done' && state.skippedSellers?.length) {
    statusText += ` (${state.skippedSellers.length} satıcı önbellekten)`;
  }
  if (state.categoryProgress) {
    const cp = state.categoryProgress;
    if (cp.parallel > 1) {
      statusText += ` — ${cp.done}/${cp.total} leaf (${cp.parallel} sekme)`;
      if (cp.active?.length) {
        statusText += `: ${cp.active.map(a => a.name).slice(0, 3).join(', ')}`;
      }
    } else {
      statusText += ` — kategori ${cp.current}/${cp.total}: ${cp.name || cp.rhPath}`;
    }
  }

  document.getElementById('status').textContent = statusText;

  if (state.status === 'done' || state.status === 'idle') {
    document.getElementById('startBtn').disabled = false;
    document.getElementById('scanSellersBtn').disabled = false;
    document.getElementById('scanOneSellerBtn').disabled = false;
  }

  document.getElementById('api-status').textContent = state.apiMessage || '';

  if (state.queuePending || state.queueCompleted) {
    updateQueueProgress({
      pending: state.queuePending,
      completed: state.queueCompleted
    });
    updateAsinCount(state.queuePending?.length);
  }

  const sellers = state.sellers || {};
  if (Object.keys(sellers).length > 0) {
    document.getElementById('sellers-section').style.display = 'block';
    const tbody = document.getElementById('sellers-body');
    tbody.innerHTML = '';

    Object.entries(sellers)
      .sort((a, b) => productCount(state, b[0]) - productCount(state, a[0]))
      .forEach(([id, seller]) => {
        const products = productCount(state, id);
        const editions = (seller.sourceEditions || []).join(', ') || '—';
        const status = seller.fromCache
          ? 'önbellek'
          : (seller.categoryScanDone ? 'kategori ✓' : (products > 0 ? 'tarandı' : 'boş'));
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${seller.name}</td>
          <td><code>${id}</code></td>
          <td>${editions}</td>
          <td>${products} ürün</td>
          <td>${status}</td>
          <td title="${seller.dbError || ''}">${dbStatusLabel(seller)}</td>
        `;
        tr.addEventListener('click', () => showProducts(id));
        tbody.appendChild(tr);
      });
  }
}

function showProducts(sellerId) {
  activeSellerId = sellerId;
  document.getElementById('products-section').style.display = 'block';

  const tbody = document.getElementById('products-body');
  tbody.innerHTML = '<tr><td colspan="4">Yükleniyor...</td></tr>';

  chrome.runtime.sendMessage({ type: 'GET_SELLER_PRODUCTS', sellerId }, (products) => {
    tbody.innerHTML = '';
    if (!products?.length) {
      tbody.innerHTML = '<tr><td colspan="4">Ürün yok</td></tr>';
      return;
    }
    products.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.asin}</td>
        <td>${p.title}</td>
        <td>${p.format || '—'}</td>
        <td>${p.price || '—'}</td>
      `;
      tbody.appendChild(tr);
    });
  });
}
