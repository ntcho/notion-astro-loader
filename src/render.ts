import type { HtmlElementNode, ListNode, TextNode } from '@jsdevtools/rehype-toc';
import { toc as rehypeToc } from '@jsdevtools/rehype-toc';
import { type Client, iteratePaginatedAPI, isFullBlock } from '@notionhq/client';
import type { AstroIntegrationLogger, MarkdownHeading } from 'astro';
import type { ParseDataOptions } from 'astro/loaders';

import type { FileObject, NotionPageData, PageObjectResponse } from './types.js';
import * as transformedPropertySchema from './schemas/transformed-properties.js';
import { fileToUrl } from './format.js';
import { type VFile } from 'vfile';

// #region Processor
import notionRehype from 'notion-rehype-k';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import { unified, type Plugin } from 'unified';
import { saveImageFromAWS, transformImagePathForCover } from './image.js';
import * as fse from 'fs-extra';
import { rehypeImages } from './rehype/rehype-images.js';

const baseProcessor = unified()
  .use(notionRehype, {}) // Parse Notion blocks to rehype AST
  .use(rehypeSlug)
  .use(
    // @ts-ignore
    rehypeKatex
  ) // Then you can use any rehype plugins to enrich the AST
  .use(rehypeStringify); // Turn AST to HTML string

export type RehypePlugin = Plugin<any[], any>;

export function buildProcessor(rehypePlugins: Promise<ReadonlyArray<readonly [RehypePlugin, any]>>) {
  let headings: MarkdownHeading[] = [];

  const processorWithToc = baseProcessor().use(rehypeToc, {
    customizeTOC(toc) {
      headings = extractTocHeadings(toc);
      return false;
    },
  });
  const processorPromise = rehypePlugins.then((plugins) => {
    let processor = processorWithToc;
    for (const [plugin, options] of plugins) {
      processor = processor.use(plugin, options);
    }
    return processor;
  });

  return async function process(blocks: unknown[], imagePaths: string[]) {
    const processor = await processorPromise.then((p) => p().use(rehypeImages(), { imagePaths }));
    const vFile = (await processor.process({ data: blocks } as Record<string, unknown>)) as VFile;
    return { vFile, headings };
  };
}
// #endregion

async function awaitAll<T>(iterable: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

/**
 * Return a generator that yields all blocks in a Notion page, recursively.
 * @param blockId ID of block to get children for.
 * @param fetchImage Function that fetches an image and returns a local path.
 */
async function* listBlocks(client: Client, blockId: string, fetchImage: (file: FileObject) => Promise<string>) {
  for await (const block of iteratePaginatedAPI(client.blocks.children.list, {
    block_id: blockId,
  })) {
    if (!isFullBlock(block)) {
      continue;
    }

    if (block.has_children) {
      const children = await awaitAll(listBlocks(client, block.id, fetchImage));
      // @ts-ignore -- TODO: Make TypeScript happy here
      block[block.type].children = children;
    }

    // Specialized handling for image blocks
    if (block.type === 'image') {
      // Fetch remote image and store it locally
      const url = await fetchImage(block.image);
      // notion-rehype-k incorrectly expects "file" to be a string instead of an object
      yield {
        ...block,
        image: {
          type: block.image.type,
          [block.image.type]: url,
          caption: block.image.caption,
        },
      };
    } else {
      yield block;
    }
  }
}

function extractTocHeadings(toc: HtmlElementNode): MarkdownHeading[] {
  if (toc.tagName !== 'nav') {
    throw new Error(`Expected nav, got ${toc.tagName}`);
  }

  function listElementToTree(ol: ListNode, depth: number): MarkdownHeading[] {
    return ol.children.flatMap((li) => {
      const [_link, subList] = li.children;
      const link = _link as HtmlElementNode;

      const currentHeading: MarkdownHeading = {
        depth,
        text: (link.children![0] as TextNode).value,
        slug: link.properties.href!.slice(1),
      };

      let headings = [currentHeading];
      if (subList) {
        headings = headings.concat(listElementToTree(subList as ListNode, depth + 1));
      }
      return headings;
    });
  }

  return listElementToTree(toc.children![0] as ListNode, 0);
}

export interface RenderedNotionEntry {
  html: string;
  metadata: {
    imagePaths: string[];
    headings: MarkdownHeading[];
  };
}

export class NotionPageRenderer {
  #imagePaths: string[] = [];
  #imageAnalytics: Record<'download' | 'cached', number> = {
    download: 0,
    cached: 0,
  };
  #logger: AstroIntegrationLogger;

  /**
   * @param client Notion API client.
   * @param page Notion page object including page ID and properties. Does not include blocks.
   * @param parentLogger Logger to use for logging messages.
   */
  constructor(
    private readonly client: Client,
    private readonly page: PageObjectResponse,
    public readonly imageSavePath: string,
    logger: AstroIntegrationLogger
  ) {
    // Create a sub-logger labeled with the page name
    const titleProp = Object.entries(page.properties).find(([_, property]) => property.type === 'title');
    const pageTitle = transformedPropertySchema.title.safeParse(titleProp ? titleProp[1] : {});
    this.#logger = logger.fork(`page ${page.id} (Title ${pageTitle.success ? pageTitle.data : 'unknown'})`);
    if (!pageTitle.success) {
      this.#logger.warn(`Failed to parse title property from page: ${pageTitle.error.toString()}`);
    }
  }

  /**
   * Return page properties for Astro to use.
   */
  async getPageData(transformCoverImage = false, rootAlias = 'src'): Promise<ParseDataOptions<NotionPageData>> {
    const { page } = this;
    let cover = page.cover;
    // transform cover image file
    if (cover && transformCoverImage && cover.type === 'file') {
      const transformedUrl = `${rootAlias}/${transformImagePathForCover(await this.#fetchImage(cover))}`;
      cover = {
        ...cover,
        file: {
          ...cover.file,
          url: transformedUrl,
        },
      };
    }
    return {
      id: page.id,
      data: {
        icon: page.icon,
        cover,
        archived: page.archived,
        in_trash: page.in_trash,
        url: page.url,
        public_url: page.public_url,
        properties: page.properties,
      },
    };
  }

  /**
   * Return rendered HTML for the page.
   * @param process Processor function to transform Notion blocks into HTML.
   * This is created once for all pages then shared.
   */
  async render(process: ReturnType<typeof buildProcessor>): Promise<RenderedNotionEntry | undefined> {
    this.#logger.debug('Rendering');
    try {
      const blocks = await awaitAll(listBlocks(this.client, this.page.id, this.#fetchImage));

      if (this.#imageAnalytics.download > 0 || this.#imageAnalytics.cached > 0) {
        this.#logger.info(
          [
            `Astro Notion Loader found `,
            ` ${this.#imageAnalytics.download} images need to download `,
            this.#imageAnalytics.cached > 0 ? `and ${this.#imageAnalytics.cached} images need to use cached ` : ``,
          ].join(' ')
        );
      }

      const { vFile, headings } = await process(blocks, this.#imagePaths);

      this.#logger.debug('Rendered');
      return {
        html: vFile.toString(),
        metadata: {
          headings,
          imagePaths: this.#imagePaths,
        },
      };
    } catch (error) {
      this.#logger.error(`Failed to render: ${getErrorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Helper function to convert remote Notion images into local images in Astro.
   * Additionally saves the path in `this.#imagePaths`.
   * @param imageFileObject Notion file object representing an image.
   * @returns Local path to the image, or undefined if the image could not be fetched.
   */
  #fetchImage: (imageFileObject: FileObject) => Promise<string> = async (imageFileObject) => {
    try {
      // only file type will be processed
      if (imageFileObject.type === 'external') {
        return imageFileObject.external.url;
      }

      fse.ensureDirSync(this.imageSavePath);

      // 文件需要下载到本地的指定目录中
      const imageUrl = await saveImageFromAWS(imageFileObject.file.url, this.imageSavePath, {
        log: (message) => {
          this.#logger.debug(message);
        },
        tag: (type) => {
          this.#imageAnalytics[type]++;
        },
      });
      this.#imagePaths.push(imageUrl);
      return imageUrl;
    } catch (error) {
      this.#logger.error(`Failed to fetch image: ${getErrorMessage(error)}`);
      // Fall back to using the remote URL directly.
      return fileToUrl(imageFileObject);
    }
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  } else if (typeof error === 'string') {
    return error;
  } else {
    return 'Unknown error';
  }
}
