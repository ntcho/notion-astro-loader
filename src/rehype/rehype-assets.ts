import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';

interface Config {
  imagePaths?: string[];
}

const ASTRO_IMAGE_FORMATS = ['avif', 'webp', 'png', 'jpg', 'jpeg', 'gif'];

function isAstroImageFormat(src: string): boolean {
  const ext = src.split('.').pop();
  return ext ? ASTRO_IMAGE_FORMATS.includes(ext.toLowerCase()) : false;
}

export function rehypeAssets() {
  return ({ imagePaths }: Config) =>
    function (tree: any, file: VFile) {
      const imageOccurrenceMap = new Map();

      visit(tree, (node) => {
        if (node.type !== 'element') return;

        if (node.properties?.src) {
          node.properties.src = decodeURI(node.properties.src);
          if (file.data.astro) {
            file.data.astro.imagePaths = imagePaths;
          }

          // Handle Astro image optimization
          if (
            node.tagName === 'img' &&
            imagePaths?.includes(node.properties.src) &&
            isAstroImageFormat(node.properties.src)
          ) {
            const { ...props } = node.properties;

            // Initialize or increment occurrence count for this image
            const index = imageOccurrenceMap.get(node.properties.src) || 0;
            imageOccurrenceMap.set(node.properties.src, index + 1);

            node.properties['__ASTRO_IMAGE_'] = JSON.stringify({ ...props, index });

            Object.keys(props).forEach((prop) => {
              delete node.properties[prop];
            });

            return; // Skip further processing for Astro images
          }

          // Convert relative paths (assets in /src) to absolute paths (served from /public)
          if (node.properties.src.startsWith('../')) node.properties.src = node.properties.src.replace(/^(..\/)+/, '/');
          if (node.properties.src.startsWith('src/')) node.properties.src = node.properties.src.replace(/^src\//, '/');
        }

        // Handle href attributes similarly to src
        if (node.properties?.href?.startsWith('src/'))
          node.properties.href = node.properties.href.replace(/^src\//, '/');
      });
    };
}
