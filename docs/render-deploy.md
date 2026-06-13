# Render Guncelleme Notu

Taskofonico desktop auth koprusu varsayilan olarak `https://taskofonico.onrender.com` adresine gider.
Bu nedenle Render servisi eski build'de kalirsa desktop login sonrasi eski ekran veya tekrar giris davranisi gorulebilir.

## Render ayarlari

- Root directory: repo koku
- Build command: `npm ci && npm run build`
- Start command: `npm run start`
- Environment:
  - `NODE_ENV=production`
  - `APP_URL=https://taskofonico.onrender.com`
  - `BASECAMP_CLIENT_ID=...`
  - `BASECAMP_CLIENT_SECRET=...`

Repo icinde `render.yaml` eklendi. Render'da yeni Blueprint olusturulursa bu ayarlari otomatik ceker.

## Guncel deploy nasil dogrulanir

Deploy sonrasi su adresi ac:

`https://taskofonico.onrender.com/api/health`

Beklenen cevap:

```json
{
  "ok": true,
  "appUrl": "https://taskofonico.onrender.com",
  "version": "...",
  "desktopAuthBridgeEnabled": true
}
```

Eger bu endpoint eski veya hata veriyorsa Render eski build'dedir.

## Desktop tarafi

Desktop uygulama varsayilan olarak `https://taskofonico.onrender.com` kullanir.
Ileride farkli backend'e gecilecekse:

- Render servisini ayni domainde guncelle
- veya `VITE_DESKTOP_BACKEND_URL` ile yeni backend adresini build aninda ver
