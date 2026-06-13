# Taskofonico macOS Desktop - Phase 1

Bu fazda yapilanlar:

- Web icindeki dogrudan `localStorage` kullanimi ortak bir persistence katmanina tasindi.
- Basecamp token, tema, tab sirasi ve tabaktakiler artik `src/lib/persistence.ts` uzerinden yonetiliyor.
- Bu sayede sonraki fazda `localStorage` yerine Tauri store / secure storage / macOS keychain adaptoru gecirilebilecek.
- Tauri Store plugin baglandi.
- Desktop acilisinda Tauri Store -> browser storage hidrasyonu eklenerek otomatik geri yukleme zemini kuruldu.

Sonraki sertlestirme adimlarinda tamamlananlar:

1. Basecamp token'i macOS Keychain tabanli secure storage katmanina tasindi
2. Desktop acilista sessiz oturum geri yukleme zemini kuruldu
3. Native notification ve hizli activity polling akisi eklendi
4. Menubar / launch at login / close-to-tray akisi eklendi
5. Tauri'nin varsayilan DMG adimi kirildigi icin repo icine manuel DMG script'i eklendi

Bu makinede artik hazir olanlar:

- `cargo`
- `rustc`
- `@tauri-apps/cli`
- `@tauri-apps/plugin-store`
- `src-tauri` iskeleti

Desktop komutlari:

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:build:app
npm run desktop:build:dmg
```

Not:
Su an desktop kaliciligi Tauri Store + macOS Keychain ile calisir.
Varsayilan `tauri build` akisi `.app` bundle uretiyor ancak bu makinede estetik `.dmg` adimi dusuyor.
Bu nedenle dagitim icin `npm run desktop:build:dmg` komutu repo icindeki sade ve calisan manuel `.dmg` ureticisini kullanir.
Desktop auth koprusu su an varsayilan olarak `https://taskofonico.onrender.com` uzerinden calisir ancak `VITE_DESKTOP_BACKEND_URL` ile degistirilebilir.
