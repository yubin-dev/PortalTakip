# PortalTakip

Muhasebe ofisinde personelin aynı GİB veya SGK hesabını eşzamanlı kullanıp birbirinin oturumunu düşürmesini önlemek için planlanan yerel ağ uygulaması. Resmî portallara giriş yapmaz, şifre toplamaz ve sayfa verisi kazımaz.

## Doğrulama durumu

Aynı bilgisayarda iki Chrome profiliyle kilit, FIFO devir ve bildirim doğrulandı; üç fiziksel cihaz ve Windows otomatik başlangıç testi henüz yapılmadı.

## Mimari

- Yönetici bilgisayarında Windows açılışında başlayabilen **PortalTakip Hub.exe** ve yalnızca yerel bilgisayara açık yönetici paneli bu repodadır.
- Hub, personel Chrome eklentileriyle kurumun yerel ağında WebSocket üzerinden konuşur. Bulut sunucusu ve harici veritabanı kullanılmaz.
- Personel, bağlantı için **Hub LAN adresi/portu ile kurum kodunu birlikte** girecek. Kurum kodu tek başına bilgisayar adresini bulmaz.
- Kilit, kuyruk ve zaman aşımının tek yetkilisi Hub olacak. Eklentinin popup, content script ve background parçaları kendi aralarında Chrome mesajlarını kullanacak.
- Kilit anahtarı **kurum + portal + ortak hesap kodu**. Ayrı mükellef hesapları birbirini beklemez.
- Hub yeniden başladığında RAM'deki aktif kilit ve kuyruklar sıfırlanacak. Hub bağlantısı yokken eklenti kilit alınmış gibi göstermeyecek.

## Dizinler ve geliştirme sırası

`src/core/` kilit ve kuyruk kurallarını, `src/hub/` WebSocket sunucusunu, `src/hub/admin/` yerel yönetici panelini barındırır. `src/background/` WebSocket bağlantısını ve sekme durumunu, `src/ui/` popup'ı, `src/content/` portal kapsülünü barındırır. `tests/` testler, `scripts/` kurulum araçları içindir. Çekirdek API [src/core/README.md](src/core/README.md), Hub kurulumu ve mesaj protokolü [src/hub/README.md](src/hub/README.md), kapsül akışı [src/content/README.md](src/content/README.md) içindedir.

1. **Hazırlık:** Bu iskelet ve mimari kararları.
2. **Faz 1.1:** Hub'ın kilit, kuyruk ve zaman aşımı motoru (`src/core/semaphore-state.js`).
3. **Faz 2 Hub:** LAN WebSocket sunucusu, yerel yönetici paneli, Windows EXE ve açılış görevi.
4. **Personel eklentisi:** Manifest V3 popup'ı, WebSocket'i taşıyan background worker ve resmî GİB/SGK sekmelerindeki hesap seçmeli kapsül hazırdır.

## Açık karar: ortak hesap kodu

Kod, aynı portalda aynı mükellef hesabını kullanan herkeste aynı; farklı hesaplarda ayrı olmalı. Yönetici paneli her hesap için rastgele, anlamsız kod üretir; yönetici kodu yalnızca o hesabı kullanan personele güvenli biçimde paylaşır. Portal şifresi, T.C. kimlik/vergi numarası veya başka hassas mükellef bilgisi kod olarak kullanılamaz. Kapsül kod ekleme/seçme ve kod seçilmeden kilit isteğini engelleme akışını sağlar. **Açık iş:** Kodun hangi hesapla eşleştiğini kurum içinde kaydetmek ve yanlış kod seçimini önlemek yöneticinin elle yürüttüğü süreçtir.

## Komutlar

Windows'ta Node geliştirme çalıştırması için yönetici PowerShell'inde `npm.cmd ci`, `npm.cmd run hub:init`, `npm.cmd run hub:start`; testler için `npm.cmd test` kullanın. Node ve EXE aynı `%ProgramData%\PortalTakip\hub.json` dosyasını kullanır. Eski `data/hub.json` varsa `hub:init` dosyayı silmeden kopyalar. Paylaşılmış bekleyen ilk kurulum anahtarını, ayarları silmeden `npm.cmd run hub:rotate-setup-key` ile yenileyin. Windows üzerinde Node.js 26+ ile `npm.cmd run hub:build-exe` ve `npm.cmd run hub:smoke-exe` EXE üretir ve geçici yolda kurulum denemesi yapar. Yönetici paneli varsayılan olarak `http://127.0.0.1:8788` adresindedir; personel WebSocket portu `8787`'dir. Gerçek Windows kurulum betiği, izinler, anahtar dosyasını okuma, güç ayarı, IP değişikliği ve düz `ws://` uyarısı [Hub README'sinde](src/hub/README.md) açıklanır.

Personel eklentisini `npm.cmd run extension:build` ile `dist/extension` altına hazırlayın; popup alanları ve gizli veri saklama kararı [popup README'sinde](src/ui/README.md), portal kapsülü ve hesap seçimi [content README'sinde](src/content/README.md), MV3 Hub istemcisinin izin ve yeniden bağlanma kuralları [background README'sinde](src/background/README.md) bulunur.

## Üç bilgisayarlı Windows/LAN kurulumu

Topoloji: **bir yönetici Windows bilgisayarı (Hub)** ve **iki ayrı personel Windows bilgisayarı (Chrome)** aynı güvenilen özel LAN'da. İnternet, Hub bağlantısı için gerekli değildir; GİB/SGK web sayfalarını yeniden yüklemek için gereklidir. Hub EXE'sini oluşturacak bilgisayarda Node.js **26.8.2 veya üstü 26.x** ve npm gerekir; kurulu Hub bilgisayarında Node gerekmez. İlk kurulum için Windows yönetici yetkisi gerekir.

1. Kaynak klasörde Windows PowerShell ile derleyin ve yerel testleri çalıştırın:

   ```powershell
   npm.cmd ci
   npm.cmd test
   npm.cmd run hub:build-exe
   npm.cmd run hub:smoke-exe
   npm.cmd run extension:build
   Compress-Archive -Path .\dist\extension\* -DestinationPath .\PortalTakip-extension.zip -Force
   ```

2. Kaynak klasörü ve `dist/PortalTakip Hub.exe` dosyasını **Hub bilgisayarına** alın. Orada **yönetici olarak açılmış** PowerShell'de aşağıdaki komutu çalıştırın. Betik EXE'yi `%ProgramFiles%\PortalTakip` altına, kalıcı yapılandırmayı `%ProgramData%\PortalTakip\hub.json` altına yerleştirir; açılış görevi ve yalnızca Private/LocalSubnet için TCP 8787 güvenlik duvarı kuralı oluşturur:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
   Get-ScheduledTask -TaskName 'PortalTakip Hub' | Select-Object TaskName,State
   Get-NetFirewallRule -Name 'PortalTakip-Hub-WS' | Get-NetFirewallPortFilter
   Get-NetConnectionProfile
   ipconfig
   ```

   Betik görevi başlatır. Daha sonra gerekirse `Start-ScheduledTask -TaskName 'PortalTakip Hub'` ile EXE'yi başlatın. Elle hata ayıklamada önce görevi durdurun; ayar dosyası ACL'si nedeniyle yükseltilmiş PowerShell'de `& "$env:ProgramFiles\PortalTakip\PortalTakip Hub.exe" --ws-port 8787 --admin-port 8788` çalıştırın. Görev ve elle başlatılan EXE aynı portlarda birlikte çalışamaz.

3. Yalnızca **Hub bilgisayarında** `http://127.0.0.1:8788` adresini açın. Yönetici hesabıyla `%ProgramData%\PortalTakip\setup-key.txt` dosyasını yerel olarak açıp ilk kurulum anahtarını, kurum adını ve yönetici parolasını girin. Anahtar konsol/log çıktısına yazılmaz ve başarılı kurulumda dosya silinir. Panelde iki ayrı personel hesabı/erişim anahtarı ve her ortak GİB/SGK hesabı için ayrı rastgele hesap kodu üretin. **Hub LAN IP'si**, **8787 portu**, **kurum kodu** ve her kişinin **kendi erişim anahtarı** ayrı bilgiler olarak ilgili personele verilir; aynı portal hesabını kullananlara aynı ortak hesap kodunu verin. Kodları portal şifresi veya mükellef numarasıyla karıştırmayın.

4. `PortalTakip-extension.zip` dosyasını USB veya kurum içi dosya paylaşımıyla **her iki personel bilgisayarına** taşıyın. Her bilgisayarda PowerShell ile açın:

   ```powershell
   Expand-Archive -LiteralPath .\PortalTakip-extension.zip -DestinationPath "$env:LOCALAPPDATA\PortalTakip\extension" -Force
   ```

   Chrome'da `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş öğe yükle** ile açılan `extension` klasörünü seçin. Popup'a ad soyad, gösterimlik kurum adı, Hub'ın **LAN IP'si**, **8787**, kurum kodu ve kişisel erişim anahtarını ayrı alanlara girip bağlanın. GİB/SGK sekmesindeki kapsülde yöneticinin verdiği ortak hesap kodunu ekleyip seçin; kod seçilmeden kilit isteği gönderilmez. Chrome'un [paketlenmemiş eklenti yükleme adımları](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) bu işlemi tarif eder.

5. Her personel bilgisayarında bağlantıyı sınayın; yönetici paneli LAN'dan açılmamalıdır:

   ```powershell
   $HubIp = '192.168.1.10'  # Panelde gösterilen gerçek LAN IPv4 ile değiştirin
   Test-NetConnection -ComputerName $HubIp -Port 8787
   Test-NetConnection -ComputerName $HubIp -Port 8788
   ```

   İlk komutta `TcpTestSucceeded: True`, ikincide `False` beklenir ([Microsoft `Test-NetConnection`](https://learn.microsoft.com/en-us/powershell/module/nettcpip/test-netconnection)). Hub'da `http://127.0.0.1:8788/api/session` açılmalıdır. İlk komut başarısızsa IP/portu, Private ağ profilini, güvenlik duvarı kuralını ve Hub görevinin çalışmasını kontrol edin. IP değişirse panel/`ipconfig` ile yeni adresi bulun ve **iki popup'taki Hub adresini** güncelleyin; kurum kodu adres bulma mekanizması değildir. Port değişirse `install-windows.ps1 -WsPort <port>` ile görev ve güvenlik duvarını güncelleyip popup portlarını da değiştirin.

6. Planlı kabul testini [üç cihaz test rehberine](docs/three-device-validation.md) göre yapın. Hub bilgisayarının prize takılıyken uykuya geçmesini kapatın; ekranın kapanması ayrı ayardır. Düz `ws://` şifreli değildir, bu kurulum yalnızca güvenilen kurum LAN'ı içindir.
