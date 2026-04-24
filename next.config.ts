import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Absolute path — relative paths make Turbopack walk up from src/app and fail
// to find `next/package.json` under a git-worktree layout.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Tauri needs static export for production build
  distDir: 'dist',
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
