import { AIRouter } from "../router";
import { WorkspaceScanner, ScannedFile } from "./workspaceScanner";
import { ChangeLogger } from "./changeLogger";
import {
  TaskPlan, CollectedKnowledge, FileChange, OrchestratorResult
} from "./types";

// POSTACI (Orchestrator)
// Akış:
// 1. Workspace'i tarar, ilgili dosyaları bulur
// 2. Planlama: araştırma/matematik gerekli mi, hangi dosyalar?
// 3. Gerekiyorsa araştırma (web :online) + matematik bilgisi toplar
// 4. Tüm bilgi + dosya içerikleriyle kod yazan AI'ya promptu verir
// 5. AI yanıtını FileChange[] olarak parse eder
export class Orchestrator {
  // POSTACI ücretsiz modellerle çalışır — biri başarısızsa sıradakini dener
  private postmanModels: string[];

  constructor(
    private router: AIRouter,
    private scanner: WorkspaceScanner,
    private log: (msg: string) => void,
    postmanModel?: string,
    private changeLogger?: ChangeLogger  // Geçmiş farkındalığı için
  ) {
    // Config'de routing rolünde agent varsa onun modelini öne al
    const routingAgent = this.router.findAgentByRole("routing");
    const cfg = this.router.getConfig();
    const preferred = postmanModel || (routingAgent ? cfg.agents[routingAgent]?.model : undefined);

    // Ücretsiz model fallback zinciri (provider hatalarına karşı dayanıklı)
    this.postmanModels = [
      ...(preferred ? [preferred] : []),
      "qwen/qwen3-coder:free",
      "openai/gpt-oss-120b:free",
      "z-ai/glm-4.5-air:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ];
  }

  // Postacı çağrısı — ücretsiz modeller arasında otomatik fallback
  private async postmanCall(systemPrompt: string, userPrompt: string, online = false): Promise<{ success: boolean; content: string; model: string; error?: string }> {
    let lastErr = "";
    for (const model of this.postmanModels) {
      const res = await this.router.callDirect(model, systemPrompt, userPrompt, online);
      if (res.success && res.content.trim()) {
        return { success: true, content: res.content, model };
      }
      lastErr = res.error || "boş yanıt";
      this.log(`   ⚠ ${model} başarısız (${lastErr}), sıradaki deneniyor...`);
    }
    return { success: false, content: "", model: "", error: lastErr };
  }

  async run(userPrompt: string, codingTaskType: string): Promise<OrchestratorResult> {
    const knowledge: CollectedKnowledge[] = [];

    // --- 1. Workspace tara ---
    const allFiles = await this.scanner.scanAll();
    const relevant = this.scanner.rankByRelevance(allFiles, userPrompt, 15);

    // --- 2. Planlama (ücretsiz model) ---
    const plan = await this.makePlan(userPrompt, relevant, allFiles);
    this.log(`Plan: ${plan.targetFiles.join(", ") || "yeni dosya"}`);

    // --- 3a. Araştırma (gerekirse) ---
    if (plan.needsResearch) {
      const q = plan.searchQuery || userPrompt;
      const res = await this.postmanCall(
        "Sen bir araştırmacısın. Güncel, doğru ve özet bilgi topla.",
        `Şu konuda güncel bilgi topla:\n${q}`,
        true
      );
      if (res.success) {
        knowledge.push({ source: "research", agentKey: "postman", model: res.model, content: res.content });
        this.log(`Araştırma tamamlandı`);
      }
    }

    // --- 3b. Matematik/uzman (gerekirse) ---
    // "math" rolü tanımlıysa o uzmana sor. Tanımlı DEĞİLSE iş coding agent'a devredilir
    // (kod yazan AI hesaplamayı da kendi yapar). Denetmen (supervisor) burada KULLANILMAZ.
    let codingExtra = "";
    if (plan.needsMath) {
      const mathAgent = this.router.findAgentByRole("math");
      if (mathAgent) {
        const res = await this.router.runFromAgent(mathAgent, `Şu görev için gerekli matematik/fizik/mantık hesaplarını yap, sonuçları net ver:\n${userPrompt}`);
        if (res.success) {
          knowledge.push({ source: "math", agentKey: res.usedAgent, model: res.usedModel, content: res.content });
          this.log(`Uzman görüşü alındı`);
        }
      } else {
        // math rolü yok → görevi kod yazan AI üstlenir
        codingExtra += "\n\n[EK GÖREV] Bu iş matematik/hesaplama gerektiriyor ama uzman tanımlı değil. Gerekli tüm hesapları KENDİN yap, doğrula ve koda doğru şekilde yansıt.";
        this.log("Hesaplama, kod yazan AI'ya devredildi");
      }
    }

    // --- 4. İlgili dosya içeriklerini oku ---
    const fileContents: { path: string; content: string }[] = [];
    for (const fp of plan.targetFiles) {
      const content = await this.scanner.readFile(fp);
      if (content !== null) fileContents.push({ path: fp, content });
    }

    // --- 4b. GEÇMİŞ FARKINDALIĞI: bu dosyalarda daha önce yapılan değişiklikleri oku ---
    let historyContext = "";
    if (this.changeLogger && plan.targetFiles.length > 0) {
      const past = await this.changeLogger.getRecentForFiles(plan.targetFiles, 2);
      if (past.length > 0) {
        this.log(`Hafıza: ${past.length} önceki değişiklik dikkate alınıyor`);
        historyContext = "\n=== BU DOSYALARDA ÖNCEKİ DEĞİŞİKLİKLER (hafıza) ===\n";
        for (const p of past) {
          historyContext += `[${p.timestamp}] ${p.filePath}: ${p.intent} (+${p.linesAdded}/-${p.linesRemoved} satır)\n`;
        }
        historyContext += "Bu geçmişi dikkate al — önceki çalışmayı tekrar bozma, tutarlı devam et.\n";
      }
    }

    // --- 5. Postacı, uzman kod AI'sına görevi iletir (AI dosya görmez, sadece kod üretir) ---
    const task = this.router.getConfig().tasks[codingTaskType];
    const codingStart = task?.primary || this.router.findAgentByRole("coding");
    if (!codingStart) {
      return { success: false, error: "Kod yazacak agent bulunamadı", knowledge, changes: [], codingAgent: "", codingModel: "", attempts: [] };
    }
    const codingModel = this.router.getConfig().agents[codingStart]?.model || "?";
    this.log(`Kod üretiliyor (${codingModel})…`);

    // Agent'ın rolünü al ve promptu rolüne göre özelleştir
    const codingAgent = this.router.getConfig().agents[codingStart];
    const agentRole = codingAgent?.role || "coding";
    const codingPrompt = this.buildCodingPrompt(userPrompt, plan, knowledge, fileContents, agentRole) + historyContext + codingExtra;
    const codeRes = await this.router.runFromAgent(codingStart, codingPrompt);
    if (!codeRes.success) {
      return { success: false, error: codeRes.error, knowledge, changes: [], codingAgent: codeRes.usedAgent, codingModel: codeRes.usedModel, attempts: codeRes.attempts };
    }

    // --- 6. Yanıt parse edilir (dosya yazımı asistanın işi) ---
    const changes = this.parseChanges(codeRes.content, fileContents);
    if (changes.length === 0) {
      this.log(`Yanıt işlenemedi — model beklenen formatı kullanmadı.`);
    } else {
      this.log(`${changes.length} dosya hazırlandı`);
    }

    return {
      success: true,
      plan,
      knowledge,
      changes,
      codingAgent: codeRes.usedAgent,
      codingModel: codeRes.usedModel,
      attempts: codeRes.attempts,
      rawResponse: codeRes.content,
    };
  }

  // Planlama: POSTACI (ücretsiz model) JSON formatında plan üretir
  private async makePlan(userPrompt: string, relevant: ScannedFile[], all: ScannedFile[]): Promise<TaskPlan> {
    const fileList = relevant.map(f => `- ${f.path} (${f.language})`).join("\n");

    const planPrompt = `Kullanıcı isteği: "${userPrompt}"

Workspace'teki mevcut dosyalar:
${fileList || "(boş workspace)"}

Şu JSON formatında yanıtla (SADECE JSON, başka hiçbir şey yazma):
{
  "intent": "isteğin tek cümlelik özeti",
  "needsResearch": false,
  "needsMath": false,
  "searchQuery": null,
  "targetFiles": ["oluşturulacak veya düzenlenecek TÜM dosya yolları"]
}

Kurallar:
- Kullanıcı yeni dosya istiyorsa targetFiles'a o yolu ekle (örn "utils/string.js").
- Mevcut dosya değişecekse onu da ekle.
- Sadece güncel/internet bilgisi gerekiyorsa needsResearch=true.
- Sadece hesaplama/formül gerekiyorsa needsMath=true.`;

    const res = await this.postmanCall(
      "Sen bir görev planlayıcı postacısın. Sadece geçerli JSON döndürürsün.",
      planPrompt
    );

    if (res.success) {
      const parsed = this.extractJson(res.content);
      if (parsed) {
        let targets = Array.isArray(parsed.targetFiles) ? parsed.targetFiles : [];
        // Plan dosya bulamadıysa prompttan çıkar
        if (targets.length === 0) targets = this.extractFilesFromPrompt(userPrompt);
        this.log(`   ✓ Plan hazır (${res.model}).`);
        return {
          needsResearch: !!parsed.needsResearch,
          needsMath: !!parsed.needsMath,
          targetFiles: targets,
          intent: parsed.intent || userPrompt,
          searchQuery: parsed.searchQuery || undefined,
        };
      }
      this.log(`   ⚠ Plan JSON parse edilemedi, basit moda geçiliyor.`);
    } else {
      this.log(`   ⚠ Tüm ücretsiz modeller başarısız, basit moda geçiliyor.`);
    }

    // FALLBACK: prompttan dosya adlarını çıkar, yoksa alakalı dosyaları kullan
    const fromPrompt = this.extractFilesFromPrompt(userPrompt);
    const targets = fromPrompt.length > 0 ? fromPrompt : relevant.slice(0, 3).map(f => f.path);
    return { needsResearch: false, needsMath: false, targetFiles: targets, intent: userPrompt };
  }

  // Prompt içinden dosya yollarını yakala (örn "calculator.js", "utils/string.js")
  private extractFilesFromPrompt(prompt: string): string[] {
    const matches = prompt.match(/[\w\-./]+\.[a-zA-Z][a-zA-Z0-9]{0,4}\b/g) || [];
    // Geçerli uzantılı, yol gibi görünenleri al
    const valid = matches.filter(m => /\.(js|ts|jsx|tsx|py|java|cpp|c|h|cs|go|rs|rb|php|html|css|scss|json|md|vue|svelte|sql|sh|yml|yaml)$/i.test(m));
    return Array.from(new Set(valid));
  }

  // Kod yazan AI'ya verilecek tam promptu kur
  private buildCodingPrompt(
    userPrompt: string,
    plan: TaskPlan,
    knowledge: CollectedKnowledge[],
    files: { path: string; content: string }[],
    agentRole: string = "coding"
  ): string {
    let p = "";

    // Agent rolüne göre görev tanımını özelleştir
    switch (agentRole) {
      case "supervisor":
        p = `Sen kıdemli bir yazılım mimarı ve kod denetçisisin. Aşağıdaki kodu DERİNLEMESİNE incele.

GÖREV: ${userPrompt}
NİYET: ${plan.intent}

DENETİM TALİMATLARI:
1. MİMARİ: SOLID, katmanlı yapı, bağımlılık yönetimi
2. GÜVENLİK: Injection, XSS, hassas veri sızıntısı, yetkilendirme
3. PERFORMANS: Gereksiz işlemler, algoritma karmaşıklığı, bellek kullanımı
4. HATA YÖNETİMİ: Eksik validasyon, boş catch, sessiz hatalar
5. KOD KALİTESİ: DRY ihlalleri, sihirli sayılar, aşırı karmaşıklık
6. TİP GÜVENLİĞİ: any kullanımı, eksik tipler, tip daraltma sorunları

Her bulgu için satır numarası, sorun açıklaması ve düzeltme önerisi ver.
`;
        break;

      case "math":
        p = `Sen bir matematik ve algoritma uzmanısın. Aşağıdaki problemi çöz.

GÖREV: ${userPrompt}
NİYET: ${plan.intent}

TALİMATLAR:
1. Hesaplamalarını ADIM ADIM göster
2. Formülleri açıkça yaz
3. Sonucu net bir şekilde belirt
4. Gerekirse alternatif çözüm yollarını da göster
`;
        break;

      case "routing":
        p = `Sen bir görev yönlendirme uzmanısın. Aşağıdaki isteği analiz et ve en uygun yaklaşımı belirle.

GÖREV: ${userPrompt}
NİYET: ${plan.intent}

TALİMATLAR:
1. İsteğin karmaşıklığını değerlendir
2. Hangi teknolojilerin/bilgilerin gerektiğini belirle
3. En uygun çözüm stratejisini öner
4. Gerekirse araştırma yapılması gereken konuları listele
`;
        break;

      default: // coding, long-coding, fallback, custom
        p = `Sen uzman bir yazılım geliştiricisin. Aşağıdaki görevi yerine getir.

GÖREV: ${userPrompt}
NİYET: ${plan.intent}
`;
        break;
    }

    if (knowledge.length > 0) {
      p += `\n=== TOPLANAN BİLGİ ===\n`;
      for (const k of knowledge) {
        p += `[${k.source.toUpperCase()} - ${k.model}]\n${k.content}\n\n`;
      }
    }

    if (files.length > 0) {
      p += `\n=== MEVCUT DOSYALAR ===\n`;
      for (const f of files) {
        p += `\n--- DOSYA: ${f.path} ---\n${f.content}\n`;
      }
    }

    p += `
=== ÇIKTI FORMATI (ÇOK ÖNEMLİ) ===
Her dosya için AYNEN şu formatı kullan, başka HİÇBİR ŞEY yazma:

<<<FILE: dosya/yolu.uzanti | ACTION: create>>>
(buraya dosyanın TAM ve EKSİKSİZ içeriğini yaz — markdown kod bloğu KULLANMA, doğrudan kod yaz)
<<<END>>>

KESİN KURALLAR:
1. Her dosya <<<FILE: ...>>> ile başlar, <<<END>>> ile biter.
2. İçeriği \`\`\` ile SARMA — doğrudan kodu yaz.
3. Dosyanın TAMAMINI yaz, "..." veya "değişmeyen kısım" gibi kısaltma YAPMA.
4. Mevcut dosyayı düzenliyorsan ACTION: modify, yeni dosyaysa ACTION: create.
5. <<<FILE>>> blokları dışında açıklama, selamlama, özet YAZMA.
6. Görevi TEK SEFERDE eksiksiz tamamla — kodu yarım bırakma.

ÖRNEK:
<<<FILE: hello.js | ACTION: create>>>
function hello() {
  console.log("Merhaba");
}
module.exports = { hello };
<<<END>>>`;

    return p;
  }

  // AI yanıtından dosya bloklarını parse et — birden fazla format desteklenir
  private parseChanges(response: string, originals: { path: string; content: string }[]): FileChange[] {
    const changes: FileChange[] = [];
    let m: RegExpExecArray | null;

    // Format 0 (EN SAĞLAM): <<<FILE: path [| ACTION: x]>>> ...içerik... <<<END>>>
    // ``` fence opsiyonel — içerik fence'li de fence'siz de yakalanır
    const fmt0 = /<<<FILE:\s*([^|>\n]+?)\s*(?:\|\s*ACTION:\s*(create|modify|delete)\s*)?>>>([\s\S]*?)<<<END>>>/gi;
    while ((m = fmt0.exec(response)) !== null) {
      const path = m[1].trim();
      const action = (m[2]?.trim() as any) || "create";
      let content = m[3];
      // İçerik ```dil ... ``` ile sarılıysa fence'i soy
      const fenced = content.match(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/);
      if (fenced) content = fenced[1];
      content = content.replace(/^\n+/, "").replace(/\n+$/, "\n");
      this.addChange(changes, path, action, content, originals);
    }
    if (changes.length > 0) return changes;

    // Format 2: ## FILE: path\n```...```  veya  // FILE: path\n```...```
    const fmt2 = /(?:##\s*FILE:|\/\/\s*FILE:|FILE:)\s*([^\n]+)\n```[a-zA-Z0-9]*\n?([\s\S]*?)```/gi;
    while ((m = fmt2.exec(response)) !== null) {
      this.addChange(changes, m[1].trim(), "create", m[2], originals);
    }
    if (changes.length > 0) return changes;

    // Format 3: ```typescript (ilk satırda yorum olarak dosya adı)
    //            // utils/math.js   veya  # utils/math.py
    const fmt3 = /```[a-zA-Z0-9]*\n(?:\/\/|#)\s*([^\n]+\.[a-zA-Z0-9]+)\n([\s\S]*?)```/gi;
    while ((m = fmt3.exec(response)) !== null) {
      this.addChange(changes, m[1].trim(), "create", m[2], originals);
    }
    if (changes.length > 0) return changes;

    // Format 4: Sadece bir kod bloğu varsa ve plan'da hedef dosya varsa oraya yaz
    const singleBlock = /```[a-zA-Z0-9]*\n([\s\S]+?)```/;
    const sb = singleBlock.exec(response);
    if (sb && originals.length === 1) {
      this.addChange(changes, originals[0].path, "modify", sb[1], originals);
    }

    return changes;
  }

  private addChange(
    changes: FileChange[],
    filePath: string,
    action: "create" | "modify" | "delete",
    newContent: string,
    originals: { path: string; content: string }[]
  ) {
    const original = originals.find(o => o.path === filePath);
    changes.push({
      filePath,
      action: original ? "modify" : action,
      originalContent: original?.content,
      newContent: newContent.replace(/\r\n/g, "\n"),
      description: original ? `${filePath} güncelleniyor` : `${filePath} oluşturuluyor`,
    });
  }

  private extractJson(text: string): any {
    // ```json ... ``` veya çıplak { ... } bul
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const raw = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}
