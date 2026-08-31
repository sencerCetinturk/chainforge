"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Orchestrator = void 0;
const validator_1 = require("../validator");
// POSTACI (Orchestrator)
// Akış:
// 1. Workspace'i tarar, ilgili dosyaları bulur
// 2. Planlama: araştırma/matematik gerekli mi, hangi dosyalar?
// 3. Gerekiyorsa araştırma (web :online) + matematik bilgisi toplar
// 4. Tüm bilgi + dosya içerikleriyle kod yazan AI'ya promptu verir
// 5. AI yanıtını FileChange[] olarak parse eder
class Orchestrator {
    constructor(router, scanner, log, postmanModel, changeLogger, // Geçmiş farkındalığı için
    codeIndexStore // Postacı'nın dosya/satır konumlarını "rahat bulması" için
    ) {
        this.router = router;
        this.scanner = scanner;
        this.log = log;
        this.changeLogger = changeLogger;
        this.codeIndexStore = codeIndexStore;
        this.flowEvents = [];
        this.routingAgentKeys = this.router.findAllAgentsByRole("routing");
        const cfg = this.router.getConfig();
        // Ek ücretsiz model belirtilmişse (ör: test) zincirin başına ekle
        const extraFree = postmanModel && postmanModel.endsWith(":free") ? [postmanModel] : [];
        this.freeModels = [
            ...extraFree,
            "qwen/qwen3-coder:free",
            "openai/gpt-oss-120b:free",
            "z-ai/glm-4.5-air:free",
            "meta-llama/llama-3.3-70b-instruct:free",
        ];
        if (this.routingAgentKeys.length > 0) {
            const names = this.routingAgentKeys.map((k, i) => `#${i + 1} "${cfg.agents[k]?.name || k}"`).join(" → ");
            this.log(`   🔀 Postacı sırası: ${names}`);
        }
    }
    // Postacı çağrısı — önce routing agent'ları sırayla, sonra ücretsiz modeller arasında otomatik fallback
    async postmanCall(systemPrompt, userPrompt, online = false) {
        // 1) Routing agent'ları öncelik sırasına göre dene
        for (const agentKey of this.routingAgentKeys) {
            const agentName = this.router.getConfig().agents[agentKey]?.name || agentKey;
            const t0 = Date.now();
            const res = await this.router.runFromAgent(agentKey, userPrompt, online);
            this.flowEvents.push({
                step: "routing_agent", model: res.usedModel, agentKey, agentName,
                purpose: userPrompt.slice(0, 100), success: res.success && !!res.content.trim(),
                durationMs: Date.now() - t0, failReason: res.success ? undefined : (res.error || "boş yanıt"),
            });
            if (res.success && res.content.trim()) {
                return { success: true, content: res.content, model: res.usedModel };
            }
            this.log(`   ⚠ Routing agent "${agentName}" başarısız (${res.error || "boş yanıt"}), sıradaki deneniyor...`);
        }
        // 2) Ücretsiz model fallback zinciri
        let lastErr = "";
        for (const model of this.freeModels) {
            const t0 = Date.now();
            const res = await this.router.callDirect(model, systemPrompt, userPrompt, online);
            this.flowEvents.push({
                step: "free_model", model, purpose: userPrompt.slice(0, 100),
                success: res.success && !!res.content.trim(), durationMs: Date.now() - t0,
                failReason: res.success ? undefined : (res.error || "boş yanıt"),
                handoffTo: res.success ? "result" : "next_model",
            });
            if (res.success && res.content.trim()) {
                return { success: true, content: res.content, model };
            }
            lastErr = res.error || "boş yanıt";
            this.log(`   ⚠ ${model} başarısız (${lastErr}), sıradaki deneniyor...`);
        }
        return { success: false, content: "", model: "", error: lastErr };
    }
    async run(userPrompt, codingTaskType) {
        const knowledge = [];
        const flowEvents = [];
        const recordFlow = (e) => flowEvents.push(e);
        // --- 1. Workspace tara ---
        const allFiles = await this.scanner.scanAll();
        const relevant = this.scanner.rankByRelevance(allFiles, userPrompt, 15);
        // --- 1b. KOD İNDEKSİ: hangi fonksiyon/sınıf hangi dosyada + satırda — AI çağrısı yok,
        // tamamen yerel/ücretsiz. Postacı'nın dosya/konum bulmasını kolaylaştırır, planlama
        // promptuna ucuz bir "harita" olarak eklenir.
        let codeHeaders = [];
        if (this.codeIndexStore) {
            codeHeaders = await this.codeIndexStore.getOrBuild(relevant, this.scanner);
            if (codeHeaders.length > 0) {
                this.log(`   📇 Kod indeksi: ${relevant.length} dosyada ${codeHeaders.length} sembol`);
            }
        }
        // --- 2. Planlama (ücretsiz model) ---
        const plan = await this.makePlan(userPrompt, relevant, allFiles, codeHeaders);
        this.log(`Plan: ${plan.targetFiles.join(", ") || "yeni dosya"}`);
        // --- 3a. Araştırma (gerekirse) ---
        if (plan.needsResearch) {
            const q = plan.searchQuery || userPrompt;
            const t0r = Date.now();
            const res = await this.postmanCall("Sen bir araştırmacısın. Güncel, doğru ve özet bilgi topla.", `Şu konuda güncel bilgi topla:\n${q}`, true);
            recordFlow({
                step: "research", model: res.model, purpose: `Araştırma: ${q.slice(0, 80)}`,
                success: res.success, durationMs: Date.now() - t0r, failReason: res.error,
                handoffTo: res.success ? "coding_agent" : undefined,
            });
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
            }
            else {
                // math rolü yok → görevi kod yazan AI üstlenir
                codingExtra += "\n\n[EK GÖREV] Bu iş matematik/hesaplama gerektiriyor ama uzman tanımlı değil. Gerekli tüm hesapları KENDİN yap, doğrula ve koda doğru şekilde yansıt.";
                this.log("Hesaplama, kod yazan AI'ya devredildi");
            }
        }
        // --- 4. İlgili dosya içeriklerini oku ---
        const fileContents = [];
        for (const fp of plan.targetFiles) {
            const content = await this.scanner.readFile(fp);
            if (content !== null)
                fileContents.push({ path: fp, content });
        }
        // --- 4a. Kod indeksini, dosyanın O ANKİ (taze okunmuş) içeriğiyle doğrula. Kod elle
        // (ChainForge dışından) değiştirilmiş olabilir — bu durumda önbellekteki satır/isim
        // bilgisi artık yanlış olabilir. Böyle bir uyuşmazlık bulunursa o dosya için başlıklar
        // anında yeniden çıkarılır (yerel/ücretsiz, AI çağrısı yok) ki bir sonraki adım
        // (extractExcerpts) yanlış konuma bakmasın.
        if (this.codeIndexStore && fileContents.length > 0) {
            for (const fc of fileContents) {
                const before = codeHeaders.filter(h => h.file === fc.path);
                const after = await this.codeIndexStore.verifyAndRefresh(fc.path, fc.content);
                if (before.length > 0 && JSON.stringify(before) !== JSON.stringify(after)) {
                    this.log(`   🔄 ${fc.path} — kod indeksi güncel değildi (elle değiştirilmiş olabilir), yeniden tarandı`);
                }
                codeHeaders = codeHeaders.filter(h => h.file !== fc.path).concat(after);
            }
        }
        // --- 4b. MALİYET OPTİMİZASYONU: kod yazan AI'ya dosyanın TAMAMI yerine sadece
        // ilgili bloğu göndermek için, ücretsiz planlayıcıya "hangi kısım değişecek" sorulur.
        // Coding agent (pahalı olabilir) böylece dosyanın büyük kısmını hiç görmez/üretmez.
        const t0e = Date.now();
        const blockMap = await this.extractExcerpts(userPrompt, plan, fileContents, codeHeaders);
        if (fileContents.length > 0) {
            this.flowEvents.push({
                step: "block_extract", model: "", purpose: `${fileContents.length} dosyada ilgili blok aranıyor`,
                success: true, durationMs: Date.now() - t0e,
                handoffTo: "coding_agent",
            });
            for (const fc of fileContents) {
                if (blockMap.has(fc.path)) {
                    this.log(`   ✂️ ${fc.path} — blok modu (${blockMap.get(fc.path).length}/${fc.content.length} karakter gönderilecek)`);
                }
                else {
                    this.log(`   📄 ${fc.path} — tam dosya modu`);
                }
            }
        }
        plan.fileExcerpts = Array.from(blockMap.entries()).map(([path, excerpt]) => ({ path, excerpt }));
        // --- 5. Postacı, uzman kod AI'sına görevi iletir (AI dosya görmez, sadece kod üretir) ---
        // NOT: Coding agent STATELESS'tır — geçmiş değişiklik kaydı (changeLogger) artık bu
        // promptun bir parçası değil, sadece o anki blok/dosya + o anki analiz veriliyor.
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
        const codingPrompt = this.buildCodingPrompt(userPrompt, plan, knowledge, fileContents, blockMap, agentRole) + codingExtra;
        const codeRes = await this.router.runFromAgent(codingStart, codingPrompt);
        if (!codeRes.success) {
            return { success: false, error: codeRes.error, knowledge, changes: [], codingAgent: codeRes.usedAgent, codingModel: codeRes.usedModel, attempts: codeRes.attempts };
        }
        // --- 6. Yanıt parse edilir (dosya yazımı asistanın işi) ---
        let changes = this.parseChanges(codeRes.content, fileContents, blockMap);
        let finalCodeRes = codeRes;
        if (changes.length === 0) {
            this.log(`Yanıt işlenemedi — model beklenen formatı kullanmadı.`);
            // OTOMATIK YÜKSELTME: blok modu kullanılmıştı ve başarısız oldu — belki model bloğun
            // DIŞINDA bir yeri de değiştirmesi gerektiğini fark etti ama format kısıtı yüzünden
            // veremedi. Aynı görevi TAM DOSYA modunda (blockMap boş) bir kez daha deneyelim —
            // pahalı ama en azından görev tamamen başarısız olmasın.
            if (blockMap.size > 0) {
                this.log(`   🔁 Blok modu başarısız — aynı görev tam dosya modunda yeniden deneniyor...`);
                const retryPrompt = this.buildCodingPrompt(userPrompt, plan, knowledge, fileContents, new Map(), agentRole) + codingExtra;
                const retryRes = await this.router.runFromAgent(codingStart, retryPrompt);
                if (retryRes.success) {
                    const retryChanges = this.parseChanges(retryRes.content, fileContents, new Map());
                    if (retryChanges.length > 0) {
                        changes = retryChanges;
                        finalCodeRes = retryRes;
                        this.log(`   ✅ Tam dosya modunda ${changes.length} dosya hazırlandı.`);
                    }
                }
            }
        }
        else {
            this.log(`${changes.length} dosya hazırlandı`);
        }
        // Kod yazma adımını da flowEvents'e ekle
        this.flowEvents.push({
            step: "code", model: finalCodeRes.usedModel, agentKey: finalCodeRes.usedAgent,
            purpose: `Kod yaz: ${userPrompt.slice(0, 80)}`, success: changes.length > 0,
            durationMs: 0, handoffTo: "file_applier",
        });
        const allFlowEvents = [...this.flowEvents, ...flowEvents];
        this.flowEvents = []; // sonraki run için sıfırla
        return {
            success: true,
            plan,
            knowledge,
            changes,
            codingAgent: finalCodeRes.usedAgent,
            codingModel: finalCodeRes.usedModel,
            attempts: finalCodeRes.attempts,
            rawResponse: finalCodeRes.content,
            flowEvents: allFlowEvents,
        };
    }
    // Planlama: POSTACI (ücretsiz model) JSON formatında plan üretir
    async makePlan(userPrompt, relevant, all, codeHeaders = []) {
        const headersByFile = new Map();
        for (const h of codeHeaders) {
            if (!headersByFile.has(h.file))
                headersByFile.set(h.file, []);
            headersByFile.get(h.file).push(h);
        }
        const fileList = relevant.map(f => {
            const headers = headersByFile.get(f.path);
            const hint = headers && headers.length > 0
                ? ` — içindekiler: ${headers.slice(0, 12).map(h => `${h.name} (satır ${h.line})`).join(", ")}`
                : "";
            return `- ${f.path} (${f.language})${hint}`;
        }).join("\n");
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
        const res = await this.postmanCall("Sen bir görev planlayıcı postacısın. Sadece geçerli JSON döndürürsün.", planPrompt);
        if (res.success) {
            const parsed = this.extractJson(res.content);
            if (parsed) {
                let targets = Array.isArray(parsed.targetFiles) ? parsed.targetFiles : [];
                // Plan dosya bulamadıysa prompttan çıkar
                if (targets.length === 0)
                    targets = this.extractFilesFromPrompt(userPrompt);
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
        }
        else {
            this.log(`   ⚠ Tüm ücretsiz modeller başarısız, basit moda geçiliyor.`);
        }
        // FALLBACK: prompttan dosya adlarını çıkar, yoksa alakalı dosyaları kullan
        const fromPrompt = this.extractFilesFromPrompt(userPrompt);
        const targets = fromPrompt.length > 0 ? fromPrompt : relevant.slice(0, 3).map(f => f.path);
        return { needsResearch: false, needsMath: false, targetFiles: targets, intent: userPrompt };
    }
    // Prompt içinden dosya yollarını yakala (örn "calculator.js", "utils/string.js")
    extractFilesFromPrompt(prompt) {
        const matches = prompt.match(/[\w\-./]+\.[a-zA-Z][a-zA-Z0-9]{0,4}\b/g) || [];
        // Geçerli uzantılı, yol gibi görünenleri al
        const valid = matches.filter(m => /\.(js|ts|jsx|tsx|py|java|cpp|c|h|cs|go|rs|rb|php|html|css|scss|json|md|vue|svelte|sql|sh|yml|yaml)$/i.test(m));
        return Array.from(new Set(valid));
    }
    // MALİYET OPTİMİZASYONU: her var-olan hedef dosya için, görevle ilgili DEĞİŞECEK tek bir
    // bölümü ücretsiz modele birebir (verbatim) alıntılat. Dönen alıntı gerçekten dosyada
    // (karakteri karakterine) geçmiyorsa ya da çok kısaysa GÜVENLE reddedilir — o dosya
    // tam-dosya moduna düşer. Böylece optimizasyon başarısız olsa da sistem kırılmaz.
    async extractExcerpts(userPrompt, plan, files, codeHeaders = []) {
        const result = new Map();
        if (files.length === 0)
            return result;
        const filesBlock = files.map(f => {
            const headers = codeHeaders.filter(h => h.file === f.path);
            const hint = headers.length > 0
                ? `(Bilinen başlıklar: ${headers.map(h => `${h.name} → satır ${h.line}`).join(", ")})\n`
                : "";
            return `--- DOSYA: ${f.path} ---\n${hint}${f.content}`;
        }).join("\n\n");
        const prompt = `GÖREV: ${userPrompt}
NİYET: ${plan.intent}

Aşağıdaki dosya(lar)ın TAM içeriği verildi. Senin işin kodu DÜZELTMEK veya DEĞİŞTİRMEK DEĞİL —
sadece bu görevle ilgili DEĞİŞECEK TEK bir bölümü (bir fonksiyon, bir sınıf, bir blok) BULMAK ve
onu dosyadan AYNEN, MEVCUT (hatalı olsa bile, hiçbir düzeltme yapmadan) haliyle kopyalamak.
Düzeltme/değişiklik SONRAKİ ayrı bir adımda başka biri tarafından yapılacak — senin ürettiğin
metin bir COPY-PASTE işlemidir, kodun kendisi değil. Dosyanın başındaki "Bilinen başlıklar"
listesi varsa, ilgili bölümü daha hızlı bulman için bir ipucudur (satır numaraları yaklaşıktır,
kesin sınır için dosyanın kendisine bak).

${filesBlock}

Şu JSON formatında yanıtla (SADECE JSON):
{
  "files": [
    { "path": "dosya/yolu", "excerpt": "dosyadan AYNEN kopyalanmış blok (mevcut/hatalı haliyle), ya da emin değilsen boş string" }
  ]
}

KESİN KURALLAR:
- "excerpt" dosyadaki metinle KARAKTERİ KARAKTERİNE bire bir eşleşmeli. Bug'ı/hatayı DÜZELTEREK
  kopyalarsan bu geçersiz sayılır ve tüm optimizasyon başarısız olur — MUTLAKA dosyada olduğu gibi kopyala.
- Parafraze etme, özetleme, biçimlendirme değiştirme, yorum ekleme/çıkarma YAPMA.
- Değişecek yer dosyanın geneline yayılmışsa, birden fazla dağınık bölgedeyse, ya da emin değilsen
  o dosya için excerpt'i boş string ("") bırak — bu durumda dosyanın tamamı gönderilecek, sorun değil.
- Yeni satır eklenecekse (ör. dosya sonuna) uygun bir çapa (ör. son birkaç satır) alıntıla.`;
        const res = await this.postmanCall("Sen bir kod konumlandırma uzmanısın — kod YAZMAZSIN, sadece ilgili bölümü olduğu gibi (kopyala-yapıştır) bulursun. Sadece geçerli JSON döndürürsün, asla açıklama yazmazsın.", prompt);
        if (!res.success)
            return result;
        const parsed = this.extractJson(res.content);
        if (!parsed || !Array.isArray(parsed.files))
            return result;
        for (const entry of parsed.files) {
            const path = entry?.path;
            const excerpt = entry?.excerpt;
            if (typeof path !== "string" || typeof excerpt !== "string")
                continue;
            if (excerpt.trim().length < 20)
                continue; // çok kısa alıntı güvenilmez — tam dosyaya düş
            const file = files.find(f => f.path === path);
            if (!file)
                continue;
            // BİREBİR doğrulama — CRLF/LF farkı yüzünden yanlışlıkla reddetmemek için normalize ederek karşılaştır
            // (Windows'ta dosyalar genelde CRLF, model çıktısı her zaman LF kullanır — içerik aynı olsa bile
            // ham karşılaştırma yanlış negatif verirdi).
            if (!file.content.replace(/\r\n/g, "\n").includes(excerpt))
                continue;
            result.set(path, excerpt);
        }
        return result;
    }
    // Kod yazan AI'ya verilecek tam promptu kur
    buildCodingPrompt(userPrompt, plan, knowledge, files, blockMap, agentRole = "coding") {
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
        const blockFiles = files.filter(f => blockMap.has(f.path));
        const fullFiles = files.filter(f => !blockMap.has(f.path));
        if (blockFiles.length > 0) {
            p += `\n=== İLGİLİ KOD BLOKLARI (sadece bu bölümler — dosyanın geri kalanını GÖRMÜYORSUN) ===\n`;
            for (const f of blockFiles) {
                p += `\n--- BLOK (${f.path}) ---\n${blockMap.get(f.path)}\n`;
            }
        }
        if (fullFiles.length > 0) {
            p += `\n=== MEVCUT DOSYALAR (TAM İÇERİK) ===\n`;
            for (const f of fullFiles) {
                p += `\n--- DOSYA: ${f.path} ---\n${f.content}\n`;
            }
        }
        p += `
=== ÇIKTI FORMATI (ÇOK ÖNEMLİ) ===
Her dosya için AYNEN şu formatı kullan, başka HİÇBİR ŞEY yazma:

<<<FILE: dosya/yolu.uzanti | ACTION: create>>>
(buraya içeriği yaz — markdown kod bloğu KULLANMA, doğrudan kod yaz)
<<<END>>>

KESİN KURALLAR:
1. Her dosya <<<FILE: ...>>> ile başlar, <<<END>>> ile biter.
2. İçeriği \`\`\` ile SARMA — doğrudan kodu yaz.
3. Mevcut dosyayı düzenliyorsan ACTION: modify, yeni dosyaysa ACTION: create.
4. <<<FILE>>> blokları dışında açıklama, selamlama, özet YAZMA.
5. Görevi TEK SEFERDE eksiksiz tamamla — kodu yarım bırakma.
${blockFiles.length > 0 ? `6. "İLGİLİ KOD BLOKLARI" bölümünde gösterilen dosyalar için: SADECE o bloğun yeni/düzeltilmiş halini yaz — dosyanın TAMAMINI YAZMA, sadece gösterilen bloğun yerine geçecek kodu ver. Bu blok otomatik olarak dosyaya geri yerleştirilecek.\n7. "MEVCUT DOSYALAR (TAM İÇERİK)" bölümündeki veya yeni oluşturacağın dosyalar için dosyanın TAMAMINI yaz, kısaltma yapma.` : `6. Mevcut dosyalar için dosyanın TAMAMINI yaz, "..." veya "değişmeyen kısım" gibi kısaltma YAPMA.`}

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
    parseChanges(response, originals, blockMap = new Map()) {
        const changes = [];
        let m;
        // Format 0 (EN SAĞLAM): <<<FILE: path [| ACTION: x]>>> ...içerik... <<<END>>>
        // ``` fence opsiyonel — içerik fence'li de fence'siz de yakalanır
        const fmt0 = /<<<FILE:\s*([^|>\n]+?)\s*(?:\|\s*ACTION:\s*(create|modify|delete)\s*)?>>>([\s\S]*?)<<<END>>>/gi;
        while ((m = fmt0.exec(response)) !== null) {
            const path = m[1].trim();
            const action = m[2]?.trim() || "create";
            let content = m[3];
            // İçerik ```dil ... ``` ile sarılıysa fence'i soy
            const fenced = content.match(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/);
            if (fenced)
                content = fenced[1];
            content = content.replace(/^\n+/, "").replace(/\n+$/, "\n");
            this.addChange(changes, path, action, content, originals, blockMap);
        }
        if (changes.length > 0)
            return changes;
        // Format 2: ## FILE: path\n```...```  veya  // FILE: path\n```...```
        const fmt2 = /(?:##\s*FILE:|\/\/\s*FILE:|FILE:)\s*([^\n]+)\n```[a-zA-Z0-9]*\n?([\s\S]*?)```/gi;
        while ((m = fmt2.exec(response)) !== null) {
            this.addChange(changes, m[1].trim(), "create", m[2], originals, blockMap);
        }
        if (changes.length > 0)
            return changes;
        // Format 3: ```typescript (ilk satırda yorum olarak dosya adı)
        //            // utils/math.js   veya  # utils/math.py
        const fmt3 = /```[a-zA-Z0-9]*\n(?:\/\/|#)\s*([^\n]+\.[a-zA-Z0-9]+)\n([\s\S]*?)```/gi;
        while ((m = fmt3.exec(response)) !== null) {
            this.addChange(changes, m[1].trim(), "create", m[2], originals, blockMap);
        }
        if (changes.length > 0)
            return changes;
        // Format 4: Sadece bir kod bloğu varsa ve plan'da hedef dosya varsa oraya yaz
        const singleBlock = /```[a-zA-Z0-9]*\n([\s\S]+?)```/;
        const sb = singleBlock.exec(response);
        if (sb && originals.length === 1) {
            this.addChange(changes, originals[0].path, "modify", sb[1], originals, blockMap);
        }
        return changes;
    }
    addChange(changes, filePath, action, newContent, originals, blockMap = new Map()) {
        // GÜVENLİK: AI'nin ürettiği yol workspace dışına çıkıyorsa değişikliği reddet
        const pathCheck = (0, validator_1.validateRelativeFilePath)(filePath);
        if (!pathCheck.valid) {
            this.log(`   🛡 Güvenlik: "${filePath}" reddedildi — ${pathCheck.error}`);
            return;
        }
        const original = originals.find(o => o.path === filePath);
        let finalContent = newContent.replace(/\r\n/g, "\n");
        // BLOK MODU: AI sadece bloğun yeni halini döndürdü — orijinal dosyaya geri yerleştir (splice).
        // NOT: karşılaştırma/splice, orijinal içeriğin CRLF→LF normalize edilmiş hali üzerinden yapılır
        // (Windows'ta dosyalar genelde CRLF, model çıktısı her zaman LF kullanır — ham karşılaştırma
        // içerik aynı olsa bile yanlış negatif verirdi). Zaten normal (blok-dışı) modda da dosya LF'e
        // normalize ediliyor (bkz. yukarıdaki finalContent ataması), yani davranış tutarlı.
        const excerpt = blockMap.get(filePath);
        if (original && excerpt) {
            const normalizedOriginal = original.content.replace(/\r\n/g, "\n");
            if (!normalizedOriginal.includes(excerpt)) {
                // Orijinal dosya beklenmedik şekilde değişmiş/excerpt artık geçmiyor — güvenle reddet,
                // yarım/bozuk bir dosya yazmaktansa bu değişikliği tamamen atla.
                this.log(`   ⚠ ${filePath}: blok artık orijinal dosyada bulunamadı, değişiklik atlandı (güvenlik).`);
                return;
            }
            // BOYUT SAĞLAMASI: model verilen küçük bloğa karşılık orantısız büyük bir çıktı
            // üretirse (halüsinasyon, fazladan kod/açıklama ekleme) — dosyaya sessizce enjekte
            // etmek yerine reddet. Eşik: alıntının 5 katı VEYA +400 karakter, hangisi büyükse
            // (çok küçük alıntılarda makul bir genişlemeye izin vermek için sabit pay eklenir).
            const maxAllowed = Math.max(excerpt.length * 5, excerpt.length + 400);
            if (finalContent.length > maxAllowed) {
                this.log(`   ⚠ ${filePath}: model beklenenden çok daha büyük bir çıktı üretti (${excerpt.length} karakterlik bloğa karşılık ${finalContent.length} karakter) — güvenlik için değişiklik atlandı.`);
                return;
            }
            // AI'nin çıktısı format-normalizasyonu gereği tek bir trailing "\n" ile bitirilmiş olabilir;
            // excerpt'in kendi sınırı bunu içermiyorsa splice fazladan boş satır ekler. Bunu temizle.
            const blockReplacement = excerpt.endsWith("\n") ? finalContent : finalContent.replace(/\n+$/, "");
            finalContent = normalizedOriginal.replace(excerpt, blockReplacement).replace(/\n{3,}/g, "\n\n");
        }
        changes.push({
            filePath,
            action: original ? "modify" : action,
            originalContent: original?.content,
            newContent: finalContent,
            description: original ? `${filePath} güncelleniyor` : `${filePath} oluşturuluyor`,
        });
    }
    extractJson(text) {
        // ```json ... ``` veya çıplak { ... } bul
        const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        const raw = fenced ? fenced[1] : (text.match(/\{[\s\S]*\}/)?.[0]);
        if (!raw)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
}
exports.Orchestrator = Orchestrator;
//# sourceMappingURL=orchestrator.js.map