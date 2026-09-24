# Personel Hub istemcisi (MV3)

`client.js` tek Manifest V3 service worker girişidir. Hub'a **istemci** olarak `new WebSocket('ws://<özel LAN IP>:<port>/ws')` ile bağlanır; `SemaphoreRoom` içermez, Chrome üzerinde dinleyen TCP/WebSocket sunucusu açmaz. Popup ve content script ile yalnızca `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` kullanır. Cihazlar arasındaki mesajlar Hub'ın [WebSocket protokolünü](../hub/README.md) kullanır.

## İzin ve kaynak kapsamı

- Manifest yalnızca `storage`, `notifications` ve `alarms` API izinlerini ister. Chrome'un [resmî MV3 WebSocket örneğinde](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/functional-samples/tutorial.websockets/manifest.json) WebSocket için `host_permissions` yoktur. Burada da değişken Hub adresi için `http://*/*` veya `<all_urls>` gibi geniş host izni ve `optional_host_permissions` istenmez. `fetch`/XHR kullanılmıyor; bunlar için host izni gereklidir.
- Popup girdisi ile worker doğrulaması Hub hedefini **literal özel IPv4, yerel/loopback IPv6 veya `localhost`** ve 1–65535 portla sınırlar. Genel IP, keyfî hostname, URL yolu ve `https://` girdisi reddedilir. Kurum kodu IP adresini çözmez.
- Content script yalnızca HTTPS `gib.gov.tr` / alt alanları ve `sgk.gov.tr` / alt alanlarında, ana çerçevede ve izole dünyada çalışır. `externally_connectable` tanımlı değildir. Worker, gelen content mesajının eklenti kimliğini, sekme URL'sini ve çerçevesini yeniden denetler; Hub kimlik bilgisini veya yönetici işlemlerini content'e iletmez.
- Chrome 147 ve sonrası yerel adrese WebSocket açarken ayrıca **tarayıcının yerel ağ erişim istemini** gösterebilir. Bu istem, MV3 `optional_host_permissions` isteminden ayrı bir Chrome ağ kısıtıdır; kurum politikası da etkileyebilir. [Chrome 147 sürüm notları](https://developer.chrome.com/release-notes/147).

## Bağlantı ve durum ömrü

En düşük Chrome sürümü **116**; bu sürümden itibaren [WebSocket trafiği MV3 worker ömrünü uzatabilir](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets). Worker 20 saniyede bir `STATE` ister. `HELLO` veya ilk snapshot 12 saniyede gelmezse, düzenli `STATE` yanıtı 10 saniyede gelmezse ya da uzun süredir snapshot yoksa soketi kapatıp yeniden bağlanır. Backoff 2, 4, 8, 16, 30 saniyedir. `alarms` izni, worker askıya alındığında yeniden deneme için yedek uyanma sağlar; alarm zamanı kesin değildir. Worker her uyandığında `chrome.storage.session` içindeki etkin bağlantıyı geri yükler.

Soket kapanır kapanmaz yerel snapshot temizlenir ve kapsül `Yeniden bağlanıyor` gösterir. Yeniden `HELLO` sonrası Hub'ın ilk `STATE` snapshot'ı gelmeden kilit sahipliği gösterilmez. Hub `hubId` değiştirirse RAM kilitleri sıfırlanmış kabul edilir. Sunucu, bağlantı kopunca kullanıcı yerini **30 saniye** tutar; nihai kilit/kuyruk temizliği ve 15 dakika + 60 saniye teyit süresi sunucunun yetkisindedir. Worker veya sekme kapanması kilidin anında bırakıldığı anlamına gelmez. `chrome.tabs.onRemoved` yalnızca bu istemcinin sekme seçimi ve yayın aboneliğini temizler; Hub'a `RELEASE` yollamaz.

Her işlem için UUID `requestId` üretilir. ACK belirsizken aynı Hub'a 30 saniye içinde dönülürse worker **aynı mesajı ve aynı `requestId`'yi** yeniden yollar; Hub böylece tekrarı idempotent işler. Hub değişmişse veya süre geçerse bekleyen işlem tekrar yollanmaz ve güncel snapshot esas alınır. Worker tamamen yeniden başlatılırsa bellekteki bekleyen işlem listesi kaybolabilir; yeniden bağlanınca snapshot ile eşitlenir. Sekmedeki `ACQUIRE` ancak seçili ortak hesap kodu ve güncel snapshot varken gönderilir.

Kurum kodu ve personel erişim anahtarı yalnızca `chrome.storage.session` içinde tutulur; kalıcı `storage.local` içine yazılmaz. Varsayılan `ws://` trafiği şifrelenmez; yalnızca güvenilen kurum LAN'ı için tasarlanmıştır.
