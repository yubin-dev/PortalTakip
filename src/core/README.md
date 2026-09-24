# Semaphore state sözleşmesi

`semaphore-state.js` ESM modülüdür. `createSemaphoreState({now, setTimeout, clearTimeout, onEvent, reconnectGraceMs})` bir RAM durumu üretir. Varsayılan saat `Date.now`, zamanlayıcılar Node zamanlayıcılarıdır. Testler bu bağımlılıkları değiştirir. `onEvent(event)` asenkron süre dolumlarını Hub'a duyurmak içindir; Hub bu olaylardan istemcilere yeni anlık durum gönderebilir. Gözlemci hatası durum geçişini geri almaz.

## Veri modeli

- Anahtar: `{organizationId, portal, accountCode}`. `portal` yalnızca `GİB` veya `SGK` olabilir. Üç alanın birleşimi bağımsız bir kilit ve FIFO kuyruk oluşturur. Baş ve sondaki boşluklar silinir; kod büyük/küçük harfe duyarlıdır. Boş kod reddedilir.
- Her anahtarın en çok bir `holder` kaydı ve sıralı `queue` kayıtları vardır. Kayıtlarda güvenilir `userId`, yalnızca gösterim amaçlı `displayName` ve zaman damgaları bulunur. `socketId` ayrı oturum eşlemesindedir; ad kimlik yerine geçmez.
- Aynı kurum ve `userId`, aynı anda tek canlı `socketId` ile eşleşir. Hub, `userId` ve yeniden bağlanma kimliğini doğrulamalıdır. Yeni soket, bağlantı kesildikten sonraki 30 saniyede aynı kullanıcıya bağlanırsa mevcut kilit ve kuyruk yerleri korunur. Süre dolarsa tüm yerleri temizlenir; kilit sıradakine geçer. Kopuk oturum `connected: false` görünür; istemci bu durumda kilit sahibi olduğunu iddia etmemelidir.
- Yönetici tarafından atılan kullanıcı kurum bazında `kickedUsers` kümesinde tutulur. Bu yasak eski veya yeni soketle `acquire` yapılmasını `KICKED` hatasıyla engeller. Yalnızca `readmitUser` yasağı kaldırır; önceki kilit veya kuyruk yeri geri verilmez.
- Çekirdek kilit, kuyruk ve atılma yasaklarını RAM'de tutar. Hub, atılma yasağını yerel ayar dosyasında ayrıca saklayıp yeniden açılışta uygular; kilitler ve kuyruklar boş başlar. `getSnapshot` kopya döndürür. Hub kurum yetkisine göre filtreleyip iletmelidir.

## İşlemler

Tüm değiştirici işlemler, `disconnect` dışında, kurum içinde benzersiz bir `requestId` ister. Başarılı istek sonuçları en çok 24 saat ve 100.000 kayıt boyunca saklanır; aynı kimlikle farklı içerik `REQUEST_ID_CONFLICT` döndürür. Tekrar `acquire` mevcut durumunu yeniden okur. Sonuçlar `{ok: true, status, key?, position?, affected?}` veya `{ok: false, code}` biçimindedir.

| İşlem | Girdi | Başarılı `status` |
| --- | --- | --- |
| `acquire` | anahtar, `userId`, `socketId`, `displayName`, `requestId` | `held`, `queued`; tekrar ama artık yer yoksa `stale` |
| `release` | anahtar, `userId`, `socketId`, `requestId` | `released`, yer yoksa `noop` |
| `cancel` | anahtar, `userId`, `socketId`, `requestId` | `cancelled`, sırada yoksa `noop` |
| `disconnect` | `socketId` | `disconnected`, bağlantı yoksa `noop` |
| `confirmPresence` | anahtar, `userId`, `socketId`, `requestId` | açık pencerede `confirmed`, pencere kapalıysa `noop` |
| `forceUnlock` | anahtar, `adminContext`, `requestId` | `unlocked`, kilit yoksa `noop` |
| `kick` | `organizationId`, hedef `userId`, `adminContext`, `requestId` | `kicked`, kullanıcı zaten atılmışsa `noop`; `affected` silinen yer sayısı |
| `readmitUser` | `organizationId`, hedef `userId`, `adminContext`, `requestId` | `readmitted`, kullanıcı atılmamışsa `noop` |
| `getSnapshot` | isteğe bağlı `{organizationId, portal, accountCode}` filtresi | `{locks: [{key, holder, queue}]}` |
| `isKicked` | `{organizationId, userId}` | `boolean`; Hub'ın yeniden bağlantı kabulü için salt okunur kontrol |
| `dispose` | girdi yok | Hub kapanırken zamanlayıcıları ve RAM durumunu temizler |

`adminContext` en az `{authorized: true, organizationId}` içerir. Bunu yalnızca Hub, yöneticiyi dışarıda doğruladıktan sonra oluşturmalıdır. Kurum kodu veya PIN bu modülde yoktur. Modül kendi başına ağ istemcilerini yetkilendirmez.

Kilit verilince ilk teyit zamanı sunucu saatine kaydedilir. **15 dakika** sonra `confirmation_required` olayı ve **60 saniyelik** teyit penceresi oluşur. `confirmPresence` yalnızca o penceredeki mevcut sahibin bağlı soketinden kabul edilir; başarılı teyit yeni 15 dakikalık süreyi başlatır. Pencere dolarsa kullanıcı düşürülür ve FIFO'daki ilk kişi aynı durum geçişinde kilidi alır. Bağlantı kopması için 30 saniyelik süre daha önce biterse de sıradakine geçilir. Tarayıcı sekmesindeki saate güvenilmez.

`forceUnlock` **her zaman** mevcut sahibi çıkarıp sıradaki kişiye devreder; kuyruk boşsa anahtar silinir. `kick` hedef kullanıcıyı kurumun tüm kilit ve kuyruklarından çıkarır; hedef kilit sahibiyse sıradakine devreder. Ayrıca canlı oturumu ve soket eşlemesini geçersiz kılar, kopma zamanlayıcısını iptal eder ve yeniden katılımı yasaklar. `readmitUser` yalnızca yasağı kaldırır. Yönetici işlemleri tekrar gönderimde aynı `requestId` ile ikinci kez uygulanmaz. Yeniden kabulden sonra eski bir `kick` isteğinin aynı `requestId` ile tekrarı kullanıcıyı yeniden atmaz; yeni atma için yeni istek kimliği gerekir.

Canlı soketi olan kullanıcı atıldığında modül, **yalnızca Hub'ın iç `onEvent` gözlemcisine** `{type: 'socket_kicked', organizationId, userId, socketId}` olayı gönderir. Bu olay, kurumun bütün kilit ve kuyruk kayıtları temizlendikten sonra teslim edilir. Hub ilgili WebSocket'i kapatmalı ve olayı personele yayınlamamalıdır. Kopuk oturum atılırsa canlı soket olmadığı için `socket_kicked` olayı üretilmez. `getSnapshot` içinde `socketId` bulunmaz.

Ortak hesap kodunu Hub/kurum yöneticisi hesap başına rastgele ve anlamsız üretip aynı hesabı kullanan personele güvenli biçimde vermelidir. Mükellef numarası, portal şifresi veya hassas hesap bilgisi kod olarak kullanılmamalıdır. Üretim ve dağıtım arayüzü sonraki fazın konusudur.
