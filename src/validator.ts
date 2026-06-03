// Güvenlik doğrulama modülü
// Tüm kullanıcı girdileri buradan geçer

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

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

export function validateAgentKey(key: string): ValidationResult {
  if (!key || key.trim() === "") return { valid: false, error: "Key boş olamaz" };
  if (!SAFE_KEY_PATTERN.test(key)) return { valid: false, error: "Key sadece harf, rakam, tire ve alt çizgi içerebilir (max 50 karakter)" };
  return { valid: true };
}

export function validateAgentName(name: string): ValidationResult {
  if (!name || name.trim() === "") return { valid: false, error: "İsim boş olamaz" };
  if (name.length > MAX_NAME_LENGTH) return { valid: false, error: `İsim max ${MAX_NAME_LENGTH} karakter olabilir` };
  // Script injection kontrolü
  if (/<|>|script|javascript|eval|onclick/i.test(name)) return { valid: false, error: "İsimde geçersiz karakterler var" };
  return { valid: true };
}

export function validateModel(model: string): ValidationResult {
  if (!model || model.trim() === "") return { valid: false, error: "Model boş olamaz" };
  if (!ALLOWED_MODEL_PATTERN.test(model)) return { valid: false, error: "Model formatı geçersiz. Örnek: minimax/minimax-m3" };
  return { valid: true };
}

export function validateRole(role: string): ValidationResult {
  if (!ALLOWED_ROLES.includes(role)) return { valid: false, error: `Geçersiz rol. İzin verilenler: ${ALLOWED_ROLES.join(", ")}` };
  return { valid: true };
}

export function validateMaxRetries(retries: number): ValidationResult {
  if (isNaN(retries) || retries < MIN_RETRIES || retries > MAX_RETRIES) {
    return { valid: false, error: `maxRetries ${MIN_RETRIES}-${MAX_RETRIES} arasında olmalı` };
  }
  return { valid: true };
}

export function validateSystemPrompt(prompt: string): ValidationResult {
  if (!prompt) return { valid: true }; // Opsiyonel
  if (prompt.length > MAX_SYSTEM_PROMPT_LENGTH) return { valid: false, error: `Sistem promptu max ${MAX_SYSTEM_PROMPT_LENGTH} karakter olabilir` };
  // Tehlikeli pattern kontrolü
  if (/<script|javascript:|eval\(|Function\(|setTimeout\(|setInterval\(/i.test(prompt)) {
    return { valid: false, error: "Sistem promptunda geçersiz içerik tespit edildi" };
  }
  return { valid: true };
}

export function validateTaskKey(key: string): ValidationResult {
  return validateAgentKey(key); // Aynı kural
}

export function validateTaskDescription(desc: string): ValidationResult {
  if (!desc || desc.trim() === "") return { valid: false, error: "Açıklama boş olamaz" };
  if (desc.length > MAX_DESCRIPTION_LENGTH) return { valid: false, error: `Açıklama max ${MAX_DESCRIPTION_LENGTH} karakter olabilir` };
  if (/<|>|script|javascript/i.test(desc)) return { valid: false, error: "Açıklamada geçersiz karakterler var" };
  return { valid: true };
}

export function validateOpenRouterKey(key: string): ValidationResult {
  if (!key || key.trim() === "") return { valid: false, error: "API key boş olamaz" };
  // OpenRouter key formatı: sk-or- ile başlar
  if (!key.startsWith("sk-or-") && !key.startsWith("sk-")) {
    return { valid: false, error: "Geçersiz OpenRouter API key formatı" };
  }
  if (key.length < 20 || key.length > 200) return { valid: false, error: "API key uzunluğu geçersiz" };
  return { valid: true };
}

export function sanitizeString(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function validateFallback(fallback: string, agents: { [key: string]: any }, currentKey: string): ValidationResult {
  if (!fallback) return { valid: true }; // Opsiyonel
  if (fallback === currentKey) return { valid: false, error: "Agent kendine fallback olamaz" };
  if (!agents[fallback]) return { valid: false, error: `Fallback agent bulunamadı: ${fallback}` };
  return { valid: true };
}

export function validateFilename(filename: string): ValidationResult {
  if (!filename || filename.trim() === "") return { valid: false, error: "Dosya adı boş olamaz" };
  // Path traversal koruması
  if (/[\/\\<>:"|?*]/.test(filename) || filename.includes("..")) {
    return { valid: false, error: "Dosya adında geçersiz karakterler var" };
  }
  if (filename.length > 100) return { valid: false, error: "Dosya adı max 100 karakter olabilir" };
  return { valid: true };
}
