# Changelog

## 1.2.0
- add burn rate prediction: shows `burn: X%/min · cap ~Ym` when rate limit usage is climbing
- simplify rate limit line to show only 5h bucket
- show "safe" in green when usage won't hit cap before reset
- prediction appears after 2 API cycles (~5 min) for stable readings
- velocity data expires after 10 min of inactivity

## 1.1.2
- add `--version` / `-v` flag to CLI

## 1.1.1
- fix rate limit line disappearing when API returns errors
- fix git branch not showing from subdirectories
- add persistent cache so rate limits always show even when the API is down
- show reset countdowns by default (e.g. `7d:1% ~166h`)
- increase cache TTL to 2.5 min to avoid API throttling

## 1.1.0
- show current git branch on status line
- rewrite hooks in javascript for cross platform support
- show real time rate limit usage
- redesign meter

## 1.0.0
- initial release
