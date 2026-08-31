# Changelog

All notable changes to ChainForge will be documented here.

## [1.4.3] - 2026-08-31

### Changed
- README (Marketplace/Open VSX listing sayfası) 1.4.2'de eklenen özellikleri (blok-bazlı maliyet optimizasyonu + ölçülen %78 tasarruf, büyük görünüm, seçili koddan hızlı görev, quick-fix, kendini güncelleyen ücretsiz katman) ve güncel Pro tablosunu (paylaşılabilir proje talimatları, preset'ler, doğru geri-al limiti: 20) yansıtacak şekilde güncellendi.
- Örnek `.chainforge.json` konfigürasyonundaki model ID'leri güncel/gerçek OpenRouter formatına düzeltildi.
- Yeni komutların Command Palette başlıkları İngilizceye çevrildi (paketin geri kalanıyla tutarlılık için).

## [1.4.2] - 2026-08-31

### Added — Yeni özellikler (kullanıcı talebi üzerine, tek turda eklendi)
- **Büyük görünüm (editör sekmesi):** Kenar çubuğu dar kalıyorsa, panel araç çubuğundaki yeni ikonla ("ChainForge: Büyük Görünümde Aç") ya da `chainforge.openFullView` komutuyla aynı panel, editör alanında büyük bir sekme olarak açılabilir. Aynı örneği paylaşır — config/isPro/geçmiş hep senkron.
- **Ücretsiz model kataloğu canlı doğrulama:** Extension açılışında OpenRouter'ın gerçek `:free` model listesi (key gerekmez) çekilip 24 saat önbelleklenir; sohbetin otomatik yedek zinciri ve panel model seçici artık sadece GERÇEKTEN çalışan modelleri gösterir/dener. Ağ hatasında davranış eskisi gibi (statik listeye düşer) — hiçbir zaman daha kötüye gitmez. ([modelCatalog.ts](src/modelCatalog.ts))
- **Görev bazlı gerçek maliyet gösterimi:** Bir agent görevi bittiğinde, o görevin TÜM AI çağrılarının gerçek toplam maliyeti hem canlı loglarda hem İşlem Geçmişi kayıtlarında ($ olarak) gösteriliyor.
- **Seçili kodla hızlı görev (sağ tık):** Editörde seçili kod (veya tüm dosya) üzerinde sağ tık → "ChainForge: Seçili Kodla Görev Başlat" ile panele gitmeden doğrudan agent görevi başlatılabilir.
- **Problems paneli entegrasyonu:** Derleyici/linter hatalarının yanında artık bir ampul (Quick Fix) ile "ChainForge ile düzelt: ..." seçeneği çıkıyor — tek bir tanıya odaklı, Denetmen'in tam-tarama akışından bağımsız.
- **Otomatik git checkpoint (opsiyonel, `chainforge.autoCheckpoint` ayarı, varsayılan kapalı):** Açıksa, workspace'te commit edilmemiş değişiklik varken ajan dosya yazmadan önce bunları otomatik bir checkpoint commit'i olarak kaydeder — kullanıcının kendi işi kaybolmaz, gerekirse tek adımda geri dönülür.
- **Blok modu başarısız olursa otomatik tam-dosya yeniden deneme:** Coding agent blok modunda beklenen formatta yanıt veremezse (örn. bloğun dışında da değişiklik gerektiğini fark edip format kısıtına takılırsa), aynı görev otomatik olarak tam dosya modunda bir kez daha denenir — görev artık sessizce tamamen başarısız olmuyor.
- **Takım/proje bazlı paylaşılabilir talimatlar (Pro):** Workspace kökünde `.chainforge/instructions.md` varsa (repo'ya committ edilip takımla paylaşılabilir) otomatik okunup kişisel talimatlarla birleştiriliyor.
- **Otomatik commit mesajı üretimi:** Dosyalar uygulandıktan sonra çıkan bildirimde "Commit Mesajı Oluştur" butonu, görev niyeti + değişen dosyalardan ucuz bir ücretsiz modelle conventional-commits formatında tek satırlık bir mesaj üretip panoya kopyalar.

### Added — Kod indeksi (Postacı'nın dosya/konum bulması için)
- Yeni `CodeIndexStore` ([codeIndex.ts](src/agent/codeIndex.ts)) — workspace'teki fonksiyon/sınıf/interface/type başlıklarını, hangi dosyada ve hangi satırda olduklarıyla birlikte kaydeder. Tamamen regex tabanlı ([codeHeaders.ts](src/agent/codeHeaders.ts)) — **AI çağrısı gerektirmez, ücretsizdir.**
- Sonuç, `globalStorage`'da (workspace bağımsız) `code-index.json` olarak **kalıcı** — dosya değişmediyse (mtime kontrolü) yeniden taranmaz, sadece değişen/yeni dosyalar güncellenir.
- Planlama promptuna (`makePlan`) ve blok-çıkarma promptuna (`extractExcerpts`) her dosyanın bilinen başlıkları + satır numaraları ipucu olarak ekleniyor — Postacı hangi dosyada ne olduğunu daha hızlı, daha az tahminle buluyor.
- JS/TS/Python/Go/Rust fonksiyonları, class/interface/type tanımları destekleniyor. 5 yeni birim testiyle doğrulandı (`test/codeIndex.test.js`) — ChainForge'un kendi `router.ts` dosyası üzerinde gerçek sınıf/fonksiyon tespiti dahil. Cache/persistans davranışı da ayrıca (sahte dosya sistemiyle) doğrulandı: değişmeyen dosya tekrar okunmuyor, mtime değişince yeniden taranıyor, disk kalıcılığı instance'lar arası korunuyor, silinen dosyalar önbellekten temizleniyor.

### Added — Maliyet optimizasyonu: blok-bazlı düzenleme
- Postacı artık var olan dosyalarda **dosyanın tamamını değil, sadece görevle ilgili kod bloğunu** coding agent'a gönderiyor. Ücretsiz planlayıcı model, hedef dosyanın tamamını okuyup görevle ilgili değişecek kısmı **birebir (verbatim)** alıntılıyor (`orchestrator.ts: extractExcerpts`); coding agent sadece bu bloğu görüyor ve sadece bloğun yeni halini üretiyor, Postacı bunu orijinal dosyaya geri yerleştiriyor (splice).
- **Güvenlik ağı:** alıntı orijinal dosyada birebir bulunamazsa (ör. model bug'ı düzelterek kopyaladıysa), çok kısaysa, ya da değişiklik dosyanın geneline yayılıyorsa sistem otomatik ve güvenle **tam dosya moduna** düşüyor — optimizasyon başarısız olsa da hiçbir zaman yarım/bozuk dosya yazılmıyor.
- Coding agent artık tam anlamıyla **stateless**: geçmiş değişiklik bağlamı (`historyContext`) coding prompt'undan tamamen kaldırıldı; agent sadece o anki blok/görev bilgisini görüyor.
- Gerçek OpenRouter API'siyle canlı doğrulandı: 66 satırlık bir dosyada tek satırlık bir bug düzeltmesinde sadece ~170 karakterlik blok coding modeline gönderildi, dönen sonuç orijinal dosyayla **byte-mükemmel** eşleşti (sadece hedeflenen satır değişti, diğer 14 fonksiyon ve `module.exports` birebir korundu).
- **Hayalet ayar kaldırıldı:** `chainforge.language` VS Code ayarı, "ChainForge interface language" açıklamasıyla kullanıcıya arayüz dilini değiştirdiğini vaat ediyordu — ama dil artık panel içinden seçilip hesaba bağlı `globalState`'te tutuluyor, bu ayar hiçbir zaman gerçek arayüzü etkilemiyordu. Üstüne üstlük, `onDidChangeConfiguration` içindeki ölü kod bu ayar değiştiğinde sessizce sadece AI'nin yanıt dili ipucunu değiştirip görünen panel diliyle tutarsızlık yaratabiliyordu. Ayar ve ilgili ölü kod kaldırıldı.
- **Kritik: ölü model ID'leri (varsayılan/ücretsiz katman tamamen çalışmıyordu):** OpenRouter'ın canlı model listesine karşı doğrulama yapıldığında, `freeModels.ts`'teki ücretsiz model listesinin (FREE_MODELS, 12 model) sadece 2'sinin, Postacı'nın ücretsiz yedek zincirinin (FREE_FALLBACK_CHAIN) ise 0/4'ünün hâlâ OpenRouter'da var olduğu tespit edildi — yani API key girmeyen HİÇBİR kullanıcı tek bir görevi bile tamamlayamıyordu. Aynı sorun `configManager.ts`'teki DEFAULT_CONFIG'in (her yeni kurulumun varsayılanı) fallback/supervisor modellerinde ve `presets.ts`'in "Ücretsiz" presetinde de vardı. Ayrıca "Güçlü" presetteki Claude model ID'leri yanlış formattaydı (`claude-sonnet-4-6` yerine gerçek ID `claude-sonnet-4.6`). Üç dosyada da tüm model ID'leri canlı kataloğa karşı doğrulanıp gerçek/çalışan ID'lerle değiştirildi.
- **Fransızca'da webview'i tamamen kıran bug:** Agent/görev düzenleme modalının başlığı, çevrilmiş metni (`t('agentEdit')` = "Modifier l'agent") kaçışsız şekilde tek tırnaklı bir JS string'ine gömüyordu — Fransızca'daki apostrof (`l'agent`) string'i erken kapatıp tüm inline `<script>`'i sözdizimi hatasıyla kırıyordu (İngilizce webview-tab-arızası buguyla aynı sınıf). `JSON.stringify()` ile güvenli şekilde kaçışlanacak şekilde düzeltildi.
- **i18n: Almanca/Fransızca/İspanyolca/Japonca/Çince'de istatistik başlığı Türkçe kalıyordu:** `statsTitle` çevirisi sadece `en`/`tr`'de tanımlıydı; diğer 5 dilde kod sabit "Kullanımı" (Türkçe) metnine düşüyordu (ör. Almanca kullanıcı "August 2026 Kullanımı" görüyordu). Her dil için doğru çeviri eklendi.
- **Kod indeksi doğrulaması (stale-cache koruması):** Postacı artık kod indeksinden (bellekten) gelen fonksiyon/satır bilgisini kullanmadan önce dosyanın O ANKİ içeriğiyle karşılaştırıp doğruluyor. Kod ChainForge dışından elle değiştirilmişse (isim/satır artık uyuşmuyorsa) ilgili dosya için başlıklar anında, yerel/ücretsiz olarak yeniden çıkarılıyor — böylece Postacı asla artık geçerli olmayan bir konum bilgisine güvenip yanlış yere bakmıyor. Ayrıca mevcut güvenlik ağı (excerpt'in dosyada birebir bulunamaması durumunda otomatik tam-dosya moduna düşme) zaten her durumda son sözü söylüyor, bu yeni doğrulama sadece isabeti artırıp gereksiz tam-dosya düşüşlerini azaltıyor.
- **Kritik CRLF/LF düzeltmesi:** Windows'ta (veya CRLF satır sonu kullanan herhangi bir repoda) blok modu **sistematik olarak hiç devreye girmiyordu** — orijinal dosya `\r\n` kullanıyor, model çıktısı her zaman `\n` kullanıyor, ham birebir karşılaştırma bu yüzden hep başarısız olup tam-dosya moduna düşüyordu. Karşılaştırma artık CRLF→LF normalize edilerek yapılıyor. Gerçek 417 satırlık bir dosyada (`router.ts`) canlı A/B testiyle doğrulandı: düzeltmeden ÖNCE her zaman tam-dosya modu, düzeltmeden SONRA blok modu (17.395 karakterlik dosyadan sadece 598 karakter coding modeline gönderildi).
- **Gerçek A/B maliyet ölçümü (gerçek API, `router.ts` üzerinde):** blok modu $0.001485/görev, tam-dosya modu $0.006739/görev — **%78 maliyet tasarrufu**. Ayrıca tam-dosya modu bu boyuttaki bir dosyada coding modelinin `max_tokens` sınırına takılıp çıktısı yarım kalarak parse hatası verdi; blok modu bu güvenilirlik riskini de ortadan kaldırıyor.
- **Boyut sağlaması:** coding agent verilen küçük bloğa karşılık orantısız büyük bir çıktı üretirse (halüsinasyon, alakasız kod/açıklama ekleme) artık **reddediliyor** (eşik: alıntının 5 katı veya +400 karakter, hangisi büyükse) — dosyaya sessizce şişirilmiş/bozuk içerik enjekte edilmiyor. 30x'lik uydurma bir çıktıyla test edilip doğrulandı.


### Fixed — canlı testte bulundu (Extension Development Host, F5)
- **Kritik: ChainForge Activity Bar'da hiç görünmüyordu.** `icon.svg` olarak 1024x1024, çok renkli, ~900KB'lık marka logosu kullanılıyordu; VS Code'un activity bar/komut ikonları basit, tek renkli (currentColor) SVG bekliyor. Sonuç: view container hiç render olmuyordu, kullanıcılar paneli activity bar'dan bulamıyordu. Yeni `icon-activitybar.svg` (24x24, tek renkli) eklendi; activity bar ve `chainforge.openPanel` komutu artık bunu kullanıyor. Marka logosu (`icon.svg`) sadece walkthrough'ta kalmaya devam ediyor.
- **Kritik: Sohbet dışındaki TÜM sekmeler (Agentlar/Görevler/Kullanım/Ayarlar) boş görünüyordu.** Sebep: bu turda eklenen "thinking display" kodunda `liveSteps.join('\n')` — dış TS template literal `\n`'i gerçek satır sonuna çevirip istemci JS'ine bozuk (kaçışsız satır sonu içeren tek tırnaklı string) bir kod gönderiyordu. Bu, webview'ın TÜM script bloğunu SyntaxError ile çökertip sekme geçişini (ve diğer tüm JS etkileşimini) sessizce devre dışı bırakıyordu. `'\n'` → `'\\n'` düzeltildi. Bulgu, panelin gerçek DOM/HTML çıktısı offline Node ile (vm.Script) statik olarak sözdizimi kontrolünden geçirilerek doğrulandı (Pro/free, dolu/boş liste gibi 4 farklı durumda).
- Küçük: Kullanım sekmesinde "AĞUSTOS 2026 {month} KULLANIMI" gibi kullanılmamış bir `{month}` şablon değişkeni sızıyordu (önceki bir sürümden kalma, bu turun eklemesi değil) — düzeltildi.


### Synced from published v1.4.1
Repo kaynağı (bu satırdan önce 1.3.0 tabanlıydı) yayınlanan VSIX'in derlenmiş koduyla karşılaştırılıp gerçek davranış farkları taşındı — bu turdaki güvenlik/Pro eklemeleri korunarak:
- Router: `findAllAgentsByRole` — birden fazla "routing" rollü agent tanımlıysa hepsi öncelik sırasıyla denenir (tek agent yerine).
- Orchestrator ve Sohbet: routing agent önceliği + ücretsiz model zinciri birlikte çalışıyor; her adım `flowEvents` ile telemetriye (opt-in) akış olarak kaydediliyor.
- Telemetry: `recordFlow()` ve zenginleştirilmiş `recordError()` (mesaj/stack/tool) eklendi. Yayınlanan sürümdeki IP-üzerinden-ülke-tespiti (ipinfo.io) kasıtlı olarak **taşınmadı** — gerekli değildi, kaldırıldı; IP adresi hiçbir şekilde toplanmıyor.
- ChangeLogger & Inspector & UndoStore: log'lar artık workspace'ten bağımsız `globalStorage` altında tutuluyor — proje klasörü taşınsa/yeniden adlandırılsa bile geçmiş kaybolmuyor, kullanıcı repo'suna `.chainforge` klasörü eklenmiyor.
- Inspector: kalıcı hata tespiti — bir dosya art arda iki denetimde de hatalıysa Postacı'ya otomatik ping atılıyor ("düzeltsin mi?").
- Agent görevleri artık iptal edilebiliyor (`chainforge.cancelAgentTask`, panelde aynı buton chat/agent moduna göre doğru komutu gönderiyor).
- Sürüm güncellemesinde ilk açılışta "Yenilikler" bildirimi.
- Sohbet geçmişi kırpma mantığı sabit mesaj sayısı yerine karakter sayısına (~60k) göre yapılıyor — daha az token taşması.
- Anonim özellik-kullanım telemetrisi (`openrouter_key_connected`, `openrouter_link_click`) — kod/prompt/key içermez.

- Panelde proje bazlı sohbet modeli hatırlama, dil tercihinin `globalState`'e taşınması (workspace/ayar bağımsız), "İşlem Geçmişi" listesi (Ayarlar sekmesi) ve canlı "thinking display" adım listesi (agent görevi sırasında result kutusunda biriken adımlar) tamamlandı.


### Security
- Sabit kodlanmış lisans bypass anahtarı kaldırıldı (`license.ts`) — VSIX içinden okunup ücretsiz Pro aktivasyonu için kötüye kullanılabiliyordu.
- Agent/Postacı modunda AI'nin ürettiği dosya yolları artık doğrulanıyor (`validator.ts: validateRelativeFilePath`, `orchestrator.ts`, `fileApplier.ts`) — mutlak yol veya `..` içeren yollar reddedilerek workspace dışına yazma/silme (path traversal) engellendi.

### Added — Güven özellikleri
- Agent/Postacı ile uygulanan son dosya değişiklikleri tek tıkla geri alınabiliyor ("↩ Son Değişikliği Geri Al").
- Dosyalara yazmadan önce commit edilmemiş git değişiklikleri varsa uyarı gösteriliyor.
- Aylık harcama tavanı ayarı (`chainforge.monthlyBudgetUsd`) — %80 ve %100 eşiklerinde bildirim.
- **Geri alma verisi diske kalıcı** — `.chainforge/logs/undo/` altında saklanıyor (yeni `UndoStore`), VS Code penceresi kapansa da kaybolmuyor.

### Added — Pro
- **Sınırsız geri alma geçmişi (Pro)** — ücretsizde 1 adım, Pro'da son 20 işleme kadar zincirleme geri alma.
- **Özel Global Talimatlar (Pro)** — panelde ekle/kaldır listesiyle yönetilen, her sohbet ve agent görevine otomatik eklenen kişisel talimatlar (`chainforge.customInstructions: string[]`). settings.json'a hiç gidilmiyor.
- Pro lisans aktivasyonunda gerçek bir teşekkür mesajı (native bildirim + panelde kalıcı not); Ayarlar > Pro License'da kalıcı teşekkür notu; üst çubuktaki "Pro" rozeti 💙 ile güncellendi.
- Pro satış modaline "bağımsız geliştiriciyi destekle" vurgusu eklendi (7 dilde).

### Added — Kullanılabilirlik
- **Hızlı Kurulum preset'leri** (Agents sekmesi): "Ücretsiz", "Dengeli", "Güçlü" — tek tıkla worker/fallback/supervisor agent'larını hazır bir model setiyle kuruyor.
- **"ChainForge'a Başlarken" walkthrough'u** — VS Code'un yerleşik onboarding akışında 4 adımlı bir tur (key bağlama, sohbet, agent görevi, Denetmen).
- Birden fazla workspace klasörü açıkken ChainForge'un yalnızca ilkini kullandığına dair uyarı (önceden sessizce göz ardı ediliyordu).

### Changed
- README ve Marketplace açıklaması gerçek özellik setini (Denetmen/Postacı döngüsü, otomatik dosya düzenleme, sohbet) yansıtacak şekilde güncellendi.
- İlk otomatik testler eklendi (`test/`, `node --test`): `validateRelativeFilePath`, `validateModel`, `validateAgentName`, `estimateCost`.

## [1.0.0] - 2026-06-03

### Added
- Multi-model AI orchestration via OpenRouter
- Visual agent and task editor (no YAML required)
- Automatic fallback chain
- File export from AI responses
- Pro license system via Dodo Payments
- 7 language support (EN, TR, DE, FR, ES, JA, ZH)
- Security: input validation, XSS protection, path traversal prevention
