import * as vscode from "vscode";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

// PROJE BAZLI SOHBET DEPOSU
// Her workspace (proje) kendi sohbet geçmişini tutar — local, kalıcı.
// Panel kapanıp açılınca geçmiş geri yüklenir.
export class ChatStore {
  private static KEY = "chainforge.chats";

  constructor(private context: vscode.ExtensionContext) {}

  // Aktif workspace'i temsil eden anahtar (proje yoksa "global")
  private currentKey(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : "__global__";
  }

  private all(): Record<string, ChatMsg[]> {
    return this.context.globalState.get<Record<string, ChatMsg[]>>(ChatStore.KEY, {});
  }

  // Bu projenin sohbet geçmişini getir
  get(): ChatMsg[] {
    return this.all()[this.currentKey()] || [];
  }

  // Bu projenin sohbetini kaydet (son 200 mesaj)
  save(messages: ChatMsg[]): Promise<void> {
    const data = this.all();
    data[this.currentKey()] = messages.slice(-200);
    return Promise.resolve(this.context.globalState.update(ChatStore.KEY, data));
  }

  // Bu projenin sohbetini temizle
  clearCurrent(): Promise<void> {
    const data = this.all();
    delete data[this.currentKey()];
    return Promise.resolve(this.context.globalState.update(ChatStore.KEY, data));
  }

  // TÜM projelerin sohbetlerini temizle
  clearAll(): Promise<void> {
    return Promise.resolve(this.context.globalState.update(ChatStore.KEY, {}));
  }

  // Kaç proje, kaç mesaj (ayarlar için özet)
  summary(): { projectCount: number; totalMessages: number; currentCount: number } {
    const data = this.all();
    const keys = Object.keys(data);
    let total = 0;
    for (const k of keys) total += (data[k] || []).length;
    return {
      projectCount: keys.length,
      totalMessages: total,
      currentCount: (data[this.currentKey()] || []).length,
    };
  }
}
