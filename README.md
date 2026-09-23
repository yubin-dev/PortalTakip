# PortalTakip

Muhasebe ofisinde personelin aynı GİB veya SGK hesabını eşzamanlı kullanıp birbirinin oturumunu düşürmesini önlemek için planlanan yerel ağ uygulaması. Resmî portallara giriş yapmaz, şifre toplamaz ve sayfa verisi kazımaz.

## Mimari

- Yönetici bilgisayarında Windows açılışında başlayacak **PortalTakip Hub.exe**, yönetici panelini yalnızca aynı bilgisayara açacak.
- Hub, personel Chrome eklentileriyle kurumun yerel ağında WebSocket üzerinden konuşacak. Bulut sunucusu ve harici veritabanı kullanılmayacak.
- Personel, bağlantı için **Hub LAN adresi/portu ile kurum kodunu birlikte** girecek. Kurum kodu tek başına bilgisayar adresini bulmaz.
- Kilit, kuyruk ve zaman aşımının tek yetkilisi Hub olacak. Eklentinin popup, content script ve background parçaları kendi aralarında Chrome mesajlarını kullanacak.
- Kilit anahtarı **portal + ortak hesap kodu** olacak. Ayrı mükellef hesapları birbirini beklemeyecek.
- Hub yeniden başladığında RAM'deki aktif kilit ve kuyruklar sıfırlanacak. Hub bağlantısı yokken eklenti kilit alınmış gibi göstermeyecek.

## Dizinler ve geliştirme sırası

`src/core/` ileride kilit ve kuyruk kurallarını, `src/hub/` WebSocket sunucusunu, `src/hub/admin/` yerel yönetici panelini, `src/background/`, `src/ui/` ve `src/content/` Chrome eklentisinin parçalarını barındıracak. `tests/` testler, `scripts/` geliştirme ve paketleme araçları için ayrıldı.

1. **Hazırlık:** Bu iskelet ve mimari kararları.
2. **Faz 1.1:** Hub'ın kilit, kuyruk ve zaman aşımı motoru; önce davranış sözleşmesi netleştirilecek.
3. Sonraki fazlar: Hub ağ arayüzü, yönetici paneli, Chrome eklentisi ve Windows EXE/paketleme.

## Açık karar: ortak hesap kodu

Kod, aynı portalda aynı mükellef hesabını kullanan herkeste aynı; farklı hesaplarda ayrı olmalı. Kodun nasıl üretileceği, yönetici tarafından personele nasıl dağıtılacağı ve yanlış kod seçiminin nasıl önleneceği henüz kararlaştırılmadı. Portal şifresi, T.C. kimlik/vergi numarası veya başka hassas mükellef bilgisi kod olarak kullanılmamalı. Olası yön: yöneticinin her hesap için rastgele, anlamsız bir kod üretip yerel olarak yetkili personele vermesi; uygulama öncesi kullanım akışı netleştirilecek.

## Komutlar

Node.js 20+ gerekir. `npm test` Node'un test çalıştırıcısını başlatır; şu anda henüz test dosyası yoktur. Hub veya eklenti henüz uygulanmadığından `start`/`dev` komutları tanımlı değildir; ilgili giriş noktaları eklendiğinde tanımlanacak.
