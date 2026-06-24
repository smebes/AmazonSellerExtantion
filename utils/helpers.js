// utils/helpers.js
// Ortak yardımcı fonksiyonlar (content script'ler ve service worker tarafından kullanılabilir)

// URL'den ASIN çek
function parseAsin(url) {
  return url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || null;
}

// URL'den seller ID çek
function parseSellerId(url) {
  return url.match(/seller=([A-Z0-9]{10,20})/)?.[1] || null;
}

// Belirli bir süre bekle
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CSV satırı için string kaçışı
function csvEscape(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Extension reload sonrası veya bağlam kopunca çökmemesi için güvenli mesaj
function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        resolve(false);
        return;
      }
      chrome.runtime.sendMessage(payload, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch {
      resolve(false);
    }
  });
}

// Başlık, kart metni ve URL'den baskı tipi / platform çıkar
function extractEdition({ title = '', cardText = '', href = '' } = {}) {
  const combined = `${title} ${cardText} ${href}`;

  const titlePatterns = [
    [/\(Kindle Edition[^)]*\)/i, 'Kindle Edition'],
    [/\[Kindle Edition[^\]]*\]/i, 'Kindle Edition'],
    [/\(Mass Market Paperback[^)]*\)/i, 'Mass Market Paperback'],
    [/\(Paperback[^)]*\)/i, 'Paperback'],
    [/\[Paperback[^\]]*\]/i, 'Paperback'],
    [/\(Hardcover[^)]*\)/i, 'Hardcover'],
    [/\[Hardcover[^\]]*\]/i, 'Hardcover'],
    [/\(Audio CD[^)]*\)/i, 'Audio CD'],
    [/\(MP3 CD[^)]*\)/i, 'MP3 CD'],
    [/\(Audiobook[^)]*\)/i, 'Audiobook'],
    [/\(Library Binding[^)]*\)/i, 'Library Binding'],
    [/\(Flexibound[^)]*\)/i, 'Flexibound'],
    [/\(Spiral-?[Bb]ound[^)]*\)/i, 'Spiral-bound'],
    [/(?:–|-)\s*(Paperback|Hardcover|Audio CD|Kindle Edition)\s*$/i, '$1']
  ];

  for (const [re, label] of titlePatterns) {
    const m = title.match(re);
    if (m) return typeof label === 'string' && label.includes('$1') ? m[1] : label;
  }

  const keywordMap = [
    ['mass market paperback', 'Mass Market Paperback'],
    ['library binding', 'Library Binding'],
    ['audio cd', 'Audio CD'],
    ['mp3 cd', 'MP3 CD'],
    ['audiobook', 'Audiobook'],
    ['paperback', 'Paperback'],
    ['hardcover', 'Hardcover'],
    ['kindle edition', 'Kindle Edition'],
    ['flexibound', 'Flexibound'],
    ['vinyl', 'Vinyl'],
    ['blu-ray', 'Blu-ray'],
    ['dvd', 'DVD']
  ];
  const lower = cardText.toLowerCase();
  for (const [kw, label] of keywordMap) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      return label;
    }
  }

  const platformPatterns = [
    [/playstation\s*5|\bps5\b/i, 'PS5'],
    [/playstation\s*4|\bps4\b/i, 'PS4'],
    [/xbox\s*series/i, 'Xbox Series X|S'],
    [/xbox\s*one/i, 'Xbox One'],
    [/nintendo\s*switch/i, 'Nintendo Switch'],
    [/\bpc\b/i, 'PC']
  ];
  for (const [re, label] of platformPatterns) {
    if (re.test(combined)) return label;
  }

  if (/paperback/i.test(href)) return 'Paperback';
  if (/hardcover/i.test(href)) return 'Hardcover';

  return '';
}

const ScraperHelpers = { parseAsin, parseSellerId, delay, csvEscape, extractEdition, safeSendMessage };

if (typeof globalThis !== 'undefined') {
  globalThis.ScraperHelpers = ScraperHelpers;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScraperHelpers;
}
