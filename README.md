# chonker

Claude Code says 200K tokens but the real usable limit is somewhere around 70-120K. There's no built-in way to see how full your context is. You just keep working until Claude starts forgetting things.

## What it shows

- context window usage bar with percentage and token ratio
- input and output tokens with model name
- real time rate limit utilization (5 hour session, 7 day weekly, model specific, extra usage)

## What it looks like

![chonker meter](images/chonker.png?v=2)

## Install

```
claude --plugin-dir /path/to/chonker
```

## How it works

On first session start, it auto-configures `~/.claude/settings.json` to run a meter script. Claude Code pipes token usage and model info as JSON to the script every 5 seconds and it outputs a formatted status line. Rate limit data is fetched from the Anthropic API and cached locally so it stays fast.
