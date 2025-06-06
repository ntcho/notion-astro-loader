import type { GetImageResult } from 'astro';
import { getImage } from 'astro:assets';
import type { AssetObject } from './types.js';

/**
 * Extract a plain string from a list of rich text items.
 *
 * @see https://developers.notion.com/reference/rich-text
 *
 * @example
 * richTextToPlainText(page.properties.Name.title)
 */
export function richTextToPlainText(data: ReadonlyArray<{ plain_text: string }>): string {
  return data.map((text) => text.plain_text).join('');
}

/**
 * Extract the URL from a file property.
 *
 * @see https://developers.notion.com/reference/file-object
 */
export function fileToUrl(file: AssetObject): string;
export function fileToUrl(file: AssetObject | null): string | undefined;
export function fileToUrl(file: AssetObject | null): string | undefined {
  switch (file?.type) {
    case 'external':
      return file.external.url;
    case 'file':
      return file.file.url;
    case 'custom_emoji':
      return file.custom_emoji.url;
    default:
      return undefined;
  }
}

/**
 * Extract and locally cache the image from a file object.
 * @see https://developers.notion.com/reference/file-object
 */
export async function fileToImageAsset(file: AssetObject): Promise<GetImageResult> {
  return getImage({
    src: fileToUrl(file),
    inferSize: true,
  });
}

/**
 * Replace date strings with date objects.
 *
 * @see https://developers.notion.com/reference/page-property-values#date
 */
export function dateToDateObjects(
  dateResponse: {
    start: string;
    end: string | null;
    time_zone: string | null;
  } | null
) {
  if (dateResponse === null) {
    return null;
  }

  return {
    start: new Date(dateResponse.start),
    end: dateResponse.end ? new Date(dateResponse.end) : null,
    time_zone: dateResponse.time_zone,
  };
}
