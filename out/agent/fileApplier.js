"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileApplier = void 0;
const vscode = require("vscode");
const path = require("path");
const child_process_1 = require("child_process");
const validator_1 = require("../validator");
// Dosya değişikliklerini kullanıcı onayıyla uygular (Claude Code mantığı).
// Her değişiklik için diff önizlemesi gösterir, onay ister.
class FileApplier {
    // Tek bir değişikliği onaylat ve uygula
    async applyWithApproval(change, autoApprove = false) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            vscode.window.showErrorMessage("ChainForge: Açık bir workspace yok.");
            return false;
        }
        // GÜVENLİK: orchestrator zaten filtreliyor ama burada da (defense-in-depth) doğrula —
        // hem AI çıktısı doğrudan bu fonksiyona geldiyse hem de gelecekte yeni bir çağıran eklenirse korunmuş olsun
        const pathCheck = (0, validator_1.validateRelativeFilePath)(change.filePath);
        const root = folders[0].uri.fsPath;
        const uri = vscode.Uri.joinPath(folders[0].uri, change.filePath);
        const resolved = path.normalize(uri.fsPath);
        const withinRoot = resolved === root || resolved.startsWith(root + path.sep);
        if (!pathCheck.valid || !withinRoot) {
            vscode.window.showErrorMessage(`ChainForge: "${change.filePath}" workspace dışına çıktığı için engellendi.`);
            return false;
        }
        if (!autoApprove) {
            const approved = await this.showApprovalDialog(change, uri);
            if (!approved)
                return false;
        }
        try {
            switch (change.action) {
                case "create":
                case "modify": {
                    // Klasör yolu yoksa oluştur
                    const dir = vscode.Uri.joinPath(uri, "..");
                    try {
                        await vscode.workspace.fs.createDirectory(dir);
                    }
                    catch { /* var */ }
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(change.newContent, "utf8"));
                    break;
                }
                case "delete": {
                    await vscode.workspace.fs.delete(uri);
                    break;
                }
            }
            return true;
        }
        catch (err) {
            vscode.window.showErrorMessage(`ChainForge: ${change.filePath} uygulanamadı — ${err?.message}`);
            return false;
        }
    }
    // Birden fazla değişikliği toplu onaylat
    async applyBatch(changes) {
        const applied = [];
        const skipped = [];
        if (changes.length === 0)
            return { applied, skipped };
        // GÜVEN: commit edilmemiş değişiklikler üzerine sessizce yazmayalım — kullanıcıyı uyar
        const dirty = await this.isGitWorkspaceDirty();
        if (dirty) {
            const autoCheckpoint = vscode.workspace.getConfiguration("chainforge").get("autoCheckpoint", false);
            if (autoCheckpoint) {
                const committed = await this.createCheckpointCommit();
                if (committed) {
                    vscode.window.showInformationMessage("ChainForge: Mevcut değişiklikler otomatik bir checkpoint commit'ine kaydedildi.");
                }
                else {
                    const proceed = await vscode.window.showWarningMessage("Workspace'te commit edilmemiş git değişiklikleri var ve otomatik checkpoint başarısız oldu. ChainForge bunların üzerine yazabilir.\nYine de devam edilsin mi?", { modal: true }, "Devam Et");
                    if (proceed !== "Devam Et")
                        return { applied, skipped: changes };
                }
            }
            else {
                const proceed = await vscode.window.showWarningMessage("Workspace'te commit edilmemiş git değişiklikleri var. ChainForge bunların üzerine yazabilir.\nYine de devam edilsin mi?", { modal: true }, "Devam Et");
                if (proceed !== "Devam Et")
                    return { applied, skipped: changes };
            }
        }
        // Toplu onay seçeneği sun
        const choice = await vscode.window.showInformationMessage(`ChainForge ${changes.length} dosyada değişiklik önerdi.`, { modal: true }, "Her birini incele", "Tümünü uygula", "İptal");
        if (choice === "İptal" || !choice) {
            return { applied, skipped: changes };
        }
        const autoAll = choice === "Tümünü uygula";
        for (const change of changes) {
            const ok = await this.applyWithApproval(change, autoAll);
            if (ok)
                applied.push(change);
            else
                skipped.push(change);
        }
        return { applied, skipped };
    }
    // Workspace'te commit edilmemiş git değişikliği var mı? Git yoksa/repo değilse sessizce false döner.
    async isGitWorkspaceDirty() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders)
            return false;
        const cwd = folders[0].uri.fsPath;
        return new Promise(resolve => {
            (0, child_process_1.exec)("git status --porcelain", { cwd, timeout: 5000 }, (err, stdout) => {
                if (err)
                    return resolve(false); // git yok veya repo değil → engelleme
                resolve(stdout.trim().length > 0);
            });
        });
    }
    // Mevcut (henüz commit edilmemiş) değişiklikleri kullanıcı adına tek bir "checkpoint"
    // commit'i olarak kaydeder — ChainForge'un kendi değişiklikleri bunun ÜZERİNE gelir, böylece
    // kullanıcının kendi işi kaybolmaz ve gerekirse `git reset --soft HEAD~1` ile tek adımda
    // geri dönülebilir. Sadece "chainforge.autoCheckpoint" ayarı açıkken çalışır (varsayılan kapalı).
    async createCheckpointCommit() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders)
            return false;
        const cwd = folders[0].uri.fsPath;
        const run = (cmd) => new Promise(resolve => {
            (0, child_process_1.exec)(cmd, { cwd, timeout: 10000 }, (err) => resolve(!err));
        });
        const added = await run("git add -A");
        if (!added)
            return false;
        return run(`git commit -m "chainforge: checkpoint (ajan görevinden önce otomatik)"`);
    }
    // Az önce uygulanan bir batch'i geri al (oturum içi "undo" — kalıcı log'dan bağımsız).
    // create → sil, modify → eski içeriği geri yaz, delete → eski içeriği yeniden oluştur.
    async revertBatch(changes) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders)
            return { reverted: 0, failed: changes.map(c => c.filePath) };
        const root = folders[0].uri.fsPath;
        let reverted = 0;
        const failed = [];
        for (const change of changes) {
            const pathCheck = (0, validator_1.validateRelativeFilePath)(change.filePath);
            const uri = vscode.Uri.joinPath(folders[0].uri, change.filePath);
            const resolved = path.normalize(uri.fsPath);
            const withinRoot = resolved === root || resolved.startsWith(root + path.sep);
            if (!pathCheck.valid || !withinRoot) {
                failed.push(change.filePath);
                continue;
            }
            try {
                if (change.action === "create") {
                    await vscode.workspace.fs.delete(uri);
                }
                else if (change.action === "modify") {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(change.originalContent ?? "", "utf8"));
                }
                else if (change.action === "delete") {
                    const dir = vscode.Uri.joinPath(uri, "..");
                    try {
                        await vscode.workspace.fs.createDirectory(dir);
                    }
                    catch { /* var */ }
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(change.originalContent ?? "", "utf8"));
                }
                reverted++;
            }
            catch {
                failed.push(change.filePath);
            }
        }
        return { reverted, failed };
    }
    // Diff önizlemesi göster ve onay al
    async showApprovalDialog(change, uri) {
        const actionLabel = change.action === "create" ? "Oluştur"
            : change.action === "delete" ? "Sil" : "Düzenle";
        // Modify/Create için diff editörü aç (kullanıcı görsel inceleyebilir)
        if (change.action !== "delete") {
            await this.openDiffPreview(change, uri);
        }
        const choice = await vscode.window.showWarningMessage(`${actionLabel}: ${change.filePath}\n${change.description}`, { modal: true }, "Uygula", "Atla");
        return choice === "Uygula";
    }
    // Mevcut içerikle yeni içeriği yan yana göster
    async openDiffPreview(change, uri) {
        try {
            const original = change.originalContent ?? "";
            // Geçici sanal doküman içerikleri ile diff aç
            const leftDoc = await vscode.workspace.openTextDocument({
                content: original, language: this.langFromPath(change.filePath)
            });
            const rightDoc = await vscode.workspace.openTextDocument({
                content: change.newContent, language: this.langFromPath(change.filePath)
            });
            await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, `${change.filePath} (Mevcut ↔ Önerilen)`, { preview: true });
        }
        catch { /* diff açılamazsa sessizce devam */ }
    }
    langFromPath(path) {
        const ext = path.split(".").pop()?.toLowerCase() || "";
        const map = {
            ts: "typescript", js: "javascript", py: "python", java: "java",
            cpp: "cpp", cs: "csharp", go: "go", rs: "rust", html: "html",
            css: "css", json: "json", md: "markdown",
        };
        return map[ext] || "plaintext";
    }
}
exports.FileApplier = FileApplier;
//# sourceMappingURL=fileApplier.js.map