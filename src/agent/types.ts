// ChainForge Agent Sistemi — Ortak Tipler

// Postacı'nın bir görevi nasıl ele alacağına dair plan
export interface TaskPlan {
  needsResearch: boolean;        // Web/AI araştırması gerekli mi?
  needsMath: boolean;            // Matematik/fizik uzmanı gerekli mi?
  targetFiles: string[];         // Düzenlenecek dosyalar (workspace-relative)
  intent: string;                // Kullanıcının ne istediğinin özeti
  searchQuery?: string;          // Araştırma sorgusu
  // MALİYET OPTİMİZASYONU: var olan dosyalar için (varsa) sadece ilgili birebir kod alıntısı.
  // Coding agent'a dosyanın TAMAMI yerine sadece bu blok gönderilir. Bulunamazsa/doğrulanamazsa
  // o dosya için tam-dosya moduna güvenle düşülür (bkz. orchestrator.ts: findExcerptFor).
  fileExcerpts?: { path: string; excerpt: string }[];
}

// Bir AI'dan toplanan ön bilgi (araştırma/matematik sonucu)
export interface CollectedKnowledge {
  source: "research" | "math" | "specialist";
  agentKey: string;
  model: string;
  content: string;
}

// Tek bir dosya değişikliği önerisi
export interface FileChange {
  filePath: string;              // workspace-relative
  action: "create" | "modify" | "delete";
  originalContent?: string;      // değişiklik öncesi (modify/delete için)
  newContent: string;            // yeni içerik (create/modify için)
  description: string;           // ne yapıldığının kısa açıklaması
}

// Postacı'nın tam görev sonucu
export interface OrchestratorResult {
  success: boolean;
  error?: string;
  plan?: TaskPlan;
  knowledge: CollectedKnowledge[];
  changes: FileChange[];
  codingAgent: string;           // kodu yazan agent key
  codingModel: string;
  attempts: string[];            // denenen agent zinciri
  rawResponse?: string;          // AI'nın ham yanıtı (debug)
  flowEvents?: import("../telemetry").FlowStepEvent[]; // hangi model/agent ne amaçla çalıştı (telemetri için)
}

// Change log girdisi (git-diff mantığı)
export interface ChangeLogEntry {
  timestamp: string;             // ISO 8601, saniye hassasiyetinde
  filePath: string;
  action: "create" | "modify" | "delete";
  agentKey: string;
  model: string;
  linesAdded: number;
  linesRemoved: number;
  diff: string;                  // unified diff metni
  newContent?: string;           // tam yeni içerik (Denetmen dosya silinmiş/taşınmış olsa bile analiz edebilsin diye)
  intent: string;                // bu değişikliği tetikleyen istek
}

// Denetmen'in bir dosya için bulgu kaydı
export interface InspectionResult {
  timestamp: string;
  filePath: string;
  status: "clean" | "error" | "warning";
  issues: InspectionIssue[];
  checkedLineRange?: { start: number; end: number }; // inkremental kontrolde
}

export interface InspectionIssue {
  line: number;
  severity: "error" | "warning";
  code: string;                  // hatalı kod satırı
  message: string;               // hata açıklaması
}
