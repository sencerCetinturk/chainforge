import * as vscode from "vscode";

export interface ScannedFile {
  path: string;        // workspace-relative
  fullPath: string;    // absolute
  language: string;
  size: number;
  mtime: number;       // son değişiklik zamanı (ms timestamp)
}

// Taranmayacak klasör/dosya kalıpları
const IGNORE_PATTERNS = [
  "**/node_modules/**", "**/.git/**", "**/out/**", "**/dist/**",
  "**/build/**", "**/.vscode/**", "**/*.min.js", "**/*.map",
  "**/package-lock.json", "**/yarn.lock", "**/.chainforge/**",
  "**/.aichain.json", "**/.git/**", "**/*.lock",
];

export class WorkspaceScanner {
  // Workspace'teki tüm kod dosyalarını listele
  async scanAll(maxFiles = 500): Promise<ScannedFile[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];

    const exclude = `{${IGNORE_PATTERNS.join(",")}}`;
    const uris = await vscode.workspace.findFiles("**/*", exclude, maxFiles);

    const files: ScannedFile[] = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 200_000) continue; // 200KB üstü atla
        const rel = vscode.workspace.asRelativePath(uri);
        files.push({
          path: rel,
          fullPath: uri.fsPath,
          language: this.langFromPath(rel),
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch { /* erişilemeyen dosyayı atla */ }
    }
    return files;
  }

  // Bir dosyanın içeriğini oku
  async readFile(relativePath: string): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return null;
    try {
      const uri = vscode.Uri.joinPath(folders[0].uri, relativePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  }

  // Prompttaki anahtar kelimelere göre en alakalı dosyaları skorla
  // (Postacı'ya hangi dosyaları okuyacağına dair ipucu verir)
  rankByRelevance(files: ScannedFile[], prompt: string, limit = 15): ScannedFile[] {
    const keywords = this.extractKeywords(prompt);
    const scored = files.map(f => {
      let score = 0;
      const lowerPath = f.path.toLowerCase();
      for (const kw of keywords) {
        if (lowerPath.includes(kw)) score += 10;          // dosya adında geçiyor
        const baseName = lowerPath.split(/[\\/]/).pop() || "";
        if (baseName.includes(kw)) score += 5;            // sadece dosya adı
      }
      return { file: f, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.file);
  }

  private extractKeywords(prompt: string): string[] {
    return prompt
      .toLowerCase()
      .replace(/[^a-z0-9çğıöşü\s]/gi, " ")
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 20);
  }

  private langFromPath(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
      ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
      py: "python", java: "java", cpp: "cpp", c: "c", h: "cpp", hpp: "cpp",
      cs: "csharp", go: "go", rs: "rust", rb: "ruby", php: "php",
      html: "html", css: "css", scss: "scss", json: "json", md: "markdown",
      yaml: "yaml", yml: "yaml", xml: "xml", sql: "sql", sh: "shellscript",
    };
    return map[ext] || "plaintext";
  }
}
