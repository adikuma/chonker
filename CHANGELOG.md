# Changelog

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
