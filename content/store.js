// content/store.js
// amazon.com/s?i=merchant-items&me={SELLER_ID}&page={N} sayfalarında çalışır

(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const sellerId = urlParams.get('me');
  const page = parseInt(urlParams.get('page') || '1', 10);
  const rhRaw = urlParams.get('rh');
  const rhPath = rhRaw ? decodeURIComponent(rhRaw).replace(/%2C/gi, ',') : null;

  if (!sellerId) return;

  waitForResults(6000)
    .then(extractProducts)
    .catch(extractProducts);

  function hasResultBar() {
    return !!document.querySelector(
      '.s-desktop-width-max h2.a-size-base, .s-result-info-bar h2, h2.a-size-base.a-spacing-small'
    );
  }

  function parseResultStats() {
    const el = document.querySelector(
      '.s-desktop-width-max h2.a-size-base, .s-result-info-bar h2, h2.a-size-base.a-spacing-small'
    );
    const text = (el?.textContent || document.body.innerText || '').trim();
    const m = text.match(/of (?:over )?([\d,]+)\+?\s+results?/i);
    if (m) {
      return {
        amazonTotal: parseInt(m[1].replace(/,/g, ''), 10),
        resultText: text.slice(0, 120)
      };
    }
    const zero = text.match(/^0 results?\b/i);
    if (zero) return { amazonTotal: 0, resultText: text.slice(0, 120) };
    const one = text.match(/^1 result\b/i);
    if (one) return { amazonTotal: 1, resultText: text.slice(0, 120) };
    const shortCount = text.match(/^(\d[\d,]*)\s+results?\b/i);
    if (shortCount) {
      return {
        amazonTotal: parseInt(shortCount[1].replace(/,/g, ''), 10),
        resultText: text.slice(0, 120)
      };
    }
    return { amazonTotal: null, resultText: text ? text.slice(0, 120) : '' };
  }

  function extractProducts() {
    const products = [];
    const seen = new Set();
    const extractEdition = globalThis.ScraperHelpers?.extractEdition || (() => '');

    // Boş data-asin olan placeholder'ları atla
    const items = document.querySelectorAll(
      'div[data-asin]:not([data-asin=""]), [data-component-type="s-search-result"][data-asin]:not([data-asin=""])'
    );

    items.forEach(item => {
      const asin = (item.getAttribute('data-asin') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) return;
      seen.add(asin);

      const titleEl = item.querySelector(
        'h2 span, h2 a span, .a-text-normal, .a-link-normal .a-text-normal, ' +
        '.a-size-medium.a-color-base, .a-size-base-plus.a-color-base'
      );
      let title = titleEl?.textContent?.trim() || '';

      const productLink = item.querySelector('a[href*="/dp/"]');
      const href = productLink?.href || '';

      if (!title && productLink) {
        title = productLink.getAttribute('aria-label')?.trim() || '';
      }

      const secondaryEls = item.querySelectorAll(
        '.a-size-base.a-color-secondary, .s-format-text, span.a-size-base, .a-row.a-size-base'
      );
      const cardText = Array.from(secondaryEls)
        .map(el => el.textContent.trim())
        .filter(Boolean)
        .join(' | ');

      const format = extractEdition({ title, cardText, href });

      const priceEl = item.querySelector('.a-price .a-offscreen, .a-price-whole');
      let price = priceEl?.textContent?.trim() || '';
      // Fiyat yoksa kısa metinleri al; uzun edition metnini price'a yazma
      if (!price) {
        const fallback = item.querySelector('.a-color-price');
        const t = fallback?.textContent?.trim() || '';
        if (t && t.length <= 30) price = t;
      }

      products.push({ asin, title: title || asin, format, price });
    });

    const stats = parseResultStats();

    const send = globalThis.ScraperHelpers?.safeSendMessage || ((p) => {
      try { chrome.runtime?.sendMessage?.(p); } catch (_) {}
      return Promise.resolve(false);
    });
    send({
      type: 'STORE_PAGE_DONE',
      sellerId,
      page,
      rhPath,
      products,
      rawCount: items.length,
      amazonTotal: stats.amazonTotal,
      resultText: stats.resultText
    });
  }

  function waitForResults(timeoutMs) {
    return new Promise((resolve) => {
      const countItems = () =>
        document.querySelectorAll('div[data-asin]:not([data-asin=""])').length;

      if (countItems() >= 1 || hasResultBar()) {
        setTimeout(resolve, 400);
        return;
      }

      const observer = new MutationObserver(() => {
        if (countItems() >= 1 || hasResultBar()) {
          observer.disconnect();
          setTimeout(resolve, 400);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve();
      }, timeoutMs);
    });
  }
})();
