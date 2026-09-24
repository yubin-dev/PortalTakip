# Üç bilgisayarlı kurulum kabul testi

**Roller:** H = Windows Hub/yönetici, P1 = personel bilgisayarı A, P2 = personel bilgisayarı B. Her cihaz ayrı fiziksel bilgisayar ve aynı özel LAN üzerinde olmalıdır. Önce [ana README'deki Windows ve Chrome kurulumunu](../README.md#üç-bilgisayarlı-windowslan-kurulumu) bitirin. Test için gerçek mükellef bilgisi veya portal şifresi kullanmayın. Yönetici test amaçlı iki personel anahtarı, bir ortak GİB kodu, bir ortak SGK kodu ve bir başka GİB hesabı için ikinci kod üretsin. Kodları hangi hesapla eşlediğini kurum içinde güvenli kaydetsin.

## Otomatik doğrulama

Windows geliştirme bilgisayarında `npm.cmd test` tüm testleri, `node --test tests/three-device-e2e.test.js` aşağıdaki akışı çalıştırır. E2E testi gerçek Hub HTTP/WebSocket sunucusunu `0.0.0.0` üzerinde açar, iki ayrı personel soketini yerel LAN IPv4 üzerinden bağlar ve yönetici HTTP oturumunu `127.0.0.1` üzerinden açar. Makinede özel LAN IPv4 yoksa personel bağlantısı için loopback kullanır ve LAN panel erişim reddini fiziksel kabul testine bırakır. Süreler Hub çekirdeğine enjekte edilen sahte saatle ilerler; işletim sistemi saati veya sekme sayacı değiştirilmez. İnternete istek atmaz.

Bu test ilk kurulum, yanlış/doğru kurum kodu, yetkisiz yönetici isteği, panelin LAN IP'den erişilememesi, GİB/SGK ve farklı hesap bağımsızlığı, iki personelin birbirinden bağımsız FIFO devri, tam 15 dakika + 60 saniye sınırları, 59.999. saniyede teyit, süresi dolan kilidin devri, force unlock, kick/readmit, bağlantı toleransı ve Hub yeniden başlatılınca yeni `hubId` ile boş snapshot'ı denetler. `tests/extension-popup.test.js`, Hub kapanınca personel kapsülü görünümünün `Sizde` durumundan `Yeniden bağlanıyor` durumuna geçtiğini ayrıca denetler. `npm.cmd run hub:smoke-exe` gerçek EXE'yi geçici yapılandırmayla başlatıp yeniden başlatır; kalıcı personel kaydı ve boş RAM kilidi doğrulanır.

## Fiziksel kabul adımları

Sonuçları tarih/saat, H/P1/P2 bilgisayar adı, Hub LAN IPv4, port, Chrome sürümü ve ekran görüntüsüyle kaydedin. **Kurum kodu, personel anahtarı ve hesap kodlarını ekran görüntülerinde ve test raporunda gizleyin.** Her satırı H/P1/P2 üzerinde gerçek cihazla işaretleyin.

| No | Yapılacak işlem | Beklenen sonuç |
| --- | --- | --- |
| 1 | H'de kurulum betiğini çalıştırın; ilk kurulum ekranını `http://127.0.0.1:8788` üzerinden tamamlayın. | Kurum/parola kaydolur; kurum kodu bir kez gösterilir; personel WebSocket portu ve yönetici paneli açılır. |
| 2 | H'de `Get-ScheduledTask -TaskName 'PortalTakip Hub'` ve `Get-ScheduledTaskInfo -TaskName 'PortalTakip Hub'` çalıştırın. Planlı bakımda H'yi yeniden başlatıp tekrar bakın. | Görev Windows açılışında otomatik `Running` olur; panel yerel bilgisayardan erişilir. Kurum ve personel kayıtları durur, kilit/kuyruk boştur. |
| 3 | H'de `http://127.0.0.1:8788/api/session`; P1/P2'de `Test-NetConnection -ComputerName <H-LAN-IP> -Port 8788` deneyin. | H yerel oturum uç noktasını açar; P1/P2 yönetici portuna bağlanamaz. Personel kurum koduyla yönetici işlemi yapamaz. |
| 4 | P1/P2'de `Test-NetConnection -ComputerName <H-LAN-IP> -Port 8787` ve popup bağlantısını deneyin. Önce yanlış, sonra doğru kurum kodunu girin. | TCP 8787 açık; yanlış kod reddedilir; doğru **IP + port + kurum kodu + kişisel anahtar** ile bağlanır. Kod IP adresi bulmaz. |
| 5 | Aynı ortak GİB kodunu P1 ve P2 kapsüllerinde seçin. P1 kilidi alsın, P2 istesin. P2 ayrıca başka GİB kodu için kilit istesin. | İlk GİB hesabı P1'de `Sizde`, P2'de `Sırada: 1`; ikinci GİB hesabı bağımsız `Sizde` olabilir. İlk hesap kodu seçilmeden `ACQUIRE` gönderilemez. |
| 6 | Ortak SGK kodunda P2 kilidi alsın, P1 sıraya girsin. P1 GİB kilidini bıraksın; P2 SGK kilidini bıraksın. | SGK sırası GİB'den bağımsızdır. GİB P2'ye, SGK P1'e geçer; sıra alan hesap dışında değişmez. |
| 7 | Kontrollü testte kilit sahibini 15 dakika aktif bırakın, sonra gelen modalı izleyin. Bir turda 60 saniye dolmadan onaylayın; başka turda onaylamayın. | Teyit penceresi 15. dakikada açılır; zamanında onay kilidi korur; 60 saniyede onay yoksa Hub sıradakine verir. Sekme kapalı olsa da Hub devreder. |
| 8 | H panelinden sıradaki varken **Kilidi düşür**, sonra kilit sahibine **Kullanıcıyı at** uygulayın. Atılan kişi eski/yeni soketle tekrar bağlanmayı denesin; panelden yeniden kabul edin. | Force unlock sıradakine verir; kick tüm kilit/sıra kayıtlarını kaldırır ve bağlantıyı kapatır; yeniden kabul eski sıra yerini vermez. |
| 9 | P1 kilit sahibi, P2 sıradayken P1'in LAN bağlantısını kesin ve 30 saniyeden önce geri getirin; P1'in yeni snapshot ve kilit isteğini doğrulayın. Tekrar kesin ve 30 saniyeyi geçirin. | Kopar kopmaz P1 `Sizde` göstermez. Süre içinde aynı kimlikle yeniden bağlanıp yerini geri alabilir; 30 saniye sonunda Hub P2'ye devreder. |
| 10 | P1 kilit sahibiyken H görevini planlı testte durdurun, sonra başlatın. Ayrı turda H bilgisayarını yeniden başlatın. | H kapalıyken **iki kapsül de `Sizde` göstermez**; `Kopuk`/`Yeniden bağlanıyor` görünür. Yeniden açılışta yeni `hubId` ve boş kilit/kuyruk snapshot'ı yayınlanır. Kayıtlı kurum/personel yapılandırması korunur. |
| 11 | Bakım penceresinde H güvenlik duvarındaki `PortalTakip-Hub-WS` kuralını geçici kapatın; P1/P2'de yeni bağlantı/`Test-NetConnection` deneyin, sonra kuralı hemen açın. Mevcut TCP oturumu açık kalırsa personel bağlantısını kesip yeniden deneyin. | Kural kapalıyken **yeni** 8787 bağlantısı başarısız ve kopan kapsül sahiplik iddiası göstermez; kural açılıp yeniden bağlanınca yeni snapshot belirleyicidir. |
| 12 | BT gözetiminde H LAN IPv4 adresini/DHCP rezervasyonunu değiştirin; P1/P2 popup'taki adresleri yeni IP'ye güncelleyin. | Eski IP bağlantısı kesilir; yeni IP + aynı port + geçerli kodla yeniden bağlanır. Yeni IP iki personelde ayrı ayrı güncellenir. |
| 13 | WAN/internet bağlantısını kesin, **yerel LAN'ı ve H'yi açık bırakın**. P1/P2 popup bağlantısını ve açık portal sekmelerindeki kapsülü izleyin. | Hub, yönetici paneli, kilit ve FIFO yerel ağda çalışır. Resmî portal sayfaları internet olmadan yeniden yüklenemeyebilir; bunun için sekmeleri WAN kesilmeden açın. |

**Bakım komutları (H üzerinde yönetici PowerShell):**

```powershell
Get-ScheduledTask -TaskName 'PortalTakip Hub' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName 'PortalTakip Hub'
Get-NetFirewallRule -Name 'PortalTakip-Hub-WS' | Get-NetFirewallPortFilter
Stop-ScheduledTask -TaskName 'PortalTakip Hub'   # yalnızca planlı testte
Start-ScheduledTask -TaskName 'PortalTakip Hub'
Disable-NetFirewallRule -Name 'PortalTakip-Hub-WS' # yalnızca planlı testte
Enable-NetFirewallRule -Name 'PortalTakip-Hub-WS'  # testten hemen sonra
```

Güç ayarını Windows **Ayarlar → Sistem → Güç ve pil** bölümünden doğrulayın. H uykuya/hibernasyona girerse ağ servisi durur; prize takılıyken uyku kapatılmalıdır. Gerekirse BT, etkin güç planında [`powercfg /change standby-timeout-ac 0`](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options) komutunu kullanabilir. Windows görevi, güvenlik duvarı, IP değişimi, gerçek iki Chrome kurulumu ve fiziksel PC yeniden başlatması otomatik test tarafından değiştirilmiyor; üç cihazlı kabul sırasında ayrıca imzalanmalıdır.

## Bu çalışma alanında alınan sonuç (2026-09-23)

| Komut | Sonuç |
| --- | --- |
| `npm.cmd test` | **23 geçti, 0 başarısız**. E2E Hub testi gerçek HTTP/WebSocket üzerinden bu Windows makinesinin özel LAN IPv4 adresini kullandı; P1/P2 ayrı soketlerdi, ayrı fiziksel PC değildi. |
| `npm.cmd run extension:build` | `dist/extension` üretildi. |
| `npm.cmd run hub:build-exe` | `dist/PortalTakip Hub.exe` üretildi. |
| `npm.cmd run hub:smoke-exe` | `EXE temiz kurulum testi geçti: ilk kurulum, gömülü panel, hash, kilit ve yeniden başlatma.` |
| `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -WhatIf` | `C:\Program Files\PortalTakip\PortalTakip Hub.exe` hedefi için planlanan kurulum gösterildi; gerçek Windows görevi/güvenlik duvarı değiştirilmedi. |

**Fiziksel kabul bekliyor:** Bu çalışma ortamında iki ayrı personel bilgisayarı, kurulu Chrome eklentilerinin canlı portal sekmeleri ve yönetici bilgisayarını yeniden başlatma yetkisi sağlanmadı. Bu nedenle tablodaki Windows açılış görevi, iki cihazdan gerçek LAN erişimi, gerçek güvenlik duvarı/IP değişimi, WAN kesintisi ve Chrome kapsülünün görsel davranışı henüz fiziksel olarak doğrulanmadı. İnternetsiz senaryo otomatik testte yalnızca yerel HTTP/WebSocket kullanılarak kapsandı; gerçek resmî portal sayfası internet olmadan yeniden yüklenemez.
