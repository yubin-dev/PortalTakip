# PortalTakip

Muhasebe ofisinde personelin aynı GİB veya SGK hesabını eşzamanlı kullanıp birbirinin oturumunu düşürmesini önlemek için planlanan yerel ağ uygulaması. Resmî portallara giriş yapmaz, şifre toplamaz ve sayfa verisi kazımaz.

## Doğrulama durumu

Aynı bilgisayarda iki Chrome profiliyle kilit, FIFO devir ve bildirim doğrulandı; üç fiziksel cihaz ve Windows otomatik başlangıç testi henüz yapılmadı.

## Mimari

- Yönetici bilgisayarında Windows açılışında başlayabilen **PortalTakip Hub.exe** ve yalnızca yerel bilgisayara açık yönetici paneli bu repodadır.
- Hub, personel Chrome eklentileriyle kurumun yerel ağında WebSocket üzerinden konuşur. Bulut sunucusu ve harici veritabanı kullanılmaz.
- Personel yönetici tarafından oluşturulan 10 dakikalık tek kullanımlık davet bağlantısını eklentiye yapıştırabilir. Eski elle bağlantıda **Hub LAN adresi/portu ile kurum kodu** birlikte girilir; kurum kodu tek başına bilgisayar adresini bulmaz.
- Kilit, kuyruk ve zaman aşımının tek yetkilisi Hub olacak. Eklentinin popup, content script ve background parçaları kendi aralarında Chrome mesajlarını kullanacak.
- Kilit anahtarı **kurum + portal + ortak hesap kodu**. Ayrı mükellef hesapları birbirini beklemez.
- Hub yeniden başladığında RAM'deki aktif kilit ve kuyruklar sıfırlanacak. Hub bağlantısı yokken eklenti kilit alınmış gibi göstermeyecek.

## Dizinler ve geliştirme sırası

`src/core/` kilit ve kuyruk kurallarını, `src/hub/` WebSocket sunucusunu, `src/hub/admin/` yerel yönetici panelini barındırır. `src/background/` WebSocket bağlantısını ve sekme durumunu, `src/ui/` popup'ı, `src/content/` portal kapsülünü barındırır. `tests/` testler, `scripts/` kurulum araçları içindir. Çekirdek API [src/core/README.md](src/core/README.md), Hub kurulumu ve mesaj protokolü [src/hub/README.md](src/hub/README.md), kapsül akışı [src/content/README.md](src/content/README.md) içindedir.

1. **Hazırlık:** Bu iskelet ve mimari kararları.
2. **Faz 1.1:** Hub'ın kilit, kuyruk ve zaman aşımı motoru (`src/core/semaphore-state.js`).
3. **Faz 2 Hub:** LAN WebSocket sunucusu, yerel yönetici paneli, Windows EXE ve açılış görevi.
4. **Personel eklentisi:** Manifest V3 popup'ı, WebSocket'i taşıyan background worker ve resmî GİB/SGK sekmelerindeki hesap seçmeli kapsül hazırdır.

## Yönetilen ortak hesaplar

Yönetici panelinde her GİB/SGK hesabı için kişisel bilgi içermeyen bir görünen ad ve yetkili personeller seçilir. Hub, hesap için değişmeyen rastgele ortak kod üretir. Atanan hesaplar personelin kapsül listesine bağlantıyı yenilemeden gelir; personel hesabı seçip kilit/sıra düğmelerini kullanır. Atanmamış hesapla işlem Hub'da `ACCOUNT_FORBIDDEN` olarak reddedilir. Portal şifresi, T.C. kimlik/vergi numarası veya başka hassas mükellef bilgisi ad ya da kod olarak kullanılmamalıdır. Erişim kaldırılırsa ilgili kişinin o hesaptaki kilidi veya sıra yeri hemen silinir ve kilit FIFO sıradakine geçer.

Eski 1.0 ayarları geçiş modunda açılır: yerel hesap listesi ve kodlar korunur. Yönetici **Eski yerel kodları eşleştir** alanına aynı portal ve kodu aynen girip kullanıcıları atar; kod veya etkin sıra yeri taşınmaz. Tüm eski hesapları eşleştirdikten sonra **Eski elle kullanımı kapat** seçilir. Eşleşmemiş etkin kilit/kuyruk varsa Hub bu adımı reddeder. Yeni kurulumlarda elle kullanım baştan kapalıdır.

## Personel daveti

Yönetici panelinde personel kaydı için **Davet oluştur** seçin, doğru Hub LAN adresini seçin ve bağlantıyı yalnızca ilgili personele iletin. Bağlantı 10 dakika geçerli, tek kullanımlıktır; kurum kodu veya kalıcı personel anahtarı içermez. Personel Chrome eklentisinde **Davet bağlantısını yapıştır** alanını kullanır. Bağlantının açtığı yerel sayfa eklentiye otomatik veri aktarmaz. “Bu cihazı hatırla” seçilirse Hub'ın verdiği iptal edilebilir cihaz anahtarı Chrome profilinde kalıcı saklanır; seçilmezse yalnızca oturum belleğinde kalır. Yönetici panelinden cihaz erişimi iptal edilebilir. Mevcut elle bağlantı formu çalışmaya devam eder.

## Komutlar

**Hub bilgisayarını kullanan yönetici için:** Hazır `PortalTakip Hub.exe` dosyasını çift tıklayın. İlk çalıştırmada veya güncelleme/onarım gerektiğinde Windows yönetici iznini onaylayın. Uygulama kendini `%ProgramFiles%\PortalTakip` altına kurar; kalıcı ayarı `%ProgramData%\PortalTakip\hub.json` altında korur, açılış görevini ve yalnızca Private/LocalSubnet için personel güvenlik duvarı kuralını ayarlar. Sonra tarayıcıda yalnızca `http://127.0.0.1:8788` panelini açar. İlk kurulum kodu uygulamanın yönetici izinli penceresinde görünür; dosya aramak veya komut çalıştırmak gerekmez. Mevcut kurum/personel/hesap/parola ayarları yeniden kurulumda silinmez.

**Geliştirici komutları:** Node ile çalıştırmak için `npm.cmd ci`, `npm.cmd run hub:init`, `npm.cmd run hub:start`; testler için `npm.cmd test`; Windows EXE üretimi için `npm.cmd run hub:build-exe` ve `npm.cmd run hub:smoke-exe`. CLI akışı ve özel portlar [Hub README'sinde](src/hub/README.md) açıklanır.

Personel eklentisini `npm.cmd run extension:build` ile `dist/extension` altına hazırlayın; popup alanları ve gizli veri saklama kararı [popup README'sinde](src/ui/README.md), portal kapsülü ve hesap seçimi [content README'sinde](src/content/README.md), MV3 Hub istemcisinin izin ve yeniden bağlanma kuralları [background README'sinde](src/background/README.md) bulunur.

## Üç bilgisayarlı Windows/LAN kurulumu

Topoloji: **bir yönetici Windows bilgisayarı (Hub)** ve **iki ayrı personel Windows bilgisayarı (Chrome)** aynı güvenilen özel LAN'da. İnternet, Hub bağlantısı için gerekli değildir; GİB/SGK web sayfalarını yeniden yüklemek için gereklidir. Hub EXE'sini oluşturacak bilgisayarda Node.js **26.8.2 veya üstü 26.x** ve npm gerekir; kurulu Hub bilgisayarında Node gerekmez. İlk kurulum için Windows yönetici yetkisi gerekir.

1. Paketi hazırlayan geliştirici kaynak klasörde Windows PowerShell ile derleyip yerel testleri çalıştırır; Hub yöneticisi bu komutları kullanmaz:

   ```powershell
   npm.cmd ci
   npm.cmd test
   npm.cmd run hub:build-exe
   npm.cmd run hub:smoke-exe
   npm.cmd run extension:build
   Compress-Archive -Path .\dist\extension\* -DestinationPath .\PortalTakip-extension.zip -Force
   ```

2. **Hub bilgisayarına** yalnızca `dist/PortalTakip Hub.exe` dosyasını taşıyın ve çift tıklayın. Windows yönetici iznini onaylayın. Uygulama `%ProgramFiles%\PortalTakip` altına kurulur, `%ProgramData%\PortalTakip\hub.json` dosyasını oluşturur veya korur, SYSTEM açılış görevini ve Private/LocalSubnet TCP 8787 kuralını ayarlar. Aynı EXE'yi tekrar açmak çalışan paneli gösterir; daha yeni EXE'yi açmak güncelleme/onarım yapar. Port doluysa PID ile anlaşılır hata gösterir; ilgili programı kapatıp EXE'yi yeniden açın. Kurulum başarısızsa mevcut ayar dosyası silinmez.

3. Tarayıcıdaki ilk kurulum ekranına uygulamanın gösterdiği tek kullanımlık kodu, kurum adını ve yeni yönetici parolasını girin. Kod URL'ye veya loga yazılmaz; başarılı kurulumda korunmuş kod dosyası silinir. Panelde iki personel kaydı ve her ortak GİB/SGK hesabı için bir yönetilen hesap oluşturup kullanacak personelleri seçin. Her personel için **Davet oluştur** seçip doğru Hub LAN adresiyle oluşan bağlantıyı yalnızca o kişiye iletin. Eski elle bağlantı yolunu kullanacak personele **Hub LAN IP'si**, **8787 portu**, **kurum kodu** ve kişinin **erişim anahtarı** ayrı bilgiler olarak verilir. Hesap görünen adında veya kodunda portal şifresi ya da mükellef bilgisi kullanmayın.

4. `PortalTakip-extension.zip` dosyasını USB veya kurum içi dosya paylaşımıyla **her iki personel bilgisayarına** taşıyın. Her bilgisayarda PowerShell ile açın:

   ```powershell
   Expand-Archive -LiteralPath .\PortalTakip-extension.zip -DestinationPath "$env:LOCALAPPDATA\PortalTakip\extension" -Force
   ```

   Chrome'da `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş öğe yükle** ile açılan `extension` klasörünü seçin. Popup'ta yönetici davet bağlantısını **Davet bağlantısını yapıştır** alanına girin. Kişisel ve paylaşılmayan profilde “Bu cihazı hatırla” seçilirse cihaz anahtarı Chrome profilinde kalır. Eski yöntem için elle bağlantı bölümündeki alanları kullanın. GİB/SGK sekmesindeki kapsülde atanan hesabı listeden seçin; kod seçilmeden kilit isteği gönderilmez. Chrome'un [paketlenmemiş eklenti yükleme adımları](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) bu işlemi tarif eder.

5. Her personel bilgisayarında bağlantıyı sınayın; yönetici paneli LAN'dan açılmamalıdır:

   ```powershell
   $HubIp = '192.168.1.10'  # Panelde gösterilen gerçek LAN IPv4 ile değiştirin
   Test-NetConnection -ComputerName $HubIp -Port 8787
   Test-NetConnection -ComputerName $HubIp -Port 8788
   ```

   İlk komutta `TcpTestSucceeded: True`, ikincide `False` beklenir ([Microsoft `Test-NetConnection`](https://learn.microsoft.com/en-us/powershell/module/nettcpip/test-netconnection)). Hub'da `http://127.0.0.1:8788/api/session` açılmalıdır. İlk komut başarısızsa IP/portu, Private ağ profilini, güvenlik duvarı kuralını ve Hub görevinin çalışmasını kontrol edin. IP değişirse panel/`ipconfig` ile yeni adresi bulun ve **iki popup'taki Hub adresini** güncelleyin; kurum kodu adres bulma mekanizması değildir. Port değişirse `install-windows.ps1 -WsPort <port>` ile görev ve güvenlik duvarını güncelleyip popup portlarını da değiştirin.

6. Planlı kabul testini [üç cihaz test rehberine](docs/three-device-validation.md) göre yapın. Hub bilgisayarının prize takılıyken uykuya geçmesini kapatın; ekranın kapanması ayrı ayardır. Düz `ws://` şifreli değildir, bu kurulum yalnızca güvenilen kurum LAN'ı içindir.
