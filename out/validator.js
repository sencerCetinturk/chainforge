"use strict";
// Güvenlik doğrulama modülü
// Tüm kullanıcı girdileri buradan geçer
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateAgentKey = validateAgentKey;
exports.validateAgentName = validateAgentName;
exports.validateModel = validateModel;
exports.validateRole = validateRole;
exports.validateMaxRetries = validateMaxRetries;
exports.validateSystemPrompt = validateSystemPrompt;
exports.validateTaskKey = validateTaskKey;
exports.validateTaskDescription = validateTaskDescription;
exports.validateOpenRouterKey = validateOpenRouterKey;
exports.sanitizeString = sanitizeString;
exports.validateFallback = validateFallback;
exports.validateFilename = validateFilename;
// İzin verilen OpenRouter model formatı: "provider/model-name"
const ALLOWED_MODEL_PATTERN = /^[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-\.]+$/;
// İzin verilen key formatı: sadece harf, rakam, tire, alt çizgi
const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_\-]{1,50}$/;
// İzin verilen roller
const ALLOWED_ROLES = ["coding", "math", "routing", "long-coding", "fallback", "supervisor", "custom"];
// Maksimum değerler
const MAX_NAME_LENGTH = 100;
const MAX_SYSTEM_PROMPT_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_RETRIES = 5;
const MIN_RETRIES = 1;
function validateAgentKey(key) {
    if (!key || key.trim() === "")
        return { valid: false, error: "Key boş olamaz" };
    if (!SAFE_KEY_PATTERN.test(key))
        return { valid: false, error: "Key sadece harf, rakam, tire ve alt çizgi içerebilir (max 50 karakter)" };
    return { valid: true };
}
function validateAgentName(name) {
    if (!name || name.trim() === "")
        return { valid: false, error: "İsim boş olamaz" };
    if (name.length > MAX_NAME_LENGTH)
        return { valid: false, error: `İsim max ${MAX_NAME_LENGTH} karakter olabilir` };
    // Script injection kontrolü
    if (/<|>|script|javascript|eval|onclick/i.test(name))
        return { valid: false, error: "İsimde geçersiz karakterler var" };
    return { valid: true };
}
function validateModel(model) {
    if (!model || model.trim() === "")
        return { valid: false, error: "Model boş olamaz" };
    if (!ALLOWED_MODEL_PATTERN.test(model))
        return { valid: false, error: "Model formatı geçersiz. Örnek: minimax/minimax-m3" };
    return { valid: true };
}
function validateRole(role) {
    if (!ALLOWED_ROLES.includes(role))
        return { valid: false, error: `Geçersiz rol. İzin verilenler: ${ALLOWED_ROLES.join(", ")}` };
    return { valid: true };
}
function validateMaxRetries(retries) {
    if (isNaN(retries) || retries < MIN_RETRIES || retries > MAX_RETRIES) {
        return { valid: false, error: `maxRetries ${MIN_RETRIES}-${MAX_RETRIES} arasında olmalı` };
    }
    return { valid: true };
}
function validateSystemPrompt(prompt) {
    if (!prompt)
        return { valid: true }; // Opsiyonel
    if (prompt.length > MAX_SYSTEM_PROMPT_LENGTH)
        return { valid: false, error: `Sistem promptu max ${MAX_SYSTEM_PROMPT_LENGTH} karakter olabilir` };
    // Tehlikeli pattern kontrolü
    if (/<script|javascript:|eval\(|Function\(|setTimeout\(|setInterval\(/i.test(prompt)) {
        return { valid: false, error: "Sistem promptunda geçersiz içerik tespit edildi" };
    }
    return { valid: true };
}
function validateTaskKey(key) {
    return validateAgentKey(key); // Aynı kural
}
function validateTaskDescription(desc) {
    if (!desc || desc.trim() === "")
        return { valid: false, error: "Açıklama boş olamaz" };
    if (desc.length > MAX_DESCRIPTION_LENGTH)
        return { valid: false, error: `Açıklama max ${MAX_DESCRIPTION_LENGTH} karakter olabilir` };
    if (/<|>|script|javascript/i.test(desc))
        return { valid: false, error: "Açıklamada geçersiz karakterler var" };
    return { valid: true };
}
function validateOpenRouterKey(key) {
    if (!key || key.trim() === "")
        return { valid: false, error: "API key boş olamaz" };
    // OpenRouter key formatı: sk-or- ile başlar
    if (!key.startsWith("sk-or-") && !key.startsWith("sk-")) {
        return { valid: false, error: "Geçersiz OpenRouter API key formatı" };
    }
    if (key.length < 20 || key.length > 200)
        return { valid: false, error: "API key uzunluğu geçersiz" };
    return { valid: true };
}
function sanitizeString(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
}
function validateFallback(fallback, agents, currentKey) {
    if (!fallback)
        return { valid: true }; // Opsiyonel
    if (fallback === currentKey)
        return { valid: false, error: "Agent kendine fallback olamaz" };
    if (!agents[fallback])
        return { valid: false, error: `Fallback agent bulunamadı: ${fallback}` };
    return { valid: true };
}
function validateFilename(filename) {
    if (!filename || filename.trim() === "")
        return { valid: false, error: "Dosya adı boş olamaz" };
    // Path traversal koruması
    if (/[\/\\<>:"|?*]/.test(filename) || filename.includes("..")) {
        return { valid: false, error: "Dosya adında geçersiz karakterler var" };
    }
    if (filename.length > 100)
        return { valid: false, error: "Dosya adı max 100 karakter olabilir" };
    return { valid: true };
}
//# sourceMappingURL=validator.js.map