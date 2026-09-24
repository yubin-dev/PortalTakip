# PortalTakip Hub kurulumu

Hub tek kurumun Windows bilgisayarında çalışır. Personel WebSocket servisi varsayılan olarak `0.0.0.0:8787` üzerinde, yönetici HTTP paneli **yalnızca `127.0.0.1:8788`** üzerinde açılır. Yönetici paneli Chrome eklentisinin parçası değildir. Hub bulut veya harici veritabanı kullanmaz.

## Node ile geliştirme

Windows'ta **yönetici olarak açılmış PowerShell** içinde:

```powershell
npm.cmd ci
npm.cmd run hub:init
npm.cmd run hub:start
```

Windows'ta Node girişi, doğrudan EXE ve açılış görevi aynı kalıcı dosyayı kullanır: `%ProgramData%\PortalTakip\hub.json` (genellikle `C:\ProgramData\PortalTakip\hub.json`). Çalışma dizini ve oturum açan kullanıcı bunu değiştirmez. `hub:init` veya EXE `--prepare` 32 rastgele baytlık ilk kurulum anahtarı üretir; konsola/loga yazmaz. Anahtar, yalnızca `SYSTEM` ve Windows Administrators erişebilen `%ProgramData%\PortalTakip\setup-key.txt` dosyasına yazılır; `hub.json` içinde yalnızca SHA-256 hash'i bulunur. Yönetici olarak açılmış bir metin düzenleyiciyle bu dosyayı okuyup `http://127.0.0.1:8788` ilk kurulum ekranına girin. Başarılı kurulum anahtar dosyasını siler. Parola rastgele tuzlu `scrypt` hash'i olarak saklanır. Kurum kodu panelde yalnızca kurulumdan sonra veya yenilendiğinde görünür; loglara yazılmaz. `PORTALTAKIP_CONFIG` yalnızca geliştirme/test için açık yol geçersiz kılmasıdır; başlangıç görevi kalıcı yolu `--config-path` ile açıkça verir.

Eski sürümün proje içindeki `data/hub.json` dosyası varsa, yeni `hub:init` hedef henüz yokken bu dosyayı **kopyalar, kaynağı silmez**. Bekleyen ilk kurulum için daha önce paylaşılmış anahtarı otomatik yeniler. Kurulum betiği de kendi yanında bulunan `data/hub.json` için aynı geçişi yapar. Eski dosya başka klasördeyse yönetici PowerShell'inde `& '.\dist\PortalTakip Hub.exe' --prepare --migrate-from 'C:\eski\proje\data\hub.json'` kullanın; hedef dosya varsa komut üzerine yazmaz. Geçişten sonra eski kopyayı güvenli arşiv politikanıza göre ayrı ele alın; çalışma ayarı artık ProgramData'dadır.

Önceden paylaşılan **bekleyen ilk kurulum anahtarını**, yapılandırmayı silmeden yenileyin: çalışan Hub'ı durdurun (`Stop-ScheduledTask -TaskName 'PortalTakip Hub'` veya Node sürecini kapatın), yönetici PowerShell'inde `npm.cmd run hub:rotate-setup-key` ya da kurulu EXE için `& "$env:ProgramFiles\PortalTakip\PortalTakip Hub.exe" --rotate-setup-key` çalıştırın, sonra Hub'ı yeniden başlatın (`Start-ScheduledTask -TaskName 'PortalTakip Hub'` veya `npm.cmd run hub:start`). Yeni anahtarı korunmuş `setup-key.txt` dosyasından yerel olarak okuyup ilk kurulumu tamamlayın. Çalışan Hub durdurulmadan anahtar değiştirilirse bellekteki eski hash sürecin kapanmasına kadar geçerli kalabilir. Eski anahtarın disk hash'i artık geçersizdir; mevcut kurum/personel ayarları silinmez. Kurulum tamamlandıysa ilk kurulum anahtarı zaten geçersizdir; bu komut reddedilir.

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

Betik EXE'yi `%ProgramFiles%\PortalTakip` altına kopyalar; ayar dosyasını `%ProgramData%\PortalTakip\hub.json` altında oluşturur veya korur. İlk kurulum anahtarı konsola yazılmaz; korunmuş `setup-key.txt` dosyasından yerel olarak okunur. Betik, klasör ve ayar dosyasının ACL'sini yalnızca `SYSTEM` ve Administrators tam erişecek şekilde ayarlar. `SYSTEM` hesabıyla bilgisayar açılışında çalışan `PortalTakip Hub` adlı Windows Zamanlanmış Görevini kaydeder; görev argümanında kalıcı ayar yolu açıkça bulunur. Görev için süre sınırını kapatır ve hata sonrası üç yeniden başlatma dener. Yalnızca Private ağ profili + LocalSubnet için WebSocket portu güvenlik duvarı kuralı açar. Varsayılan portlar `8787` ve `8788`'dir; örneğin `-WsPort 9001 -AdminPort 9002` ile değiştirilebilir. Betiği yeniden çalıştırmak mevcut kurum ayarlarını korur ve görev/EXE/kuralı günceller.

Kurulum için Windows yönetici yetkisi gerekir; Görev Zamanlayıcı ve güvenlik duvarı kuralı normal kullanıcı tarafından oluşturulamaz. Kurulumdan sonra panel, **Hub bilgisayarında** normal kullanıcı oturumundan açılabilir; yönetici parolası gerekir. Ayar dosyası erişimi `SYSTEM` ve Windows Administrators ile sınırlandırılır. Üretilen EXE imzalanmamıştır; dağıtım ortamında kurumsal kod imzalama tercih edilebilir. Görevin çalışmasını Görev Zamanlayıcı'dan `PortalTakip Hub` adıyla ve panel adresini yerel tarayıcıdan kontrol edin.

Gerçek kurulumdan sonra yönetici PowerShell'inde `(Get-ScheduledTask -TaskName 'PortalTakip Hub').Principal.UserId` sonucunun `SYSTEM`, `(Get-ScheduledTask -TaskName 'PortalTakip Hub').Actions` içindeki `--config-path` değerinin `%ProgramData%\PortalTakip\hub.json` olmasını doğrulayın. `icacls.exe "$env:ProgramData\PortalTakip"` ve `icacls.exe "$env:ProgramData\PortalTakip\hub.json"` çıktısında yalnızca `SYSTEM` ile Administrators erişimi bulunmalı. Görevi `Start-ScheduledTask -TaskName 'PortalTakip Hub'` ile başlatıp `http://127.0.0.1:8788/api/session` adresini Hub bilgisayarından açın. Elle EXE denemesinde görevi durdurun, başka bir çalışma dizinine geçin ve kurulu EXE'yi mutlak yolla başlatın; panel aynı kalıcı ayarı görmelidir.

Bilgisayar uykuya veya hazırda beklemeye girerse Hub ağ hizmeti durur. Yönetici bilgisayarında Windows **Ayarlar → Sistem → Güç ve pil → Ekran, uyku ve hazırda bekleme zaman aşımları** bölümünden prize takılıyken uykuyu kapatın; ekranı kapatmak ayrı bir ayardır. Windows açılışı ve görev başladığında Hub yeni `hubId` üretir; kilit/kuyruk RAM'i boş başlar. Kurum adı, kod hash'i, parola hash'i ve personel kayıtları ayar dosyasında kalır.

`npm.cmd run hub:smoke-exe`, geçici ayar yolunda önce `hub:init` çalıştırır; ardından gerçek EXE'yi farklı çalışma dizininden, başlangıç görevi gibi açık `--config-path` ile başlatır. Panel/personel/kilit akışını, anahtarın loglanmamasını ve yeniden başlatmada kalıcı ayarların korunup RAM kilitlerinin boşalmasını doğrular. Bu test gerçek `%ProgramData%` ACL'si, `SYSTEM` görevi veya güvenlik duvarını değiştirmez; yönetici yetkili Windows kurulumunda ayrıca doğrulayın.

## Personel bağlantısı

Panelin kurulum alanı **Hub LAN IPv4 adresini**, **WebSocket portunu** ve **kurum kodunu** ayrı alanlarda gösterir ve ayrı ayrı kopyalar. Birden çok ağ kartı varsa doğru LAN adresini seçin; bulunmazsa `ipconfig` ile doğrulayıp elle yazın. Eklentide adres, port, kurum kodu ve kişiye özel erişim anahtarı birlikte gerekir. Kurum kodu Hub adresini kendisi bulmaz. IP değişirse tüm personelin adres ayarını güncelleyin; DHCP rezervasyonu adresi sabit tutabilir. Port değişirse görev, güvenlik duvarı kuralı ve eklenti ayarları birlikte güncellenmelidir. LAN portu HTTP yönetici paneli sunmaz.

Panelde personel için ayrı rastgele erişim anahtarı, her portal hesabı için rastgele ortak hesap kodu üretin. İkisi de yalnızca üretildiğinde gösterilir; personel anahtarı hash olarak saklanır. Aynı hesabı kullananlara aynı ortak hesap kodunu verin. Bu kod mükellef numarası veya portal şifresi olmamalı. Hesap kodlarının hangi hesaba ait olduğunu yönetici kurum içinde güvenli bir kayıtta tutmalıdır; Hub bu eşleştirmeyi saklamaz.

Kurum kodunu yenilemek için yönetici parolasını tekrar girin. Yenileme yeni 32 baytlık kod üretir, yalnızca hash'ini saklar ve mevcut WebSocket bağlantılarını `CODE_ROTATED` ile kapatır. Yeni kodu tüm personele güvenli biçimde dağıtın. Kayıp kod geri okunamaz; yeniden yenilenir. Kullanıcı atıldığında bağlantısı kapatılır, yeniden bağlanması engellenir; panelden yeniden kabul edildiğinde eski sıra/kilit yeri geri gelmez. Kilit düşürme mevcut sahibini çıkarır ve sıradakine devreder.

**Varsayılan kurulum güvenilen kurum LAN'ı içindir. Düz `ws://` trafiği şifreli değildir; kurum kodu ve personel anahtarı ağ üzerinde açık iletilir.** Güvenilmeyen ağda WSS sağlayan bir TLS katmanı gerekir. Uygulama resmî portallara giriş yapmaz, portal şifresi toplamaz veya sayfa verisi kazımaz.

## WebSocket protokolü (v1)

JSON metin mesajları kullanılır; ikili ve 8 KiB üzeri mesajlar reddedilir. Bilinmeyen alanlar reddedilir. Kullanıcı kimliği, ad, kurum ve soket kimliği istemci işlem mesajlarından alınmaz; doğrulanmış personel anahtarı ve bağlantıdan atanır. Bağlantı açıldıktan sonraki 10 saniye içinde `HELLO` gerekir.

| Yön | Mesaj | Alanlar |
| --- | --- | --- |
| İstemci → Hub | `HELLO` | `organizationCode`, `staffToken`, isteğe bağlı önceki `lastHubId` (UUID) |
| Hub → istemci | `HELLO` | `status: "ok"`, `hubId`, `connectionId`, `userId`, `displayName`, `stateReset` |
| İstemci → Hub | `ACQUIRE`, `RELEASE`, `CANCEL`, `CONFIRM` | `requestId` (UUID), `portal` (`GİB`/`SGK`), `accountCode` (16–128 URL güvenli karakter) |
| Hub → istemci | aynı işlem türü | `requestId`, `status`, varsa `position` |
| İstemci → Hub | `STATE` | İsteğe bağlı `requestId`; güncel durum isteği |
| Hub → istemci | `STATE` | `hubId`, `serverTime` (Unix ms), `organizationId`, `reason`, `reset`, `locks` |
| Hub → istemci | `ERROR` | `code`, ilgiliyse `requestId` |

```json
{"type":"ACQUIRE","requestId":"1d19684c-9afb-4ad9-a886-710ae65e2dd7","portal":"GİB","accountCode":"aBcD1234efGH5678"}
```

`requestId` kurum içinde her **yeni işlem** için benzersiz olmalıdır. Yanıtı belirsiz kalmış **aynı işlem** aynı Hub'a yeniden gönderilecekse aynı ID ve aynı içerik kullanılır; farklı içerik `REQUEST_ID_CONFLICT` verir. Başarılı işlem geçmişi RAM'de en çok 24 saat/100.000 kayıt tutulur. Hub yeniden başladıysa eski işlem tekrar gönderilmez; yeni snapshot alınır. Bağlantı kopukken eklenti kilidi alınmış göstermemeli; yalnızca güncel Hub `STATE` verisine güvenmelidir.

Her başlangıçta `hubId` değişir. İstemci eski `hubId`'yi `lastHubId` olarak gönderir; farklıysa `HELLO.stateReset` ve ilk `STATE.reset` `true` olur. Aynı Hub'a yeniden bağlanınca güncel snapshot gönderilir. Aynı personel anahtarıyla yeni `HELLO` önceki soketi kapatır. Çekirdek kopan kullanıcının yerini 30 saniye tutar; yeni bağlantıdan yeni `ACQUIRE` gelirse yer korunur, süresi dolarsa temizlenir. Sunucu zamanlayıcı tek yetkilidir. Atılma yasağı ve personel kayıtları yeniden başlatmada kalır; kilitler ve kuyruklar kalmaz.

Yönetici oturumu paroladan ayrıdır; `HttpOnly`, `SameSite=Strict` çerezi kullanır. Mutasyonlar aynı kaynak `Origin` ve oturuma özel CSRF başlığı ister. Oturum 30 dakika hareketsizlik veya 8 saat toplam sürede biter. HTTP gövdesi 16 KiB ile sınırlandırılır; WebSocket yükseltme, `HELLO` ve mesajlarda oran sınırı vardır. Personel kurum kodu yönetici yetkisi vermez.
