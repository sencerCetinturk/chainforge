# ChainForge Configuration Guide

## Agent Roles

| Role | Purpose |
|---|---|
| `coding` | Code writing, editing, refactoring |
| `math` | Mathematics, physics, reasoning |
| `routing` | Task routing decisions |
| `long-coding` | Long-horizon autonomous tasks |
| `fallback` | Secondary option when primary fails |
| `supervisor` | Final review and quality control |
| `custom` | Any custom purpose |

## Recommended Models (via OpenRouter)

| Model | Best For | Cost |
|---|---|---|
| `minimax/minimax-m3` | General coding | Low |
| `google/gemini-flash-1-5` | Routing, quick tasks | Free tier |
| `deepseek/deepseek-chat` | Math, reasoning | Very low |
| `anthropic/claude-sonnet-4-5` | Quality fallback | Medium |
| `zhipuai/glm-5.1` | Long-horizon tasks | Medium |

## Fallback Chain Example

```
coding task
  └─ minimax/minimax-m3 (3 retries)
       └─ google/gemini-flash-1-5 (2 retries)
            └─ anthropic/claude-sonnet-4-5 (1 retry)
```
