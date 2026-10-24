# EnvSync website

The landing page, as static files: `index.html`, `styles.css`, `app.js` and `favicon.svg`.
There is no build step and there are no dependencies. The page loads nothing from third parties,
and `vercel.json` sets a strict Content-Security-Policy so it stays that way.

## Preview locally

Any static file server works, for example:

```sh
npx --yes serve site
```

## Deploy on Vercel

Import the repository in Vercel and set:

| Setting | Value |
|---|---|
| Root Directory | `site` |
| Framework Preset | Other |
| Build Command | none (leave empty) |
| Output Directory | `.` |

## Keeping it honest

All CLI output on the page (the terminal replay and the diagnostics table in `app.js`) is real output
captured from `tests/fixtures`. When diagnostic messages or the quick-start commands change,
update the page to match.
