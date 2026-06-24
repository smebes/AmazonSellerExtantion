// content/offers.js
// amazon.com/dp/{ASIN}?aod=1 sayfasında çalışır
// AOD (All Offers Display) overlay'inden satıcı isim + ID'lerini toplar

(function() {
  // Yalnızca AOD overlay (?aod=1) ya da offer-listing sayfasında çalış.
  // İlk dp/{ASIN} yüklemesinde (aod yokken) çalışıp boş SELLERS_FOUND göndererek
  // state'i kirletmesini engelle.
  const isAod = /[?&]aod=1\b/.test(location.search);
  const isOfferListing = /\/gp\/offer-listing\//.test(location.pathname);
  if (!isAod && !isOfferListing) return;

  // AOD overlay'i DOM'a eklenmesi için bekle (dynamic loading)
  waitForElement('#aod-offer-list, #aod-container, .a-popover-content', 8000)
    .then(extractSellers)
    .catch(() => {
      // AOD yüklenmediyse yine de dene
      extractSellers();
    });

  function extractSellers() {
    const sellers = {};

    // Satıcı linkleri: <a class="a-size-small a-link-normal" href="/gp/aag/main?...seller=XXXX...">
    const sellerLinks = document.querySelectorAll(
      'a.a-size-small.a-link-normal[href*="seller="], a[href*="/gp/aag/main"]'
    );

    sellerLinks.forEach(link => {
      const idMatch = link.href.match(/seller=([A-Z0-9]{10,20})/);
      if (!idMatch) return;

      const sellerId = idMatch[1];
      const sellerName = link.textContent.trim();

      // Geçersiz linkleri filtrele
      if (!sellerName || sellerName.length < 2) return;
      if (/best seller|clear|more|\+/i.test(sellerName)) return;

      // Bu satıcının hangi offer'ı sunduğunu da bul
      const offerEl = link.closest('#aod-offer, .aod-offer-row, [id^="aod-offer-"]');
      let format = 'Unknown', price = '';

      if (offerEl) {
        // Format (Paperback, Hardcover, vs.)
        const conditionEl = offerEl.querySelector(
          '.a-size-large.a-color-price, .a-size-medium.a-color-price, ' +
          '[id^="aod-offer-heading"], .aod-offer-condition'
        );
        format = conditionEl?.textContent?.trim() || 'Unknown';

        // Fiyat
        const priceEl = offerEl.querySelector('.a-price .a-offscreen, .a-price-whole');
        price = priceEl?.textContent?.trim() || '';
      }

      if (!sellers[sellerId]) {
        sellers[sellerId] = { name: sellerName, id: sellerId, offers: [] };
      }
      sellers[sellerId].offers.push({ format, price });
    });

    // "See N options" butonu varsa tıkla (daha fazla satıcı için)
    const seeMoreBtn = document.querySelector(
      'a[href*="aod=1"]:not([data-scraper-clicked]), button.see-more-offers'
    );

    if (seeMoreBtn && Object.keys(sellers).length === 0) {
      seeMoreBtn.setAttribute('data-scraper-clicked', '1');
      seeMoreBtn.click();
      setTimeout(extractSellers, 2000);
      return;
    }

    const sourceAsin = location.pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || null;
    const send = globalThis.ScraperHelpers?.safeSendMessage;
    const payload = { type: 'SELLERS_FOUND', sourceAsin, sellers };
    if (send) {
      send(payload);
    } else {
      try { chrome.runtime?.sendMessage?.(payload); } catch (_) {}
    }
  }

  // DOM'da element görünene kadar bekleyen yardımcı
  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) { resolve(existing); return; }

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); reject(); }, timeoutMs);
    });
  }
})();
