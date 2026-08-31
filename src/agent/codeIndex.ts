import * as vscode from "vscode";
import { ScannedFile, WorkspaceScanner } from "./workspaceScanner";
import { CodeHeader, extractHeaders } from "./codeHeaders";

export { CodeHeader, extractHeaders };

interface CachedFileEntry {
  mtime: number;
  headers: CodeHeader[];
}

// Postacı'nın dosyaları "rahat bulabilmesi" için hafif bir kod indeksi:
// her dosyadaki fonksiyon/sınıf/metod başlıklarını, hangi dosyada ve hangi
// satırda olduklarıyla birlikte kaydeder. AI çağrısı gerektirmez (regex tabanlı,
// bkz. codeHeaders.ts), bu yüzden ücretsizdir — planlama promptuna ucuz bir
// "harita" olarak eklenir.
export class CodeIndexStore {
  private storageUri: vscode.Uri | null = null;
  private cache: Record<string, CachedFileEntry> = {};
  private loaded = false;

  constructor(context?: vscode.ExtensionContext) {
    const folders = vscode.workspace.workspaceFolders;
    if (context && folders) {
      const wsKey = folders[0].uri.fsPath.replace(/[:\\/]/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(-80);
      this.storageUri = vscode.Uri.joinPath(context.globalStorageUri, "chainforge-logs", wsKey, "code-index.json");
    }
  }

  // Dosya listesine bakıp değişmeyenler için önbelleği kullanır, değişen/yeni dosyalar
  // için yeniden regex taraması yapar. AI çağrısı YOK — tamamen yerel ve ücretsiz.
  async getOrBuild(files: ScannedFile[], scanner: WorkspaceScanner): Promise<CodeHeader[]> {
    await this.ensureLoaded();
    const headers: CodeHeader[] = [];
    let rebuiltCount = 0;

    const seenPaths = new Set<string>();
    for (const f of files) {
      seenPaths.add(f.path);
      const cached = this.cache[f.path];
      if (cached && cached.mtime === f.mtime) {
        headers.push(...cached.headers);
        continue;
      }
      const content = await scanner.readFile(f.path);
      if (content === null) continue;
      const fileHeaders = extractHeaders(f.path, content);
      this.cache[f.path] = { mtime: f.mtime, headers: fileHeaders };
      headers.push(...fileHeaders);
      rebuiltCount++;
    }

    // Artık var olmayan dosyaları önbellekten temizle
    for (const path of Object.keys(this.cache)) {
      if (!seenPaths.has(path)) delete this.cache[path];
    }

    if (rebuiltCount > 0) await this.save();
    return headers;
  }

  // Postacı'nın elindeki (önbellekten gelen) başlık bilgisinin, dosyanın O ANKİ (taze
  // okunmuş) içeriğiyle hâlâ tutarlı olup olmadığını doğrular. Kod ChainForge dışından
  // (kullanıcı tarafından elle) değiştirilmiş olabilir — mtime kontrolü normalde bunu
  // yakalar, ama aynı çalışma (run) içinde dosya sonradan değişmişse ya da mtime bir
  // şekilde güncellenmemişse, önbellekteki satır/isim bilgisi artık yanlış olabilir.
  // Böyle bir uyuşmazlık bulunursa (kayıtlı satırda artık o isim yoksa) dosya için
  // başlıklar anında yeniden çıkarılır — AI çağrısı yok, tamamen yerel ve ücretsiz.
  async verifyAndRefresh(filePath: string, freshContent: string): Promise<CodeHeader[]> {
    await this.ensureLoaded();
    const cached = this.cache[filePath];
    const lines = freshContent.replace(/\r\n/g, "\n").split("\n");

    if (cached && cached.headers.length > 0) {
      const stillValid = cached.headers.every(h => {
        const lineText = lines[h.line - 1];
        return lineText !== undefined && lineText.includes(h.name);
      });
      if (stillValid) return cached.headers;
    }

    // Önbellek yok ya da artık geçersiz (satır kaymış/isim eşleşmiyor) → yeniden tara.
    const fresh = extractHeaders(filePath, freshContent);
    this.cache[filePath] = { mtime: cached?.mtime ?? Date.now(), headers: fresh };
    await this.save();
    return fresh;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.storageUri) { this.loaded = true; return; }
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(this.storageUri)).toString("utf8");
      this.cache = JSON.parse(raw) || {};
    } catch {
      this.cache = {};
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    if (!this.storageUri) return;
    try {
      const dir = vscode.Uri.joinPath(this.storageUri, "..");
      try { await vscode.workspace.fs.createDirectory(dir); } catch { /* var */ }
      await vscode.workspace.fs.writeFile(this.storageUri, Buffer.from(JSON.stringify(this.cache), "utf8"));
    } catch { /* kaydedilemezse sessizce devam — index sadece bir optimizasyon, kritik değil */ }
  }
}
