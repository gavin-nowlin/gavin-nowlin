# gavinnowlin.com

Personal site for Gavin Nowlin — built with [Astro](https://astro.build).

The site lives in this `web/` folder so the repo root can stay a [GitHub profile README](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/customizing-your-profile/managing-your-profile-readme).

## Local development

```bash
cd web
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:4321`).

## Build

```bash
cd web
npm run build
npm run preview
```

Static output is written to `web/dist/`.

## Deploy to Cloudflare Pages

Set the project root directory to `web`, then:

1. Build command: `npm run build`
2. Output directory: `dist`
3. Custom domain: `gavinnowlin.com`

With Wrangler (from `web/`, after `npm run build`):

```bash
npx wrangler pages deploy dist --project-name=gavin-nowlin
```

## Content

Site copy lives in:

- `src/data/site.ts` — name, bio, about, contact links
- `src/data/projects.ts` — project cards
