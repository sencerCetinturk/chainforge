"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LicenseManager = void 0;
const https = require("https");
const DODO_TEST_URL = "test.dodopayments.com";
const DODO_LIVE_URL = "live.dodopayments.com";
const IS_TEST_MODE = false;
const DODO_API_URL = IS_TEST_MODE ? DODO_TEST_URL : DODO_LIVE_URL;
function httpsPost(hostname, path, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const options = {
            hostname,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
            },
        };
        const req = https.request(options, (res) => {
            let responseData = "";
            res.on("data", (chunk) => { responseData += chunk; });
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(responseData);
                    if (res.statusCode && res.statusCode >= 400) {
                        const err = new Error(parsed?.message || parsed?.error || "HTTP Error");
                        err.status = res.statusCode;
                        err.data = parsed;
                        reject(err);
                    }
                    else {
                        resolve(parsed);
                    }
                }
                catch {
                    reject(new Error("Invalid JSON response"));
                }
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
        req.write(data);
        req.end();
    });
}
class LicenseManager {
    constructor(context) {
        this.context = context;
    }
    async checkSavedLicense() {
        const savedKey = this.context.globalState.get(LicenseManager.STORAGE_KEY);
        const isPro = this.context.globalState.get(LicenseManager.IS_PRO_KEY, false);
        if (!savedKey || !isPro)
            return false;
        // Dev bypass key — network'e gitme
        if (savedKey === "CHAINFORGE-DEV-2026")
            return true;
        try {
            const activationId = this.context.globalState.get(LicenseManager.ACTIVATION_KEY);
            const body = { license_key: savedKey };
            if (activationId)
                body.license_key_instance_id = activationId;
            const data = await httpsPost(DODO_API_URL, "/licenses/validate", body);
            if (data?.valid === true)
                return true;
            await this.clearLicense();
            return false;
        }
        catch {
            return isPro; // Offline tolerans
        }
    }
    async activateLicense(licenseKey) {
        const key = licenseKey.trim();
        if (!key || key.length < 5)
            return { valid: false, error: "Geçersiz lisans key" };
        // Dev bypass
        if (key === "CHAINFORGE-DEV-2026") {
            await this.context.globalState.update(LicenseManager.STORAGE_KEY, key);
            await this.context.globalState.update(LicenseManager.IS_PRO_KEY, true);
            return { valid: true };
        }
        try {
            const data = await httpsPost(DODO_API_URL, "/licenses/activate", {
                license_key: key,
                name: "VSCode Extension",
            });
            // Başarı: response'da id (lki_xxx) gelir
            if (data?.id) {
                await this.context.globalState.update(LicenseManager.STORAGE_KEY, key);
                await this.context.globalState.update(LicenseManager.ACTIVATION_KEY, data.id);
                await this.context.globalState.update(LicenseManager.IS_PRO_KEY, true);
                return { valid: true, activationId: data.id };
            }
            return { valid: false, error: "Lisans aktive edilemedi" };
        }
        catch (err) {
            const status = err?.status;
            console.error("[ChainForge License] Status:", status, "Data:", JSON.stringify(err?.data), "Msg:", err?.message);
            if (status === 404)
                return { valid: false, error: "Lisans key bulunamadı" };
            if (status === 409)
                return { valid: false, error: "Bu lisans key zaten aktif" };
            if (status === 400)
                return { valid: false, error: `Geçersiz istek: ${JSON.stringify(err?.data)}` };
            if (status === 422)
                return { valid: false, error: "Aktivasyon limiti doldu" };
            return { valid: false, error: `Hata ${status || "?"}: ${err?.message || "Bilinmeyen"}` };
        }
    }
    async deactivateLicense() {
        const savedKey = this.context.globalState.get(LicenseManager.STORAGE_KEY);
        const activationId = this.context.globalState.get(LicenseManager.ACTIVATION_KEY);
        if (savedKey && activationId && savedKey !== "CHAINFORGE-DEV-2026") {
            try {
                await httpsPost(DODO_API_URL, "/licenses/deactivate", {
                    license_key: savedKey,
                    license_key_instance_id: activationId,
                });
            }
            catch { }
        }
        await this.clearLicense();
    }
    async isPro() {
        return this.context.globalState.get(LicenseManager.IS_PRO_KEY, false);
    }
    getSavedKey() {
        return this.context.globalState.get(LicenseManager.STORAGE_KEY) || "";
    }
    async clearLicense() {
        await this.context.globalState.update(LicenseManager.STORAGE_KEY, undefined);
        await this.context.globalState.update(LicenseManager.ACTIVATION_KEY, undefined);
        await this.context.globalState.update(LicenseManager.IS_PRO_KEY, false);
    }
}
exports.LicenseManager = LicenseManager;
LicenseManager.STORAGE_KEY = "aichain.licenseKey";
LicenseManager.ACTIVATION_KEY = "aichain.activationId";
LicenseManager.IS_PRO_KEY = "aichain.isPro";
//# sourceMappingURL=license.js.map