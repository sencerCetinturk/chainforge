"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UndoStore = void 0;
const vscode = require("vscode");
// "Geri Al" verisini diske kalıcı olarak saklar (ChangeLogger ile aynı desen).
// globalStorageUri/chainforge-logs/<workspaceKey>/undo/ altına her batch tam içerikle
// (revert için gerekli) yazılır. Workspace bağımsız — proje klasörü taşınsa/yeniden
// adlandırılsa bile geçmiş kaybolmaz, kullanıcının repo'suna ekstra klasör de eklenmez.
class UndoStore {
    constructor(context) {
        this.logDir = null;
        const folders = vscode.workspace.workspaceFolders;
        if (context && folders) {
            const wsKey = folders[0].uri.fsPath.replace(/[:\\/]/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(-80);
            this.logDir = vscode.Uri.joinPath(context.globalStorageUri, "chainforge-logs", wsKey, "undo");
        }
        else if (folders) {
            // Geriye dönük uyumluluk: context verilmezse eski (workspace-relative) davranış
            this.logDir = vscode.Uri.joinPath(folders[0].uri, ".chainforge", "logs", "undo");
        }
    }
    // Yeni bir batch kaydet. `cap` aşılırsa en eski kayıtlar silinir (free:1, pro:20).
    async push(batch, cap) {
        if (!this.logDir || batch.length === 0)
            return;
        await this.ensureDir();
        const fileUri = vscode.Uri.joinPath(this.logDir, await this.uniqueFileName());
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify({ timestamp: this.now(), changes: batch }, null, 2), "utf8"));
        await this.trimTo(cap);
    }
    // En son kaydedilen batch'i döner ve diskten SİLER (tekrar geri alınmasın diye).
    async popLatest() {
        const names = await this.sortedFileNames();
        if (names.length === 0)
            return null;
        const latest = names[names.length - 1];
        const uri = vscode.Uri.joinPath(this.logDir, latest);
        try {
            const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
            const parsed = JSON.parse(raw);
            await vscode.workspace.fs.delete(uri);
            return Array.isArray(parsed?.changes) ? parsed.changes : null;
        }
        catch {
            // Bozuk/okunamayan dosyayı temizle ki sonsuz döngüye girmesin
            try {
                await vscode.workspace.fs.delete(uri);
            }
            catch { /* yok say */ }
            return null;
        }
    }
    // Geride başka geri alınabilir kayıt var mı?
    async hasAny() {
        const names = await this.sortedFileNames();
        return names.length > 0;
    }
    async trimTo(cap) {
        const names = await this.sortedFileNames();
        if (names.length <= cap)
            return;
        const toDelete = names.slice(0, names.length - cap);
        for (const name of toDelete) {
            try {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.logDir, name));
            }
            catch { /* yok say */ }
        }
    }
    async sortedFileNames() {
        if (!this.logDir)
            return [];
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.logDir);
            return entries
                .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json"))
                .map(([name]) => name)
                .sort(); // dosya adları zaman damgalı → alfabetik sıra = kronolojik sıra
        }
        catch {
            return [];
        }
    }
    // Aynı saniyede birden fazla push olursa çakışmayı önler (changeLogger'daki desenle aynı)
    async uniqueFileName() {
        const base = this.tsToFileKey(this.now());
        let name = `${base}.json`;
        let counter = 1;
        while (this.logDir && await this.fileExists(vscode.Uri.joinPath(this.logDir, name))) {
            name = `${base}_${String(counter).padStart(2, "0")}.json`;
            counter++;
        }
        return name;
    }
    async fileExists(uri) {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        }
        catch {
            return false;
        }
    }
    async ensureDir() {
        if (this.logDir) {
            try {
                await vscode.workspace.fs.createDirectory(this.logDir);
            }
            catch { /* var */ }
        }
    }
    now() {
        return new Date().toISOString().split(".")[0];
    }
    tsToFileKey(iso) {
        return iso.replace("T", "_").replace(/:/g, "-");
    }
}
exports.UndoStore = UndoStore;
//# sourceMappingURL=undoStore.js.map