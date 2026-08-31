// Saf, vscode'a bağımsız kod başlığı çıkarma mantığı — CodeIndexStore (codeIndex.ts) bunu
// kullanır. Ayrı dosyada tutulması, bağımsız birim testine (test/codeIndex.test.js) izin verir.
export interface CodeHeader {
  name: string;
  kind: "function" | "class" | "method" | "const" | "interface" | "type";
  file: string;   // workspace-relative
  line: number;   // 1-tabanlı
  signature: string; // başlığın kısaltılmış tam metni (görünürlük için)
}

// Dile göre başlık yakalama kalıpları. Her biri en az bir "isim" grubu (index 1) içerir.
const PATTERNS: { lang: RegExp[]; kind: CodeHeader["kind"] }[] = [
  {
    kind: "function",
    lang: [
      /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/,
      /^\s*def\s+([A-Za-z_]\w*)\s*\(/, // Python
      /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, // Go
      /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/, // Rust
    ],
  },
  {
    kind: "class",
    lang: [
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /^\s*class\s+([A-Za-z_]\w*)\s*[:({]/, // Python/C#/Java
    ],
  },
  {
    kind: "interface",
    lang: [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
  },
  {
    kind: "type",
    lang: [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/],
  },
  {
    kind: "method",
    lang: [
      // Sınıf içi metod — "function"/"const" anahtar kelimesi yok ama parantez+süslü var.
      // Yanlış pozitifi azaltmak için satır başında 2+ boşluk girinti şart koşulur.
      /^ {2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]| ]+)?\s*\{/,
    ],
  },
];

const MAX_HEADERS_PER_FILE = 40; // aşırı büyük dosyalarda prompt şişmesin

// Tek bir dosyanın içeriğinden kod başlıklarını çıkarır (saf fonksiyon — vscode'a bağımlı değil, test edilebilir).
export function extractHeaders(filePath: string, content: string): CodeHeader[] {
  const lines = content.split("\n");
  const headers: CodeHeader[] = [];

  for (let i = 0; i < lines.length && headers.length < MAX_HEADERS_PER_FILE; i++) {
    const line = lines[i];
    for (const group of PATTERNS) {
      for (const re of group.lang) {
        const m = re.exec(line);
        if (m && m[1]) {
          headers.push({
            name: m[1],
            kind: group.kind,
            file: filePath,
            line: i + 1,
            signature: line.trim().slice(0, 120),
          });
          break; // bu satır için bir eşleşme yeter, bir sonraki desene geçme
        }
      }
    }
  }
  return headers;
}
