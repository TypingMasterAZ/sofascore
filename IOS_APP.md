# iOS App Build

Bu layihə iOS üçün Capacitor shell kimi hazırlandı. App açıldıqda `https://sofascore-xoyr.onrender.com` saytını native iOS WebView içində göstərir.

## Lazım Olanlar

- Mac kompüter
- Xcode
- Node.js
- iPhone-da test üçün Apple ID

Pulsuz Apple ID ilə app-i öz telefonunda test etmək olar, amma Apple onu 7 gündən bir yenidən imzalamağı tələb edə bilər. Hamıya paylamaq üçün Apple Developer hesabı lazımdır.

## İlk Quraşdırma

```bash
npm install
npm run ios:init
npm run ios:sync
npm run ios:open
```

`ios:init` yalnız bir dəfə lazımdır. `ios` qovluğu artıq varsa, sadəcə `npm run ios:sync` və `npm run ios:open` işlət.

Xcode açıldıqdan sonra:

1. `Signing & Capabilities` bölməsində öz Apple ID/Team seç.
2. iPhone-u Mac-a qoş.
3. Run düyməsinə bas.

## Sayt Dəyişəndə

Sayt Render-də işlədiyi üçün çox dəyişiklikdə iOS app-i yenidən build etmək lazım deyil. App içində public Render linki açılır. Native ayar dəyişsə, bunu işlə:

```bash
npm run ios:sync
npm run ios:open
```
