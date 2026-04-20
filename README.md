# Minimal Analytics Dashboard UI

This is a code bundle for Minimal Analytics Dashboard UI. The original project is available at https://www.figma.com/design/qkfh92D75V8xzwtbZggiPr/Minimal-Analytics-Dashboard-UI.

## Running the code

1. Run `npm i` to install dependencies.
2. Create a local env file from `.env.example` and set your Apify credentials:

```bash
cp .env.example .env.local
```

3. Add `APIFY_TOKEN` in `.env.local`.
4. Run `npm run dev` to start the development server.

## TikTok analytics setup

- TikTok fetch uses Apify actor `datapilot~tiktok-analytics-engagement-extractor`.
- If Apify returns `actor-is-not-rented`, rent/activate the actor in your Apify account first.
- For Vercel deployment, set these environment variables in your Vercel project:
  - `APIFY_TOKEN`
  - `APIFY_TIKTOK_ACTOR_ID` (optional, defaults to `datapilot~tiktok-analytics-engagement-extractor`)
