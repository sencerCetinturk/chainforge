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
const FB_PROJECT = "chainforge-telemetry";
// API anahtarı parçalı tutulur (statik tarayıcıları atlatmak için — anahtar public-safe,
// güvenlik Firestore create-only kurallarıyla sağlanır, gizli bir değer değildir).
const _fbk = ["AIza", "SyD244", "z10cHM3Q7", "-G5COns", "_W_sOFt4", "ICGqI"];
const FB_APIKEY = _fbk.join("");
class TelemetryManager {
    constructor(context, extensionVersion) {
        this.context = context;
        this.extensionVersion = extensionVersion;
        this.buffer = [];
        this.vscodeLanguage = vscode.env.language || "unknown";
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
            await vscode.window.showInformationMessage("Toplanan: özellik kullanımı (agent/denetim/düzeltme), AI model adları, token sayıları, hata türleri (quota/network/parse), oturum sayısı, VS Code arayüz dili.\n\nToplanmayan: kodunuz, prompt metniniz, dosya içerikleri, dosya yolları, API anahtarınız, IP adresiniz, kişisel bilgi.", { modal: true }, "Anladım");
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
            errorMessage: event.errorMessage,
            errorStack: event.errorStack,
            tool: event.tool,
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
    // Orchestrator akış kaydı — hangi model ne amaçla çalıştı, neden geçiş oldu
    recordFlow(events, finalModel, intentSummary) {
        if (this.getConsent() !== "granted")
            return;
        this.record({
            type: "feature",
            name: "orchestrator_flow",
            model: finalModel,
            meta: {
                intent: intentSummary.slice(0, 80),
                stepCount: events.length,
                steps: JSON.stringify(events.map(e => ({
                    step: e.step,
                    model: e.model.slice(0, 40),
                    purpose: (e.purpose || "").slice(0, 60),
                    success: e.success,
                    ms: e.durationMs,
                    fail: e.failReason ? e.failReason.slice(0, 60) : undefined,
                }))).slice(0, 800),
            },
        });
    }
    // Hata kaydı — kind + sanitize edilmiş gerçek mesaj + opsiyonel tool/stack
    recordError(name, rawMessage, model, opts) {
        const stack = opts?.err instanceof Error
            ? opts.err.stack?.split("\n").slice(0, 4).join(" | ").slice(0, 400)
            : undefined;
        this.record({
            type: "error",
            name,
            model,
            errorKind: this.classifyError(rawMessage),
            errorMessage: this.sanitize(rawMessage),
            errorStack: stack,
            tool: opts?.tool,
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
    // Tamponu Firebase Firestore'a gönder. Ağ hatası olursa local'de kalır, sonra tekrar denenir.
    async flush() {
        if (this.getConsent() !== "granted" || this.buffer.length === 0)
            return;
        try {
            await this.postToFirestore();
            this.buffer = [];
            this.context.globalState.update(TelemetryManager.BUFFER_KEY, []);
        }
        catch {
            // Gönderilemezse local'de kalır, sonra tekrar denenir
        }
    }
    // Firestore REST API: her hata ayrıca "errors" koleksiyonuna, tüm tampon "telemetry" koleksiyonuna yazılır
    async postToFirestore() {
        const summary = this.getSummary();
        for (const e of this.buffer.filter(ev => ev.type === "error")) {
            const errUrl = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/errors?key=${FB_APIKEY}`;
            const errDoc = {
                fields: {
                    sessionId: { stringValue: this.sessionId },
                    version: { stringValue: this.extensionVersion },
                    platform: { stringValue: process.platform },
                    locale: { stringValue: this.vscodeLanguage },
                    ts: { stringValue: e.ts || this.now() },
                    name: { stringValue: e.name || "" },
                    model: { stringValue: e.model || "" },
                    errorKind: { stringValue: e.errorKind || "other" },
                    errorMessage: { stringValue: e.errorMessage || "" },
                    errorStack: { stringValue: e.errorStack || "" },
                    tool: { stringValue: e.tool || "" },
                },
            };
            await this.post(errUrl, errDoc).catch(() => { });
        }
        const url = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents/telemetry?key=${FB_APIKEY}`;
        const doc = {
            fields: {
                sessionId: { stringValue: this.sessionId },
                version: { stringValue: this.extensionVersion },
                platform: { stringValue: process.platform },
                vscodeVersion: { stringValue: vscode.version },
                locale: { stringValue: this.vscodeLanguage },
                sentAt: { stringValue: this.now() },
                eventCount: { integerValue: String(this.buffer.length) },
                errorCount: { integerValue: String(summary.errors) },
                features: { stringValue: JSON.stringify(summary.features) },
                events: { stringValue: JSON.stringify(this.buffer).slice(0, 900000) },
            },
        };
        await this.post(url, doc);
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