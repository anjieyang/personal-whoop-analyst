# Personal WHOOP Analyst

Private WHOOP data collection for local analysis.

## Daily use

```bash
npm run whoop:sync -- 35
npm run whoop:status
```

The latest normalized snapshot is written to `data/latest.json`. Timestamped raw API archives are written under `data/raw/`. The entire `data/` directory is excluded from Git.

OAuth client credentials and the rotating refresh token are stored in macOS Keychain under the service name `personal-whoop-analyst`; they are not stored in project files.

The public files at the repository root provide the OAuth callback and privacy policy required by WHOOP. They do not receive or store WHOOP health data.
