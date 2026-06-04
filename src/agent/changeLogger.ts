import * as vscode from "vscode";
import { ChangeLogEntry, FileChange } from "./types";

// Değişiklikleri git-diff mantığında, tarih-saat damgalı loglar.
// .chainforge/logs/changes/ klasörüne JSON + okunabilir diff yazar.
export class ChangeLogger {
  private logDir: vscode.Uri | null = null;

  constructor() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      this.logDir = vscode.Uri.joinPath(folders[0].uri, ".chainforge", "logs", "changes");
    }
  }

  // Tek bir dosya değişikliğini logla
  async log(change: FileChange, agentKey: string, model: string, intent: string): Promise<ChangeLogEntry | null> {
    if (!this.logDir) return null;

    const diff = this.makeUnifiedDiff(
      change.filePath,
      change.originalContent || "",
      change.newContent
    );
    const { added, removed } = this.countLines(change.originalContent || "", change.newContent);

    const entry: ChangeLogEntry = {
      timestamp: this.now(),
      filePath: change.filePath,
      action: change.action,
      agentKey,
      model,
      linesAdded: added,
      linesRemoved: removed,
      diff,
      intent,
    };

    await this.ensureDir();
    // HER DEĞİŞİKLİK AYRI DOSYA — ad: YYYY-MM-DD_HH-mm-ss__hedefDosya.json
    // Denetmen dosya ADINDAN hem ZAMANI hem HANGİ DOSYANIN değiştiğini görür (açmadan).
    const fileName = await this.uniqueFileName(change.filePath);
    const fileUri = vscode.Uri.joinPath(this.logDir, fileName);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(entry, null, 2), "utf8"));

    return entry;
  }

  // GEÇMİŞ FARKINDALIĞI: belirli dosyalar için en son değişiklikleri getir.
  // Postacı, AI'ya "bu dosyada daha önce şunu değiştirdin" bağlamı verir.
  async getRecentForFiles(filePaths: string[], maxPerFile = 2): Promise<ChangeLogEntry[]> {
    if (!this.logDir || filePaths.length === 0) return [];
    const wanted = new Set(filePaths);
    const all: ChangeLogEntry[] = [];
    try {
      const files = await vscode.workspace.fs.readDirectory(this.logDir);
      // En yeni dosyalar önce (ad = timestamp, ters sırala)
      const names = files
        .filter(([n, t]) => t === vscode.FileType.File && n.endsWith(".json"))
        .map(([n]) => n)
        .sort()
        .reverse();
      const perFileCount: Record<string, number> = {};
      for (const name of names) {
        if (all.length >= filePaths.length * maxPerFile) break;
        const uri = vscode.Uri.joinPath(this.logDir, name);
        try {
          const e: ChangeLogEntry = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
          if (!wanted.has(e.filePath)) continue;
          perFileCount[e.filePath] = (perFileCount[e.filePath] || 0);
          if (perFileCount[e.filePath] >= maxPerFile) continue;
          perFileCount[e.filePath]++;
          all.push(e);
        } catch { /* atla */ }
      }
    } catch { /* klasör yok */ }
    return all;
  }

  // Son kontrolden BERİ değişen log dosyalarını oku.
  // Önce dosya ADLARINI (timestamp) süzer — sadece ilgili dosyaları açar, hepsini değil.
  async readSince(sinceTimestamp: string): Promise<ChangeLogEntry[]> {
    if (!this.logDir) return [];
    const entries: ChangeLogEntry[] = [];
    // sinceTimestamp ISO ("2026-06-04T14:30:25") → dosya adı formatına ("2026-06-04_14-30-25")
    const sinceFileKey = this.tsToFileKey(sinceTimestamp);
    try {
      const files = await vscode.workspace.fs.readDirectory(this.logDir);
      for (const [name, type] of files) {
        if (type !== vscode.FileType.File || !name.endsWith(".json")) continue;
        // Dosya adından timestamp anahtarını al — "__" ayıracından önceki kısım
        // ör: "2026-06-04_14-30-25__calculator-js.json" → "2026-06-04_14-30-25"
        const fileKey = name.split("__")[0];
        // İçeriği AÇMADAN ada göre filtrele — denetmenin optimizasyonu
        if (fileKey <= sinceFileKey) continue;
        const uri = vscode.Uri.joinPath(this.logDir, name);
        try {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
          entries.push(JSON.parse(raw));
        } catch { /* bozuk dosyayı atla */ }
      }
    } catch { /* klasör yoksa boş */ }
    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ISO timestamp → dosya adı sıralama anahtarı
  private tsToFileKey(iso: string): string {
    return iso.replace("T", "_").replace(/:/g, "-");
  }

  // Çakışmayan dosya adı: ZAMAN__hedefDosya.json
  private async uniqueFileName(targetPath: string): Promise<string> {
    const base = this.now().replace("T", "_").replace(/:/g, "-"); // 2026-06-04_14-30-25
    // Hedef dosya yolunu dosya-adı-güvenli hale getir (calculator.js → calculator-js)
    const safeTarget = targetPath.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9_.\-]/g, "_").replace(/\./g, "-");
    let name = `${base}__${safeTarget}.json`;
    let counter = 1;
    while (this.logDir && await this.fileExists(vscode.Uri.joinPath(this.logDir, name))) {
      name = `${base}__${safeTarget}_${String(counter).padStart(2, "0")}.json`;
      counter++;
    }
    return name;
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
  }

  // Basit unified diff üretici (harici bağımlılık yok)
  private makeUnifiedDiff(path: string, oldStr: string, newStr: string): string {
    const oldLines = oldStr.split("\n");
    const newLines = newStr.split("\n");
    const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

    // Basit satır-bazlı LCS olmadan, blok karşılaştırma:
    // değişen ilk ve son satırı bul, aradakini diff olarak göster
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
      start++;
    }
    let endOld = oldLines.length - 1;
    let endNew = newLines.length - 1;
    while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
      endOld--; endNew--;
    }

    out.push(`@@ -${start + 1},${endOld - start + 1} +${start + 1},${endNew - start + 1} @@`);
    for (let i = start; i <= endOld; i++) out.push(`-${oldLines[i]}`);
    for (let i = start; i <= endNew; i++) out.push(`+${newLines[i]}`);

    return out.join("\n");
  }

  private countLines(oldStr: string, newStr: string): { added: number; removed: number } {
    const oldSet = oldStr.split("\n");
    const newSet = newStr.split("\n");
    let start = 0;
    while (start < oldSet.length && start < newSet.length && oldSet[start] === newSet[start]) start++;
    let endOld = oldSet.length - 1, endNew = newSet.length - 1;
    while (endOld >= start && endNew >= start && oldSet[endOld] === newSet[endNew]) { endOld--; endNew--; }
    return { added: Math.max(0, endNew - start + 1), removed: Math.max(0, endOld - start + 1) };
  }

  private now(): string {
    // YYYY-MM-DDTHH:mm:ss (yerel saat, saniye hassasiyetinde)
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private async ensureDir(): Promise<void> {
    if (!this.logDir) return;
    try { await vscode.workspace.fs.createDirectory(this.logDir); } catch { /* zaten var */ }
  }
}
