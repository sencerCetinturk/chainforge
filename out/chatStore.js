"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatStore = void 0;
const vscode = require("vscode");
// PROJE BAZLI SOHBET DEPOSU
// Her workspace (proje) kendi sohbet geçmişini tutar — local, kalıcı.
// Panel kapanıp açılınca geçmiş geri yüklenir.
class ChatStore {
    constructor(context) {
        this.context = context;
    }
    // Aktif workspace'i temsil eden anahtar (proje yoksa "global")
    currentKey() {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : "__global__";
    }
    all() {
        return this.context.globalState.get(ChatStore.KEY, {});
    }
    // Bu projenin sohbet geçmişini getir
    get() {
        return this.all()[this.currentKey()] || [];
    }
    // Bu projenin sohbetini kaydet (son 200 mesaj)
    save(messages) {
        const data = this.all();
        data[this.currentKey()] = messages.slice(-200);
        return Promise.resolve(this.context.globalState.update(ChatStore.KEY, data));
    }
    // Bu projenin sohbetini temizle
    clearCurrent() {
        const data = this.all();
        delete data[this.currentKey()];
        return Promise.resolve(this.context.globalState.update(ChatStore.KEY, data));
    }
    // TÜM projelerin sohbetlerini temizle
    clearAll() {
        return Promise.resolve(this.context.globalState.update(ChatStore.KEY, {}));
    }
    // Kaç proje, kaç mesaj (ayarlar için özet)
    summary() {
        const data = this.all();
        const keys = Object.keys(data);
        let total = 0;
        for (const k of keys)
            total += (data[k] || []).length;
        return {
            projectCount: keys.length,
            totalMessages: total,
            currentCount: (data[this.currentKey()] || []).length,
        };
    }
}
exports.ChatStore = ChatStore;
ChatStore.KEY = "chainforge.chats";
//# sourceMappingURL=chatStore.js.map