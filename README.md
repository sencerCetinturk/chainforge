# ⛓ ChainForge

**Your AI coding team inside VS Code — chat, auto-edit, and self-healing code, powered by 400+ models via one OpenRouter key.**

ChainForge isn't just a chat sidebar. It's a small pipeline of AI agents that talk to each other: a router picks the right model for the job, a fallback chain kicks in the moment one fails, and a Denetmen ↔ Postacı ("Inspector ↔ Postman") loop can scan your codebase, find bugs, and fix them automatically — all without you writing a single line of YAML.

![ChainForge Panel](docs/preview.png)

---

## ✨ What it actually does

- **💬 Project-aware chat** — reads your open file and the most relevant files in your workspace automatically, no need to paste code in. Remembers conversation history per project.
- **🛠 Agent mode (auto-edit)** — describe a task in plain language; ChainForge plans it, researches if needed, writes the code, shows you a diff, and applies it on approval. Full operation history kept per project.
- **🔎 Denetmen (Inspector)** — scans your workspace for bugs, security issues, and code smells. Incremental: after the first full pass, only re-checks files that changed.
- **✉️ Postacı (Postman) auto-fix loop** — reads the Inspector's report and sends each broken file to an AI to fix, then re-applies the fix with your approval. Ask ChainForge to check your code, then let it clean up after itself.
- **🧭 Smart routing & fallback** — tasks go to the model best suited for them; if a model fails, hits a rate limit, or the format breaks, the chain automatically moves to the next one. Nothing dead-ends.
- **⏱ Live progress + cancel** — see every step as it happens ("trying model X…", "planning…", "writing code…") and cancel a running chat or agent task mid-flight.
- **🌐 400+ Models** — Claude, GPT, Gemini, DeepSeek, MiniMax, GLM, Qwen, Grok and more, all through your own [OpenRouter](https://openrouter.ai) key.
- **🆓 Works without any paid key** — a free-model fallback chain means you can chat and run basic agent tasks with zero cost, zero setup beyond installing.
- **💰 Cost tracking** — every AI call's token usage and estimated cost (live OpenRouter pricing) is logged; see a monthly breakdown by model right in the panel.
- **🌍 7 Languages** — EN, TR, DE, FR, ES, JA, ZH — full interface and AI response language.
- **🔒 Privacy-first telemetry** — fully opt-in; if enabled, only anonymous feature/error data is collected — never your code, prompts, or API key.

---

## 🚀 Quick Start

1. Install **ChainForge** from the VS Code Marketplace or [Open VSX](https://open-vsx.org).
2. Open the ChainForge icon in the Activity Bar.
3. Start chatting immediately with free models — **no API key required.**
4. Want more power? Get a free key at [openrouter.ai/keys](https://openrouter.ai/keys) and paste it into the **Settings** tab to unlock paid models and agent tasks.
5. Try `ChainForge: Agent Task (Auto Edit Files)` from the Command Palette to have it write and apply code directly to your project.
6. Try `ChainForge: Inspect Files (Denetmen)` to scan your codebase, then let the Postacı auto-fix loop clean up what it finds.

---

## 🔗 How It Works

```
Your task → Router picks best agent → (fails?) → Fallback agent → (still stuck?) → Supervisor
```

Each agent has a model, a role (coding / math / routing / supervisor / fallback / custom), a retry count, and an optional fallback chain — all configurable through the visual panel, no config file editing required (though `.chainforge.json` is there if you want it).

The **Denetmen ↔ Postacı loop** works on top of this: Denetmen finds problems, Postacı asks the coding agent to fix them, and the fix goes through the same diff-review-apply flow as any other agent change.

---

## ⚙️ Configuration (optional)

ChainForge stores its agent/task setup in `.chainforge.json` in your workspace root — edit it directly, or use the Visual Editor in the panel.

```json
{
  "agents": {
    "worker": {
      "name": "AI Worker",
      "model": "minimax/minimax-m3",
      "role": "coding",
      "fallback": "fallback",
      "maxRetries": 3
    },
    "fallback": {
      "name": "Fallback",
      "model": "google/gemini-flash-1-5",
      "role": "fallback",
      "fallback": "supervisor",
      "maxRetries": 2
    },
    "supervisor": {
      "name": "Supervisor",
      "model": "anthropic/claude-sonnet-4-5",
      "role": "supervisor",
      "maxRetries": 1
    }
  },
  "tasks": {
    "coding": { "primary": "worker", "description": "Code writing, editing" },
    "review": { "primary": "supervisor", "description": "Code review" },
    "general": { "primary": "worker", "description": "General questions" }
  }
}
```

---

## 💎 Pro — $9.99 one-time

| Feature | Free | Pro |
|---|:---:|:---:|
| Chat (free models) | ✓ | ✓ |
| Agents | 3 | **Unlimited** |
| Bring your own API key **per agent** (any provider, not just OpenRouter) | — | ✓ |
| Agent auto-edit tasks | ✓ | ✓ |
| Denetmen / Postacı auto-fix loop | ✓ | ✓ |
| Undo history for auto-edits | 1 step | **Unlimited (session)** |
| Custom global instructions (your style, preferred libraries, conventions — applied to every chat & agent task) | — | ✓ |
| Tasks | Unlimited | Unlimited |
| Visual editor | ✓ | ✓ |
| Cost & usage tracking | ✓ | ✓ |
| All future updates | — | ✓ |

No subscription, no recurring charge — pay once, keep it forever. ChainForge is built and maintained by a single indie developer, so every Pro purchase goes straight into keeping it alive and improving. **If you've bought Pro — thank you, genuinely. It means a lot.** 💙

[**Get Pro — $9.99 one-time →**](https://dodo.pe/yahnyvd3ig)

---

## 🔐 Security & Privacy

- Path traversal and prompt-injection–resistant file writes: agent-generated file paths are validated before anything touches disk — a task can only create or edit files inside your workspace.
- Input validation on every user-editable field (agent names, models, prompts) — no script injection, no malformed model IDs.
- Telemetry is opt-in, sanitized, and never includes your code, prompts, file paths, or API key.

---

## 🤝 Contributing

Issues and PRs welcome on [GitHub](https://github.com/sencerCetinturk/chainforge/issues).

## 📄 License

MIT — see [LICENSE](LICENSE)
