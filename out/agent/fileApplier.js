"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileApplier = void 0;
const vscode = require("vscode");
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
        const uri = vscode.Uri.joinPath(folders[0].uri, change.filePath);
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