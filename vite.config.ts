import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apifyToken = env.APIFY_TOKEN || env.VITE_APIFY_TOKEN || ''
  const apifyInstagramActorId = env.APIFY_INSTAGRAM_ACTOR_ID || 'apify~instagram-scraper'
  const apifyActorId = env.APIFY_TIKTOK_ACTOR_ID || 'clockworks~tiktok-scraper'
  const instagramProxyPath = `/v2/acts/${apifyInstagramActorId}/run-sync-get-dataset-items`
  const tiktokProxyPath = `/v2/acts/${apifyActorId}/run-sync-get-dataset-items`

  return {
    plugins: [
      figmaAssetResolver(),
      // The React and Tailwind plugins are both required for Make, even if
      // Tailwind is not being actively used – do not remove them
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        // Alias @ to the src directory
        '@': path.resolve(__dirname, './src'),
      },
    },

    server: {
      proxy: {
        '/instagram-proxy': {
          target: 'https://www.instagram.com',
          changeOrigin: true,
          secure: true,
          rewrite: (requestPath) => requestPath.replace(/^\/instagram-proxy/, ''),
        },
        '/instagram-apify-proxy': {
          target: 'https://api.apify.com',
          changeOrigin: true,
          secure: true,
          rewrite: () => `${instagramProxyPath}${apifyToken ? `?token=${encodeURIComponent(apifyToken)}` : ''}`,
        },
        '/jina-proxy': {
          target: 'https://r.jina.ai',
          changeOrigin: true,
          secure: true,
          rewrite: (requestPath) => requestPath.replace(/^\/jina-proxy/, ''),
        },
        '/tiktok-apify-proxy': {
          target: 'https://api.apify.com',
          changeOrigin: true,
          secure: true,
          rewrite: () => `${tiktokProxyPath}${apifyToken ? `?token=${encodeURIComponent(apifyToken)}` : ''}`,
        },
      },
    },

    // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
    assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})
