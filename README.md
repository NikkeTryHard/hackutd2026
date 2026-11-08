# Sightline

[![HackUTD 2026](https://img.shields.io/badge/HackUTD-2026-7c6cf0)](https://github.com/NikkeTryHard/hackutd2026)
![Bun](https://img.shields.io/badge/runtime-Bun-14151a?logo=bun)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white)
![SpacetimeDB](https://img.shields.io/badge/state-SpacetimeDB-c46aef)
![Playwright](https://img.shields.io/badge/browser-Playwright-2ead33?logo=playwright&logoColor=white)

**UI/UX for the people, by the people.**

Visual agents explore websites through screenshots, mouse movements, and keyboard input. Watch live browser previews, inspect findings, and guide each agent from its own workspace.

## Demo

[![Watch the Sightline demo](public/media/sightline-browser-demo-poster.jpg)](https://github.com/NikkeTryHard/hackutd2026/raw/refs/heads/main/public/media/sightline-browser-demo.mp4)

[Watch the video](https://github.com/NikkeTryHard/hackutd2026/raw/refs/heads/main/public/media/sightline-browser-demo.mp4)

## Run

```sh
bun install
cp .env.example .env
bun run db:start
```

Publish the database module using the [database setup](spacetimedb/README.md), configure your model in `.env`, and run `bun run dev`.

The demo uses controlled shopping and campus websites with intentional defects and clean verification twins. Interaction profiles are synthetic testing conditions, not validated demographic simulations. The recorded demo is not a benchmark result.
