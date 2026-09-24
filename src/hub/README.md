# PortalTakip Hub kurulumu

Hub tek kurumun Windows bilgisayarında çalışır. Personel WebSocket servisi varsayılan olarak `0.0.0.0:8787` üzerinde, yönetici HTTP paneli **yalnızca `127.0.0.1:8788`** üzerinde açılır. Yönetici paneli Chrome eklentisinin parçası değildir. Hub bulut veya harici veritabanı kullanmaz.

## Yönetici için ilk kurulum ve onarım

Hazır `PortalTakip Hub.exe` dosyasını Hub bilgisayarına kopyalayıp **çift tıklayın**. Uygulama yalnızca kurulum, güncelleme veya onarım gerektiğinde Windows yönetici izni ister. `%ProgramFiles%\PortalTakip` içine kopyalanır; `%ProgramData%\PortalTakip\hub.json` için yalnızca SYSTEM/Administrators erişimi ayarlanır. SYSTEM açılış görevi ve Private ağ profili ile LocalSubnet sınırındaki personel portu kuralı oluşturulur. Tarayıcı yalnızca `http://127.0.0.1:8788` adresini açar. Kurulum kodu URL'de, logda veya komut satırında bulunmaz: yönetici izinli uygulama penceresinde gösterilir. Bu kodu ilk kurulum ekranına kurum adı ve yeni parolayla birlikte girin. Personeli ekleyip panelden davet oluşturabilirsiniz. Başarılı kurulum kod dosyasını siler.

Aynı EXE'ye tekrar çift tıklamak sağlıklı kurulu paneli açar; farklı içerikteki yeni EXE'yi çift tıklamak günceller. Kurulum eski görevi durdurur, açık portları kontrol eder, EXE'yi yedekleyerek değiştirir, görevi/kuralı yeniler ve panelin gerçek kurulu işlem tarafından dinlendiğini doğrular. Hata olursa eski EXE'yi geri yüklemeyi ve önceki görevi başlatmayı dener; `hub.json` silinmez. Port çakışmasında PID ile onarım penceresi gösterilir. Kapanmış uygulama veya bozuk görev için EXE'yi yeniden açıp UAC iznini onaylayın. Windows uykudayken Hub hizmet vermez.

Panel LAN IPv4 adresi değiştiğinde eski/yeni adresi gösterir; personele yeni adresi ilettikten sonra uyarıyı onaylayın. Hub yeniden başladıysa panel RAM kilitlerinin ve kuyrukların boşaldığını bildirir. İşletim sistemi yeniden başlatıldığında görev otomatik çalışacak şekilde **kurulur**, fakat fiziksel Windows yeniden başlatma kabulü ayrıca yapılmalıdır. Aynı masaüstü oturumundaki kötü amaçlı yazılıma karşı kullanıcı arayüzünde gösterilen kodun gizliliği garanti edilemez; farklı yetkisiz yerel kullanıcı ve LAN istemcisi korunan koda erişemez. Kurulum kodunu paylaşmayın.

## Node ile geliştirme

Windows'ta **yönetici olarak açılmış PowerShell** içinde:

```powershell
npm.cmd ci
npm.cmd run hub:init
npm.cmd run hub:start
```

Windows'ta Node girişi, doğrudan EXE ve açılış görevi aynı kalıcı dosyayı kullanır: `%ProgramData%\PortalTakip\hub.json` (genellikle `C:\ProgramData\PortalTakip\hub.json`). Çalışma dizini ve oturum açan kullanıcı bunu değiştirmez. `hub:init` veya EXE `--prepare` 120 rastgele bitlik, 20 karakterli ilk kurulum kodu üretir; konsola/loga yazmaz. Kod, yalnızca `SYSTEM` ve Windows Administrators erişebilen `%ProgramData%\PortalTakip\setup-key.txt` dosyasına yazılır; `hub.json` içinde yalnızca SHA-256 hash'i bulunur. Geliştirici CLI akışında kod dosyası elle okunabilir; çift tıklama akışında uygulama kodu yönetici penceresinde gösterir. Başarılı kurulum kod dosyasını siler. Parola rastgele tuzlu `scrypt` hash'i olarak saklanır. Kurum kodu panelde yalnızca kurulumdan sonra veya yenilendiğinde görünür; loglara yazılmaz. `PORTALTAKIP_CONFIG` yalnızca geliştirme/test için açık yol geçersiz kılmasıdır; başlangıç görevi kalıcı yolu `--config-path` ile açıkça verir.

Eski sürümün proje içindeki `data/hub.json` dosyası varsa, yeni `hub:init` hedef henüz yokken bu dosyayı **kopyalar, kaynağı silmez**. Bekleyen ilk kurulum için daha önce paylaşılmış anahtarı otomatik yeniler. Kurulum betiği de kendi yanında bulunan `data/hub.json` için aynı geçişi yapar. Eski dosya başka klasördeyse yönetici PowerShell'inde `& '.\dist\PortalTakip Hub.exe' --prepare --migrate-from 'C:\eski\proje\data\hub.json'` kullanın; hedef dosya varsa komut üzerine yazmaz. Geçişten sonra eski kopyayı güvenli arşiv politikanıza göre ayrı ele alın; çalışma ayarı artık ProgramData'dadır.

Önceden paylaşılan **bekleyen ilk kurulum kodunu**, yapılandırmayı silmeden yenilemek için uygulamayı tekrar açıp yönetici iznini onaylayın. Kurulum görevi durdurur, bekleyen kodu yeniler ve yeni kodu pencerede gösterir. Geliştirici CLI'sinde `hub:rotate-setup-key` de kullanılabilir. Tamamlanmış kurulumda ilk kurulum kodu zaten geçersizdir. Mevcut kurum/personel/hesap/parola ayarları korunur.

Portları `PORTALTAKIP_WS_PORT` ve `PORTALTAKIP_ADMIN_PORT` ortam değişkenleriyle veya EXE için `--ws-port` ve `--admin-port` argümanlarıyla ayarlayın. `PORTALTAKIP_WS_HOST` veya `--ws-host` personel dinleme adresini belirler. Yönetici adresi değiştirilemez.

## Windows EXE oluşturma ve kurma

Paketleme, bu depoda test edilen Node.js 26.8.2'nin yerleşik `--build-sea` işlevini ve geliştirme bağımlılığı `esbuild`'i kullanır. Derleme Windows üzerinde yapılır; çıktı `dist/PortalTakip Hub.exe` dosyasıdır. Hedef bilgisayarda Node.js veya `node_modules` gerekmez.

```powershell
npm.cmd ci
npm.cmd run hub:build-exe
npm.cmd run hub:smoke-exe
```

Dağıtım öncesi mevcut EXE hâlâ çalışıyorsa Windows dosyayı kilitleyebilir. Çalışan Hub'ı kesmeden yeni bir dosya üretmek için `PORTALTAKIP_EXE_OUTPUT` ile `dist` altında ayrı bir EXE yolu seçin; `PORTALTAKIP_EXE_PATH` ile duman testini bu dosyaya yönlendirin. Bakım sırasında `install-windows.ps1 -ExePath <yeni-exe-yolu>` kurulu EXE'yi ve açılış görevini günceller.

**Yönetici olarak açılmış** PowerShell'de kurulum:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

Betik EXE'yi `%ProgramFiles%\PortalTakip` altına kopyalar; ayar dosyasını `%ProgramData%\PortalTakip\hub.json` altında oluşturur veya korur. Betik ve dosya izinlerini ayarlayan kod EXE içine gömülüdür; normal kullanıcı betiği ayrıca çalıştırmaz. `SYSTEM` hesabıyla bilgisayar açılışında çalışan `PortalTakip Hub` adlı Windows Zamanlanmış Görevini kaydeder; görev argümanında kalıcı ayar yolu açıkça bulunur. Görev için süre sınırını kapatır ve hata sonrası üç yeniden başlatma dener. Yalnızca Private ağ profili + LocalSubnet için WebSocket portu güvenlik duvarı kuralı açar. Varsayılan portlar `8787` ve `8788`'dir; geliştirici CLI'sinde örneğin `-WsPort 9001 -AdminPort 9002` ile değiştirilebilir. Betiği yeniden çalıştırmak mevcut kurum ayarlarını korur ve görev/EXE/kuralı günceller.

Kurulum için Windows yönetici yetkisi gerekir; Görev Zamanlayıcı ve güvenlik duvarı kuralı normal kullanıcı tarafından oluşturulamaz. Kurulumdan sonra panel, **Hub bilgisayarında** normal kullanıcı oturumundan açılabilir; yönetici parolası gerekir. Ayar dosyası erişimi `SYSTEM` ve Windows Administrators ile sınırlandırılır. Üretilen EXE imzalanmamıştır; dağıtım ortamında kurumsal kod imzalama tercih edilebilir. Görevin çalışmasını Görev Zamanlayıcı'dan `PortalTakip Hub` adıyla ve panel adresini yerel tarayıcıdan kontrol edin.

Gerçek kurulumdan sonra yönetici PowerShell'inde `(Get-ScheduledTask -TaskName 'PortalTakip Hub').Principal.UserId` sonucunun `SYSTEM`, `(Get-ScheduledTask -TaskName 'PortalTakip Hub').Actions` içindeki `--config-path` değerinin `%ProgramData%\PortalTakip\hub.json` olmasını doğrulayın. `icacls.exe "$env:ProgramData\PortalTakip"` ve `icacls.exe "$env:ProgramData\PortalTakip\hub.json"` çıktısında yalnızca `SYSTEM` ile Administrators erişimi bulunmalı. Görevi `Start-ScheduledTask -TaskName 'PortalTakip Hub'` ile başlatıp `http://127.0.0.1:8788/api/session` adresini Hub bilgisayarından açın. Elle EXE denemesinde görevi durdurun, başka bir çalışma dizinine geçin ve kurulu EXE'yi mutlak yolla başlatın; panel aynı kalıcı ayarı görmelidir.

Bilgisayar uykuya veya hazırda beklemeye girerse Hub ağ hizmeti durur. Yönetici bilgisayarında Windows **Ayarlar → Sistem → Güç ve pil → Ekran, uyku ve hazırda bekleme zaman aşımları** bölümünden prize takılıyken uykuyu kapatın; ekranı kapatmak ayrı bir ayardır. Windows açılışı ve görev başladığında Hub yeni `hubId` üretir; kilit/kuyruk RAM'i boş başlar. Kurum adı, kod hash'i, parola hash'i ve personel kayıtları ayar dosyasında kalır.

`npm.cmd run hub:smoke-exe` gömülü kurulum betiğini gerçek EXE içinden `-WhatIf` ile kuru çalıştırır; geçici ayar yolunda `hub:init` çalıştırır ve EXE'yi farklı çalışma dizininden, başlangıç görevi gibi açık `--config-path` ile başlatır. Panel/personel/kilit akışını, kodun loglanmamasını ve yeniden başlatmada kalıcı ayarların korunup RAM kilitlerinin boşalmasını doğrular. Bu test gerçek `%ProgramData%` ACL'si, UAC penceresi, `SYSTEM` açılış görevi veya güvenlik duvarını değiştirmez; yönetici yetkili Windows kurulumunda ayrıca doğrulayın.

## Personel bağlantısı

Yönetici, panelde mevcut bir personel için **Davet oluştur** seçer. Hub yalnızca davet sırrının SHA-256 hash'ini `%ProgramData%\PortalTakip\hub.json` içinde saklar; bağlantı 10 dakika geçerli ve tek kullanımlıktır. Yeni davet aynı personelin önceki kullanılmamış davetini geçersiz kılar. Yönetici doğru LAN IPv4 adresini seçip bağlantıyı ilgili personele verir. Örnek biçim `http://192.168.1.10:8787/invite#invite=<sır>`; URL parçasındaki sır HTTP isteğinde Hub'a gitmez. `/invite` sayfası yalnızca yapıştırma yönergesi gösterir, eklentiye otomatik aktarım yapmaz. Eklenti sırla WebSocket `HELLO` gönderir; Hub daveti atomik tüketip o cihaz için ayrı bir erişim anahtarı üretir ve yalnızca hash'ini saklar. Başarılı yanıttan önce bağlantı kesilirse davet tüketilmiş olabilir; yönetici yeni davet oluşturmalıdır. Davet veya cihaz anahtarı loglara yazılmaz.

Panelde cihaz kimlikleri ve iptal durumu görülür; **Cihazı iptal et** bağlı soketi kapatır ve o kullanıcının kilit/sıra kayıtlarını hemen bırakır. Atılan personel cihaz anahtarıyla da bağlanamaz; yeniden kabul edilince iptal edilmemiş cihaz anahtarı yeniden kullanılabilir, eski kilit/sıra yeri geri gelmez. Kurum kodu yenilenirse tüm kullanılmamış davetler ve cihaz anahtarları iptal edilir; mevcut bağlantılar kapanır. Eski beş alanlı elle bağlantı yöntemi korunur.

Eski v1/v2/v3 `hub.json` dosyası açılışta v4 şemasına atomik yazımla geçirilir: kurum kimliği, kurum kodu hash'i, personel kayıtları ve mevcut anahtar hash'leri korunur; eksik davet/cihaz dizileri eklenir. `accounts: []` ve `legacyAllowed: true` eklenerek mevcut yerel hesap kodlarıyla bağlantı sürer. Yeni kurulumlarda `accounts: []`, `legacyAllowed: false` başlar. Kurulum ayarları kalıcıdır, kilit/kuyruk her açılışta RAM'de boş başlar.

Panelin kurulum alanı **Hub LAN IPv4 adresini**, **WebSocket portunu** ve **kurum kodunu** ayrı alanlarda gösterir ve ayrı ayrı kopyalar. Birden çok ağ kartı varsa doğru LAN adresini seçin; bulunmazsa `ipconfig` ile doğrulayıp elle yazın. Eklentide adres, port, kurum kodu ve kişiye özel erişim anahtarı birlikte gerekir. Kurum kodu Hub adresini kendisi bulmaz. IP değişirse tüm personelin adres ayarını güncelleyin; DHCP rezervasyonu adresi sabit tutabilir. Port değişirse görev, güvenlik duvarı kuralı ve eklenti ayarları birlikte güncellenmelidir. LAN portu HTTP yönetici paneli sunmaz.

Panelde personel için ayrı rastgele erişim anahtarı veya kısa süreli davet oluşturun. Hesap kataloğunda portalı, kişisel/mükellef bilgisi içermeyen görünen adı ve erişecek personelleri seçin. Hub her yeni hesap için değişmeyen rastgele ortak kod üretir ve `hub.json` içinde katalog/atamayı saklar. Kod yetki sırrı değildir; personelin kilit anahtarıdır. Yalnızca atanmış hesaplar personelin `STATE` mesajına girer. Yönetici paneli hesap kodlarını yalnızca oturumlu loopback erişiminde gösterir. Personel anahtarı ve davet/cihaz sırlarının yalnızca hash'i saklanır.

**1.0 geçişi:** Eski yerel hesap listeleri `chrome.storage.session` içinde olduğu gibi kalır. Eski kurulumda `legacyAllowed: true` ile elle kod ekleme/işlem geçici olarak sürer. Panelde **Eski yerel kodları eşleştir** alanına eski portal ve kodu aynen girin, o kodla çalışan herkesin erişimini seçin. Hub kodu yeniden üretmez ve etkin kilit/kuyrukları başka anahtara taşımaz. Etkin bir kod içe alınırken sıradaki veya sahibi olan tüm personel atanmamışsa içe alma reddedilir. Tüm eski kodlar eşleştikten sonra **Eski elle kullanımı kapat** seçin; eşleşmemiş etkin kilit/kuyruk varsa işlem reddedilir. Bu düğme `legacyAllowed: false` yapar; bilinmeyen kodlar artık Hub'da `ACCOUNT_FORBIDDEN` alır. Eski yerel liste silinmez, fakat kapsülde gösterilmez. Atanmış yönetilen kodla eşleşen yerel seçim aynı kodda korunur. Bu kapatma için geri açma API'si yoktur; gerekli eski kodları önce eşleştirin.

Bir hesaptan personel çıkarılınca yetki önce kalıcı ayara yazılır, ardından yalnızca o portal ve hesap kodundaki kilit/sıra yeri hemen silinir. Kilit sahibi çıkarıldıysa sıradaki kişiye FIFO devredilir; kişinin diğer hesapları etkilenmez. Panel bu kuralı ve hedefi onayda gösterir. Yeni atamalar ve kaldırmalar açık WebSocket bağlantılarına yeni `STATE` ile yansır; yeniden bağlanma gerekmez. Genel snapshot personele verilmez: yönetilen hesaplarda yalnızca atandığı kodlar ve kilitleri; geçişte bilinmeyen eski kodlarda yalnızca kendisinin katıldığı kilit gösterilir. Başka hesabın kodu veya kuyruğu açığa çıkmaz.

Kurum kodunu yenilemek için yönetici parolasını tekrar girin. Yenileme yeni 32 baytlık kod üretir, yalnızca hash'ini saklar, mevcut WebSocket bağlantılarını `CODE_ROTATED` ile kapatır ve davet/cihaz anahtarlarını iptal eder. Eski elle bağlantı yöntemini kullananlara yeni kodu güvenli biçimde dağıtın; davet yöntemi için yeni davet oluşturun. Kayıp kod geri okunamaz; yeniden yenilenir. Kullanıcı atıldığında bağlantısı kapatılır, yeniden bağlanması engellenir; panelden yeniden kabul edildiğinde eski sıra/kilit yeri geri gelmez. Kilit düşürme mevcut sahibini çıkarır ve sıradakine devreder.

**Varsayılan kurulum güvenilen kurum LAN'ı içindir. Düz `ws://` trafiği şifreli değildir; elle bağlantı anahtarları, davet sırrı ve cihaz anahtarı ağ üzerinde açık iletilir.** Güvenilmeyen ağda WSS sağlayan bir TLS katmanı gerekir. Uygulama resmî portallara giriş yapmaz, portal şifresi toplamaz veya sayfa verisi kazımaz.

## WebSocket protokolü (v1)

JSON metin mesajları kullanılır; ikili ve 8 KiB üzeri mesajlar reddedilir. Bilinmeyen alanlar reddedilir. Kullanıcı kimliği, ad, kurum ve soket kimliği istemci işlem mesajlarından alınmaz; doğrulanmış kimlik bilgisi ve bağlantıdan atanır. Bağlantı açıldıktan sonraki 10 saniye içinde `HELLO` gerekir.

| Yön | Mesaj | Alanlar |
| --- | --- | --- |
| İstemci → Hub | `HELLO` | Tam olarak biri: eski `organizationCode` + `staffToken`, yeni `inviteToken` veya `deviceToken`; isteğe bağlı `lastHubId` (UUID) |
| Hub → istemci | `HELLO` | `status: "ok"`, `hubId`, `connectionId`, `userId`, `displayName`, `stateReset`; davet kullanıldıysa yalnızca bu yanıtta `deviceToken` |
| İstemci → Hub | `ACQUIRE`, `RELEASE`, `CANCEL`, `CONFIRM` | `requestId` (UUID), `portal` (`GİB`/`SGK`), `accountCode` (16–128 URL güvenli karakter) |
| Hub → istemci | aynı işlem türü | `requestId`, `status`, varsa `position` |
| İstemci → Hub | `STATE` | İsteğe bağlı `requestId`; güncel durum isteği |
| Hub → istemci | `STATE` | `hubId`, `serverTime` (Unix ms), `organizationId`, `reason`, `reset`, atanan `accounts` (`id`, `portal`, `label`, `code`), `legacyAllowed`, filtrelenmiş `locks` |
| Hub → istemci | `ERROR` | `code`, ilgiliyse `requestId` |

```json
{"type":"ACQUIRE","requestId":"1d19684c-9afb-4ad9-a886-710ae65e2dd7","portal":"GİB","accountCode":"aBcD1234efGH5678"}
```

`requestId` kurum içinde her **yeni işlem** için benzersiz olmalıdır. Yanıtı belirsiz kalmış **aynı işlem** aynı Hub'a yeniden gönderilecekse aynı ID ve aynı içerik kullanılır; farklı içerik `REQUEST_ID_CONFLICT` verir. Başarılı işlem geçmişi RAM'de en çok 24 saat/100.000 kayıt tutulur. Hub yeniden başladıysa eski işlem tekrar gönderilmez; yeni snapshot alınır. Bağlantı kopukken eklenti kilidi alınmış göstermemeli; yalnızca güncel Hub `STATE` verisine güvenmelidir.

Davet tüketimi `requestId` ile tekrar oynatılmaz: ilk geçerli `HELLO` daveti kalıcı ayarda tüketip cihaz anahtarını kaydeder; eşzamanlı ikinci kullanım `INVITE_INVALID` alır. Süre sınırı Hub saatiyle `expiresAt` anında biter. `deviceToken` aynı personel kimliğine bağlıdır; yönetici cihazı iptal edince yeni `HELLO` `DEVICE_REVOKED` alır. Yönetici HTTP işlemleri yalnızca loopback panelinde oturum ve CSRF ile yapılır: `POST /api/invitations` (`userId`) tek sefer gösterilen sır ve bitiş zamanı döner; `POST /api/devices/revoke` (`deviceId`) idempotent iptal eder. `GET /api/state` yalnızca cihaz kimliği/zamanı/iptal durumunu verir, sırları vermez.

Her başlangıçta `hubId` değişir. İstemci eski `hubId`'yi `lastHubId` olarak gönderir; farklıysa `HELLO.stateReset` ve ilk `STATE.reset` `true` olur. Aynı Hub'a yeniden bağlanınca güncel snapshot gönderilir. Aynı personel anahtarıyla yeni `HELLO` önceki soketi kapatır. Çekirdek kopan kullanıcının yerini 30 saniye tutar; yeni bağlantıdan yeni `ACQUIRE` gelirse yer korunur, süresi dolarsa temizlenir. Sunucu zamanlayıcı tek yetkilidir. Atılma yasağı ve personel kayıtları yeniden başlatmada kalır; kilitler ve kuyruklar kalmaz.

Yönetici oturumu paroladan ayrıdır; `HttpOnly`, `SameSite=Strict` çerezi kullanır. Mutasyonlar aynı kaynak `Origin` ve oturuma özel CSRF başlığı ister. Oturum 30 dakika hareketsizlik veya 8 saat toplam sürede biter. HTTP gövdesi 16 KiB ile sınırlandırılır; WebSocket yükseltme, `HELLO` ve mesajlarda oran sınırı vardır. Personel kurum kodu yönetici yetkisi vermez.

Hesap API'si yalnızca aynı oturum/CSRF ile loopback panelindedir: `POST /api/accounts` (`portal`, `label`, `assignedUserIds`) yeni sabit kod üretir; `POST /api/accounts/import` aynı alanlar ve `accountCode` ile eski kodu aynen kaydeder; `POST /api/accounts/assign` (`accountId`, `assignedUserIds`) atamaları değiştirir; `POST /api/accounts/enforce` boş gövdeyle eski elle kullanımını kapatır. `GET /api/state` tam kataloğu yalnızca yöneticiye verir. Eski `POST /api/account-code` geçişte kullanılabilir, yönetilen moda geçince reddedilir. Personel `ACQUIRE` ve diğer işlemlerinde Hub aynı portal+kod için atamayı denetler; atanmadıysa `ACCOUNT_FORBIDDEN` verir.
