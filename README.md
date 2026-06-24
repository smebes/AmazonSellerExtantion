# Amazon Seller Extension

Chrome Manifest V3 uzantısı — Amazon satıcı mağazalarını kategori bazlı tarar ve backend API'ye gönderir.

**Backend (private):** [SellerAsinList](https://github.com/Taletrunk-Books/SellerAsinList) — ana projede `extension/` submodule olarak bağlıdır.

## Kurulum

1. Chrome → `chrome://extensions`
2. **Developer mode** açık
3. **Load unpacked** → bu klasörü seç
4. Popup'ta API URL: `http://SUNUCU:3009/sellers`

## Fleet modu (VM filosu)

Popup'ta **Fleet** sekmesinden makine ID girin, backend adresini ayarlayın, **Fleet başlat**.

Sunucuda kuyruk: `POST /fleet/queue/sync`

## Geliştirme

```bash
git pull origin main
# Chrome → uzantıyı Reload
```

Değişiklikleri bu repoya push edin. Ana (private) repoda submodule işaretçisini güncellemek için:

```bash
cd ..   # SellerAsinList kökü
git add extension
git commit -m "extension submodule güncelle"
```
