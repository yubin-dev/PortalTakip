# Portal kapsülü (Faz 3.2)

`src/extension/manifest.json` content script'i yalnızca HTTPS `gib.gov.tr` / `*.gib.gov.tr` ve `sgk.gov.tr` / `*.sgk.gov.tr` ana sayfa çerçevelerine yükler. Kapsül sağ üstte açılır; başlığından sürüklenebilir. İzole content script dünyasında kapalı Shadow DOM kullanır. Durumlar (`Boş`, `Sizde`, `Meşgul`, `Sırada`, `Kopuk`, `Yeniden bağlanıyor`) yalnızca background worker'ın Hub `STATE` snapshot'ından türetilir. Hub bağlantısı veya güncel snapshot yoksa kapsül sahiplik iddiasında bulunmaz.

## Ortak hesap seçimi

Yönetici, **her portal hesabı için ayrı**, rastgele ve anlamsız en az 16 karakterlik ortak kod üretip yalnızca o hesabı kullanan personele güvenli bir kurum içi kanaldan dağıtır. Çalışan kapsülde `Ortak hesap kodu ekle` ile açıklayıcı bir takma ad ve kodu girip seçer; sonra aktif kod kapsülde görünür. Aynı portal hesabını kullanan herkes **aynı kodu** ekleyip seçmelidir; farklı hesabın kodu ayrı olmalıdır. Kod seçilmeden `ACQUIRE` düğmesi kapalıdır; background da isteği reddeder. Portal şifresi, vergi/T.C. kimlik numarası ve diğer mükellef verileri kod veya takma ad olarak kullanılmamalıdır. Yönetici panelinde kod üretme/dağıtma arayüzü henüz yoktur; bu adım yöneticinin sorumluluğundadır.

Kodlar ve sekme seçimleri yalnızca `chrome.storage.session` içinde tutulur; tarayıcı oturumu kapanınca tekrar girilir. Aynı Chrome profilini kullanan kişiler bu seçimlere erişebilir. Paylaşılan bilgisayarda ayrı profiller kullanılmalı ve iş bitince bağlantı kesilmelidir. Kapsül yalnızca **seçili** ortak hesap kodunu gösterir; diğer hesapların listesi takma adlardan oluşur. Ortak hesap kodu bir parola veya yetkilendirme belirteci olarak değerlendirilmemelidir.

## İşlemler ve teyit

Kilit isteği, bırakma/sıradan çıkma ve kullanım teyidi `chrome.runtime.sendMessage` ile background'a gider; content script WebSocket açmaz. Kısayollar kullanıcı kapsülde açana kadar kapalıdır. Açıldığında **Ctrl+Ç** kilit ister, **Ctrl+K** kilidi bırakır veya sıradan çıkar. Form alanında, düzenlenebilir öğede, tekrar eden/IME tuşunda ve portalın önceden `preventDefault()` ile işlediği tuşta tetiklenmez. Portal aynı kısayolu kullanıp olayı iptal etmiyorsa bunu güvenilir biçimde tespit etmek mümkün değildir; böyle bir portal ekranında `Kısayollar` seçimini kapatın. Düğmeler her zaman kullanılabilir.

Hub, son teyitten 15 dakika sonra açtığı 60 saniyelik pencereyi `confirmationDeadlineAt` ile bildirir. Kapsül modalı yalnızca bu snapshot'a göre açar. Görünen geri sayım Hub'ın `serverTime` değerinden hesaplanan kalan süreye ve yerel monoton geçen süreye dayanır. Sayaç kilidi devretmez ve süre dolunca modalı kendi başına kapatmaz; yeni Hub snapshot'ını bekler. Sekme kapalıyken de Hub'ın kendi zamanlayıcısı devri yapar. Sıra geldiğinde Chrome bildirimi ve kapsülde kısa bir uyarı görünür; ses kullanıcı açarsa çalınır.

## DOM ve mesaj güvenliği

Kapsül tüm metinleri `textContent` ile yazar, form girdilerini background tekrar doğrular, `innerHTML`/`eval`/sayfa `postMessage` kullanmaz. Sayfa betiğine kurum kodu, personel erişim anahtarı veya yönetici işlemi aktarılmaz. Background içerik mesajlarını eklenti kimliği, ana çerçeve ve resmî HTTPS kaynak adresiyle sınırlar. Shadow DOM görünüm yalıtımıdır; sayfadaki betiklere karşı güvenlik sınırı olarak kabul edilmez. Portal sayfasındaki diğer eklentiler veya kullanıcı, ekranda gösterilen ortak hesap kodunu görebilir.
