import * as vscode from "vscode";
import { AIRouter, AgentConfig } from "../router";
import { WorkspaceScanner } from "./workspaceScanner";
import { ChangeLogger } from "./changeLogger";
import { InspectionResult, InspectionIssue } from "./types";

// DENETMEN (Inspector)
// - Agentler bölümünde "supervisor" rolüyle tanımlanan AI'yı kullanır
// - İlk çalıştırma: TÜM dosyaları analiz eder
// - Sonraki: son kontrolden BERİ değişen dosyaları kontrol eder
// - Tek bir rapor dosyasına yazar (globalStorage/chainforge-logs/.../inspections/rapor_*.txt)
// - En yetkili agent'tır — sadece çıkılamaz durumda koda müdahale eder
export class Inspector {
  private logDir: vscode.Uri | null = null;
  private persistentErrorDir: vscode.Uri | null = null;
  private static LAST_CHECK_KEY = "chainforge.lastInspection";
  private agentKey: string | null = null;
  private agentConfig: AgentConfig | null = null;

  constructor(
    private router: AIRouter,
    private scanner: WorkspaceScanner,
    private changeLogger: ChangeLogger,
    private context: vscode.ExtensionContext,
    private log: (msg: string) => void,
    private onProgress?: (checked: number, total: number, currentFile: string) => void,
    private onPersistentErrors?: (persistentPaths: string[]) => void // Postacı'ya ping
  ) {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      const wsKey = folders[0].uri.fsPath.replace(/[:\\/]/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(-80);
      this.logDir = vscode.Uri.joinPath(context.globalStorageUri, "chainforge-logs", wsKey, "inspections");
      this.persistentErrorDir = vscode.Uri.joinPath(context.globalStorageUri, "chainforge-logs", wsKey, "persistent-errors");
    }
    // Agentler bölümünden denetmeni bul
    this.resolveAgent();
  }

  // Agentler bölümünde "supervisor" rolündeki AI'yı bul
  // Yoksa en yetkili agent'ı (tercihen supervisor > coding > ilk sıradaki) kullan
  private resolveAgent(): void {
    const config = this.router.getConfig();
    const agents = config.agents;

    // Öncelik sırası: supervisor rolü > custom rolünde "denet" içeren > ilk agent
    let bestKey: string | null = null;
    let bestAgent: AgentConfig | null = null;

    for (const [key, agent] of Object.entries(agents)) {
      if (agent.role === "supervisor") {
        bestKey = key;
        bestAgent = agent;
        break; // supervisor en yüksek öncelik
      }
    }

    if (!bestKey) {
      // supervisor yoksa, isminde "denet" geçen custom agent ara
      for (const [key, agent] of Object.entries(agents)) {
        const name = (agent.name || key).toLowerCase();
        if (agent.role === "custom" && (name.includes("denet") || name.includes("inspector"))) {
          bestKey = key;
          bestAgent = agent;
          break;
        }
      }
    }

    if (!bestKey) {
      // Hala yoksa, ilk agent'ı kullan
      const first = Object.entries(agents)[0];
      if (first) {
        bestKey = first[0];
        bestAgent = first[1];
      }
    }

    this.agentKey = bestKey;
    this.agentConfig = bestAgent;

    if (bestKey && bestAgent) {
      this.log(`   🔍 Denetmen: "${bestAgent.name || bestKey}" (${bestAgent.model})`);
    } else {
      this.log("   ⚠ Denetmen: Agent bulunamadı. Önce Agentler sekmesinden bir agent ekleyin.");
    }
  }

  // Ana giriş: ilk kez mi çalışıyor, yoksa inkremental mi?
  // forceFull=true → checkpoint'i yok sayar, tüm dosyaları tarar
  // Son denetim raporunun zaman damgasını bul (dosya sistemindeki loglardan)
  private async getLastInspectionTime(): Promise<string | null> {
    if (!this.logDir) return null;
    try {
      const files = await vscode.workspace.fs.readDirectory(this.logDir);
      let latest = "";
      // rapor_2026-06-04_11-47-25.txt
      for (const [name] of files) {
        const m = name.match(/^rapor_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.(txt|json)$/);
        if (m && m[1] > latest) latest = m[1];
      }
      if (latest) {
        // 2026-06-04_11-47-25 → 2026-06-04T11:47:25
        const [date, time] = latest.split("_");
        return `${date}T${time}`;
      }
    } catch { /* klasör yok */ }
    return null;
  }

  async inspect(forceFull = false): Promise<{ checked: number; errors: number; clean: number; results: InspectionResult[] }> {
    if (!this.agentConfig) {
      this.log("   ❌ Denetmen agent'ı bulunamadı. Agentler bölümüne bir supervisor ekleyin.");
      return { checked: 0, errors: 0, clean: 0, results: [] };
    }

    let filesToCheck: { path: string; content: string }[] = [];
    const allResults: InspectionResult[] = [];

    // Tüm workspace dosyalarını tara
    const all = await this.scanner.scanAll();
    const codeFiles = all.filter(f => this.isCodeFile(f.path));

    // Son denetim zamanını KENDİ LOG DOSYALARINDAN bul (globalState checkpoint değil)
    const lastCheck = forceFull ? null : await this.getLastInspectionTime();

    if (!lastCheck) {
      // İLK ÇALIŞTIRMA — tüm dosyaları analiz et
      this.log(`${codeFiles.length} dosya taranıyor…`);
      for (const f of codeFiles) {
        const content = await this.scanner.readFile(f.path);
        if (content !== null) filesToCheck.push({ path: f.path, content });
      }
    } else {
      // İNKREMENTAL — dosya sistemi mtime + loglara göre değişenleri bul
      const lastCheckMs = new Date(lastCheck).getTime();
      const changedPaths = new Set<string>();
      for (const f of codeFiles) {
        if (f.mtime > lastCheckMs) changedPaths.add(f.path);
      }
      const changeEntries = await this.changeLogger.readSince(lastCheck);
      // Log'dan en son içeriği al (disk yerine) — dosya silinmiş/taşınmış olsa bile çalışır
      const latestContentFromLog = new Map<string, string>();
      for (const e of changeEntries) {
        changedPaths.add(e.filePath);
        if (e.newContent) latestContentFromLog.set(e.filePath, e.newContent);
      }
      const prevErrors = await this.getRecentErrors(lastCheck);
      for (const pe of prevErrors) {
        if (pe.status === "error") changedPaths.add(pe.filePath);
      }
      this.log(`${changedPaths.size} değişen dosya taranıyor…`);
      for (const p of changedPaths) {
        // Önce log'dan al, yoksa diskten oku
        const content = latestContentFromLog.get(p) ?? await this.scanner.readFile(p);
        if (content !== null && content !== undefined) filesToCheck.push({ path: p, content });
      }
    }

    if (filesToCheck.length === 0) {
      this.log("   ✓ Kontrol edilecek yeni değişiklik yok.");
      this.onProgress?.(0, 0, "");
      return { checked: 0, errors: 0, clean: 0, results: [] };
    }

    let errorCount = 0, cleanCount = 0, checked = 0;
    for (const file of filesToCheck) {
      checked++;
      this.onProgress?.(checked, filesToCheck.length, file.path);
      const result = await this.inspectFile(file.path, file.content);
      allResults.push(result);
      if (result.status === "error") {
        errorCount++;
        this.log(`   ❌ ${file.path} — ${result.issues.length} sorun`);
      } else {
        cleanCount++;
        this.log(`   ✅ ${file.path} — temiz`);
      }
    }

    // Persistent hata tespiti: önceki raporda DA hatalı olan dosyalar → Postacı'ya ping
    if (lastCheck && allResults.length > 0) {
      await this.detectAndSavePersistentErrors(allResults, lastCheck);
    }

    return { checked: filesToCheck.length, errors: errorCount, clean: cleanCount, results: allResults };
  }

  // Tek dosyayı DENETMEN agent'ı (supervisor) ile analiz et
  private async inspectFile(path: string, content: string): Promise<InspectionResult> {
    if (!this.agentConfig || !this.agentKey) {
      return { timestamp: this.now(), filePath: path, status: "clean", issues: [] };
    }

    const numbered = content.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
    const ext = path.split(".").pop()?.toLowerCase() || "";

    // Denetmen agent'ın kendi system prompt'unu kullan
    // Agent'in system prompt'u zaten denetim talimatlarını içermeli
    const agentSystemPrompt = this.agentConfig.systemPrompt
      || "Sen kıdemli bir kod denetmenisin. Kod dosyalarını derinlemesine analiz et, GERÇEK sorunları bul.";

    const isTS = /^tsx?$/.test(ext);
    const isJS = /^jsx?$/.test(ext);
    const isPY = ext === "py";
    const isWeb = /^(html|css|scss|vue|svelte)$/.test(ext);

    const prompt = `Aşağıdaki kod dosyasını analiz et. GERÇEK sorunları bul — sözdizimi hataları, tip hataları, güvenlik açıkları, mantık hataları, eksik import, tanımsız referanslar.

DOSYA: ${path}
DİL: ${ext}

\`\`\`${ext}
${content}
\`\`\`

=== ANALİZ TALİMATLARI ===
Şu kategorilerde sorun ara (SADECE GERÇEK sorunları bildir, stil tercihlerini değil):

1. SÖZDİZİMİ: Eksik parantez, yanlış keyword, geçersiz sözdizimi
2. TİP HATALARI${isTS ? " (TypeScript — tip uyumsuzluğu, any kullanımı)" : ""}
3. TANIMSIZ REFERANSLAR: Tanımlanmamış değişken/fonksiyon/sınıf kullanımı
4. EKSİK İMPORT: Kullanılıp import edilmemiş bağımlılıklar
5. GÜVENLİK${isWeb ? " (XSS, innerHTML, eval)" : ""}: Injection riski, hassas veri sızıntısı (console.log ile şifre/token), eval kullanımı, hardcoded secret/key
6. BOŞ CATCH: try-catch'te boş catch, hatayı yutan kod
7. ASENKRON HATALARI: await eksik, Promise zinciri kopuk
8. PERFORMANS: Gereksiz döngü, büyük veri kopyalama, N+1 problemi
9. MANTIK HATALARI: Yanlış koşul, null/undefined kontrolü eksik, off-by-one

KURALLAR:
- Stil/biçim (boşluk, girinti, tırnak tipi) SORUN SAYMA
- SADECE çalışmayı bozacak veya güvenlik riski oluşturacak şeyleri bildir
- Her bulgu için satır numarası ve hatanın NE OLDUĞUNU yaz
- Emin değilsen bildirme
- Sorun yoksa status: "clean" ve boş issues dizisi

SADECE JSON formatında yanıtla (başka hiçbir şey yazma):
{
  "status": "clean" veya "error",
  "issues": [
    {
      "line": satır_numarası,
      "severity": "error" veya "warning",
      "code": "sorunlu satırın tam metni",
      "message": "Sorunun açıklaması ve düzeltme önerisi"
    }
  ]
}`;

    // Agent'i router üzerinden çağır (kendi modeli ve system prompt'uyla)
    const res = await this.router.runFromAgent(this.agentKey, prompt);
    if (res.success && res.content.trim()) {
      const parsed = this.extractJson(res.content);
      if (parsed) {
        const issues: InspectionIssue[] = Array.isArray(parsed.issues) ? parsed.issues : [];
        return {
          timestamp: this.now(),
          filePath: path,
          status: (parsed.status === "error" || issues.length > 0) ? "error" : "clean",
          issues,
        };
      }
      // JSON parse edilemedi — AI düzgün formatta yanıt vermedi
      this.log(`   ⚠ ${path}: AI JSON formatında yanıt vermedi. İlk 200 karakter: "${res.content.substring(0, 200)}"`);
      return {
        timestamp: this.now(),
        filePath: path,
        status: "error",
        issues: [{
          line: 1,
          severity: "warning",
          code: "",
          message: `Denetmen AI JSON formatında yanıt vermedi. Model: ${this.agentConfig?.model}. Prompt'u güncelleyin veya farklı bir denetmen modeli seçin.`,
        }],
      };
    }

    // API çağrısı başarısız
    this.log(`   ⚠ ${path}: Denetmen API hatası — ${res.error || "bilinmeyen"}. Model: ${this.agentConfig?.model}`);

    // Fallback dene
    if (this.agentConfig?.fallback) {
      this.log(`   → Fallback deneniyor: ${this.agentConfig.fallback}`);
      const fbRes = await this.router.runFromAgent(this.agentConfig.fallback, prompt);
      if (fbRes.success && fbRes.content.trim()) {
        const parsed = this.extractJson(fbRes.content);
        if (parsed) {
          const issues: InspectionIssue[] = Array.isArray(parsed.issues) ? parsed.issues : [];
          return {
            timestamp: this.now(),
            filePath: path,
            status: (parsed.status === "error" || issues.length > 0) ? "error" : "clean",
            issues,
          };
        }
      }
      this.log(`   ⚠ Fallback de başarısız oldu.`);
    }

    // Hiçbir şekilde analiz edilemedi → bunu bir hata olarak raporla
    return {
      timestamp: this.now(),
      filePath: path,
      status: "error",
      issues: [{
        line: 1,
        severity: "error",
        code: "",
        message: `DENETMEN ANALİZ EDEMEDİ. Model "${this.agentConfig?.model}" çağrısı başarısız oldu: ${res.error || "bilinmeyen hata"}. Agentler bölümünden Denetmen'in modelini değiştirin.`,
      }],
    };
  }

  // Tüm denetim sonuçlarını TEK BİR rapor dosyasına yaz
  // Format: okunabilir düz metin + JSON (başka AI'ların okuyabileceği şekilde)
  async writeInspectionReport(
    results: InspectionResult[],
    summary: { checked: number; errors: number; clean: number }
  ): Promise<string | null> {
    if (!this.logDir) return null;
    try { await vscode.workspace.fs.createDirectory(this.logDir); } catch { /* var */ }

    const ts = this.now();
    const tsFile = ts.replace("T", "_").replace(/:/g, "-");
    const reportPath = vscode.Uri.joinPath(this.logDir, `rapor_${tsFile}.txt`);
    const jsonPath = vscode.Uri.joinPath(this.logDir, `rapor_${tsFile}.json`);

    const agentName = this.agentConfig?.name || "Denetmen";
    const agentModel = this.agentConfig?.model || "?";

    // === DÜZ METİN RAPOR (insan + AI okuması için) ===
    const lines: string[] = [];
    lines.push("=".repeat(70));
    lines.push(`CHAINFORGE DENETİM RAPORU`);
    lines.push(`Tarih: ${ts}`);
    lines.push(`Denetmen: ${agentName} (${agentModel})`);
    lines.push(`Özet: ${summary.checked} dosya tarandı — ${summary.errors} hatalı, ${summary.clean} temiz`);
    lines.push("=".repeat(70));
    lines.push("");

    const errorFiles = results.filter(r => r.status === "error");
    const cleanFiles = results.filter(r => r.status === "clean");

    if (errorFiles.length > 0) {
      lines.push(`┌${"─".repeat(68)}┐`);
      lines.push(`│ HATALI DOSYALAR (${errorFiles.length} adet)`.padEnd(70) + "│");
      lines.push(`└${"─".repeat(68)}┘`);
      lines.push("");

      for (const r of errorFiles) {
        lines.push(`▸ DOSYA: ${r.filePath}`);
        lines.push(`  Durum: ❌ HATALI — ${r.issues.length} sorun tespit edildi`);
        lines.push(`  ${"─".repeat(60)}`);

        for (let i = 0; i < r.issues.length; i++) {
          const iss = r.issues[i];
          const sevIcon = iss.severity === "error" ? "🔴" : "🟡";
          lines.push(`  ${sevIcon} Sorun #${i + 1} — Satır ${iss.line} [${iss.severity.toUpperCase()}]`);
          lines.push(`     Açıklama: ${iss.message}`);
          if (iss.code) {
            lines.push(`     Kod     : ${iss.code.trim()}`);
          }
          lines.push("");
        }
        lines.push("");
      }
    }

    if (cleanFiles.length > 0) {
      lines.push(`┌${"─".repeat(68)}┐`);
      lines.push(`│ TEMİZ DOSYALAR (${cleanFiles.length} adet)`.padEnd(70) + "│");
      lines.push(`└${"─".repeat(68)}┘`);
      for (const r of cleanFiles) {
        lines.push(`  ✅ ${r.filePath} — Temiz, sorun bulunamadı`);
      }
      lines.push("");
    }

    lines.push("=".repeat(70));
    lines.push(`RAPOR SONU — ${ts}`);
    lines.push(`Denetmen: ${agentName} (${agentModel})`);
    lines.push("=".repeat(70));

    const reportText = lines.join("\n");
    await vscode.workspace.fs.writeFile(reportPath, Buffer.from(reportText, "utf8"));

    // === JSON RAPOR (programatik erişim için) ===
    const jsonReport = {
      timestamp: ts,
      denetmen: { name: agentName, model: agentModel },
      summary: { checked: summary.checked, errors: summary.errors, clean: summary.clean },
      files: results.map(r => ({
        path: r.filePath,
        status: r.status,
        issueCount: r.issues.length,
        issues: r.issues.map(iss => ({
          line: iss.line,
          severity: iss.severity,
          code: iss.code,
          message: iss.message,
        })),
      })),
    };
    await vscode.workspace.fs.writeFile(jsonPath, Buffer.from(JSON.stringify(jsonReport, null, 2), "utf8"));

    return reportText;
  }

  // Önceki raporda DA hatalı olan dosyaları persistent-errors/ klasörüne yaz ve Postacı'ya ping at
  private async detectAndSavePersistentErrors(currentResults: InspectionResult[], lastCheck: string): Promise<void> {
    if (!this.persistentErrorDir || !this.logDir) return;

    // Önceki rapordan hatalı dosyaları oku — lastCheck'TEN ÖNCEKİ en son raporu bul
    const prevErrorPaths = new Set<string>();
    try {
      const files = await vscode.workspace.fs.readDirectory(this.logDir);
      const sinceKey = lastCheck.replace("T", "_").replace(/:/g, "-");
      let prevReport = "";
      for (const [name] of files) {
        const m = name.match(/^rapor_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < sinceKey && m[1] > prevReport) prevReport = m[1];
      }
      if (prevReport) {
        const uri = vscode.Uri.joinPath(this.logDir, `rapor_${prevReport}.json`);
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        const parsed = JSON.parse(raw);
        for (const f of (parsed.files || [])) {
          if (f.status === "error") prevErrorPaths.add(f.path);
        }
      }
    } catch {
      return;
    }
    if (prevErrorPaths.size === 0) return;

    // Hem önceki hem bu denetimde hatalı olan dosyalar → persistent (kalıcı)
    const persistent = currentResults.filter(r => r.status === "error" && prevErrorPaths.has(r.filePath));
    if (persistent.length === 0) return;

    this.log(`\n⚠ ${persistent.length} kalıcı hata tespit edildi (önceki denetimden beri giderilmemiş):`);
    for (const p of persistent) this.log(`   🔴 ${p.filePath}`);

    try { await vscode.workspace.fs.createDirectory(this.persistentErrorDir); } catch { /* var */ }
    const ts = this.now().replace("T", "_").replace(/:/g, "-");
    const entry = {
      timestamp: this.now(),
      detectedAt: ts,
      files: persistent.map(r => ({ path: r.filePath, issueCount: r.issues.length, issues: r.issues })),
    };
    const uri = vscode.Uri.joinPath(this.persistentErrorDir, `persistent_${ts}.json`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(entry, null, 2), "utf8"));
    this.log(`   📁 Kalıcı hata raporu: ${uri.fsPath}`);

    // Postacı'ya ping at
    const paths = persistent.map(r => r.filePath);
    this.onPersistentErrors?.(paths);
  }

  // Son kontrolden beri kayıtlı hataları oku
  async getRecentErrors(sinceTimestamp?: string): Promise<InspectionResult[]> {
    if (!this.logDir) return [];
    const results: InspectionResult[] = [];
    const sinceKey = sinceTimestamp ? sinceTimestamp.replace("T", "_").replace(/:/g, "-") : "";
    try {
      const files = await vscode.workspace.fs.readDirectory(this.logDir);
      for (const [name, type] of files) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
        if (sinceKey && name.split("__")[0] <= sinceKey) continue;
        const uri = vscode.Uri.joinPath(this.logDir, name);
        try {
          results.push(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8")));
        } catch { /* atla */ }
      }
    } catch { /* klasör yok */ }
    return results;
  }

  resetCheckpoint(): void {
    this.context.globalState.update(Inspector.LAST_CHECK_KEY, undefined);
  }

  private isCodeFile(path: string): boolean {
    return /\.(js|ts|jsx|tsx|py|java|cpp|c|h|hpp|cs|go|rs|rb|php|vue|svelte|html|css|scss|json)$/i.test(path);
  }

  private now(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private extractJson(text: string): any {
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const raw = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}
