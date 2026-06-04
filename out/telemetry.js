"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelemetryManager = void 0;
const vscode = require("vscode");
const https = require("https");
// TELEMETRİ — opt-in, gizlilik öncelikli
// Toplanan: hata tipleri, model adları, token sayıları, özellik kullanımı, başarı oranları
// ASLA toplanmaz: kod içeriği, prompt metni, API key, dosya yolları (sadece uzantı)
// Kullanıcı onayı zorunlu. Kullanıcı kendi verisini görebilir ve istediğinde silebilir.
// Gömülü Firebase yapılandırması — dağıtılan extension'daki tüm kullanıcılardan
// (onay verenlerden) telemetri toplamak için. Web API anahtarı public-safe'tir;
// güvenlik Firestore kurallarıyla (yalnızca create) sağlanır.
const FB_PROJECT_DEFAULT = "chainforge-telemetry";
const FB_APIKEY_DEFAULT = "AIzaSyD244z10cHM3Q7-G5COns_W_sOFt4ICGqI";
class TelemetryManager {
    constructor(context, extensionVersion) {
        this.context = context;
        this.extensionVersion = extensionVersion;
        this.buffer = [];
        this.buffer = context.globalState.get(TelemetryManager.BUFFER_KEY, []);
        this.sessionId = context.globalState.get(TelemetryManager.SESSION_KEY)
            || this.randomId();
        context.globalState.update(TelemetryManager.SESSION_KEY, this.sessionId);
    }
    // İlk açılışta onay iste (opt-in)
    async ensureConsent() {
        const state = this.getConsent();
        if (state !== "ask")
            return;
        const choice = await vscode.window.showInformationMessage("ChainForge'u geliştirmemize yardım eder misiniz? Anonim kullanım ve hata verileri toplanır (kod, prompt veya API anahtarınız ASLA gönderilmez). İstediğiniz zaman Ayarlar'dan kapatabilirsiniz.", "Kabul Et", "Hayır, Teşekkürler", "Detaylar");
        if (choice === "Kabul Et") {
            this.setConsent("granted");
            this.record({ type: "session", name: "consent_granted", ts: this.now() });
        }
        else if (choice === "Detaylar") {
            await vscode.window.showInformationMessage("Toplanan: özellik kullanımı (agent/denetim/düzeltme), AI model adları, token sayıları, hata türleri (quota/network/parse), oturum sayısı.\n\nToplanmayan: kodunuz, prompt metniniz, dosya içerikleri, dosya yolları, API anahtarınız, kişisel bilgi.", { modal: true }, "Anladım");
            // Tekrar sor
            await this.ensureConsent();
        }
        else if (choice === "Hayır, Teşekkürler") {
            this.setConsent("denied");
        }
        // choice undefined (kapatıldı) → "ask" kalır, sonra tekrar sorulur
    }
    getConsent() {
        return this.context.globalState.get(TelemetryManager.CONSENT_KEY, "ask");
    }
    setConsent(state) {
        this.context.globalState.update(TelemetryManager.CONSENT_KEY, state);
        if (state === "denied") {
            // Onay geri çekildiyse tampondaki veriyi sil
            this.buffer = [];
            this.context.globalState.update(TelemetryManager.BUFFER_KEY, []);
        }
    }
    // Olay kaydet — sadece onay verildiyse
    record(event) {
        if (this.getConsent() !== "granted")
            return;
        const sanitized = {
            type: event.type,
            name: this.sanitize(event.name),
            ts: event.ts || this.now(),
            success: event.success,
            durationMs: event.durationMs,
            model: event.model ? this.sanitize(event.model) : undefined,
            errorKind: event.errorKind,
            tokens: event.tokens,
            costUsd: event.costUsd,
            meta: event.meta,
        };
        this.buffer.push(sanitized);
        if (this.buffer.length > 500)
            this.buffer = this.buffer.slice(-500);
        this.context.globalState.update(TelemetryManager.BUFFER_KEY, this.buffer);
        // Hatalar anında, diğerleri toplu gönderilir
        if (event.type === "error")
            this.scheduleFlush(2000);
        else
            this.scheduleFlush(30000);
    }
    // Hata kaydını kolaylaştıran yardımcı — mesajı kategoriye indirger (içerik göndermez)
    recordError(name, rawMessage, model) {
        this.record({
            type: "error",
            name,
            model,
            errorKind: this.classifyError(rawMessage),
        });
    }
    classifyError(msg) {
        const m = (msg || "").toLowerCase();
        if (/quota|rate.?limit|exceeded|token.*(limit|doldu)|credits?/.test(m))
            return "quota";
        if (/enotfound|network|timeout|econn|getaddrinfo/.test(m))
            return "network";
        if (/401|403|auth|unauthorized|api key/.test(m))
            return "auth";
        if (/parse|json|format/.test(m))
            return "parse";
        if (/döngü|loop|fallback/.test(m))
            return "fallback";
        return "other";
    }
    scheduleFlush(delayMs) {
        if (this.flushTimer)
            return; // zaten planlı
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush().catch(() => { });
        }, delayMs);
    }
    // Tamponu Firebase Firestore'a (veya genel endpoint'e) gönder. Yapılandırılmamışsa local'de kalır.
    async flush() {
        if (this.getConsent() !== "granted" || this.buffer.length === 0)
            return;
        const cfg = vscode.workspace.getConfiguration("chainforge");
        // Settings boşsa gömülü varsayılan Firebase'i kullan (geliştiriciye veri akışı)
        const fbProject = cfg.get("telemetryFirebaseProjectId") || FB_PROJECT_DEFAULT;
        const fbApiKey = cfg.get("telemetryFirebaseApiKey") || FB_APIKEY_DEFAULT;
        const endpoint = cfg.get("telemetryEndpoint") || "";
        try {
            if (fbProject && fbApiKey) {
                // Firebase Firestore REST API — telemetry koleksiyonuna bir doküman ekle
                await this.postToFirestore(fbProject, fbApiKey);
            }
            else if (endpoint) {
                // Genel JSON endpoint (webhook vb.)
                await this.post(endpoint, {
                    sessionId: this.sessionId,
                    version: this.extensionVersion,
                    platform: process.platform,
                    vscodeVersion: vscode.version,
                    events: this.buffer.slice(),
                });
            }
            else {
                return; // Hiçbiri ayarlı değil — local'de biriktir
            }
            // Başarılı gönderim sonrası tamponu temizle
            this.buffer = [];
            this.context.globalState.update(TelemetryManager.BUFFER_KEY, []);
        }
        catch {
            // Gönderilemezse local'de kalır, sonra tekrar denenir
        }
    }
    // Firestore REST API: tek doküman olarak batch yaz (events JSON string olarak)
    async postToFirestore(projectId, apiKey) {
        const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/telemetry?key=${encodeURIComponent(apiKey)}`;
        const summary = this.getSummary();
        const firestoreDoc = {
            fields: {
                sessionId: { stringValue: this.sessionId },
                version: { stringValue: this.extensionVersion },
                platform: { stringValue: process.platform },
                vscodeVersion: { stringValue: vscode.version },
                sentAt: { stringValue: this.now() },
                eventCount: { integerValue: String(this.buffer.length) },
                errorCount: { integerValue: String(summary.errors) },
                events: { stringValue: JSON.stringify(this.buffer).slice(0, 900000) },
            },
        };
        await this.post(url, firestoreDoc);
    }
    // Kullanıcı kendi verisini görebilsin (şeffaflık)
    getBufferedEvents() {
        return this.buffer.slice();
    }
    getSummary() {
        const features = {};
        let errors = 0;
        for (const e of this.buffer) {
            if (e.type === "error")
                errors++;
            if (e.type === "feature")
                features[e.name] = (features[e.name] || 0) + 1;
        }
        return { total: this.buffer.length, errors, features, consent: this.getConsent() };
    }
    clearData() {
        this.buffer = [];
        this.context.globalState.update(TelemetryManager.BUFFER_KEY, []);
    }
    post(url, body) {
        return new Promise((resolve, reject) => {
            let u;
            try {
                u = new URL(url);
            }
            catch {
                return reject(new Error("geçersiz endpoint"));
            }
            if (u.protocol !== "https:")
                return reject(new Error("sadece https"));
            const data = JSON.stringify(body);
            const req = https.request({
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: "POST",
                headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
            }, (res) => {
                res.on("data", () => { });
                res.on("end", () => {
                    if (res.statusCode && res.statusCode < 400)
                        resolve();
                    else
                        reject(new Error(`HTTP ${res.statusCode}`));
                });
            });
            req.on("error", reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
            req.write(data);
            req.end();
        });
    }
    sanitize(s) {
        // Olası hassas içeriği temizle (yol, key benzeri uzun stringler)
        return String(s).replace(/sk-[a-zA-Z0-9\-_]+/g, "[key]").slice(0, 120);
    }
    now() {
        return new Date().toISOString().split(".")[0];
    }
    randomId() {
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    dispose() {
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.flush().catch(() => { });
    }
}
exports.TelemetryManager = TelemetryManager;
TelemetryManager.CONSENT_KEY = "chainforge.telemetryConsent";
TelemetryManager.BUFFER_KEY = "chainforge.telemetryBuffer";
TelemetryManager.SESSION_KEY = "chainforge.telemetrySessionId";
//# sourceMappingURL=telemetry.js.map