// content/product.js
// amazon.com/dp/{ASIN} sayfasında çalışır
// Sayfadaki tüm format/baskı tiplerini (Paperback, Hardcover, vs.) ve ASIN'lerini toplar

(function() {
  // Bu script yalnızca normal ürün sayfasında (format/baskı listesi için) çalışmalı.
  // AOD overlay (?aod=1) offers.js'in işidir — orada FORMAT_OPTIONS göndermeyiz,
  // aksi halde service worker döngüyü yeniden tetikler.
  if (/[?&]aod=1\b/.test(location.search)) return;

  // Sayfa tam yüklenene kadar bekle
  if (document.readyState !== 'complete') {
    window.addEventListener('load', extractFormats);
  } else {
    extractFormats();
  }

  function extractFormats() {
    const formats = [];

    // Yöntem 1: Format seçim butonları (#formats veya #mediaTab_*)
    // Amazon'da format seçenekleri genellikle şu şekilde görünür:
    // <li id="mediaTab_0"> <a href="/dp/B000MOHD7W/"> <span>Paperback</span> <span>$7.49</span> </a>

    const formatTabs = document.querySelectorAll(
      '#tmmSwatches .swatchElement, #formats .selected, [id^="mediaTab_"], .a-button-group .a-button'
    );

    formatTabs.forEach(el => {
      // ASIN'i href'den veya data attribute'den çek
      const link = el.querySelector('a[href*="/dp/"]');
      if (!link) return;

      const asinMatch = link.href.match(/\/dp\/([A-Z0-9]{10})/);
      if (!asinMatch) return;

      const asin = asinMatch[1];
      const labelEl = el.querySelector('span.a-button-text, span.a-color-base, .format-name');
      const priceEl = el.querySelector('.a-color-price, .a-price');

      formats.push({
        asin,
        label: labelEl?.textContent?.trim() || 'Unknown',
        price: priceEl?.textContent?.trim() || ''
      });
    });

    // Yöntem 2: Eğer format butonları bulunamazsa, mevcut sayfanın ASIN'ini kullan
    if (formats.length === 0) {
      const canonicalAsin = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      if (canonicalAsin) {
        const priceEl = document.querySelector('.a-price .a-offscreen, #price_inside_buybox');
        formats.push({
          asin: canonicalAsin,
          label: 'Default',
          price: priceEl?.textContent?.trim() || ''
        });
      }
    }

    // "Other Used/New/Collectible" linkini de bul (doğrudan AOD açmak için)
    // Bu link: "Other Used & New from $X.XX" veya "N used & new from $X.XX"
    const aodLinks = [];
    document.querySelectorAll('a[href*="aod=1"], a[href*="offer-listing"]').forEach(a => {
      const asinM = a.href.match(/\/dp\/([A-Z0-9]{10})/);
      if (asinM) aodLinks.push(asinM[1]);
    });

    const send = globalThis.ScraperHelpers?.safeSendMessage;
    if (send) {
      send({ type: 'FORMAT_OPTIONS', formats, aodAsins: [...new Set(aodLinks)] });
    } else {
      try {
        chrome.runtime?.sendMessage?.({
          type: 'FORMAT_OPTIONS',
          formats,
          aodAsins: [...new Set(aodLinks)]
        });
      } catch (_) {}
    }
  }
})();
