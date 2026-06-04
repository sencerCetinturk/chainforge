"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const validator_1 = require("./validator");
const DEFAULT_CONFIG = {
    version: "1.0",
    openRouterKey: "",
    agents: {
        worker: {
            name: "AI Worker",
            model: "minimax/minimax-m3",
            role: "coding",
            fallback: "fallback",
            maxRetries: 3,
            systemPrompt: `Sen kıdemli bir yazılım geliştiricisin. Görevin: kullanıcının istediği kodu eksiksiz, hatasız ve çalışır şekilde yazmak.

KURALLARIN:
1. HER ZAMAN tam ve eksiksiz kod yaz — "burayı siz tamamlayın", "..." gibi kısaltmalar KULLANMA.
2. Dosyanın TAMAMINI yaz, eksik bırakma.
3. Temiz kod prensiplerine uy: anlamlı isimler, tek sorumluluk, DRY.
4. Hata yönetimini UNUTMA: try-catch, input validasyonu, edge case'leri düşün.
5. Kodunu yorum satırlarıyla açıkla (karmaşık mantık varsa).
6. Yazdığın kod doğrudan çalıştırılabilir olmalı — eksik import veya bağımlılık bırakma.
7. Güvenlik açığı oluşturma: input validasyonu, injection koruması, hassas veri işleme.`
        },
        fallback: {
            name: "Fallback",
            model: "qwen/qwen3-coder:free",
            role: "fallback",
            fallback: "supervisor",
            maxRetries: 2,
            systemPrompt: `Sen yardımcı bir AI asistanısın. Birincil agent başarısız olduğunda devreye girersin.

GÖREVİN: Kullanıcının isteğini en iyi şekilde yerine getirmek. Kod yaz, soruları yanıtla, analiz yap. Elindeki tüm bilgiyi kullanarak eksiksiz yanıt ver.`
        },
        supervisor: {
            name: "Denetmen",
            model: "deepseek/deepseek-chat-v3-0324:free",
            role: "supervisor",
            maxRetries: 2,
            // ZİNCİR SONU — fallback YOK. (Önceden "fallback"e dönüyordu = sonsuz halka!)
            systemPrompt: `Sen 20 yıllık tecrübeye sahip KIDEMLİ BİR KOD DENETMENİ ve YAZILIM MİMARISIN. ChainForge'un en yetkili AI'sısın. Tek işin: verilen kodu ACIMASIZCA ve TİTİZLİKLE denetlemek.

MİSYONUN: Çalışan kodu bozacak, güvenlik zaafiyeti yaratacak veya ileride sorun çıkaracak HER ŞEYİ bulmak. Cımbızla çekerek, satır satır, karakter karakter analiz et.

=== DENETİM KATEGORİLERİN (HER BİRİNİ KONTROL ET) ===

1. SÖZDİZİMİ HATALARI
   - Eksik/y fazla parantez, köşeli parantez, süslü parantez
   - Yanlış keyword kullanımı (const/let/var uyumsuzluğu)
   - Geçersiz operator, syntax error oluşturacak yapılar

2. TİP GÜVENLİĞİ (TypeScript/JavaScript)
   - 'any' tipinin gereksiz kullanımı
   - Eksik tip tanımlamaları, yanlış generic kullanımı
   - null/undefined kontrolü yapılmadan property erişimi (!)
   - Tip assertion (as) ile yanlış tip dönüşümü

3. TANIMSIZ REFERANSLAR
   - Tanımlanmamış değişken, fonksiyon, sınıf, import kullanımı
   - Kapsam dışı (out of scope) değişken erişimi
   - Module.exports / export/import uyumsuzlukları

4. GÜVENLİK ZAAFİYETLERİ (EN KRİTİK — HER BİRİNİ TEK TEK KONTROL ET)
   - Hardcoded secret/key/token/password (JWT_SECRET, API_KEY, DB_PASSWORD vb.)
   - SQL/NoSQL injection (kullanıcı girdisinin direkt sorguya eklenmesi)
   - XSS açığı (innerHTML, document.write, eval, dangerouslySetInnerHTML)
   - Command injection (exec, spawn, eval ile kullanıcı girdisi çalıştırma)
   - Hassas veri sızıntısı (console.log ile şifre, token, kişisel veri basma)
   - Zayıf şifreleme (MD5, SHA1, sabit IV'li AES)
   - CSRF koruması eksikliği
   - Path traversal (kullanıcı girdisiyle dosya yolu oluşturma)
   - Rate limiting eksikliği
   - HTTPS/TLS sertifika doğrulaması atlama (NODE_TLS_REJECT_UNAUTHORIZED=0)
   - Hassas bilgilerin hata mesajlarında sızması

5. HATA YÖNETİMİ
   - Boş catch blokları (catch(e) {} — sessiz hata yutma!)
   - Sadece console.error ile geçiştirilen hatalar
   - Try-catch'in yanlış kapsamda kullanımı
   - Promise rejection'ların yakalanmaması
   - process.on('unhandledRejection') eksikliği

6. ASENKRON HATALARI
   - async fonksiyonda await eksikliği
   - Promise.all içinde hata yönetimi eksikliği
   - Race condition riski (paylaşılan değişkene eşzamanlı erişim)
   - Callback hell / zincirlemede kopukluk

7. PERFORMANS SORUNLARI
   - Döngü içinde ağır işlem (dosya okuma, API çağrısı, veritabanı sorgusu)
   - Gereksiz veri kopyalama (spread operatörü ile büyük dizileri kopyalama)
   - Bellek sızıntısı (kapatılmayan interval/timeout, event listener)
   - N+1 sorgu problemi
   - Senkron dosya işlemleri (readFileSync yerine readFile)

8. MANTIK HATALARI
   - Yanlış koşul ifadeleri (= yerine == veya tam tersi)
   - Off-by-one hataları (dizi indeksleme, döngü sınırı)
   - undefined/null ile yanlış karşılaştırma
   - Boolean mantık hataları (|| yerine && kullanımı)
   - Sonsuz döngü riski

9. KOD KALİTESİ (SADECE ÇALIŞMAYI BOZACAK OLANLAR)
   - Aynı kodun 3+ kez tekrarlanması (DRY ihlali)
   - Aşırı uzun fonksiyon (50+ satır tek bir işi yapmayan)
   - Sihirli sayılar (açıklamasız sabit değerler)

=== KESİN KURALLAR ===

✅ BUNLARI BİLDİR:
- Kodun çalışmasını ENGELLEYECEK her şey
- Güvenlik açığı oluşturacak HER ŞEY (ne kadar küçük olursa olsun)
- Veri kaybına veya bozulmasına yol açacak hatalar
- Gelecekte kesin sorun çıkaracak teknik borçlar

❌ BUNLARI BİLDİRME (stil tercihidir, çalışmayı bozmaz):
- Boşluk, girinti, tırnak tipi (' vs ")
- Noktalı virgül tercihi
- Değişken isimlendirme stili (camelCase vs snake_case)
- Comment eksikliği (çok bariz değilse)
- import sıralaması

=== YANIT FORMATI ===

KESİNLİKLE şu JSON yapısında yanıt ver. Başka HİÇBİR ŞEY yazma:

{
  "status": "error",
  "issues": [
    {
      "line": 42,
      "severity": "error",
      "code": "const JWT_SECRET = 'mysecret123';",
      "message": "GÜVENLİK: JWT gizli anahtarı kod içinde hardcoded olarak tanımlanmış. Bu anahtar GitHub'a pushlandığında tüm token'lar ele geçirilebilir. ÇÖZÜM: process.env.JWT_SECRET kullan, .env dosyasından oku, .env'i .gitignore'a ekle. Asla varsayılan değer (fallback) kullanma — anahtar yoksa uygulama başlatılmasın."
    },
    {
      "line": 58,
      "severity": "warning",
      "code": "const query = 'SELECT * FROM users WHERE id = ' + userId;",
      "message": "GÜVENLİK: SQL injection riski. Kullanıcı girdisi (userId) doğrudan SQL sorgusuna ekleniyor. Kötü niyetli bir kullanıcı '1; DROP TABLE users;--' göndererek veritabanını silebilir. ÇÖZÜM: Parametreli sorgu kullan — db.query('SELECT * FROM users WHERE id = ?', [userId])"
    }
  ]
}

Eğer hiç sorun yoksa:
{
  "status": "clean",
  "issues": []
}

=== ÖNEMLİ HATIRLATMALAR ===
- Her sorun için MUTLAKA satır numarası ver
- code alanına hatanın olduğu satırın TAM metnini koy
- message alanına: ne hatası → nedeni → somut risk → net çözüm önerisi
- Emin olmadığın şeyi BİLDİRME. Yanlış pozitif, doğru pozitiften kötüdür.
- Güvenlik hatalarını ASLA atlama. Bir tanesi bile tüm sistemi çökertebilir.`
        },
    },
    tasks: {
        coding: { primary: "worker", description: "💻 Kod yazma, düzenleme, refactor" },
        review: { primary: "supervisor", description: "🔍 Kod inceleme, mimari denetim" },
        general: { primary: "worker", description: "💬 Genel soru-cevap" },
    }
};
class ConfigManager {
    constructor(context) {
        this.context = context;
    }
    getConfigPath() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders?.length) {
            return path.join(workspaceFolders[0].uri.fsPath, ".aichain.json");
        }
        const globalDir = this.context.globalStorageUri.fsPath;
        if (!fs.existsSync(globalDir))
            fs.mkdirSync(globalDir, { recursive: true });
        return path.join(globalDir, "config.json");
    }
    async loadConfig() {
        try {
            const configPath = this.getConfigPath();
            if (!fs.existsSync(configPath)) {
                await this.saveConfig(DEFAULT_CONFIG);
                return { ...DEFAULT_CONFIG };
            }
            const raw = fs.readFileSync(configPath, "utf8");
            const parsed = JSON.parse(raw);
            const config = this.mergeWithDefaults(parsed);
            // API key VSCode settings'den al (güvenli)
            const settings = vscode.workspace.getConfiguration("chainforge");
            config.openRouterKey = settings.get("openRouterKey") || "";
            return config;
        }
        catch {
            return { ...DEFAULT_CONFIG };
        }
    }
    async saveConfig(config) {
        try {
            const configPath = this.getConfigPath();
            const toSave = { ...config, openRouterKey: "" }; // Key asla dosyaya yazılmaz
            fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), "utf8");
        }
        catch (err) {
            vscode.window.showErrorMessage(`AI Chain: Config kaydedilemedi: ${err}`);
        }
    }
    // Kullanıcıdan gelen agent verisini doğrula ve ekle
    validateAndAddAgent(config, data, isEdit) {
        const checks = [
            (0, validator_1.validateAgentKey)(data.key),
            (0, validator_1.validateAgentName)(data.name),
            (0, validator_1.validateModel)(data.model),
            (0, validator_1.validateRole)(data.role),
            (0, validator_1.validateSystemPrompt)(data.systemPrompt || ""),
            (0, validator_1.validateFallback)(data.fallback || "", config.agents, data.key),
        ];
        const failed = checks.find(c => !c.valid);
        if (failed)
            return { success: false, error: failed.error };
        const retriesCheck = (0, validator_1.validateMaxRetries)(parseInt(data.maxRetries) || 2);
        if (!retriesCheck.valid)
            return { success: false, error: retriesCheck.error };
        if (!isEdit && config.agents[data.key]) {
            return { success: false, error: `'${data.key}' key'i zaten mevcut` };
        }
        const newConfig = { ...config };
        newConfig.agents = { ...config.agents };
        newConfig.agents[data.key] = {
            name: data.name.trim(),
            model: data.model.trim().toLowerCase(),
            role: data.role,
            fallback: data.fallback || undefined,
            maxRetries: Math.min(Math.max(parseInt(data.maxRetries) || 2, 1), 5),
            systemPrompt: data.systemPrompt?.trim() || undefined,
        };
        return { success: true, config: newConfig };
    }
    // Kullanıcıdan gelen görev verisini doğrula ve ekle
    validateAndAddTask(config, data, isEdit) {
        const keyCheck = (0, validator_1.validateTaskKey)(data.key);
        if (!keyCheck.valid)
            return { success: false, error: keyCheck.error };
        const descCheck = (0, validator_1.validateTaskDescription)(data.description);
        if (!descCheck.valid)
            return { success: false, error: descCheck.error };
        if (!config.agents[data.primary]) {
            return { success: false, error: `Agent bulunamadı: ${data.primary}` };
        }
        if (!isEdit && config.tasks[data.key]) {
            return { success: false, error: `'${data.key}' görevi zaten mevcut` };
        }
        const newConfig = { ...config };
        newConfig.tasks = { ...config.tasks };
        newConfig.tasks[data.key] = {
            primary: data.primary,
            description: data.description.trim(),
        };
        return { success: true, config: newConfig };
    }
    deleteAgent(config, key) {
        const keyCheck = (0, validator_1.validateAgentKey)(key);
        if (!keyCheck.valid)
            return { success: false, error: "Geçersiz key" };
        if (!config.agents[key])
            return { success: false, error: "Agent bulunamadı" };
        // Bu agent'a bağımlı başka agent var mı?
        const dependents = Object.entries(config.agents)
            .filter(([k, a]) => a.fallback === key && k !== key)
            .map(([k]) => k);
        if (dependents.length > 0) {
            return { success: false, error: `Bu agent şu agent'ların fallback'i: ${dependents.join(", ")}. Önce onları güncelleyin.` };
        }
        const newConfig = { ...config };
        newConfig.agents = { ...config.agents };
        delete newConfig.agents[key];
        return { success: true, config: newConfig };
    }
    deleteTask(config, key) {
        const keyCheck = (0, validator_1.validateTaskKey)(key);
        if (!keyCheck.valid)
            return { success: false, error: "Geçersiz key" };
        if (!config.tasks[key])
            return { success: false, error: "Görev bulunamadı" };
        const newConfig = { ...config };
        newConfig.tasks = { ...config.tasks };
        delete newConfig.tasks[key];
        return { success: true, config: newConfig };
    }
    mergeWithDefaults(parsed) {
        return {
            version: parsed.version || "1.0",
            openRouterKey: "",
            agents: parsed.agents || {},
            tasks: parsed.tasks || {},
        };
    }
    async openConfigFile() {
        const configPath = this.getConfigPath();
        if (!fs.existsSync(configPath))
            await this.saveConfig(DEFAULT_CONFIG);
        const doc = await vscode.workspace.openTextDocument(configPath);
        await vscode.window.showTextDocument(doc);
    }
}
exports.ConfigManager = ConfigManager;
//# sourceMappingURL=configManager.js.map