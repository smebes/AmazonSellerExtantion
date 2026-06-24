// extension/config.js — API sunucusu (Chrome'un yüklü olduğu makineden erişilebilir olmalı)
// Yerel geliştirme: host = '127.0.0.1'
// Sunucu (Docker API): host = '51.102.128.78'
const SCRAPER_API = {
  host: '51.102.128.78',
  port: 3009,
  get base() {
    return `http://${this.host}:${this.port}`;
  },
  get sellersUrl() {
    return `${this.base}/sellers`;
  },
  fleet: {
    heartbeatMin: 2,
    watchdogMin: 15
  }
};
